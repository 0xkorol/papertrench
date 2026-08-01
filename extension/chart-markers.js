/* PaperTrench — chart bubble markers.
 *
 * Replicates the buy/sell bubble markers that Padre (and similar trading
 * sites) draw on their price chart when a real trade is executed. Paper
 * trades get the same visual treatment: a colored bubble appears at the
 * price level of the fill, and hovering shows the price and SOL amount.
 *
 * Two rendering strategies, tried in order:
 *
 *  1. SVG overlay on the chart container — if we can find the chart element,
 *     we position an SVG layer on top of it and draw bubbles at the correct
 *     price/time coordinates.
 *
 *  2. Fixed-position fallback — if the chart container can't be reliably
 *     found (e.g. the site uses a shadow DOM or a complex canvas setup),
 *     we render a small floating strip of bubbles on the right edge of the
 *     screen that always stays visible.
 *
 * The chart container is discovered via multiple strategies:
 *  - CSS selectors for common chart class patterns
 *  - Canvas element search (most charting libs use canvas)
 *  - MutationObserver to catch chart elements that render after a delay
 *  - Periodic re-scan to handle SPA re-renders that replace the chart
 */
(() => {
  'use strict';

  const Q = window.PaperQuote;
  const OVERLAY_ID = 'papertrench-chart-overlay';
  const FALLBACK_ID = 'papertrench-chart-fallback';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const BUBBLE_R = 7;
  const BUBBLE_HIT_R = 16;
  const MAX_MARKERS = 200;

  let svgEl = null;
  let chartContainer = null;
  let resizeObs = null;
  let domObserver = null;
  let markers = []; // {ts, price, side, solAmount, symbol}
  let priceRange = { min: 0, max: 0 };
  let series = [];
  let scanTimer = null;
  let fallbackEl = null;
  // Debounce render: multiple tickPrice calls in the same frame collapse
  // into a single renderMarkers. Without this, every heartbeat + every
  // page tick triggers a full SVG rebuild, which is expensive and can
  // cascade with the DOM observer.
  let renderPending = false;
  // Track whether a render is actually needed. tickPrice only changes the
  // price range (affecting Y positions), so we skip the rebuild if the
  // range hasn't moved meaningfully.
  let lastRenderedRange = { min: 0, max: 0 };
  let lastRenderedCount = -1;

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
    // Generic chart containers
    '[class*="chart"]',
    '[data-chart]',
    '[id*="chart"]',
    '[id*="tv"]',
    '[class*="tv_chart"]',
    '[class*="price-chart"]',
    '[class*="priceChart"]',
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

    // Class/id name bonuses
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

  function ensureContainer() {
    if (chartContainer && typeof document !== 'undefined' && document.contains && document.contains(chartContainer)) return chartContainer;
    // Stale reference — reset
    if (chartContainer && !document.contains(chartContainer)) {
      chartContainer = null;
      removeOverlay();
    }

    const found = findChartContainer();
    if (found) {
      chartContainer = found;
      setupOverlay();
      return chartContainer;
    }
    return null;
  }

  /* ---------------- SVG overlay ---------------- */

  function setupOverlay() {
    if (!chartContainer) return;
    removeOverlay();

    svgEl = document.createElementNS(SVG_NS, 'svg');
    svgEl.setAttribute('id', OVERLAY_ID);
    svgEl.style.cssText = [
      'position:absolute',
      'top:0', 'left:0',
      'width:100%', 'height:100%',
      'pointer-events:none',
      'z-index:999',
      'overflow:visible',
    ].join(';');

    // Position relative to chart container
    if (getComputedStyle(chartContainer).position === 'static') {
      chartContainer.style.position = 'relative';
    }
    chartContainer.appendChild(svgEl);

    // Observe chart size changes
    if (typeof ResizeObserver !== 'undefined') {
      resizeObs = new ResizeObserver(() => requestRender());
      resizeObs.observe(chartContainer);
    }

    // Observe DOM changes to the chart container (SPA re-renders)
    if (typeof MutationObserver !== 'undefined') {
      domObserver = new MutationObserver(() => {
        // If our SVG was removed, re-attach
        if (!chartContainer.contains(svgEl)) {
          chartContainer.appendChild(svgEl);
        }
        requestRender();
      });
      domObserver.observe(chartContainer, { childList: true, subtree: true });
    }
  }

  function removeOverlay() {
    if (svgEl && svgEl.parentNode) svgEl.parentNode.removeChild(svgEl);
    svgEl = null;
    if (resizeObs) { resizeObs.disconnect(); resizeObs = null; }
    if (domObserver) { domObserver.disconnect(); domObserver = null; }
  }

  /* ---------------- fallback strip ---------------- */

  /**
   * If we can't find the chart container, render a small floating strip
   * of bubbles on the right side of the screen so the user still sees
   * their paper trade markers.
   */
  function ensureFallback() {
    if (fallbackEl && typeof document !== 'undefined' && document.contains && document.contains(fallbackEl)) return fallbackEl;
    if (fallbackEl) fallbackEl = null;
    if (!document.body) return null; // not ready yet

    fallbackEl = document.createElement('div');
    fallbackEl.id = FALLBACK_ID;
    fallbackEl.style.cssText = [
      'position:fixed',
      'top:140px',
      'right:360px',
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
    if (fallbackEl && fallbackEl.parentNode) fallbackEl.parentNode.removeChild(fallbackEl);
    fallbackEl = null;
  }

  /* ---------------- price-to-pixel mapping ---------------- */

  function updatePriceRange(currentPrice) {
    if (currentPrice > 0) {
      series.push(currentPrice);
      if (series.length > 300) series.shift();
    }
    if (series.length < 2) {
      if (currentPrice > 0) {
        priceRange = { min: currentPrice * 0.85, max: currentPrice * 1.15 };
      }
      return;
    }
    let min = Infinity, max = -Infinity;
    for (const p of series) {
      if (p < min) min = p;
      if (p > max) max = p;
    }
    const span = max - min || max * 0.1 || 1;
    priceRange = { min: min - span * 0.15, max: max + span * 0.15 };
  }

  function priceToY(price) {
    if (!chartContainer || !svgEl) return 0;
    const h = chartContainer.clientHeight || 400;
    if (priceRange.max <= priceRange.min) return h / 2;
    const frac = (price - priceRange.min) / (priceRange.max - priceRange.min);
    const clamped = Math.max(0.02, Math.min(0.98, frac));
    return h * (1 - clamped);
  }

  function timeToX(ts, allMarkers) {
    if (!chartContainer) return 0;
    const w = chartContainer.clientWidth || 800;
    if (allMarkers.length <= 1) return w - 30;
    const minTs = allMarkers[0].ts;
    const maxTs = allMarkers[allMarkers.length - 1].ts;
    const span = maxTs - minTs || 1;
    const frac = (ts - minTs) / span;
    return w * (0.05 + frac * 0.9);
  }

  /* ---------------- marker rendering (SVG on chart) ---------------- */

  function renderMarkers() {
    if (!svgEl || !chartContainer) {
      if (!ensureContainer()) {
        renderFallback();
        return;
      }
    }

    // Skip rebuild if nothing meaningful changed since last render.
    // This prevents 60fps SVG rebuilds when tickPrice is called but the
    // price range hasn't actually moved.
    const count = markers.length;
    const rangeChanged =
      Math.abs(priceRange.min - lastRenderedRange.min) > Math.abs(priceRange.min) * 0.001 ||
      Math.abs(priceRange.max - lastRenderedRange.max) > Math.abs(priceRange.max) * 0.001;
    if (count === lastRenderedCount && !rangeChanged) return;

    lastRenderedCount = count;
    lastRenderedRange = { min: priceRange.min, max: priceRange.max };

    // Clear existing SVG content
    while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);

    if (!markers.length) return;

    const visible = markers.slice(-MAX_MARKERS);
    for (const m of visible) {
      const x = timeToX(m.ts, visible);
      const y = priceToY(m.price);
      const isBuy = m.side === 'buy';
      const color = isBuy ? '#3fb950' : '#f85149';
      const label = isBuy ? 'B' : 'S';

      // Hit area
      const hit = document.createElementNS(SVG_NS, 'circle');
      hit.setAttribute('cx', x);
      hit.setAttribute('cy', y);
      hit.setAttribute('r', BUBBLE_HIT_R);
      hit.setAttribute('fill', 'transparent');
      hit.style.pointerEvents = 'all';
      hit.style.cursor = 'pointer';

      // Visible bubble
      const bubble = document.createElementNS(SVG_NS, 'circle');
      bubble.setAttribute('cx', x);
      bubble.setAttribute('cy', y);
      bubble.setAttribute('r', BUBBLE_R);
      bubble.setAttribute('fill', color);
      bubble.setAttribute('stroke', '#fff');
      bubble.setAttribute('stroke-width', '1.5');
      bubble.style.filter = 'drop-shadow(0 1px 3px rgba(0,0,0,.5))';

      // Label
      const text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('x', x);
      text.setAttribute('y', y + 3);
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('font-size', '8');
      text.setAttribute('font-weight', '900');
      text.setAttribute('fill', '#fff');
      text.style.pointerEvents = 'none';
      text.textContent = label;

      // Tooltip
      const tooltip = createSvgTooltip(m);
      hit.addEventListener('mouseenter', () => showSvgTooltip(tooltip, x, y));
      hit.addEventListener('mouseleave', () => hideSvgTooltip(tooltip));

      svgEl.appendChild(bubble);
      svgEl.appendChild(text);
      svgEl.appendChild(hit);
      svgEl.appendChild(tooltip);
    }

    // Remove fallback if we're rendering on the chart
    if (fallbackEl) removeFallback();
  }

  function createSvgTooltip(m) {
    const g = document.createElementNS(SVG_NS, 'g');
    g.style.opacity = '0';
    g.style.transition = 'opacity 0.15s';
    g.style.pointerEvents = 'none';

    const lines = [
      `${m.side === 'buy' ? '🟢 Buy' : '🔴 Sell'} (Paper)`,
      `Price: ${Q.formatPrice(m.price)} SOL`,
      `Amount: ${m.solAmount.toFixed(3)} SOL`,
    ];
    if (m.symbol) lines.push(`Token: ${m.symbol}`);
    lines.push(timeAgo(m.ts));

    const padX = 8, padY = 6, lineH = 14;
    const maxW = Math.max(...lines.map(l => l.length * 6.5)) + padX * 2;
    const totalH = lines.length * lineH + padY * 2;

    const bg = document.createElementNS(SVG_NS, 'rect');
    bg.setAttribute('rx', 6);
    bg.setAttribute('ry', 6);
    bg.setAttribute('width', maxW);
    bg.setAttribute('height', totalH);
    bg.setAttribute('fill', '#0d1117');
    bg.setAttribute('stroke', m.side === 'buy' ? '#3fb950' : '#f85149');
    bg.setAttribute('stroke-width', '1.5');
    g.appendChild(bg);

    lines.forEach((line, i) => {
      const t = document.createElementNS(SVG_NS, 'text');
      t.setAttribute('x', padX);
      t.setAttribute('y', padY + (i + 1) * lineH - 3);
      t.setAttribute('font-size', '11');
      t.setAttribute('font-family', 'ui-sans-serif, system-ui, sans-serif');
      t.setAttribute('fill', i === 0 ? (m.side === 'buy' ? '#3fb950' : '#f85149') : '#e6edf3');
      t.textContent = line;
      g.appendChild(t);
    });

    g._maxW = maxW;
    g._totalH = totalH;
    return g;
  }

  function showSvgTooltip(g, x, y) {
    const w = chartContainer.clientWidth || 400;
    const tx = Math.min(x + 12, w - (g._maxW || 120) - 4);
    const ty = Math.max(4, y - (g._totalH || 60) - 8);
    g.setAttribute('transform', `translate(${tx}, ${ty})`);
    g.style.opacity = '1';
  }

  function hideSvgTooltip(g) {
    g.style.opacity = '0';
  }

  /* ---------------- fallback rendering (DOM strip) ---------------- */

  function renderFallback() {
    if (!markers.length) {
      if (fallbackEl) removeFallback();
      return;
    }

    const el = ensureFallback();
    if (!el) return; // document.body not ready
    // Clear and re-render
    el.textContent = '';

    const visible = markers.slice(-20); // Show last 20 in fallback
    for (const m of visible) {
      const isBuy = m.side === 'buy';
      const dot = document.createElement('div');
      dot.style.cssText = [
        'pointer-events:all',
        'cursor:pointer',
        'display:flex',
        'align-items:center',
        'gap:6px',
        'background:#0d1117',
        'border:1px solid ' + (isBuy ? '#3fb950' : '#f85149'),
        'border-radius:8px',
        'padding:4px 8px',
        'font-size:11px',
        'font-family:ui-sans-serif,system-ui,sans-serif',
        'color:#e6edf3',
        'box-shadow:0 2px 8px rgba(0,0,0,.4)',
      ].join(';');

      const badge = document.createElement('span');
      badge.textContent = isBuy ? '🟢 B' : '🔴 S';
      badge.style.fontWeight = '900';
      dot.appendChild(badge);

      const info = document.createElement('span');
      info.textContent = `${Q.formatPrice(m.price)} SOL · ${m.solAmount.toFixed(2)}`;
      dot.appendChild(info);

      const age = document.createElement('span');
      age.style.color = '#8b949e';
      age.style.fontSize = '10px';
      age.textContent = timeAgo(m.ts);
      dot.appendChild(age);

      el.appendChild(dot);
    }
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
   * same frame collapse into one render. This prevents render loops where
   * a DOM mutation from renderMarkers triggers the observer which triggers
   * another tickPrice which triggers another renderMarkers.
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
    });
    if (markers.length > MAX_MARKERS) markers.shift();
    updatePriceRange(m.price);
    requestRender();
  }

  /**
   * Update the current price for range tracking. Does NOT immediately render
   * — rendering is debounced to the next animation frame so multiple rapid
   * ticks don't cause excessive DOM manipulation.
   */
  function tickPrice(price) {
    if (!(price > 0)) return;
    updatePriceRange(price);
    if (markers.length) requestRender();
  }

  function clearMarkers() {
    markers = [];
    series = [];
    priceRange = { min: 0, max: 0 };
    lastRenderedRange = { min: 0, max: 0 };
    lastRenderedCount = -1;
    if (svgEl) while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);
    removeFallback();
  }

  function initChartMarkers() {
    // Try to find the chart container immediately
    if (ensureContainer()) {
      requestRender();
      return;
    }

    // Chart not found yet — set up aggressive polling to find it.
    if (scanTimer) clearInterval(scanTimer);
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
    series = [];
    priceRange = { min: 0, max: 0 };
  }

  const api = {
    addMarker,
    tickPrice,
    clearMarkers,
    initChartMarkers,
    destroyChartMarkers,
    // Exposed for testing
    _priceToY: priceToY,
    _timeToX: timeToX,
    _updatePriceRange: updatePriceRange,
    _getMarkers: () => markers,
    _getPriceRange: () => priceRange,
    _findChartContainer: findChartContainer,
    _scoreChartCandidate: scoreChartCandidate,
  };

  if (typeof window !== 'undefined') window.PTChartMarkers = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
