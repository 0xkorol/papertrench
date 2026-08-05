/* PaperTrench — honest chart marker rail (the non-native fallback).
 *
 * On sites with a reachable TradingView widget, fills and average lines are
 * drawn NATIVELY through the MAIN-world bridge (see price-bridge.js) — that
 * is the only way a marker stays glued to its candle through pan, zoom and
 * auto-scale. This module is the fallback for pages where no native chart
 * API was discovered (DEFECT C-19 routes everything else away from here).
 *
 * WHAT THIS DELIBERATELY DOES NOT DO (DEFECTS C-02 / C-03 / C-04): the old
 * SVG overlay invented its own price range from observed ticks, glued
 * out-of-range levels to the chart edge, put single fills at mid-height, and
 * spread X positions by rank-in-array instead of time — while drawing precise
 * labels, with no pan/zoom awareness at all. Every position was a fabrication
 * wearing the costume of accuracy. A marker at a wrong level is a lie; honest
 * absence beats fabricated presence.
 *
 * The replacement is a compact MARKER RAIL pinned to the chart's top-right
 * corner (or, when no chart container exists, a strip docked to a free screen
 * corner): each fill is listed with side, price/mcap label and age, and the
 * average entry/exit LEVELS appear as labeled chips. The rail explicitly
 * claims NO Y position — the numbers are exact, the geometry claims nothing.
 *
 * Sizing note (DEFECTS C-27 / C-28): the old SVG label pill and tooltip
 * estimated width as character-count x 6.2, overflowing onto the site's
 * price scale. The rail is plain HTML sized by the layout engine itself
 * (width: max-content) — no width estimate exists to be wrong.
 */
