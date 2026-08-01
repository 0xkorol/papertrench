/* PaperTrench — session replay model.
 *
 * A "replay" is one paper round trip rendered as a timeline: every fill, every
 * captured chart frame, and the screen recording if one was made. This module
 * owns the shape of that record and the pure helpers that build it, so both the
 * service worker (which writes) and the dashboard (which plays it back) agree
 * on one contract.
 */
(() => {
  'use strict';

  const SCHEMA_VERSION = 1;
  const STORAGE_KEY = 'pt_replays';
  const MAX_REPLAYS = 80;

  function text(value, max = 300) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function integer(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
  }

  function number(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function sessionId(mint, openedAt) {
    const cleanMint = text(mint, 60).replace(/[^A-Za-z0-9]/g, '');
    const stamp = Math.max(0, integer(openedAt) || Date.now()).toString(36);
    const tail = cleanMint ? cleanMint.slice(0, 5) + cleanMint.slice(-4) : 'unknown';
    return `pts-${stamp}-${tail}`;
  }

  /** Normalize whatever the caller has into a stable session descriptor. */
  function normalizeSession(value) {
    const raw = value && typeof value === 'object' ? value : {};
    const mint = text(raw.mint, 60);
    const openedAt = Math.max(0, integer(raw.openedAt ?? raw.startedAt) || Date.now());
    return {
      sessionId: text(raw.sessionId, 100) || sessionId(mint, openedAt),
      roundId: text(raw.roundId ?? raw.id, 100) || null,
      mint,
      symbol: text(raw.symbol, 40),
      name: text(raw.name, 120),
      site: text(raw.site, 40) || 'unknown',
      openedAt,
      closedAt: integer(raw.closedAt ?? raw.endedAt),
    };
  }

  function normalizeReplayList(value) {
    return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : [];
  }

  function newReplay(sessionValue) {
    const session = normalizeSession(sessionValue);
    return {
      version: SCHEMA_VERSION,
      sessionId: session.sessionId,
      roundId: session.roundId,
      mint: session.mint,
      symbol: session.symbol,
      name: session.name,
      site: session.site,
      openedAt: session.openedAt,
      closedAt: session.closedAt,
      status: session.closedAt ? 'closed' : 'open',
      errors: [],
      updatedAt: Date.now(),
    };
  }

  function findReplay(replaysValue, sessionOrId) {
    const replays = normalizeReplayList(replaysValue);
    const id = typeof sessionOrId === 'string'
      ? sessionOrId
      : normalizeSession(sessionOrId).sessionId;
    return replays.find((item) => item.sessionId === id) || null;
  }

  /** Create or update the replay record for a session. */
  function upsertReplay(replaysValue, sessionValue) {
    const replays = normalizeReplayList(replaysValue);
    const session = normalizeSession(sessionValue);
    let replay = findReplay(replays, session.sessionId);
    if (!replay) {
      replay = newReplay(session);
      replays.unshift(replay);
    }
    replay.roundId = session.roundId || replay.roundId || null;
    replay.mint = session.mint || replay.mint;
    replay.symbol = session.symbol || replay.symbol;
    replay.name = session.name || replay.name;
    replay.site = session.site || replay.site;
    replay.openedAt = Math.min(replay.openedAt || session.openedAt, session.openedAt);
    replay.updatedAt = Date.now();

    replays.sort((a, b) => Number(b.openedAt) - Number(a.openedAt));
    if (replays.length > MAX_REPLAYS) replays.length = MAX_REPLAYS;
    return { replays, replay };
  }

  /** Seal a replay with the round's final result. */
  function closeReplay(replaysValue, sessionValue, roundValue) {
    const session = normalizeSession(sessionValue);
    const { replays, replay } = upsertReplay(replaysValue, session);
    const round = roundValue && typeof roundValue === 'object' ? roundValue : {};
    replay.roundId = text(round.id || session.roundId, 100) || replay.roundId;
    replay.closedAt = integer(round.closedAt || session.closedAt) || Date.now();
    replay.status = 'closed';
    replay.result = {
      pnlSol: number(round.pnlSol),
      pnlPct: number(round.pnlPct),
      investedSol: number(round.investedSol),
      returnedSol: number(round.returnedSol),
      heldMs: integer(round.heldMs),
    };
    replay.updatedAt = Date.now();
    return { replays, replay };
  }

  /**
   * Interleave a session's fills and captured frames into one ordered timeline.
   *
   * Fills come first when timestamps tie, because a frame is captured as a
   * consequence of the fill rather than the other way round.
   */
  function buildReplayEvents(replayValue, tradesValue, framesValue) {
    const replay = replayValue && typeof replayValue === 'object' ? replayValue : {};
    const start = Number(replay.openedAt) || 0;
    const end = Number(replay.closedAt) || Number.MAX_SAFE_INTEGER;
    const inSession = (item) => {
      if (item.sessionId) return item.sessionId === replay.sessionId;
      return item.mint === replay.mint
        && Number(item.ts ?? item.t) >= start
        && Number(item.ts ?? item.t) <= end;
    };

    const events = [];
    for (const trade of (Array.isArray(tradesValue) ? tradesValue : []).filter(inSession)) {
      events.push({ at: Number(trade.ts), kind: trade.side, source: 'papertrench', trade });
    }
    for (const frame of (Array.isArray(framesValue) ? framesValue : []).filter(inSession)) {
      events.push({ at: Number(frame.t), kind: 'frame', source: 'papertrench', frame });
    }
    events.sort((a, b) => a.at - b.at || (a.trade ? -1 : 1));
    return events;
  }

  function addReplayError(replaysValue, sessionValue, errorValue, at = Date.now()) {
    const { replays, replay } = upsertReplay(replaysValue, sessionValue);
    replay.errors = Array.isArray(replay.errors) ? replay.errors : [];
    replay.errors.push({
      at: integer(at) || Date.now(),
      message: text(errorValue && errorValue.message ? errorValue.message : errorValue, 300) || 'Unknown replay error',
    });
    if (replay.errors.length > 20) replay.errors.splice(0, replay.errors.length - 20);
    replay.updatedAt = Date.now();
    return { replays, replay };
  }

  const api = {
    SCHEMA_VERSION,
    STORAGE_KEY,
    MAX_REPLAYS,
    sessionId,
    normalizeSession,
    normalizeReplayList,
    newReplay,
    findReplay,
    upsertReplay,
    closeReplay,
    addReplayError,
    buildReplayEvents,
  };

  if (typeof window !== 'undefined') window.PTReplay = api;
  if (typeof self !== 'undefined') self.PTReplay = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
