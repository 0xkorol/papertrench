/* PaperTrench — background service worker.
 *
 * Responsibilities:
 *  - Open the dashboard.
 *  - Proxy AI chat calls to a user-configured OpenAI-compatible endpoint.
 *  - Orchestrate optional recording and frame capture.
 *  - Record session replays linking fills, frames, and screen recordings.
 */


if (typeof importScripts === 'function') {
  importScripts('replay.js', 'quote.js', 'resolver.js', 'onchain.js', 'rpc-pool.js', 'onchain-feed.js', 'recordings.js', 'xlinks.js', 'warmdest.js', 'xray-core.js', 'pnlcard.js');
}
const RP = self.PTReplay;
const R = self.PaperTrenchResolver;
const FEED = self.PTOnchainFeed;
const XL = self.PTXLinks;
const XR = self.PTXRay;

const DEFAULTS = {
  appEnabled: true,
  balanceStartSol: 10,
  presetsBuy: [0.1, 0.5, 1, 2],
  sellPcts: [25, 50, 75, 100],
  panelBuyEnabled: true,
  panelPresetsEnabled: true,
  feeBps: 100,
  slippageBps: 0,
  recordingEnabled: false,
  framesEnabled: true,
  autoReview: false,
  overlayEnabled: true,
  overlayHideWhenNoToken: true,
  overlayWidth: null,
  overlayHeight: null,
  tradeEffectsEnabled: true,
  tradeSoundsEnabled: true,
  profitAlertsEnabled: false,
  profitAlertPct: 10,
  averagePriceLinesEnabled: true,
  positionsBarEnabled: true,
  positionsBarHidden: false,
  warmXLinksEnabled: false,
  warmHoverCardsEnabled: false,
  warmHoverRowEnabled: false,
  warmEverywhereEnabled: false,
  xrayEnabled: false,
  xrayDeepScanEnabled: true,
  settingsRevision: 6,
  aiEndpoint: '',
  aiModel: '',
  aiApiKey: '',
  aiAllowLocalEndpoint: false,
};

const FRAME_CAP = 80;
const FRAME_INTERVAL_MS = 30_000;
let frameInterval = null;
let recActive = false;
let lastTradeTabId = null;
let replayMutation = Promise.resolve();

const OLD_LOCAL_AI_ENDPOINT = 'http://127.0.0.1:8765/v1';

function migrateBackgroundSettings(settings) {
  const revision = Number(settings.settingsRevision) || 0;
  if (revision < 4) {
    // The default AI endpoint used to point at a local BYOK shim. Treat an
    // unchanged install as empty so the new validator does not immediately
    // block it, and require an explicit opt-in before local/private endpoints
    // are reachable from the background script.
    if (settings.aiEndpoint === OLD_LOCAL_AI_ENDPOINT) {
      settings.aiEndpoint = '';
    }
    settings.aiAllowLocalEndpoint = false;
    settings.settingsRevision = 4;
  }
  return settings;
}

function getSettings() {
  return new Promise((resolve) =>
    chrome.storage.local.get(['pt_settings'], (value) => {
      if (chrome.runtime && chrome.runtime.lastError) {
        console.warn('PaperTrench: settings read failed', chrome.runtime.lastError.message);
        resolve(migrateBackgroundSettings({ ...DEFAULTS }));
        return;
      }
      resolve(migrateBackgroundSettings({ ...DEFAULTS, ...(value.pt_settings || {}) }));
    })
  );
}

function getState() {
  return new Promise((resolve) => chrome.storage.local.get(['pt_state'], (value) => {
    if (chrome.runtime && chrome.runtime.lastError) {
      console.warn('PaperTrench: state read failed', chrome.runtime.lastError.message);
      resolve(null);
      return;
    }
    resolve(value.pt_state || null);
  }));
}

function setState(state) {
  // Every writer must advance the wallet's write counter. Content tabs adopt a
  // stored state only when its seq is STRICTLY greater than their own, so a
  // write that leaves seq unchanged is invisible to open tabs and gets
  // overwritten by their next heartbeat — which is how AI reviews and
  // recording references used to vanish within a second.
  if (state && typeof state === 'object') state.seq = (Number(state.seq) || 0) + 1;
  return new Promise((resolve) => chrome.storage.local.set({ pt_state: state }, () => {
    if (chrome.runtime && chrome.runtime.lastError) {
      console.warn('PaperTrench: state write failed', chrome.runtime.lastError.message);
    }
    resolve();
  }));
}

function getReplays() {
  return new Promise((resolve) => chrome.storage.local.get([RP.STORAGE_KEY], (value) => {
    if (chrome.runtime && chrome.runtime.lastError) {
      console.warn('PaperTrench: replays read failed', chrome.runtime.lastError.message);
      resolve(RP.normalizeReplayList(null));
      return;
    }
    resolve(RP.normalizeReplayList(value[RP.STORAGE_KEY]));
  }));
}

function setReplays(replays) {
  return new Promise((resolve) => chrome.storage.local.set({ [RP.STORAGE_KEY]: replays }, () => {
    if (chrome.runtime && chrome.runtime.lastError) {
      console.warn('PaperTrench: replays write failed', chrome.runtime.lastError.message);
    }
    resolve();
  }));
}

/* ---- shared card-background gallery (extension-origin IndexedDB) ----
 *
 * The Flex composer also runs inside the page overlay now, and a content
 * script's IndexedDB belongs to the SITE origin — uploads made on Axiom
 * would be invisible on Padre and on the dashboard. Routing the gallery
 * through here keeps ONE gallery: this worker shares the extension origin
 * with dashboard.html, so it opens the very 'pt-cardmedia' database
 * dashboard.js reads directly. Blobs cross the message boundary as data
 * URLs (runtime messages are JSON).
 */
const CARDBG_DB_NAME = 'pt-cardmedia';
const CARDBG_DB_STORE = 'backgrounds';

function cardBgDbOpen() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return; }
    let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };
    // Bounded open, like recordings.js: a stalled IndexedDB must degrade to
    // "no gallery", never hang the composer.
    const timer = setTimeout(() => finish(reject, new Error('IndexedDB open timed out')), 5000);
    let request;
    try {
      request = indexedDB.open(CARDBG_DB_NAME, 1);
    } catch (err) {
      finish(reject, err instanceof Error ? err : new Error('IndexedDB open failed'));
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CARDBG_DB_STORE)) {
        db.createObjectStore(CARDBG_DB_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => finish(resolve, request.result);
    request.onerror = () => finish(reject, request.error || new Error('IndexedDB open failed'));
    request.onblocked = () => finish(reject, new Error('IndexedDB open blocked by another tab'));
  });
}

function cardBgDbRequest(db, mode, run) {
  return new Promise((resolve, reject) => {
    const request = run(db.transaction(CARDBG_DB_STORE, mode).objectStore(CARDBG_DB_STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

/** Base64 the blob by hand — service workers have no FileReader/objectURL. */
async function cardBgBlobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return 'data:' + (blob.type || 'image/png') + ';base64,' + btoa(binary);
}

async function cardBgList() {
  const db = await cardBgDbOpen();
  try {
    const entries = await cardBgDbRequest(db, 'readonly', (store) => store.getAll());
    const sorted = (entries || []).sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
    const items = [];
    for (const record of sorted) {
      try {
        items.push({
          id: record.id,
          name: record.name,
          addedAt: record.addedAt,
          dataUrl: await cardBgBlobToDataUrl(record.blob),
        });
      } catch (_) { /* an unreadable blob is simply not offered */ }
    }
    return items;
  } finally {
    try { db.close(); } catch (_) {}
  }
}

async function cardBgAdd(name, dataUrl) {
  if (typeof dataUrl !== 'string' || !/^data:image\//.test(dataUrl)) {
    return { ok: false, reason: 'Card backgrounds must be images.' };
  }
  const blob = await (await fetch(dataUrl)).blob();
  const db = await cardBgDbOpen();
  try {
    const existing = await cardBgDbRequest(db, 'readonly', (store) => store.getAll());
    // Admission is re-checked here, not only at the drop site, so no future
    // call path can slip past the 2 MB / 10-image doctrine. Same pure
    // function the composers use (pnlcard.js is imported above).
    const verdict = self.PTPnlCard.admitUpload(blob, (existing || []).length);
    if (!verdict.ok) return { ok: false, reason: verdict.reason };
    const record = {
      id: 'bg' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      name: String(name || 'background'),
      blob,
      addedAt: Date.now(),
    };
    await cardBgDbRequest(db, 'readwrite', (store) => store.put(record));
    return { ok: true, record: { id: record.id, name: record.name, addedAt: record.addedAt, dataUrl } };
  } finally {
    try { db.close(); } catch (_) {}
  }
}

async function cardBgRemove(id) {
  const db = await cardBgDbOpen();
  try {
    await cardBgDbRequest(db, 'readwrite', (store) => store.delete(String(id)));
    return { ok: true };
  } finally {
    try { db.close(); } catch (_) {}
  }
}

function openDashboard() {
  chrome.runtime.openOptionsPage();
}

/* -------------------- recording orchestration -------------------- */

async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument().catch(() => false);
  if (has) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['DISPLAY_MEDIA'],
    justification: 'Record the trading tab while a paper position is open (user-enabled).',
  });
}

async function startRecording(tabId, symbol) {
  if (recActive) return;
  try {
    await ensureOffscreen();
    const response = await chrome.runtime.sendMessage({ type: 'recorder.begin', symbol });
    recActive = !!(response && response.active);
  } catch (error) {
    recActive = false;
    console.warn('recorder begin failed:', error.message);
  }
  broadcastRecStatus();
}

async function stopRecording(roundId) {
  let result = null;
  try {
    result = await chrome.runtime.sendMessage({ type: 'recorder.stop', roundId });
  } catch (error) {
    console.warn('recorder stop failed:', error.message);
  }
  recActive = false;
  broadcastRecStatus();

  const file = result && result.file ? result.file : null;
  if (file && roundId) {
    const state = await getState();
    if (state && Array.isArray(state.rounds)) {
      const round = state.rounds.find((item) => item.id === roundId);
      if (round) {
        round.recordingFile = file;
        // Recorded to IndexedDB, so the dashboard can play the video back
        // instead of falling back to still frames.
        round.recording = result.stored ? {
          id: roundId,
          file,
          startedAt: Number(result.startedAt) || 0,
          endedAt: Number(result.endedAt) || 0,
          size: Number(result.size) || 0,
        } : null;
        await setState(state);
      }
    }
  }
  return file;
}

function broadcastRecStatus() {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: 'pt_rec_status', active: recActive }).catch(() => {});
    }
  });
}

