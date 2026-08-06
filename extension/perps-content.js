/* PaperTrench — perps ticket content script (ISOLATED world).
 *
 * The thin DOM layer over the pure stack: perps-sites (where am I),
 * perps-venues (venue math + API parsers), perps (the book),
 * perps-ticket (view-model), perps-reconcile (offline truth).
 *
 * Design constraints inherited from the product:
 *  - Wrong presence is a defect class: the ticket mounts only on a detected
 *    perps market page, and for Hyperliquid only after the market is
 *    confirmed against the live perp universe.
 *  - No background involvement: api.hyperliquid.xyz serves
 *    Access-Control-Allow-Origin: * (verified 2026-08-05), so the feed
 *    fetches directly from here. No new message types, no new permissions.
 *  - No polling the world when nobody is looking: intervals run only while
 *    the tab is visible, and everything stops on extension reload
 *    (chrome.runtime.id guard — the orphaned-script doctrine).
 *  - Never blank before rebuilding: static chrome is built once; only
 *    numbers and rows are swapped, via replaceChildren on detached nodes.
 *  - Storage writes are revision-guarded read-modify-write with retry, and
 *    tick-driven state (lastSeenMs) persists lazily, not per tick.
 */
(() => {
  'use strict';

  const S = window.PaperPerpsSites;
  const V = window.PaperPerpsVenues;
  const P = window.PaperPerps;
  const T = window.PaperPerpsTicket;
  const RC = window.PaperPerpsReconcile;
  const BARS = window.PaperBars;
  const TAC = window.PaperTA;
  if (!S || !V || !P || !T || !RC || !BARS || !TAC) return;

  const STORE_KEY = 'pt_perps';
  const UI_KEY = 'pt_perps_ui';
  const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';
  const PARAMS_REFRESH_MS = 30000;
  const LOCATION_POLL_MS = 1000;
  const CARRY_TICK_MS = 60000;
  const ENTRY_RETRY_MS = 5000;
  const ENTRY_ATTEMPTS_BEFORE_NOTICE = 6; // ~30s of the venue not answering
  const ACCEPT_RATIO = 20; // same magnitude gate doctrine as quote.js
  const BARS_REFRESH_MS = 60000;
  const BARS_LOOKBACK_MS = 12 * 3600 * 1000; // ~144 5m bars: emaSlow warms honestly
  const RES_SEC = 300;

  /* ------------------------- lifetime hygiene ------------------------- */

  const timers = new Set();
  let dead = false;

  function alive() {
    if (dead) return false;
    try { if (chrome.runtime.id) return true; } catch (e) { /* fall through */ }
    teardown();
    return false;
  }

  function managedInterval(fn, ms) {
    const h = setInterval(() => {
      if (!alive()) return;
      if (document.visibilityState !== 'visible') return;
      fn();
    }, ms);
    timers.add(h);
    return h;
  }

  function teardown() {
    if (dead) return;
    dead = true;
    for (const h of timers) clearInterval(h);
    timers.clear();
    if (titleObserver) titleObserver.disconnect();
    if (root) root.remove();
  }

  /* --------------------------- feed state --------------------------- */

  let adapter = null;        // { venue, market, ... } from perps-sites
  let hlAssets = null;       // parsed metaAndAssetCtxs
  let jupBorrowFrac = null;  // parsed displayed rate
  let lastPx = 0;            // newest accepted tick for the current market
  let lastPxAt = 0;
  let state = null;          // the perps book (pt_perps.state)
  let stateRev = 0;
  let reconciled = false;
  let barStore = null;       // TA bar ring for the current HL market
  let taReads = null;        // assembleReads() context pack, or null
  let venueParamsPending = false; // entry is waiting on the venue's own API
  let entryAttempts = 0;
  let venueUnreachable = false;   // said out loud rather than left blank

  function anchorPx() {
    if (adapter && adapter.venue === 'hyperliquid' && hlAssets && hlAssets[adapter.market]) {
      return hlAssets[adapter.market].markPx;
    }
    return lastPx;
  }

  function acceptTick(px) {
    if (!Number.isFinite(px) || px <= 0) return false;
    const anchor = anchorPx();
    if (anchor > 0 && (px > anchor * ACCEPT_RATIO || px < anchor / ACCEPT_RATIO)) return false;
    lastPx = px;
    lastPxAt = Date.now();
    return true;
  }

  async function fetchHlInfo(body) {
    const res = await fetch(HL_INFO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('hl-info-' + res.status);
    return res.json();
  }

  /* TA bars: the venue's own candles feed the bar store (provenance
   * backfill:hl-api), and every read downstream stays warm-up honest —
   * a failed fetch leaves the strip saying how many bars it has, never
   * inventing the rest. Hyperliquid only: Jupiter has no verified candle
   * source yet, so its strip stays silent rather than approximate. */
  async function refreshBars() {
    if (!adapter || adapter.venue !== 'hyperliquid' || !barStore) return;
    try {
      const nowMs = Date.now();
      const rows = await fetchHlInfo({
        type: 'candleSnapshot',
        req: { coin: adapter.market, interval: '5m', startTime: nowMs - BARS_LOOKBACK_MS, endTime: nowMs },
      });
      if (!Array.isArray(rows)) return;
      for (const r of rows) {
        const b = { t: Math.floor(r.t / 1000), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c) };
        const v = Number(r.v);
        if (Number.isFinite(v)) b.v = v;
        BARS.noteBar(barStore, adapter.market, RES_SEC, b, 'backfill:hl-api');
      }
      taReads = TAC.assembleReads(BARS.bars(barStore, adapter.market, RES_SEC));
      scheduleRender();
    } catch (e) { /* strip stays on its last honest state */ }
  }

  async function refreshParams() {
    if (!adapter) return;
    if (adapter.venue === 'hyperliquid') {
      try {
        const payload = await fetchHlInfo({ type: 'metaAndAssetCtxs' });
        const parsed = V.parseHlAssetCtxs(payload);
        if (parsed) hlAssets = parsed;
      } catch (e) { /* stale params stay; the carry gate keeps opens honest */ }
    } else if (adapter.venue === 'jupiter') {
      jupBorrowFrac = S.parseJupBorrowRate(document.body ? document.body.innerText : '');
    }
    scheduleRender();
  }

  /* --------------------------- storage --------------------------- */

  function freshState() { return P.defaultPerpsState({}); }

  /* A stored book that does not have the shape of a book degrades to an
   * empty one rather than throwing on every tick from inside an interval.
   * `positions` is dereferenced on the hot path, so an absent or non-object
   * value took the whole ticket down silently once per tick. */
  function usableBook(candidate) {
    return Boolean(candidate)
      && typeof candidate === 'object'
      && Boolean(candidate.positions)
      && typeof candidate.positions === 'object'
      && typeof candidate.cashUsd === 'number'
      && Number.isFinite(candidate.cashUsd);
  }

  function loadStore() {
    return new Promise((resolve) => {
      chrome.storage.local.get([STORE_KEY], (o) => {
        const rec = o && o[STORE_KEY];
        state = usableBook(rec && rec.state) ? rec.state : freshState();
        stateRev = rec && Number.isInteger(rec.rev) ? rec.rev : 0;
        resolve();
      });
    });
  }

  /* Revision-guarded read-modify-write: re-reads and re-applies on
   * contention, so a dashboard tab and this ticket can never eat each
   * other's fills. op(state) must be deterministic and return {ok,...}. */
  async function applyOp(op) {
    for (let attempt = 0; attempt < 3; attempt++) {
      await loadStore();
      const result = op(state);
      const wroteRev = stateRev;
      const won = await new Promise((resolve) => {
        chrome.storage.local.get([STORE_KEY], (o) => {
          const cur = o && o[STORE_KEY];
          const curRev = cur && Number.isInteger(cur.rev) ? cur.rev : 0;
          if (curRev !== wroteRev) { resolve(false); return; }
          chrome.storage.local.set({ [STORE_KEY]: { rev: wroteRev + 1, state } }, () => {
            stateRev = wroteRev + 1;
            resolve(!chrome.runtime.lastError);
          });
        });
      });
      if (won) { scheduleRender(); return result; }
    }
    return { ok: false, reason: 'storage-contention' };
  }

  /* ------------------------ offline reconciliation ------------------------
   * On boot (the wake moment) every open position is reconciled against
   * what actually happened while nobody was watching. HL gets the full
   * candle+funding replay; Jupiter gets the wake-price check with the gap
   * recorded. Runs once per page load, before the first render of rows. */

  /* One Hyperliquid position, reconciled against the venue's own history for
   * everything since it was last settled. This runs on boot AND on the carry
   * interval, deliberately: funding is a real cost the venue charges whether
   * or not anyone is looking, so an open tab must not be cheaper than a
   * closed one. Reusing the reconciler rather than accruing locally keeps
   * ONE arithmetic — the rates are the venue's actual published rates in
   * both cases, never an interpolation of our own.
   *
   * lastSeenMs advances ONLY here, as part of applying the carry. Stamping
   * it on a bare heartbeat (as an earlier version did) silently consumed the
   * window the funding replay reads, so an open tab paid no funding at all. */
  async function reconcileHlPosition(pos, nowMs) {
    const fromMs = Number.isInteger(pos.lastSeenMs) ? pos.lastSeenMs : pos.openT * 1000;
    if (nowMs - fromMs < 5 * 60000) return;
    let candles = null, funding = null;
    try {
      [candles, funding] = await Promise.all([
        fetchHlInfo({ type: 'candleSnapshot', req: { coin: pos.market, interval: '5m', startTime: fromMs - 300000, endTime: nowMs } }),
        fetchHlInfo({ type: 'fundingHistory', coin: pos.market, startTime: fromMs }),
      ]);
    } catch (e) { return; /* unreachable venue: the gap stays a gap */ }
    const plan = RC.reconcileHl(pos, {
      candles, funding, fromMs: fromMs - 300000, toMs: nowMs, intervalMs: 300000,
    });
    await applyOp((st) => {
      const live = st.positions[pos.id];
      if (!live) return { ok: true };
      if (plan.verdict === 'liquidated') {
        P.applyHlFunding(st, live.id, plan.fundingBefore, { markPx: plan.crossPx });
        const r = P.liquidatePerp(st, live.id, { price: plan.crossPx, t: Math.floor(plan.atMs / 1000) });
        if (r.ok) st.rounds[st.rounds.length - 1].provenance = plan.provenance;
        return r;
      }
      if (plan.verdict === 'survived') {
        P.applyHlFunding(st, live.id, plan.fundingApplied, { markPx: plan.lastPx });
        P.markPerp(st, live.id, { price: plan.lastPx });
        live.lastSeenMs = nowMs;
        return { ok: true };
      }
      live.unverifiedGapSec = (live.unverifiedGapSec || 0) + Math.round((nowMs - fromMs) / 1000);
      live.lastSeenMs = nowMs;
      return { ok: true };
    });
  }

  /* Jupiter at wake: the gap's borrow is NOT invented — we did not observe
   * the rate over it, so it is recorded as unobserved and said so on the
   * row. Only a crossing we can prove from the wake price is acted on. */
  async function reconcileJupPositionOnWake(pos, nowMs) {
    if (!(adapter && adapter.venue === 'jupiter' && adapter.market === pos.market && lastPx > 0)) return;
    const plan = RC.reconcileJup(pos, {
      nowPx: lastPx, nowMs,
      lastSeenMs: Number.isInteger(pos.lastSeenMs) ? pos.lastSeenMs : pos.openT * 1000,
    });
    await applyOp((st) => {
      const live = st.positions[pos.id];
      if (!live) return { ok: true };
      if (plan.verdict === 'liquidated') {
        const r = P.liquidatePerp(st, live.id, { price: plan.crossPx, t: Math.floor(nowMs / 1000) });
        if (r.ok) st.rounds[st.rounds.length - 1].provenance = plan.provenance;
        return r;
      }
      live.unverifiedGapSec = (live.unverifiedGapSec || 0) + (plan.gapSec || 0);
      live.lastSeenMs = nowMs;
      return { ok: true };
    });
  }

  /* Jupiter while we ARE watching: the venue publishes its effective hourly
   * borrow rate on the page, the ticket quotes it to the user before every
   * entry, and the position must actually be charged it. Without this the
   * paper position is permanently cheaper than the real venue — the ticket
   * would promise a cost it never collects, and the liquidation price would
   * never drift the way the real one does. No live rate means no charge and
   * no stamp: the time then falls to the unobserved-gap path instead. */
  async function accrueJupBorrowLive(pos, nowMs) {
    if (!Number.isFinite(jupBorrowFrac) || jupBorrowFrac < 0) return;
    await applyOp((st) => {
      const live = st.positions[pos.id];
      if (!live) return { ok: true };
      const r = P.accrueJupBorrow(st, live.id, {
        toT: Math.floor(nowMs / 1000), hourlyRateFrac: jupBorrowFrac,
      });
      if (r.ok) live.lastSeenMs = nowMs;
      return r;
    });
  }

  async function reconcileOnBoot() {
    if (reconciled) return;
    reconciled = true;
    await loadStore();
    const open = Object.values(state.positions);
    if (!open.length) return;
    const nowMs = Date.now();
    for (const pos of open) {
      if (pos.venue === 'hyperliquid') await reconcileHlPosition(pos, nowMs);
      else if (pos.venue === 'jupiter') await reconcileJupPositionOnWake(pos, nowMs);
    }
  }

  /* The carry tick: what leverage costs while you hold it. */
  async function carryTick() {
    if (!adapter || !state || !reconciled) return;
    const nowMs = Date.now();
    for (const pos of Object.values(state.positions)) {
      if (pos.venue !== adapter.venue || pos.market !== adapter.market) continue;
      if (pos.venue === 'hyperliquid') await reconcileHlPosition(pos, nowMs);
      else if (pos.venue === 'jupiter') await accrueJupBorrowLive(pos, nowMs);
    }
  }

  /* ------------------------ liquidation watch ------------------------ */

  function watchLiquidations() {
    if (!adapter || !state || !(lastPx > 0)) return;
    for (const pos of Object.values(state.positions)) {
      if (pos.venue !== adapter.venue || pos.market !== adapter.market) continue;
      // perpMark is pure: it takes the position record, not the book, so it
      // cannot read cash, the journal, totals or a sibling position, and it
      // writes nothing. No clone is needed to keep the question
      // non-destructive, and none to keep the cost flat as the account's
      // history grows. Only the committed applyOp path below may write, and
      // it re-decides against the real book.
      const m = P.perpMark(pos, lastPx);
      if (m.ok && m.liquidatable) {
        applyOp((st) => {
          if (!st.positions[pos.id]) return { ok: true };
          return P.liquidatePerp(st, pos.id, { price: lastPx, t: Math.floor(Date.now() / 1000) });
        }).then((r) => {
          if (r && r.ok) {
            flashNotice('Liquidated at ' + T.fmtPx(lastPx) + ' — margin lost.');
            playPerpSound('liquidation'); // no particles: this is not a win
          }
        });
      }
    }
  }

  /* ---------------------------- fill feedback ----------------------------
   * A fill you cannot feel is a fill you are not sure happened. This mirrors
   * the spot overlay exactly — same tones, same particle burst, same two
   * settings keys — so one toggle governs both surfaces.
   *
   * Deliberate asymmetry: a LIQUIDATION never celebrates. It gets a low,
   * flat two-tone and no particles. Confetti for a margin call would be the
   * product congratulating a user for losing everything. */

  let uiSettings = { tradeEffectsEnabled: true, tradeSoundsEnabled: true };

  function loadUiSettings() {
    try {
      chrome.storage.local.get(['pt_settings'], (o) => {
        const s = o && o.pt_settings;
        if (!s || typeof s !== 'object') return;
        if (typeof s.tradeEffectsEnabled === 'boolean') uiSettings.tradeEffectsEnabled = s.tradeEffectsEnabled;
        if (typeof s.tradeSoundsEnabled === 'boolean') uiSettings.tradeSoundsEnabled = s.tradeSoundsEnabled;
      });
    } catch (e) { /* defaults stand */ }
  }

  let audioCtx = null;
  function primeAudio() {
    try {
      if (!audioCtx) {
        const Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor) return null;
        audioCtx = new Ctor();
      }
      if (audioCtx.state === 'suspended') audioCtx.resume();
      return audioCtx;
    } catch (e) { return null; }
  }

  function playTone(ctx, frequency, start, duration, type, volume) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume || 0.06), start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }

  function playPerpSound(kind) {
    if (!uiSettings.tradeSoundsEnabled) return;
    const ctx = primeAudio();
    if (!ctx) return;
    const t = ctx.currentTime + 0.01;
    if (kind === 'long') {
      playTone(ctx, 523.25, t, 0.11, 'triangle', 0.055);
      playTone(ctx, 659.25, t + 0.07, 0.12, 'triangle', 0.06);
      playTone(ctx, 783.99, t + 0.14, 0.16, 'sine', 0.07);
    } else if (kind === 'short') {
      // Same shape inverted: a short is an entry too, just the other way up.
      playTone(ctx, 783.99, t, 0.11, 'triangle', 0.055);
      playTone(ctx, 659.25, t + 0.07, 0.12, 'triangle', 0.06);
      playTone(ctx, 523.25, t + 0.14, 0.16, 'sine', 0.07);
    } else if (kind === 'close') {
      playTone(ctx, 880, t, 0.10, 'triangle', 0.055);
      playTone(ctx, 659.25, t + 0.075, 0.14, 'sine', 0.065);
      playTone(ctx, 1046.5, t + 0.14, 0.10, 'sine', 0.04);
    } else if (kind === 'liquidation') {
      // Low, flat, unmistakable. Nothing celebratory.
      playTone(ctx, 174.61, t, 0.34, 'sawtooth', 0.05);
      playTone(ctx, 138.59, t + 0.16, 0.44, 'sine', 0.055);
    }
  }

  let effectRunId = 0;
  function runPerpEffect(side) {
    if (!uiSettings.tradeEffectsEnabled || !els || !els.effects) return;
    const layer = els.effects;
    const runId = ++effectRunId;
    layer.textContent = '';

    const flash = document.createElement('div');
    flash.className = 'pt-fx-flash ' + (side === 'short' ? 'short' : 'long');
    layer.appendChild(flash);

    const colors = side === 'short'
      ? ['#f85149', '#ff7b72', '#f0883e', '#ffffff', '#d29922']
      : ['#3fb950', '#58d68d', '#f0883e', '#ffd166', '#ffffff'];
    for (let i = 0; i < 42; i++) {
      const p = document.createElement('i');
      p.className = 'pt-fx-particle';
      p.style.left = (15 + Math.random() * 70) + '%';
      p.style.top = (25 + Math.random() * 35) + '%';
      p.style.background = colors[i % colors.length];
      p.style.setProperty('--dx', ((Math.random() - 0.5) * 360) + 'px');
      p.style.setProperty('--dy', (80 + Math.random() * 260) + 'px');
      p.style.setProperty('--rot', (Math.random() * 900 - 450) + 'deg');
      p.style.setProperty('--delay', (Math.random() * 120) + 'ms');
      p.style.setProperty('--dur', (650 + Math.random() * 450) + 'ms');
      layer.appendChild(p);
    }
    setTimeout(() => { if (runId === effectRunId && els && els.effects) els.effects.textContent = ''; }, 1300);
  }

  /* ------------------------------- UI ------------------------------- */

  let root = null, shadow = null, els = null, titleObserver = null;
  let renderQueued = false;
  const inputs = { side: 'long', marginUsd: 10, leverage: 5 };

  const CSS = `
    :host { all: initial; }
    .card { position: fixed; z-index: 2147483000; top: 84px; right: 16px; width: 268px;
      background: #0d1117; color: #e6edf3; border: 1px solid #2d333b; border-radius: 10px;
      font: 12px/1.45 -apple-system, "Segoe UI", sans-serif; box-shadow: 0 6px 24px rgba(0,0,0,.45); }
    .hdr { display: flex; align-items: center; gap: 6px; padding: 8px 10px; cursor: grab;
      border-bottom: 1px solid #2d333b; user-select: none; }
    .hdr b { font-size: 11px; letter-spacing: .08em; color: #f0b429; }
    .hdr .mkt { margin-left: auto; font-weight: 600; }
    .hdr .px { color: #9da7b1; font-variant-numeric: tabular-nums; }
    .hdr .tgl { cursor: pointer; padding: 0 2px; color: #9da7b1; }
    .body { padding: 10px; }
    .row { display: flex; gap: 6px; margin-bottom: 8px; }
    .seg { flex: 1; text-align: center; padding: 6px 0; border: 1px solid #2d333b; border-radius: 6px;
      cursor: pointer; color: #9da7b1; }
    .seg.on-long { background: #12261c; border-color: #1f6f4a; color: #3fb970; }
    .seg.on-short { background: #2b1517; border-color: #8a3033; color: #e5484d; }
    .lbl { color: #768390; font-size: 10px; text-transform: uppercase; letter-spacing: .06em; }
    input[type=number] { width: 100%; background: #010409; color: #e6edf3; border: 1px solid #2d333b;
      border-radius: 6px; padding: 6px 8px; font: inherit; box-sizing: border-box; }
    input[type=range] { width: 100%; accent-color: #f0b429; }
    .lev { display: flex; justify-content: space-between; color: #9da7b1; }
    .lev b { color: #e6edf3; }
    .prev { border: 1px solid #2d333b; border-radius: 6px; padding: 8px; margin: 8px 0;
      display: grid; grid-template-columns: 1fr auto; row-gap: 4px; font-variant-numeric: tabular-nums; }
    .prev .k { color: #768390; }
    .prev .v { text-align: right; }
    .prev .liq { color: #e5484d; }
    .ta { border: 1px solid #2d333b; border-radius: 6px; padding: 5px 8px; margin-bottom: 8px;
      color: #9da7b1; font-size: 11px; }
    .ta .setup { color: #e6edf3; margin-top: 3px; }
    .ta .setup .d { color: #768390; }
    .warn { color: #f0b429; margin: 6px 0; }
    .refuse { color: #9da7b1; font-style: italic; margin: 6px 0; }
    button.open { width: 100%; padding: 8px 0; border: 0; border-radius: 6px; font: inherit;
      font-weight: 700; cursor: pointer; background: #238636; color: #fff; }
    button.open.short { background: #b62324; }
    button.open:disabled { background: #21262d; color: #768390; cursor: not-allowed; }
    .pos { border-top: 1px solid #2d333b; margin-top: 10px; padding-top: 8px; }
    .prow { border: 1px solid #2d333b; border-radius: 6px; padding: 6px 8px; margin-bottom: 6px;
      font-variant-numeric: tabular-nums; }
    .prow .l1 { display: flex; justify-content: space-between; }
    .prow .pnl-up { color: #3fb970; } .prow .pnl-dn { color: #e5484d; }
    .prow .l2 { display: flex; justify-content: space-between; color: #768390; font-size: 11px; }
    .prow .acts { display: flex; gap: 6px; margin-top: 5px; }
    .prow .acts button { flex: 1; background: #21262d; border: 1px solid #2d333b; color: #e6edf3;
      border-radius: 5px; padding: 3px 0; font: inherit; font-size: 11px; cursor: pointer; }
    .bal { display: flex; justify-content: space-between; color: #768390; margin-top: 8px; }
    .notice { color: #e5484d; font-weight: 600; margin-top: 6px; }
    .foot { color: #4d5761; font-size: 10px; margin-top: 8px; }
    .collapsed .body { display: none; }

    /* Fill feedback — the same language as the spot overlay (content.js
       "celebration effects"), restated here because a shadow root does not
       inherit the page-level stylesheet. Same timings, same palette, so a
       paper perp entry feels like a paper spot entry. */
    .pt-effects { position: fixed; inset: 0; z-index: 2147483646; pointer-events: none; overflow: hidden; }
    .pt-fx-flash { position: absolute; inset: 0; animation: pt-fx-flash 0.48s ease-out forwards; }
    .pt-fx-flash.long { background: radial-gradient(circle at 50% 45%, rgba(52, 211, 153, 0.24), rgba(255, 157, 69, 0.09) 35%, transparent 72%); }
    .pt-fx-flash.short { background: radial-gradient(circle at 50% 45%, rgba(255, 95, 86, 0.22), rgba(255, 157, 69, 0.07) 35%, transparent 72%); }
    .pt-fx-particle {
      position: absolute; width: 8px; height: 12px; border-radius: 2px;
      opacity: 0; animation: pt-fx-particle var(--dur) cubic-bezier(0.18, 0.72, 0.35, 1) var(--delay) forwards;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.28);
    }
    @keyframes pt-fx-flash { 0% { opacity: 0; } 18% { opacity: 1; } 100% { opacity: 0; } }
    @keyframes pt-fx-particle {
      0% { opacity: 0; transform: translate(0, -20px) rotate(0deg) scale(0.7); }
      12% { opacity: 1; }
      100% { opacity: 0; transform: translate(var(--dx), var(--dy)) rotate(var(--rot)) scale(1); }
    }
  `;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function mountTicket() {
    if (root || !adapter) return;
    root = document.createElement('div');
    root.id = 'pt-perps-root';
    shadow = root.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);

    const card = el('div', 'card');
    const hdr = el('div', 'hdr');
    hdr.append(el('b', '', 'PAPER PERPS'), el('span', 'mkt', adapter.market), el('span', 'px', '…'));
    const tgl = el('span', 'tgl', '—');
    hdr.appendChild(tgl);
    const body = el('div', 'body');

    const ta = el('div', 'ta');
    ta.style.display = 'none';

    const sideRow = el('div', 'row');
    const longBtn = el('div', 'seg on-long', 'LONG');
    const shortBtn = el('div', 'seg', 'SHORT');
    sideRow.append(longBtn, shortBtn);

    const marginLbl = el('div', 'lbl', 'Margin (paper USD)');
    const margin = el('input');
    margin.type = 'number'; margin.min = '1'; margin.step = '1'; margin.value = String(inputs.marginUsd);

    const levLbl = el('div', 'lev');
    levLbl.append(el('span', 'lbl', 'Leverage'), el('b', '', inputs.leverage + 'x'));
    const lev = el('input');
    lev.type = 'range'; lev.min = '1'; lev.max = '20'; lev.step = '1'; lev.value = String(inputs.leverage);

    const preview = el('div');
    const openBtn = el('button', 'open', 'OPEN LONG');
    const positions = el('div', 'pos');
    const bal = el('div', 'bal');
    const notice = el('div', 'notice', '');
    const foot = el('div', 'foot', 'Paper trading — zero real money. Liquidations fill at the venue’s trigger; real ones usually fare worse.');

    body.append(ta, sideRow, marginLbl, margin, levLbl, lev, preview, openBtn, positions, bal, notice, foot);
    card.append(hdr, body);
    const effects = el('div', 'pt-effects');
    shadow.append(card, effects);
    document.documentElement.appendChild(root);

    els = { card, hdr, px: hdr.children[2], tgl, longBtn, shortBtn, margin, lev, levVal: levLbl.children[1], ta, preview, openBtn, positions, bal, notice, effects };

    longBtn.addEventListener('click', () => { inputs.side = 'long'; scheduleRender(); });
    shortBtn.addEventListener('click', () => { inputs.side = 'short'; scheduleRender(); });
    margin.addEventListener('input', () => { inputs.marginUsd = Number(margin.value); scheduleRender(); });
    lev.addEventListener('input', () => { inputs.leverage = Number(lev.value); scheduleRender(); });
    openBtn.addEventListener('click', onOpen);
    tgl.addEventListener('click', () => {
      els.card.classList.toggle('collapsed');
      chrome.storage.local.set({ [UI_KEY]: uiPrefs() });
    });
    initDrag(hdr, card);
    chrome.storage.local.get([UI_KEY], (o) => {
      const u = o && o[UI_KEY];
      if (!u || !els) return;
      if (u.collapsed) els.card.classList.add('collapsed');
      if (Number.isFinite(u.left) && Number.isFinite(u.top)) place(card, u.left, u.top);
    });
  }

  function uiPrefs() {
    const r = els.card.getBoundingClientRect();
    return { collapsed: els.card.classList.contains('collapsed'), left: r.left, top: r.top };
  }

  function place(card, left, top) {
    const w = card.offsetWidth || 268, h = card.offsetHeight || 100;
    const cl = Math.min(Math.max(0, left), Math.max(0, window.innerWidth - w));
    const ct = Math.min(Math.max(0, top), Math.max(0, window.innerHeight - h));
    card.style.left = cl + 'px'; card.style.top = ct + 'px'; card.style.right = 'auto';
  }

  function initDrag(handle, card) {
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    handle.addEventListener('pointerdown', (e) => {
      if (e.target === els.tgl) return;
      dragging = true; sx = e.clientX; sy = e.clientY;
      const r = card.getBoundingClientRect(); ox = r.left; oy = r.top;
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      place(card, ox + e.clientX - sx, oy + e.clientY - sy);
    });
    handle.addEventListener('pointerup', () => {
      if (!dragging) return;
      dragging = false;
      chrome.storage.local.set({ [UI_KEY]: uiPrefs() });
    });
  }

  function flashNotice(text) {
    if (!els) return;
    els.notice.textContent = text;
    setTimeout(() => { if (els && els.notice.textContent === text) els.notice.textContent = ''; }, 12000);
  }

  function carryFor() {
    if (!adapter) return {};
    if (adapter.venue === 'hyperliquid') {
      const a = hlAssets && hlAssets[adapter.market];
      return { fundingHourlyFrac: a ? a.fundingHourlyFrac : NaN };
    }
    return { borrowRateFrac: jupBorrowFrac === null ? NaN : jupBorrowFrac };
  }

  function paramsFor() {
    if (adapter.venue === 'hyperliquid') {
      const a = hlAssets && hlAssets[adapter.market];
      return a ? { maxLeverage: a.maxLeverage } : {};
    }
    const mkt = V.VENUES.jupiter.markets[adapter.market];
    return { impactScalarAdjUsd: mkt ? mkt.impactScalarAdjUsd : null };
  }

  function scheduleRender() {
    if (renderQueued || !els) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }

  function render() {
    if (!els || !state || !adapter) return;
    els.px.textContent = lastPx > 0 ? T.fmtPx(lastPx) : '…';
    els.longBtn.className = 'seg' + (inputs.side === 'long' ? ' on-long' : '');
    els.shortBtn.className = 'seg' + (inputs.side === 'short' ? ' on-short' : '');
    els.levVal.textContent = inputs.leverage + 'x';
    els.openBtn.textContent = 'OPEN ' + inputs.side.toUpperCase();
    els.openBtn.classList.toggle('short', inputs.side === 'short');

    if (adapter.venue === 'hyperliquid') {
      const a = hlAssets && hlAssets[adapter.market];
      const max = a ? a.maxLeverage : 20;
      if (els.lev.max !== String(max)) { els.lev.max = String(max); if (inputs.leverage > max) { inputs.leverage = max; els.lev.value = String(max); } }
    } else if (els.lev.max !== '250') {
      els.lev.max = '250';
    }

    // The TA strip: regime + setups when we have real bars, warm-up truth
    // when we do not, nothing at all on venues without a candle source.
    const strip = adapter.venue === 'hyperliquid' ? T.buildTaStrip(taReads) : null;
    if (strip) {
      const box = el('div');
      box.appendChild(el('div', '', strip.regimeText));
      for (const su of strip.setups) {
        const line = el('div', 'setup', su.text + ' ');
        line.appendChild(el('span', 'd', su.detail));
        box.appendChild(line);
      }
      els.ta.replaceChildren(box);
      els.ta.style.display = '';
    } else {
      els.ta.style.display = 'none';
    }

    const atr = adapter.venue === 'hyperliquid' && taReads ? taReads.atr : null;
    if (venueUnreachable && !(hlAssets && hlAssets[adapter.market])) {
      els.ta.style.display = 'none';
      els.preview.replaceChildren(el('div', 'refuse',
        'Hyperliquid’s public API is not answering from this network, so the '
        + 'leverage tiers and funding rate this ticket needs are unavailable. '
        + 'Paper perps stay closed rather than guess them. Retrying.'));
      els.openBtn.disabled = true;
      els.positions.style.display = 'none';
      els.bal.replaceChildren(el('span', '', 'Paper balance'), el('span', '', T.fmtUsd(state.cashUsd)));
      return;
    }

    const marketConfirmed = adapter.venue !== 'hyperliquid'
      ? true : Boolean(hlAssets && hlAssets[adapter.market]);
    const pv = T.buildPreview({
      venue: adapter.venue, market: adapter.market, side: inputs.side,
      marginUsd: inputs.marginUsd, leverage: inputs.leverage,
      price: lastPx > 0 ? lastPx : NaN, t: Math.floor(Date.now() / 1000),
      cashUsd: state.cashUsd, params: paramsFor(), carry: carryFor(),
      marketConfirmed, atr,
    });

    const prev = el('div', 'prev');
    if (pv.ok) {
      const add = (k, v, cls) => { prev.append(el('span', 'k', k), el('span', 'v' + (cls ? ' ' + cls : ''), v)); };
      add('Size', pv.rows.notionalText);
      add(pv.rows.feeLabel, pv.rows.feeText);
      add('Liq. price', pv.rows.liqText + ' (' + pv.rows.liqDistText + ')', 'liq');
      add(pv.rows.carryLabel, pv.rows.carryText);
      els.openBtn.disabled = false;
    } else {
      prev.append(el('div', 'refuse', pv.text));
      els.openBtn.disabled = true;
    }
    const warnBox = el('div');
    for (const w of (pv.ok ? pv.warnings : [])) warnBox.appendChild(el('div', 'warn', '⚠ ' + w));
    els.preview.replaceChildren(prev, warnBox);

    const rows = T.buildPositionRows(state, { venue: adapter.venue, market: adapter.market, px: lastPx > 0 ? lastPx : NaN, atr });
    const box = el('div');
    for (const r of rows) {
      const pr = el('div', 'prow');
      const l1 = el('div', 'l1');
      l1.append(el('span', '', r.label + ' · ' + r.marginText),
        el('span', r.uPnlUsd >= 0 ? 'pnl-up' : 'pnl-dn', r.uPnlText));
      const l2 = el('div', 'l2');
      l2.append(el('span', '', 'liq ' + r.liqText), el('span', '', 'eq ' + r.equityText));
      pr.append(l1, l2);
      if (r.gapNote) pr.appendChild(el('div', 'warn', r.gapNote));
      const acts = el('div', 'acts');
      const half = el('button', '', 'CLOSE 50%');
      const full = el('button', '', 'CLOSE');
      half.addEventListener('click', () => onClose(r.id, 0.5));
      full.addEventListener('click', () => onClose(r.id, 1));
      acts.append(half, full);
      pr.appendChild(acts);
      box.appendChild(pr);
    }
    els.positions.replaceChildren(box);
    els.positions.style.display = rows.length ? '' : 'none';

    const balBox = el('div');
    els.bal.replaceChildren(el('span', '', 'Paper balance'), el('span', '', T.fmtUsd(state.cashUsd)));
    void balBox;
  }

  function onOpen() {
    if (!adapter || !(lastPx > 0)) return;
    const args = {
      venue: adapter.venue, market: adapter.market, side: inputs.side,
      marginUsd: inputs.marginUsd, leverage: inputs.leverage,
      price: lastPx, t: Math.floor(Date.now() / 1000), params: paramsFor(),
    };
    const carry = carryFor();
    const gate = T.buildPreview(Object.assign({ cashUsd: state.cashUsd, carry, marketConfirmed: true }, args));
    if (!gate.ok) { flashNotice(gate.text); return; }
    applyOp((st) => P.openPerp(st, args)).then((r) => {
      if (r && !r.ok) { flashNotice(T.REASON_TEXT[r.reason] || r.reason); return; }
      // Confirmation belongs to the FILL, never to the click: this only runs
      // once the write actually won, so an effect can never imply a position
      // that storage refused.
      runPerpEffect(inputs.side);
      playPerpSound(inputs.side);
    });
  }

  function onClose(id, fraction) {
    if (!(lastPx > 0)) return;
    applyOp((st) => P.closePerp(st, id, { price: lastPx, t: Math.floor(Date.now() / 1000), fraction }))
      .then((r) => {
        if (r && !r.ok) { flashNotice(T.REASON_TEXT[r.reason] || r.reason); return; }
        if (!r || !r.ok) return;
        const net = r.pnlUsd - r.feeUsd;
        runPerpEffect(net >= 0 ? 'long' : 'short');
        playPerpSound('close');
        if (r.fullyClosed) flashNotice('Closed: ' + T.fmtUsd(net, { signed: true }) + ' net of fees.');
      });
  }

  /* --------------------------- title feed --------------------------- */

  function onTitle() {
    if (!adapter) return;
    const t = document.title;
    const tick = adapter.venue === 'hyperliquid'
      ? S.parseHlTitle(t, adapter.market) : S.parseJupTitle(t, adapter.market);
    if (tick && acceptTick(tick.px)) {
      watchLiquidations();
      scheduleRender();
    }
  }

  function watchTitle() {
    const node = document.querySelector('title');
    if (!node) return;
    if (titleObserver) titleObserver.disconnect();
    titleObserver = new MutationObserver(() => { if (alive()) onTitle(); });
    titleObserver.observe(node, { childList: true, characterData: true, subtree: true });
    onTitle();
  }

  /* ------------------------------ boot ------------------------------ */

  async function enterPage() {
    const found = S.detect(location.hostname, location.pathname);
    if (!found) { leavePage(); return; }
    if (adapter && found.venue === adapter.venue && found.market === adapter.market) return;
    leavePage();
    adapter = found;
    lastPx = 0;
    await loadStore();
    await refreshParams();
    // Hyperliquid: mount only once the market is confirmed a real perp.
    if (adapter.venue === 'hyperliquid' && !(hlAssets && hlAssets[adapter.market])) {
      if (!hlAssets) {
        // The venue's public API has not answered yet. This is RETRYABLE and
        // must actually be retried: an earlier version returned here while
        // the location poll had ALREADY consumed this href, so the page was
        // never looked at again and the ticket never appeared at all. A slow
        // or blocked API turned into permanent silence, which is worse than
        // a slow start. Clearing the adapter lets the retry re-enter.
        adapter = null;
        venueParamsPending = true;
        return;
      }
      // Answered, and this market is not in the live perp universe.
      adapter = null;
      venueParamsPending = false;
      return;
    }
    venueParamsPending = false;
    mountTicket();
    watchTitle();
    if (adapter.venue === 'hyperliquid') {
      barStore = BARS.createStore({ cap: 250 });
      refreshBars();
    }
    await reconcileOnBoot();
    scheduleRender();
  }

  function leavePage() {
    if (root) { root.remove(); root = null; shadow = null; els = null; }
    if (titleObserver) { titleObserver.disconnect(); titleObserver = null; }
    adapter = null;
    barStore = null;
    taReads = null;
    venueUnreachable = false;
    entryAttempts = 0;
  }

  let lastHref = '';
  let lastEntryAt = 0;

  /* The location poll owns two jobs: noticing navigation, and retrying an
   * entry that could not complete because the venue had not answered yet.
   * The retry is rate-limited so a blocked venue costs one request every few
   * seconds rather than one per tick, and it stops the moment entry
   * succeeds or the market is positively ruled out. */
  function pollLocation() {
    const now = Date.now();
    if (location.href !== lastHref) {
      lastHref = location.href;
      lastEntryAt = now;
      enterPage();
      return;
    }
    if (venueParamsPending && now - lastEntryAt >= ENTRY_RETRY_MS) {
      lastEntryAt = now;
      entryAttempts += 1;
      enterPage();
      // Nothing may die quietly. Once the venue has had a fair chance to
      // answer and has not, the page says so instead of staying blank —
      // the user cannot tell "no perps here" from "we are broken" otherwise.
      if (entryAttempts >= ENTRY_ATTEMPTS_BEFORE_NOTICE && !root) {
        const found = S.detect(location.hostname, location.pathname);
        if (found && found.venue === 'hyperliquid') {
          adapter = found;
          mountTicket();
          venueUnreachable = true;
          scheduleRender();
        }
      }
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (!alive()) return;
    if (area === 'local' && changes[STORE_KEY]) {
      const rec = changes[STORE_KEY].newValue;
      // Our own write echoes back here; ingesting it re-renders for nothing.
      if (rec && Number.isInteger(rec.rev) && rec.rev === stateRev) return;
      if (usableBook(rec && rec.state)) { state = rec.state; stateRev = rec.rev || 0; scheduleRender(); }
    }
    // One Settings toggle governs both surfaces; pick up changes live.
    if (area === 'local' && changes.pt_settings) loadUiSettings();
  });

  loadUiSettings();
  managedInterval(pollLocation, LOCATION_POLL_MS);
  managedInterval(refreshParams, PARAMS_REFRESH_MS);
  managedInterval(refreshBars, BARS_REFRESH_MS);
  managedInterval(carryTick, CARRY_TICK_MS);
  // Coming back to a hidden tab settles the carry for the time away before
  // anything is rendered — the row must never show a position cheaper than
  // the venue has been charging it.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && alive()) carryTick();
  });
  pollLocation();
})();
