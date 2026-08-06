/* PaperTrench — perps chart drawing (ISOLATED world producer).
 *
 * The perps analogue of content.js's drawFillOnChart / syncAveragePriceLines:
 * it turns the perps book into the two messages the MAIN-world bridge already
 * knows how to draw, and does nothing else. All of the hard chart work —
 * finding the widget, patching getMarks, the execution-shape fallback, the
 * DOM bubble layer for line-tool charts, frozen levels, the F-31 time clamp,
 * off-visible-range reporting — lives in price-bridge.js and is shared
 * unchanged. This module only speaks.
 *
 * Units: a perps fill is quoted in ABSOLUTE USD. It has no SOL price, no
 * mint and no market cap, so every message declares `quote: 'usd-abs'` /
 * `axisBasis: 'usd-abs'` and the bridge skips the memecoin unit-guessing
 * entirely. That machinery exists because token price and market cap sit
 * ~14 orders of magnitude apart; a perp axis is USD and only USD, and
 * borrowing the guesswork would import exactly the class of wrong-level
 * defect it was written to kill.
 *
 * What gets drawn:
 *   - one bubble per fill (open / close / liquidation), at its USD price;
 *   - an ENTRY line at the open position's entry price;
 *   - a LIQUIDATION line — the number that actually decides the trade.
 */
(() => {
  'use strict';

  const OUT_TAG = 'papertrench-content';
  const LINE_REPOST_MS = 2000;

  const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

  function post(type, payload) {
    try {
      window.postMessage({ source: OUT_TAG, type, payload: payload || null }, '*');
    } catch (e) { /* the page is gone; nothing to draw on */ }
  }

  const drawn = new Set();   // journal entry ids already sent — one fill, one bubble
  let lastLineAt = 0;
  let lastLineKey = '';
  let announcedSymbol = '';

  /* The bridge gates drawing to the chart whose symbol matches; a bare
   * symbol needle is enough (no mint exists for a perp). */
  function announce(market) {
    if (!market || market === announcedSymbol) return;
    announcedSymbol = market;
    post('paper-axis', { symbol: market });
  }

  /* One journal entry -> one bubble. Perps journal times are SECONDS; the
   * marker contract is milliseconds. */
  function markerFor(entry, market) {
    const kind = entry.type === 'liquidation' ? 'liquidation'
      : (entry.type === 'close' ? 'close' : (entry.side === 'short' ? 'short' : 'long'));
    return {
      quote: 'usd-abs',
      ts: entry.t * 1000,
      fillId: 'perp-' + entry.venue + '-' + entry.id + '-' + entry.type + '-' + entry.t,
      side: entry.side === 'short' ? 'short' : 'long',
      kind,
      priceUsd: entry.price,
      notionalUsd: isNum(entry.notionalUsd) ? entry.notionalUsd : null,
      leverage: isNum(entry.leverage) ? entry.leverage : null,
      symbol: market,
    };
  }

  /* o: { state, venue, market, px } */
  function syncChart(o) {
    if (!o || !o.state || !o.venue || !o.market) return;
    announce(o.market);

    // Bubbles: replay the whole journal for this market, deduped by id, so a
    // reload or a render handoff redraws exactly what happened and no more.
    const journal = Array.isArray(o.state.journal) ? o.state.journal : [];
    for (const entry of journal) {
      if (!entry || entry.venue !== o.venue || entry.market !== o.market) continue;
      if (!isNum(entry.price) || entry.price <= 0 || !isNum(entry.t)) continue;
      const marker = markerFor(entry, o.market);
      if (drawn.has(marker.fillId)) continue;
      drawn.add(marker.fillId);
      post('paper-marker', marker);
    }

    // Lines: the open position's entry, and its liquidation price.
    let entryPx = null;
    let liqPx = null;
    for (const id of Object.keys(o.state.positions || {})) {
      const pos = o.state.positions[id];
      if (!pos || pos.venue !== o.venue || pos.market !== o.market) continue;
      if (isNum(pos.entryPx) && pos.entryPx > 0) entryPx = pos.entryPx;
      // perpMark is the one arithmetic for a liquidation price; the stored
      // copy is only as fresh as the last committed write.
      const P = window.PaperPerps;
      const m = P && isNum(o.px) && o.px > 0 ? P.perpMark(pos, o.px) : null;
      const live = m && m.ok && isNum(m.liqPx) ? m.liqPx : pos.liqPx;
      if (isNum(live) && live > 0) liqPx = live;
      break; // one position per market on this surface
    }

    const key = String(entryPx) + '|' + String(liqPx);
    const now = Date.now();
    if (key === lastLineKey && now - lastLineAt < LINE_REPOST_MS) return;
    lastLineKey = key;
    lastLineAt = now;

    if (entryPx === null && liqPx === null) {
      post('paper-lines-clear', null);
      return;
    }
    post('paper-lines', {
      enabled: true,
      axisBasis: 'usd-abs',
      currentPriceUsd: isNum(o.px) ? o.px : null,
      avgBuyUsd: entryPx,
      avgSellUsd: liqPx,
      buyLabel: 'PAPER Entry',
      sellLabel: 'PAPER Liquidation',
      buyColor: '#90A8FA99',
      sellColor: '#E7433699',
    });
  }

  function clearChart() {
    drawn.clear();
    lastLineKey = '';
    announcedSymbol = '';
    post('paper-marker-clear', null);
    post('paper-lines-clear', null);
  }

  const api = { syncChart, clearChart, markerFor };
  if (typeof window !== 'undefined') window.PaperPerpsChart = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