/* -------------------- frame snapshots -------------------- */

async function snapFrame(kind, sessionValue, tabId) {
  const settings = await getSettings();
  if (!settings.framesEnabled) return;
  const session = sessionValue ? RP.normalizeSession(sessionValue) : null;
  // Never photograph whichever window happens to be focused. A frame is only
  // honest when it shows the tab that actually traded, so we capture that
  // tab's own window — and when the tab is gone or hidden, there is no
  // truthful frame, so we skip instead of grabbing some unrelated screen.
  const target = await resolveFrameTab(tabId);
  if (!target) return;
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(target.windowId, { format: 'jpeg', quality: 45 });
    const small = await downscaleDataUrl(dataUrl, 480);
    const { pt_frames = [] } = await chrome.storage.local.get(['pt_frames']);
    pt_frames.push({
      t: Date.now(),
      kind,
      sessionId: session?.sessionId || null,
      roundId: session?.roundId || null,
      symbol: session?.symbol || null,
      mint: session?.mint || null,
      dataUrl: small,
    });
    while (pt_frames.length > FRAME_CAP) pt_frames.shift();
    await chrome.storage.local.set({ pt_frames });
  } catch (error) {
    console.warn('frame capture failed:', error.message);
  }
}

/** Resolve the tab a frame should depict: the one that traded, if it still
 * exists and is the visible tab of its window. Anything else is a lie about
 * what was on screen, so it resolves to nothing. */
async function resolveFrameTab(tabId) {
  const id = Number(tabId || lastTradeTabId);
  if (!Number.isFinite(id) || id <= 0) return null;
  let tab = null;
  try { tab = await chrome.tabs.get(id); } catch (_) { tab = null; }
  if (!tab || !tab.active) return null;
  return tab;
}

async function downscaleDataUrl(dataUrl, width) {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    const scale = width / bitmap.width;
    const canvas = new OffscreenCanvas(width, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const output = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.55 });
    const buffer = new Uint8Array(await output.arrayBuffer());
    let binary = '';
    const chunk = 0x8000;
    for (let index = 0; index < buffer.length; index += chunk) {
      binary += String.fromCharCode.apply(null, buffer.subarray(index, index + chunk));
    }
    return 'data:image/jpeg;base64,' + btoa(binary);
  } catch (_) {
    return dataUrl;
  }
}

async function openPositions() {
  const state = await getState();
  return state && state.positions ? Object.values(state.positions) : [];
}

async function refreshFrameInterval() {
  const positions = await openPositions();
  const settings = await getSettings();
  if (positions.length && settings.framesEnabled && !frameInterval) {
    frameInterval = setInterval(async () => {
      const current = await openPositions();
      if (current[0]) await snapFrame('interval', current[0]);
    }, FRAME_INTERVAL_MS);
  } else if ((!positions.length || !settings.framesEnabled) && frameInterval) {
    clearInterval(frameInterval);
    frameInterval = null;
  }
}

/* -------------------- session replay bookkeeping -------------------- */

/**
 * Record the replay record for a paper session.
 *
 * This is pure local bookkeeping: it links a round's fills, chart frames, and
 * screen recording under one session id so the dashboard can play the trade
 * back. No network calls are involved.
 */
function recordReplay(sessionValue, roundValue = null) {
  const session = RP.normalizeSession(sessionValue || roundValue || {});
  replayMutation = replayMutation.catch(() => {}).then(async () => {
    if (!session.mint) return { skipped: true };
    let replays = await getReplays();
    try {
      if (roundValue) ({ replays } = RP.closeReplay(replays, session, roundValue));
      else ({ replays } = RP.upsertReplay(replays, session));
      await setReplays(replays);
      return { ok: true };
    } catch (error) {
      ({ replays } = RP.addReplayError(replays, session, error));
      await setReplays(replays);
      return { error: error.message };
    }
  });
  return replayMutation;
}

/* -------------------- AI proxy -------------------- */

function isForbiddenIPv4(a, b, c, d, allowLocal) {
  if (a === 0) return true;                                 // 0.0.0.0/8
  if (a === 10) return !allowLocal;                         // 10.0.0.0/8
  if (a === 127) return !allowLocal;                        // 127.0.0.0/8
  if (a === 169 && b === 254) return true;                  // 169.254.0.0/16 link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return !allowLocal;  // 172.16.0.0/12
  if (a === 192 && b === 168) return !allowLocal;           // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return !allowLocal; // 100.64.0.0/10 CGNAT
  if ((a === 192 && b === 0 && c === 0) ||                  // 192.0.0.0/24
      (a === 192 && b === 0 && c === 2) ||                  // 192.0.2.0/24 TEST-NET-1
      (a === 198 && b === 51 && c === 100) ||               // 198.51.100.0/24 TEST-NET-2
      (a === 203 && b === 0 && c === 113) ||                // 203.0.113.0/24 TEST-NET-3
      (a === 198 && (b === 18 || b === 19))) {             // 198.18.0.0/15 benchmark
    return !allowLocal;
  }
  if (a >= 224 && a <= 239) return true;                    // 224.0.0.0/4 multicast
  if (a >= 240) return true;                                // 240.0.0.0/4 + 255.255.255.255
  return false;
}

function isForbiddenIPv6(ip, allowLocal) {
  // The unspecified address resolves to loopback on many systems; block it
  // unconditionally just like 0.0.0.0/8.
  if (ip === '::') return true;
  if (ip === '::1') return !allowLocal;
  const lower = ip.toLowerCase();
  if (lower.startsWith('::ffff:') || lower.startsWith('::ffff:0:')) {
    const rest = lower.replace(/^::ffff(:0)?:/, '');
    if (rest.includes('.')) {
      const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(rest);
      if (ipv4) return isForbiddenIPv4(Number(ipv4[1]), Number(ipv4[2]), Number(ipv4[3]), Number(ipv4[4]), allowLocal);
    }
    const parts = rest.split(':').filter(Boolean);
    if (parts.length) {
      const lastTwo = parts.slice(-2);
      const high = parseInt(lastTwo[0] || '0', 16);
      const low = parseInt(lastTwo[1] || '0', 16);
      return isForbiddenIPv4((high >> 8) & 255, high & 255, (low >> 8) & 255, low & 255, allowLocal);
    }
  }
  if (/^fe[89ab][0-9a-f]{0,2}:/i.test(ip) || /^fe[89ab][0-9a-f]{0,2}$/i.test(ip)) return true;    // fe80::/10 link-local
  if (/^f[c-d][0-9a-f]{0,2}:/i.test(ip) || /^f[c-d][0-9a-f]{0,2}$/i.test(ip)) return !allowLocal;   // fc00::/7 unique local
  if (/^fe[c-f][0-9a-f]{0,2}:/i.test(ip) || /^fe[c-f][0-9a-f]{0,2}$/i.test(ip)) return !allowLocal; // fec0::/10 site-local (deprecated)
  if (/^ff[0-9a-f]{0,2}:/i.test(ip) || /^ff[0-9a-f]{0,2}$/i.test(ip)) return true;                  // ff00::/8 multicast
  return false;
}

function isForbiddenHost(host, allowLocal) {
  // Strip an optional trailing dot (FQDN form) so "localhost." is treated the
  // same as "localhost" by the literal and IP checks.
  const lower = host.toLowerCase().replace(/\.$/, '');
  if (lower === 'localhost' || lower === 'localhost.localdomain' || lower.endsWith('.localhost')) {
    return !allowLocal;
  }
  if (lower.includes(':')) {
    const ip = lower.replace(/^\[|\]$/g, '');
    return isForbiddenIPv6(ip, allowLocal);
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(lower);
  if (ipv4) {
    return isForbiddenIPv4(Number(ipv4[1]), Number(ipv4[2]), Number(ipv4[3]), Number(ipv4[4]), allowLocal);
  }
  return false;
}

function isAllowedEndpoint(url, allowLocal = false) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    return !isForbiddenHost(parsed.hostname, allowLocal);
  } catch (_) {
    return false;
  }
}

async function aiChat({ messages, maxTokens }) {
  const settings = await getSettings();
  const endpoint = (settings.aiEndpoint || '').replace(/\/+$/, '');
  if (!endpoint) return { error: 'No AI endpoint configured (open the dashboard → Settings)' };
  if (!isAllowedEndpoint(endpoint, settings.aiAllowLocalEndpoint)) {
    return { error: 'AI endpoint URL is not allowed. Enable local/private endpoints in Settings if you run a self-hosted endpoint, otherwise use a public endpoint.' };
  }
  const body = {
    model: settings.aiModel || 'default',
    messages,
    temperature: 0.3,
  };
  if (maxTokens) body.max_tokens = maxTokens;
  try {
    const response = await fetch(endpoint + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(settings.aiApiKey ? { Authorization: 'Bearer ' + settings.aiApiKey } : {}),
      },
      body: JSON.stringify(body),
      redirect: 'error',
    });
    if (!response.ok) return { error: `AI endpoint returned ${response.status}` };
    const json = await response.json();
    return { reply: json?.choices?.[0]?.message?.content || '' };
  } catch (error) {
    return { error: 'AI request failed: ' + error.message };
  }
}