(() => {
  'use strict';

  const Q = window.PaperQuote;
  const OVERLAY_ID = 'papertrench-chart-overlay';
  const FALLBACK_ID = 'papertrench-chart-fallback';
  const MAX_MARKERS = 200;   // stored
  const RAIL_MAX_ROWS = 6;   // shown on the rail
  const FALLBACK_MAX_ROWS = 6;

  const BUY_COLOR = '#3fb950';
  const SELL_COLOR = '#f85149';

  let chartContainer = null;
  let railEl = null;
  let domObserver = null;
  let markers = []; // {ts, price, side, solAmount, symbol, displayPrice, currency}
  let averageLines = {
    avgBuyPrice: null, avgSellPrice: null,
    avgBuyLabel: null, avgSellLabel: null,
    currency: 'SOL',
  };
  let scanTimer = null;
  let fallbackEl = null;
  // Debounce render: multiple calls in the same frame collapse into one.
  let renderPending = false;
  // DEFECT C-10: the render-skip memo compares the rendered VALUES (average
  // levels, labels, fill rows), never just counts — a cross-tab fill that
  // changes the average without changing the marker count must repaint.
  let lastRenderedSignature = null;
  let renderCount = 0; // test hook

  /* ---------------- chart container discovery ---------------- */

  /**
   * Comprehensive list of selectors to find the chart container.
   * Ordered from most specific to most generic.
   */
  const CHART_SELECTORS = [
    // Padre-specific
    '[class*="TradingViewChart"]',
    '[class*="trading-view"]',
    '[class*="tradingview"]',
    '[class*="chart-wrapper"]',
    '[class*="chartWrapper"]',
    '[class*="chart-container"]',
    '[class*="chartContainer"]',
    // GMGN-specific — GMGN mounts its TradingView iframe here.
    '#global-tv-overlay',
    '#chart_anchor_container_main',
    '[class*="kline"]',
    '[class*="k-line"]',
    '[class*="KlineChart"]',
    '[class*="price-chart"]',
    '[class*="token-chart"]',
    '[class*="trading_chart"]',
    // BullX / Dexscreener / Birdeye
    '[class*="ChartContainer"]',
    '[class*="chart-area"]',
    '[class*="chartArea"]',
    // Generic chart containers
    '[class*="chart"]',
    '[data-chart]',
    '[id*="chart"]',
    '[id*="tv"]',
    '[class*="tv_chart"]',
    // Canvas-based charts (TradingView, lightweight-charts, etc.)
    'canvas',
    // Generic containers that might wrap a chart
    '[class*="graph"]',
    '[class*="candlestick"]',
    '[class*="candle"]',
  ];

  /**
   * Score a candidate element by how likely it is to be the chart container.
   * Higher score = better candidate. We prefer large, visible elements
   * that contain a canvas or have chart-related class names.
   */
  function scoreChartCandidate(el) {
    if (!el || el.nodeType !== 1) return -1;
    const rect = el.getBoundingClientRect();
    if (rect.width < 200 || rect.height < 150) return -1;

    let score = 0;
    const cls = (el.className || '').toLowerCase();
    const id = (el.id || '').toLowerCase();

    // Size bonus — bigger is more likely to be the chart
    score += Math.min(rect.width / 100, 10);
    score += Math.min(rect.height / 100, 5);

    // Class/id name bonuses. GMGN's TradingView iframe is deliberately
    // hosted at #global-tv-overlay; it must beat broad page shell matches.
    if (id === 'global-tv-overlay') score += 100;
    if (id === 'chart_anchor_container_main') score += 90;
    if (/chart/.test(cls)) score += 20;
    if (/chart/.test(id)) score += 15;
    if (/tradingview|tv[_-]/.test(cls)) score += 15;
    if (/candle|graph|price/.test(cls)) score += 10;

    // Contains a canvas? Strong signal.
    if (el.querySelector && el.querySelector('canvas')) score += 30;

    // Must be visible
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return -1;
    if (parseFloat(style.opacity) < 0.1) return -1;

    return score;
  }

  function findChartContainer() {
    let best = null;
    let bestScore = -1;

    for (const sel of CHART_SELECTORS) {
      let els;
      try { els = document.querySelectorAll(sel); } catch (e) { continue; }
      for (const el of els) {
        // For canvas elements, consider the canvas itself and its parent
        const candidates = [el];
        if (el.tagName === 'CANVAS' && el.parentElement) candidates.push(el.parentElement);

        for (const cand of candidates) {
          const score = scoreChartCandidate(cand);
          if (score > bestScore) {
            bestScore = score;
            best = cand;
          }
        }
      }
    }

    return best;
  }

  /** Attachment check that works on real nodes and harness fakes alike. */
  function isAttached(el) {
    if (!el) return false;
    if (typeof el.isConnected === 'boolean') return el.isConnected;
    try {
      return Boolean(document.contains && document.contains(el));
    } catch (_) {
      return false;
    }
  }

  /** parent.contains(el) with a fallback for harness fakes. */
  function holdsChild(parent, el) {
    if (!parent || !el) return false;
    if (typeof parent.contains === 'function') {
      try { return parent.contains(el); } catch (_) { /* fall through */ }
    }
    const kids = parent.children || [];
    for (let i = 0; i < kids.length; i++) if (kids[i] === el) return true;
    return false;
  }

  function ensureContainer() {
    // DEFECT C-11: a truthy-but-DETACHED container (TradingView reload, SPA
    // re-render, resolution remount) must be dropped and re-discovered. The
    // old guard only checked falsiness, so every render after a remount
    // wrote into a dead subtree forever. Checked on EVERY render.
    if (chartContainer && !isAttached(chartContainer)) {
      chartContainer = null;
      removeOverlay();
    }
    if (chartContainer) return chartContainer;

    const found = findChartContainer();
    if (found) {
      chartContainer = found;
      setupOverlay();
      return chartContainer;
    }
    return null;
  }

  /* ---------------- rail placement on the chart ---------------- */

  function setupOverlay() {
    if (!chartContainer) return;
    removeOverlay();

    // The rail is positioned INSIDE the container's top-right corner — an
    // edge pin, not a price position.
    if (getComputedStyle(chartContainer).position === 'static') {
      chartContainer.style.position = 'relative';
    }

    // Observe the container so a site render that removes the rail brings it
    // back. DEFECT C-24: the old observer watched the very subtree the
    // renderer wrote into, so every render scheduled another render, with
    // only the value-blind skip guard breaking the cycle. Mutations that
    // originate INSIDE our own rail are filtered out here.
    if (typeof MutationObserver !== 'undefined') {
      domObserver = new MutationObserver((records) => {
        let external = false;
        for (const record of records || []) {
          const target = record && record.target;
          if (railEl && (target === railEl || holdsChild(railEl, target))) continue;
          external = true;
          break;
        }
        if (!external) return; // our own writes: never re-render off them (C-24)
        requestRender();
      });
      try {
        domObserver.observe(chartContainer, { childList: true, subtree: true });
      } catch (_) { /* container may be a harness fake */ }
    }
  }

  function detachNode(el) {
    try {
      if (el && el.parentNode && typeof el.parentNode.removeChild === 'function') {
        el.parentNode.removeChild(el);
      } else if (el && typeof el.remove === 'function') {
        el.remove();
      }
    } catch (_) { /* already gone */ }
  }

  function removeOverlay() {
    if (railEl) detachNode(railEl);
    railEl = null;
    if (domObserver) { domObserver.disconnect(); domObserver = null; }
  }

  /* ---------------- fallback strip ---------------- */

  /**
   * When no chart container can be found, the rail becomes a fixed strip
   * docked to a screen corner. DEFECTS O-23 / C-25: the old strip hardcoded
   * `top:140px; right:360px` — the default panel spot — so a widened or
   * dragged panel sat on top of it. The dock now probes each corner with
   * elementFromPoint and takes the first one the PaperTrench overlay (which
   * retargets to its #papertrench-host shadow host) does not occupy.
   */
  function pickFreeCorner() {
    const corners = [
      { name: 'bottom-left', css: 'left:12px;bottom:12px;top:auto;right:auto' },
      { name: 'bottom-right', css: 'right:12px;bottom:12px;top:auto;left:auto' },
      { name: 'top-left', css: 'left:12px;top:84px;bottom:auto;right:auto' },
      { name: 'top-right', css: 'right:12px;top:84px;bottom:auto;left:auto' },
    ];
    if (typeof document.elementFromPoint !== 'function') return corners[0];
    const vw = (window.innerWidth || 1280);
    const vh = (window.innerHeight || 800);
    const probes = {
      'bottom-left': [40, vh - 40],
      'bottom-right': [vw - 40, vh - 40],
      'top-left': [40, 120],
      'top-right': [vw - 40, 120],
    };
    for (const corner of corners) {
      const [x, y] = probes[corner.name];
      let hit = null;
      try { hit = document.elementFromPoint(x, y); } catch (_) { hit = null; }
      if (!hit || hit.id !== 'papertrench-host') return corner;
    }
    return corners[0]; // every corner occupied (unlikely): least-bad default
  }

  function ensureFallback() {
    if (fallbackEl && isAttached(fallbackEl)) return fallbackEl;
    if (fallbackEl) fallbackEl = null;
    if (!document.body) return null; // not ready yet

    fallbackEl = document.createElement('div');
    fallbackEl.setAttribute('id', FALLBACK_ID);
    fallbackEl.style.cssText = [
      'position:fixed',
      pickFreeCorner().css,
      'z-index:2147483646',
      'pointer-events:none',
      'display:flex',
      'flex-direction:column',
      'gap:4px',
      'max-height:60vh',
      'overflow:hidden',
    ].join(';');
    document.body.appendChild(fallbackEl);
    return fallbackEl;
  }

  function removeFallback() {
    if (fallbackEl) detachNode(fallbackEl);
    fallbackEl = null;
  }

  /* ---------------- shared row/chip builders ---------------- */

  /**
   * Chart-side value text.
   *
   * `MCAP` is preferred wherever a market cap is available, because that is the
   * figure traders actually read off a memecoin chart. Unit price is the
   * fallback for the rare case no cap is known.
   */
  function formatChartPrice(price, currency) {
    if (currency === 'MCAP') {
      return Q && typeof Q.formatMarketCap === 'function'
        ? Q.formatMarketCap(price)
        : '$' + price;
    }
    const text = Q && typeof Q.formatPrice === 'function' ? Q.formatPrice(price) : String(price);
    return currency === 'USD' ? '$' + text : text + ' SOL';
  }

  const ROW_BASE_CSS = [
    'pointer-events:none',
    'display:flex',
    'align-items:center',
    'gap:6px',
    'width:max-content', // layout-engine sizing — no estimated widths (C-27/C-28)
    'max-width:340px',
    'background:rgba(13,17,23,0.92)',
    'border-radius:8px',
    'padding:3px 8px',
    'font-size:11px',
    'line-height:1.5',
    'font-family:ui-sans-serif,system-ui,sans-serif',
    'color:#e6edf3',
    'white-space:nowrap',
    'box-shadow:0 2px 8px rgba(0,0,0,.4)',
  ].join(';');

  /** One fill row: side badge, fill level label, size, age. */
  function buildFillRow(m) {
    const isBuy = m.side === 'buy';
    const row = document.createElement('div');
    row.className = 'pt-rail-fill';
    row.style.cssText = ROW_BASE_CSS + ';border:1px solid ' + (isBuy ? BUY_COLOR : SELL_COLOR);

    const badge = document.createElement('span');
    badge.textContent = isBuy ? 'B' : 'S';
    badge.style.cssText = 'font-weight:900;color:' + (isBuy ? BUY_COLOR : SELL_COLOR);
    row.appendChild(badge);

    const info = document.createElement('span');
    info.textContent = `${formatChartPrice(m.displayPrice || m.price, m.currency || 'SOL')} · ${Number(m.solAmount || 0).toFixed(2)} SOL`;
    row.appendChild(info);

    const age = document.createElement('span');
    age.style.cssText = 'color:#8b949e;font-size:10px';
    age.textContent = timeAgo(m.ts);
    row.appendChild(age);

    return row;
  }

  /**
   * One average-level chip. This is a labeled LEVEL, not a positioned line:
   * the rail never claims a Y coordinate for it (C-02's honest replacement).
   */
  function buildAverageChip(kind, value, label, currency) {
    const color = kind === 'AVG BUY' ? '#34D399' : '#FF5F56';
    const chip = document.createElement('div');
    chip.className = 'pt-rail-avg';
    chip.style.cssText = ROW_BASE_CSS + ';border:1px solid ' + color + ';font-weight:700';

    const tag = document.createElement('span');
    tag.textContent = kind;
    tag.style.cssText = 'color:' + color;
    chip.appendChild(tag);

    const val = document.createElement('span');
    val.textContent = formatChartPrice(label != null ? label : value, currency);
    chip.appendChild(val);

    return chip;
  }

  /** The rows/chips the rail currently stands behind, oldest fill last. */
  function buildRailContent(rootCss, maxRows) {
    const hasAvg = averageLines.avgBuyPrice != null || averageLines.avgSellPrice != null;
    if (!markers.length && !hasAvg) return null;

    const root = document.createElement('div');
    root.setAttribute('id', OVERLAY_ID);
    root.style.cssText = rootCss;

    if (averageLines.avgBuyPrice != null) {
      root.appendChild(buildAverageChip('AVG BUY', averageLines.avgBuyPrice, averageLines.avgBuyLabel, averageLines.currency));
    }
    if (averageLines.avgSellPrice != null) {
      root.appendChild(buildAverageChip('AVG SELL', averageLines.avgSellPrice, averageLines.avgSellLabel, averageLines.currency));
    }
    // Newest fills first — the ones the trader is still thinking about.
    const visible = markers.slice(-maxRows).reverse();
    for (const m of visible) root.appendChild(buildFillRow(m));
    return root;
  }

  /* ---------------- rendering ---------------- */

  /**
   * DEFECT C-10: the skip guard is a VALUE signature over everything the rail
   * displays — average levels, labels, currency and the visible fill rows —
   * plus a minute bucket so age text refreshes while ticks flow. The old
   * guard compared marker COUNT and range only, so a cross-tab fill that
   * moved the average (same count) kept the stale level on screen.
   */
  function modelSignature() {
    const rows = markers.slice(-RAIL_MAX_ROWS).map(
      (m) => `${m.ts}·${m.side}·${m.displayPrice || m.price}·${m.currency}`
    );
    return JSON.stringify([
      averageLines.avgBuyPrice, averageLines.avgSellPrice,
      averageLines.avgBuyLabel, averageLines.avgSellLabel,
      averageLines.currency,
      markers.length,
      rows,
      Math.floor(Date.now() / 60_000),
    ]);
  }

  function renderMarkers() {
    const container = ensureContainer();
    if (!container) {
      renderFallback();
      return;
    }

    const signature = modelSignature();
    if (signature === lastRenderedSignature && railEl && holdsChild(container, railEl)) {
      return; // nothing the rail displays has changed (C-10: values, not counts)
    }
    renderCount += 1;
    lastRenderedSignature = signature;

    // Rebuild wholesale: a fresh rail replaces the old one, which also
    // self-heals any external mutation of the previous rail's subtree.
    if (railEl) { detachNode(railEl); railEl = null; }
    const rail = buildRailContent([
      'position:absolute',
      'top:8px',
      'right:8px',
      'z-index:999',
      'pointer-events:none',
      'display:flex',
      'flex-direction:column',
      'align-items:flex-end',
      'gap:4px',
      'max-height:70%',
      'overflow:hidden',
    ].join(';'), RAIL_MAX_ROWS);
    if (rail) {
      container.appendChild(rail);
      railEl = rail;
    }

    // Remove fallback if we're rendering on the chart
    if (fallbackEl) removeFallback();
  }

  function renderFallback() {
    const hasAvg = averageLines.avgBuyPrice != null || averageLines.avgSellPrice != null;
    if (!markers.length && !hasAvg) {
      if (fallbackEl) removeFallback();
      return;
    }
    const el = ensureFallback();
    if (!el) return; // document.body not ready
    el.textContent = '';
    const content = buildRailContent('display:flex;flex-direction:column;gap:4px', FALLBACK_MAX_ROWS);
    if (content) el.appendChild(content);
  }

  /* ---------------- utilities ---------------- */

  function timeAgo(ts) {
    const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    return Math.floor(s / 3600) + 'h ago';
  }

  /* ---------------- public API ---------------- */

  /**
   * Request a render on the next animation frame. Multiple calls within the
   * same frame collapse into one render.
   */
  function requestRender() {
    if (renderPending) return;
    renderPending = true;
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        renderPending = false;
        renderMarkers();
      });
    } else {
      // Fallback for environments without rAF
      setTimeout(() => {
        renderPending = false;
        renderMarkers();
      }, 16); // ~60fps
    }
  }

  function addMarker(m) {
    if (!m || !(m.price > 0)) return;
    markers.push({
      ts: m.ts || Date.now(),
      price: m.price,
      side: m.side || 'buy',
      solAmount: m.solAmount || 0,
      symbol: m.symbol || '',
      // `displayPrice` is the human-readable fill figure (market cap where
      // known); `price` is retained for API compatibility and labels.
      displayPrice: Number(m.displayPrice) > 0 ? Number(m.displayPrice) : m.price,
      currency: m.currency === 'USD' || m.currency === 'MCAP' ? m.currency : 'SOL',
    });
    if (markers.length > MAX_MARKERS) markers.shift();
    requestRender();
  }

  /**
   * Live-price notification. DEFECTS C-02/C-03: ticks no longer fabricate a
   * price range — the rail claims no Y positions, so there is nothing
   * price-shaped to update. A tick only nudges the debounced render so the
   * relative-age text stays fresh (the value signature buckets it by minute).
   */
  function tickPrice(price) {
    if (!(price > 0)) return;
    if (markers.length || averageLines.avgBuyPrice != null || averageLines.avgSellPrice != null) {
      requestRender();
    }
  }

  function clearMarkers() {
    markers = [];
    averageLines = { avgBuyPrice: null, avgSellPrice: null, avgBuyLabel: null, avgSellLabel: null, currency: 'SOL' };
    lastRenderedSignature = null;
    if (railEl) { detachNode(railEl); railEl = null; }
    removeFallback();
  }

  function initChartMarkers() {
    // DEFECT C-21: retire any scan interval from a previous init FIRST.
    // The early return below used to skip the clearInterval, so a re-init
    // that found the container immediately leaked the old timer.
    if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }

    // Try to find the chart container immediately
    if (ensureContainer()) {
      requestRender();
      return;
    }

    // Chart not found yet — set up aggressive polling to find it.
    let attempts = 0;
    scanTimer = setInterval(() => {
      attempts++;
      if (ensureContainer()) {
        clearInterval(scanTimer);
        scanTimer = null;
        requestRender();
        return;
      }
      // After 10 attempts (5s), start showing fallback if we have markers
      if (attempts >= 10 && markers.length) {
        renderFallback();
      }
      // Give up after 60 attempts (30s)
      if (attempts > 60) {
        clearInterval(scanTimer);
        scanTimer = null;
        if (markers.length) renderFallback();
      }
    }, 500);
  }

  function destroyChartMarkers() {
    removeOverlay();
    removeFallback();
    if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
    renderPending = false; // cancel any pending debounced render
    chartContainer = null;
    markers = [];
    averageLines = { avgBuyPrice: null, avgSellPrice: null, avgBuyLabel: null, avgSellLabel: null, currency: 'SOL' };
    // DEFECT C-22: the render-skip memo must reset with the state it
    // memoizes, or the first render after a re-init can compare equal
    // against the previous mount's values and silently skip drawing.
    lastRenderedSignature = null;
  }

  /**
   * Set the average buy/sell LEVELS shown on the rail chips.
   * Pass null or omit a value to leave that entry unchanged;
   * pass `undefined` explicitly to clear it.
   */
  function setAverageLines(opts) {
    if (!opts) return;
    if (opts.avgBuyPrice !== undefined) averageLines.avgBuyPrice = opts.avgBuyPrice;
    if (opts.avgSellPrice !== undefined) averageLines.avgSellPrice = opts.avgSellPrice;
    if (opts.avgBuyLabel !== undefined) averageLines.avgBuyLabel = opts.avgBuyLabel;
    if (opts.avgSellLabel !== undefined) averageLines.avgSellLabel = opts.avgSellLabel;
    if (opts.currency !== undefined) {
      averageLines.currency = opts.currency === 'USD' || opts.currency === 'MCAP' ? opts.currency : 'SOL';
    }
    requestRender();
  }

  /** Clear both average entries. */
  function clearAverageLines() {
    averageLines = { avgBuyPrice: null, avgSellPrice: null, avgBuyLabel: null, avgSellLabel: null, currency: 'SOL' };
    requestRender();
  }

  const api = {
    addMarker,
    tickPrice,
    clearMarkers,
    setAverageLines,
    clearAverageLines,
    initChartMarkers,
    destroyChartMarkers,
    // Exposed for testing. Deliberately ABSENT: _priceToY / _timeToX /
    // _updatePriceRange / _getPriceRange — the fabricated positioning they
    // exposed is gone (C-02/C-03/C-04), not merely unused.
    _getMarkers: () => markers,
    _getAverageLines: () => ({ ...averageLines }),
    _findChartContainer: findChartContainer,
    _scoreChartCandidate: scoreChartCandidate,
    _getRenderCount: () => renderCount,
    _getRailElement: () => railEl,
    _getFallbackElement: () => fallbackEl,
  };

  if (typeof window !== 'undefined') window.PTChartMarkers = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
