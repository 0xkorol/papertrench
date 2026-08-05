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
  // Per-mark fill levels (USD / SOL / market cap), kept for the execution-
  // shape fallback which must place a Y-anchored arrow on whatever unit the
  // site's chart actually plots.
  const paperMarkLevels = new Map();
  let lastWidget = null;
  let padreBarsHooked = false;
  let padreMarksHooked = false;
  let paperLineSpec = null;
  let lineWidget = null;
  // Newest live bar close seen through the patched datafeed. Charts on these
  // sites plot either token USD price or market cap; the bar close tells us
  // which magnitude the Y axis lives at, so lines and shapes land on it.
  let lastBarClose = 0;
  // The pair/mint/symbol the content script has resolved for THIS page, used
  // to keep ticks, exports and drawing on the chart instance that matches it.
  // Axiom preloads charts for OTHER tokens — trusting their closes once put a
  // different token's price into the P&L and the average lines. Some Axiom
  // chart symbols carry the token symbol or mint rather than the pair address,
  // so we match against every identifier we know.
  const currentSymbolNeedles = [];
  const currentSymbolInfo = { mint: null, pairAddress: null, symbol: null };

  function chartSymbolMatches(chart) {
    if (!currentSymbolNeedles.length) return true; // nothing resolved yet: permissive
    try {
      const symbol = chart && typeof chart.symbol === 'function'
        ? String(chart.symbol()).toUpperCase()
        : '';
      if (!symbol || symbol.indexOf('UNKNOWN') === 0) return false;
      return currentSymbolNeedles.some((n) => symbol.indexOf(n) >= 0);
    } catch (_) {
      return false;
    }
  }

  function barSymbolMatches(symbolInfo) {
    if (!currentSymbolNeedles.length) return true;
    const raw = symbolInfo && (symbolInfo.ticker || symbolInfo.name || symbolInfo.symbol);
    if (!raw) return true; // unidentified feed: let validation decide
    const s = String(raw).toUpperCase();
    return currentSymbolNeedles.some((n) => s.indexOf(n) >= 0);
  }

  function setCurrentSymbolNeedles(payload) {
    const next = [];
    for (const key of ['pairAddress', 'mint', 'symbol']) {
      const v = payload && payload[key];
      if (typeof v === 'string' && v.length >= 2) {
        next.push(String(v).toUpperCase());
      }
      if (key in currentSymbolInfo) currentSymbolInfo[key] = v || null;
    }
    const changed = next.length !== currentSymbolNeedles.length
      || !next.every((n) => currentSymbolNeedles.indexOf(n) >= 0);
    currentSymbolNeedles.length = 0;
    for (const n of next) currentSymbolNeedles.push(n);
    // A new token means the old bar close is no longer a valid axis hint.
    if (changed) lastBarClose = 0;
  }
  // GMGN runs a private TradingView widget inside a same-origin blob iframe.
  // Its live React chart manager exposes `getActiveChart().createOrderLine()`.
  let gmgnChart = null;
  let gmgnLineSpec = null;
  let gmgnRetryTimer = null;

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

  // GMGN's realtime WebSocket publishes every venue trade on the
  // `token_activity` channel with terse keys: `a` = token mint, `pu` = trade
  // price in USD, `e` = buy/sell. The generic key scanner cannot see these
  // (`pu` matches no price pattern and `ca` is the AMM address, not the mint),
  // which left GMGN's live feed entirely unused — the extension fell back to
  // slow polling. Mint-tagged USD ticks let quote.js validate exactly.
  let lastActivityTickAt = 0;

  function forwardTokenActivity(parsed) {
    if (!parsed || parsed.channel !== 'token_activity' || !Array.isArray(parsed.data)) return false;
    const now = Date.now();
    if (now - lastActivityTickAt < 100) return true; // consumed, rate-limited
    const latestByMint = new Map();
    for (const item of parsed.data) {
      if (!item || typeof item.a !== 'string' || !BASE58_RE.test(item.a)) continue;
      const priceUsd = numberValue(item.pu);
      if (priceUsd > 0) latestByMint.set(item.a, priceUsd);
    }
    if (!latestByMint.size) return true;
    lastActivityTickAt = now;
    // Emit the mint the user is actually looking at FIRST: under high volume a
    // batch carries many mints, and Map iteration order offers no guarantee
    // the watched coin makes the cut. Then top up with any others.
    let emitted = 0;
    const emitTick = (mint, priceUsd) => {
      emit('tick', {
        candidates: [{ value: priceUsd, unit: 'usd', key: 'tokenActivityPriceUsd' }],
        mcap: null,
        mint,
        symbol: currentSymbolInfo.mint === mint ? currentSymbolInfo.symbol : null,
        name: null,
        source: 'gmgn-ws-trade',
      });
    };
    if (currentSymbolInfo.mint && latestByMint.has(currentSymbolInfo.mint)) {
      emitTick(currentSymbolInfo.mint, latestByMint.get(currentSymbolInfo.mint));
      emitted++;
    }
    for (const [mint, priceUsd] of latestByMint) {
      if (mint === currentSymbolInfo.mint) continue;
      if (emitted++ >= 4) break;
      emitTick(mint, priceUsd);
    }
    return true;
  }

  function forwardJson(raw, source, url) {
    let parsed = raw;
    if (typeof raw === 'string') {
      const trimmed = raw.trimStart();
      // GMGN's realtime trade batches grow past the parse guard exactly when
      // volume is high (reported: "tech doesn't work when volume is high" on
      // GMGN). The size limit exists to keep the generic collector walk from
      // chewing pathological frames — it must NOT blind the token_activity
      // fast path, which is the whole live feed on GMGN. Route those frames
      // before the guard; the walk keeps its guard. The probe is tolerant of
      // serializer whitespace (`"channel": "token_activity"` matches too);
      // forwardTokenActivity still validates the parsed shape.
      if (trimmed.length > 15 && trimmed.slice(0, 120).indexOf('"token_activity"') !== -1) {
        try { parsed = JSON.parse(raw); } catch (_) { return; }
        forwardTokenActivity(parsed);
        return;
      }
      if (raw.length > 500_000) return;
      if (trimmed[0] !== '{' && trimmed[0] !== '[') return;
      try { parsed = JSON.parse(raw); } catch (_) { return; }
    }
    if (!parsed || typeof parsed !== 'object') return;

    if (forwardTokenActivity(parsed)) return;

    // GMGN's embedded TradingView chart is explicitly a market-cap chart:
    // /api/v1/token_mcap_candles/... returns USD market-cap OHLC values in
    // data.list[]. GMGN's iframe symbol is `<chain>/<mint>/USD/MCAP`, so its
    // `close` value is the exact Y-axis unit, never a token-price value.
    if (url && /\/api\/v1\/token_mcap_candles\//.test(url)) {
      const candles = parsed && parsed.data && Array.isArray(parsed.data.list) ? parsed.data.list : [];
      const last = candles[candles.length - 1];
      const mcap = last && numberValue(last.close);
      if (mcap > 0) {
        emit('tick', {
          candidates: [],
          mcap,
          mint: currentSymbolInfo.mint,
          symbol: currentSymbolInfo.symbol,
          source: 'gmgn-mcap-candle',
        });
        return;
      }
    }

    const found = collect(parsed);
    if (!found.candidates.length && found.mcap === null) return;
    emit('tick', { ...found, source });
  }

  /* ---------------- early generic transport interception ---------------- */

  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function (...args) {
      const promise = originalFetch.apply(this, args);
      const input = args[0];
      const requestUrl = typeof input === 'string' ? input : (input && input.url) || '';
      promise.then((response) => {
        try {
          const type = response.headers && response.headers.get('content-type');
          if (type && !/json/i.test(type)) return;
          response.clone().text().then((text) => forwardJson(text, 'fetch', response.url || requestUrl), () => {});
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
          if (this.responseType === '' || this.responseType === 'text') forwardJson(this.responseText, 'xhr', this.responseURL);
          else if (this.responseType === 'json') forwardJson(this.response, 'xhr', this.responseURL);
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

  // GMGN routes realtime price updates through a SharedWorker. Observing the
  // worker port gives the page's newest quote without polling or modifying the
  // worker protocol. Returning the original worker object preserves instanceof
  // checks and application behavior.
  const OriginalSharedWorker = window.SharedWorker;
  if (typeof OriginalSharedWorker === 'function') {
    const WrappedSharedWorker = function (url, options) {
      const worker = options === undefined
        ? new OriginalSharedWorker(url)
        : new OriginalSharedWorker(url, options);
      try {
        const port = worker && worker.port;
        if (port && typeof port.addEventListener === 'function') {
          port.addEventListener('message', (event) => {
            if (event && typeof event.data === 'string') forwardJson(event.data, 'shared-worker');
            else if (event && event.data && typeof event.data === 'object') forwardJson(event.data, 'shared-worker');
          });
          if (typeof port.start === 'function') port.start();
        }
      } catch (_) {}
      return worker;
    };
    WrappedSharedWorker.prototype = OriginalSharedWorker.prototype;
    try { window.SharedWorker = WrappedSharedWorker; } catch (_) {}
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

  /* ---------------- TradingView widget discovery ---------------- */

  /**
   * Find the page's TradingView widget.
   *
   * Padre publishes it as `window.tvWidget`. Axiom loads the same TradingView
   * library (`/scripts/trading-view-lib/datafeeds/udf/dist/bundle.js`) but does
   * not always use that name, so the known globals are checked first and then
   * the window is scanned for an object carrying the widget's own API shape.
   *
   * Matching on API SHAPE rather than a name is what makes this survive a site
   * renaming its variable, which minified bundles do on every deploy.
   */
  const WIDGET_GLOBALS = ['tvWidget', 'tradingViewWidget', 'axiomChart', 'chartWidget', 'widget'];

  function looksLikeWidget(value) {
    if (!value || typeof value !== 'object') return false;
    const hasChart = typeof value.activeChart === 'function' || typeof value.chart === 'function';
    if (!hasChart) return false;
    // onChartReady is present on every TradingView widget and is rare enough
    // elsewhere to make this a safe discriminator.
    return typeof value.onChartReady === 'function' || Boolean(getPadreDatafeed(value));
  }

  function findGlobalWidget() {
    for (const name of WIDGET_GLOBALS) {
      try {
        if (looksLikeWidget(window[name])) return window[name];
      } catch (_) { /* cross-origin or throwing getter */ }
    }
    // Shape scan, bounded so a large page cannot stall the bridge.
    let keys;
    try { keys = Object.keys(window); } catch (_) { return null; }
    for (let i = 0; i < keys.length && i < 400; i++) {
      const key = keys[i];
      if (!/widget|chart|tv|axiom/i.test(key)) continue;
      try {
        if (looksLikeWidget(window[key])) return window[key];
      } catch (_) { /* ignore */ }
    }
    return null;
  }

  /**
   * Axiom exposes NO window global for its TradingView widget — the instances
   * live in React refs. The mounted fiber tree (reached through the standard
   * TradingView container iframe's parent element) is walked defensively for
   * ref objects with the widget's API shape, exactly like the GMGN chart
   * manager discovery below. The scan is cached: it is bounded but not free,
   * and the callers poll.
   */
  const fiberWidgetsCache = { at: 0, widgets: [] };
  const FIBER_SCAN_INTERVAL_MS = 3000;

  function widgetsFromFibers() {
    const now = Date.now();
    if (now - fiberWidgetsCache.at < FIBER_SCAN_INTERVAL_MS) return fiberWidgetsCache.widgets;
    fiberWidgetsCache.at = now;
    const widgets = [];
    try {
      const anchor = document.querySelector('iframe[id^="tradingview_"]');
      const el = anchor && anchor.parentElement;
      const fiberKey = el && Object.getOwnPropertyNames(el).find((key) => key.indexOf('__reactFiber$') === 0);
      let root = fiberKey ? el[fiberKey] : null;
      if (root) {
        while (root.return) root = root.return;
        const seen = new Set();
        const stack = [root];
        let inspected = 0;
        while (stack.length && inspected++ < 8000) {
          const fiber = stack.pop();
          if (!fiber || seen.has(fiber)) continue;
          seen.add(fiber);
          if (fiber.child) stack.push(fiber.child);
          if (fiber.sibling) stack.push(fiber.sibling);
          let hook = fiber.memoizedState;
          let hooks = 0;
          while (hook && hooks++ < 100) {
            const ref = hook.memoizedState && hook.memoizedState.current;
            try {
              if (looksLikeWidget(ref) && widgets.indexOf(ref) < 0) widgets.push(ref);
            } catch (_) { /* throwing getter on a ref */ }
            hook = hook.next;
          }
        }
      }
    } catch (_) { /* fiber internals shifted; other strategies still apply */ }
    fiberWidgetsCache.widgets = widgets;
    return widgets;
  }

  /**
   * Last resort: the TradingView library iframe is same-origin (blob: URL),
   * and its inner window publishes `tradingViewApi` with `activeChart()`.
   * This grants order lines and execution shapes even when the outer widget
   * object cannot be located at all. No datafeed access from here, so bars
   * and getMarks stay unhooked on this path.
   */
  const iframeWidgetCache = new WeakMap();

  function widgetsFromIframes() {
    const out = [];
    try {
      for (const frame of document.querySelectorAll('iframe[id^="tradingview_"]')) {
        let api = null;
        try {
          api = frame.contentWindow && frame.contentWindow.tradingViewApi;
        } catch (_) { continue; }
        if (!api || typeof api.activeChart !== 'function') continue;
        let pseudo = iframeWidgetCache.get(frame);
        if (!pseudo) {
          pseudo = {
            activeChart: () => {
              const live = frame.contentWindow && frame.contentWindow.tradingViewApi;
              return live && typeof live.activeChart === 'function' ? live.activeChart() : null;
            },
            onChartReady: (cb) => { try { cb(); } catch (_) {} },
            _iFrame: frame,
          };
          iframeWidgetCache.set(frame, pseudo);
        }
        out.push(pseudo);
      }
    } catch (_) {}
    return out;
  }

  function findTradingViewWidgets() {
    const out = [];
    const push = (w) => { if (w && out.indexOf(w) < 0) out.push(w); };
    push(findGlobalWidget());
    for (const w of widgetsFromFibers()) push(w);
    if (!out.length) for (const w of widgetsFromIframes()) push(w);
    return out;
  }

  function findTradingViewWidget() {
    return findTradingViewWidgets()[0] || null;
  }

  /* ---------------- TradingView live bars ---------------- */

  function getPadreDatafeed(widget) {
    if (!widget || typeof widget !== 'object') return null;
    return (widget._options && widget._options.datafeed)
      || (widget.options && widget.options.datafeed)
      || null;
  }

  let lastLiveBarAt = 0; // newest live bar through the subscribeBars hook

  function emitPadreBar(bar, resolution) {
    if (!bar || typeof bar !== 'object') return;
    const close = numberValue(bar.close);
    if (!(close > 0)) return;
    lastBarClose = close;
    lastLiveBarAt = Date.now();

    // Padre can chart token USD price or market cap. Send the decoded close as
    // both an unknown price candidate and a possible market cap. quote.js
    // validates it against the trusted Dexscreener anchors and chooses the
    // matching interpretation.
    emit('tick', {
      candidates: [{ value: close, unit: 'unknown', key: 'padreChartClose' }],
      mcap: close,
      mint: currentSymbolInfo.mint,
      symbol: currentSymbolInfo.symbol,
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
      noteResolution(resolution);
      const wrappedCallback = (bar) => {
        // Bars for a different token's chart (Axiom preload) are still passed
        // to the site but must never move our price or axis detection.
        if (barSymbolMatches(symbolInfo)) emitPadreBar(bar, resolution);
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

  // Newest chart resolution observed through subscribeBars/getMarks, so paper
  // marks can snap their time to the bar grid exactly like the site's own
  // bubbles do.
  let lastResolutionMs = null;

  function resolutionToMs(res) {
    const s = String(res || '');
    if (/^\d+S$/.test(s)) return parseInt(s, 10) * 1000;
    if (/^\d+$/.test(s)) return parseInt(s, 10) * 60_000;
    if (/^\d+D$/i.test(s)) return parseInt(s, 10) * 86_400_000;
    if (/^\d+W$/i.test(s)) return parseInt(s, 10) * 604_800_000;
    return null;
  }

  function noteResolution(res) {
    const ms = resolutionToMs(res);
    if (ms) lastResolutionMs = ms;
  }

  function snapMarkTime(tsMs) {
    if (lastResolutionMs) return Math.floor(tsMs / lastResolutionMs) * lastResolutionMs / 1000;
    return Math.floor(tsMs / 1000);
  }

  /** Compact money text, matching how Axiom prints bubble prices. */
  function formatCompactUsd(n) {
    const v = Number(n);
    if (!(v > 0)) return '';
    if (v >= 1e12) return '$' + (v / 1e12).toFixed(2) + 'T';
    if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
    if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
    if (v >= 0.01) return '$' + v.toFixed(2);
    return '$' + v.toPrecision(4);
  }

  /** Plain-decimal SOL text (never scientific notation), as Axiom prints it. */
  function formatSolNative(v) {
    const n = Number(v);
    if (!(n > 0)) return '';
    if (n >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
    if (n >= 0.001) return String(Number(n.toPrecision(4)));
    return n.toFixed(12).replace(/0+$/, '').replace(/\.$/, '');
  }

  // Axiom draws trades as TradingView marks; these are the DEFAULTS of its
  // own bubble settings atoms (userBuyBubbleColor / userSellBubbleColor /
  // userBubbleSize), so paper fills are indistinguishable from the bubbles
  // Axiom paints for the user's and tracked wallets' real trades.
  const AXIOM_HOSTS = /(^|\.)axiom\.trade$/;
  let isAxiomHost = false;
  try { isAxiomHost = AXIOM_HOSTS.test(location.hostname); } catch (_) {}
  const AXIOM_BUY_BUBBLE = '#089981';
  const AXIOM_SELL_BUBBLE = '#f23645';
  const AXIOM_BUBBLE_SIZE = 25;

  function normalizePaperMark(payload) {
    if (!payload || !(numberValue(payload.priceNative) > 0)) return null;
    const side = payload.side === 'sell' ? 'sell' : 'buy';
    const price = numberValue(payload.priceNative);
    const solAmount = numberValue(payload.solAmount) || 0;
    const tsMs = numberValue(payload.ts) || Date.now();
    const symbol = typeof payload.symbol === 'string' ? payload.symbol : '';
    const id = `papertrench-${side}-${Math.floor(tsMs)}-${Math.random().toString(36).slice(2, 8)}`;

    if (isAxiomHost) {
      const priceUsd = numberValue(payload.priceUsd);
      const mcap = numberValue(payload.mcap);
      const usdSize = priceUsd && price > 0 ? solAmount * (priceUsd / price) : null;
      const sizeText = usdSize ? formatCompactUsd(usdSize) : `${solAmount.toFixed(4)} SOL`;
      // Print the "at" price in the same units the chart's Y axis currently
      // shows — price vs market cap, USD vs SOL — like Axiom's own bubbles.
      const nativeMcap = mcap && priceUsd && price > 0 ? mcap * (price / priceUsd) : null;
      const atEntry = pickAxisEntry([
        { v: mcap, text: mcap ? `${formatCompactUsd(mcap)} Market Cap` : null },
        { v: priceUsd, text: priceUsd ? `${formatCompactUsd(priceUsd)} USD` : null },
        { v: price, text: `${formatSolNative(price)} SOL` },
        { v: nativeMcap, text: nativeMcap ? `${formatSolNative(nativeMcap)} SOL Market Cap` : null },
      ]) || { v: mcap, text: mcap ? `${formatCompactUsd(mcap)} Market Cap` : `${formatSolNative(price)} SOL` };
      const atText = atEntry.text || formatCompactUsd(atEntry.v);
      const background = side === 'buy' ? AXIOM_BUY_BUBBLE : AXIOM_SELL_BUBBLE;
      return {
        id,
        time: snapMarkTime(tsMs),
        color: { background, border: background + '80' },
        text: `You ${side === 'buy' ? 'bought' : 'sold'} ${sizeText} at ${atText} (Paper)`,
        label: side === 'buy' ? 'B' : 'S',
        labelFontColor: 'white',
        minSize: AXIOM_BUBBLE_SIZE,
        _paperTrench: true,
      };
    }

    const color = side === 'buy' ? '#17C671' : '#E73A44';
    const sideText = side === 'buy' ? 'Buy' : 'Sell';
    return {
      id,
      time: snapMarkTime(tsMs),
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

  // Newest moment TradingView actually pulled marks through our patched
  // getMarks. Some sites load the library with marks disabled; when that
  // pipeline never runs, fills are drawn as native execution shapes instead.
  let marksPipelineSeenAt = 0;
  let shapeFallbackActive = false;

  function marksInRange(from, to) {
    // Once the execution-shape fallback owns rendering, the getMarks pipeline
    // must not duplicate the same fills.
    if (shapeFallbackActive) return [];
    const lo = Number(from);
    const hi = Number(to);
    return paperMarks.filter((mark) => mark.time >= lo && mark.time <= hi);
  }

  function patchPadreMarks(datafeed) {
    if (!datafeed || typeof datafeed.getMarks !== 'function') return false;
    if (datafeed.getMarks[PATCHED]) return true;

    const original = datafeed.getMarks;
    function getMarks(symbolInfo, from, to, onDataCallback, ...rest) {
      marksPipelineSeenAt = Date.now();
      noteResolution(rest[0]);
      // The library IS pulling marks — the native pipeline wins. If the
      // execution-shape fallback fired first (slow chart boot), hand
      // rendering back and remove the temporary shapes. Paper fills then
      // render as the site's own bubble marks (Axiom-styled on Axiom).
      if (shapeFallbackActive) {
        shapeFallbackActive = false;
        clearShapeFallback();
      }
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

  function frameVisible(frame) {
    try {
      if (!frame || typeof frame.getClientRects !== 'function') return false;
      return frame.getClientRects().length > 0 && frame.clientWidth > 0;
    } catch (_) {
      return false;
    }
  }

  /**
   * All reachable charts, best first.
   *
   * Axiom keeps a hidden PRELOAD widget alongside the visible one; its chart
   * has no series ("UNKNOWN-..." symbol) and every draw call on it throws
   * "Value is null". Drawing must always target the chart the user is
   * actually looking at, so charts are ranked by iframe visibility and by
   * whether they carry a real symbol.
   */
  function getRankedCharts() {
    const ranked = [];
    const seen = new Set();
    for (const widget of findTradingViewWidgets()) {
      // Axiom's own drawing code goes through widget.chart(), while the
      // "active" chart of a multi-chart widget can be a seriesless shell
      // whose every draw call throws. Collect BOTH accessors' charts and let
      // the ranked fall-through find the one that actually accepts drawing.
      const accessors = [];
      if (typeof widget.chart === 'function') accessors.push('chart');
      if (typeof widget.activeChart === 'function') accessors.push('activeChart');
      for (const accessor of accessors) {
        try {
          const chart = widget[accessor]();
          if (!chart || seen.has(chart)) continue;
          seen.add(chart);
          let score = 0;
          if (chartSymbolMatches(chart)) score += 4;
          if (frameVisible(widget._iFrame)) score += 2;
          try {
            const symbol = typeof chart.symbol === 'function' ? String(chart.symbol()) : '';
            if (symbol && symbol.indexOf('UNKNOWN') !== 0) score += 1;
          } catch (_) {}
          ranked.push({ chart, score });
        } catch (_) { /* try the next accessor/widget */ }
      }
    }
    ranked.sort((a, b) => b.score - a.score);
    const ordered = ranked.map((entry) => entry.chart);
    if (!currentSymbolNeedles.length) return ordered;
    const matched = ordered.filter((c) => chartSymbolMatches(c));
    return matched.length ? matched : ordered;
  }

  function getPadreChart() {
    return getRankedCharts()[0] || null;
  }

  /* ---------------- async-tolerant native adapters ----------------
   *
   * Current TradingView builds (GMGN today, others as they upgrade) return a
   * Promise from createOrderLine()/createExecutionShape(); older builds hand
   * back the adapter synchronously. Every native drawing below goes through
   * these helpers so both shapes work, including the clear-while-creating
   * race: a slot generation counter makes a stale resolution remove itself.
   */

  function makeLineSlot() { return { adapter: null, pending: false, pendingAt: 0, gen: 0, chart: null }; }

  function clearLineSlot(slot) {
    slot.gen += 1;
    slot.pending = false;
    slot.pendingAt = 0;
    if (slot.adapter) { try { slot.adapter.remove(); } catch (_) {} }
    slot.adapter = null;
    slot.chart = null;
  }

  function configureAverageLine(line, price, label, color) {
    // Exact configuration used by Padre's K5r average-line helper.
    return line
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
  }

  /**
   * Keep one average line in sync with `price`. Returns true when the line is
   * live, being created, or intentionally absent; false when the chart could
   * not produce it (callers retry).
   */
  function syncLineSlot(slot, chart, price, label, color) {
    if (!(Number(price) > 0)) { clearLineSlot(slot); return true; }
    // The adapter belongs to one chart. If the site promoted a different
    // chart to the foreground (Axiom preload swap), recreate the line there.
    if (slot.adapter && slot.chart && slot.chart !== chart) clearLineSlot(slot);
    if (slot.adapter) {
      try {
        slot.adapter
          .setPrice(Number(price))
          .setLineColor(color)
          .setText(label)
          .setBodyFont('11px Inter, sans-serif')
          .setBodyTextColor(color);
        return true;
      } catch (_) {
        clearLineSlot(slot);
      }
    }
    // An async createOrderLine can stay pending forever when it was issued
    // before the chart had a series (same failure as exportData at boot).
    // Let the guard expire and try again.
    if (slot.pending) {
      if (Date.now() - slot.pendingAt < 5000) return true;
      clearLineSlot(slot);
    }

    let created;
    try { created = chart.createOrderLine(); } catch (_) { return false; }
    if (created && typeof created.then === 'function') {
      slot.pending = true;
      slot.pendingAt = Date.now();
      const gen = slot.gen;
      created.then((line) => {
        if (slot.gen !== gen) { try { line.remove(); } catch (_) {} return; }
        slot.pending = false;
        slot.pendingAt = 0;
        try {
          configureAverageLine(line, price, label, color);
          slot.adapter = line;
          slot.chart = chart;
        } catch (_) {
          try { line.remove(); } catch (_) {}
        }
      }, () => { if (slot.gen === gen) { slot.pending = false; slot.pendingAt = 0; } });
      return true;
    }
    if (!created) return false;
    try {
      configureAverageLine(created, price, label, color);
      slot.adapter = created;
      slot.chart = chart;
      return true;
    } catch (_) {
      try { created.remove(); } catch (_) {}
      return false;
    }
  }

  /**
   * Spawn one buy/sell execution shape at `level` on the chart's own Y axis.
   * Returns a handle whose `removed` flag also cancels an in-flight creation.
   */
  function spawnExecutionShape(chart, spec) {
    const level = Number(spec.level);
    const timeSec = Number(spec.timeSec);
    if (!(level > 0) || !(timeSec > 0)) return null;
    const isBuy = spec.side !== 'sell';
    const handle = { removed: false, adapter: null };

    const configure = (shape) => {
      shape
        .setText(spec.text || (isBuy ? 'PT Buy' : 'PT Sell'))
        .setTextColor(isBuy ? '#34D399' : '#FF5F56')
        .setArrowColor(isBuy ? '#34D399' : '#FF5F56')
        .setDirection(isBuy ? 'buy' : 'sell')
        .setTime(Math.floor(timeSec))
        .setPrice(level);
      if (handle.removed) { try { shape.remove(); } catch (_) {} return; }
      handle.adapter = shape;
    };

    let created;
    try { created = chart.createExecutionShape(); } catch (_) { return null; }
    if (created && typeof created.then === 'function') {
      created.then((shape) => {
        try { configure(shape); } catch (_) { try { shape.remove(); } catch (_) {} }
      }, () => {});
      return handle;
    }
    if (!created) return null;
    try { configure(created); } catch (_) { try { created.remove(); } catch (_) {} return null; }
    return handle;
  }

  function removeShapeHandle(handle) {
    if (!handle) return;
    handle.removed = true;
    if (handle.adapter) { try { handle.adapter.remove(); } catch (_) {} }
    handle.adapter = null;
  }

  /**
   * Choose which stored fill level matches the chart's Y axis. The newest live
   * bar close reveals the axis unit by magnitude: a $0.000003 token and its
   * $250M market cap are ~14 orders of magnitude apart, so the nearest level
   * in log space is unambiguous. Entries may carry a `text` the caller wants
   * to reuse when that unit wins (hover text on Axiom prints in chart units).
   */
  function pickAxisEntry(entries) {
    const usable = entries.filter((e) => Number(e && e.v) > 0);
    if (!usable.length) return null;
    if (!(lastBarClose > 0)) return usable[0];
    let best = usable[0];
    let bestDist = Math.abs(Math.log10(best.v / lastBarClose));
    for (const e of usable.slice(1)) {
      const dist = Math.abs(Math.log10(e.v / lastBarClose));
      if (dist < bestDist) { best = e; bestDist = dist; }
    }
    return best;
  }

  function pickAxisLevel(usd, mcap, native, nativeMcap) {
    // Before any bar close has been seen, pickAxisEntry falls back to the
    // FIRST usable candidate. Axiom's default chart view is market cap, so
    // order mcap first there; Padre charts price, so USD first elsewhere.
    const ordered = isAxiomHost
      ? [{ v: mcap }, { v: usd }, { v: native }, { v: nativeMcap }]
      : [{ v: usd }, { v: mcap }, { v: native }, { v: nativeMcap }];
    const picked = pickAxisEntry(ordered);
    return picked ? picked.v : null;
  }

  /* ---------------- Padre/Axiom average lines ---------------- */

  /**
   * Compute the market-cap level that corresponds to an average token price,
   * using the live bar close as the current mcap and the current token price.
   * This is the only way to draw an accurate mcap average line when the
   * resolver has a different mcap (e.g., Axiom Final Stretch vs Dexscreener).
   */
  function mcapLevelFromClose(avgPrice, currentPrice) {
    if (!(lastBarClose > 0) || !(Number(avgPrice) > 0) || !(Number(currentPrice) > 0)) return null;
    return lastBarClose * (Number(avgPrice) / Number(currentPrice));
  }

  /**
   * The level for one average line. When the content script knows the chart's
   * axis unit (learned from which band accepted the live chart ticks), the
   * matching candidate is used directly — no magnitude guessing. Otherwise
   * fall back to comparing candidates against the newest bar close.
   */
  function lineLevelFor(spec, side) {
    const basis = spec.axisBasis;
    const currentNative = Number(spec.currentPriceNative);
    const currentUsd = Number(spec.currentPriceUsd);

    if (basis) {
      if (basis === 'usd') return Number(spec['avg' + side + 'Usd']) || null;
      if (basis === 'native') return Number(spec['avg' + side + 'Native']) || null;
      if (basis === 'mcap') {
        const avg = Number(spec['avg' + side + 'Usd']);
        const computed = mcapLevelFromClose(avg, currentUsd);
        if (computed > 0) return computed;
        const explicit = Number(spec['avg' + side + 'Mcap']);
        return explicit > 0 ? explicit : null;
      }
      if (basis === 'native-mcap') {
        const avg = Number(spec['avg' + side + 'Native']);
        const computed = mcapLevelFromClose(avg, currentNative);
        if (computed > 0) return computed;
        const explicit = Number(spec['avg' + side + 'McapNative']);
        return explicit > 0 ? explicit : null;
      }
    }

    // Fallback: compute mcap candidates from the live bar close when possible,
    // so the bridge can still land the line on an Axiom/Padre mcap chart even
    // if the content script has not determined the axis basis yet.
    const usd = Number(spec['avg' + side + 'Usd']);
    const native = Number(spec['avg' + side + 'Native']);
    const mcap = mcapLevelFromClose(usd, currentUsd)
      || Number(spec['avg' + side + 'Mcap'])
      || null;
    const nativeMcap = mcapLevelFromClose(native, currentNative)
      || Number(spec['avg' + side + 'McapNative'])
      || null;
    return pickAxisLevel(usd, mcap, native, nativeMcap);
  }

  const averageFillSlot = makeLineSlot();
  const averageExitSlot = makeLineSlot();

  function clearPaperAverageLines() {
    clearLineSlot(averageFillSlot);
    clearLineSlot(averageExitSlot);
  }

  function syncPaperAverageLines() {
    const widget = findTradingViewWidget();
    const charts = getRankedCharts();
    if (!widget || !charts.length) return false;

    if (lineWidget && lineWidget !== widget) clearPaperAverageLines();
    lineWidget = widget;

    if (!paperLineSpec || !paperLineSpec.enabled) {
      clearPaperAverageLines();
      return true;
    }

    const buyLevel = lineLevelFor(paperLineSpec, 'Buy');
    const sellLevel = lineLevelFor(paperLineSpec, 'Sell');
    // The best-ranked chart can still refuse (Axiom's preload chart throws
    // "Value is null" until a series loads); fall through the ranking.
    for (const chart of charts) {
      const buyOk = syncLineSlot(averageFillSlot, chart, buyLevel, 'Avg. Fill Price', '#90A8FA99');
      const sellOk = syncLineSlot(averageExitSlot, chart, sellLevel, 'Avg. Exit Price', '#F7DC8599');
      if (buyOk && sellOk) return true;
    }
    return false;
  }

  /* ---------------- execution-shape fallback for fills ---------------- */

  const fallbackShapeHandles = new Map(); // mark id -> shape handle
  let fallbackCheckTimer = null;

  function drawShapeFallback() {
    const charts = getRankedCharts();
    let drewAll = charts.length > 0;
    for (const mark of paperMarks) {
      const levels = paperMarkLevels.get(mark.id);
      if (!levels) continue;
      const existing = fallbackShapeHandles.get(mark.id);
      // Redraw on the current best chart if the site swapped charts.
      if (existing && existing.chart && charts.length && existing.chart !== charts[0]) {
        removeShapeHandle(existing);
        fallbackShapeHandles.delete(mark.id);
      } else if (existing) {
        continue;
      }
      const level = pickAxisLevel(levels.usd, levels.mcap, levels.native, levels.nativeMcap);
      if (!(level > 0)) continue;
      let handle = null;
      for (const chart of charts) {
        if (typeof chart.createExecutionShape !== 'function') continue;
        handle = spawnExecutionShape(chart, {
          side: levels.side,
          timeSec: mark.time,
          level,
          text: levels.side === 'sell' ? 'PT Sell' : 'PT Buy',
        });
        if (handle) { handle.chart = chart; break; }
      }
      if (handle) fallbackShapeHandles.set(mark.id, handle);
      else drewAll = false;
    }
    return drewAll;
  }

  function clearShapeFallback() {
    for (const handle of fallbackShapeHandles.values()) removeShapeHandle(handle);
    fallbackShapeHandles.clear();
  }

  /**
   * After a fill is submitted through the marks pipeline, verify the library
   * actually pulled marks. Axiom loads TradingView without marks support, so
   * refreshMarks() there is a silent no-op — the only reliable signal is
   * whether our patched getMarks ever ran. When it did not, switch this page
   * to native execution shapes permanently.
   */
  function ensureMarksRender() {
    if (shapeFallbackActive) { drawShapeFallback(); return; }
    if (fallbackCheckTimer) clearTimeout(fallbackCheckTimer);
    fallbackCheckTimer = setTimeout(() => {
      fallbackCheckTimer = null;
      if (!paperMarks.length) return;
      if (marksPipelineSeenAt && Date.now() - marksPipelineSeenAt < 10_000) return;
      shapeFallbackActive = true;
      drawShapeFallback();
    }, 2000);
  }

  /* ---------------- GMGN native TradingView order lines ---------------- */

  function findGmgnChart() {
    const host = document.getElementById('global-tv-overlay');
    if (!host) return null;
    const fiberKey = Object.getOwnPropertyNames(host).find((key) => key.indexOf('__reactFiber$') === 0);
    const start = fiberKey && host[fiberKey];
    if (!start) return null;

    // GMGN's chart manager is not global. It is kept in a React ref whose
    // current value carries these stable public manager subjects/methods.
    // Traverse the mounted fiber tree defensively; no component is mutated.
    let root = start;
    while (root.return) root = root.return;
    const seen = new Set();
    const stack = [root];
    let inspected = 0;
    while (stack.length && inspected++ < 4000) {
      const fiber = stack.pop();
      if (!fiber || seen.has(fiber)) continue;
      seen.add(fiber);
      if (fiber.child) stack.push(fiber.child);
      if (fiber.sibling) stack.push(fiber.sibling);
      let hook = fiber.memoizedState;
      let hooks = 0;
      while (hook && hooks++ < 100) {
        const ref = hook.memoizedState && hook.memoizedState.current;
        if (ref && ref.widgetSubject && ref.activeChartSubject && ref.chartsSubject && typeof ref.getActiveChart === 'function') {
          try {
            const chart = ref.getActiveChart();
            if (chart && typeof chart.createOrderLine === 'function') return chart;
          } catch (_) {}
        }
        hook = hook.next;
      }
    }
    return null;
  }

  const gmgnBuySlot = makeLineSlot();
  const gmgnSellSlot = makeLineSlot();

  function clearGmgnAverageLines() {
    clearLineSlot(gmgnBuySlot);
    clearLineSlot(gmgnSellSlot);
    gmgnChart = null;
    if (gmgnRetryTimer) { clearTimeout(gmgnRetryTimer); gmgnRetryTimer = null; }
  }

  /* ---------------- GMGN native fill markers ---------------- */

  let gmgnShapes = [];       // shape handles for drawn fills
  let gmgnMarkerQueue = [];  // fills waiting for a usable chart
  let gmgnMarkerTimer = null;

  /**
   * Draw a paper fill on GMGN's own chart using TradingView's execution shape.
   *
   * GMGN's axis is market cap, so `mcap` positions the arrow. A native shape
   * stays anchored to its candle through panning, zooming and auto-scale,
   * which an absolutely-positioned SVG overlay cannot do.
   *
   * Fills are queued and drained: markers restored from the journal arrive
   * before GMGN's chart manager has mounted, and dropping them on the floor
   * was exactly the "bubbles never show" failure. The drain retries until the
   * chart exists.
   */
  function drainGmgnMarkers() {
    if (!gmgnMarkerQueue.length) return true;
    const chart = findGmgnChart();
    if (!chart || typeof chart.createExecutionShape !== 'function') return false;
    for (const payload of gmgnMarkerQueue.splice(0)) {
      const handle = spawnExecutionShape(chart, {
        side: payload.side,
        timeSec: Math.floor((numberValue(payload.ts) || 0) / 1000),
        level: numberValue(payload.mcap),
        text: payload.text,
      });
      if (!handle) continue;
      gmgnShapes.push(handle);
      if (gmgnShapes.length > MAX_MARKS) removeShapeHandle(gmgnShapes.shift());
    }
    return true;
  }

  function scheduleGmgnMarkerDrain() {
    if (gmgnMarkerTimer) return;
    let attempts = 0;
    const retry = () => {
      gmgnMarkerTimer = null;
      if (drainGmgnMarkers() || ++attempts >= 30) return;
      gmgnMarkerTimer = setTimeout(retry, 500);
    };
    retry();
  }

  function addGmgnFillMarker(payload) {
    const level = numberValue(payload && payload.mcap);
    const time = numberValue(payload && payload.ts);
    if (!(level > 0) || !(time > 0)) return false;
    gmgnMarkerQueue.push(payload);
    if (gmgnMarkerQueue.length > MAX_MARKS) gmgnMarkerQueue = gmgnMarkerQueue.slice(-MAX_MARKS);
    scheduleGmgnMarkerDrain();
    return true;
  }

  function clearGmgnFillMarkers() {
    gmgnMarkerQueue = [];
    if (gmgnMarkerTimer) { clearTimeout(gmgnMarkerTimer); gmgnMarkerTimer = null; }
    for (const handle of gmgnShapes.splice(0)) removeShapeHandle(handle);
  }

  function syncGmgnAverageLines() {
    if (!gmgnLineSpec || !gmgnLineSpec.enabled) {
      clearGmgnAverageLines();
      return true;
    }
    const chart = findGmgnChart();
    if (!chart) return false;
    if (gmgnChart && gmgnChart !== chart) { clearLineSlot(gmgnBuySlot); clearLineSlot(gmgnSellSlot); }
    gmgnChart = chart;
    const buyOk = syncLineSlot(gmgnBuySlot, chart, gmgnLineSpec.avgBuyMcap, gmgnLineSpec.avgBuyText || 'PT Avg Buy', '#34D399');
    const sellOk = syncLineSlot(gmgnSellSlot, chart, gmgnLineSpec.avgSellMcap, gmgnLineSpec.avgSellText || 'PT Avg Sell', '#FF5F56');
    return buyOk && sellOk;
  }

  function retryGmgnAverageLines() {
    if (gmgnRetryTimer) clearTimeout(gmgnRetryTimer);
    let attempts = 0;
    const retry = () => {
      gmgnRetryTimer = null;
      if (syncGmgnAverageLines() || ++attempts >= 30) return;
      gmgnRetryTimer = setTimeout(retry, 500);
    };
    retry();
  }

  function refreshPadreMarks() {
    let refreshed = false;
    for (const chart of getRankedCharts()) {
      try {
        if (typeof chart.clearMarks === 'function') chart.clearMarks();
        if (typeof chart.refreshMarks === 'function') {
          chart.refreshMarks();
          refreshed = true;
        }
      } catch (_) { /* a booting chart may refuse; others still refresh */ }
    }
    return refreshed;
  }

  function patchPadreWidget() {
    const widgets = findTradingViewWidgets();
    if (!widgets.length) return false;

    // Axiom keeps more than one live widget (a visible chart plus a preload).
    // Patch every datafeed so bars and marks flow no matter which instance the
    // site promotes to the foreground.
    let bars = false;
    let marks = false;
    let newlyPatched = false;
    for (const widget of widgets) {
      const datafeed = getPadreDatafeed(widget);
      if (!datafeed) continue;
      const barsWerePatched = Boolean(datafeed.subscribeBars && datafeed.subscribeBars[PATCHED]);
      const marksWerePatched = Boolean(datafeed.getMarks && datafeed.getMarks[PATCHED]);
      const b = patchPadreBars(datafeed);
      const m = patchPadreMarks(datafeed);
      newlyPatched = newlyPatched || (!barsWerePatched && b) || (!marksWerePatched && m);
      bars = bars || b;
      marks = marks || m;
    }

    const widget = widgets[0];
    const changedWidget = widget !== lastWidget;
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
      if (paperMarks.length) ensureMarksRender();
    }
    return bars && marks;
  }

  function handleContentMessage(event) {
    if (event.source !== window || !event.data || event.data.source !== IN_TAG) return;
    const { type, payload } = event.data;

    if (type === 'paper-axis') {
      // The page's resolved token identity: ticks, exports and drawing are
      // only taken from the chart whose symbol contains one of these needles.
      setCurrentSymbolNeedles(payload);
      return;
    }

    if (type === 'row-scan') {
      scanScreenerRows(payload);
      return;
    }

    if (type === 'row-buy-done') {
      for (const entry of rowChips.values()) entry.el.classList.remove('busy');
      return;
    }

    if (type === 'gmgn-marker') {
      const ok = addGmgnFillMarker(payload);
      emit('gmgn-lines-status', { action: 'marker', ok });
      return;
    }

    if (type === 'gmgn-marker-clear') {
      clearGmgnFillMarkers();
      emit('gmgn-lines-status', { action: 'marker-clear', ok: true });
      return;
    }

    if (type === 'gmgn-lines-clear') {
      gmgnLineSpec = null;
      clearGmgnAverageLines();
      clearGmgnFillMarkers();
      emit('gmgn-lines-status', { action: 'clear', ok: true });
      return;
    }

    if (type === 'gmgn-lines') {
      gmgnLineSpec = {
        enabled: Boolean(payload && payload.enabled),
        avgBuyMcap: numberValue(payload && payload.avgBuyMcap),
        avgSellMcap: numberValue(payload && payload.avgSellMcap),
        avgBuyText: typeof (payload && payload.avgBuyText) === 'string' ? payload.avgBuyText : 'PT Avg Buy',
        avgSellText: typeof (payload && payload.avgSellText) === 'string' ? payload.avgSellText : 'PT Avg Sell',
      };
      retryGmgnAverageLines();
      return;
    }

    if (type === 'paper-lines-clear') {
      paperLineSpec = null;
      clearPaperAverageLines();
      emit('paper-lines-status', { action: 'clear', ok: true });
      return;
    }

    if (type === 'paper-lines') {
      paperLineSpec = {
        enabled: Boolean(payload && payload.enabled),
        axisBasis: typeof (payload && payload.axisBasis) === 'string' ? payload.axisBasis : null,
        currentPriceNative: numberValue(payload && payload.currentPriceNative),
        currentPriceUsd: numberValue(payload && payload.currentPriceUsd),
        avgBuyUsd: numberValue(payload && payload.avgBuyUsd),
        avgSellUsd: numberValue(payload && payload.avgSellUsd),
        avgBuyMcap: numberValue(payload && payload.avgBuyMcap),
        avgSellMcap: numberValue(payload && payload.avgSellMcap),
        avgBuyNative: numberValue(payload && payload.avgBuyNative),
        avgSellNative: numberValue(payload && payload.avgSellNative),
        avgBuyMcapNative: numberValue(payload && payload.avgBuyMcapNative),
        avgSellMcapNative: numberValue(payload && payload.avgSellMcapNative),
      };
      patchPadreWidget();
      const synced = syncPaperAverageLines();
      emit('paper-lines-status', {
        action: 'sync',
        ok: synced,
        buyVisible: Boolean(averageFillSlot.adapter || averageFillSlot.pending),
        sellVisible: Boolean(averageExitSlot.adapter || averageExitSlot.pending),
      });
      return;
    }

    if (type === 'paper-marker-clear') {
      paperMarks = [];
      paperMarkLevels.clear();
      clearShapeFallback();
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
      const markNative = numberValue(payload.priceNative);
      const markUsd = numberValue(payload.priceUsd);
      const markMcap = numberValue(payload.mcap);
      paperMarkLevels.set(mark.id, {
        side: payload.side === 'sell' ? 'sell' : 'buy',
        native: markNative,
        usd: markUsd,
        mcap: markMcap,
        nativeMcap: markMcap && markUsd && markNative ? markMcap * (markNative / markUsd) : null,
      });
      if (paperMarks.length > MAX_MARKS) {
        for (const dropped of paperMarks.slice(0, paperMarks.length - MAX_MARKS)) {
          paperMarkLevels.delete(dropped.id);
          const handle = fallbackShapeHandles.get(dropped.id);
          if (handle) { removeShapeHandle(handle); fallbackShapeHandles.delete(dropped.id); }
        }
        paperMarks = paperMarks.slice(-MAX_MARKS);
      }
      patchPadreWidget();
      const refreshed = refreshPadreMarks();
      ensureMarksRender();
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

  /* ---------------- screener row chips (Axiom Pulse) ----------------
   *
   * Rows without an address link identify their token only through the row
   * component's React props — and fibers are visible exclusively in the MAIN
   * world, so this lives here. Chips forward their tap back to the content
   * script, which owns the fill pipeline.
   *
   * CRITICAL: chips NEVER enter the page's own DOM tree. Inserting foreign
   * nodes into React-managed containers corrupts reconciliation — on Axiom
   * Pulse (rows re-render every second) that crashed the whole list into an
   * error-boundary skeleton state. Instead every chip lives in a private
   * fixed overlay layer on <body> and is positioned over its row from the
   * row's bounding rect.
   */

  const ROW_ADDR_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/;

  let rowChipLayer = null;
  const rowChips = new Map(); // row element -> { el, address, place }

  function ensureRowChipLayer() {
    if (rowChipLayer && rowChipLayer.isConnected) return rowChipLayer;
    rowChipLayer = document.getElementById('pt-rowbuy-layer');
    if (!rowChipLayer) {
      rowChipLayer = document.createElement('div');
      rowChipLayer.id = 'pt-rowbuy-layer';
      (document.body || document.documentElement).appendChild(rowChipLayer);
    }
    return rowChipLayer;
  }

  /* Chip taps are handled at the WINDOW capture phase: these sites install
   * their own capturing click handlers that stop propagation (Padre does),
   * so a listener on the chip itself never fires. The bridge runs at
   * document_start — its window listener registers before any page script,
   * so it always sees the event first. Press events are swallowed too so
   * the row underneath never navigates from a chip tap.
   */
  function handleRowChipTap(ev) {
    const target = ev.target;
    const chip = target && target.closest ? target.closest('.pt-rowbuy') : null;
    if (!chip) return;
    ev.preventDefault();
    ev.stopPropagation();
    ev.stopImmediatePropagation();
    if (ev.type !== 'click') return;
    for (const entry of rowChips.values()) {
      if (entry.el === chip) {
        chip.classList.add('busy');
        emit('row-buy', { address: entry.address });
        break;
      }
    }
  }
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click']) {
    window.addEventListener(type, handleRowChipTap, true);
  }

  function positionRowChip(entry) {
    const { row, el, place } = entry;
    if (!row.isConnected) return false;
    const rect = row.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10 ||
        rect.bottom < 0 || rect.top > window.innerHeight ||
        rect.right < 0 || rect.left > window.innerWidth) {
      el.style.display = 'none';
      return true;
    }
    // Occlusion: rows scroll inside their own panes — when a row slides
    // under a sticky header the fixed-layer chip must vanish with it.
    const probeY = Math.min(Math.max(rect.top + rect.height / 2, 1), window.innerHeight - 1);
    const probeX = Math.min(Math.max(rect.left + rect.width * 0.35, 1), window.innerWidth - 1);
    const hit = document.elementFromPoint(probeX, probeY);
    if (hit && hit !== el && !row.contains(hit) && !el.contains(hit)) {
      el.style.display = 'none';
      return true;
    }
    el.style.display = '';

    let anchor = null; // { x, y, align }
    if (place.mode === 'before-buy-button') {
      let pill = entry.pill;
      if (pill && pill.isConnected) {
        // A cached pill must still sit in this row's column — rows get
        // recycled and a stale pill would drag the chip onto another card.
        const r = pill.getBoundingClientRect();
        if (!(r.width > 0 && r.right > rect.left && r.left < rect.right &&
              r.bottom > rect.top - 8 && r.top < rect.bottom + 44)) pill = null;
      } else {
        pill = null;
      }
      if (!pill) {
        // The pill can live just OUTSIDE the detected row container (Padre
        // renders it in a sibling strip below the card body), so widen the
        // search up two ancestors but only accept buttons overlapping the
        // row's own column — never a neighbour card's pill.
        const matches = (scope) => [...scope.querySelectorAll('button')].filter((b) => {
          if (!place.pattern.test((b.textContent || '').trim())) return false;
          const r = b.getBoundingClientRect();
          return r.width > 0 && r.height > 0 &&
            r.right > rect.left && r.left < rect.right &&
            r.bottom > rect.top - 8 && r.top < rect.bottom + 44;
        });
        pill = matches(row)[0] || null;
        for (let up = row.parentElement, i = 0; !pill && up && i < 2; up = up.parentElement, i += 1) {
          pill = matches(up)[0] || null;
        }
        entry.pill = pill;
      }
      if (pill) {
        const pr = pill.getBoundingClientRect();
        anchor = { x: pr.left - 6, y: pr.top + pr.height / 2, align: 'right-center' };
      } else {
        anchor = { x: rect.right - 6, y: rect.bottom - 6, align: 'right-bottom' };
      }
    } else if (place.mode === 'badge') {
      // Straddling the card's top-right edge: half in the row gutter, half
      // over the card's own top padding — clear of the MC/stat text.
      anchor = { x: rect.right - 8, y: rect.top, align: 'right-center' };
    } else {
      anchor = { x: rect.right - 6, y: rect.top + 6, align: 'right-top' };
    }

    el.style.left = anchor.x + 'px';
    el.style.top = anchor.y + 'px';
    const size = Number(entry.size) > 0 ? entry.size : 1;
    el.style.transformOrigin = anchor.align === 'right-center' ? '100% 50%'
      : anchor.align === 'right-bottom' ? '100% 100%'
      : '100% 0%';
    el.style.transform = (anchor.align === 'right-center' ? 'translate(-100%, -50%)'
      : anchor.align === 'right-bottom' ? 'translate(-100%, -100%)'
      : 'translate(-100%, 0)') + ' scale(' + size + ')';
    return true;
  }

  function sweepRowChips() {
    for (const [row, entry] of rowChips) {
      if (!row.isConnected || !positionRowChip(entry)) {
        entry.el.remove();
        rowChips.delete(row);
      }
    }
  }

  let rowChipRaf = 0;
  function scheduleRowChipReposition() {
    if (rowChipRaf || !rowChips.size) return;
    rowChipRaf = requestAnimationFrame(() => {
      rowChipRaf = 0;
      sweepRowChips();
    });
  }
  window.addEventListener('scroll', scheduleRowChipReposition, { capture: true, passive: true });
  window.addEventListener('resize', scheduleRowChipReposition, { passive: true });
  // Screener lists churn hard (New Pairs shifts every row down each time a
  // token lands) — chips must chase their rows the moment the DOM moves,
  // not on the next 350ms scan, or they visibly trail onto the wrong row.
  let rowChipObserver = null;
  function ensureRowChipObserver() {
    if (rowChipObserver || !document.body) return;
    rowChipObserver = new MutationObserver(scheduleRowChipReposition);
    rowChipObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  }
  // SPA navigation away from the list unmounts the rows without another
  // row-scan ever firing — this sweep is what clears the orphaned chips.
  setInterval(() => { if (rowChips.size) sweepRowChips(); }, 1000);
  // Read-only diagnostics for E2E tooling (no page code can reach the map).
  try {
    Object.defineProperty(window, '__ptRowChipDebug', {
      value: () => [...rowChips.values()].map((e) => ({
        address: e.address,
        mode: e.place.mode,
        hasPill: Boolean(e.pill),
        display: e.el.style.display,
        rowRect: e.row.isConnected ? (({ x, y, width, height }) => ({
          x: Math.round(x), y: Math.round(y), w: Math.round(width), h: Math.round(height) }))(e.row.getBoundingClientRect()) : null,
      })),
      configurable: true,
    });
  } catch (_) { /* diagnostics only */ }

  function addressFromRowFiber(row) {
    try {
      const key = Object.getOwnPropertyNames(row).find((k) => k.indexOf('__reactFiber$') === 0);
      const start = key && row[key];
      if (!start) return null;
      const seen = new Set();
      const stack = [start];
      let steps = 0;
      let best = null;
      const consider = (value, keyName) => {
        // The WHOLE value must be one base58 address: substring matches let
        // EVM rows (0x…) and IPFS image CIDs sneak in as fake Solana mints.
        if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return;
        if (!/address|pair|token|mint|\bca\b/i.test(keyName)) return;
        if (/image|img|logo|icon|uri|url|banner/i.test(keyName)) return;
        const score = /pair/i.test(keyName) ? 3 : /token|mint/i.test(keyName) ? 2 : 1;
        if (!best || score > best.score) best = { address: value, score };
      };
      const walk = (obj, depth) => {
        if (!obj || typeof obj !== 'object' || depth > 3) return;
        for (const [k, v] of Object.entries(obj)) {
          consider(v, k);
          if (v && typeof v === 'object') walk(v, depth + 1);
        }
      };
      while (stack.length && steps++ < 80) {
        const fiber = stack.pop();
        if (!fiber || seen.has(fiber)) continue;
        seen.add(fiber);
        walk(fiber.memoizedProps, 0);
        walk(fiber.memoizedState, 0);
        if (best && best.score >= 3) break;
        if (fiber.child) stack.push(fiber.child);
        if (fiber.sibling) stack.push(fiber.sibling);
      }
      return best ? best.address : null;
    } catch (_) {
      return null;
    }
  }

  function findRowContainer(anchor) {
    let node = anchor;
    for (let i = 0; i < 9 && node && node.parentElement; i++) {
      node = node.parentElement;
      const rect = node.getBoundingClientRect();
      if (rect.height >= 55 && rect.height <= 190 && rect.width >= 380) return node;
      if (rect.height >= 55 && rect.height <= 190 && rect.width >= 300) return node;
    }
    return null;
  }

  function scanScreenerRows(spec) {
    const amount = numberValue(spec && spec.amount) || 0.1;
    const size = Math.max(0.6, Math.min(1.5, numberValue(spec && spec.size) || 1));
    const selectors = spec && Array.isArray(spec.linkSelectors) ? spec.linkSelectors : [];
    const groupRows = spec && spec.containerMode === 'group';
    const beforeButton = spec && spec.placement === 'before-buy-button';
    const rows = new Map(); // row/card element -> address

    for (const selector of selectors) {
      let anchors;
      try { anchors = document.querySelectorAll(selector); } catch (_) { continue; }
      for (const anchor of anchors) {
        const match = String(anchor.getAttribute('href') || '').match(ROW_ADDR_RE);
        if (!match) continue;
        // Axiom Pulse rows carry the stable `group` class — matching it
        // exactly keeps chips out of page chrome.
        const row = groupRows ? anchor.closest('div.group') : findRowContainer(anchor);
        if (row && !rows.has(row)) rows.set(row, match[0]);
      }
    }

    // Rows/cards with no address link at all: the identity lives in React
    // props. Enumerate siblings of known rows (same list container), plus
    // Axiom's div.group rows directly.
    const candidates = new Set();
    if (groupRows) {
      let groups;
      try { groups = document.querySelectorAll('div.group'); } catch (_) { groups = []; }
      for (const g of groups) {
        const rect = g.getBoundingClientRect();
        if (rect.height >= 40 && rect.height <= 160 && rect.width >= 380) candidates.add(g);
      }
    } else {
      // Cousin cards too: on Padre an anchor-found row is a card's BODY,
      // buried inner-twin > wrapper > wrapper > list — climb until the
      // ancestors include the container whose children are sibling cards.
      const parents = new Set();
      for (const row of [...rows.keys(), ...rowChips.keys()]) {
        let p = row.parentElement;
        for (let i = 0; p && i < 5; i += 1, p = p.parentElement) parents.add(p);
      }
      for (const parent of parents) {
        for (const card of parent.children) {
          const rect = card.getBoundingClientRect();
          if (rect.height >= 55 && rect.height <= 190 && rect.width >= 300) candidates.add(card);
        }
      }
    }
    const isNested = (a, b) => a === b || a.contains(b) || b.contains(a);
    const staleAt = Date.now() - 3000;
    for (const row of candidates) {
      if (rows.has(row)) continue;
      const chipped = rowChips.get(row);
      if (chipped && chipped.verifiedAt > staleAt) continue;
      if (!chipped) {
        // A card and its inner body both look like rows — one chip only.
        let nested = false;
        for (const other of rows.keys()) if (isNested(other, row)) { nested = true; break; }
        if (!nested) {
          for (const other of rowChips.keys()) {
            if (other.isConnected && isNested(other, row)) { nested = true; break; }
          }
        }
        if (nested) continue;
      }
      // Fresh row, or a recycled element that may now show a different
      // token: (re-)read the address from the row's React props.
      const address = addressFromRowFiber(row);
      if (address) rows.set(row, address);
      else if (chipped) { chipped.el.remove(); rowChips.delete(row); }
    }

    let pattern;
    try { pattern = new RegExp((spec && spec.buyButtonPattern) || '^Buy\\s', 'i'); } catch (_) { pattern = /^Buy\s/i; }
    const layer = ensureRowChipLayer();
    ensureRowChipObserver();

    const now = Date.now();
    for (const [row, address] of rows) {
      const existing = rowChips.get(row);
      if (existing) {
        existing.address = address;
        existing.verifiedAt = now;
        existing.size = size;
        continue;
      }

      const button = document.createElement('button');
      button.className = 'pt-rowbuy';
      button.type = 'button';
      button.textContent = `P ${amount}`;
      button.title = `PaperTrench: paper-buy ${amount} SOL of this token right now`;
      const entry = {
        row,
        el: button,
        address,
        pill: null,
        verifiedAt: now,
        size,
        place: { mode: beforeButton ? 'before-buy-button' : (spec && spec.placement) || 'float', pattern },
      };
      // Taps are handled by the window-level capture listener above — a
      // listener on the chip itself never fires on sites that stop
      // propagation during capture.
      layer.appendChild(button);
      rowChips.set(row, entry);
      positionRowChip(entry);
    }

    sweepRowChips();
  }

  /* ---------------- chart-export price peg ----------------
   *
   * The subscribeBars hook only sees bars for subscriptions created AFTER the
   * patch. On Axiom the widget is unreachable until React mounts, by which
   * time the chart has already subscribed — so no live bars ever flow and the
   * displayed price (and unrealized P&L) drifted to slower fallback sources.
   *
   * The fix reads the newest close directly off the site's own chart via the
   * public `exportData()` API. That value IS the chart the user is looking
   * at, which is exactly what the P&L must be pegged to. The poll suspends
   * itself whenever real live bars are flowing or the tab is hidden.
   */
  const CHART_EXPORT_POLL_MS = 700;
  // exportData() called before the chart has a series can stay pending
  // FOREVER (observed on GMGN during page boot). The in-flight guard
  // therefore expires, and a sequence number disarms the stale promise so a
  // years-late resolution cannot publish an outdated close.
  const EXPORT_STUCK_MS = 5000;
  let lastExportedClose = 0;
  let exportStartedAt = 0;
  let exportSeq = 0;

  function pollChartClose() {
    const now = Date.now();
    if (exportStartedAt && now - exportStartedAt < EXPORT_STUCK_MS) return;
    if (now - lastLiveBarAt < 1500) return; // live bars own the peg
    try { if (document.hidden) return; } catch (_) {}
    // Only the chart showing THIS page's token may set the price — a preload
    // chart for another token must not.
    const charts = getRankedCharts();
    const chart = currentSymbolNeedles.length
      ? charts.find((c) => chartSymbolMatches(c))
      : charts[0];
    if (!chart || typeof chart.exportData !== 'function') return;

    let exported;
    try {
      exported = chart.exportData({
        from: Math.floor(now / 1000) - 600,
        includeTime: true,
        includedStudies: [],
      });
    } catch (_) { return; }

    exportStartedAt = now;
    const seq = ++exportSeq;
    Promise.resolve(exported).then((result) => {
      if (seq !== exportSeq) return; // superseded by a newer poll
      exportStartedAt = 0;
      // A live bar may have arrived while the export was in flight; the
      // subscription feed always outranks a polled snapshot.
      if (Date.now() - lastLiveBarAt < 1500) return;
      const rows = result && Array.isArray(result.data) ? result.data : null;
      if (!rows || !rows.length) return;
      const schema = Array.isArray(result.schema) ? result.schema : null;
      let closeIndex = 4; // TradingView default: [time, open, high, low, close]
      if (schema) {
        const found = schema.findIndex((f) => f && (f === 'close' || f.plotTitle === 'close' || f.sourceTitle === 'close'));
        if (found >= 0) closeIndex = found;
      }
      // Rows come back as Float64Array (not Array), so index access only.
      const lastRow = rows[rows.length - 1];
      const close = numberValue(lastRow ? lastRow[closeIndex] : null);
      if (!(close > 0) || close === lastExportedClose) return;
      lastExportedClose = close;
      lastBarClose = close;
      emit('tick', {
        candidates: [{ value: close, unit: 'unknown', key: 'chartExportClose' }],
        mcap: close,
        mint: currentSymbolInfo.mint,
        symbol: currentSymbolInfo.symbol,
        name: null,
        source: 'chart-export',
      });
    }, () => { if (seq === exportSeq) exportStartedAt = 0; });
  }

  setInterval(pollChartClose, CHART_EXPORT_POLL_MS);

  // The bridge is installed before Padre creates window.tvWidget. Check
  // frequently during startup so subscribeBars is wrapped before the chart
  // subscribes, then continue at a low cadence to catch SPA widget replacement.
  let fastChecks = 0;
  const fastTimer = setInterval(() => {
    fastChecks += 1;
    if (patchPadreWidget() || fastChecks >= 500) clearInterval(fastTimer);
  }, 10);
  setInterval(() => {
    patchPadreWidget();
    // GMGN's chart manager mounts late and is remounted on SPA navigation;
    // recreate any average line that is expected but not on the chart yet.
    if (gmgnLineSpec && gmgnLineSpec.enabled && !gmgnRetryTimer) {
      const buyMissing = Number(gmgnLineSpec.avgBuyMcap) > 0 && !gmgnBuySlot.adapter && !gmgnBuySlot.pending;
      const sellMissing = Number(gmgnLineSpec.avgSellMcap) > 0 && !gmgnSellSlot.adapter && !gmgnSellSlot.pending;
      if (buyMissing || sellMissing) syncGmgnAverageLines();
    }
    if (gmgnMarkerQueue.length && !gmgnMarkerTimer) scheduleGmgnMarkerDrain();
    // Shape-mode fills that could not draw yet (chart still booting, or the
    // site swapped to a fresh chart instance) are retried here.
    if (shapeFallbackActive && paperMarks.length && fallbackShapeHandles.size < paperMarks.length) {
      drawShapeFallback();
    }
  }, 1000);

  emit('ready', { href: location.href, phase: 'document-start', version: 4 });
})();