/**
 * List the models the configured endpoint serves — or, when the caller
 * passes overrides, the endpoint the caller supplies.
 *
 * D-29: the dashboard's "Test AI endpoint" button used to persist the entire
 * unsaved settings form to storage just so this function would read the right
 * endpoint. Overrides let the probe use the form values with NOTHING written;
 * they pass through the exact same isAllowedEndpoint gate as saved settings,
 * so this widens no security surface — it only changes where the values come
 * from. (`model` is accepted for interface symmetry; the /models listing does
 * not need it.)
 */
async function aiModels(overrides) {
  const settings = await getSettings();
  const o = overrides && typeof overrides === 'object' ? overrides : {};
  const endpoint = String(typeof o.endpoint === 'string' ? o.endpoint : (settings.aiEndpoint || '')).replace(/\/+$/, '');
  const allowLocal = typeof o.aiAllowLocalEndpoint === 'boolean'
    ? o.aiAllowLocalEndpoint
    : Boolean(settings.aiAllowLocalEndpoint);
  const apiKey = typeof o.apiKey === 'string' ? o.apiKey : (settings.aiApiKey || '');
  if (!endpoint) return { models: [] };
  if (!isAllowedEndpoint(endpoint, allowLocal)) {
    return { models: [], error: 'AI endpoint URL is not allowed. Enable local/private endpoints in Settings if you run a self-hosted endpoint, otherwise use a public endpoint.' };
  }
  try {
    const response = await fetch(endpoint + '/models', {
      headers: apiKey ? { Authorization: 'Bearer ' + apiKey } : {},
      redirect: 'error',
    });
    if (!response.ok) return { models: [] };
    const json = await response.json();
    return { models: (json.data || []).map((model) => model.id).filter(Boolean) };
  } catch (error) {
    return { models: [], error: error.message };
  }
}

async function autoReview(roundId) {
  const state = await getState();
  if (!state) return;
  const round = (state.rounds || []).find((item) => item.id === roundId);
  if (!round) return;
  const trades = (state.journal || []).filter((trade) => round.tradeIds.includes(trade.id));
  const prompt = buildRoundReviewPrompt(round, trades);
  const { reply, error } = await aiChat({ messages: prompt, maxTokens: 1800 });
  round.aiReview = {
    t: Date.now(),
    text: reply || ('AI review failed: ' + error),
    ok: !error,
  };
  await setState(state);
}

/**
 * D-49: coach prompts stamp times in LOCAL time with an explicit UTC-offset
 * suffix, matching the dashboard's P&L calendar (which buckets days in local
 * time). A bare UTC ISO stamp put fills near midnight on a different day
 * than the calendar the user sees, so the coach's "day" observations
 * disagreed with the grid. Same helper as dashboard.js formatLocalStamp.
 */
function formatLocalStamp(ms) {
  const d = new Date(Number(ms) || 0);
  const pad = (n) => String(n).padStart(2, '0');
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} `
    + `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function buildRoundReviewPrompt(round, trades) {
  const lines = trades
    .sort((a, b) => a.ts - b.ts)
    .map((trade) => `${formatLocalStamp(trade.ts)} ${trade.side.toUpperCase()} ${trade.qty.toFixed(4)} ${trade.symbol} @ ${trade.priceNative} SOL (gross ${trade.solGross.toFixed(3)} SOL${trade.pnlSol !== undefined ? `, realized ${trade.pnlSol >= 0 ? '+' : ''}${trade.pnlSol.toFixed(4)}` : ''})`)
    .join('\n');
  return [
    {
      role: 'system',
      content:
        'You are a brutally honest but constructive Solana memecoin trading coach. Review this paper-trade round trip. Analyze entries, exits, sizing, and hold time against the P&L path, and name specific bad habits if present. Be concrete and short.',
    },
    {
      role: 'user',
      content:
        `Round trip on ${round.symbol} (${round.mint})\n` +
        `Opened: ${formatLocalStamp(round.openedAt)}  Closed: ${formatLocalStamp(round.closedAt)}  Held: ${(round.heldMs / 60000).toFixed(1)} min\n` +
        `Invested: ${round.investedSol.toFixed(4)} SOL  Returned: ${round.returnedSol.toFixed(4)} SOL\n` +
        `P&L: ${round.pnlSol >= 0 ? '+' : ''}${round.pnlSol.toFixed(4)} SOL (${round.pnlPct.toFixed(1)}%)\n` +
        `Peak unrealized P&L: +${round.peakPnlSol.toFixed(4)} SOL   Worst: ${round.troughPnlSol.toFixed(4)} SOL\n\n` +
        `Fills:\n${lines}` +
        '\n\nGive: (1) verdict, (2) what was done right, (3) what was done wrong, (4) one bad habit, and (5) one concrete fix for next time.',
    },
  ];
}

/* -------------------- Turbo receipts (local route timings) -----------------
 *
 * Speed claims get receipts or they do not get made. Every warm route
 * records how long the background took from receiving the click to
 * dispatching the navigation / revealing the viewer — measured on THIS
 * machine, stored locally under one key, shown in the popup as medians.
 * That is exactly what the number is and all it is: background routing
 * latency, not page-ready time. No telemetry; nothing ever leaves the
 * device; the ring holds the last 50 samples per route.
 */
const TURBO_STATS_KEY = 'pt_turbo_stats';
const TURBO_RING_MAX = 50;
let turboChain = Promise.resolve();
function turboNote(route, ms) {
  turboChain = turboChain.catch(() => {}).then(() => new Promise((resolve) => {
    try {
      chrome.storage.local.get([TURBO_STATS_KEY], (value) => {
        if (chrome.runtime && chrome.runtime.lastError) { resolve(); return; }
        const stats = (value && value[TURBO_STATS_KEY]) || {};
        const entry = stats[route] || { count: 0, ring: [] };
        entry.count += 1;
        if (Number.isFinite(ms)) {
          entry.ring.push(Math.round(ms));
          if (entry.ring.length > TURBO_RING_MAX) entry.ring.splice(0, entry.ring.length - TURBO_RING_MAX);
        }
        stats[route] = entry;
        chrome.storage.local.set({ [TURBO_STATS_KEY]: stats }, () => resolve());
      });
    } catch (_) { resolve(); }
  }));
}

/* -------------------- warm X links (instant post opens) --------------------
 *
 * Opt-in (warmXLinksEnabled, default off). One muted background tab is kept
 * hydrated on x.com; clicking an X post/profile link on a trading site routes
 * into it via an in-page SPA navigation (~0.5s) instead of a cold tab (~3.5s).
 *
 * Single-viewer model: after a click the SAME tab stays registered as the
 * viewer, so every subsequent click is a warm SPA hop in an already-hydrated
 * page — no per-click tab churn, no idle-tab TTL bookkeeping, and nothing to
 * recycle out from under the user. Modified clicks bypass the feature in the
 * content script, so multi-tab comparison workflows still work natively.
 *
 * Reveal-first: the viewer is brought to front the moment the SPA request is
 * acked, BEFORE verification. Perceived latency is one message round-trip;
 * verification runs behind the user's eyes and repairs with a full load of the
 * same URL only if the in-page route did not actually arrive.
 *
 * The viewer tab id lives in chrome.storage.session: gone with the browser
 * session (matching the tab itself), survives service-worker restarts.
 * No alarms, no telemetry, no remote flags — the only gate is the user's own
 * toggle, and the only logging is console.debug on this machine.
 */

/** The warm feature runs only under BOTH switches: its own toggle and the
 * app-wide master switch (appEnabled). "PaperTrench off" must mean off —
 * including the hidden viewer tab and all link interception. */
function warmFeatureOn(settings) {
  return settings.appEnabled !== false && settings.warmXLinksEnabled === true;
}

const WARM_IDLE_URL = 'https://x.com/home';
const WARM_SPA_TIMEOUT_MS = 6000;
const WARM_STORAGE_KEY = 'pt_warm_tab';
// Mirrors the manifest's trading-site matches; used only to decide whether
// enabling the toggle should pre-warm immediately.
const WARM_PLATFORM_URLS = [
  'https://axiom.trade/*', 'https://*.axiom.trade/*', 'https://*.padre.gg/*',
  'https://*.tinyastro.io/*', 'https://gmgn.ai/*', 'https://*.gmgn.ai/*',
  'https://*.bullx.io/*', 'https://dexscreener.com/*', 'https://*.dexscreener.com/*',
  'https://birdeye.so/*', 'https://*.birdeye.so/*', 'https://jup.ag/*',
  'https://*.jup.ag/*', 'https://pump.fun/*', 'https://*.pump.fun/*',
];

// One in-flight SPA request per viewer tab; a newer click supersedes the
// older one so a late failure can never "repair" the tab back to a stale
// target the user already clicked past.
const warmPending = new Map(); // tabId -> { requestId, url, timer }

// All read-modify-write of the viewer registration is serialized through this
// chain — the reference design declared a lock and then never used it, which
// let two rapid clicks race createTab and leak a hidden tab.
let warmChain = Promise.resolve();
function warmSerial(fn) {
  const next = warmChain.catch(() => {}).then(fn);
  warmChain = next.catch(() => {});
  return next;
}

function readWarmTab() {
  return new Promise((resolve) => chrome.storage.session.get([WARM_STORAGE_KEY], (value) => {
    if (chrome.runtime && chrome.runtime.lastError) { resolve(null); return; }
    resolve(value[WARM_STORAGE_KEY] || null);
  }));
}
function writeWarmTab(state) {
  return new Promise((resolve) => chrome.storage.session.set({ [WARM_STORAGE_KEY]: state }, () => resolve()));
}
function clearWarmTabState() {
  return new Promise((resolve) => chrome.storage.session.remove(WARM_STORAGE_KEY, () => resolve()));
}

