/* PaperTrench — recording store.
 *
 * Screen recordings are video Blobs measured in tens of megabytes, which is far
 * beyond what chrome.storage can hold (and base64-ing them into it would inflate
 * them by a third). IndexedDB stores Blobs natively, so the dashboard can play a
 * round's recording back instead of only showing still frames.
 *
 * Loaded by the offscreen recorder (writer) and the dashboard (reader).
 */
(() => {
  'use strict';

  const DB_NAME = 'papertrench';
  const DB_VERSION = 1;
  const STORE = 'recordings';
  // Recordings are large; keep a bounded history rather than growing forever.
  const MAX_RECORDINGS = 12;

  // An open() that never answers must not hang the caller. IndexedDB can stall
  // indefinitely: `onblocked` fires when another tab holds an older version
  // open and then nothing further happens, and in some contexts (private mode,
  // a corrupt profile, a file:// page) neither success nor error ever arrives.
  // The dashboard awaits this during startup, so an unresolved promise leaves
  // the whole page blank forever. Failing after a bounded wait degrades to
  // "no recordings" instead, which the UI already handles.
  const OPEN_TIMEOUT_MS = 5000;

  function idb() {
    return typeof indexedDB !== 'undefined' ? indexedDB : null;
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const api = idb();
      if (!api) { reject(new Error('IndexedDB unavailable')); return; }

      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      const timer = setTimeout(
        () => finish(reject, new Error('IndexedDB open timed out')),
        OPEN_TIMEOUT_MS
      );

      let request;
      try {
        request = api.open(DB_NAME, DB_VERSION);
      } catch (err) {
        finish(reject, err instanceof Error ? err : new Error('IndexedDB open failed'));
        return;
      }

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          // Keyed by round/session id so a replay can look its video up directly.
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('savedAt', 'savedAt');
        }
      };
      request.onsuccess = () => finish(resolve, request.result);
      request.onerror = () => finish(reject, request.error || new Error('IndexedDB open failed'));
      // Another tab is holding an older version open; that upgrade will not
      // complete on its own, so surface it rather than waiting out the timeout.
      request.onblocked = () => finish(reject, new Error('IndexedDB open blocked by another tab'));
    });
  }

  function tx(db, mode) {
    const transaction = db.transaction(STORE, mode);
    return transaction.objectStore(STORE);
  }

  function promisify(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
    });
  }

  /**
   * Persist a recording for a round.
   *
   * `id` is the round id when the round is known, so the dashboard can find it.
   * Returns the stored record's metadata, never the blob itself.
   */
  async function put(record) {
    if (!record || !record.id || !record.blob) return null;
    const db = await openDb();
    try {
      const entry = {
        id: String(record.id),
        sessionId: record.sessionId || null,
        mint: record.mint || null,
        symbol: record.symbol || null,
        file: record.file || null,
        // Wall-clock bounds let the dashboard map a replay moment onto a
        // position inside the video.
        startedAt: Number(record.startedAt) || 0,
        endedAt: Number(record.endedAt) || Date.now(),
        mimeType: record.blob.type || 'video/webm',
        size: record.blob.size || 0,
        blob: record.blob,
        savedAt: Date.now(),
      };
      await promisify(tx(db, 'readwrite').put(entry));
      await prune(db);
      return meta(entry);
    } finally {
      try { db.close(); } catch (_) { /* already closing */ }
    }
  }

  /** Fetch one recording (including its blob) by round id. */
  async function get(id) {
    if (!id) return null;
    const db = await openDb();
    try {
      const entry = await promisify(tx(db, 'readonly').get(String(id)));
      return entry || null;
    } finally {
      try { db.close(); } catch (_) {}
    }
  }

  /** List stored recordings without loading any video data. */
  async function list() {
    const db = await openDb();
    try {
      const entries = await promisify(tx(db, 'readonly').getAll());
      return (entries || []).map(meta).sort((a, b) => b.savedAt - a.savedAt);
    } finally {
      try { db.close(); } catch (_) {}
    }
  }

  async function remove(id) {
    if (!id) return;
    const db = await openDb();
    try {
      await promisify(tx(db, 'readwrite').delete(String(id)));
    } finally {
      try { db.close(); } catch (_) {}
    }
  }

  async function clear() {
    const db = await openDb();
    try {
      await promisify(tx(db, 'readwrite').clear());
    } finally {
      try { db.close(); } catch (_) {}
    }
  }

  /** Drop the oldest recordings so stored video cannot grow without bound. */
  async function prune(db) {
    const entries = await promisify(tx(db, 'readonly').getAll());
    if (!entries || entries.length <= MAX_RECORDINGS) return;
    const doomed = entries
      .sort((a, b) => b.savedAt - a.savedAt)
      .slice(MAX_RECORDINGS);
    const store = tx(db, 'readwrite');
    for (const entry of doomed) {
      try { store.delete(entry.id); } catch (_) { /* best effort */ }
    }
  }

  function meta(entry) {
    if (!entry) return null;
    return {
      id: entry.id,
      sessionId: entry.sessionId || null,
      mint: entry.mint || null,
      symbol: entry.symbol || null,
      file: entry.file || null,
      startedAt: entry.startedAt || 0,
      endedAt: entry.endedAt || 0,
      mimeType: entry.mimeType || 'video/webm',
      size: entry.size || 0,
      savedAt: entry.savedAt || 0,
    };
  }

  /**
   * Map a wall-clock moment onto a playback offset inside a recording.
   *
   * Returns null when the moment lies outside the recording, so a replay never
   * seeks to a frame that does not correspond to what actually happened.
   */
  function offsetForMoment(recording, atMs) {
    if (!recording) return null;
    const start = Number(recording.startedAt);
    const end = Number(recording.endedAt);
    const at = Number(atMs);
    if (!(start > 0) || !(at > 0)) return null;
    if (at < start) return null;
    if (end > start && at > end) return null;
    return (at - start) / 1000;
  }

  /**
   * The inverse of offsetForMoment: turn a video playback position back into
   * wall-clock time.
   *
   * This is what lets the video drive the timeline. Playback is the clock, and
   * the tape follows it — rather than the tape re-seeking the video, which
   * fights natural playback and causes stutter.
   */
  function momentForOffset(recording, seconds) {
    if (!recording) return null;
    const start = Number(recording.startedAt);
    const offset = Number(seconds);
    if (!(start > 0) || !Number.isFinite(offset) || offset < 0) return null;
    return start + offset * 1000;
  }

  /**
   * Index of the event that is current at a given wall-clock moment.
   *
   * Returns the last event at or before `atMs`, mirroring how a timeline
   * behaves during playback. -1 means playback has not reached the first event.
   */
  function activeEventIndex(events, atMs) {
    const list = Array.isArray(events) ? events : [];
    const at = Number(atMs);
    if (!list.length || !Number.isFinite(at)) return -1;
    let index = -1;
    for (let i = 0; i < list.length; i++) {
      const eventAt = Number(list[i] && list[i].at);
      if (!Number.isFinite(eventAt) || eventAt > at) break;
      index = i;
    }
    return index;
  }

  const api = {
    DB_NAME, STORE, MAX_RECORDINGS,
    put, get, list, remove, clear, meta,
    offsetForMoment, momentForOffset, activeEventIndex,
  };

  if (typeof window !== 'undefined') window.PTRecordings = api;
  if (typeof self !== 'undefined') self.PTRecordings = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
