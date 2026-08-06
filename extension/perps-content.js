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
  if (!S || !V || !P || !T || !RC) return;

  const STORE_KEY = 'pt_perps';
  const UI_KEY = 'pt_perps_ui';
  const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';
  const PARAMS_REFRESH_MS = 30000;
  const LOCATION_POLL_MS = 1000;
  const PERSIST_SEEN_MS = 60000;
  const ACCEPT_RATIO = 20; // same magnitude gate doctrine as quote.js

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

  function loadStore() {
    return new Promise((resolve) => {
      chrome.storage.local.get([STORE_KEY], (o) => {
        const rec = o && o[STORE_KEY];
        state = rec && rec.state ? rec.state : freshState();
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

  async function reconcileOnBoot() {
    if (reconciled) return;
    reconciled = true;
    await loadStore();
    const open = Object.values(state.positions);
    if (!open.length) return;
    const nowMs = Date.now();

    for (const pos of open) {
      if (pos.venue === 'hyperliquid') {
        const fromMs = Number.isInteger(pos.lastSeenMs) ? pos.lastSeenMs : pos.openT * 1000;
        if (nowMs - fromMs < 5 * 60000) continue;
        let candles = null, funding = null;
        try {
          [candles, funding] = await Promise.all([
            fetchHlInfo({ type: 'candleSnapshot', req: { coin: pos.market, interval: '5m', startTime: fromMs - 300000, endTime: nowMs } }),
            fetchHlInfo({ type: 'fundingHistory', coin: pos.market, startTime: fromMs }),
          ]);
        } catch (e) { continue; /* unreachable venue: the gap stays a gap */ }
        const plan = RC.reconcileHl(pos, {
          candles, funding, fromMs: fromMs - 300000, toMs: nowMs, intervalMs: 300000,
        });
        await applyOp((st) => {
          const live = st.positions[pos.id];
          if (!live) return { ok: true };
          if (plan.verdict === 'liquidated') {
            P.applyHlFunding(st, live.id, plan.fundingBefore);
            const r = P.liquidatePerp(st, live.id, { price: plan.crossPx, t: Math.floor(plan.atMs / 1000) });
            if (r.ok) st.rounds[st.rounds.length - 1].provenance = plan.provenance;
            return r;
          }
          if (plan.verdict === 'survived') {
            P.applyHlFunding(st, live.id, plan.fundingApplied);
            P.markPerp(st, live.id, { price: plan.lastPx });
            live.lastSeenMs = nowMs;
            return { ok: true };
          }
          live.unverifiedGapSec = (live.unverifiedGapSec || 0) + Math.round((nowMs - fromMs) / 1000);
          live.lastSeenMs = nowMs;
          return { ok: true };
        });
      } else if (pos.venue === 'jupiter') {
        if (!(adapter && adapter.venue === 'jupiter' && adapter.market === pos.market && lastPx > 0)) continue;
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
    }
  }

  function persistSeen() {
    if (!adapter || !state) return;
    const nowMs = Date.now();
    const touched = Object.values(state.positions).some(
      (p) => p.venue === adapter.venue && p.market === adapter.market
    );
    if (!touched) return;
    applyOp((st) => {
      for (const p of Object.values(st.positions)) {
        if (p.venue === adapter.venue && p.market === adapter.market) p.lastSeenMs = nowMs;
      }
      return { ok: true };
    });
  }

  /* ------------------------ liquidation watch ------------------------ */

  function watchLiquidations() {
    if (!adapter || !state || !(lastPx > 0)) return;
    for (const pos of Object.values(state.positions)) {
      if (pos.venue !== adapter.venue || pos.market !== adapter.market) continue;
      const clone = JSON.parse(JSON.stringify(state));
      const m = P.markPerp(clone, pos.id, { price: lastPx });
      if (m.ok && m.liquidatable) {
        applyOp((st) => {
          if (!st.positions[pos.id]) return { ok: true };
          return P.liquidatePerp(st, pos.id, { price: lastPx, t: Math.floor(Date.now() / 1000) });
        }).then((r) => {
          if (r && r.ok) flashNotice('Liquidated at ' + T.fmtPx(lastPx) + ' — margin lost.');
        });
      }
    }
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

    body.append(sideRow, marginLbl, margin, levLbl, lev, preview, openBtn, positions, bal, notice, foot);
    card.append(hdr, body);
    shadow.appendChild(card);
    document.documentElement.appendChild(root);

    els = { card, hdr, px: hdr.children[2], tgl, longBtn, shortBtn, margin, lev, levVal: levLbl.children[1], preview, openBtn, positions, bal, notice };

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

    const marketConfirmed = adapter.venue !== 'hyperliquid'
      ? true : Boolean(hlAssets && hlAssets[adapter.market]);
    const pv = T.buildPreview({
      venue: adapter.venue, market: adapter.market, side: inputs.side,
      marginUsd: inputs.marginUsd, leverage: inputs.leverage,
      price: lastPx > 0 ? lastPx : NaN, t: Math.floor(Date.now() / 1000),
      cashUsd: state.cashUsd, params: paramsFor(), carry: carryFor(),
      marketConfirmed,
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

    const rows = T.buildPositionRows(state, { venue: adapter.venue, market: adapter.market, px: lastPx > 0 ? lastPx : NaN });
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
      if (r && !r.ok) flashNotice(T.REASON_TEXT[r.reason] || r.reason);
    });
  }

  function onClose(id, fraction) {
    if (!(lastPx > 0)) return;
    applyOp((st) => P.closePerp(st, id, { price: lastPx, t: Math.floor(Date.now() / 1000), fraction }))
      .then((r) => {
        if (r && !r.ok) flashNotice(T.REASON_TEXT[r.reason] || r.reason);
        else if (r && r.ok && r.fullyClosed) flashNotice('Closed: ' + T.fmtUsd(r.pnlUsd - r.feeUsd, { signed: true }) + ' net of fees.');
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
      if (!hlAssets) return;      // API unreachable — try again on next poll
      adapter = null; return;     // confirmed NOT a perp market: stay away
    }
    mountTicket();
    watchTitle();
    await reconcileOnBoot();
    scheduleRender();
  }

  function leavePage() {
    if (root) { root.remove(); root = null; shadow = null; els = null; }
    if (titleObserver) { titleObserver.disconnect(); titleObserver = null; }
    adapter = null;
  }

  let lastHref = '';
  function pollLocation() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    enterPage();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (!alive()) return;
    if (area === 'local' && changes[STORE_KEY]) {
      const rec = changes[STORE_KEY].newValue;
      if (rec && rec.state) { state = rec.state; stateRev = rec.rev || 0; scheduleRender(); }
    }
  });

  managedInterval(pollLocation, LOCATION_POLL_MS);
  managedInterval(refreshParams, PARAMS_REFRESH_MS);
  managedInterval(persistSeen, PERSIST_SEEN_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && alive()) persistSeen();
  });
  pollLocation();
})();