/** The registered viewer tab, revalidated against reality: it must still exist
 * and still be on X. Anything else clears the registration — a tab the user
 * closed or navigated elsewhere is their tab, not our viewer. */
async function validWarmTab() {
  const state = await readWarmTab();
  if (!state || !Number.isFinite(state.tabId)) return null;
  let tab = null;
  try { tab = await chrome.tabs.get(state.tabId); } catch (_) { tab = null; }
  let host = '';
  try { host = new URL((tab && (tab.pendingUrl || tab.url)) || '').hostname; } catch (_) { host = ''; }
  if (!tab || !XL.isXHost(host)) {
    await clearWarmTabState();
    return null;
  }
  return { tab, state };
}

async function warmReveal(tab, url) {
  // Muted only while hidden; a viewer the user is looking at must play media
  // normally. Passing url makes this the full-load route in one call.
  const props = url ? { url, active: true, muted: false } : { active: true, muted: false };
  try { await chrome.tabs.update(tab.id, props); } catch (_) {}
  // active:true selects the tab within its window; if the viewer lives in
  // another window that window must also be focused or nothing visibly happens
  // on a multi-window setup.
  try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (_) {}
}

/** An x.com tab the user already has open can BE the viewer. Routing into it
 * is what people expect — "open it in my X tab" — and it is exactly the case
 * from the field where a lost registration made the cold path spawn a
 * duplicate x.com tab NEXT TO the one already sitting there (lev's community
 * link "opens them separately"). Never a tab the user is looking at, never a
 * pinned one, never one playing audio — those are in use, and a viewer gets
 * silently navigated by clicks and hover prefetch. Prefer a tab parked on
 * /home (nothing to lose there), then the most recently used. */
async function warmAdoptableTab() {
  const tabs = await new Promise((resolve) => chrome.tabs.query({
    url: ['https://x.com/*', 'https://*.x.com/*', 'https://twitter.com/*', 'https://*.twitter.com/*'],
  }, (result) => resolve(result || [])));
  const candidates = tabs.filter((tab) => tab && Number.isFinite(tab.id)
    && !tab.active && !tab.pinned && !tab.audible);
  if (!candidates.length) return null;
  const parked = candidates.filter((tab) => {
    try { return new URL(tab.pendingUrl || tab.url || '').pathname === '/home'; } catch (_) { return false; }
  });
  const pool = parked.length ? parked : candidates;
  return pool.reduce((best, tab) => ((tab.lastAccessed || 0) > (best.lastAccessed || 0) ? tab : best));
}

/** Ensure a viewer exists: adopt an existing X tab, else create the hidden
 * one. Callers must already hold warmSerial. Adopted tabs register as
 * used:true — they are the user's tabs, so a later toggle-off must never
 * close them. */
async function warmEnsureViewerLocked() {
  const settings = await getSettings();
  if (!warmFeatureOn(settings)) return;
  if (await validWarmTab()) return;
  const adopted = await warmAdoptableTab();
  if (adopted) {
    await writeWarmTab({ tabId: adopted.id, used: true, createdAt: Date.now() });
    console.debug('PaperTrench warm links: adopted an existing X tab as the viewer');
    return;
  }
  const tab = await chrome.tabs.create({ url: WARM_IDLE_URL, active: false });
  try { await chrome.tabs.update(tab.id, { muted: true }); } catch (_) {}
  await writeWarmTab({ tabId: tab.id, used: false, createdAt: Date.now() });
}

/** Pre-create the hidden viewer so the session's FIRST click is already warm.
 * Idempotent under warmSerial: n trading tabs announcing themselves create
 * one viewer, not n. */
function warmPrewarm() {
  return warmSerial(warmEnsureViewerLocked);
}

function warmSupersede(tabId) {
  const pending = warmPending.get(tabId);
  if (pending) {
    clearTimeout(pending.timer);
    warmPending.delete(tabId);
  }
}

function warmRepair(tabId, requestId, reason) {
  const pending = warmPending.get(tabId);
  if (!pending || pending.requestId !== requestId) return; // superseded
  warmSupersede(tabId);
  console.debug('PaperTrench warm links: SPA route failed (' + reason + '), falling back to a full load');
  chrome.tabs.update(tabId, { url: pending.url }).catch(() => {});
}

function warmSpaResult(message, sender) {
  const tabId = sender && sender.tab ? sender.tab.id : null;
  if (!Number.isFinite(tabId)) return;
  const pending = warmPending.get(tabId);
  // Results are hints from a page-adjacent world: only the tab we actually
  // messaged may report, and only for the request that is still live.
  if (!pending || pending.requestId !== message.requestId) return;
  if (message.ok === true) {
    if (message.reason === 'x_error_page') {
      console.debug('PaperTrench warm links: target renders X\'s error page (deleted post?) — shown as-is, no reload');
    }
    warmSupersede(tabId);
    return;
  }
  warmRepair(tabId, message.requestId, message.reason || 'spa_failed');
}

/** Same X page, regardless of x.com/twitter.com host or trailing slash.
 * Re-clicking a token's X link is the most common flow there is — the viewer
 * already showing that exact post must simply be revealed, never re-loaded
 * (and never even messaged: a mid-load viewer has no relay yet, and the old
 * fallback answered that with a redundant full reload of the same URL). */
function sameXTarget(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    if (!XL.isXHost(ua.hostname) || !XL.isXHost(ub.hostname)) return false;
    return ua.pathname.replace(/\/+$/, '') === ub.pathname.replace(/\/+$/, '')
      && ua.search === ub.search;
  } catch (_) {
    return false;
  }
}

/** Open a brand-new viewer next to the tab that was clicked, when possible. */
async function warmCreateViewer(url, sender) {
  const opener = sender && sender.tab;
  if (opener && Number.isFinite(opener.id)) {
    try {
      return await chrome.tabs.create({
        url, active: true,
        windowId: opener.windowId, index: opener.index + 1, openerTabId: opener.id,
      });
    } catch (_) { /* opener window vanished mid-click */ }
  }
  return chrome.tabs.create({ url, active: true });
}

/** Hover prefetch: drive the HIDDEN viewer to the hovered target so the
 * eventual click is only a reveal. Strictly weaker than a click — it never
 * creates a tab, never reveals, never touches a viewer the user is looking
 * at, and never claims the tab as used. If the in-page route fails, the
 * normal repair full-loads the target while still hidden — which is itself a
 * prefetch: even with X's router refusing the SPA trick, the click lands on
 * a fully loaded page. A hint with no live relay does nothing at all: a
 * hover is not intent enough to spend a reload on. */
function warmHint(rawUrl, settings) {
  if (!warmFeatureOn(settings)) return Promise.resolve();
  const target = XL.classify(String(rawUrl || ''));
  if (!target) return Promise.resolve();
  return warmSerial(async () => {
    const valid = await validWarmTab();
    if (!valid) return;
    const { tab } = valid;
    if (tab.active) return;
    if (tab.discarded === true || tab.status === 'unloaded') return;
    if (sameXTarget(tab.pendingUrl || tab.url || '', target.url)) return;
    warmSupersede(tab.id);
    const requestId = 'pth-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);
    const pending = { requestId, url: target.url, timer: null };
    warmPending.set(tab.id, pending);
    pending.timer = setTimeout(() => warmRepair(tab.id, requestId, 'hint_timeout'), WARM_SPA_TIMEOUT_MS);
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'pt_warm_spa',
        requestId,
        url: target.url,
        kind: target.kind,
        handle: target.handle,
        postId: target.postId,
      });
      console.debug('PaperTrench warm links: prefetch dispatched for hover target');
    } catch (_) {
      warmSupersede(tab.id);
    }
  });
}

async function warmOpen(rawUrl, sender, settings) {
  // Re-classify at this trust boundary; content-script input is not trusted.
  const target = XL.classify(String(rawUrl || ''));
  if (!target) return { ok: false, error: 'not an X post or profile URL' };

  if (!warmFeatureOn(settings)) {
    // Toggle raced off between click and message: behave like a native open.
    await warmCreateViewer(target.url, sender);
    console.debug('PaperTrench warm links: route=new_tab (feature disabled)');
    return { ok: true, route: 'new_tab' };
  }

  return warmSerial(async () => {
    const startedAt = Date.now();
    let valid = await validWarmTab();

    if (!valid) {
      // No registered viewer. Before spawning a separate tab, adopt an X tab
      // the user already keeps — the field failure was exactly a community
      // link opening in a fresh tab NEXT TO the user's own x.com tab. The
      // adopted tab goes through the normal warm route below (the relay
      // scripts run on every x.com tab, so SPA works there too).
      const adopted = await warmAdoptableTab();
      if (adopted) {
        const state = { tabId: adopted.id, used: true, createdAt: Date.now() };
        await writeWarmTab(state);
        valid = { tab: adopted, state };
        console.debug('PaperTrench warm links: route continues in an adopted X tab');
      }
    }

    if (!valid) {
      // Cold path — and the new tab immediately becomes the viewer, so only
      // the first click of a session (or after the user closes the viewer)
      // ever pays the cold price.
      const tab = await warmCreateViewer(target.url, sender);
      await writeWarmTab({ tabId: tab.id, used: true, createdAt: Date.now() });
      console.debug('PaperTrench warm links: route=cold_tab (no viewer yet; this tab is now the viewer)');
      turboNote('x:cold_tab', Date.now() - startedAt);
      return { ok: true, route: 'cold_tab' };
    }

    const { tab, state } = valid;
    warmSupersede(tab.id);

    // Already showing (or already loading) this exact target: reveal, done.
    if (sameXTarget(tab.pendingUrl || tab.url || '', target.url)) {
      await warmReveal(tab);
      await writeWarmTab({ ...state, used: true });
      console.debug('PaperTrench warm links: route=already_open');
      turboNote('x:already_open', Date.now() - startedAt);
      return { ok: true, route: 'already_open' };
    }

    // A tab Chrome discarded under memory pressure has no live content scripts
    // to SPA through — but a full load in it still beats a cold tab (process,
    // connections, and X's service-worker cache are warm).
    if (tab.discarded === true || tab.status === 'unloaded') {
      await warmReveal(tab, target.url);
      await writeWarmTab({ ...state, used: true });
      console.debug('PaperTrench warm links: route=warm_reload (viewer was discarded)');
      turboNote('x:warm_reload', Date.now() - startedAt);
      return { ok: true, route: 'warm_reload' };
    }

    const requestId = 'ptw-' + startedAt.toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);
    const pending = { requestId, url: target.url, timer: null };
    warmPending.set(tab.id, pending);
    pending.timer = setTimeout(() => warmRepair(tab.id, requestId, 'timeout'), WARM_SPA_TIMEOUT_MS);

    // SPA request and reveal fire CONCURRENTLY — the ack round-trip is off
    // the critical path; verification and any repair happen behind the
    // user's eyes.
    const acked = chrome.tabs.sendMessage(tab.id, {
      type: 'pt_warm_spa',
      requestId,
      url: target.url,
      kind: target.kind,
      handle: target.handle,
      postId: target.postId,
    }).then(() => true, () => false);
    await warmReveal(tab);
    await writeWarmTab({ ...state, used: true });

    if (!(await acked)) {
      // No relay in the tab (still loading, or scripts not injected yet).
      // Already revealed; just drive the full load.
      warmSupersede(tab.id);
      try { await chrome.tabs.update(tab.id, { url: target.url }); } catch (_) {}
      console.debug('PaperTrench warm links: route=warm_reload (no relay in viewer)');
      turboNote('x:warm_reload', Date.now() - startedAt);
      return { ok: true, route: 'warm_reload' };
    }

    console.debug('PaperTrench warm links: SPA route dispatched in ' + (Date.now() - startedAt) + 'ms');
    turboNote('x:spa', Date.now() - startedAt);
    return { ok: true, route: 'spa' };
  });
}

