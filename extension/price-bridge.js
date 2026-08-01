/* PaperTrench — MAIN-world live-feed + Padre chart bridge.
 *
 * This file is loaded by the manifest at document_start in the page's MAIN
 * world. That timing matters: Padre opens a binary multiplex WebSocket during
 * startup, so injecting at document_idle is already too late.
 *
 * Live price path on Padre:
 *   Padre's TradingView datafeed -> subscribeBars callback -> `tick` message
 *
 * Native chart marker path on Padre:
 *   PaperTrench paper fill -> `paper-marker` message -> patched datafeed
 *   getMarks() -> TradingView activeChart().refreshMarks()
 *
 * This intentionally does NOT observe the entire DOM. A prior whole-document
 * MutationObserver reacted to PaperTrench's own chart DOM writes and could
 * create a render/mutation feedback loop that froze the site.
 */
(() => {
  'use strict';

  if (window.__paperTrenchMainBridgeV4) return;
  window.__paperTrenchMainBridgeV4 = true;

  const OUT_TAG = 'papertrench-bridge';
  const IN_TAG = 'papertrench-content';
  const PATCHED = Symbol('papertrench-patched');
  const MAX_DEPTH = 7;
  const MAX_CANDIDATES = 32;
  const MAX_MARKS = 500;

  let paperMarks = [];
  let lastWidget = null;
  let padreBarsHooked = false;
  let padreMarksHooked = false;
  let paperLineSpec = null;
  let averageFillLine = null;
  let averageExitLine = null;
  let lineWidget = null;

  function emit(type, payload) {
    try {
      window.postMessage({ source: OUT_TAG, type, payload }, '*');
    } catch (_) {}
  }

  function numberValue(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string' && v.length <= 64) {
      const n = Number(v.replace(/[$,\s]/g, ''));
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }

  const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const PRICE_KEY = /^(price|priceNative|priceUsd|priceInSol|priceSol|solPrice|usdPrice|tokenPrice|lastPrice|last|close|c|markPrice|currentPrice|avgPrice|quote)$/i;
  const MCAP_KEY = /^(marketCap|marketCapInUsd|mcap|mcapInUsd|fdv|fullyDilutedValuation)$/i;
  const MINT_KEY = /^(mint|tokenMint|tokenAddress|baseMint|address|contract|ca)$/i;
  const SYMBOL_KEY = /^(symbol|ticker|tokenSymbol|baseSymbol)$/i;
  const NAME_KEY = /^(name|tokenName|baseName)$/i;
  const USD_HINT = /usd|dollar/i;
  const NATIVE_HINT = /native|sol/i;

  function collect(obj) {
    const found = { candidates: [], mcap: null, mint: null, symbol: null, name: null };
    const seen = new WeakSet();

    (function walk(node, depth) {
      if (!node || typeof node !== 'object' || depth > MAX_DEPTH || seen.has(node)) return;
      seen.add(node);
      const entries = Array.isArray(node)
        ? node.slice(0, 80).map((v, i) => [String(i), v])
        : Object.entries(node);

      for (const [key, value] of entries) {
        if (value && typeof value === 'object') {
          walk(value, depth + 1);
          continue;
        }
        if (PRICE_KEY.test(key)) {
          const n = numberValue(value);
          if (n > 0 && found.candidates.length < MAX_CANDIDATES) {
            const unit = USD_HINT.test(key) ? 'usd' : NATIVE_HINT.test(key) ? 'native' : 'unknown';
            found.candidates.push({ value: n, unit, key });
          }
        } else if (MCAP_KEY.test(key)) {
          const n = numberValue(value);
          if (n > 0 && found.mcap === null) found.mcap = n;
        } else if (MINT_KEY.test(key) && typeof value === 'string' && BASE58_RE.test(value)) {
          found.mint = found.mint || value;
        } else if (SYMBOL_KEY.test(key) && typeof value === 'string' && value.length <= 24) {
          found.symbol = found.symbol || value;
        } else if (NAME_KEY.test(key) && typeof value === 'string' && value.length <= 64) {
          found.name = found.name || value;
        }
      }
    })(obj, 0);

    return found;
  }

  function forwardJson(raw, source) {
    let parsed = raw;
    if (typeof raw === 'string') {
      if (raw.length > 500_000) return;
      const trimmed = raw.trimStart();
      if (trimmed[0] !== '{' && trimmed[0] !== '[') return;
      try { parsed = JSON.parse(raw); } catch (_) { return; }
    }
    if (!parsed || typeof parsed !== 'object') return;
    const found = collect(parsed);
    if (!found.candidates.length && found.mcap === null) return;
    emit('tick', { ...found, source });
  }

  /* ---------------- early generic transport interception ---------------- */

  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function (...args) {
      const promise = originalFetch.apply(this, args);
      promise.then((response) => {
        try {
          const type = response.headers && response.headers.get('content-type');
          if (type && !/json/i.test(type)) return;
          response.clone().text().then((text) => forwardJson(text, 'fetch'), () => {});
        } catch (_) {}
      }, () => {});
      return promise;
    };
  }

  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype && !XHR.prototype.__paperTrenchPatched) {
    const originalSend = XHR.prototype.send;
    XHR.prototype.__paperTrenchPatched = true;
    XHR.prototype.send = function (body) {
      this.addEventListener('load', () => {
        try {
          if (this.responseType === '' || this.responseType === 'text') forwardJson(this.responseText, 'xhr');
          else if (this.responseType === 'json') forwardJson(this.response, 'xhr');
        } catch (_) {}
      });
      return originalSend.call(this, body);
    };
  }

  const OriginalWebSocket = window.WebSocket;
  if (typeof OriginalWebSocket === 'function') {
    const WrappedWebSocket = function (url, protocols) {
      const socket = protocols === undefined
        ? new OriginalWebSocket(url)
        : new OriginalWebSocket(url, protocols);
      socket.addEventListener('message', (event) => {
        // Padre's multiplex messages are binary protobuf and are deliberately
        // handled after Padre decodes them through its TradingView datafeed.
        if (typeof event.data === 'string') forwardJson(event.data, 'ws');
      });
      return socket;
    };
    WrappedWebSocket.prototype = OriginalWebSocket.prototype;
    WrappedWebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
    WrappedWebSocket.OPEN = OriginalWebSocket.OPEN;
    WrappedWebSocket.CLOSING = OriginalWebSocket.CLOSING;
    WrappedWebSocket.CLOSED = OriginalWebSocket.CLOSED;
    try { window.WebSocket = WrappedWebSocket; } catch (_) {}
  }

  const OriginalEventSource = window.EventSource;
  if (typeof OriginalEventSource === 'function') {
    const WrappedEventSource = function (url, options) {
      const source = options === undefined
        ? new OriginalEventSource(url)
        : new OriginalEventSource(url, options);
      source.addEventListener('message', (event) => {
        if (typeof event.data === 'string') forwardJson(event.data, 'sse');
      });
      return source;
    };
    WrappedEventSource.prototype = OriginalEventSource.prototype;
    try { window.EventSource = WrappedEventSource; } catch (_) {}
  }

  /* ---------------- Padre TradingView live bars ---------------- */

  function getPadreDatafeed(widget) {
    if (!widget || typeof widget !== 'object') return null;
    return (widget._options && widget._options.datafeed)
      || (widget.options && widget.options.datafeed)
      || null;
  }

  function emitPadreBar(bar, resolution) {
    if (!bar || typeof bar !== 'object') return;
    const close = numberValue(bar.close);
    if (!(close > 0)) return;

    // Padre can chart token USD price or market cap. Send the decoded close as
    // both an unknown price candidate and a possible market cap. quote.js
    // validates it against the trusted Dexscreener anchors and chooses the
    // matching interpretation.
    emit('tick', {
      candidates: [{ value: close, unit: 'unknown', key: 'padreChartClose' }],
      mcap: close,
      mint: null,
      symbol: null,
      name: null,
      source: 'padre-chart-bar',
      barTime: bar.time || null,
      resolution: resolution || null,
    });
  }

  function patchPadreBars(datafeed) {
    if (!datafeed || typeof datafeed.subscribeBars !== 'function') return false;
    if (datafeed.subscribeBars[PATCHED]) return true;

    const original = datafeed.subscribeBars;
    function subscribeBars(symbolInfo, resolution, onRealtimeCallback, subscriberUID, onResetCacheNeededCallback) {
      const wrappedCallback = (bar) => {
        emitPadreBar(bar, resolution);
        return onRealtimeCallback(bar);
      };
      return original.call(
        this,
        symbolInfo,
        resolution,
        wrappedCallback,
        subscriberUID,
        onResetCacheNeededCallback
      );
    }
    subscribeBars[PATCHED] = true;
    datafeed.subscribeBars = subscribeBars;
    return true;
  }

  /* ---------------- Padre native TradingView marks ---------------- */

  function normalizePaperMark(payload) {
    if (!payload || !(numberValue(payload.priceNative) > 0)) return null;
    const side = payload.side === 'sell' ? 'sell' : 'buy';
    const price = numberValue(payload.priceNative);
    const solAmount = numberValue(payload.solAmount) || 0;
    const tsMs = numberValue(payload.ts) || Date.now();
    const color = side === 'buy' ? '#17C671' : '#E73A44';
    const sideText = side === 'buy' ? 'Buy' : 'Sell';
    const symbol = typeof payload.symbol === 'string' ? payload.symbol : '';

    return {
      id: `papertrench-${side}-${Math.floor(tsMs)}-${Math.random().toString(36).slice(2, 8)}`,
      time: Math.floor(tsMs / 1000),
      color: { background: color, border: color },
      text: `${sideText} (Paper)\n${solAmount.toFixed(4)} SOL\n${price.toPrecision(7)} SOL${symbol ? `\n${symbol}` : ''}`,
      label: side === 'buy' ? 'B' : 'S',
      labelFontColor: '#FFFFFF',
      minSize: 18,
      borderWidth: 1,
      hoveredBorderWidth: 3,
      imageUrl: null,
      showLabelWhenImageLoaded: true,
      _paperTrench: true,
    };
  }

  function marksInRange(from, to) {
    const lo = Number(from);
    const hi = Number(to);
    return paperMarks.filter((mark) => mark.time >= lo && mark.time <= hi);
  }

  function patchPadreMarks(datafeed) {
    if (!datafeed || typeof datafeed.getMarks !== 'function') return false;
    if (datafeed.getMarks[PATCHED]) return true;

    const original = datafeed.getMarks;
    function getMarks(symbolInfo, from, to, onDataCallback, ...rest) {
      const mergedCallback = (siteMarks) => {
        const base = Array.isArray(siteMarks) ? siteMarks : [];
        const ours = marksInRange(from, to);
        onDataCallback(base.concat(ours));
      };
      return original.call(this, symbolInfo, from, to, mergedCallback, ...rest);
    }
    getMarks[PATCHED] = true;
    datafeed.getMarks = getMarks;
    return true;
  }

  function getPadreChart() {
    const widget = window.tvWidget;
    if (!widget) return null;
    try {
      return typeof widget.activeChart === 'function'
        ? widget.activeChart()
        : (typeof widget.chart === 'function' ? widget.chart() : null);
    } catch (_) {
      return null;
    }
  }

  function removeNativeLine(line) {
    if (!line) return null;
    try { line.remove(); } catch (_) {}
    return null;
  }

  function syncNativeAverageLine(line, chart, price, label, color) {
    if (!(Number(price) > 0)) return removeNativeLine(line);
    if (line) {
      try {
        line
          .setPrice(Number(price))
          .setLineColor(color)
          .setText(label)
          .setBodyFont('11px Inter, sans-serif')
          .setBodyTextColor(color);
        return line;
      } catch (_) {
        removeNativeLine(line);
      }
    }

    try {
      // Exact configuration used by Padre's K5r average-line helper.
      return chart.createOrderLine()
        .setText('')
        .setQuantity('')
        .setLineColor(color)
        .setLineStyle(2)
        .setLineWidth(1)
        .setPrice(Number(price))
        .setText(label)
        .setBodyFont('11px Inter, sans-serif')
        .setBodyTextColor(color)
        .setBodyBorderColor('#FFFFFF00')
        .setBodyBackgroundColor('#FFFFFF00')
        .setEditable(false);
    } catch (_) {
      return null;
    }
  }

  function clearPaperAverageLines() {
    averageFillLine = removeNativeLine(averageFillLine);
    averageExitLine = removeNativeLine(averageExitLine);
  }

  function syncPaperAverageLines() {
    const widget = window.tvWidget;
    const chart = getPadreChart();
    if (!widget || !chart) return false;

    if (lineWidget && lineWidget !== widget) clearPaperAverageLines();
    lineWidget = widget;

    if (!paperLineSpec || !paperLineSpec.enabled) {
      clearPaperAverageLines();
      return true;
    }

    averageFillLine = syncNativeAverageLine(
      averageFillLine,
      chart,
      paperLineSpec.avgBuyUsd,
      'Avg. Fill Price',
      '#90A8FA99'
    );
    averageExitLine = syncNativeAverageLine(
      averageExitLine,
      chart,
      paperLineSpec.avgSellUsd,
      'Avg. Exit Price',
      '#F7DC8599'
    );

    const buyExpected = Number(paperLineSpec.avgBuyUsd) > 0;
    const sellExpected = Number(paperLineSpec.avgSellUsd) > 0;
    return (!buyExpected || Boolean(averageFillLine)) && (!sellExpected || Boolean(averageExitLine));
  }

  function refreshPadreMarks() {
    try {
      const chart = getPadreChart();
      if (!chart) return false;
      if (typeof chart.clearMarks === 'function') chart.clearMarks();
      if (typeof chart.refreshMarks === 'function') {
        chart.refreshMarks();
        return true;
      }
    } catch (_) {}
    return false;
  }

  function patchPadreWidget() {
    const widget = window.tvWidget;
    if (!widget) return false;
    const datafeed = getPadreDatafeed(widget);
    if (!datafeed) return false;

    const barsWerePatched = Boolean(datafeed.subscribeBars && datafeed.subscribeBars[PATCHED]);
    const marksWerePatched = Boolean(datafeed.getMarks && datafeed.getMarks[PATCHED]);
    const bars = patchPadreBars(datafeed);
    const marks = patchPadreMarks(datafeed);
    const changedWidget = widget !== lastWidget;
    const newlyPatched = (!barsWerePatched && bars) || (!marksWerePatched && marks);
    lastWidget = widget;
    padreBarsHooked = bars;
    padreMarksHooked = marks;
    const linesReady = paperLineSpec ? syncPaperAverageLines() : true;

    if (changedWidget || newlyPatched) {
      emit('padre-hook-status', {
        barsHooked: padreBarsHooked,
        marksHooked: padreMarksHooked,
        linesReady,
        markerCount: paperMarks.length,
      });
      // A paper fill may have arrived while the widget was still loading.
      // Refresh once the native marks hook becomes available.
      if (marks && paperMarks.length) setTimeout(refreshPadreMarks, 0);
    }
    return bars && marks;
  }

  function handleContentMessage(event) {
    if (event.source !== window || !event.data || event.data.source !== IN_TAG) return;
    const { type, payload } = event.data;

    if (type === 'paper-lines-clear') {
      paperLineSpec = null;
      clearPaperAverageLines();
      emit('paper-lines-status', { action: 'clear', ok: true });
      return;
    }

    if (type === 'paper-lines') {
      paperLineSpec = {
        enabled: Boolean(payload && payload.enabled),
        avgBuyUsd: numberValue(payload && payload.avgBuyUsd),
        avgSellUsd: numberValue(payload && payload.avgSellUsd),
      };
      patchPadreWidget();
      const synced = syncPaperAverageLines();
      emit('paper-lines-status', {
        action: 'sync',
        ok: synced,
        buyVisible: Boolean(averageFillLine),
        sellVisible: Boolean(averageExitLine),
      });
      return;
    }

    if (type === 'paper-marker-clear') {
      paperMarks = [];
      patchPadreWidget();
      const refreshed = refreshPadreMarks();
      emit('paper-marker-status', { action: 'clear', ok: refreshed, count: 0 });
      return;
    }

    if (type === 'paper-marker') {
      const mark = normalizePaperMark(payload);
      if (!mark) {
        emit('paper-marker-status', { action: 'add', ok: false, reason: 'invalid-marker' });
        return;
      }
      paperMarks.push(mark);
      if (paperMarks.length > MAX_MARKS) paperMarks = paperMarks.slice(-MAX_MARKS);
      patchPadreWidget();
      const refreshed = refreshPadreMarks();
      emit('paper-marker-status', {
        action: 'add',
        ok: padreMarksHooked && refreshed,
        id: mark.id,
        count: paperMarks.length,
        marksHooked: padreMarksHooked,
      });
    }
  }

  window.addEventListener('message', handleContentMessage);

  // The bridge is installed before Padre creates window.tvWidget. Check
  // frequently during startup so subscribeBars is wrapped before the chart
  // subscribes, then continue at a low cadence to catch SPA widget replacement.
  let fastChecks = 0;
  const fastTimer = setInterval(() => {
    fastChecks += 1;
    if (patchPadreWidget() || fastChecks >= 500) clearInterval(fastTimer);
  }, 10);
  setInterval(patchPadreWidget, 1000);

  emit('ready', { href: location.href, phase: 'document-start', version: 4 });
})();
