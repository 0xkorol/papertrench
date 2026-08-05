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
  // Upper bound on frames the generic path will JSON.parse. Parse cost at
  // this size is ~10-20 ms occasionally; the collector walk is separately
  // bounded by NODE_BUDGET, so bigger frames cannot runaway the main thread.
  const FRAME_GUARD_BYTES = 2_000_000;
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
  // F-35: closes tracked PER live subscription. The C-14 token gate keeps
  // other tokens out of lastBarClose, but the SAME token can stream in two
  // units at once (price-mode and mcap-mode charts in a Padre multichart
  // layout, or across a mode toggle) — and those closes differ by the supply
  // factor. Level math must pick a close in the axis's own unit, never
  // "whichever series ticked last".
  const barCloseLedger = new Map(); // subscriberUID -> { close, atMs }
  const BAR_CLOSE_FRESH_MS = 15_000;
  // Chart time (seconds) of the newest live bar — paper shapes/marks clamp to
  // it so a fill can never render ahead of the final candle (F-31).
  let lastBarTimeSec = 0;
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
    // A new token means the old bar close is no longer a valid axis hint —
    // and the export dedupe must forget the old token's close, or the first
    // poll on the new token can be swallowed as "unchanged" (DEFECT F-19).
    // The GMGN candle close is the same class of per-token evidence (C-08).
    if (changed) { lastBarClose = 0; lastBarTimeSec = 0; lastExportedClose = 0; gmgnLastCandleClose = 0; barCloseLedger.clear(); }
  }
  // GMGN runs a private TradingView widget inside a same-origin blob iframe.
  // Its live React chart manager exposes `getActiveChart().createOrderLine()`.
  let gmgnChart = null;
  let gmgnLineSpec = null;
  let gmgnRetryTimer = null;
  // DEFECT C-08: the newest close from GMGN's own mcap-candle feed. GMGN's
  // cap definition can differ from the resolver's (circulating vs total,
  // migrated coins) by a constant factor; this close is the ground truth for
  // what GMGN's Y axis actually shows, so lines and fill shapes are scaled
  // through it rather than trusting resolver-implied supply. Reset per token.
  let gmgnLastCandleClose = 0;

  /* ---------------- content-script liveness (DEFECTS O-04/C-17) ----------
   * The MAIN world cannot observe extension death, so the bridge watches for
   * SILENCE instead: every content-script message refreshes this stamp (the
   * overlay also sends a 30 s 'bridge-ping' while enabled). After 5 minutes
   * without any message the 1 s sweep stops re-asserting lines/marks — a
   * dead extension must not keep repainting a frozen level forever. An
   * explicit 'standdown' message (overlay disabled, extension teardown)
   * clears everything immediately and silences the sweep at once.
   */
  const CONTENT_SILENCE_LIMIT_MS = 5 * 60_000;
  let lastContentMessageAt = Date.now();

  /* ---------------- feed demand gate (Turbo) ------------------------------
   * Parsing is the bridge's whole main-thread cost, and most of the frames it
   * parses have no consumer: ticks feed exactly (a) the page's resolved token
   * and (b) screener row chips. On every other page — wallet, portfolio,
   * settings, a list page with chips disabled — every clone().text() and
   * JSON.parse is pure jank donated to the host site. The content script
   * publishes whether any consumer exists ('page-state'); with none, frames
   * are dropped BEFORE the body copy and the parse, not after.
   *
   * The boot default is TRUE: the bridge runs at document_start, the content
   * script at document_idle, and the first tick of a brand-new coin must not
   * be lost to a gate that nobody has evaluated yet. Silence (the O-04/C-17
   * stamp) still wins over a stale TRUE: a dead extension stops costing the
   * page within CONTENT_SILENCE_LIMIT_MS no matter what it last said, and
   * 'standdown' backdates that stamp so the master switch stops the parsing
   * the instant it is thrown, not five minutes later.
   */
  let feedWanted = true;

  function feedActive() {
    return feedWanted && Date.now() - lastContentMessageAt <= CONTENT_SILENCE_LIMIT_MS;
  }

  /* DEFECT F-26: the widget sweep must not scan forever on sites that never
   * mount a TradingView chart. After WIDGET_SWEEP_MISS_LIMIT consecutive
   * empty scans (~1 minute at the 1 s cadence) it drops to a 10 s cadence;
   * a discovered widget or a fresh paper-axis/paper-lines message returns it
   * to the fast cadence.
   */
  const WIDGET_SWEEP_MISS_LIMIT = 60;
  const WIDGET_SWEEP_SLOW_EVERY = 10;
  let widgetSweepMisses = 0;
  let lastWidgetScanFound = false;

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
  // avgPrice is deliberately ABSENT: it is a position-average field, not a
  // live price. When the user holds a REAL position, the site streams their
  // real entry average under that key, and treating it as a market tick let
  // the user's own entry price pollute the paper feed (DEFECT F-30 — the
  // average line "blended" a real buy with the paper buy).
  const PRICE_KEY = /^(price|priceNative|priceUsd|priceInSol|priceSol|solPrice|usdPrice|tokenPrice|lastPrice|last|close|c|markPrice|currentPrice|quote)$/i;
  // Subtrees that describe the USER'S OWN holdings, not the market. Prices
  // inside them are historical facts about the user (entry averages, cost
  // bases, unrealized P&L) and must never become market-price candidates.
  const POSITION_SUBTREE_KEY = /^(positions?|holdings?|portfolio|userPositions?|myPositions?|openOrders?)$/i;
  const MCAP_KEY = /^(marketCap|marketCapInUsd|mcap|mcapInUsd|fdv|fullyDilutedValuation)$/i;
  // A record that IS a trade event — an id-carrying or user-attributed
  // swap/trade object (fomo's social feed, tx-hash trade tapes). Its price
  // and cap fields describe the moment that trade happened, minutes to
  // HOURS in the past, and must never tick the live price: F-30's "the
  // user's own average is not a market price", one layer out. Anonymous
  // live-tape pushes ({price, ts} with no id or attribution) stay eligible.
  const TRADE_EVENT_TYPE_RE = /^(swap|trade|buy|sell)/i;
  function looksLikeTradeEvent(node) {
    const type = node.type || node.eventType || node.txType;
    const typed = typeof type === 'string' && TRADE_EVENT_TYPE_RE.test(type);
    const hasEventId = typeof node.tradeId === 'string' || typeof node.txId === 'string'
      || typeof node.txHash === 'string' || typeof node.signature === 'string'
      || typeof node.transactionHash === 'string';
    const attributed = typeof node.userId === 'string' || typeof node.userHandle === 'string'
      || typeof node.displayName === 'string' || typeof node.maker === 'string';
    return (typed && (hasEventId || attributed)) || (hasEventId && attributed);
  }
  const MINT_KEY = /^(mint|tokenMint|tokenAddress|baseMint|address|contract|ca)$/i;
  const SYMBOL_KEY = /^(symbol|ticker|tokenSymbol|baseSymbol)$/i;
  const NAME_KEY = /^(name|tokenName|baseName)$/i;
  const USD_HINT = /usd|dollar/i;
  const NATIVE_HINT = /native|sol/i;

  // Traversal is bounded by a single global node budget rather than the old
  // per-array slice(0, 80): trade arrays are newest-LAST, so capping at the
  // front reported ever older prices exactly as batches grew with volume
  // (DEFECT F-03). The budget only bites on pathological frames.
  const NODE_BUDGET = 20_000;
  // Identifier strength: on several sites `address`/`ca` carry the AMM/pool
  // address rather than the token mint, so an explicit mint-ish key must win
  // the record association when both appear on one object.
  const MINT_KEY_STRONG = /^(mint|tokenMint|baseMint)$/i;
  const MINT_KEY_MEDIUM = /^(tokenAddress)$/i;
  function mintKeyRank(key) {
    if (MINT_KEY_STRONG.test(key)) return 3;
    if (MINT_KEY_MEDIUM.test(key)) return 2;
    if (MINT_KEY.test(key)) return 1;
    return 0;
  }

  function collect(obj) {
    // Prices are grouped by the token record they appear inside (DEFECT F-02).
    // A batched frame — screener list, multi-pair snapshot, trending payload —
    // carries many tokens; the old flattened walk attributed token B's price
    // to whichever mint happened to be seen first, and the accept band then
    // derived USD/mcap from that wrong ratio self-consistently. A node that
    // carries a mint-shaped identifier opens a record; every price / mcap /
    // symbol beneath it belongs to that token. Finds outside any record land
    // in `top` (frames with no identifier at all), which downstream
    // anchor-banding still validates before use.
    const records = new Map();
    const top = { candidates: [], mcap: null, mint: null, symbol: null, name: null };
    const seen = new WeakSet();
    let budget = NODE_BUDGET;

    const recordFor = (mint) => {
      let rec = records.get(mint);
      if (!rec) {
        rec = { candidates: [], mcap: null, mint, symbol: null, name: null };
        records.set(mint, rec);
      }
      return rec;
    };
    const pushCandidate = (rec, cand) => {
      // Ring, not cap: when a record overflows, keep the NEWEST candidates.
      if (rec.candidates.length >= MAX_CANDIDATES) rec.candidates.shift();
      rec.candidates.push(cand);
    };

    (function walk(node, depth, ctx, tainted) {
      if (!node || typeof node !== 'object' || depth > MAX_DEPTH || seen.has(node)) return;
      if (budget-- <= 0) return;
      seen.add(node);

      // Trade EVENTS taint their whole subtree exactly like position
      // subtrees do: identity fields still flow, prices and caps do not.
      if (!tainted && !Array.isArray(node) && looksLikeTradeEvent(node)) tainted = true;

      let target = ctx;
      if (!Array.isArray(node)) {
        let bestRank = 0;
        let bestMint = null;
        for (const [key, value] of Object.entries(node)) {
          if (typeof value !== 'string' || !BASE58_RE.test(value)) continue;
          const rank = mintKeyRank(key);
          if (rank > bestRank) { bestRank = rank; bestMint = value; }
        }
        if (bestMint) target = recordFor(bestMint);
      }

      const entries = Array.isArray(node)
        ? node.map((v, i) => [String(i), v])
        : Object.entries(node);

      for (const [key, value] of entries) {
        if (budget <= 0) return;
        if (value && typeof value === 'object') {
          // A subtree describing the user's own holdings is DATA ABOUT THE
          // USER, not the market: entry averages and cost bases inside it
          // must never tick the price (DEFECT F-30). Identity fields still
          // flow; prices and caps do not.
          walk(value, depth + 1, target, tainted || POSITION_SUBTREE_KEY.test(key));
          continue;
        }
        const rec = target || top;
        if (!tainted && PRICE_KEY.test(key)) {
          const n = numberValue(value);
          if (n > 0) {
            const unit = USD_HINT.test(key) ? 'usd' : NATIVE_HINT.test(key) ? 'native' : 'unknown';
            pushCandidate(rec, { value: n, unit, key });
          }
        } else if (!tainted && MCAP_KEY.test(key)) {
          const n = numberValue(value);
          if (n > 0 && rec.mcap === null) rec.mcap = n;
        } else if (SYMBOL_KEY.test(key) && typeof value === 'string' && value.length <= 24) {
          rec.symbol = rec.symbol || value;
        } else if (NAME_KEY.test(key) && typeof value === 'string' && value.length <= 64) {
          rec.name = rec.name || value;
        }
      }
    })(obj, 0, null, false);

    return { records, top };
  }

  // GMGN's realtime WebSocket publishes every venue trade on the
  // `token_activity` channel with terse keys: `a` = token mint, `pu` = trade
  // price in USD, `e` = buy/sell. The generic key scanner cannot see these
  // (`pu` matches no price pattern and `ca` is the AMM address, not the mint),
  // which left GMGN's live feed entirely unused — the extension fell back to
  // slow polling. Mint-tagged USD ticks let quote.js validate exactly.
  // The tick throttle is PER MINT, not global (DEFECT F-07). The old global
  // 100 ms gate ran before the batch was even inspected, so at high volume —
  // when inter-batch gaps fall under 100 ms — a batch of unrelated mints
  // silently discarded the NEXT batch, including the watched coin. That is
  // the same starvation class v1.2.14 fixed inside a single batch, one layer
  // up. Every batch is now parsed (a single cheap pass) and each mint keeps
  // its own emission clock.
  const ACTIVITY_TICK_MIN_MS = 100;
  const activityLastEmitByMint = new Map();

  function forwardTokenActivity(parsed) {
    if (!parsed || parsed.channel !== 'token_activity' || !Array.isArray(parsed.data)) return false;
    const now = Date.now();
    const latestByMint = new Map();
    for (const item of parsed.data) {
      if (!item || typeof item.a !== 'string' || !BASE58_RE.test(item.a)) continue;
      const priceUsd = numberValue(item.pu);
      if (priceUsd > 0) latestByMint.set(item.a, priceUsd);
    }
    if (!latestByMint.size) return true;
    // Emit the mint the user is actually looking at FIRST: under high volume a
    // batch carries many mints, and Map iteration order offers no guarantee
    // the watched coin makes the cut. Then top up with any others.
    let emitted = 0;
    const due = (mint) => now - (activityLastEmitByMint.get(mint) || 0) >= ACTIVITY_TICK_MIN_MS;
    const emitTick = (mint, priceUsd) => {
      activityLastEmitByMint.set(mint, now);
      emit('tick', {
        candidates: [{ value: priceUsd, unit: 'usd', key: 'tokenActivityPriceUsd' }],
        mcap: null,
        mint,
        symbol: currentSymbolInfo.mint === mint ? currentSymbolInfo.symbol : null,
        name: null,
        source: 'gmgn-ws-trade',
      });
    };
    const watchedMint = currentSymbolInfo.mint;
    if (watchedMint && latestByMint.has(watchedMint) && due(watchedMint)) {
      emitTick(watchedMint, latestByMint.get(watchedMint));
      emitted++;
    }
    for (const [mint, priceUsd] of latestByMint) {
      if (mint === watchedMint) continue;
      if (emitted >= 5) break;
      if (!due(mint)) continue;
      emitTick(mint, priceUsd);
      emitted++;
    }
    // Bound the per-mint clock map so a long trenches session cannot grow it
    // without limit; entries older than a few seconds are meaningless anyway.
    if (activityLastEmitByMint.size > 512) {
      for (const [mint, at] of activityLastEmitByMint) {
        if (now - at > 5000) activityLastEmitByMint.delete(mint);
        if (activityLastEmitByMint.size <= 256) break;
      }
    }
    return true;
  }

  function forwardJson(raw, source, url) {
    // No consumer, no parse — the cheapest frame is the one never read.
    if (!feedActive()) return;
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
      if (url && /\/api\/v1\/token_mcap_candles\//.test(url)) {
        // GMGN's market-cap candles ARE the chart feed on GMGN, and a hot
        // token's full history outgrows the generic guard — the exact failure
        // v1.2.14 fixed for the trade feed (DEFECT F-06). The URL match is
        // exact, so this is not a generic bypass.
        try { parsed = JSON.parse(raw); } catch (_) { return; }
      } else {
        // The guard bounds JSON.parse cost only — the collector walk itself
        // is bounded by NODE_BUDGET regardless of frame size. 500 KB silently
        // killed every non-GMGN site's trade feed at peak volume (F-06).
        if (raw.length > FRAME_GUARD_BYTES) return;
        if (trimmed[0] !== '{' && trimmed[0] !== '[') return;
        try { parsed = JSON.parse(raw); } catch (_) { return; }
      }
    }
    if (!parsed || typeof parsed !== 'object') return;

    if (forwardTokenActivity(parsed)) return;

    // GMGN's embedded TradingView chart is explicitly a market-cap chart:
    // /api/v1/token_mcap_candles/... returns USD market-cap OHLC values in
    // data.list[]. GMGN's iframe symbol is `<chain>/<mint>/USD/MCAP`, so its
    // `close` value is the exact Y-axis unit, never a token-price value.
    if (url && /\/api\/v1\/token_mcap_candles\//.test(url)) {
      // DEFECT C-26: the candle request names the chart's bar grid
      // (?resolution=1s/1m/...). Note it so GMGN fill markers snap to the
      // bar boundary exactly like the Padre/Axiom mark path does.
      const resMatch = /[?&]resolution=([0-9A-Za-z]+)/.exec(url);
      if (resMatch) noteResolution(resMatch[1]);
      const candles = parsed && parsed.data && Array.isArray(parsed.data.list) ? parsed.data.list : [];
      const last = candles[candles.length - 1];
      const mcap = last && numberValue(last.close);
      if (mcap > 0) {
        // C-08: this close IS the value on GMGN's Y axis — the scale anchor
        // for every GMGN line and fill shape (see gmgnCapScale).
        gmgnLastCandleClose = mcap;
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

    const { records, top } = collect(parsed);
    const hasContent = (rec) => rec.candidates.length || rec.mcap !== null;
    if (records.size) {
      // Watched token first — the GMGN fast-path contract, now generic — then
      // a bounded top-up so screener row chips keep their mint-tagged prices.
      const watched = (currentSymbolInfo.mint && records.get(currentSymbolInfo.mint))
        || (currentSymbolInfo.pairAddress && records.get(currentSymbolInfo.pairAddress))
        || null;
      let emitted = 0;
      if (watched && hasContent(watched)) { emit('tick', { ...watched, source }); emitted++; }
      for (const rec of records.values()) {
        if (rec === watched || !hasContent(rec)) continue;
        if (emitted++ >= 5) break;
        emit('tick', { ...rec, source });
      }
      if (emitted) return;
      // Records existed but carried no prices; fall through to the
      // unattributed finds so a lone top-level price still ticks.
    }
    if (!top.candidates.length && top.mcap === null) return;
    emit('tick', { ...top, source });
  }

  /* ---------------- SPA navigation signal ----------------
   * Every supported site is an SPA, and the content script's only navigation
   * signal used to be an 800 ms URL poll — so the previous token's live panel
   * and chart lines lingered on the new page for up to a tick (DEFECT O-14).
   * Programmatic pushState/replaceState is invisible to the isolated world,
   * so the hook lives here and posts a nav event the moment the route
   * changes. popstate/hashchange are visible to both worlds and the content
   * script listens for those itself.
   */
  try {
    const notifyNav = () => emit('nav', { href: location.href });
    const origPush = history.pushState;
    history.pushState = function (...args) { const r = origPush.apply(this, args); notifyNav(); return r; };
    const origReplace = history.replaceState;
    history.replaceState = function (...args) { const r = origReplace.apply(this, args); notifyNav(); return r; };
  } catch (_) {}

  /* ---------------- early generic transport interception ---------------- */

  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function (...args) {
      const promise = originalFetch.apply(this, args);
      const input = args[0];
      const requestUrl = typeof input === 'string' ? input : (input && input.url) || '';
      promise.then((response) => {
        try {
          // Gate BEFORE the clone: response.clone().text() materializes a
          // second copy of the body on the page's main thread, which is most
          // of this tap's cost. With no tick consumer the copy never happens.
          if (!feedActive()) return;
          const type = response.headers && response.headers.get('content-type');
          if (type && !/json/i.test(type)) return;
          const finalUrl = response.url || requestUrl;
          // Bodies the parse guard would drop anyway are not worth copying.
          // The GMGN mcap-candles route is the one audited fetch/XHR path
          // allowed past the guard (F-06), so it alone skips this pre-gate.
          const length = Number(response.headers && response.headers.get('content-length'));
          if (length > FRAME_GUARD_BYTES && !/\/api\/v1\/token_mcap_candles\//.test(finalUrl)) return;
          response.clone().text().then((text) => forwardJson(text, 'fetch', finalUrl), () => {});
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
  //
  // GMGN is the ONLY audited site that carries prices this way (per-site
  // matrix, DEFECTS.md), and this wrapper is the one tap with a side effect —
  // port.start() — on an object the host site owns. Other sites keep their
  // native SharedWorker untouched.
  const OriginalSharedWorker = window.SharedWorker;
  const bridgeHostname = (() => {
    try { return location.hostname || new URL(location.href).hostname; } catch (_) { return ''; }
  })();
  const hostUsesSharedWorkerFeed = /(^|\.)gmgn\.ai$/.test(bridgeHostname);
  if (typeof OriginalSharedWorker === 'function' && hostUsesSharedWorkerFeed) {
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

  function emitPadreBar(bar, resolution, subscriberUID) {
    if (!bar || typeof bar !== 'object') return;
    const close = numberValue(bar.close);
    if (!(close > 0)) return;
    lastBarClose = close;
    // F-35: remember which subscription produced this close so line/shape
    // level math can vet closes by unit instead of taking the newest global.
    if (subscriberUID != null) {
      barCloseLedger.set(String(subscriberUID), { close, atMs: Date.now() });
      if (barCloseLedger.size > 32) {
        const cutoff = Date.now() - BAR_CLOSE_FRESH_MS;
        for (const [uid, entry] of barCloseLedger) {
          if (entry.atMs < cutoff) barCloseLedger.delete(uid);
        }
      }
    }
    lastLiveBarAt = Date.now();
    // F-31: remember the newest bar's chart time so paper shapes/marks can be
    // clamped to it — a fill stamped milliseconds ahead of the last bar (feed
    // latency or clock skew on a 1 s chart) parked its bubble beyond the
    // final candle, floating at the right edge.
    const barTimeMs = Number(bar.time);
    if (barTimeMs > 0) lastBarTimeSec = barTimeMs > 1e12 ? Math.floor(barTimeMs / 1000) : Math.floor(barTimeMs);

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
      // DEFECT C-14: Axiom's hidden preload widget subscribes for OTHER
      // tokens (often at a different resolution); only the chart showing
      // THIS token may set the mark-snapping grid.
      // DEFECT F-29: this runs inside the HOST site's own subscribe call —
      // a PaperTrench throw here would break the site's chart, so the
      // preamble is contained and the host path always proceeds.
      try {
        if (barSymbolMatches(symbolInfo)) noteResolution(resolution);
      } catch (_) { /* our problem, never the host's */ }
      const wrappedCallback = (bar) => {
        // Bars for a different token's chart (Axiom preload) are still passed
        // to the site but must never move our price or axis detection.
        // F-29: the host's realtime callback MUST run whatever our
        // preamble does — a poisoned bar object or a future bug in
        // emitPadreBar must never kill the site's own chart feed.
        try {
          if (barSymbolMatches(symbolInfo)) emitPadreBar(bar, resolution, subscriberUID);
        } catch (_) { /* our problem, never the host's */ }
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
    if (/^\d+s$/i.test(s)) return parseInt(s, 10) * 1000;
    if (/^\d+$/.test(s)) return parseInt(s, 10) * 60_000;
    // DEFECT C-26: GMGN's candle URLs spell resolutions with lowercase unit
    // suffixes ('1m', '5m', '1h'). Lowercase m is minutes and must be read
    // BEFORE the uppercase-M month rule below.
    if (/^\d+m$/.test(s)) return parseInt(s, 10) * 60_000;
    if (/^\d+h$/i.test(s)) return parseInt(s, 10) * 3_600_000;
    // DEFECT C-14: TradingView sends BARE letters for daily/weekly/monthly
    // ('D', 'W', 'M'), where parseInt alone yields NaN — those charts kept a
    // stale lastResolutionMs and marks snapped to the wrong grid.
    if (/^\d*D$/i.test(s)) return (parseInt(s, 10) || 1) * 86_400_000;
    if (/^\d*W$/i.test(s)) return (parseInt(s, 10) || 1) * 604_800_000;
    if (/^\d*M$/.test(s)) return (parseInt(s, 10) || 1) * 2_592_000_000;
    return null;
  }

  function noteResolution(res) {
    const ms = resolutionToMs(res);
    if (!ms || ms === lastResolutionMs) return;
    lastResolutionMs = ms;
    // DEFECT C-14: marks were snapped ONCE at creation to the then-current
    // grid; a chart switched from 1s to 1m candles silently dropped them
    // (TradingView discards marks whose time is off the bar grid). Re-snap
    // every stored mark from its original fill timestamp and refresh.
    resnapPaperMarks();
  }

  function resnapPaperMarks() {
    if (!paperMarks.length) return;
    let moved = false;
    for (const mark of paperMarks) {
      if (!(mark._tsMs > 0)) continue;
      const snapped = snapMarkTime(mark._tsMs);
      if (snapped !== mark.time) { mark.time = snapped; moved = true; }
    }
    // noteResolution runs inside the HOST's subscribeBars/getMarks call —
    // defer the clear+refresh so a throwing chart cannot break the site's
    // own callback (the C-29 latent-hazard rule).
    if (moved) setTimeout(() => { try { refreshPadreMarks(); } catch (_) {} }, 0);
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
        // Original fill time, so a later resolution change can re-snap the
        // mark to the new bar grid instead of dropping it (C-14).
        _tsMs: Math.floor(tsMs),
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
      _tsMs: Math.floor(tsMs), // C-14: kept for re-snapping on resolution change
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
    // F-31: a mark stamped ahead of the newest bar clamps onto it — clamp
    // BEFORE the range filter so a "future" fill renders on the last candle
    // instead of silently not rendering at all.
    const clamp = (t) => (lastBarTimeSec > 0 && t > lastBarTimeSec ? lastBarTimeSec : t);
    return paperMarks
      .map((mark) => { const t = clamp(mark.time); return t === mark.time ? mark : { ...mark, time: t }; })
      .filter((mark) => mark.time >= lo && mark.time <= hi);
  }

  function patchPadreMarks(datafeed) {
    if (!datafeed || typeof datafeed.getMarks !== 'function') return false;
    if (datafeed.getMarks[PATCHED]) return true;

    const original = datafeed.getMarks;
    function getMarks(symbolInfo, from, to, onDataCallback, ...rest) {
      marksPipelineSeenAt = Date.now();
      // DEFECT F-29: everything PaperTrench does before handing control back
      // runs inside the HOST's own getMarks call — contained, so a throw in
      // our preamble can never break the site's chart.
      try {
        // C-14: same gate as subscribeBars — a preload chart's resolution must
        // never overwrite the visible chart's snapping grid.
        if (barSymbolMatches(symbolInfo)) noteResolution(rest[0]);
        // The library IS pulling marks — the native pipeline wins. If the
        // execution-shape fallback fired first (slow chart boot), hand
        // rendering back and remove the temporary shapes. Paper fills then
        // render as the site's own bubble marks (Axiom-styled on Axiom).
        if (shapeFallbackActive) {
          shapeFallbackActive = false;
          clearShapeFallback();
        }
      } catch (_) { /* our problem, never the host's */ }
      const mergedCallback = (siteMarks) => {
        const base = Array.isArray(siteMarks) ? siteMarks : [];
        // F-29: the host's data callback ALWAYS runs; if merging our marks
        // fails, the site still gets its own marks unharmed.
        let ours = [];
        try { ours = marksInRange(from, to); } catch (_) { ours = []; }
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
    // F-35: the slot always remembers the newest requested appearance. An
    // async createOrderLine that is still in flight configures itself from
    // HERE on resolve — not from the values captured when it was issued, or
    // a DCA that moved the average mid-creation drew at the old level.
    slot.want = { price: Number(price), label, color };
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
          // F-35: configure from the slot's newest request, not the values
          // this closure captured at issue time.
          const want = slot.want || { price, label, color };
          configureAverageLine(line, want.price, want.label, want.color);
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
    // DEFECT C-05: before the first bar close there is NO evidence of the
    // chart's unit. The old "first usable candidate" fallback painted a USD
    // token price on an mcap axis (~9 orders of magnitude off) exactly
    // during chart boot. Honest absence beats a fabricated level: draw
    // nothing until evidence arrives (a close, or an explicit axisBasis
    // which bypasses this picker entirely).
    if (!(lastBarClose > 0)) return null;
    let best = usable[0];
    let bestDist = Math.abs(Math.log10(best.v / lastBarClose));
    for (const e of usable.slice(1)) {
      const dist = Math.abs(Math.log10(e.v / lastBarClose));
      if (dist < bestDist) { best = e; bestDist = dist; }
    }
    return best;
  }

  function pickAxisLevel(usd, mcap, native, nativeMcap) {
    // With a live bar close the nearest candidate in log space wins; with no
    // close yet, pickAxisEntry refuses (C-05) and callers retry once evidence
    // arrives. The ordering only breaks exact log-distance ties: Axiom's
    // default chart view is market cap, Padre charts price.
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

  /** A close within [1/4, 4]x of `current` is a plain price tick in that
   *  unit. Cap closes differ from price closes by the supply factor (1e6+),
   *  and USD from SOL by the SOL rate (~1e2), so the band cannot confuse
   *  families; it only needs to absorb feed skew between close and current. */
  function closeWithinBand(close, current) {
    const c = Number(current);
    if (!(c > 0)) return false;
    const ratio = close / c;
    return ratio > 0.25 && ratio < 4;
  }

  /**
   * F-35: the freshest ledger close that is eligible for MCAP-axis level
   * math. A close that looks like a plain price tick (either unit) is the
   * same token's price-mode series — scaling it by avg/current would land
   * the line a supply-factor off, so it is excluded outright. Among the
   * survivors, a close agreeing with the resolver's current mcap is
   * preferred; disagreement alone does not disqualify (Axiom Final Stretch
   * caps legitimately differ from the resolver's — the F-31 lesson).
   */
  function vettedMcapClose(spec) {
    const now = Date.now();
    let preferred = null;
    let survivor = null;
    for (const entry of barCloseLedger.values()) {
      if (!(entry.close > 0) || now - entry.atMs > BAR_CLOSE_FRESH_MS) continue;
      if (closeWithinBand(entry.close, spec.currentPriceUsd)) continue;
      if (closeWithinBand(entry.close, spec.currentPriceNative)) continue;
      if (!survivor || entry.atMs > survivor.atMs) survivor = entry;
      if (closeWithinBand(entry.close, spec.currentMcap)
        && (!preferred || entry.atMs > preferred.atMs)) preferred = entry;
    }
    const pick = preferred || survivor;
    if (pick) return pick.close;
    // No subscription-tracked bars at all (export-only charts): the single
    // global close is all there is — still refuse it when it is price-like.
    if (barCloseLedger.size) return null;
    if (!(lastBarClose > 0)) return null;
    if (closeWithinBand(lastBarClose, spec.currentPriceUsd)) return null;
    if (closeWithinBand(lastBarClose, spec.currentPriceNative)) return null;
    return lastBarClose;
  }

  /** mcapLevelFromClose, but the close must have passed F-35 unit vetting. */
  function vettedMcapLevel(spec, avgPrice, currentPrice) {
    const close = vettedMcapClose(spec);
    if (!(close > 0) || !(Number(avgPrice) > 0) || !(Number(currentPrice) > 0)) return null;
    return close * (Number(avgPrice) / Number(currentPrice));
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
      // DEFECT C-07: fresh launches can have fills that predate the SOL/USD
      // rate, so avgBuyUsd is null while avgBuyNative sits in the same spec.
      // The old hard `|| null` returned no line on exactly those tokens.
      // When the axis is native, the native average is used directly; when
      // the axis is USD and only the native average is known, convert it via
      // the spec's current rate — and with no rate, draw no line at all
      // rather than a wrong one.
      if (basis === 'usd') {
        const usd = Number(spec['avg' + side + 'Usd']);
        if (usd > 0) return usd;
        const native = Number(spec['avg' + side + 'Native']);
        if (native > 0 && currentUsd > 0 && currentNative > 0) {
          return native * (currentUsd / currentNative);
        }
        return null;
      }
      if (basis === 'native') {
        const native = Number(spec['avg' + side + 'Native']);
        if (native > 0) return native;
        const usd = Number(spec['avg' + side + 'Usd']);
        if (usd > 0 && currentUsd > 0 && currentNative > 0) {
          return usd * (currentNative / currentUsd);
        }
        return null;
      }
      if (basis === 'mcap') {
        // F-35: the close is unit-vetted — a price-mode series of the same
        // token can never price an mcap line, even when it ticked last.
        const avg = Number(spec['avg' + side + 'Usd']);
        const computed = vettedMcapLevel(spec, avg, currentUsd);
        if (computed > 0) return computed;
        // C-07: no USD average — the native price RATIO carries the same
        // information (close x avgNative/currentNative is the same level).
        const viaNative = vettedMcapLevel(spec, Number(spec['avg' + side + 'Native']), currentNative);
        if (viaNative > 0) return viaNative;
        const explicit = Number(spec['avg' + side + 'Mcap']);
        return explicit > 0 ? explicit : null;
      }
      if (basis === 'native-mcap') {
        const avg = Number(spec['avg' + side + 'Native']);
        const computed = vettedMcapLevel(spec, avg, currentNative);
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

    // F-32 (lev's video, post-C-01): an average line is a CONSTANT level in
    // axis units. The ratio math (close x avg/current) exists only to convert
    // the average into the chart's unit — recomputing it on every sweep from
    // a MOVING close meant any staleness anywhere (a missed spec re-post, a
    // frozen current) made the line ride the candle at ratio ~= 1. The level
    // is therefore computed ONCE per spec arrival (or on the first sweep
    // where a bar close exists) and FROZEN; sweeps re-assert the same number.
    // A fresh spec — the content script re-posts within 2 s of any move —
    // recomputes it, so accuracy is unchanged while the failure class dies.
    if (paperLineSpec.frozenBuyLevel === undefined || paperLineSpec.frozenBuyLevel === null) {
      paperLineSpec.frozenBuyLevel = lineLevelFor(paperLineSpec, 'Buy');
    }
    if (paperLineSpec.frozenSellLevel === undefined || paperLineSpec.frozenSellLevel === null) {
      paperLineSpec.frozenSellLevel = lineLevelFor(paperLineSpec, 'Sell');
    }
    const buyLevel = paperLineSpec.frozenBuyLevel;
    const sellLevel = paperLineSpec.frozenSellLevel;
    // The best-ranked chart can still refuse (Axiom's preload chart throws
    // "Value is null" until a series loads); fall through the ranking — but
    // ONLY past charts that refused everything. DEFECT C-15: requiring
    // buyOk && sellOk from one chart tore a WORKING buy line off the visible
    // chart whenever the sell line failed, then rebuilt it on the seriesless
    // preload. A partially-successful chart is kept: the failed line simply
    // retries there on the next sweep, and a working line is never moved to
    // a chart that ranked worse.
    for (const chart of charts) {
      // "PAPER" prefix is non-negotiable: Padre labels the user's REAL
      // position line "Avg. Fill Price", so an identical label on ours made
      // the two indistinguishable when both positions exist (DEFECT F-30).
      // Same doctrine as the P&L-card watermark — a paper artifact must
      // never be mistakable for a real one.
      const buyOk = syncLineSlot(averageFillSlot, chart, buyLevel, 'PAPER Avg. Fill', '#90A8FA99');
      const sellOk = syncLineSlot(averageExitSlot, chart, sellLevel, 'PAPER Avg. Exit', '#F7DC8599');
      if (buyOk && sellOk) return true;
      if (buyOk || sellOk) return false; // keep the partial chart; retry the other line here
    }
    return false;
  }

  /* ---------------- execution-shape fallback for fills ---------------- */

  const fallbackShapeHandles = new Map(); // mark id -> shape handle
  let fallbackCheckTimer = null;

  /**
   * F-31 (community screenshot, Padre mcap chart): fill shapes floated ~1.5x
   * above the candles while the avg line sat exactly right. The line gets the
   * live-close correction; shapes used the RAW fill-time resolver-implied
   * mcap — and the chart's own cap definition (bonding curve, Padre supply
   * math) differs from the resolver's by a constant factor. The universal
   * honest formula is axis-agnostic: lastBarClose × (fillPrice/currentPrice).
   * Whatever unit the close is in — USD cap, SOL cap, plain price — scaling
   * it by the price ratio lands the fill in that same unit, and supply
   * cancels out entirely. Explicit price axes still use the exact recorded
   * values (no correction needed there).
   */
  function shapeLevelFor(levels) {
    const spec = paperLineSpec || {};
    const basis = spec.axisBasis;
    if (basis === 'usd' && levels.usd > 0) return levels.usd;
    if (basis === 'native' && levels.native > 0) return levels.native;
    const currentNative = Number(spec.currentPriceNative);
    // F-35: on a declared mcap axis the ratio-scaled close must be a cap
    // close, not a price-mode series that happened to tick last. An unknown
    // basis keeps the historical global-close behavior.
    const close = (basis === 'mcap' || basis === 'native-mcap')
      ? vettedMcapClose(spec)
      : lastBarClose;
    if (close > 0 && levels.native > 0 && currentNative > 0) {
      return close * (levels.native / currentNative);
    }
    return pickAxisLevel(levels.usd, levels.mcap, levels.native, levels.nativeMcap);
  }

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
      const level = shapeLevelFor(levels);
      if (!(level > 0)) continue;
      let handle = null;
      for (const chart of charts) {
        if (typeof chart.createExecutionShape !== 'function') continue;
        handle = spawnExecutionShape(chart, {
          side: levels.side,
          // F-31: never draw ahead of the chart's newest bar.
          timeSec: lastBarTimeSec > 0 ? Math.min(mark.time, lastBarTimeSec) : mark.time,
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

  let gmgnShapes = [];       // [{ handle, payload }] for drawn fills
  let gmgnMarkerQueue = [];  // fills waiting for a usable chart (or a cap)
  let gmgnMarkerTimer = null;
  // The chart instance the current shapes were drawn on. GMGN remounts its
  // chart on timeframe changes; shapes drawn on the dead instance vanish and
  // must be re-queued onto the new one (DEFECT C-12).
  let gmgnShapesChart = null;
  // A draw that actually FAILED (createExecutionShape refused) is retried a
  // bounded number of times; waiting for data (no cap yet) never burns these.
  const GMGN_MARKER_DRAW_ATTEMPTS = 30;

  /**
   * DEFECT C-08: how much GMGN's own cap axis differs from resolver-implied
   * caps. Both are supply x priceUsd with different supply definitions, so
   * the ratio is a per-token constant — the live candle close over the
   * resolver's current mcap (carried in the gmgn-lines spec, re-posted by
   * the content script as prices move). 1 until both sides exist.
   */
  function gmgnCapScale() {
    const current = gmgnLineSpec && numberValue(gmgnLineSpec.currentMcap);
    if (gmgnLastCandleClose > 0 && current > 0) return gmgnLastCandleClose / current;
    return 1;
  }

  /**
   * The Y level for one GMGN fill. Resolver-implied caps are corrected onto
   * GMGN's own axis via gmgnCapScale (C-08). A capless fill — priceUsd was
   * null at fill time, so the content script refused to fabricate an mcap
   * (C-09) — is priced from its SOL price the moment the live candle close
   * and a current SOL price coexist: close x (fillNative / currentNative)
   * is the fill expressed on GMGN's axis (C-16). Null means "not yet".
   */
  function gmgnMarkerLevel(payload) {
    const mcap = numberValue(payload && payload.mcap);
    if (mcap > 0) return mcap * gmgnCapScale();
    const native = numberValue(payload && payload.priceNative);
    const currentNative = gmgnLineSpec && numberValue(gmgnLineSpec.currentPriceNative);
    if (native > 0 && currentNative > 0 && gmgnLastCandleClose > 0) {
      return gmgnLastCandleClose * (native / currentNative);
    }
    return null;
  }

  /** C-12: pull every drawn shape back into the queue (chart remounted). */
  function requeueGmgnShapes() {
    for (const entry of gmgnShapes.splice(0)) {
      removeShapeHandle(entry.handle);
      entry.payload._ptDrawAttempts = 0;
      gmgnMarkerQueue.push(entry.payload);
    }
    gmgnShapesChart = null;
  }

  /**
   * Draw paper fills on GMGN's own chart using TradingView execution shapes.
   *
   * A native shape stays anchored to its candle through panning, zooming and
   * auto-scale, which an absolutely-positioned SVG overlay cannot do.
   *
   * Fills are queued and drained: markers restored from the journal arrive
   * before GMGN's chart manager has mounted, and dropping them on the floor
   * was exactly the "bubbles never show" failure. The drain retries until the
   * chart exists. DEFECT C-13: the old drain spliced the whole queue and then
   * DISCARDED payloads whose draw failed (a mid-boot chart ate every batch);
   * failures now go back into the queue with a bounded retry budget, and
   * fills still waiting on a cap (C-16) are kept without burning retries.
   */
  function drainGmgnMarkers() {
    const chart = findGmgnChart();
    // C-12: shapes belong to one chart instance. If GMGN swapped it
    // (timeframe change, SPA remount) the old shapes died with it — requeue
    // everything onto the live chart before draining new fills.
    if (chart && gmgnShapesChart && gmgnShapesChart !== chart && gmgnShapes.length) {
      requeueGmgnShapes();
    }
    if (!gmgnMarkerQueue.length) return true;
    if (!chart || typeof chart.createExecutionShape !== 'function') return false;
    const pending = gmgnMarkerQueue.splice(0);
    const retry = [];
    let allDrawn = true;
    for (const payload of pending) {
      const level = gmgnMarkerLevel(payload);
      if (!(level > 0)) {
        // C-16: cap not resolvable yet — keep waiting. Not a draw failure.
        retry.push(payload);
        allDrawn = false;
        continue;
      }
      const handle = spawnExecutionShape(chart, {
        side: payload.side,
        // DEFECT C-26: snap to the chart's bar grid (noted from the candle
        // URL) exactly like the Padre/Axiom mark path — a raw floor-to-second
        // put mid-bar arrows off-grid. Snapping happens at DRAW time from the
        // original fill ts, so a remount after a timeframe change (C-12)
        // re-snaps the requeued fills onto the new grid for free.
        timeSec: snapMarkTime(numberValue(payload.ts) || 0),
        level,
        text: payload.text,
      });
      if (!handle) {
        // C-13: a failed draw is re-queued (bounded), never lost.
        payload._ptDrawAttempts = (payload._ptDrawAttempts || 0) + 1;
        if (payload._ptDrawAttempts < GMGN_MARKER_DRAW_ATTEMPTS) {
          retry.push(payload);
          allDrawn = false;
        }
        continue;
      }
      gmgnShapes.push({ handle, payload });
      if (gmgnShapes.length > MAX_MARKS) removeShapeHandle(gmgnShapes.shift().handle);
    }
    gmgnShapesChart = chart;
    if (retry.length) gmgnMarkerQueue.unshift(...retry);
    return allDrawn;
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
    // C-16: a fill whose cap is unknown (null priceUsd at fill time) is still
    // queued when it carries its SOL price — gmgnMarkerLevel prices it the
    // moment the candle close and a current price coexist. Only a fill with
    // no usable level source at all is refused.
    const native = numberValue(payload && payload.priceNative);
    if (!(time > 0) || (!(level > 0) && !(native > 0))) return false;
    gmgnMarkerQueue.push(payload);
    if (gmgnMarkerQueue.length > MAX_MARKS) gmgnMarkerQueue = gmgnMarkerQueue.slice(-MAX_MARKS);
    scheduleGmgnMarkerDrain();
    return true;
  }

  function clearGmgnFillMarkers() {
    gmgnMarkerQueue = [];
    if (gmgnMarkerTimer) { clearTimeout(gmgnMarkerTimer); gmgnMarkerTimer = null; }
    for (const entry of gmgnShapes.splice(0)) removeShapeHandle(entry.handle);
    gmgnShapesChart = null;
  }

  /** C-08: line level on GMGN's own axis (see gmgnCapScale). */
  function gmgnLineLevel(side) {
    const avg = numberValue(gmgnLineSpec && gmgnLineSpec['avg' + side + 'Mcap']);
    if (!(avg > 0)) return null;
    return avg * gmgnCapScale();
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
    const buyOk = syncLineSlot(gmgnBuySlot, chart, gmgnLineLevel('Buy'), gmgnLineSpec.avgBuyText || 'PT Avg Buy', '#34D399');
    const sellOk = syncLineSlot(gmgnSellSlot, chart, gmgnLineLevel('Sell'), gmgnLineSpec.avgSellText || 'PT Avg Sell', '#FF5F56');
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
    lastWidgetScanFound = widgets.length > 0;
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
        // C-19: a usable widget exists on this page — the content script may
        // route markers/lines natively regardless of the site's id.
        nativeCapable: true,
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

    // ANY message from the content script proves the extension is alive
    // (O-04/C-17); a token/chart signal also revives the fast widget sweep
    // after an F-26 stand-down. A bare 'bridge-ping' refreshes liveness only.
    lastContentMessageAt = Date.now();
    if (type === 'paper-axis' || type === 'paper-lines') widgetSweepMisses = 0;

    // Feed demand. 'page-state' is the explicit signal; a token anchor or a
    // chip scan is proof of a consumer regardless of message ordering.
    if (type === 'page-state') {
      feedWanted = Boolean(payload && payload.wantsTicks);
      return;
    }
    if (type === 'paper-axis' || type === 'row-scan') feedWanted = true;

    if (type === 'standdown') {
      // The content script is going away (overlay disabled, or extension
      // reload teardown): erase every native drawing this bridge owns and
      // stop re-asserting it. Backdating the liveness stamp silences the
      // sweep immediately; a future content script revives it by speaking.
      paperLineSpec = null;
      gmgnLineSpec = null;
      paperMarks = [];
      paperMarkLevels.clear();
      shapeFallbackActive = false;
      if (fallbackCheckTimer) { clearTimeout(fallbackCheckTimer); fallbackCheckTimer = null; }
      clearShapeFallback();
      clearPaperAverageLines();
      clearGmgnAverageLines();
      clearGmgnFillMarkers();
      refreshPadreMarks();
      lastContentMessageAt = Date.now() - CONTENT_SILENCE_LIMIT_MS;
      // A standdown also ends feed demand outright: "PaperTrench off" must
      // cost the page zero parses from this instant, not from the next tick.
      feedWanted = false;
      return;
    }

    if (type === 'paper-axis') {
      // The page's resolved token identity: ticks, exports and drawing are
      // only taken from the chart whose symbol contains one of these needles.
      setCurrentSymbolNeedles(payload);
      // DEFECT C-19: answer with a capability snapshot. Widget discovery is
      // site-agnostic, so sites outside the hardcoded native set (Photon,
      // BullX, DexScreener...) route markers natively the moment a usable
      // TradingView widget exists here — the content script falls back to
      // the SVG rail only when no widget is found within its grace period.
      emit('padre-hook-status', {
        barsHooked: padreBarsHooked,
        marksHooked: padreMarksHooked,
        nativeCapable: findTradingViewWidgets().length > 0,
      });
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
        // C-08/C-16: the resolver's CURRENT view of the token, re-posted by
        // the content script as prices move — the other half of the candle-
        // close correction, and the rate that prices capless fills.
        currentMcap: numberValue(payload && payload.currentMcap),
        currentPriceNative: numberValue(payload && payload.currentPriceNative),
        currentPriceUsd: numberValue(payload && payload.currentPriceUsd),
      };
      retryGmgnAverageLines();
      // A fresher spec may be exactly what a queued capless fill was waiting
      // for (C-16) — give the drain a chance without waiting for the sweep.
      if (gmgnMarkerQueue.length) scheduleGmgnMarkerDrain();
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
    // pointerdown must keep propagating to OTHER window-capture listeners:
    // the content script's gesture stamp (isTrusted pointerdown) lives there,
    // and stopImmediatePropagation starved it — so a chip tap after >5 s of
    // idling was refused by the fill pipeline's own forgery gate and the chip
    // stuck in busy forever (DEFECT F-08). stopPropagation still keeps the
    // row underneath from navigating; the later press events stay swallowed
    // entirely.
    if (ev.type === 'pointerdown') {
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
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

  /* Chip layout runs in two strict phases (Turbo): ALL reads, then ALL
   * writes. The old per-chip read→write interleave dirtied layout with every
   * chip's style writes, forcing a synchronous reflow for the NEXT chip's
   * getBoundingClientRect/elementFromPoint — O(N chips) reflows per sweep,
   * on the same thread the feed parses on (the F-18 starvation class).
   * Measured against clean layout the whole sweep costs one reflow, and the
   * writes are diffed against the last applied values, so a steady-state
   * sweep (rows unmoved) writes nothing and leaves layout clean for the
   * page's own frame.
   */
  const PILL_RETRY_MS = 1000;

  function positionRowChip(entry) {
    // READ phase: measures and decides; touches no styles. Returns the write
    // plan for applyRowChip, or null when the row is gone.
    const { row, el, place } = entry;
    if (!row.isConnected) return null;
    const rect = row.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10 ||
        rect.bottom < 0 || rect.top > window.innerHeight ||
        rect.right < 0 || rect.left > window.innerWidth) {
      return { display: 'none' };
    }
    // Occlusion: rows scroll inside their own panes — when a row slides
    // under a sticky header the fixed-layer chip must vanish with it.
    const probeY = Math.min(Math.max(rect.top + rect.height / 2, 1), window.innerHeight - 1);
    const probeX = Math.min(Math.max(rect.left + rect.width * 0.35, 1), window.innerWidth - 1);
    const hit = document.elementFromPoint(probeX, probeY);
    if (hit && hit !== el && !row.contains(hit) && !el.contains(hit)) {
      return { display: 'none' };
    }

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
      if (!pill) entry.pill = null;
      if (!pill && Date.now() - (entry.pillMissAt || 0) >= PILL_RETRY_MS) {
        // The pill can live just OUTSIDE the detected row container (Padre
        // renders it in a sibling strip below the card body), so widen the
        // search up two ancestors but only accept buttons overlapping the
        // row's own column — never a neighbour card's pill. The walk reads a
        // rect per button, so a row that simply HAS no pill must not pay it
        // on every sweep: misses retry at 1 Hz. A fresh chip searches at
        // once (pillMissAt starts unset), so first placement is never late.
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
        entry.pillMissAt = pill ? 0 : Date.now();
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

    // DEFECT O-22: the chip layer sits BELOW the PaperTrench panel/bar by
    // design (a chip must never cover the trade panel), so a chip whose spot
    // the overlay covers would render invisible yet swallow no clicks — a
    // dead control. Probe the chip's own anchor point: everything the
    // overlay draws (panel, positions bar, pill, toasts) lives in the
    // #papertrench-host shadow tree, and elementFromPoint retargets shadow
    // content to its host, so one id check covers all of it. Occluded chips
    // stand down; they return the moment the panel is dragged away.
    const chipProbeX = Math.min(Math.max(anchor.x - 10, 1), (window.innerWidth || 1) - 1);
    const chipProbeY = Math.min(Math.max(
      anchor.y + (anchor.align === 'right-top' ? 8 : anchor.align === 'right-bottom' ? -8 : 0),
      1), (window.innerHeight || 1) - 1);
    const over = document.elementFromPoint(chipProbeX, chipProbeY);
    if (over && over !== el && !el.contains(over) && over.id === 'papertrench-host') {
      return { display: 'none' };
    }

    const size = Number(entry.size) > 0 ? entry.size : 1;
    return {
      display: '',
      left: anchor.x + 'px',
      top: anchor.y + 'px',
      origin: anchor.align === 'right-center' ? '100% 50%'
        : anchor.align === 'right-bottom' ? '100% 100%'
        : '100% 0%',
      transform: (anchor.align === 'right-center' ? 'translate(-100%, -50%)'
        : anchor.align === 'right-bottom' ? 'translate(-100%, -100%)'
        : 'translate(-100%, 0)') + ' scale(' + size + ')',
    };
  }

  function applyRowChip(entry, plan) {
    // WRITE phase: every write is diffed — an unmoved chip costs nothing.
    const el = entry.el;
    const last = entry.applied || (entry.applied = {});
    if (plan.display === 'none') {
      if (last.display !== 'none') { el.style.display = 'none'; last.display = 'none'; }
      return;
    }
    if (last.display !== '') { el.style.display = ''; last.display = ''; }
    if (last.left !== plan.left) { el.style.left = plan.left; last.left = plan.left; }
    if (last.top !== plan.top) { el.style.top = plan.top; last.top = plan.top; }
    if (last.origin !== plan.origin) { el.style.transformOrigin = plan.origin; last.origin = plan.origin; }
    if (last.transform !== plan.transform) { el.style.transform = plan.transform; last.transform = plan.transform; }
  }

  function sweepRowChips() {
    // Phase R: measure every chip against clean layout…
    const plans = [];
    const dead = [];
    for (const [row, entry] of rowChips) {
      const plan = positionRowChip(entry);
      if (!plan) {
        dead.push(entry);
        rowChips.delete(row);
        continue;
      }
      plans.push([entry, plan]);
    }
    // …Phase W: then write, removals included.
    for (const entry of dead) entry.el.remove();
    for (const [entry, plan] of plans) applyRowChip(entry, plan);
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
    // childList only: rows shifting is a node change. characterData fired a
    // reposition (with its forced-layout chip walk) on EVERY price-digit
    // update across the whole list — main-thread starvation exactly when
    // volume peaked, on the same thread the feed parses on (DEFECT F-18).
    // Pure text updates cannot move a row; scroll/resize listeners and the
    // 1 s sweep cover residual drift.
    rowChipObserver.observe(document.body, { childList: true, subtree: true });
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
      // Placement happens in the sweep below — one batched read/write pass
      // for every chip, the fresh one included.
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
  let lastExportEmitAt = 0;
  let exportStartedAt = 0;
  let exportSeq = 0;

  function pollChartClose() {
    const now = Date.now();
    // F-26: a page that has produced no TradingView widget for a minute has
    // nothing to export — stand down with the widget sweep; the slow sweep
    // resets the miss counter the moment a chart appears.
    if (widgetSweepMisses >= WIDGET_SWEEP_MISS_LIMIT) return;
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
      if (!(close > 0)) return;
      // A flat market is not a dead feed. Re-assert an unchanged close on a
      // slow heartbeat so staleness handling does not declare a healthy chart
      // dead and route every fill to the resolver (DEFECT F-19).
      if (close === lastExportedClose && Date.now() - lastExportEmitAt < 2500) return;
      lastExportedClose = close;
      lastExportEmitAt = Date.now();
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
  let sweepTicks = 0;
  setInterval(() => {
    sweepTicks += 1;
    // O-04/C-17: a content script that has said NOTHING for 5+ minutes is
    // dead (extension reloaded/removed) or deliberately stood down. Stop
    // repainting lines/marks; the transport wrappers keep forwarding ticks,
    // and any future content-script message revives the sweep instantly.
    if (Date.now() - lastContentMessageAt > CONTENT_SILENCE_LIMIT_MS) return;

    // GMGN recovery is driven by its own chart manager, not the TradingView
    // widget scan, so it runs whenever specs/queues exist.
    if (gmgnLineSpec && gmgnLineSpec.enabled && !gmgnRetryTimer) {
      const buyMissing = Number(gmgnLineSpec.avgBuyMcap) > 0 && !gmgnBuySlot.adapter && !gmgnBuySlot.pending;
      const sellMissing = Number(gmgnLineSpec.avgSellMcap) > 0 && !gmgnSellSlot.adapter && !gmgnSellSlot.pending;
      if (buyMissing || sellMissing) syncGmgnAverageLines();
    }
    if (gmgnMarkerQueue.length && !gmgnMarkerTimer) scheduleGmgnMarkerDrain();
    // DEFECT C-12: lines detect chart replacement inside syncGmgnAverageLines,
    // but shapes had no such check — a GMGN timeframe change permanently
    // erased every paper arrow. Compare the drawn shapes' chart identity to
    // the live chart and requeue+redraw on mismatch. Only runs while shapes
    // exist, i.e. on GMGN pages with fills.
    if (gmgnShapes.length && !gmgnMarkerTimer) {
      const liveGmgnChart = findGmgnChart();
      if (liveGmgnChart && gmgnShapesChart && liveGmgnChart !== gmgnShapesChart) {
        requeueGmgnShapes();
        scheduleGmgnMarkerDrain();
      }
    }

    // F-26: after a minute of empty scans the widget sweep (fiber walks,
    // iframe probes) drops to every 10th tick until a chart shows up or the
    // content script announces one (paper-axis/paper-lines resets misses).
    const standingDown = widgetSweepMisses >= WIDGET_SWEEP_MISS_LIMIT;
    if (standingDown && sweepTicks % WIDGET_SWEEP_SLOW_EVERY !== 0) return;
    patchPadreWidget();
    widgetSweepMisses = lastWidgetScanFound ? 0 : widgetSweepMisses + 1;
    // Shape-mode fills that could not draw yet (chart still booting, or the
    // site swapped to a fresh chart instance) are retried here.
    if (shapeFallbackActive && paperMarks.length && fallbackShapeHandles.size < paperMarks.length) {
      drawShapeFallback();
    }
  }, 1000);

  emit('ready', { href: location.href, phase: 'document-start', version: 4 });
})();