/* Hover tweet cards: X's public oEmbed endpoint returns a post's author and
 * text for any status URL — no auth, no cookies, and `dnt=1` asks for no
 * tracking. Fetched from the worker (host_permissions covers it), cached hard
 * (positive AND gone results — a deleted post stays deleted), and requested
 * only on the same hover dwell that fires the prefetch, never on the click
 * path. A 404 here is the pre-click rug signal: the card can say "post
 * unavailable" before the trader spends a click on it.
 * This is PaperTrench's ONLY third-party call besides the price APIs and the
 * user's own endpoints — documented in docs/PERMISSIONS.md and README. */
const WARM_OEMBED_URL = 'https://publish.twitter.com/oembed';
const WARM_OEMBED_TIMEOUT_MS = 3500;
const WARM_OEMBED_CACHE_MAX = 200;
const warmOembedCache = new Map(); // canonical post url -> result

function decodeOembedEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, '—');
}

/** Text + date out of the oEmbed blockquote HTML. No DOM in a worker, so
 * this is string surgery on a format that has been stable for a decade. */
function parseOembedHtml(html) {
  const p = /<p[^>]*>([\s\S]*?)<\/p>/.exec(String(html));
  const text = p
    ? decodeOembedEntities(p[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''))
    : '';
  const date = /<\/p>[\s\S]*?<a[^>]*>([^<]+)<\/a>\s*<\/blockquote>/.exec(String(html));
  return { text: text.slice(0, 600), date: date ? decodeOembedEntities(date[1]) : null };
}

async function warmOembed(rawUrl, settings) {
  if (!warmFeatureOn(settings)) return { ok: false };
  const target = XL.classify(String(rawUrl || ''));
  if (!target || target.kind !== 'post') return { ok: false }; // oEmbed does posts only
  const cached = warmOembedCache.get(target.url);
  if (cached) return cached;

  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), WARM_OEMBED_TIMEOUT_MS);
  let result = null;
  try {
    const response = await fetch(
      WARM_OEMBED_URL + '?omit_script=1&dnt=1&hide_thread=1&url=' + encodeURIComponent(target.url),
      { signal: controller.signal, redirect: 'follow' }
    );
    if (response.status === 404 || response.status === 403) {
      result = { ok: true, gone: true, url: target.url };
    } else if (response.ok) {
      const json = await response.json();
      const parsed = parseOembedHtml(json.html || '');
      result = {
        ok: true, gone: false, url: target.url,
        authorName: String(json.author_name || '').slice(0, 80),
        text: parsed.text, date: parsed.date,
      };
    }
  } catch (_) {
    // Network trouble: report nothing and cache nothing — the next hover may
    // succeed, and the card simply not appearing costs the user zero.
  } finally {
    clearTimeout(abortTimer);
  }
  if (!result) return { ok: false };
  if (warmOembedCache.size >= WARM_OEMBED_CACHE_MAX) {
    warmOembedCache.delete(warmOembedCache.keys().next().value);
  }
  warmOembedCache.set(target.url, result);
  return result;
}

async function warmSettingsChanged(settings) {
  if (warmFeatureOn(settings)) {
    // Toggled on with trading tabs already open? Warm up right away.
    const tabs = await new Promise((resolve) => chrome.tabs.query({ url: WARM_PLATFORM_URLS }, (result) => resolve(result || [])));
    if (tabs.length) warmPrewarm().catch(() => {});
    return;
  }
  const state = await readWarmTab();
  if (!state) return;
  await clearWarmTabState();
  // Only an idle, never-used, still-hidden viewer is ours to close. Once used
  // (or found and focused by the user) the tab belongs to the user.
  if (state.used) return;
  try {
    const tab = await chrome.tabs.get(state.tabId);
    if (tab && !tab.active) await chrome.tabs.remove(state.tabId);
  } catch (_) { /* already gone */ }
}

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  warmSupersede(tabId);
  warmSerial(async () => {
    const state = await readWarmTab();
    if (!state || state.tabId !== tabId) return;
    await clearWarmTabState();
    // An accidentally-closed viewer must not degrade the feature until the
    // user rediscovers the toggle ("I closed the x tab and had to turn
    // instant mode off and on to get the hot tab open" — lev). While the
    // toggle is on and a trading tab is open, a fresh hidden viewer takes
    // its place immediately; turning the feature off remains the one way to
    // not have a viewer. A closing WINDOW is the browser going away, not the
    // user aiming at our tab — never spawn tabs into a shutdown.
    if (removeInfo && removeInfo.isWindowClosing) return;
    const settings = await getSettings();
    if (!warmFeatureOn(settings)) return;
    const trading = await new Promise((resolve) => chrome.tabs.query({ url: WARM_PLATFORM_URLS }, (result) => resolve(result || [])));
    if (!trading.length) return;
    await warmEnsureViewerLocked();
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'loading') return;
  warmSerial(async () => {
    const state = await readWarmTab();
    if (!state || state.tabId !== tabId) return;
    const url = changeInfo.url || (tab && (tab.pendingUrl || tab.url)) || '';
    if (!url) return;
    let host = '';
    try { host = new URL(url).hostname; } catch (_) { host = ''; }
    if (!XL.isXHost(host)) {
      // The user steered the viewer off X — release it, it is theirs.
      warmSupersede(tabId);
      await clearWarmTabState();
    }
  });
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  warmSerial(async () => {
    const state = await readWarmTab();
    if (!state || state.tabId !== activeInfo.tabId || state.used) return;
    // The user found the hidden idle tab on their own: unmute it and mark it
    // used so a later toggle-off will not close a tab they are reading.
    await writeWarmTab({ ...state, used: true });
    try { await chrome.tabs.update(activeInfo.tabId, { muted: false }); } catch (_) {}
  });
});

/* ------------- warm destination viewers (Instant Everything links) --------
 *
 * Turbo Tier 1: the X viewer generalized to the two NON-X cold destinations
 * every token row on the supported terminals carries — pump.fun and solscan.
 * Opt-in (warmEverywhereEnabled, default off), and structurally simpler than
 * the X route on purpose:
 *
 *   - One kept-warm muted tab per family, registered in storage.session.
 *   - Clicks route as a FULL navigation in the warm tab (tabs.update + reveal).
 *     No SPA relay: solscan carries no PaperTrench scripts at all, and a full
 *     load in an already-hot renderer (live connections, HTTP cache, service
 *     worker) is the honest, unbreakable version of fast for these sites.
 *   - Hover prefetch navigates the HIDDEN viewer only. Hints never create
 *     tabs, never touch a tab the user is looking at (X contract, verbatim).
 *   - Same ownership rules: used/found tabs belong to the user; toggle-off
 *     closes only a never-used, still-hidden viewer. A closed viewer does NOT
 *     respawn (unlike X): two respawning background tabs would read as an
 *     infestation — the next click simply recreates its viewer cold.
 *
 * The X path above is untouched: different messages, different storage keys,
 * shared warmSerial (tab bookkeeping stays single-file) and shared warmReveal.
 */

const WD = self.PTWarmDest;

function warmDestFeatureOn(settings) {
  return settings.appEnabled !== false && settings.warmEverywhereEnabled === true;
}

const WARM_DEST_FAMILIES = {
  pumpfun: {
    storageKey: 'pt_warm_tab_pumpfun',
    idleUrl: 'https://pump.fun/board',
    hostRe: /(^|\.)pump\.fun$/,
    label: 'pump.fun',
  },
  solscan: {
    storageKey: 'pt_warm_tab_solscan',
    idleUrl: 'https://solscan.io/',
    hostRe: /(^|\.)solscan\.io$/,
    label: 'Solscan',
  },
};

function readWarmDestTab(family) {
  const spec = WARM_DEST_FAMILIES[family];
  return new Promise((resolve) => chrome.storage.session.get([spec.storageKey], (value) => {
    if (chrome.runtime && chrome.runtime.lastError) { resolve(null); return; }
    resolve(value[spec.storageKey] || null);
  }));
}
function writeWarmDestTab(family, state) {
  const spec = WARM_DEST_FAMILIES[family];
  return new Promise((resolve) => chrome.storage.session.set({ [spec.storageKey]: state }, () => resolve()));
}
function clearWarmDestTab(family) {
  const spec = WARM_DEST_FAMILIES[family];
  return new Promise((resolve) => chrome.storage.session.remove(spec.storageKey, () => resolve()));
}

/** The family's registered viewer, revalidated against reality (the X rule:
 * a tab the user closed or steered elsewhere is theirs, not our viewer). */
async function validWarmDestTab(family) {
  const spec = WARM_DEST_FAMILIES[family];
  const state = await readWarmDestTab(family);
  if (!state || !Number.isFinite(state.tabId)) return null;
  let tab = null;
  try { tab = await chrome.tabs.get(state.tabId); } catch (_) { tab = null; }
  let host = '';
  try { host = new URL((tab && (tab.pendingUrl || tab.url)) || '').hostname; } catch (_) { host = ''; }
  if (!tab || !spec.hostRe.test(host)) {
    await clearWarmDestTab(family);
    return null;
  }
  return { tab, state };
}

function sameDestUrl(a, b) {
  try {
    const ua = new URL(a); const ub = new URL(b);
    return ua.hostname.replace(/^www\./, '') === ub.hostname.replace(/^www\./, '')
      && ua.pathname.replace(/\/+$/, '') === ub.pathname.replace(/\/+$/, '')
      && ua.search === ub.search;
  } catch (_) { return false; }
}

async function warmDestOpen(rawUrl, sender, settings) {
  // Trust boundary: the terminal-side world only SUGGESTS a URL; what
  // navigates is what the shared classifier re-derives here.
  const target = WD && WD.classify(String(rawUrl || ''));
  if (!target) return { ok: false, reason: 'unclassified' };

  const createNext = async (active) => {
    const props = { url: target.url, active };
    if (sender && sender.tab) {
      props.windowId = sender.tab.windowId;
      props.index = sender.tab.index + 1;
      props.openerTabId = sender.tab.id;
    }
    try { return await chrome.tabs.create(props); }
    catch (_) { return chrome.tabs.create({ url: target.url, active }); }
  };

  if (!warmDestFeatureOn(settings)) {
    await createNext(true);
    return { ok: true, route: 'new_tab' };
  }

  return warmSerial(async () => {
    const startedAt = Date.now();
    const valid = await validWarmDestTab(target.family);
    if (!valid) {
      // Cold path — the new tab immediately becomes the family viewer, so
      // only the FIRST open pays the cold price.
      const tab = await createNext(true);
      if (tab && Number.isFinite(tab.id)) {
        await writeWarmDestTab(target.family, { tabId: tab.id, used: true, createdAt: Date.now() });
      }
      console.debug('PaperTrench warm dest: route=cold_tab (' + target.family + ')');
      turboNote('dest:cold_tab', Date.now() - startedAt);
      return { ok: true, route: 'cold_tab' };
    }

    const { tab, state } = valid;
    const already = sameDestUrl((tab.pendingUrl || tab.url || ''), target.url);
    // Full-load route in one call: reveal carries the url unless the viewer
    // is already parked on the exact target.
    await warmReveal(tab, already ? undefined : target.url);
    await writeWarmDestTab(target.family, { ...state, used: true });
    console.debug('PaperTrench warm dest: route=' + (already ? 'already_open' : 'warm_nav')
      + ' (' + target.family + ') in ' + (Date.now() - startedAt) + 'ms');
    turboNote(already ? 'dest:already_open' : 'dest:warm_nav', Date.now() - startedAt);
    return { ok: true, route: already ? 'already_open' : 'warm_nav' };
  });
}

/** Hover prefetch: strictly weaker than a click. Never creates a tab, never
 * reveals, never navigates a tab the user is actually looking at. */
async function warmDestHint(rawUrl, settings) {
  if (!warmDestFeatureOn(settings)) return;
  const target = WD && WD.classify(String(rawUrl || ''));
  if (!target) return;
  return warmSerial(async () => {
    const valid = await validWarmDestTab(target.family);
    if (!valid) return;
    const { tab } = valid;
    if (tab.active) return;
    if (sameDestUrl((tab.pendingUrl || tab.url || ''), target.url)) return;
    try { await chrome.tabs.update(tab.id, { url: target.url }); } catch (_) {}
  });
}

/** Pre-create both hidden viewers so the session's FIRST click is warm.
 * Idempotent under warmSerial, exactly like warmPrewarm. */
function warmDestPrewarm() {
  return warmSerial(async () => {
    const settings = await getSettings();
    if (!warmDestFeatureOn(settings)) return;
    for (const family of Object.keys(WARM_DEST_FAMILIES)) {
      if (await validWarmDestTab(family)) continue;
      const spec = WARM_DEST_FAMILIES[family];
      let tab = null;
      try { tab = await chrome.tabs.create({ url: spec.idleUrl, active: false }); } catch (_) { tab = null; }
      if (!tab || !Number.isFinite(tab.id)) continue;
      try { await chrome.tabs.update(tab.id, { muted: true }); } catch (_) {}
      await writeWarmDestTab(family, { tabId: tab.id, used: false, createdAt: Date.now() });
    }
  });
}

async function warmDestSettingsChanged(settings) {
  if (warmDestFeatureOn(settings)) {
    const tabs = await new Promise((resolve) => chrome.tabs.query({ url: WARM_PLATFORM_URLS }, (result) => resolve(result || [])));
    if (tabs.length) warmDestPrewarm().catch(() => {});
    return;
  }
  for (const family of Object.keys(WARM_DEST_FAMILIES)) {
    const state = await readWarmDestTab(family);
    if (!state) continue;
    await clearWarmDestTab(family);
    if (state.used) continue; // used or user-found tabs are the user's
    try {
      const tab = await chrome.tabs.get(state.tabId);
      if (tab && !tab.active) await chrome.tabs.remove(state.tabId);
    } catch (_) { /* already gone */ }
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  warmSerial(async () => {
    for (const family of Object.keys(WARM_DEST_FAMILIES)) {
      const state = await readWarmDestTab(family);
      if (state && state.tabId === tabId) await clearWarmDestTab(family);
    }
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'loading') return;
  warmSerial(async () => {
    for (const family of Object.keys(WARM_DEST_FAMILIES)) {
      const state = await readWarmDestTab(family);
      if (!state || state.tabId !== tabId) continue;
      const url = changeInfo.url || (tab && (tab.pendingUrl || tab.url)) || '';
      if (!url) continue;
      let host = '';
      try { host = new URL(url).hostname; } catch (_) { host = ''; }
      if (!WARM_DEST_FAMILIES[family].hostRe.test(host)) {
        // The user steered the viewer off its family — release it, it is theirs.
        await clearWarmDestTab(family);
      }
    }
  });
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  warmSerial(async () => {
    for (const family of Object.keys(WARM_DEST_FAMILIES)) {
      const state = await readWarmDestTab(family);
      if (!state || state.tabId !== activeInfo.tabId || state.used) continue;
      await writeWarmDestTab(family, { ...state, used: true });
      try { await chrome.tabs.update(activeInfo.tabId, { muted: false }); } catch (_) {}
    }
  });
});

/* -------------------- X-Ray (account intel ledger) --------------------
 *
 * Opt-in (xrayEnabled, default off). The x.com MAIN world digests the page's
 * OWN GraphQL responses into derived facts; this worker is the ledger that
 * remembers them across visits and the arbiter that decides whether a deep
 * scan may spend a request.
 *
 * Three properties this section is responsible for:
 *
 *  - REVALIDATION. A digest arrives from a page-adjacent world, so every
 *    field is re-checked here before it can touch stored state. A hostile
 *    page can, at worst, write plausible-looking entries about accounts into
 *    a local ledger — no request is issued on its say-so beyond the budget
 *    below, and nothing leaves the device.
 *  - BUDGET. Deep scans are bounded per account (cooldown) and globally
 *    (a rolling per-minute cap) and are only ever executed by the page
 *    itself, with its own session, against its own origin. This worker never
 *    issues an X request — X-Ray adds no network call to the service worker.
 *  - HONEST STORAGE. Watch-window history is what THIS device saw, and the
 *    first sighting timestamp is never overwritten, so the panel can always
 *    say how long "no change seen" has actually been true for.
 */

const XRAY_STORAGE_KEY = 'pt_xray';
const XRAY_SCAN_COOLDOWN_MS = 6 * 60 * 60 * 1000; // per account, per op
const XRAY_SCAN_PER_MINUTE = 10;
const XRAY_TWEET_PAGES = 4; // deep-scan paging depth per profile visit
const xrayScanStamps = [];
const xrayPending = new Map(); // requestId -> { restId, op, plannedAt }

function xrayFeatureOn(settings) {
  return settings.appEnabled !== false && settings.xrayEnabled === true;
}

let xrayChain = Promise.resolve();
function xraySerial(fn) {
  const next = xrayChain.catch(() => {}).then(fn);
  xrayChain = next.catch(() => {});
  return next;
}

function readLedger() {
  return new Promise((resolve) => chrome.storage.local.get([XRAY_STORAGE_KEY], (value) => {
    if (chrome.runtime && chrome.runtime.lastError) { resolve(XR.emptyLedger()); return; }
    const stored = value[XRAY_STORAGE_KEY];
    if (!stored || typeof stored !== 'object') { resolve(XR.emptyLedger()); return; }
    resolve({
      accounts: stored.accounts && typeof stored.accounts === 'object' ? stored.accounts : {},
      handleIdx: stored.handleIdx && typeof stored.handleIdx === 'object' ? stored.handleIdx : {},
      order: Array.isArray(stored.order) ? stored.order : [],
      ops: stored.ops && typeof stored.ops === 'object' ? stored.ops : {},
    });
  }));
}

function writeLedger(ledger) {
  return new Promise((resolve) => chrome.storage.local.set({ [XRAY_STORAGE_KEY]: ledger }, () => resolve()));
}

/* ---- revalidation of page-adjacent input ---- */

const XRAY_HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const XRAY_ID_RE = /^\d{1,25}$/;

function xrayCleanUser(u) {
  if (!u || typeof u !== 'object') return null;
  if (!XRAY_ID_RE.test(String(u.restId)) || !XRAY_HANDLE_RE.test(String(u.handle))) return null;
  const text = (v, cap) => (typeof v === 'string' ? v.slice(0, cap) : null);
  const count = (v) => (Number.isFinite(v) && v >= 0 && v < 1e10 ? Math.floor(v) : null);
  const stamp = (v) => (Number.isFinite(v) && v > 0 && v < 4102444800000 ? v : null);
  const avatar = typeof u.avatar === 'string' && /^https:\/\//.test(u.avatar) ? u.avatar.slice(0, 300) : null;
  return {
    restId: String(u.restId),
    handle: String(u.handle),
    name: text(u.name, XR.LIMITS.nameChars),
    bio: text(u.bio, XR.LIMITS.bioChars),
    urls: Array.isArray(u.urls) ? u.urls.filter((x) => typeof x === 'string').slice(0, 12).map((x) => x.slice(0, 600)) : [],
    avatar,
    createdAt: stamp(u.createdAt),
    followers: count(u.followers),
    following: count(u.following),
    verified: u.verified === true,
  };
}

function xrayCleanTweet(t) {
  if (!t || typeof t !== 'object') return null;
  if (!XRAY_ID_RE.test(String(t.id))) return null;
  const cas = Array.isArray(t.cas)
    ? t.cas.filter((c) => isSolanaAddress(c)).slice(0, 12)
    : [];
  return {
    id: String(t.id),
    authorId: XRAY_ID_RE.test(String(t.authorId)) ? String(t.authorId) : null,
    createdAt: Number.isFinite(t.createdAt) && t.createdAt > 0 && t.createdAt < 4102444800000 ? t.createdAt : null,
    cas,
  };
}

function xrayCleanDigest(digest) {
  if (!digest || typeof digest !== 'object') return null;
  if (typeof digest.op !== 'string' || !XR.OPS.has(digest.op)) return null;
  const users = (Array.isArray(digest.users) ? digest.users : [])
    .slice(0, XR.LIMITS.maxUsersPerDigest).map(xrayCleanUser).filter(Boolean);
  const tweets = (Array.isArray(digest.tweets) ? digest.tweets : [])
    .slice(0, XR.LIMITS.maxTweetsPerDigest).map(xrayCleanTweet).filter(Boolean);
  let opShape = null;
  if (digest.opShape && typeof digest.opShape === 'object'
      && typeof digest.opShape.op === 'string' && XR.REPLAY_OPS.has(digest.opShape.op)
      && typeof digest.opShape.url === 'string'
      && digest.opShape.headers && typeof digest.opShape.headers === 'object') {
    let sameOrigin = false;
    try { sameOrigin = XL.isXHost(new URL(digest.opShape.url).hostname); } catch (_) { sameOrigin = false; }
    if (sameOrigin) {
      const headers = {};
      for (const k of Object.keys(digest.opShape.headers).slice(0, 8)) {
        const v = digest.opShape.headers[k];
        if (typeof v === 'string') headers[String(k).toLowerCase().slice(0, 40)] = v.slice(0, 400);
      }
      opShape = { op: digest.opShape.op, url: digest.opShape.url.slice(0, 2000), headers };
    }
  }
  return {
    op: digest.op,
    users,
    tweets,
    cursor: typeof digest.cursor === 'string' ? digest.cursor.slice(0, 400) : null,
    subjectRestId: XRAY_ID_RE.test(String(digest.subjectRestId)) ? String(digest.subjectRestId) : null,
    followersTarget: XRAY_ID_RE.test(String(digest.followersTarget)) ? String(digest.followersTarget) : null,
    scan: digest.scan && typeof digest.scan === 'object' && typeof digest.scan.requestId === 'string'
      ? { requestId: digest.scan.requestId.slice(0, 80), status: digest.scan.status }
      : null,
    opShape,
  };
}

/** The account a digest is about, resolved against the route the panel says
 * it is on. Route handle wins where the payload is ambiguous — a follower
 * list contains a hundred users and only one of them is the subject. */
function xraySubjectId(ledger, digest, routeHandle) {
  if (digest.subjectRestId) return digest.subjectRestId;
  if (digest.followersTarget) return digest.followersTarget;
  if (routeHandle && XRAY_HANDLE_RE.test(routeHandle)) {
    const known = ledger.handleIdx[routeHandle.toLowerCase()];
    if (known) return known;
    const hit = digest.users.find((u) => u.handle.toLowerCase() === routeHandle.toLowerCase());
    if (hit) return hit.restId;
  }
  return null;
}

function xrayRecordFor(ledger, user, now) {
  const existing = ledger.accounts[user.restId] || null;
  const { record, changed } = XR.observeUser(existing, user, now);
  ledger.accounts[user.restId] = record;
  ledger.handleIdx[record.handle] = record.restId;
  XR.touchAccount(ledger, record.restId);
  return { record, changed };
}

async function xrayObserve(message, settings) {
  if (!xrayFeatureOn(settings)) return { ok: false };
  const digest = xrayCleanDigest(message.digest);
  if (!digest) return { ok: false };
  const routeHandle = typeof message.handle === 'string' && XRAY_HANDLE_RE.test(message.handle)
    ? message.handle.toLowerCase() : null;

  return xraySerial(async () => {
    const now = Date.now();
    const ledger = await readLedger();

    if (digest.opShape) {
      ledger.ops[digest.opShape.op] = {
        url: digest.opShape.url, headers: digest.opShape.headers, at: now,
      };
    }
    if (digest.scan) {
      const pending = xrayPending.get(digest.scan.requestId);
      if (pending) {
        xrayPending.delete(digest.scan.requestId);
        const failed = digest.scan.status !== 200;
        const record = ledger.accounts[pending.restId];
        if (record) record.lastDeepScanAt = now;
        if (failed && (digest.scan.status === 'no_shape' || Number(digest.scan.status) >= 400)) {
          // The remembered shape no longer works (X rotated its query id, or
          // rate-limited us). Forget it rather than retry it every visit.
          delete ledger.ops[pending.op];
        }
      }
    }

    // Every user in the payload gets its own record — that is what makes a
    // notable follower's own history available the moment you click through.
    for (const user of digest.users) xrayRecordFor(ledger, user, now);

    const subjectId = xraySubjectId(ledger, digest, routeHandle);
    let intel = null;
    let scanAgain = false;

    if (subjectId && ledger.accounts[subjectId]) {
      const record = ledger.accounts[subjectId];
      XR.observeTweets(record, digest.tweets, now);

      if (XR.FOLLOWER_OPS.has(digest.op) && digest.followersTarget === subjectId) {
        const source = digest.op === 'FollowersYouKnow' ? 'you_follow' : 'followers';
        const others = digest.users.filter((u) => u.restId !== subjectId && u.followers !== null);
        if (others.length) XR.mergeSmart(record, others, source, now);
      }
      if (digest.cursor && (digest.op === 'UserTweets' || digest.op === 'UserTweetsAndReplies')) {
        record.scanCursor = digest.cursor;
      }
      XR.touchAccount(ledger, subjectId);
      intel = XR.assembleIntel(record, now);
      scanAgain = digest.scan !== null && digest.scan.status === 200;
    }

    await writeLedger(ledger);
    return { ok: true, intel, scanAgain };
  });
}

async function xrayGet(message, settings) {
  if (!xrayFeatureOn(settings)) return { ok: false };
  const handle = typeof message.handle === 'string' && XRAY_HANDLE_RE.test(message.handle)
    ? message.handle.toLowerCase() : null;
  if (!handle) return { ok: false };
  const ledger = await readLedger();
  const restId = ledger.handleIdx[handle];
  const record = restId ? ledger.accounts[restId] : null;
  if (!record) return { ok: true, intel: null };
  return { ok: true, intel: XR.assembleIntel(record, Date.now()) };
}

/** Decide the ONE request (if any) worth spending on this account right now.
 * Preference order: tweet history first (CA history is the highest-value
 * missing piece and needs paging), then the followers-you-know edge, then a
 * follower page. Returns null when the budget says no — the passive layer
 * keeps working regardless. */
async function xrayPlan(message, settings) {
  if (!xrayFeatureOn(settings)) return { ok: false };
  if (settings.xrayDeepScanEnabled === false) return { ok: true, scan: null };
  if (!XRAY_ID_RE.test(String(message.restId))) return { ok: false };

  const now = Date.now();
  while (xrayScanStamps.length && now - xrayScanStamps[0] > 60_000) xrayScanStamps.shift();
  if (xrayScanStamps.length >= XRAY_SCAN_PER_MINUTE) return { ok: true, scan: null };
  for (const [id, pending] of xrayPending) {
    if (now - pending.plannedAt > 30_000) xrayPending.delete(id);
  }
  if (xrayPending.size >= 2) return { ok: true, scan: null };

  return xraySerial(async () => {
    const ledger = await readLedger();
    const record = ledger.accounts[String(message.restId)];
    if (!record) return { ok: true, scan: null };

    let op = null;
    let cursor = null;
    const pagesLeft = (record.tweetRing.length / 20) < XRAY_TWEET_PAGES;
    if (record.scanCursor && pagesLeft && ledger.ops.UserTweets) {
      op = 'UserTweets';
      cursor = record.scanCursor;
    } else if (now - (record.lastDeepScanAt || 0) > XRAY_SCAN_COOLDOWN_MS) {
      if (!record.smartAt && ledger.ops.FollowersYouKnow) op = 'FollowersYouKnow';
      else if (!record.smartAt && ledger.ops.BlueVerifiedFollowers) op = 'BlueVerifiedFollowers';
      else if (!record.tweetRing.length && ledger.ops.UserTweets) op = 'UserTweets';
    }
    if (!op) return { ok: true, scan: null };

    const shape = ledger.ops[op];
    if (!shape) return { ok: true, scan: null };
    const requestId = 'ptx-' + now.toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);
    xrayPending.set(requestId, { restId: String(message.restId), op, plannedAt: now });
    xrayScanStamps.push(now);
    record.lastDeepScanAt = now;
    if (op === 'UserTweets' && cursor) record.scanCursor = null; // consumed
    await writeLedger(ledger);

    return {
      ok: true,
      scan: {
        requestId,
        op,
        userId: String(message.restId),
        cursor,
        count: op === 'UserTweets' ? 40 : 20,
        shape: { url: shape.url, headers: shape.headers },
      },
    };
  });
}

/* -------------------- message routing -------------------- */

const BASE58_RE = /^[A-HJ-NP-Za-km-z1-9]{32,44}$/;
const MAX_MINTS_PER_BATCH = 100;

function isSolanaAddress(s) {
  return typeof s === 'string' && BASE58_RE.test(s);
}

function sanitizeMints(list) {
  if (!Array.isArray(list)) return null;
  const clean = list.filter(isSolanaAddress);
  return clean.length ? clean.slice(0, MAX_MINTS_PER_BATCH) : null;
}

function isValidTokenForRefresh(t) {
  if (!t || typeof t !== 'object') return false;
  if (!isSolanaAddress(t.mint)) return false;
  if (t.pairAddress && !isSolanaAddress(t.pairAddress)) return false;
  return true;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return;

  (async () => {
    const settings = await getSettings();
    switch (message.type) {
      case 'pt_open_dashboard':
        openDashboard();
        sendResponse({ ok: true });
        break;

      case 'pt_trade_event': {
        const session = RP.normalizeSession(message.session || message.round || {});
        if (sender.tab && sender.tab.id) lastTradeTabId = sender.tab.id;
        if (message.opened && settings.recordingEnabled) await startRecording(sender.tab?.id, session.symbol);
        await snapFrame(message.kind || message.trade?.side || 'fill', session, sender.tab?.id);
        if (message.round && settings.recordingEnabled) await stopRecording(message.round.id);
        await recordReplay(session, message.round || null);
        await refreshFrameInterval();
        if (message.round && settings.autoReview && message.round.id) {
          autoReview(message.round.id).catch(() => {});
        }
        sendResponse({ ok: true });
        break;
      }

      // Compatibility with PaperTrench 0.4 content scripts still alive in an
      // already-open tab while the extension service worker updates.
      case 'pt_round_opened': {
        const session = RP.normalizeSession(message.session || {
          mint: message.mint,
          symbol: message.symbol,
          openedAt: Date.now(),
        });
        if (settings.recordingEnabled) await startRecording(sender.tab?.id, session.symbol);
        await snapFrame('buy', session, sender.tab?.id);
        await recordReplay(session);
        await refreshFrameInterval();
        sendResponse({ ok: true });
        break;
      }

      case 'pt_round_closed': {
        const session = RP.normalizeSession(message.session || message.round || {});
        if (settings.recordingEnabled) await stopRecording(message.round?.id);
        await snapFrame('sell', session, sender.tab?.id);
        await recordReplay(session, message.round || null);
        await refreshFrameInterval();
        if (settings.autoReview && message.round?.id) autoReview(message.round.id).catch(() => {});
        sendResponse({ ok: true });
        break;
      }

      case 'pt_snap_frame': {
        await snapFrame(message.kind || 'fill', message.session || message, sender.tab?.id);
        await refreshFrameInterval();
        sendResponse({ ok: true });
        break;
      }



      case 'pt_settings_changed':
        await refreshFrameInterval();
        await warmSettingsChanged(settings);
        await warmDestSettingsChanged(settings);
        sendResponse({ ok: true });
        break;

      case 'pt_warmdest_open':
        sendResponse(await warmDestOpen(message.url, sender, settings));
        break;

      case 'pt_warmdest_hint':
        warmDestHint(message.url, settings).catch(() => {});
        sendResponse({ ok: true });
        break;

      case 'pt_warmdest_prewarm':
        warmDestPrewarm().catch(() => {});
        sendResponse({ ok: true });
        break;

      case 'pt_warm_open':
        sendResponse(await warmOpen(message.url, sender, settings));
        break;

      case 'pt_warm_hint':
        warmHint(message.url, settings).catch(() => {});
        sendResponse({ ok: true });
        break;

      case 'pt_warm_oembed':
        sendResponse(await warmOembed(message.url, settings));
        break;

      case 'pt_warm_prewarm':
        warmPrewarm().catch(() => {});
        sendResponse({ ok: true });
        break;

      case 'pt_warm_spa_result':
        warmSpaResult(message, sender);
        sendResponse({ ok: true });
        break;

      case 'pt_xray_observe':
        sendResponse(await xrayObserve(message, settings));
        break;

      case 'pt_xray_get':
        sendResponse(await xrayGet(message, settings));
        break;

      case 'pt_xray_plan':
        sendResponse(await xrayPlan(message, settings));
        break;

      // The in-page Flex composer's gallery. A content script's IndexedDB is
      // site-origin; these three keep uploads in the ONE extension-origin
      // gallery the dashboard composer reads directly.
      case 'pt_cardbg_list':
        try { sendResponse({ ok: true, items: await cardBgList() }); }
        catch (e) { sendResponse({ ok: false, items: [], error: e && e.message }); }
        break;

      case 'pt_cardbg_add':
        try { sendResponse(await cardBgAdd(message.name, message.dataUrl)); }
        catch (e) { sendResponse({ ok: false, error: e && e.message }); }
        break;

      case 'pt_cardbg_remove':
        try { sendResponse(await cardBgRemove(message.id)); }
        catch (e) { sendResponse({ ok: false, error: e && e.message }); }
        break;

      case 'pt_clear_recordings':
        // The popup's reset promises recordings go too, but the popup is
        // deliberately storage-only — IndexedDB cleanup runs here (D-36).
        try { await self.PTRecordings.clear(); sendResponse({ ok: true }); }
        catch (e) { sendResponse({ ok: false, error: e && e.message }); }
        break;

      case 'pt_ai_chat':
        sendResponse(await aiChat({ messages: message.messages, maxTokens: message.maxTokens }));
        break;

      case 'pt_ai_models':
        // D-29: optional overrides carry the dashboard's UNSAVED form values
        // for the endpoint test; aiModels validates them through the same
        // isAllowedEndpoint gate and persists nothing.
        sendResponse(await aiModels(message.overrides));
        break;

      case 'pt_rec_query':
        sendResponse({ active: recActive });
        break;

      case 'pt_recording_toggle':
        if (!message.enabled && recActive) await stopRecording(null);
        sendResponse({ ok: true });
        break;

      // Price resolution is done from the service worker so it is not subject to
      // the page origin's CORS or CSP. The content script supplies only mints
      // and addresses; the background decides which public APIs to call.
      case 'pt_resolve': {
        if (!isSolanaAddress(message.address)) { sendResponse(null); break; }
        const maxAgeMs = Number(message.maxAgeMs);
        const opts = Number.isFinite(maxAgeMs) && maxAgeMs >= 0 ? { maxAgeMs } : undefined;
        try { sendResponse(await R.resolve(message.address, opts)); } catch (e) { sendResponse(null); }
        break;
      }

      case 'pt_sol_usd':
        try { sendResponse(await R.solUsd()); } catch (e) { sendResponse(0); }
        break;

      case 'pt_refresh':
        if (!isValidTokenForRefresh(message.token)) { sendResponse(null); break; }
        try { sendResponse(await R.refresh(message.token)); } catch (e) { sendResponse(null); }
        break;

      case 'pt_batch_prices': {
        const mints = sanitizeMints(message.mints);
        if (!mints) { sendResponse({}); break; }
        try { sendResponse(await R.batchPrices(mints)); } catch (e) { sendResponse({}); }
        break;
      }

      // Begin streaming live pool state for the token on screen. Prices then
      // arrive from chain state at `processed` commitment instead of from an
      // aggregator running ~2-3s behind.
      case 'pt_onchain_watch': {
        if (!FEED || !isSolanaAddress(message.mint) || !isSolanaAddress(message.pool)) {
          sendResponse({ live: false });
          break;
        }
        try {
          // An empty rpcUrl is the normal case: the keyless public pool.
          const settings = await getSettings();
          FEED.configure({ rpcUrl: settings.rpcUrl || null });
          sendResponse({ live: await FEED.watch(message.mint, message.pool) });
        } catch (e) { sendResponse({ live: false }); }
        break;
      }

      case 'pt_onchain_unwatch':
        if (FEED && isSolanaAddress(message.mint)) FEED.unwatch(message.mint);
        sendResponse({ ok: true });
        break;

      // The authoritative price at click time. Null means no fresh on-chain
      // observation exists, and the caller must not invent one.
      case 'pt_onchain_quote':
        if (!FEED || !isSolanaAddress(message.mint)) { sendResponse(null); break; }
        sendResponse(FEED.currentQuote(message.mint));
        break;

      default:
        sendResponse({ error: 'unknown message type' });
    }
  })().catch((error) => sendResponse({ error: error.message }));

  return true;
});

chrome.runtime.onStartup.addListener(() => {
  refreshFrameInterval().catch(() => {});
});
chrome.runtime.onInstalled.addListener(() => {
  refreshFrameInterval().catch(() => {});
});
refreshFrameInterval().catch(() => {});
