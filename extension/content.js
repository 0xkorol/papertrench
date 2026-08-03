/* PaperTrench — content script.
 *
 * Injected on supported trading sites. Detects the token on screen, pulls the
 * live price from the page itself (via price-bridge.js in the main world), and
 * renders a Shadow-DOM quick-trade panel. Zero paid API calls.
 */
(() => {
  'use strict';

  const E = window.PaperEngine;
  const S = window.PaperTrenchSites;
  const Q = window.PaperQuote;
  // Price network calls are routed through the service worker, which has the
  // extension's host permissions and is not bound by the page origin's CORS.
  // Keep a reference to the in-page resolver so wiring tests still see it.
  const resolver = window.PaperTrenchResolver;
  function okOrNull(reply) {
    // The background answers failures and unknown types with { error: ... },
    // which must not be treated as a real token record.
    return (reply && typeof reply === 'object' && !reply.error) ? reply : null;
  }
  const R = {
    resolve: (address) => sendMessage({ type: 'pt_resolve', address }).then(okOrNull),
    refresh: (token) => sendMessage({ type: 'pt_refresh', token }).then(okOrNull),
    solUsd: () => sendMessage({ type: 'pt_sol_usd' }).then((r) => (typeof r === 'number' && r > 0 ? r : 0)).catch(() => 0),
    onchainWatch: (mint, pool) => sendMessage({ type: 'pt_onchain_watch', mint, pool }).then(okOrNull),
    onchainUnwatch: (mint) => sendMessage({ type: 'pt_onchain_unwatch', mint }).catch(() => null),
    onchainQuote: (mint) => sendMessage({ type: 'pt_onchain_quote', mint }).then(okOrNull),
    batchPrices: (mints) => sendMessage({ type: 'pt_batch_prices', mints }).then((r) => (r && typeof r === 'object' && !r.error) ? r : {}),
    clearCache: () => { if (resolver && typeof resolver.clearCache === 'function') resolver.clearCache(); },
  };
  const HOST_ID = 'papertrench-host';
  const DETECT_MS = 800;
  // The heartbeat is a SAFETY NET only — it re-quotes when the feed is quiet
  // and re-renders in case a tick was missed. The primary render path is
  // event-driven: handlePageTick fires the instant the page's own feed or
  // DOM observer delivers a price, and renderPosition() runs right there.
  // 100ms heartbeat catches any missed tick within 1 frame.
  const PRICE_TICK_MS = 100;
  // While a brand-new coin is still unindexed, retry far faster than the
  // ordinary detect cadence, for a bounded window.
  const FAST_RETRY_MS = 250;
  const FAST_RETRY_WINDOW_MS = 90_000;
  const SERIES_CAP = 2400;

  let settings = E.defaultSettings();
  let state = E.defaultState(settings);
  let site = null;
  let token = null; // {kind, address, mint, pairAddress, symbol, priceNative, priceUsd, mcap, anchor}
  let series = [];
  let marks = [];
  let lastHref = '';
  let priceTimer = null;
  let lastPollAt = 0;
  let pollInFlight = false;
  let posEls = null;            // cached position-card nodes, updated in place
  let thesisEls = null;         // cached thesis card state
  let thesisEditing = false;
  // A buy requested before the first quote existed, to be executed on arrival.
  let armedBuy = null;
  const ARMED_BUY_TTL_MS = 60_000;
  let lastRenderedPrice = null; // drives the tick flash
  let lastPriceAt = 0;
  let pageQuoteSeq = 0;
  const pageQuoteWaiters = new Set();
  let resolving = false;
  // True once live chain state is streaming for the token on screen.
  let onchainLive = false;
  // Fresh-launch tracking: how long the current address has been unresolved.
  let pendingSince = 0;
  let pendingAttempts = 0;
  let pendingSolUsd = 0;      // warmed SOL/USD rate for bootstrapping USD ticks
  let fastDetectTimer = null;
  let detectLoopTimer = null;
  let barScanTimer = null;
  let lastCmTickPrice = 0;
  // Track whether the main panel is collapsed to the mini pill.
  let panelMinimized = false;
  // Track an in-progress resize of the trade tab.
  let resizingOverlay = false;
  let resizeStart = null;
  const CM = window.PTChartMarkers; // chart bubble markers
  const TF = window.PTTitleFeed;    // zero-cost market-cap change signal

  /**
   * Return the trusted resolver anchor for the current token. Live chart ticks
   * are validated against this anchor, not against the last accepted tick, so a
   * single wrong page value cannot corrupt every following tick and P&L mark.
   */
  function tokenAnchor() {
    if (token && token.anchor && Number(token.anchor.priceNative) > 0) return token.anchor;
    return token;
  }
  // Which unit band accepted the site's chart ticks ('usd' | 'native' |
  // 'mcap' | 'native-mcap'). This is the ground truth for the chart's Y
  // axis, so average lines are drawn in exactly that unit.
  let chartAxisBasis = null;

  /**
   * Sites whose charts are TradingView, where PaperTrench draws NATIVE marks
   * and order lines instead of an SVG overlay.
   *
   * Native drawing is the only way markers stay glued to the candles when the
   * user pans, zooms, or the chart auto-scales. Padre and Axiom both load the
   * TradingView library and expose a widget with `activeChart()`, so one code
   * path serves both.
   */
  const NATIVE_TV_SITES = new Set(['padre', 'axiom']);
  function usesNativeChart() { return Boolean(site && NATIVE_TV_SITES.has(site.id)); }
  const AT = window.PTAttest;       // tamper-evident fill chain
  const profitAlertLevels = new Map(); // mint -> highest threshold already handled
  // Positions bar: prices for tokens whose charts are NOT on screen.
  const BAR_HEIGHT_PX = 38;
  const BAR_POLL_MS = 6000;        // visible tab, off-screen positions
  const BAR_POLL_HIDDEN_MS = 30000; // background tab: stay polite
  let livePositionPrices = {};      // mint -> { priceNative, priceUsd }
  const barChips = new Map();       // mint -> cached chip nodes
  let barTotalEls = null;           // cached aggregate nodes
  let positionsBarHidden = false;
  let barOffsetApplied = false;
  let barPollAt = 0;
  let barPollInFlight = false;
  let audioContext = null;
  let audioPrimed = false;

  let host, shadow, els = {};

  /* -------------------- extension lifetime -------------------- */

  // Reloading or updating the extension kills this script's context, but the
  // already-injected copy keeps running in the page. Every chrome.* call then
  // throws "Extension context invalidated", and because this script is driven
  // by several timers that produced a rejection on EVERY tick plus a visibly
  // thrashing panel. The guard below turns that into a single clean shutdown.
  let contextDead = false;
  const teardownFns = [];

  /** True while this content script may still talk to the extension. */
  function contextAlive() {
    if (contextDead) return false;
    try {
      // chrome.runtime.id becomes undefined the moment the context is gone.
      return Boolean(chrome && chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  /** Register a cleanup action to run when the extension goes away. */
  function onTeardown(fn) { teardownFns.push(fn); }

  /**
   * Stop everything and remove our UI from the page.
   *
   * Idempotent: later timers that fire before they are cleared simply see
   * contextDead and return.
   */
  function shutdown(reason) {
    if (contextDead) return;
    contextDead = true;
    for (const fn of teardownFns.splice(0)) {
      try { fn(); } catch (_) { /* keep tearing down */ }
    }
    try { window.removeEventListener('message', onBridgeMessage); } catch (_) {}
    try { if (host && host.remove) host.remove(); } catch (_) {}
    host = null; shadow = null; els = {};
    // One quiet line, not a per-tick error storm.
    try { console.info('PaperTrench: extension context ended (' + (reason || 'reloaded') + '); overlay removed.'); } catch (_) {}
  }

  /** setInterval that is registered for teardown and dies with the context. */
  function managedInterval(fn, ms) {
    const id = setInterval(() => {
      if (!contextAlive()) { shutdown('invalidated'); return; }
      fn();
    }, ms);
    onTeardown(() => clearInterval(id));
    return id;
  }

  /**
   * Storage access that fails soft.
   *
   * A dead context is an expected end-of-life condition, not an error worth
   * rejecting into the page's console on every heartbeat.
   *
   * get() resolves null when the read FAILED (dead context, lastError, or an
   * exception) and {} when it succeeded but nothing is stored. Callers must
   * never treat a failed read as "empty wallet" — that is how a transient
   * storage hiccup turns into a silent wipe of every open position.
   */
  const store = {
    get: (keys) => new Promise((resolve) => {
      if (!contextAlive()) { shutdown('invalidated'); resolve(null); return; }
      try {
        chrome.storage.local.get(keys, (value) => {
          if (chrome.runtime && chrome.runtime.lastError) { resolve(null); return; }
          resolve(value || {});
        });
      } catch (_) { shutdown('invalidated'); resolve(null); }
    }),
    set: (obj) => new Promise((resolve) => {
      if (!contextAlive()) { shutdown('invalidated'); resolve(); return; }
      try {
        chrome.storage.local.set(obj, () => {
          if (chrome.runtime && chrome.runtime.lastError) { resolve(); return; }
          resolve();
        });
      } catch (_) { shutdown('invalidated'); resolve(); }
    }),
  };

  /** Fire-and-forget message that never rejects into the page console. */
  function sendMessage(payload) {
    if (!contextAlive()) { shutdown('invalidated'); return Promise.resolve(null); }
    try {
      const result = chrome.runtime.sendMessage(payload);
      return result && typeof result.catch === 'function'
        ? result.catch(() => null)
        : Promise.resolve(result || null);
    } catch (_) {
      shutdown('invalidated');
      return Promise.resolve(null);
    }
  }

  // Exposed for tests so the in-flight storage/messaging paths can be driven
  // directly; harmless in a page (a plain reference on the isolated-world
  // global, which the host page cannot see).
  try { window.__ptStore = store; window.__ptSend = sendMessage; } catch (_) {}

  /* -------------------- MAIN-world bridge messages -------------------- */

  let padreHookStatus = { barsHooked: false, marksHooked: false, linesReady: false };
  let lastMarkerStatus = null;
  let lastLineStatus = null;

  function onBridgeMessage(event) {
    if (event.source !== window || !event.data || event.data.source !== 'papertrench-bridge') return;
    const ev = event.data;
    if (ev.type === 'tick') { noteRowPrice(ev.payload); handlePageTick(ev.payload); }
    else if (ev.type === 'row-buy') {
      // A quick-buy chip injected by the MAIN-world bridge was tapped; the
      // fill pipeline itself lives here. The done-signal lets the bridge
      // clear the chip's busy state.
      if (ev.payload && ev.payload.address) {
        doRowBuy(ev.payload.address, null)
          .finally(() => sendPadreMarker('row-buy-done', null));
      }
    }
    else if (ev.type === 'padre-hook-status') {
      padreHookStatus = { ...padreHookStatus, ...(ev.payload || {}) };
      renderSiteStatus();
    } else if (ev.type === 'paper-marker-status') {
      lastMarkerStatus = ev.payload || null;
      renderSiteStatus();
    } else if (ev.type === 'paper-lines-status') {
      lastLineStatus = ev.payload || null;
      renderSiteStatus();
    } else if (ev.type === 'gmgn-lines-status') {
      // The GMGN bridge reports only lifecycle status; its labels live on the
      // native TradingView lines rather than in the PaperTrench card.
      renderSiteStatus();
    }
  }
  window.addEventListener('message', onBridgeMessage);

  function sendPadreMarker(type, payload) {
    window.postMessage({ source: 'papertrench-content', type, payload: payload || null }, '*');
  }

  /**
   * Value model for the generic SVG overlay. GMGN is not a price chart:
   * its live iframe symbol is `sol/<mint>/USD/MCAP` and its candle endpoint
   * returns market-cap OHLC values. Thus markers must be placed with market
   * cap but continue to display the trader's USD token fill.
   */
  function genericChartPoint(priceNative, priceUsd, mcap) {
    const usd = Number(priceUsd) > 0 ? Number(priceUsd) : Number(priceNative);
    const liveSupply = token && Number(token.mcap) > 0 && Number(token.priceUsd) > 0
      ? Number(token.mcap) / Number(token.priceUsd)
      : null;
    const chartMcap = Number(mcap) > 0 ? Number(mcap)
      : (liveSupply && usd > 0 ? usd * liveSupply : null);

    // The hover figure is the market cap of that fill whenever it is known,
    // because that is the number the trader remembers the entry by.
    if (chartMcap > 0) {
      const plot = site && site.id === 'gmgn' ? chartMcap : usd;
      return { plot, display: chartMcap, currency: 'MCAP' };
    }
    return { plot: usd, display: usd, currency: Number(priceUsd) > 0 ? 'USD' : 'SOL' };
  }

  /* -------------------- price handling -------------------- */

  /**
   * A tick from the page's own feed may only refine a price we already trust.
   *
   * For a brand-new coin with no anchor, the FIRST trustworthy on-screen price
   * is bootstrapped directly. This is what makes sniping possible before
   * Dexscreener or Jupiter have indexed the token.
   */
  function handlePageTick(payload) {
    if (!payload || !token) return;

    // Reject cross-token page ticks as early as possible. The bridge is
    // supposed to filter, but a preload chart or an unknown-symbol feed can
    // still leak through.
    if (payload.mint && payload.mint !== token.mint) return;
    if (payload.symbol && token.symbol
      && String(payload.symbol).toUpperCase() !== String(token.symbol).toUpperCase()) return;

    let verdict = null;
    const anchor = tokenAnchor();
    if (Number(anchor && anchor.priceNative) > 0) {
      verdict = Q.validateTick(anchor, payload);
    } else {
      verdict = Q.bootstrapTick(token, payload, pendingSolUsd);
    }
    if (!verdict || !verdict.accepted) return;

    // A live chart tick that validates tells us which unit the chart plots.
    if ((payload.source === 'padre-chart-bar' || payload.source === 'chart-export') && verdict.basis) {
      chartAxisBasis = verdict.basis;
    }

    const oldNative = Number(token.priceNative);
    token.priceNative = verdict.priceNative;
    if (verdict.priceUsd) token.priceUsd = verdict.priceUsd;
    if (verdict.mcap) token.mcap = verdict.mcap;
    token.priceSource = payload.source || 'page-feed';

    // For a brand-new coin, the first accepted on-screen tick becomes the
    // anchor until the resolver catches up. For resolved coins the anchor is
    // only refreshed by requote()/setToken() so live ticks cannot drift it.
    if (!token.anchor && Number(token.priceNative) > 0) {
      token.anchor = {
        mint: token.mint,
        priceNative: Number(token.priceNative),
        priceUsd: Number(token.priceUsd) || null,
        mcap: Number(token.mcap) || null,
      };
    }

    lastPriceAt = Date.now();
    pageQuoteSeq += 1;
    for (const resolve of pageQuoteWaiters) resolve();
    pageQuoteWaiters.clear();
    flushArmedBuy();
    // A duplicate tick still proves the feed is alive, but it does not need a
    // position mark, storage write, or DOM render.
    if (token.priceNative === oldNative) return;

    series.push({ t: lastPriceAt, p: token.priceNative, usd: token.priceUsd });
    if (series.length > SERIES_CAP) series.shift();
    E.markPosition(state, token.mint, token.priceNative, token.priceUsd);
    maybeProfitAlert(token.mint);
    if (CM && !usesNativeChart()) CM.tickPrice(genericChartPoint(token.priceNative, token.priceUsd, token.mcap).plot);
    persistSoon();
    // Event-driven hot path: render in this same task, with no timer wait.
    renderHeader();
    renderPosition();
    renderBalance();
    renderLiveDot();
    renderSparkline();
    // The on-screen token may also be held; keep its chip in step with the card.
    renderPositionsBar();
  }

  /* -------------------- detection -------------------- */

  async function detectLoop() {
    // A pending token still needs resolving, so do not treat "same URL" as
    // done until the address actually resolved. Without this a brand-new coin
    // would only retry when the URL changed — i.e. never.
    const settled = token && !token.pending;
    if (location.href === lastHref && settled) return;
    lastHref = location.href;
    site = S.currentSite();
    const candidate = site.detect();
    if (!candidate) { setToken(null); return; }
    if (settled && (token.mint === candidate.address || token.pairAddress === candidate.address || token.srcAddress === candidate.address)) return;
    if (resolving) return;
    resolving = true;

    // Show the pending state immediately so the panel is honest during the
    // resolve rather than displaying a fabricated number. Rebuilding this on
    // every retry would restart the card animation, so it is only set when the
    // address actually changes.
    const alreadyPendingSame = token && token.pending && token.mint === candidate.address;
    if (!alreadyPendingSame) {
      setToken({
        mint: candidate.address, symbol: null, name: null,
        priceNative: null, priceUsd: null, pending: true,
      });
      pendingSince = Date.now();
      pendingAttempts = 0;
      // Anchor the bridge to this token before the resolver finishes, so bars
      // and chart exports from a preloaded other-token chart do not leak in.
      sendPadreMarker('paper-axis', {
        pairAddress: candidate.kind === 'pair' ? candidate.address : null,
        mint: candidate.kind === 'mint' ? candidate.address : null,
      });
      // Warm the SOL/USD rate so a USD on-screen price can be filled the moment
      // it appears. resolveViaJupiter will also populate this cache shortly.
      R.solUsd().then((rate) => { if (rate > 0) pendingSolUsd = rate; }).catch(() => {});
    }

    try {
      const data = await R.resolve(candidate.address);
      if (!data) {
        // NOT a teardown. A brand-new coin is simply not indexed yet, and
        // tearing the token down here is what caused the visible flashing:
        // each failed attempt cleared markers and stopped the price loop,
        // then the next tick rebuilt everything from scratch.
        pendingAttempts += 1;
        renderHeader();
        return;
      }
      data.srcAddress = candidate.address;
      data.kind = candidate.kind;
      setToken(data);
      // Tell the bridge which address this page is about, so ticks, exports
      // and drawing only come from the chart instance showing THIS token.
      sendPadreMarker('paper-axis', { pairAddress: data.pairAddress, mint: data.mint, symbol: data.symbol });
      // The site publishes its live market cap in document.title, which changes
      // the instant the page re-renders — cheaper and earlier than any network
      // read. It refreshes the DISPLAYED cap between chain updates; it never
      // prices a fill, and it is validated against chain state before use.
      startTitleSignal();
      // Start streaming live pool state. Until this connects, prices come from
      // the aggregator and are labelled as such rather than presented as live.
      if (data.pairAddress) {
        R.onchainWatch(data.mint, data.pairAddress).then((reply) => {
          if (token && token.mint === data.mint) {
            onchainLive = Boolean(reply && reply.live);
            renderSiteStatus();
          }
        }).catch(() => {});
      }
      pendingSince = 0;
      pendingAttempts = 0;
      // After the token is resolved and state is current, restore any
      // existing trade markers from the journal (page reload scenario).
      await reloadState();
      restoreMarkersFromJournal();
      syncAveragePriceLines();
    } catch (e) {
      // Transient network failure: keep the pending token and retry, rather
      // than dropping a token the user may be about to snipe.
      pendingAttempts += 1;
    } finally {
      resolving = false;
      // The resolver warms the SOL/USD cache even when the token is still
      // unindexed; capture that rate for pending-token bootstraps.
      R.solUsd().then((rate) => { if (rate > 0) pendingSolUsd = rate; }).catch(() => {});
    }
  }



  function setToken(data) {
    const prevMint = token?.mint;
    const hadPrice = Boolean(token && token.priceNative);
    token = data;
    // Keep a separate resolver anchor for validation. This is the price we
    // trust until a newer resolver quote or a first on-chain observation
    // confirms the live level. Live chart ticks validate against this, so one
    // bogus tick does not become the new ground truth.
    if (token && Number(token.priceNative) > 0) {
      token.anchor = {
        mint: token.mint,
        priceNative: Number(token.priceNative),
        priceUsd: Number(token.priceUsd) || null,
        mcap: Number(token.mcap) || null,
      };
    }
    // Navigating to a different token invalidates any armed intent. But a
    // pending pair address RESOLVING into its base mint is the same token
    // gaining its real identity, not a navigation: on pair-URL sites (Axiom,
    // Photon, BullX) the pending token's mint IS the pair address, and the
    // resolved record carries the base mint. Dropping the armed buy there
    // silently killed every snipe at exactly the moment the first quote
    // landed — the classic "ARMED … but nothing executed" report.
    if (token && prevMint && token.mint !== prevMint) {
      const sameTokenResolving = armedBuy
        && armedBuy.mint === prevMint
        && (token.pairAddress === prevMint || token.srcAddress === prevMint);
      if (sameTokenResolving) armedBuy.mint = token.mint;
      else armedBuy = null;
    }
    if (!token) armedBuy = null;
    void hadPrice;
    if (!token || token.mint !== prevMint) {
      // The cached card belongs to the previous token; force a rebuild.
      posEls = null;
      lastRenderedPrice = null;
    }
    if (prevMint && (!token || token.mint !== prevMint)) {
      // Release the previous token's chain subscription immediately; a stale
      // stream is both wasted bandwidth and a source of wrong-token prices.
      onchainLive = false;
      R.onchainUnwatch(prevMint);
      // The title signal is anchored to the previous token's cap; a stale
      // anchor would validate the new token's title against the wrong scale.
      stopTitleSignal();
    }
    if (token && token.mint !== prevMint) {
      series = []; marks = [];
      lastPriceAt = 0;
      lastCmTickPrice = 0;
      chartAxisBasis = null;
      if (usesNativeChart()) {
        // Padre uses its own TradingView getMarks pipeline. Clear native paper
        // marks for the previous token; do not mount the generic SVG overlay.
        sendPadreMarker('paper-marker-clear');
        sendPadreMarker('paper-lines-clear');
        if (CM) CM.destroyChartMarkers();
      } else if (CM) {
        // The generic SVG state is token-scoped. GMGN also owns native
        // TradingView average lines, so clear those before reusing its chart.
        if (site && site.id === 'gmgn') sendPadreMarker('gmgn-lines-clear');
        CM.clearMarkers();
        CM.initChartMarkers();
      }
      startPriceLoop();
    }
    if (!token) {
      stopPriceLoop();
      if (CM) CM.destroyChartMarkers();
      if (usesNativeChart()) {
        sendPadreMarker('paper-marker-clear');
        sendPadreMarker('paper-lines-clear');
      }
      if (site && site.id === 'gmgn') sendPadreMarker('gmgn-lines-clear');
    }
    renderAll();
    // The resolver may have just supplied the first quote this coin ever had.
    flushArmedBuy();
  }

  /**
   * The live-price heartbeat.
   *
   * Runs on a short fixed tick. Every beat it re-renders the position so the
   * P&L reflects the newest price, and — when the page's own feed is not
   * supplying usable ticks — issues a fresh network quote. Q.shouldRequote()
   * owns that decision so the cadence is unit-testable.
   */
  function startPriceLoop() {
    stopPriceLoop();
    priceTimer = setInterval(() => {
      if (!contextAlive()) { shutdown('invalidated'); return; }
      if (!token || !token.mint) return;

      const now = Date.now();
      const watchingHiddenProfit = Boolean(
        document.hidden && settings.profitAlertsEnabled && state.positions && state.positions[token.mint]
      );
      // Normal hidden tabs do not poll. When hidden profit bells are enabled
      // for an open position, keep a low-rate 2s safety quote in case the
      // site's own feed pauses in the background. Live Padre bars still arrive
      // event-driven and suppress this fallback entirely.
      const backgroundCadenceDue = !watchingHiddenProfit || !lastPollAt || now - lastPollAt >= 2000;
      const hiddenBlocked = document.hidden && !watchingHiddenProfit;
      if (backgroundCadenceDue && Q.shouldRequote({
        lastPriceAt, lastPollAt, inFlight: pollInFlight, hidden: hiddenBlocked,
      }, now)) {
        lastPollAt = now;
        requote();
      }

      // Re-render every beat so the P&L reflects the newest price we hold.
      // Marking is done wherever a NEW price arrives (requote / page tick),
      // so there is nothing to re-mark here.
      // Only feed chart markers if the price actually changed, to avoid
      // unnecessary SVG rebuilds on every 100ms heartbeat.
      const chartPrice = genericChartPoint(token.priceNative, token.priceUsd, token.mcap).plot;
      if (CM && !usesNativeChart() && chartPrice > 0 && chartPrice !== lastCmTickPrice) {
        lastCmTickPrice = chartPrice;
        CM.tickPrice(chartPrice);
      }
      // Armed-buy watchdog: no matter which path a price arrives by (page
      // feed, resolver, a future source), the armed intent fires on the next
      // beat — and it also EXPIRES visibly. Before this existed, an armed buy
      // could sit on "ARMED … ON FIRST QUOTE" indefinitely when the quote
      // that landed never flowed through a flushing path.
      if (armedBuy) {
        if (token && Number(token.priceNative) > 0) {
          flushArmedBuy();
        } else if (Date.now() - armedBuy.at > ARMED_BUY_TTL_MS) {
          armedBuy = null;
          renderBuyButton();
          toast('Armed buy expired — no quote arrived in time');
        }
      }
      renderHeader();
      renderPosition();
    }, PRICE_TICK_MS);
  }

  /** Fetch a fresh anchor quote and adopt it if it is for this token. */
  async function requote() {
    if (pollInFlight || !token || !token.mint) return;
    pollInFlight = true;
    const forMint = token.mint;
    try {
      const fresh = await R.refresh(token);
      // The user may have navigated while this was in flight.
      if (!token || token.mint !== forMint) return;
      if (!fresh || !(fresh.priceNative > 0)) return;
      if (fresh.mint && fresh.mint !== token.mint) return;

      // The resolver quote becomes the new anchor immediately. Live ticks
      // validate against this, so the anchor never lags behind real moves.
      token.anchor = {
        mint: token.mint,
        priceNative: Number(fresh.priceNative),
        priceUsd: Number(fresh.priceUsd) || null,
        mcap: Number(fresh.mcap) || null,
      };

      // When the page's own feed is live, the CHART owns the price level —
      // the P&L must stay pegged to what the trader sees on screen, not to
      // an aggregator's delayed quote. The network fetch then only refreshes
      // what the feed cannot supply: the SOL/USD rate and the implied
      // supply, both of which drift slowly over a session.
      const feedLive = lastPriceAt
        && Date.now() - lastPriceAt < Q.STALE_AFTER_MS
        && Number(token.priceNative) > 0
        && token.priceSource !== 'resolver';
      if (feedLive) {
        const rate = Number(fresh.priceUsd) > 0 ? fresh.priceUsd / fresh.priceNative : null;
        if (rate) token.priceUsd = token.priceNative * rate;
        if (Number(fresh.mcap) > 0 && Number(fresh.priceUsd) > 0 && Number(token.priceUsd) > 0) {
          const supply = fresh.mcap / fresh.priceUsd;
          token.mcap = token.priceUsd * supply;
        }
        persistSoon();
        renderHeader();
        renderPosition();
        return;
      }

      token.priceNative = fresh.priceNative;
      if (fresh.priceUsd) token.priceUsd = fresh.priceUsd;
      if (fresh.mcap) token.mcap = fresh.mcap;
      token.priceSource = fresh.priceSource || 'resolver';

      lastPriceAt = Date.now();
      series.push({ t: lastPriceAt, p: token.priceNative, usd: token.priceUsd });
      if (series.length > SERIES_CAP) series.shift();
      E.markPosition(state, token.mint, token.priceNative, token.priceUsd);
      maybeProfitAlert(token.mint);
      if (CM && !usesNativeChart()) CM.tickPrice(genericChartPoint(token.priceNative, token.priceUsd, token.mcap).plot);
      persistSoon();
      renderHeader();
      renderPosition();
      // The first trusted quote for a brand-new pair usually lands HERE — the
      // resolver indexes it before the site's chart feed is hookable — so an
      // armed buy must fire from this path too, or the button stays "ARMED"
      // forever while the price is plainly on screen.
      flushArmedBuy();
    } catch (e) {
      /* transient network failure; the next beat retries */
    } finally {
      pollInFlight = false;
    }
  }

  function stopPriceLoop() {
    if (priceTimer) clearInterval(priceTimer);
    priceTimer = null;
    lastPollAt = 0;
  }
  // The heartbeat is recreated per token, so it is torn down explicitly rather
  // than registered once.
  onTeardown(stopPriceLoop);

  /* -------------------- optional fun + alerts -------------------- */

  function primeAudio() {
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return null;
    try {
      if (!audioContext) audioContext = new AudioCtor();
      audioPrimed = true;
      if (audioContext.state === 'suspended' && audioContext.resume) {
        audioContext.resume().catch(() => {});
      }
      return audioContext;
    } catch (_) {
      return null;
    }
  }

  function playTone(ctx, frequency, start, duration, type, volume) {
    if (!ctx || !ctx.createOscillator || !ctx.createGain) return;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = type || 'sine';
    oscillator.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume || 0.06), start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.02);
  }

  function playTradeSound(side) {
    if (!settings.tradeSoundsEnabled) return;
    const ctx = primeAudio();
    if (!ctx) return;
    const now = ctx.currentTime + 0.01;
    if (side === 'buy') {
      // Quick ascending major arpeggio.
      playTone(ctx, 523.25, now, 0.11, 'triangle', 0.055);
      playTone(ctx, 659.25, now + 0.07, 0.12, 'triangle', 0.06);
      playTone(ctx, 783.99, now + 0.14, 0.16, 'sine', 0.07);
    } else {
      // Crisp cash-out double chirp.
      playTone(ctx, 880, now, 0.10, 'triangle', 0.055);
      playTone(ctx, 659.25, now + 0.075, 0.14, 'sine', 0.065);
      playTone(ctx, 1046.5, now + 0.14, 0.10, 'sine', 0.04);
    }
  }

  function playProfitBell() {
    if (!settings.profitAlertsEnabled || !audioPrimed) return;
    const ctx = primeAudio();
    if (!ctx) return;
    const now = ctx.currentTime + 0.01;
    // Two bell strikes with a quiet harmonic tail.
    playTone(ctx, 1046.5, now, 0.42, 'sine', 0.085);
    playTone(ctx, 1568, now, 0.30, 'sine', 0.035);
    playTone(ctx, 1174.66, now + 0.34, 0.46, 'sine', 0.09);
    playTone(ctx, 1760, now + 0.34, 0.32, 'sine', 0.035);
  }

  let effectRunId = 0;
  function runTradeEffect(side) {
    if (!settings.tradeEffectsEnabled || !els.effects) return;
    const root = els.effects;
    const runId = ++effectRunId;
    root.textContent = '';

    const flash = document.createElement('div');
    flash.className = `pt-fx-flash ${side === 'buy' ? 'buy' : 'sell'}`;
    root.appendChild(flash);

    const colors = side === 'buy'
      ? ['#3fb950', '#58d68d', '#f0883e', '#ffd166', '#ffffff']
      : ['#f85149', '#ff7b72', '#f0883e', '#ffffff', '#d29922'];
    for (let i = 0; i < 42; i++) {
      const particle = document.createElement('i');
      particle.className = 'pt-fx-particle';
      particle.style.left = `${15 + Math.random() * 70}%`;
      particle.style.top = `${25 + Math.random() * 35}%`;
      particle.style.background = colors[i % colors.length];
      particle.style.setProperty('--dx', `${(Math.random() - 0.5) * 360}px`);
      particle.style.setProperty('--dy', `${80 + Math.random() * 260}px`);
      particle.style.setProperty('--rot', `${Math.random() * 900 - 450}deg`);
      particle.style.setProperty('--delay', `${Math.random() * 120}ms`);
      particle.style.setProperty('--dur', `${650 + Math.random() * 450}ms`);
      root.appendChild(particle);
    }

    setTimeout(() => {
      if (runId === effectRunId) root.textContent = '';
    }, 1300);
  }

  function maybeProfitAlert(mint) {
    const pos = state.positions && state.positions[mint];
    if (!pos || !token || token.mint !== mint) {
      profitAlertLevels.delete(mint);
      return;
    }
    const mark = Q.positionMark(pos, token.priceNative, token.priceUsd);
    if (!mark) return;

    const interval = Math.max(1, Number(settings.profitAlertPct) || 10);
    const previous = profitAlertLevels.get(mint) || 0;
    const current = E.profitAlertLevel(mark.pnlPct, interval);

    // While visible, silently remember levels the trader already watched so
    // switching tabs cannot replay old alerts.
    if (!document.hidden) {
      if (current > previous) profitAlertLevels.set(mint, current);
      return;
    }
    if (!settings.profitAlertsEnabled) return;

    const crossed = E.crossedProfitAlert(previous, mark.pnlPct, interval);
    if (crossed === null) return;
    profitAlertLevels.set(mint, crossed);
    playProfitBell();
    toast(`${pos.symbol} crossed +${crossed * interval}% paper P&L 🔔`);
  }

  /**
   * Draw a fill on the site's own chart.
   *
   * Padre and Axiom take native TradingView marks; GMGN takes a native
   * execution shape positioned on its market-cap axis. Only sites with no
   * usable chart API fall back to the SVG overlay, because a native shape is
   * the only thing that stays glued to its candle through pan and zoom.
   */
  function drawFillOnChart(fill) {
    const markerTs = fill.ts;
    const point = genericChartPoint(fill.priceNative, fill.priceUsd, fill.mcap);

    if (usesNativeChart()) {
      sendPadreMarker('paper-marker', {
        ts: markerTs,
        priceNative: fill.priceNative,
        // The bridge picks whichever of these magnitudes matches the site
        // chart's Y axis (token USD price vs market cap) when it has to draw
        // the fill as a Y-anchored execution shape.
        priceUsd: fill.priceUsd || null,
        mcap: point.currency === 'MCAP' ? point.display : null,
        side: fill.side,
        solAmount: fill.solAmount,
        symbol: token && token.symbol,
      });
      return;
    }

    if (site && site.id === 'gmgn') {
      sendPadreMarker('gmgn-marker', {
        ts: markerTs,
        mcap: point.currency === 'MCAP' ? point.display : null,
        side: fill.side,
        text: `${fill.side === 'buy' ? 'PT Buy' : 'PT Sell'} ${Q.formatMarketCap(point.display)}`,
      });
      return;
    }

    if (CM) {
      CM.addMarker({
        ts: markerTs,
        price: point.plot,
        displayPrice: point.display,
        side: fill.side,
        solAmount: fill.solAmount,
        symbol: token && token.symbol,
        currency: point.currency,
      });
    }
  }

  /* -------------------- page-title market-cap signal -------------------- */

  let stopTitleListener = null;

  /**
   * Watch the site's own title for market-cap changes.
   *
   * This is a display accelerator, not a price source. The cap it produces is
   * validated against the market cap chain state already established, so a
   * mis-parse cannot move the number on screen, and it never touches a fill.
   */
  function startTitleSignal() {
    if (!TF || !site) return;
    stopTitleSignal();
    stopTitleListener = TF.onMarketCap((mcap) => {
      if (!token || !(mcap > 0)) return;
      // Supply is constant over a trade, so a cap move IS a price move. Scale
      // the held price by the same ratio to keep every figure consistent.
      const previous = Number(token.mcap);
      if (previous > 0 && Number(token.priceNative) > 0) {
        const ratio = mcap / previous;
        token.priceNative = Number(token.priceNative) * ratio;
        if (Number(token.priceUsd) > 0) token.priceUsd = Number(token.priceUsd) * ratio;
      }
      token.mcap = mcap;
      renderHeader();
      renderPosition();
    });
    TF.start(site.id, () => (token && Number(token.mcap) > 0 ? Number(token.mcap) : null));
  }

  function stopTitleSignal() {
    if (stopTitleListener) { stopTitleListener(); stopTitleListener = null; }
    if (TF) TF.stop();
  }
  onTeardown(stopTitleSignal);

  /* -------------------- action-time quotes and fills -------------------- */

  // A displayed price is not automatically a tradeable price. A trade gets a
  // page quote only if it was received within this window; otherwise it waits
  // briefly for the site's live feed, then performs one direct resolver quote.
  const ACTION_QUOTE_MAX_AGE_MS = 350;
  const ACTION_PAGE_WAIT_MS = 175;
  // A fresh-launch coin has no Dexscreener/Jupiter quote yet, so the on-screen
  // price is the only price. Keep it tradeable a little longer while pending.
  const PENDING_ACTION_MAX_AGE_MS = 2000;
  // When the resolver is momentarily unavailable (new launch, just migrated,
  // network hiccup), the on-screen price is still better than refusing the
  // trade entirely, as long as it is not ancient.
  const ACTION_FALLBACK_MAX_AGE_MS = 10000;

  function quoteSnapshot() {
    if (!token || !(Number(token.priceNative) > 0)) return null;
    return {
      mint: token.mint,
      priceNative: Number(token.priceNative),
      priceUsd: Number(token.priceUsd) > 0 ? Number(token.priceUsd) : null,
      mcap: Number(token.mcap) > 0 ? Number(token.mcap) : null,
      source: token.priceSource || 'unknown',
      receivedAt: lastPriceAt,
    };
  }

  function waitForNewPageQuote(afterSeq, timeoutMs) {
    if (pageQuoteSeq > afterSeq) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = () => { pageQuoteWaiters.delete(done); resolve(pageQuoteSeq > afterSeq); };
      pageQuoteWaiters.add(done);
      setTimeout(done, timeoutMs);
    });
  }

  /**
   * Convert a live on-chain observation into a fill-ready quote.
   *
   * The chain gives a SOL-denominated price. USD and market cap are derived
   * from the same observation using the SOL/USD and supply ratios the resolver
   * already established, so the fill, the panel, the marker and the average
   * line can never disagree with each other.
   */
  function quoteFromOnchain(observation) {
    if (!observation || !(observation.priceNative > 0)) return null;
    if (!token || token.mint !== observation.mint) return null;

    const anchorNative = Number(token.priceNative);
    const anchorUsd = Number(token.priceUsd);
    const usdPerSol = anchorNative > 0 && anchorUsd > 0 ? anchorUsd / anchorNative : null;
    const priceUsd = usdPerSol ? observation.priceNative * usdPerSol : null;

    const anchorMcap = Number(token.mcap);
    const mcap = anchorMcap > 0 && anchorUsd > 0 && priceUsd
      ? anchorMcap * (priceUsd / anchorUsd)
      : null;

    return {
      mint: observation.mint,
      priceNative: observation.priceNative,
      priceUsd,
      mcap,
      slot: observation.slot,
      source: 'onchain',
      receivedAt: observation.observedAt,
    };
  }

  async function quoteForTrade() {
    const startMint = token && token.mint;
    if (!startMint) return null;

    // Chain state is the authority. It is the only source that is not behind
    // by construction, so it is asked first and trusted absolutely.
    const observation = await R.onchainQuote(startMint);
    const onchain = quoteFromOnchain(observation);
    if (onchain) return onchain;

    const initial = quoteSnapshot();
    if (initial && Date.now() - initial.receivedAt <= ACTION_QUOTE_MAX_AGE_MS) return initial;

    const seqAtClick = pageQuoteSeq;
    // Prefer an imminent site-feed update (Padre bar / GMGN worker) over an
    // aggregator response because it is the price represented by that chart.
    await waitForNewPageQuote(seqAtClick, ACTION_PAGE_WAIT_MS);
    if (!token || token.mint !== startMint) return null;
    const pageQuote = quoteSnapshot();
    if (pageQuote && pageQuoteSeq > seqAtClick && Date.now() - pageQuote.receivedAt <= ACTION_QUOTE_MAX_AGE_MS) {
      return pageQuote;
    }

    // The feed is quiet. Take exactly one action-time resolver quote rather
    // than filling from the stale display snapshot. If the page ticks while it
    // is in flight, the newer page quote wins.
    const fresh = await R.refresh(token);
    if (!token || token.mint !== startMint) return null;

    // A new coin or a freshly-migrated coin may not be re-indexed by the
    // aggregator yet. The on-screen price is the only truthful quote we have,
    // so use it for a little longer rather than refusing the buy entirely.
    // This also covers a transient resolver outage for page-driven feeds.
    const displayPriceOnly = token.pending || token.priceSource !== 'resolver';
    if (displayPriceOnly) {
      if (pageQuoteSeq > seqAtClick) {
        const newerPageQuote = quoteSnapshot();
        if (newerPageQuote && Date.now() - newerPageQuote.receivedAt <= ACTION_FALLBACK_MAX_AGE_MS) return newerPageQuote;
      }
      const stalePageQuote = quoteSnapshot();
      if (stalePageQuote && Date.now() - stalePageQuote.receivedAt <= ACTION_FALLBACK_MAX_AGE_MS) return stalePageQuote;
    }

    if (!fresh || !(Number(fresh.priceNative) > 0)) return null;
    if (fresh.mint && fresh.mint !== startMint) return null;
    if (pageQuoteSeq > seqAtClick) {
      const newerPageQuote = quoteSnapshot();
      if (newerPageQuote && Date.now() - newerPageQuote.receivedAt <= ACTION_QUOTE_MAX_AGE_MS) return newerPageQuote;
    }

    // Keep GMGN's chart-scale market cap from its own market-cap feed when it
    // is available; Dexscreener is the fallback quote, not the chart authority.
    const inheritedMcap = site && site.id === 'gmgn' && Number(token.mcap) > 0 && Number(token.priceUsd) > 0 && Number(fresh.priceUsd) > 0
      ? Number(token.mcap) * (Number(fresh.priceUsd) / Number(token.priceUsd))
      : Number(fresh.mcap) || null;
    return {
      mint: startMint,
      priceNative: Number(fresh.priceNative),
      priceUsd: Number(fresh.priceUsd) > 0 ? Number(fresh.priceUsd) : null,
      mcap: inheritedMcap,
      source: 'action-resolver',
      receivedAt: Date.now(),
    };
  }

  /* -------------------- fills -------------------- */

  let mutationChain = Promise.resolve();
  function withState(fn) {
    mutationChain = mutationChain.then(async () => { await reloadState(); return fn(); }).catch(() => {});
    return mutationChain;
  }

  async function reloadState() {
    const stored = await store.get([E.STORAGE_KEYS.state, E.STORAGE_KEYS.settings]);
    // A failed read (null) must keep whatever state we already hold: swapping
    // in a fresh default here is how a transient storage error silently wipes
    // every open position — and the next heartbeat mark persists that wipe.
    if (stored === null) return;
    settings = E.mergeSettings(stored[E.STORAGE_KEYS.settings]);
    // A missing state key means "never stored"; the in-memory default is
    // already the correct value for that case, so never fabricate over a
    // state this session has since populated.
    if (stored[E.STORAGE_KEYS.state]) state = stored[E.STORAGE_KEYS.state];
  }

  /**
   * Adopt wallet state written elsewhere and re-render everything that
   * depends on it. Shared by the storage listener and the contention guard in
   * persistSoon, so both paths refresh the UI identically.
   */
  function adoptState(next) {
    const hadPosition = Boolean(token && state.positions && state.positions[token.mint]);
    state = next;
    const hasPosition = Boolean(token && state.positions && state.positions[token.mint]);
    // The card's structure only changes when a position appears or vanishes.
    if (hadPosition !== hasPosition) posEls = null;

    renderBalance();
    renderPosition();
    renderClosedPnl();
    // A fill in ANOTHER tab changes the portfolio too; without this the bar
    // would keep showing a chip for a position that is already closed.
    renderPositionsBar();
    syncAveragePriceLines();
  }

  /**
   * Stamp the current state as the newest version and write it.
   *
   * `seq` is a monotonic write counter: every writer bumps it, and a writer
   * holding an older base can tell it has been overtaken (see persistSoon).
   * That is what stops a tab whose adoption lagged from blindly clobbering a
   * fresher wallet — the failure that made open positions, and therefore the
   * quick-sell buttons, disappear.
   */
  function persistStateNow() {
    state.seq = (Number(state.seq) || 0) + 1;
    state.updatedAt = Date.now();
    lastWrittenState = state;
    return store.set({ [E.STORAGE_KEYS.state]: state });
  }

  /**
   * Adopt wallet state written elsewhere (another tab, the popup, the
   * dashboard) so the position card and balance never show stale figures.
   *
   * Writes we originated are tagged and skipped, rather than gating on a
   * pending-write timer: the heartbeat persists marks continuously, so a timer
   * guard would suppress external updates almost permanently.
   */
  function watchStorage() {
    if (!contextAlive() || !chrome.storage || !chrome.storage.onChanged) return;
    const listener = (changes, area) => {
      if (contextDead || area !== 'local') return;

      const settingsChange = changes[E.STORAGE_KEYS.settings];
      if (settingsChange && settingsChange.newValue) {
        settings = E.mergeSettings(settingsChange.newValue);
        if (settings.overlayEnabled) enableOverlay().catch(() => {});
        else disableOverlay();
        if (els.buyPresets) renderPresets();
        syncAveragePriceLines();
        updateOverlayVisibility();
        applyOverlaySize();
      }

      const stateChange = changes[E.STORAGE_KEYS.state];
      if (!stateChange) return;
      const next = stateChange.newValue;
      if (!next || next === state) return;
      if (lastWrittenState && next === lastWrittenState) return; // our own write

      adoptState(next);
    };
    chrome.storage.onChanged.addListener(listener);
    onTeardown(() => {
      try { chrome.storage.onChanged.removeListener(listener); } catch (_) {}
    });
  }

  /**
   * Restore chart markers for the current token from the journal history.
   * Called after the token is resolved and state is loaded, so a page reload
   * doesn't lose the visual trade history.
   */
  function restoreMarkersFromJournal() {
    if (!token || !token.mint) return;
    const fills = (state.journal || []).filter(
      (t) => t.mint === token.mint && (t.side === 'buy' || t.side === 'sell')
    ).reverse(); // journal is newest-first; we want chronological
    for (const f of fills) {
      drawFillOnChart({
        ts: f.ts,
        side: f.side,
        priceNative: f.priceNative,
        priceUsd: f.priceUsd,
        mcap: f.mcap,
        solAmount: f.solGross,
      });
    }
  }

  function syncAveragePriceLines() {
    if (!settings.averagePriceLinesEnabled || !token || !token.mint) {
      if (usesNativeChart()) sendPadreMarker('paper-lines-clear');
      if (site && site.id === 'gmgn') sendPadreMarker('gmgn-lines-clear');
      if (CM && site && !usesNativeChart()) CM.clearAverageLines();
      return;
    }

    const averages = E.averageFillPrices(state, token.mint);
    if (!averages) {
      if (usesNativeChart()) sendPadreMarker('paper-lines-clear');
      if (site && site.id === 'gmgn') sendPadreMarker('gmgn-lines-clear');
      if (CM && site && !usesNativeChart()) CM.clearAverageLines();
      return;
    }

    const usdPerNative = Number(token.priceUsd) > 0 && Number(token.priceNative) > 0
      ? Number(token.priceUsd) / Number(token.priceNative)
      : null;
    const avgBuyUsd = Number(averages.avgBuyUsd) > 0
      ? averages.avgBuyUsd
      : (usdPerNative && Number(averages.avgBuyNative) > 0 ? averages.avgBuyNative * usdPerNative : null);
    const avgSellUsd = Number(averages.avgSellUsd) > 0
      ? averages.avgSellUsd
      : (usdPerNative && Number(averages.avgSellNative) > 0 ? averages.avgSellNative * usdPerNative : null);

    // Padre uses its native TradingView bridge for lines
    if (usesNativeChart()) {
      // Include the market-cap equivalents: Axiom (and Padre) can chart either
      // token USD price or market cap, and the bridge matches the line level
      // to the live bar close so it lands on the visible axis.
      const nativeSupply = Number(token.mcap) > 0 && Number(token.priceUsd) > 0
        ? Number(token.mcap) / Number(token.priceUsd)
        : null;
      sendPadreMarker('paper-lines', {
        enabled: true,
        // Ground truth from the live chart ticks: draw in exactly the unit
        // the chart's Y axis is showing (price vs MC, USD vs SOL).
        axisBasis: chartAxisBasis,
        currentPriceNative: token.priceNative,
        currentPriceUsd: token.priceUsd,
        avgBuyUsd,
        avgSellUsd,
        avgBuyMcap: nativeSupply && avgBuyUsd ? avgBuyUsd * nativeSupply : null,
        avgSellMcap: nativeSupply && avgSellUsd ? avgSellUsd * nativeSupply : null,
        // Axiom's chart can also be SOL-denominated (its USD/SOL toggle), so
        // the SOL price and the SOL-valued market cap go along as candidates;
        // the bridge picks whichever magnitude matches the live bar close.
        avgBuyNative: Number(averages.avgBuyNative) > 0
          ? averages.avgBuyNative
          : (usdPerNative && avgBuyUsd ? avgBuyUsd / usdPerNative : null),
        avgSellNative: Number(averages.avgSellNative) > 0
          ? averages.avgSellNative
          : (usdPerNative && avgSellUsd ? avgSellUsd / usdPerNative : null),
        avgBuyMcapNative: nativeSupply && Number(averages.avgBuyNative) > 0
          ? averages.avgBuyNative * nativeSupply
          : null,
        avgSellMcapNative: nativeSupply && Number(averages.avgSellNative) > 0
          ? averages.avgSellNative * nativeSupply
          : null,
      });
    }

    if (CM && !usesNativeChart()) {
      if (site && site.id === 'gmgn') {
        // GMGN's TradingView symbol ends in `/USD/MCAP`: its Y axis is market
        // cap. Scale the USD fill prices by GMGN's live implied supply, but
        // retain the true average token price in the line label.
        const supply = Number(token.mcap) > 0 && Number(token.priceUsd) > 0
          ? Number(token.mcap) / Number(token.priceUsd)
          : null;
        if (supply) {
          // GMGN's own chart manager is available through its React-held
          // TradingView instance. Ask the MAIN-world bridge to use native
          // order lines so panning, zooming, and auto-scale stay exact.
          sendPadreMarker('gmgn-lines', {
            enabled: true,
            avgBuyMcap: avgBuyUsd ? avgBuyUsd * supply : null,
            avgSellMcap: avgSellUsd ? avgSellUsd * supply : null,
            // GMGN's axis IS market cap, so the label states the cap the line
            // sits at — the same figure the trader would quote out loud.
            avgBuyText: avgBuyUsd ? `PT Avg Buy ${Q.formatMarketCap(avgBuyUsd * supply)}` : '',
            avgSellText: avgSellUsd ? `PT Avg Sell ${Q.formatMarketCap(avgSellUsd * supply)}` : '',
          });
          CM.clearAverageLines();
        } else {
          sendPadreMarker('gmgn-lines-clear');
          CM.clearAverageLines();
        }
      } else {
        // Non-GMGN generic adapters plot USD token price, but the LABEL still
        // reads in market cap so it matches how the entry is discussed.
        const supply = Number(token.mcap) > 0 && Number(token.priceUsd) > 0
          ? Number(token.mcap) / Number(token.priceUsd)
          : null;
        CM.setAverageLines({
          avgBuyPrice: avgBuyUsd,
          avgSellPrice: avgSellUsd,
          avgBuyLabel: supply && avgBuyUsd ? avgBuyUsd * supply : avgBuyUsd,
          avgSellLabel: supply && avgSellUsd ? avgSellUsd * supply : avgSellUsd,
          currency: supply ? 'MCAP' : 'USD',
        });
      }
    }
  }

  let persistTimer = null;
  let lastWrittenState = null;
  function persistSoon() {
    if (persistTimer) return;
    persistTimer = setTimeout(async () => {
      persistTimer = null;
      if (!contextAlive()) { shutdown('invalidated'); return; }
      // This writer is blind: it debounces marks and knows nothing about what
      // happened during the wait. If another tab/popup/dashboard wrote a newer
      // state in the meantime (and the adoption event was missed or is still
      // racing), writing our copy would clobber it — that is exactly how an
      // open position silently vanished. Read first; when storage is ahead,
      // adopt it and re-apply only the live marks this tab actually owns.
      const stored = await store.get([E.STORAGE_KEYS.state]);
      if (stored === null) return; // storage unreadable: never write blind
      const storedState = stored[E.STORAGE_KEYS.state];
      if (storedState && Number(storedState.seq) > Number(state.seq)) {
        adoptState(storedState);
        if (token && token.mint && Number(token.priceNative) > 0) {
          E.markPosition(state, token.mint, token.priceNative, token.priceUsd);
        }
        for (const mint of Object.keys(livePositionPrices)) {
          const p = livePositionPrices[mint];
          if (p && Number(p.priceNative) > 0) E.markPosition(state, mint, p.priceNative, p.priceUsd);
        }
      }
      await persistStateNow();
    }, 800);
  }

  // Re-entrancy guard: an instant preset tap (or a double-click) while a buy
  // is still pricing must not stack a second fill on top of the first.
  let buyInFlight = false;

  /**
   * Every buy — the big BUY button or a one-click preset tap — comes through
   * here so the pending-token arming and the in-flight guard apply equally.
   */
  function requestBuy(amt) {
    if (!(amt > 0)) return toast('Pick a SOL amount first');
    if (buyInFlight) return toast('Buy already in progress…');
    primeAudio();

    // A brand-new coin may still be resolving. Rather than refusing the
    // click — which reads as broken — arm the buy and fire it the moment a
    // trusted price lands. This is the difference between "buggy" and
    // "waiting", and it is what makes sniping a fresh launch feel possible.
    if (!token || !token.priceNative) {
      if (!token) return toast('No token detected on this page');
      armedBuy = { amount: amt, at: Date.now(), mint: token.mint };
      renderBuyButton();
      toast('Buy armed — fires the instant the first quote lands');
      return;
    }
    buyInFlight = true;
    doBuy(amt).finally(() => { buyInFlight = false; });
  }

  async function doBuy(solAmount) {
    if (!token) return toast('No token detected on this page');
    const fillQuote = await quoteForTrade();
    if (!fillQuote) return toast('Could not obtain a fresh price — paper buy not filled.');
    try {
      const result = await withState(async () => {
        if (!token || token.mint !== fillQuote.mint) throw new Error('Token changed before the paper buy could be filled');
        const hadPosition = Boolean(state.positions[token.mint]);
        const { trade, position } = E.buy(state, settings, {
          ts: Date.now(), mint: token.mint, pairAddress: token.pairAddress,
          symbol: token.symbol, name: token.name, site: site.id,
          priceNative: fillQuote.priceNative, priceUsd: fillQuote.priceUsd, mcap: fillQuote.mcap,
          solAmount,
        });
        // Commit the fill to the evidence chain before persisting, so the
        // stored snapshot and its attestation are written atomically.
        await commitFill(trade);
        await persistStateNow();
        const markerTs = Date.now();
        marks.push({ t: markerTs, p: trade.priceNative, side: 'buy' });
        drawFillOnChart({
          ts: markerTs,
          side: 'buy',
          priceNative: trade.priceNative,
          priceUsd: trade.priceUsd,
          mcap: trade.mcap,
          solAmount,
        });
        syncAveragePriceLines();
        if (!hadPosition) profitAlertLevels.set(token.mint, 0);
        return { trade, position, opened: !hadPosition };
      });
      if (result) {
        sendMessage({
          type: 'pt_trade_event',
          kind: 'buy',
          opened: result.opened,
          session: summarizeSession(result.position),
          trade: summarizeTrade(result.trade),
        }).catch(() => {});
        runTradeEffect('buy');
        playTradeSound('buy');
        // Confirm the fill in the unit the trader thinks in: "at 240K".
        const atMcap = mcapAtPrice(result.trade.priceNative);
        toast(`Bought ${E.fmt(solAmount, 3)} SOL of ${token.symbol}${atMcap ? ` at ${fmtMoney(atMcap)} MC` : ''} (paper)`);
      }
    } catch (err) { toast(err.message || 'Buy failed'); }
    renderAll();
  }

  async function doSell(fraction) {
    if (!token) return toast('No token detected on this page');
    const fillQuote = await quoteForTrade();
    if (!fillQuote) return toast('Could not obtain a fresh price — paper sell not filled.');
    try {
      const result = await withState(async () => {
        if (!token || token.mint !== fillQuote.mint) throw new Error('Token changed before the paper sell could be filled');
        const { trade, position, round } = E.sell(state, settings, {
          ts: Date.now(), mint: token.mint, site: site.id,
          qtyFraction: fraction, priceNative: fillQuote.priceNative, priceUsd: fillQuote.priceUsd, mcap: fillQuote.mcap,
        });
        await commitFill(trade);
        await persistStateNow();
        const markerTs = Date.now();
        marks.push({ t: markerTs, p: trade.priceNative, side: 'sell' });
        drawFillOnChart({
          ts: markerTs,
          side: 'sell',
          priceNative: trade.priceNative,
          priceUsd: trade.priceUsd,
          mcap: trade.mcap,
          solAmount: trade.solGross,
        });
        syncAveragePriceLines();
        if (round) profitAlertLevels.delete(token.mint);
        return { trade, position, round };
      });
      if (result) {
        sendMessage({
          type: 'pt_trade_event',
          kind: 'sell',
          opened: false,
          session: summarizeSession(result.round || result.position),
          trade: summarizeTrade(result.trade),
          round: result.round ? summarizeRound(result.round) : null,
        }).catch(() => {});
        runTradeEffect('sell');
        playTradeSound('sell');
        const pnl = result.trade.pnlSol;
        const exitMcap = mcapAtPrice(result.trade.priceNative);
        toast(`Sold ${Math.round(fraction * 100)}%${exitMcap ? ` at ${fmtMoney(exitMcap)} MC` : ''} — ${pnl >= 0 ? '+' : ''}${E.fmt(pnl)} SOL paper`);
        if (result.round) toast(`Round closed: ${result.round.pnlSol >= 0 ? '+' : ''}${E.fmt(result.round.pnlSol)} SOL (${result.round.pnlPct.toFixed(1)}%)`);
      }
    } catch (err) { toast(err.message || 'Sell failed'); }
    renderAll();
  }

  function summarizeSession(value) {
    if (!value) return null;
    return {
      sessionId: value.sessionId,
      roundId: value.id || value.roundId || null,
      mint: value.mint,
      symbol: value.symbol,
      name: value.name || token?.name || '',
      site: value.site || site?.id || 'unknown',
      openedAt: value.openedAt,
      closedAt: value.closedAt || null,
    };
  }

  function summarizeTrade(t) {
    return {
      id: t.id,
      sessionId: t.sessionId,
      ts: t.ts,
      side: t.side,
      mint: t.mint,
      symbol: t.symbol,
      qty: t.qty,
      priceNative: t.priceNative,
      priceUsd: t.priceUsd,
      solGross: t.solGross,
      solNet: t.solNet,
      feeSol: t.feeSol,
      pnlSol: t.pnlSol,
      mcap: t.mcap,
    };
  }

  function summarizeRound(r) {
    return {
      id: r.id,
      sessionId: r.sessionId,
      mint: r.mint,
      symbol: r.symbol,
      name: r.name || '',
      site: r.site,
      openedAt: r.openedAt,
      closedAt: r.closedAt,
      heldMs: r.heldMs,
      investedSol: r.investedSol,
      returnedSol: r.returnedSol,
      pnlSol: r.pnlSol,
      pnlPct: r.pnlPct,
    };
  }

  /* -------------------- UI -------------------- */

  /* Inline SVG beats emoji: it inherits currentColor, stays crisp at any DPI,
   * and renders identically across every host site's font stack. */
  const ICONS = {
    chart: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M18.7 8 13 13.7l-3-3L6.3 14.4"/></svg>',
    minimize: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 12h14"/></svg>',
    grip: '<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><circle cx="2.5" cy="2.5" r="1.2"/><circle cx="7.5" cy="2.5" r="1.2"/><circle cx="2.5" cy="6" r="1.2"/><circle cx="7.5" cy="6" r="1.2"/><circle cx="2.5" cy="9.5" r="1.2"/><circle cx="7.5" cy="9.5" r="1.2"/></svg>',
    eye: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
    'eye-off': '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.7 0 0 1 12 19c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94m2.8-2.8A16.46 16.46 0 0 1 21.94 4.06 18.45 18.45 0 0 1 23 12s-4 8-11 8a12.92 12.92 0 0 1-6.06-1.06M1 1l22 22"/></svg>',
    resize: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15l-6 6M16 10l-9 9M3 21V3h18"/></svg>',
  };

  const CSS = `
    /* ============================================================
       PaperTrench overlay — design system
       Tokens first, then components. Every number uses tabular
       figures so digits never jitter as prices tick.
       ============================================================ */
    :host {
      all: initial;
      --pt-void: #07090D;
      --pt-bg: #0B0E14;
      --pt-surface: rgba(20, 24, 32, 0.86);
      --pt-raised: rgba(30, 36, 47, 0.72);
      --pt-line: rgba(255, 255, 255, 0.07);
      --pt-line-2: rgba(255, 255, 255, 0.13);
      --pt-text: #EAEFF7;
      --pt-dim: #8D97A9;
      --pt-faint: #5A6273;
      --pt-amber: #FF9D45;
      --pt-amber-soft: rgba(255, 157, 69, 0.16);
      --pt-green: #34D399;
      --pt-green-soft: rgba(52, 211, 153, 0.15);
      --pt-red: #FF5F56;
      --pt-red-soft: rgba(255, 95, 86, 0.15);
      --pt-r-lg: 18px;
      --pt-r-md: 12px;
      --pt-r-sm: 9px;
      --pt-ease: cubic-bezier(0.16, 1, 0.3, 1);
      --pt-sans: ui-sans-serif, -apple-system, "Segoe UI", Inter, Roboto, sans-serif;
      --pt-mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace;
    }

    * { box-sizing: border-box; }
    button { font-family: inherit; }

    .pt-wrap {
      font-family: var(--pt-sans);
      font-size: 13px;
      line-height: 1.45;
      -webkit-font-smoothing: antialiased;
      font-variant-numeric: tabular-nums;
    }

    /* ---------------- panel shell ---------------- */

    .pt-box {
      position: fixed; top: 84px; right: 18px; z-index: 2147483647;
      width: 336px;
      min-width: 260px; max-width: 560px;
      min-height: 320px; max-height: 820px;
      color: var(--pt-text);
      background:
        radial-gradient(120% 90% at 50% -10%, rgba(255, 157, 69, 0.10), transparent 62%),
        linear-gradient(180deg, rgba(17, 21, 28, 0.96), rgba(9, 11, 16, 0.97));
      backdrop-filter: blur(20px) saturate(140%);
      -webkit-backdrop-filter: blur(20px) saturate(140%);
      border-radius: var(--pt-r-lg);
      box-shadow:
        0 32px 70px -18px rgba(0, 0, 0, 0.85),
        0 8px 24px -8px rgba(0, 0, 0, 0.6),
        inset 0 1px 0 rgba(255, 255, 255, 0.06);
      display: flex; flex-direction: column;
      overflow: hidden;
      animation: pt-enter 0.42s var(--pt-ease) both;
    }
    /* Hairline gradient rim — the "expensive" edge. */
    .pt-box::before {
      content: ''; position: absolute; inset: 0; z-index: 4;
      border-radius: inherit; padding: 1px; pointer-events: none;
      background: linear-gradient(150deg,
        rgba(255, 157, 69, 0.75), rgba(255, 157, 69, 0.14) 34%,
        rgba(255, 255, 255, 0.07) 62%, rgba(255, 157, 69, 0.42));
      -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
      -webkit-mask-composite: xor;
      mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
      mask-composite: exclude;
    }
    @keyframes pt-enter {
      from { opacity: 0; transform: translateY(-10px) scale(0.975); }
      to   { opacity: 1; transform: none; }
    }
    .pt-resize {
      position: absolute; right: 4px; bottom: 4px; z-index: 6;
      width: 18px; height: 18px;
      display: flex; align-items: flex-end; justify-content: flex-end;
      color: rgba(255, 157, 69, 0.45);
      cursor: nwse-resize; pointer-events: auto;
      transition: color 0.12s;
    }
    .pt-resize:hover { color: var(--pt-amber); }
    .pt-resize:active { color: #fff; }

    .pt-watermark {
      position: absolute; top: 50%; left: 50%;
      transform: translate(-50%, -50%) rotate(-20deg);
      font-size: 62px; font-weight: 900; letter-spacing: 6px; white-space: nowrap;
      color: transparent;
      -webkit-text-stroke: 1.5px rgba(255, 157, 69, 0.07);
      pointer-events: none; z-index: 0;
    }

    /* ---------------- paper banner ---------------- */

    .pt-banner {
      position: relative; z-index: 2;
      display: flex; align-items: center; justify-content: center; gap: 7px;
      padding: 6px 10px;
      background: linear-gradient(90deg, rgba(255, 157, 69, 0.14), rgba(255, 157, 69, 0.28), rgba(255, 157, 69, 0.14));
      border-bottom: 1px solid rgba(255, 157, 69, 0.24);
      color: #FFC790;
      font-size: 9.5px; font-weight: 800; letter-spacing: 1.6px; text-transform: uppercase;
      overflow: hidden;
    }
    .pt-banner::after {
      content: ''; position: absolute; inset: 0;
      background: linear-gradient(105deg, transparent 30%, rgba(255, 255, 255, 0.16) 50%, transparent 70%);
      transform: translateX(-100%);
      animation: pt-sheen 5.5s ease-in-out infinite;
    }
    @keyframes pt-sheen {
      0%, 62% { transform: translateX(-100%); }
      100% { transform: translateX(100%); }
    }
    .pt-banner b { font-weight: 900; letter-spacing: 1.6px; }

    /* ---------------- header ---------------- */

    .pt-header {
      position: relative; z-index: 2;
      display: flex; align-items: center; gap: 10px;
      padding: 11px 12px 10px;
      border-bottom: 1px solid var(--pt-line);
      cursor: grab; user-select: none;
    }
    .pt-header:active { cursor: grabbing; }
    .pt-icon {
      width: 30px; height: 30px; border-radius: 10px; flex: none;
      display: flex; align-items: center; justify-content: center;
      font-size: 14px; font-weight: 900; color: #2A1400;
      background: linear-gradient(145deg, #FFC081, var(--pt-amber) 55%, #E77B22);
      box-shadow: 0 4px 14px rgba(255, 157, 69, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.45);
    }
    .pt-title { font-weight: 750; font-size: 13.5px; letter-spacing: -0.15px; min-width: 0; }
    .pt-title .sub {
      display: block; margin-top: 1px;
      font-size: 10px; font-weight: 500; color: var(--pt-faint);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .pt-grow { flex: 1; }
    .pt-hbtn {
      display: flex; align-items: center; justify-content: center;
      width: 26px; height: 26px; padding: 0;
      background: transparent; border: 1px solid transparent; border-radius: 8px;
      color: var(--pt-faint); font-size: 13px; cursor: pointer;
      transition: background 0.16s, color 0.16s, border-color 0.16s, transform 0.16s;
    }
    .pt-hbtn:hover { background: var(--pt-raised); border-color: var(--pt-line-2); color: var(--pt-text); }
    .pt-hbtn:active { transform: scale(0.92); }

    /* ---------------- body ---------------- */

    .pt-body {
      position: relative; z-index: 2; padding: 13px 12px 14px;
      flex: 1; min-height: 0; overflow-y: auto;
    }

    .pt-token-row {
      display: flex; align-items: flex-start; justify-content: space-between; gap: 10px;
      margin-bottom: 11px;
    }
    .pt-token { flex: 1; min-width: 0; }
    .pt-token > div:first-child {
      font-size: 17px; font-weight: 800; letter-spacing: -0.3px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%;
    }
    .pt-mint {
      display: inline-block; margin-top: 4px; padding: 2px 7px;
      max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-family: var(--pt-mono); font-size: 9.5px; font-weight: 500; color: var(--pt-dim);
      background: var(--pt-raised); border: 1px solid var(--pt-line);
      border-radius: 999px;
    }
    .pt-price { text-align: right; flex: none; }
    .pt-price .num {
      font-size: 15px; font-weight: 800; letter-spacing: -0.3px;
      font-family: var(--pt-mono);
      transition: color 0.2s;
    }
    .pt-price .usd { margin-top: 3px; font-size: 10.5px; color: var(--pt-dim); }
    .pt-price-stale { color: var(--pt-amber) !important; }

    /* live sparkline */
    .pt-spark { height: 26px; margin: 0 0 11px; opacity: 0.95; }
    .pt-spark svg { display: block; width: 100%; height: 26px; overflow: visible; }
    .pt-spark:empty { display: none; }

    /* ---------------- balance hero ---------------- */

    .pt-balance {
      position: relative; overflow: hidden;
      padding: 11px 13px; margin-bottom: 13px;
      background: linear-gradient(135deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.015));
      border: 1px solid var(--pt-line); border-radius: var(--pt-r-md);
    }
    .pt-balance .lab {
      display: flex; align-items: center; gap: 6px;
      font-size: 9.5px; font-weight: 700; letter-spacing: 1.1px; text-transform: uppercase;
      color: var(--pt-faint);
    }
    .pt-balance .amt {
      margin-top: 3px;
      font-size: 23px; font-weight: 800; letter-spacing: -0.7px;
      font-feature-settings: "tnum";
    }
    .pt-delta { margin-top: 2px; font-size: 11px; font-weight: 650; color: var(--pt-dim); }

    /* live status dot */
    .pt-dot {
      width: 6px; height: 6px; border-radius: 50%; flex: none;
      background: var(--pt-faint); box-shadow: 0 0 0 0 transparent;
    }
    .pt-dot.on { background: var(--pt-green); animation: pt-pulse 2.1s ease-out infinite; }
    .pt-dot.warn { background: var(--pt-amber); }
    @keyframes pt-pulse {
      0% { box-shadow: 0 0 0 0 rgba(52, 211, 153, 0.5); }
      70% { box-shadow: 0 0 0 7px rgba(52, 211, 153, 0); }
      100% { box-shadow: 0 0 0 0 rgba(52, 211, 153, 0); }
    }

    /* ---------------- labels ---------------- */

    .pt-label {
      display: flex; align-items: center; justify-content: space-between;
      margin: 12px 0 7px;
      font-size: 9.5px; font-weight: 700; letter-spacing: 1.1px; text-transform: uppercase;
      color: var(--pt-faint);
    }

    /* ---------------- presets ---------------- */

    .pt-presets {
      display: grid; grid-template-columns: repeat(4, 1fr); gap: 5px;
      padding: 4px; border-radius: var(--pt-r-md);
      background: rgba(0, 0, 0, 0.32); border: 1px solid var(--pt-line);
    }
    .pt-preset {
      position: relative;
      padding: 8px 2px; border: 1px solid transparent; border-radius: var(--pt-r-sm);
      background: transparent; color: var(--pt-dim);
      font-size: 11.5px; font-weight: 750; text-align: center; cursor: pointer;
      transition: color 0.16s, background 0.16s, border-color 0.16s, transform 0.12s;
    }
    .pt-preset:hover { color: var(--pt-text); background: var(--pt-raised); }
    .pt-preset:active { transform: scale(0.95); }
    .pt-preset.sel {
      color: #2A1400; border-color: transparent;
      background: linear-gradient(145deg, #FFC081, var(--pt-amber));
      box-shadow: 0 4px 14px rgba(255, 157, 69, 0.3);
    }

    .pt-custom {
      width: 100%; margin-top: 7px; padding: 10px 11px;
      background: rgba(0, 0, 0, 0.32); border: 1px solid var(--pt-line);
      border-radius: var(--pt-r-sm); color: var(--pt-text);
      font-family: var(--pt-mono); font-size: 13px; outline: none;
      transition: border-color 0.16s, box-shadow 0.16s, background 0.16s;
    }
    .pt-custom::placeholder { color: var(--pt-faint); font-family: var(--pt-sans); }
    .pt-custom:focus {
      border-color: rgba(255, 157, 69, 0.6);
      box-shadow: 0 0 0 3px rgba(255, 157, 69, 0.13);
      background: rgba(0, 0, 0, 0.45);
    }

    /* ---------------- primary action ---------------- */

    .pt-buy {
      position: relative; overflow: hidden;
      width: 100%; margin-top: 9px; padding: 13px;
      border: none; border-radius: var(--pt-r-md);
      background: linear-gradient(180deg, #3FE49B, #22B573);
      color: #032B1B; font-size: 14.5px; font-weight: 850; letter-spacing: 0.4px;
      cursor: pointer;
      box-shadow: 0 8px 22px -6px rgba(34, 181, 115, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.35);
      transition: transform 0.13s var(--pt-ease), box-shadow 0.2s, filter 0.16s;
    }
    .pt-buy::after {
      content: ''; position: absolute; inset: 0;
      background: linear-gradient(105deg, transparent 35%, rgba(255, 255, 255, 0.32) 50%, transparent 65%);
      transform: translateX(-100%);
      transition: transform 0.6s var(--pt-ease);
    }
    .pt-buy:hover { filter: brightness(1.06); box-shadow: 0 12px 28px -8px rgba(34, 181, 115, 0.68), inset 0 1px 0 rgba(255, 255, 255, 0.35); }
    .pt-buy:hover::after { transform: translateX(100%); }
    .pt-buy:active { transform: translateY(1px) scale(0.988); }
    /* Armed: the click already happened, we are waiting on the first quote. */
    .pt-buy-armed {
      background: linear-gradient(180deg, #FFC081, var(--pt-amber));
      color: #2A1400;
      box-shadow: 0 8px 22px -6px rgba(255, 157, 69, 0.55), inset 0 1px 0 rgba(255,255,255,0.35);
      animation: pt-armed-pulse 1.4s ease-in-out infinite;
    }
    @keyframes pt-armed-pulse {
      0%, 100% { filter: brightness(1); }
      50% { filter: brightness(1.12); }
    }

    /* ---------------- position card ---------------- */

    .pt-pos {
      margin-top: 13px; padding: 12px 13px;
      background: linear-gradient(135deg, rgba(255, 255, 255, 0.045), rgba(255, 255, 255, 0.012));
      border: 1px solid var(--pt-line); border-radius: var(--pt-r-md);
      animation: pt-rise 0.32s var(--pt-ease) both;
    }
    @keyframes pt-rise {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: none; }
    }
    .pt-pos .row {
      display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
      padding: 5px 0;
    }
    .pt-pos .row + .row { border-top: 1px solid rgba(255, 255, 255, 0.045); }
    .pt-pos .k { font-size: 11px; color: var(--pt-dim); white-space: nowrap; flex: none; }
    .pt-pos .v {
      font-weight: 700; font-family: var(--pt-mono); font-size: 12px;
      text-align: right; min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .pt-pos .big { font-size: 14px; font-weight: 800; }
    /* The P&L row carries three values (SOL, %, USD) and is the one number
       that must never be clipped. It gets its own full-width line so the USD
       amount cannot be cut off on the right. */
    .pt-pos .row-pnl {
      display: block; padding-top: 7px;
    }
    .pt-pos .row-pnl .k { display: block; margin-bottom: 4px; }
    .pt-pos .pnl {
      display: block; width: 100%; padding: 5px 9px; border-radius: 8px;
      font-size: 12.5px; font-weight: 800;
      text-align: left; white-space: normal; overflow: visible;
      line-height: 1.35;
    }
    /* USD sits on its own line at narrow widths rather than being truncated. */
    .pt-pos .pnl .usd-part { opacity: 0.85; }

    /* ---------------- closed P&L ---------------- */

    .pt-closed {
      margin-top: 11px; padding: 11px 13px;
      background: linear-gradient(135deg, rgba(255, 157, 69, 0.11), rgba(11, 14, 20, 0.9));
      border: 1px solid rgba(255, 157, 69, 0.4); border-radius: var(--pt-r-md);
      animation: pt-rise 0.34s var(--pt-ease) both;
    }
    .pt-closed-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
    .pt-closed-title {
      font-size: 9.5px; font-weight: 800; letter-spacing: 1.1px; text-transform: uppercase;
      color: var(--pt-amber);
    }
    .pt-closed-badge {
      padding: 2px 7px; border-radius: 999px;
      background: rgba(255, 157, 69, 0.14); border: 1px solid rgba(255, 157, 69, 0.28);
      font-size: 8.5px; font-weight: 800; letter-spacing: 0.6px; color: #FFC790;
    }
    .pt-closed-pnl { font-size: 21px; font-weight: 850; letter-spacing: -0.6px; line-height: 1.2; }
    .pt-closed-meta { margin-top: 3px; font-size: 10px; color: var(--pt-dim); }

    /* ---------------- sell row ---------------- */

    .pt-sell-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 5px; margin-top: 6px; }
    .pt-sell {
      padding: 9px 2px; border-radius: var(--pt-r-sm);
      border: 1px solid rgba(255, 95, 86, 0.32);
      background: linear-gradient(180deg, rgba(255, 95, 86, 0.19), rgba(255, 95, 86, 0.09));
      color: #FFB3AE; font-size: 11.5px; font-weight: 800; cursor: pointer;
      transition: background 0.16s, color 0.16s, transform 0.12s, box-shadow 0.18s;
    }
    .pt-sell:hover {
      background: linear-gradient(180deg, #FF6B62, #E0433A);
      color: #fff; border-color: transparent;
      box-shadow: 0 6px 18px -6px rgba(255, 95, 86, 0.6);
    }
    .pt-sell:active { transform: scale(0.95); }

    /* ---------------- footer ---------------- */

    .pt-footer {
      position: relative; z-index: 2;
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      padding: 8px 12px;
      border-top: 1px solid var(--pt-line);
      background: rgba(0, 0, 0, 0.28);
      font-size: 10px; color: var(--pt-faint);
    }
    .pt-footer span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .pt-footer a {
      color: var(--pt-dim); cursor: pointer; text-decoration: none;
      border-bottom: 1px dotted var(--pt-line-2);
      transition: color 0.16s, border-color 0.16s;
    }
    .pt-footer a:hover { color: var(--pt-amber); border-color: var(--pt-amber); }

    /* ---------------- semantic colors ---------------- */

    .pt-green { color: var(--pt-green); }
    .pt-red { color: var(--pt-red); }
    .pt-muted { color: var(--pt-dim); }
    .pt-pos .pnl.pt-green { background: var(--pt-green-soft); }
    .pt-pos .pnl.pt-red { background: var(--pt-red-soft); }
    .pt-hidden { display: none !important; }

    /* ---------------- minimized pill ---------------- */

    .pt-minipill {
      position: fixed; top: 84px; right: 18px; z-index: 2147483647;
      display: none; align-items: center; gap: 7px;
      padding: 9px 15px; border-radius: 999px;
      background: linear-gradient(180deg, rgba(20, 24, 32, 0.95), rgba(9, 11, 16, 0.95));
      backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
      border: 1px solid rgba(255, 157, 69, 0.55);
      color: var(--pt-amber); font-family: var(--pt-sans);
      font-size: 11.5px; font-weight: 800; letter-spacing: 0.6px; cursor: pointer;
      box-shadow: 0 14px 34px -10px rgba(0, 0, 0, 0.8);
      transition: transform 0.18s var(--pt-ease), box-shadow 0.2s, border-color 0.2s;
    }
    .pt-minipill:hover { transform: translateY(-2px); border-color: var(--pt-amber); box-shadow: 0 18px 40px -10px rgba(0, 0, 0, 0.85); }
    .pt-minipill:active { transform: scale(0.96); }

    /* ---------------- toasts ---------------- */

    .pt-toast {
      position: fixed; top: 74px; right: 18px; z-index: 2147483647;
      max-width: 320px; padding: 10px 14px;
      background: linear-gradient(180deg, rgba(24, 28, 37, 0.97), rgba(13, 16, 22, 0.97));
      backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
      border: 1px solid var(--pt-line-2); border-left: 3px solid var(--pt-amber);
      border-radius: var(--pt-r-md); color: var(--pt-text);
      font-size: 12px; font-weight: 600;
      box-shadow: 0 18px 40px -12px rgba(0, 0, 0, 0.8);
      animation: pt-toast-in 0.34s var(--pt-ease) both;
    }
    @keyframes pt-toast-in {
      from { opacity: 0; transform: translateX(22px) scale(0.97); }
      to { opacity: 1; transform: none; }
    }

    /* ---------------- celebration effects ---------------- */

    .pt-effects { position: fixed; inset: 0; z-index: 2147483646; pointer-events: none; overflow: hidden; }
    .pt-fx-flash { position: absolute; inset: 0; animation: pt-fx-flash 0.48s ease-out forwards; }
    .pt-fx-flash.buy { background: radial-gradient(circle at 50% 45%, rgba(52, 211, 153, 0.24), rgba(255, 157, 69, 0.09) 35%, transparent 72%); }
    .pt-fx-flash.sell { background: radial-gradient(circle at 50% 45%, rgba(255, 95, 86, 0.22), rgba(255, 157, 69, 0.07) 35%, transparent 72%); }
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

    /* ---------------- tick flash ----------------
       Colored by TOTAL position P&L, never tick direction. */
    @keyframes pt-flash-up { from { background: rgba(52, 211, 153, 0.38); } to { background: var(--pt-green-soft); } }
    @keyframes pt-flash-down { from { background: rgba(255, 95, 86, 0.38); } to { background: var(--pt-red-soft); } }
    .pt-flash-up { animation: pt-flash-up 0.45s ease-out; border-radius: 7px; }
    .pt-flash-down { animation: pt-flash-down 0.45s ease-out; border-radius: 7px; }

    /* ---------------- trade thesis ---------------- */
    .pt-thesis {
      margin-top: 11px; padding: 11px 12px;
      background: rgba(255, 255, 255, 0.035);
      border: 1px solid var(--pt-line); border-radius: var(--pt-r-md);
    }
    .pt-thesis-head {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      margin-bottom: 8px;
    }
    .pt-thesis-title {
      font-size: 9.5px; font-weight: 700; letter-spacing: 1.1px;
      text-transform: uppercase; color: var(--pt-faint);
    }
    .pt-thesis textarea {
      width: 100%; min-height: 56px; resize: vertical;
      padding: 8px 10px; border-radius: var(--pt-r-sm);
      background: rgba(0, 0, 0, 0.32); border: 1px solid var(--pt-line);
      color: var(--pt-text); font-family: var(--pt-sans); font-size: 12px;
      line-height: 1.45; outline: none;
      transition: border-color 0.16s, box-shadow 0.16s;
    }
    .pt-thesis textarea::placeholder { color: var(--pt-faint); }
    .pt-thesis textarea:focus {
      border-color: rgba(255, 157, 69, 0.55);
      box-shadow: 0 0 0 3px rgba(255, 157, 69, 0.12);
    }
    .pt-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
    .pt-tag {
      padding: 4px 9px; border-radius: 999px;
      background: transparent; border: 1px solid var(--pt-line);
      color: var(--pt-dim); font-size: 10.5px; font-weight: 650;
      cursor: pointer; font-family: inherit;
      transition: color 0.15s, background 0.15s, border-color 0.15s;
    }
    .pt-tag:hover { color: var(--pt-text); background: var(--pt-raised); }
    .pt-tag.on {
      color: #2A1400; border-color: transparent;
      background: linear-gradient(145deg, #FFC081, var(--pt-amber));
    }
    .pt-thesis-row { display: flex; gap: 6px; margin-top: 8px; }
    .pt-thesis-row input {
      flex: 1; min-width: 0; padding: 7px 9px; border-radius: var(--pt-r-sm);
      background: rgba(0, 0, 0, 0.32); border: 1px solid var(--pt-line);
      color: var(--pt-text); font-family: var(--pt-mono); font-size: 11.5px; outline: none;
    }
    .pt-thesis-row input:focus { border-color: rgba(255, 157, 69, 0.55); }
    .pt-thesis-saved {
      font-size: 11px; color: var(--pt-dim); line-height: 1.5;
      white-space: pre-wrap; word-break: break-word;
    }
    .pt-thesis-meta { margin-top: 6px; font-size: 10px; color: var(--pt-faint); }
    .pt-thesis-edit {
      background: none; border: none; padding: 0; cursor: pointer;
      color: var(--pt-amber); font-size: 10.5px; font-weight: 650; font-family: inherit;
    }

    /* ---------------- positions bar (Padre-style) ----------------
       A fixed top rail listing every open paper position, so P&L stays
       visible while the user is looking at a different token's chart. */
    /* Floats over the page rather than reflowing it.
       Anchored to the LEFT, tucked into the empty space beside the host site's
       logo, instead of the top-right where trading UIs put their own buttons
       (wallet, settings, connect) and an overlay would sit on top of them. */
    .pt-bar {
      position: fixed; top: var(--pt-bar-top, 7px); left: var(--pt-bar-left, 210px); right: auto; z-index: 2147483645;
      max-width: min(62vw, 760px);
      display: flex; align-items: stretch; gap: 0;
      min-height: 36px; padding: 0;
      font-family: var(--pt-sans); font-size: 12px;
      color: var(--pt-text);
      background: linear-gradient(180deg, rgba(13, 16, 23, 0.94), rgba(9, 11, 16, 0.92));
      backdrop-filter: blur(18px) saturate(140%);
      -webkit-backdrop-filter: blur(18px) saturate(140%);
      border: 1px solid rgba(255, 157, 69, 0.3);
      border-radius: 12px;
      box-shadow: 0 14px 34px -14px rgba(0, 0, 0, 0.85), inset 0 1px 0 rgba(255, 255, 255, 0.05);
      overflow: hidden;
      animation: pt-bar-in 0.34s var(--pt-ease) both;
    }
    @keyframes pt-bar-in {
      from { opacity: 0; transform: translateY(-12px); }
      to { opacity: 1; transform: none; }
    }
    .pt-bar.pt-hidden { display: none !important; }

    .pt-bar-grip {
      display: flex; align-items: center; justify-content: center;
      flex: none; width: 18px; padding: 0 2px;
      color: var(--pt-faint); cursor: grab; user-select: none;
      border-right: 1px solid var(--pt-line);
    }
    .pt-bar-grip:hover { color: var(--pt-amber); }
    .pt-bar-grip:active { cursor: grabbing; }
    .pt-bar-brand {
      display: flex; align-items: center; gap: 7px; flex: none;
      padding: 0 12px;
      border-right: 1px solid var(--pt-line);
      cursor: pointer; user-select: none;
    }
    .pt-bar-brand:hover { background: rgba(255, 255, 255, 0.04); }
    .pt-bar-mark {
      width: 18px; height: 18px; border-radius: 5px; flex: none;
      display: flex; align-items: center; justify-content: center;
      font-size: 9.5px; font-weight: 900; color: #2A1400;
      background: linear-gradient(145deg, #FFC081, var(--pt-amber) 60%, #E77B22);
    }
    .pt-bar-label {
      font-size: 9px; font-weight: 800; letter-spacing: 1.1px;
      text-transform: uppercase; color: var(--pt-amber);
      white-space: nowrap;
    }

    /* aggregate segment */
    .pt-bar-total {
      display: flex; align-items: center; gap: 9px; flex: none;
      padding: 0 13px; border-right: 1px solid var(--pt-line);
      white-space: nowrap;
    }
    .pt-bar-total .k {
      font-size: 9px; font-weight: 700; letter-spacing: 0.9px;
      text-transform: uppercase; color: var(--pt-faint);
    }
    .pt-bar-total .v {
      font-family: var(--pt-mono); font-size: 12.5px; font-weight: 800;
      letter-spacing: -0.2px;
    }

    /* scrolling chip rail */
    .pt-bar-rail {
      display: flex; align-items: center; gap: 6px;
      flex: 1; min-width: 0;
      padding: 5px 10px;
      overflow-x: auto; overflow-y: hidden;
      scrollbar-width: thin;
    }
    .pt-bar-rail::-webkit-scrollbar { height: 4px; }
    .pt-bar-rail::-webkit-scrollbar-track { background: transparent; }
    .pt-bar-rail::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.16); border-radius: 99px; }

    .pt-chip {
      display: flex; align-items: center; gap: 8px; flex: none;
      padding: 5px 10px;
      background: rgba(255, 255, 255, 0.045);
      border: 1px solid var(--pt-line);
      border-radius: 999px;
      color: var(--pt-text); font-family: inherit; font-size: 11.5px;
      cursor: pointer; white-space: nowrap;
      transition: background 0.15s, border-color 0.15s, transform 0.15s var(--pt-ease);
    }
    .pt-chip:hover {
      background: rgba(255, 255, 255, 0.09);
      border-color: var(--pt-line-2);
      transform: translateY(-1px);
    }
    .pt-chip:active { transform: translateY(0) scale(0.98); }
    /* The token whose chart is on screen right now. */
    .pt-chip.active {
      border-color: rgba(255, 157, 69, 0.65);
      background: linear-gradient(135deg, rgba(255, 157, 69, 0.18), rgba(255, 157, 69, 0.05));
      box-shadow: 0 0 0 1px rgba(255, 157, 69, 0.12);
    }
    .pt-chip-sym { font-weight: 800; letter-spacing: -0.1px; }
    .pt-chip-pnl { font-family: var(--pt-mono); font-weight: 750; }
    .pt-chip-pct { font-family: var(--pt-mono); font-size: 10.5px; opacity: 0.75; }
    /* A position with no fresh quote must look different from a live one. */
    .pt-chip.stale .pt-chip-pnl, .pt-chip.stale .pt-chip-pct { opacity: 0.5; }
    .pt-chip-dot {
      width: 6px; height: 6px; border-radius: 50%; flex: none;
      background: currentColor;
      box-shadow: 0 0 6px currentColor;
    }
    .pt-chip.stale .pt-chip-dot { box-shadow: none; opacity: 0.45; }

    .pt-bar-empty {
      display: flex; align-items: center;
      padding: 0 12px; color: var(--pt-faint); font-size: 11.5px;
    }
    .pt-bar-actions {
      display: flex; align-items: center; gap: 4px; flex: none;
      padding: 0 8px; border-left: 1px solid var(--pt-line);
    }
    .pt-bar-btn {
      display: flex; align-items: center; justify-content: center;
      width: 24px; height: 24px; padding: 0;
      background: transparent; border: 1px solid transparent; border-radius: 7px;
      color: var(--pt-faint); font-size: 12px; cursor: pointer;
      transition: background 0.15s, color 0.15s, border-color 0.15s;
    }
    .pt-bar-btn:hover { background: var(--pt-raised); border-color: var(--pt-line-2); color: var(--pt-text); }

    /* Restore tab shown when the bar is collapsed. */
    .pt-bar-tab {
      position: fixed; top: var(--pt-bar-top, 7px); left: var(--pt-bar-left, 210px); right: auto;
      z-index: 2147483645; display: none; align-items: center; gap: 6px;
      padding: 6px 12px;
      background: linear-gradient(180deg, rgba(13, 16, 23, 0.94), rgba(9, 11, 16, 0.92));
      backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
      border: 1px solid rgba(255, 157, 69, 0.42);
      border-radius: 999px;
      color: var(--pt-amber); font-family: var(--pt-sans);
      font-size: 10px; font-weight: 800; letter-spacing: 0.7px;
      cursor: pointer;
      transition: transform 0.16s var(--pt-ease), border-color 0.16s;
    }
    .pt-bar-tab:hover { transform: translateY(1px); border-color: var(--pt-amber); }

    @media (prefers-reduced-motion: reduce) {
      .pt-bar { animation: none; }
      .pt-chip:hover { transform: none; }
    }

    @media (prefers-reduced-motion: reduce) {
      .pt-box, .pt-pos, .pt-closed, .pt-toast { animation: none; }
      .pt-banner::after, .pt-dot.on { animation: none; }
      .pt-buy::after { display: none; }
    }
  `;

  function createUI() {
    if (document.getElementById(HOST_ID)) return;
    host = document.createElement('div');
    host.id = HOST_ID;
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>${CSS}</style>
      <div class="pt-wrap">
        <div class="pt-bar pt-hidden" id="pt-bar">
          <div class="pt-bar-grip" id="pt-bar-grip" title="Drag to move">${ICONS.grip}</div>
          <div class="pt-bar-brand" id="pt-bar-brand" title="Open PaperTrench dashboard">
            <span class="pt-bar-mark">P</span>
            <span class="pt-bar-label">Paper</span>
          </div>
          <div class="pt-bar-total" id="pt-bar-total"></div>
          <div class="pt-bar-rail" id="pt-bar-rail"></div>
          <div class="pt-bar-actions">
            <button class="pt-bar-btn" id="pt-bar-hide" title="Hide positions bar">${ICONS.minimize}</button>
          </div>
        </div>
        <button class="pt-bar-tab" id="pt-bar-tab" title="Show paper positions">POSITIONS</button>
        <div class="pt-box" id="pt-box">
          <div class="pt-watermark">PAPER</div>
          <div class="pt-banner"><b>Paper Trading</b> · Simulated Funds</div>
          <div class="pt-header" id="pt-drag">
            <div class="pt-icon">P</div>
            <div class="pt-title">PaperTrench<span class="sub" id="pt-subtitle">Quick paper buy box</span></div>
            <span class="pt-grow"></span>
            <button class="pt-hbtn" id="pt-visibility" title="Toggle auto-hide when no token" aria-label="Toggle visibility">${ICONS.eye}</button>
            <button class="pt-hbtn" id="pt-dash" title="Open dashboard">${ICONS.chart}</button>
            <button class="pt-hbtn" id="pt-min" title="Minimize">${ICONS.minimize}</button>
          </div>
          <div class="pt-body">
            <div class="pt-token-row">
              <div class="pt-token"><div id="pt-token-name">—</div><div class="pt-mint" id="pt-token-mint">waiting for token</div></div>
              <div class="pt-price"><div class="num ${!token || (!token.priceNative && !token.priceUsd) ? 'pt-price-stale' : ''}" id="pt-price">—</div><div class="usd" id="pt-price-usd"></div></div>
            </div>
            <div class="pt-spark" id="pt-spark"></div>
            <div class="pt-balance">
              <div class="lab"><span class="pt-dot" id="pt-live-dot"></span>Paper balance</div>
              <div class="amt" id="pt-balance">— SOL</div>
              <div class="pt-delta" id="pt-delta"></div>
            </div>
            <div class="pt-label" id="pt-buy-label">Quick buy (SOL)</div>
            <div class="pt-presets" id="pt-buy-presets"></div>
            <input class="pt-custom" id="pt-custom" type="number" min="0" step="0.01" placeholder="Or type a custom SOL amount…" />
            <button class="pt-buy" id="pt-buy">BUY (PAPER)</button>
            <div id="pt-position"></div>
            <div id="pt-thesis"></div>
            <div id="pt-closed"></div>
          </div>
          <div class="pt-footer">
            <span id="pt-site"></span>
            <span><a id="pt-reset">Reset wallet</a> · <a id="pt-settings">Settings</a></span>
          </div>
          <div class="pt-resize" id="pt-resize" title="Resize">${ICONS.resize}</div>
        </div>
        <button class="pt-minipill" id="pt-pill"><span class="pt-dot on"></span><span id="pt-pill-text">PAPER</span></button>
        <div id="pt-toast-root"></div>
        <div class="pt-effects" id="pt-effects"></div>
      </div>
    `;
    document.body.appendChild(host);

    els.box = shadow.getElementById('pt-box');
    els.pill = shadow.getElementById('pt-pill');
    els.tokenName = shadow.getElementById('pt-token-name');
    els.tokenMint = shadow.getElementById('pt-token-mint');
    els.price = shadow.getElementById('pt-price');
    els.priceUsd = shadow.getElementById('pt-price-usd');
    els.balance = shadow.getElementById('pt-balance');
    els.buyPresets = shadow.getElementById('pt-buy-presets');
    els.buyLabel = shadow.getElementById('pt-buy-label');
    els.custom = shadow.getElementById('pt-custom');
    els.btnBuy = shadow.getElementById('pt-buy');
    els.position = shadow.getElementById('pt-position');
    els.thesis = shadow.getElementById('pt-thesis');
    els.closed = shadow.getElementById('pt-closed');
    els.effects = shadow.getElementById('pt-effects');
    els.footSite = shadow.getElementById('pt-site');
    els.spark = shadow.getElementById('pt-spark');
    els.subtitle = shadow.getElementById('pt-subtitle');
    els.bar = shadow.getElementById('pt-bar');
    els.barGrip = shadow.getElementById('pt-bar-grip');
    els.barTotal = shadow.getElementById('pt-bar-total');
    els.barRail = shadow.getElementById('pt-bar-rail');
    els.barTab = shadow.getElementById('pt-bar-tab');
    els.liveDot = shadow.getElementById('pt-live-dot');
    els.visibility = shadow.getElementById('pt-visibility');
    els.delta = shadow.getElementById('pt-delta');
    els.pillText = shadow.getElementById('pt-pill-text');
    els.resize = shadow.getElementById('pt-resize');

    bindUI();
    renderPresets();
    renderAll();
    applyOverlaySize();
  }

  function bindUI() {
    // A user gesture unlocks Web Audio so a later hidden-tab profit bell is
    // allowed to play. Creating/resuming here is silent.
    els.box.addEventListener('pointerdown', primeAudio);

    if (els.visibility) els.visibility.addEventListener('click', toggleOverlayAutoHide);
    if (els.resize) els.resize.addEventListener('pointerdown', onOverlayResizeStart);
    shadow.getElementById('pt-min').addEventListener('click', () => {
      panelMinimized = true;
      setPanelVisible(true);
    });
    els.pill.addEventListener('click', () => {
      panelMinimized = false;
      setPanelVisible(true);
    });
    // Positions bar controls.
    const barBrand = shadow.getElementById('pt-bar-brand');
    if (barBrand) barBrand.addEventListener('click', openDashboard);
    const barHide = shadow.getElementById('pt-bar-hide');
    if (barHide) barHide.addEventListener('click', () => {
      positionsBarHidden = true;
      renderPositionsBar();
    });
    if (els.barTab) els.barTab.addEventListener('click', () => {
      positionsBarHidden = false;
      renderPositionsBar();
    });
    setupBarDrag();

    shadow.getElementById('pt-dash').addEventListener('click', openDashboard);
    shadow.getElementById('pt-settings').addEventListener('click', openDashboard);
    shadow.getElementById('pt-reset').addEventListener('click', async () => {
      if (!confirm(`Reset paper wallet to ${settings.balanceStartSol} SOL? All history is wiped.`)) return;
      await withState(async () => { state = E.resetState(settings); await persistStateNow(); });
      syncAveragePriceLines();
      renderAll(); toast('Paper wallet reset');
    });
    els.btnBuy.addEventListener('click', () => {
      const custom = Number(els.custom.value);
      const sel = els.buyPresets.querySelector('.pt-preset.sel');
      const amt = custom > 0 ? custom : sel ? Number(sel.dataset.amt) : 0;
      if (!(amt > 0)) return toast('Pick a SOL amount first');
      requestBuy(amt);
    });

    const drag = shadow.getElementById('pt-drag');
    let dragging = false, sx = 0, sy = 0, sr = 0, st = 0;
    drag.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      dragging = true; sx = e.clientX; sy = e.clientY;
      const boxStyle = window.getComputedStyle(els.box);
      sr = parseInt(boxStyle.right) || 18; st = parseInt(boxStyle.top) || 84;
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      els.box.style.right = Math.max(0, sr - (e.clientX - sx)) + 'px';
      els.box.style.top = Math.max(0, st + (e.clientY - sy)) + 'px';
      els.box.style.left = 'auto';
    });
    window.addEventListener('mouseup', () => (dragging = false));
  }

  /** Let the user drag the top positions bar out of the way of host nav. */
  function setupBarDrag() {
    if (!els.barGrip) return;
    let dragging = false, sx = 0, sy = 0, sl = 0, st = 0;
    const start = (e) => {
      // Left click or touch only.
      if (e.type === 'mousedown' && e.button !== 0) return;
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      const style = window.getComputedStyle(els.bar);
      sl = parseInt(style.left) || 210;
      st = parseInt(style.top) || 7;
      e.preventDefault();
    };
    const move = (e) => {
      if (!dragging) return;
      const viewportW = window.innerWidth || 800;
      const viewportH = window.innerHeight || 600;
      const rect = els.bar.getBoundingClientRect();
      let left = sl + (e.clientX - sx);
      let top = st + (e.clientY - sy);
      // Keep a strip of the bar visible so the user can drag it back.
      left = Math.max(4 - rect.width, Math.min(left, viewportW - 4));
      top = Math.max(0, Math.min(top, viewportH - 20));
      els.bar.style.setProperty('--pt-bar-left', left + 'px');
      els.bar.style.setProperty('--pt-bar-top', top + 'px');
      if (els.barTab) {
        els.barTab.style.setProperty('--pt-bar-left', left + 'px');
        els.barTab.style.setProperty('--pt-bar-top', top + 'px');
      }
    };
    const stop = () => {
      if (!dragging) return;
      dragging = false;
      const style = window.getComputedStyle(els.bar);
      const left = parseInt(style.left) || 210;
      const top = parseInt(style.top) || 7;
      settings.positionsBarLeft = left;
      settings.positionsBarTop = top;
      try {
        store.set({ [E.STORAGE_KEYS.settings]: settings });
      } catch (_) {}
    };
    els.barGrip.addEventListener('mousedown', start);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', stop);
  }

  function openDashboard() { sendMessage({ type: 'pt_open_dashboard' }); }

  function renderPresets() {
    // Two user toggles strip the buy controls back: the preset row can be
    // hidden on its own, or the whole buy section (label, presets, custom
    // amount, BUY button) for a view-only trade tab. Hidden, not removed —
    // flipping either switch back on restores everything as it was.
    const sectionOn = settings.panelBuyEnabled !== false;
    const presetsOn = sectionOn && settings.panelPresetsEnabled !== false;
    if (els.buyLabel) els.buyLabel.style.display = sectionOn ? '' : 'none';
    if (els.custom) els.custom.style.display = sectionOn ? '' : 'none';
    if (els.btnBuy) els.btnBuy.style.display = sectionOn ? '' : 'none';
    if (els.buyPresets) els.buyPresets.style.display = presetsOn ? '' : 'none';

    const list = settings.presetsBuy || [0.1, 0.5, 1, 2];
    const instant = settings.instantBuyEnabled !== false;
    if (sectionOn && els.buyLabel) {
      // "Tap to fill" only reads honestly while the tappable row is visible.
      els.buyLabel.textContent = presetsOn && instant ? 'Quick buy — tap to fill (SOL)' : 'Quick buy (SOL)';
    }
    if (!presetsOn) return;
    els.buyPresets.innerHTML = list.map((a, i) =>
      `<button class="pt-preset${i === 1 ? ' sel' : ''}" data-amt="${a}" title="${instant ? 'Buy this amount instantly' : 'Select this amount'}">${a} SOL</button>`
    ).join('');
    els.buyPresets.querySelectorAll('.pt-preset').forEach((b) => {
      b.addEventListener('click', () => {
        els.buyPresets.querySelectorAll('.pt-preset').forEach((x) => x.classList.remove('sel'));
        b.classList.add('sel'); els.custom.value = '';
        // One-click quick buy: the tap IS the order, like Axiom and Padre.
        if (instant) requestBuy(Number(b.dataset.amt));
      });
    });
  }

  /**
   * Show or hide only the main panel and its minimized pill. The positions bar
   * is intentionally left alone: it must remain visible on non-coin pages when
   * the user has open positions.
   */
  function applyOverlaySize() {
    if (!els.box || resizingOverlay) return;
    const w = settings.overlayWidth;
    const h = settings.overlayHeight;
    els.box.style.width = (w && Number(w) > 0) ? `${w}px` : '';
    els.box.style.height = (h && Number(h) > 0) ? `${h}px` : '';
  }

  const OVERLAY_MIN_W = 260;
  const OVERLAY_MAX_W = 560;
  const OVERLAY_MIN_H = 320;
  const OVERLAY_MAX_H = 820;

  function clampOverlaySize(w, h) {
    return {
      w: Math.max(OVERLAY_MIN_W, Math.min(OVERLAY_MAX_W, Math.round(w))),
      h: Math.max(OVERLAY_MIN_H, Math.min(OVERLAY_MAX_H, Math.round(h))),
    };
  }

  function onOverlayResizeStart(e) {
    if (!els.box) return;
    e.preventDefault();
    resizingOverlay = true;
    resizeStart = {
      x: e.clientX,
      y: e.clientY,
      w: els.box.offsetWidth,
      h: els.box.offsetHeight,
    };
    window.addEventListener('pointermove', onOverlayResizeMove, { passive: false });
    window.addEventListener('pointerup', onOverlayResizeEnd, { once: true });
  }

  function onOverlayResizeMove(e) {
    if (!resizingOverlay || !resizeStart || !els.box) return;
    e.preventDefault();
    const nextW = resizeStart.w + (e.clientX - resizeStart.x);
    const nextH = resizeStart.h + (e.clientY - resizeStart.y);
    const { w, h } = clampOverlaySize(nextW, nextH);
    els.box.style.width = `${w}px`;
    els.box.style.height = `${h}px`;
  }

  async function onOverlayResizeEnd() {
    window.removeEventListener('pointermove', onOverlayResizeMove);
    if (!resizeStart || !els.box) return;
    resizingOverlay = false;
    const w = els.box.offsetWidth;
    const h = els.box.offsetHeight;
    resizeStart = null;
    settings = { ...settings, overlayWidth: w, overlayHeight: h };
    await store.set({ [E.STORAGE_KEYS.settings]: settings });
  }

  function setPanelVisible(visible) {
    if (!els.box || !els.pill) return;
    if (!visible) {
      els.box.classList.add('pt-hidden');
      els.pill.style.display = 'none';
      return;
    }
    if (panelMinimized) {
      els.box.classList.add('pt-hidden');
      els.pill.style.display = 'block';
    } else {
      els.box.classList.remove('pt-hidden');
      els.pill.style.display = 'none';
    }
  }

  /**
   * Update the main panel visibility based on the auto-hide setting and the
   * presence of a token. The overlay is hidden when the user is on a non-coin
   * page and auto-hide is enabled, and reappears when a token is detected or
   * auto-hide is turned off.
   */
  function updateOverlayVisibility() {
    if (!host) return;
    const hide = settings.overlayHideWhenNoToken && !token;
    setPanelVisible(!hide);
    renderVisibilityIcon();
  }

  function renderVisibilityIcon() {
    if (!els.visibility) return;
    // eye = always visible / auto-hide off. eye-off = hides on non-coin pages.
    const autoHide = settings.overlayHideWhenNoToken !== false;
    els.visibility.innerHTML = autoHide ? ICONS['eye-off'] : ICONS.eye;
    els.visibility.title = autoHide
      ? 'Overlay auto-hides when no token is detected'
      : 'Overlay is always visible';
  }

  async function toggleOverlayAutoHide() {
    settings = { ...settings, overlayHideWhenNoToken: !settings.overlayHideWhenNoToken };
    await store.set({ [E.STORAGE_KEYS.settings]: settings });
    // The storage listener will also refresh settings, but we update the UI
    // immediately so the icon and host display feel instant.
    updateOverlayVisibility();
  }

  async function toggleOverlayEnabled() {
    settings = { ...settings, overlayEnabled: !settings.overlayEnabled };
    await store.set({ [E.STORAGE_KEYS.settings]: settings });
  }

  function renderAll() {
    if (contextDead || !shadow) return;
    renderHeader();
    renderBalance();
    renderPosition();
    renderBuyButton();
    renderThesis();
    renderClosedPnl();
    renderSiteStatus();
    renderLiveDot();
    renderSparkline();
    updateOverlayVisibility();
    renderPositionsBar();
  }

  function renderSiteStatus() {
    if (!els.footSite) return;
    if (!site) {
      els.footSite.textContent = '';
      if (els.subtitle) els.subtitle.textContent = 'Open a token page to begin';
      return;
    }
    // The price source is stated plainly. "CHAIN" means the fill price comes
    // from pool state at `processed` commitment; anything else is an
    // aggregator running behind, and the user deserves to know which.
    const feed = onchainLive ? ' · CHAIN ⚡' : '';
    if (!usesNativeChart()) {
      els.footSite.textContent = `Site: ${site.name}${feed}`;
      if (els.subtitle) els.subtitle.textContent = site.name;
      return;
    }
    // Padre and Axiom both drive native TradingView marks and order lines, so
    // the hook status is reported against whichever site is in front of us.
    const live = padreHookStatus.barsHooked ? 'LIVE ✓' : 'live connecting…';
    const markersReady = padreHookStatus.marksHooked ? 'MARKS ✓' : 'marks connecting…';
    const lines = settings.averagePriceLinesEnabled
      ? ` · ${(lastLineStatus && lastLineStatus.ok) || padreHookStatus.linesReady ? 'LINES ✓' : 'lines connecting…'}`
      : '';
    els.footSite.textContent = `${site.name} · ${live} · ${markersReady}${lines}${feed}`;
    if (els.subtitle) {
      els.subtitle.textContent = padreHookStatus.barsHooked
        ? `${site.name} · live feed connected`
        : `${site.name} · connecting…`;
    }
  }

  /**
   * Header rendering is a thin projection of the pure headerFields() contract,
   * so what the user sees is exactly what the tests assert.
   */
  function renderHeader() {
    if (!els.tokenName) return;

    const f = Q.headerFields(token, { lastPriceAt, now: Date.now(), pendingSince });
    els.tokenName.textContent = f.title;
    // Distinct fields: the name goes above, the contract address below.
    els.tokenMint.textContent = token
      ? f.address
      : (site ? `${site.name} — open a token page` : 'Open a token page');
    els.price.textContent = f.priceText;
    // Amber for both "no price yet" and "price has gone stale" — either way the
    // number on screen is not currently live.
    els.price.classList.toggle('pt-price-stale', f.pending || f.stale);

    // The headline is market cap, so the second line carries the label and the
    // unit price rather than repeating the cap.
    const secondary = f.priceIsMarketCap
      ? `MC · ${f.priceUsdText || (f.hasTrustedPrice ? Q.formatPrice(token.priceNative) + ' SOL' : '')}`.trim()
      : (f.priceUsdText || '');
    els.priceUsd.textContent = f.stale ? `${secondary} · reconnecting…`.trim() : secondary;
  }

  function renderBalance() {
    if (els.balance) els.balance.textContent = `${E.fmt(state.cashSol, 2)} SOL`;

    // Equity (cash + open positions marked live) against the starting stake:
    // the one number that answers "am I actually up?" at a glance.
    if (els.delta) {
      const equity = E.equitySol(state);
      const start = Number(settings.balanceStartSol) || 0;
      const diff = equity - start;
      if (!start) {
        els.delta.textContent = '';
      } else {
        const pct = (diff / start) * 100;
        els.delta.textContent =
          `Equity ${E.fmt(equity, 2)} SOL · ${diff >= 0 ? '+' : ''}${E.fmt(diff, 2)} (${diff >= 0 ? '+' : ''}${pct.toFixed(1)}%)`;
        els.delta.classList.toggle('pt-green', diff > 0);
        els.delta.classList.toggle('pt-red', diff < 0);
      }
    }
  }


  /**
   * Trade thesis: why this position was opened, captured while it is open and
   * the outcome is still unknown. That timing is the whole point — a reason
   * written after the result is hindsight, not a thesis.
   */
  function renderThesis() {
    if (!els.thesis) return;
    const pos = token && state.positions[token.mint];
    if (!pos) {
      if (els.thesis.childNodes.length) els.thesis.textContent = '';
      thesisEls = null;
      return;
    }

    const saved = pos.thesis;
    // Rebuild only when switching between the saved and editing views, so
    // typing is never interrupted by the heartbeat.
    const wantEditor = !saved || thesisEditing;
    if (thesisEls && thesisEls.editing === wantEditor && thesisEls.mint === token.mint) return;

    els.thesis.textContent = '';
    const card = document.createElement('div');
    card.className = 'pt-thesis';

    if (!wantEditor) {
      card.innerHTML = `
        <div class="pt-thesis-head">
          <span class="pt-thesis-title">Thesis</span>
          <button class="pt-thesis-edit" data-f="edit">Edit</button>
        </div>
        <div class="pt-thesis-saved" data-f="text"></div>
        <div class="pt-tags" data-f="tags"></div>
        <div class="pt-thesis-meta" data-f="meta"></div>`;
      els.thesis.appendChild(card);

      card.querySelector('[data-f="text"]').textContent = saved.text || '(no note)';
      const tagWrap = card.querySelector('[data-f="tags"]');
      for (const tag of saved.tags || []) {
        const chip = document.createElement('span');
        chip.className = 'pt-tag on';
        chip.textContent = tag;
        tagWrap.appendChild(chip);
      }
      const bits = [];
      if (saved.plan) bits.push(saved.plan);
      if (saved.conviction) bits.push(`conviction ${saved.conviction}/5`);
      if (saved.targetPct) bits.push(`target +${saved.targetPct}%`);
      if (saved.stopPct) bits.push(`stop -${saved.stopPct}%`);
      card.querySelector('[data-f="meta"]').textContent = bits.join(' · ');
      card.querySelector('[data-f="edit"]').addEventListener('click', () => {
        thesisEditing = true;
        thesisEls = null;
        renderThesis();
      });
      thesisEls = { editing: false, mint: token.mint };
      return;
    }

    card.innerHTML = `
      <div class="pt-thesis-head">
        <span class="pt-thesis-title">Why this trade?</span>
        <button class="pt-thesis-edit" data-f="save">Save</button>
      </div>
      <textarea data-f="text" maxlength="${E.THESIS_MAX}" placeholder="What is the setup? Write it before you know how it ends."></textarea>
      <div class="pt-tags" data-f="tags"></div>
      <div class="pt-thesis-row">
        <input data-f="target" type="number" min="1" step="1" placeholder="target %">
        <input data-f="stop" type="number" min="1" step="1" placeholder="stop %">
      </div>`;
    els.thesis.appendChild(card);

    const textarea = card.querySelector('[data-f="text"]');
    const tagWrap = card.querySelector('[data-f="tags"]');
    const targetInput = card.querySelector('[data-f="target"]');
    const stopInput = card.querySelector('[data-f="stop"]');

    if (saved) {
      textarea.value = saved.text || '';
      targetInput.value = saved.targetPct || '';
      stopInput.value = saved.stopPct || '';
    }
    const chosen = new Set(saved ? saved.tags || [] : []);
    for (const tag of E.THESIS_TAGS) {
      const chip = document.createElement('button');
      chip.className = 'pt-tag' + (chosen.has(tag) ? ' on' : '');
      chip.textContent = tag;
      chip.addEventListener('click', () => {
        if (chosen.has(tag)) chosen.delete(tag); else chosen.add(tag);
        chip.classList.toggle('on', chosen.has(tag));
      });
      tagWrap.appendChild(chip);
    }

    card.querySelector('[data-f="save"]').addEventListener('click', async () => {
      const payload = {
        text: textarea.value,
        tags: [...chosen],
        targetPct: Number(targetInput.value) || null,
        stopPct: Number(stopInput.value) || null,
      };
      await withState(async () => {
        E.setThesis(state, token.mint, payload, Date.now());
        await persistStateNow();
      });
      thesisEditing = false;
      thesisEls = null;
      renderThesis();
      toast('Thesis saved');
    });

    thesisEls = { editing: true, mint: token.mint };
  }


  /**
   * Fire a buy that was requested before the coin had a tradeable price.
   *
   * The click already happened; all that was missing was a trusted quote. This
   * runs on the same event as the first accepted price, so the fill lands as
   * early as the data allows rather than waiting for another user action.
   */
  function flushArmedBuy() {
    if (!armedBuy || !token || !token.priceNative) return;
    // Only ever fill the token the user actually armed. Navigation already
    // clears this, but binding the mint makes that guarantee explicit rather
    // than dependent on ordering.
    if (armedBuy.mint && armedBuy.mint !== token.mint) {
      armedBuy = null;
      renderBuyButton();
      return;
    }
    if (Date.now() - armedBuy.at > ARMED_BUY_TTL_MS) {
      // Never execute a stale intent silently.
      armedBuy = null;
      renderBuyButton();
      toast('Armed buy expired — the quote took too long');
      return;
    }
    const amount = armedBuy.amount;
    armedBuy = null;
    renderBuyButton();
    doBuy(amount);
  }

  /** The buy button states its own readiness instead of failing on click. */
  function renderBuyButton() {
    if (!els.btnBuy) return;
    const ready = Boolean(token && token.priceNative);
    if (armedBuy) {
      els.btnBuy.textContent = `ARMED — ${E.fmt(armedBuy.amount, 3)} SOL ON FIRST QUOTE`;
      els.btnBuy.classList.add('pt-buy-armed');
      return;
    }
    els.btnBuy.classList.remove('pt-buy-armed');
    els.btnBuy.textContent = ready ? 'BUY (PAPER)' : 'BUY WHEN QUOTED';
  }


  /**
   * Commit a fill to the tamper-evident chain.
   *
   * Done at fill time, before the outcome is known, so the chain records what
   * was actually decided rather than what the user later wishes they had done.
   * Failure here must never block a trade — the trade is the product; the
   * chain is evidence for an optional leaderboard.
   */
  async function commitFill(trade) {
    if (!AT || !trade) return;
    try {
      const chain = Array.isArray(state.attestChain) ? state.attestChain : [];
      const previous = chain.length ? chain[chain.length - 1].hash : AT.GENESIS;
      const link = await AT.appendFill(previous, trade);
      link.seq = chain.length;
      chain.push(link);
      // Bound the stored chain; the head hash still commits to all of it.
      if (chain.length > 5000) chain.splice(0, chain.length - 5000);
      state.attestChain = chain;
      // The caller writes state once, after this returns. Writing here too
      // would mean two storage round trips per fill for no benefit.
    } catch (_) {
      /* evidence is best-effort; never interfere with trading */
    }
  }

  /* -------------------- screener row quick buys --------------------
   *
   * Axiom Pulse, Padre Trenches and GMGN Trenches give every token row its
   * own one-click buy so a trade can be opened without loading the chart.
   * PaperTrench mirrors that: a small "P <amount>" chip is appended to every
   * token-row link on the screener pages, and tapping it paper-buys the
   * first preset amount. The fill lands in the positions bar immediately,
   * exactly like the site's own quick buy moves you to the position.
   */

  const ROW_ADDR_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/;
  // Newest USD price per mint from the site's OWN realtime feed (GMGN's
  // token_activity ticks carry a mint). A row buy prefers this over a
  // network quote because the screener is showing that very price.
  const recentRowPrices = new Map(); // mint -> { usd, at }
  const ROW_PRICE_TTL_MS = 10_000;
  let rowBuyScanAt = 0;
  let rowBuyInFlight = false;

  function noteRowPrice(payload) {
    if (!payload || typeof payload.mint !== 'string' || !ROW_ADDR_RE.test(payload.mint)) return;
    const cand = Array.isArray(payload.candidates)
      ? payload.candidates.find((c) => c && c.unit === 'usd' && Number(c.value) > 0)
      : null;
    if (!cand) return;
    recentRowPrices.set(payload.mint, { usd: Number(cand.value), at: Date.now() });
    if (recentRowPrices.size > 300) recentRowPrices.delete(recentRowPrices.keys().next().value);
  }

  /**
   * Chips on screener rows are injected by the MAIN-world bridge (only it can
   * read React fibers, which rows without an address link need for their
   * token identity). This just forwards the scan request on a light cadence.
   */
  function scanRowBuys() {
    if (!site || !site.rowBuy || settings.listQuickBuyEnabled === false) return;
    if (!site.rowBuy.listPaths.test(location.pathname)) return;
    const now = Date.now();
    if (now - rowBuyScanAt < 350) return;
    rowBuyScanAt = now;

    sendPadreMarker('row-scan', {
      amount: (settings.presetsBuy || [0.1])[0],
      size: Math.max(0.6, Math.min(1.5, Number(settings.listQuickBuySize) || 1)),
      linkSelectors: site.rowBuy.linkSelectors,
      placement: site.rowBuy.placement,
      buyButtonPattern: site.rowBuy.buyButtonPattern || null,
      containerMode: site.rowBuy.containerMode || 'heuristic',
    });
  }

  // Rows stream in continuously (virtualized lists, infinite scroll). A light
  // observer makes chips appear with the row instead of on the next poll.
  let rowBuyObserver = null;
  function startRowBuyObserver() {
    if (rowBuyObserver || !document.body) return;
    let debounce = null;
    rowBuyObserver = new MutationObserver(() => {
      if (debounce) return;
      debounce = setTimeout(() => { debounce = null; scanRowBuys(); }, 200);
    });
    rowBuyObserver.observe(document.body, { childList: true, subtree: true });
    onTeardown(() => {
      try { rowBuyObserver && rowBuyObserver.disconnect(); } catch (_) {}
      rowBuyObserver = null;
    });
  }

  /** Paper-buy the first preset amount of a screener row's token. */
  async function doRowBuy(address, button) {
    if (rowBuyInFlight) return toast('Row buy already in progress…');
    rowBuyInFlight = true;
    if (button) button.classList.add('busy');
    primeAudio();
    try {
      const amount = (settings.presetsBuy || [0.1])[0];
      const data = await R.resolve(address);
      if (!data || !(data.priceNative > 0)) {
        toast('Could not price that token yet — open its chart to buy');
        return;
      }
      // The screener's own realtime price wins when it is fresh: that is the
      // number the user just looked at before tapping.
      const live = data.mint && recentRowPrices.get(data.mint);
      if (live && Date.now() - live.at < ROW_PRICE_TTL_MS && Number(data.priceUsd) > 0) {
        const rate = data.priceUsd / data.priceNative;
        data.priceUsd = live.usd;
        data.priceNative = live.usd / rate;
        data.priceSource = 'row-feed';
      }

      const result = await withState(async () => {
        const opened = !state.positions[data.mint];
        const { trade, position } = E.buy(state, settings, {
          ts: Date.now(), mint: data.mint, pairAddress: data.pairAddress,
          symbol: data.symbol, name: data.name, site: site.id,
          solAmount: amount,
          priceNative: data.priceNative, priceUsd: data.priceUsd, mcap: data.mcap,
        });
        await commitFill(trade);
        await persistStateNow();
        return { trade, position, opened };
      });
      if (!result) return;
      sendMessage({
        type: 'pt_trade_event',
        kind: 'buy',
        opened: result.opened,
        session: summarizeSession(result.position),
        trade: summarizeTrade(result.trade),
      }).catch(() => {});
      runTradeEffect('buy');
      playTradeSound('buy');
      const atMcap = result.trade.mcap ? ` at ${fmtMoney(result.trade.mcap)} MC` : '';
      toast(`Bought ${E.fmt(amount, 3)} SOL of ${result.trade.symbol}${atMcap} (paper)`);
      if (result.opened) profitAlertLevels.set(data.mint, 0);
      // The positions bar is the screener's answer to a row buy: the new
      // position shows up in the rail instantly, chart one click away.
      pollPositionPrices();
      renderPositionsBar();
      // If this token's chart happens to be on screen, refresh the card too.
      if (token && token.mint === data.mint) renderAll();
    } catch (err) {
      toast(err.message || 'Row buy failed');
    } finally {
      rowBuyInFlight = false;
      if (button) button.classList.remove('busy');
    }
  }

  /* -------------------- positions bar -------------------- */

  /**
   * Render the Padre-style top rail listing every open paper position.
   *
   * Chips are updated IN PLACE rather than rebuilt, for the same reason the
   * position card is: this runs on every tick, and replacing innerHTML would
   * reset the rail's horizontal scroll and kill a click already in progress.
   */
  function renderPositionsBar() {
    if (contextDead || !els.bar || !els.barRail) return;

    const rows = Q.positionRows(state, livePositionPrices, token && token.mint);
    const enabled = settings.positionsBarEnabled !== false;
    const show = enabled && rows.length > 0 && !positionsBarHidden;

    // Release resources for tokens that are no longer held. This runs BEFORE
    // the early return so a closed position cannot leak a cached quote or a
    // detached chip while the bar happens to be collapsed or disabled.
    const held = new Set(rows.map((row) => row.mint));
    for (const [mint, chip] of barChips) {
      if (held.has(mint)) continue;
      chip.el.remove();
      barChips.delete(mint);
    }
    for (const mint of Object.keys(livePositionPrices)) {
      if (!held.has(mint)) delete livePositionPrices[mint];
    }

    const wasHidden = els.bar.classList.contains('pt-hidden');
    els.bar.classList.toggle('pt-hidden', !show);
    // Re-measure when the bar becomes visible: the host header has painted by
    // then, and SPA navigation can change its width.
    if (show && wasHidden) positionBar();
    if (els.barTab) {
      els.barTab.style.display = enabled && rows.length > 0 && positionsBarHidden ? 'flex' : 'none';
    }
    // Nudge the host page down so a fixed site header isn't covered.
    applyBarOffset(show);
    if (!show) return;

    const summary = Q.portfolioSummary(rows);
    if (els.barTotal) {
      // Built once, then updated via textContent only. Nothing derived from a
      // token's own metadata is ever interpreted as markup.
      if (!barTotalEls) {
        els.barTotal.textContent = '';
        const count = document.createElement('span');
        count.className = 'k';
        const sol = document.createElement('span');
        sol.className = 'v';
        const pct = document.createElement('span');
        pct.className = 'v';
        pct.style.fontSize = '11px';
        pct.style.opacity = '.75';
        els.barTotal.appendChild(count);
        els.barTotal.appendChild(sol);
        els.barTotal.appendChild(pct);
        barTotalEls = { count, sol, pct };
      }
      const sign = summary.up ? '+' : '';
      barTotalEls.count.textContent = `${rows.length} position${rows.length === 1 ? '' : 's'}`;
      barTotalEls.sol.textContent = `${sign}${E.fmt(summary.pnlSol, 3)} SOL`;
      barTotalEls.pct.textContent = `${sign}${summary.pnlPct.toFixed(1)}%`;
      for (const node of [barTotalEls.sol, barTotalEls.pct]) {
        node.classList.toggle('pt-green', summary.up);
        node.classList.toggle('pt-red', !summary.up);
      }
    }

    for (const row of rows) {
      let chip = barChips.get(row.mint);
      if (!chip) {
        chip = buildChip(row);
        barChips.set(row.mint, chip);
        // Only touch DOM order when a chip is genuinely new. Re-appending on
        // every tick would reset the rail's scroll position mid-drag.
        els.barRail.appendChild(chip.el);
      }
      updateChip(chip, row);
    }

    // Re-order only when the intended order actually differs from the DOM.
    const desired = rows.map((row) => barChips.get(row.mint).el);
    const current = els.barRail.children;
    let ordered = desired.length === current.length;
    if (ordered) {
      for (let i = 0; i < desired.length; i++) {
        if (current[i] !== desired[i]) { ordered = false; break; }
      }
    }
    if (!ordered) desired.forEach((el) => els.barRail.appendChild(el));
  }

  function buildChip(row) {
    const el = document.createElement('button');
    el.className = 'pt-chip';
    el.innerHTML =
      '<span class="pt-chip-dot"></span>' +
      '<span class="pt-chip-sym"></span>' +
      '<span class="pt-chip-pnl"></span>' +
      '<span class="pt-chip-pct"></span>';
    const chip = {
      el,
      dot: el.querySelector('.pt-chip-dot'),
      sym: el.querySelector('.pt-chip-sym'),
      pnl: el.querySelector('.pt-chip-pnl'),
      pct: el.querySelector('.pt-chip-pct'),
      mint: row.mint,
      lastPnl: null,
    };
    el.addEventListener('click', () => openPositionChart(chip.mint));
    return chip;
  }

  function updateChip(chip, row) {
    const sign = row.pnlSol >= 0 ? '+' : '';
    chip.mint = row.mint;
    chip.sym.textContent = row.symbol;
    chip.pnl.textContent = `${sign}${E.fmt(row.pnlSol, 3)}`;
    chip.pct.textContent = `${sign}${row.pnlPct.toFixed(1)}%`;

    // Color by TOTAL position P&L, never by the direction of the last tick.
    chip.el.classList.toggle('pt-green', row.up);
    chip.el.classList.toggle('pt-red', !row.up);
    chip.el.classList.toggle('active', row.active);
    chip.el.classList.toggle('stale', row.stale);
    chip.el.title = row.stale
      ? `${row.symbol} — ${E.fmt(row.valueSol, 4)} SOL · price not live yet`
      : `${row.symbol} — ${E.fmt(row.valueSol, 4)} SOL · click to open its chart`;

    if (chip.lastPnl !== null && row.pnlSol !== chip.lastPnl) {
      const cls = row.up ? 'pt-flash-up' : 'pt-flash-down';
      chip.el.classList.remove('pt-flash-up', 'pt-flash-down');
      void chip.el.offsetWidth;
      chip.el.classList.add(cls);
    }
    chip.lastPnl = row.pnlSol;
  }

  /**
   * Keep prices fresh for positions the user is NOT currently looking at.
   *
   * The on-screen token already streams from the page's own feed, so it is
   * excluded here; only off-screen mints are batched to Dexscreener. Requests
   * never stack, and a hidden tab backs off hard.
   */
  async function pollPositionPrices() {
    if (settings.positionsBarEnabled === false) return;
    if (barPollInFlight) return;

    const mints = Object.keys(state.positions || {}).filter(
      (mint) => !(token && token.mint === mint)
    );
    if (!mints.length) return;

    const now = Date.now();
    const interval = document.hidden ? BAR_POLL_HIDDEN_MS : BAR_POLL_MS;
    if (barPollAt && now - barPollAt < interval) return;

    barPollInFlight = true;
    barPollAt = now;
    try {
      const prices = await R.batchPrices(mints);
      let changed = false;
      for (const mint of Object.keys(prices)) {
        const quote = prices[mint];
        if (!quote || !(quote.priceNative > 0)) continue;
        livePositionPrices[mint] = { priceNative: quote.priceNative, priceUsd: quote.priceUsd };
        // Mark the engine too, so peak/trough and equity stay truthful for
        // positions the user never has on screen.
        E.markPosition(state, mint, quote.priceNative, quote.priceUsd);
        changed = true;
      }
      if (changed) {
        persistSoon();
        renderPositionsBar();
        renderBalance();
      }
    } catch (e) {
      /* offline or rate-limited: keep the last marks and flag rows stale */
    } finally {
      barPollInFlight = false;
    }
  }

  /** Navigate to a held token's chart, preferring the site it was opened on. */
  function openPositionChart(mint) {
    if (!mint) return;
    if (token && token.mint === mint) return; // already here
    const pos = state.positions && state.positions[mint];
    const url = S.tokenUrlFor(mint, {
      siteId: (pos && pos.site) || (site && site.id),
      pairAddress: pos && pos.pairAddress,
      fallbackSite: site,
    });
    if (!url) return;
    // Same tab: this mirrors Padre's own bar, where a position swaps the chart.
    window.location.href = url;
  }

  /**
   * Find where the host site's own top-left branding ends, so the bar can sit
   * in the empty space beside it instead of on top of the site's controls.
   *
   * Measuring beats hardcoding: every site's header is a different width, and
   * a fixed offset that looks right on Padre would overlap something else on
   * Axiom or Photon. Falls back to a sane default if nothing is measurable.
   */
  function measureBarLeft() {
    const DEFAULT_LEFT = 210;
    const MIN_LEFT = 96;
    const MAX_LEFT = 460;
    try {
      // Sample the strip where a site header's logo lives and take the
      // right-most edge of the elements actually painted there.
      const probeY = 24;
      let edge = 0;
      for (let x = 8; x <= 420; x += 28) {
        const el = document.elementFromPoint(x, probeY);
        if (!el || el === document.body || el === document.documentElement) continue;
        // Ignore our own shadow host.
        if (host && (el === host || (host.contains && host.contains(el)))) continue;
        const rect = el.getBoundingClientRect();
        // Only consider compact header-ish elements, not full-width containers.
        if (rect.width > 0 && rect.width < 420 && rect.top < 60 && rect.right > edge) {
          edge = rect.right;
        }
      }
      if (edge > 0) return Math.min(MAX_LEFT, Math.max(MIN_LEFT, Math.round(edge + 18)));
    } catch (_) { /* cross-origin or exotic layout: use the default */ }
    return DEFAULT_LEFT;
  }

  /** Position the bar once the page has painted its own header. */
  function positionBar() {
    if (!els.bar) return;
    const left = typeof settings.positionsBarLeft === 'number' ? settings.positionsBarLeft : measureBarLeft();
    const top = typeof settings.positionsBarTop === 'number' ? settings.positionsBarTop : 7;
    els.bar.style.setProperty('--pt-bar-left', left + 'px');
    els.bar.style.setProperty('--pt-bar-top', top + 'px');
    if (els.barTab) {
      els.barTab.style.setProperty('--pt-bar-left', left + 'px');
      els.barTab.style.setProperty('--pt-bar-top', top + 'px');
    }
  }

  /**
   * The bar deliberately does NOT reflow the host page.
   *
   * The obvious approach — margin-top on <html> — is wrong: it does not move
   * `position: fixed` site headers, so on Padre (and most trading UIs, which
   * all pin their nav) the bar would sit ON TOP of the site's own controls and
   * make them unclickable. Verified visually against a fixed-header page.
   *
   * Instead the bar floats as an overlay and is inset from the left, leaving
   * the site's own top-left nav and logo visible and clickable underneath.
   * Nothing about the host layout is mutated, so there is also nothing to
   * revert or leak when the bar hides.
   */
  function applyBarOffset() { /* intentionally a no-op — see comment above */ }

  /**
   * Feed-health dot: green while ticks are arriving, amber the moment the
   * quote goes stale. It reads the same staleness contract the header uses,
   * so the dot can never disagree with the price it sits beside.
   */
  function renderLiveDot() {
    if (!els.liveDot) return;
    const hasPrice = Boolean(token && token.priceNative);
    const stale = !hasPrice || Q.isPriceStale(lastPriceAt, Date.now());
    els.liveDot.classList.toggle('on', hasPrice && !stale);
    els.liveDot.classList.toggle('warn', hasPrice && stale);
  }

  /**
   * Micro-sparkline of the recent price series, drawn as an SVG path.
   * Colored by move direction across the window, with a soft area fill and a
   * pulsing head so the newest tick is obvious in peripheral vision.
   */
  function renderSparkline() {
    if (!els.spark) return;
    const pts = series.slice(-64).map((s) => Number(s.p)).filter((p) => p > 0);
    if (pts.length < 3) { els.spark.textContent = ''; return; }

    const w = 100, h = 26, pad = 2;
    const min = Math.min(...pts), max = Math.max(...pts);
    const span = max - min || max || 1;
    const step = w / (pts.length - 1);
    const y = (p) => pad + (h - pad * 2) * (1 - (p - min) / span);

    const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(2)},${y(p).toFixed(2)}`).join(' ');
    const up = pts[pts.length - 1] >= pts[0];
    const stroke = up ? '#34D399' : '#FF5F56';
    const headY = y(pts[pts.length - 1]).toFixed(2);

    els.spark.innerHTML =
      `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">` +
        `<defs><linearGradient id="ptSparkFill" x1="0" y1="0" x2="0" y2="1">` +
          `<stop offset="0%" stop-color="${stroke}" stop-opacity="0.32"/>` +
          `<stop offset="100%" stop-color="${stroke}" stop-opacity="0"/>` +
        `</linearGradient></defs>` +
        `<path d="${line} L${w},${h} L0,${h} Z" fill="url(#ptSparkFill)" stroke="none"/>` +
        `<path d="${line}" fill="none" stroke="${stroke}" stroke-width="1.6" ` +
          `stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>` +
        `<circle cx="${w}" cy="${headY}" r="2" fill="${stroke}"/>` +
      `</svg>`;
  }

  /**
   * Render the position card.
   *
   * This runs on every heartbeat, so the card is built ONCE and thereafter
   * only its numbers are updated in place. Rebuilding innerHTML twice a second
   * would rip out the sell buttons under the user's cursor and kill their
   * click, which is unacceptable on a panel whose whole job is fast exits.
   */
  function renderPosition() {
    if (!els.position) return;
    const pos = token && state.positions[token.mint];

    if (!pos) {
      if (els.position.childNodes.length) els.position.textContent = '';
      posEls = null;
      return;
    }

    if (!posEls) buildPositionCard(pos);

    const mark = Q.positionMark(pos, token.priceNative, token.priceUsd);
    if (!mark) return;

    posEls.qty.textContent = `${E.fmt(mark.qty, 2)} ${pos.symbol}`;
    // "I got in at 240K" is how the entry is actually discussed, so the card
    // shows the market cap at entry whenever the cap is known.
    posEls.entry.textContent = entryText(mark.avgEntry);
    posEls.value.textContent = `${E.fmt(mark.valueSol, 4)} SOL`;

    const sign = mark.pnlSol >= 0 ? '+' : '';
    posEls.pnl.textContent =
      `${sign}${E.fmt(mark.pnlSol)} SOL (${mark.pnlPct.toFixed(1)}%)` +
      (mark.pnlUsd !== null ? ` · ${E.fmtUsd(mark.pnlUsd)}` : '');
    posEls.pnl.classList.toggle('pt-green', mark.up);
    posEls.pnl.classList.toggle('pt-red', !mark.up);

    // Flash when the underlying price moves, but color by TOTAL position P&L,
    // never by tick direction. A losing position stays red during a bounce;
    // a profitable position stays green during a pullback.
    if (lastRenderedPrice !== null && mark.price !== lastRenderedPrice) {
      const cls = mark.up ? 'pt-flash-up' : 'pt-flash-down';
      posEls.pnl.classList.remove('pt-flash-up', 'pt-flash-down');
      // Force a reflow so the animation restarts on consecutive ticks.
      void posEls.pnl.offsetWidth;
      posEls.pnl.classList.add(cls);
    }
    lastRenderedPrice = mark.price;
  }

  /**
   * Keep the newest realized result visible after a sell. Full exits show the
   * complete round-trip result; partial exits show the realized slice.
   */
  function renderClosedPnl() {
    if (!els.closed) return;
    const closed = token && E.latestClosedPnl(state, token.mint);
    if (!closed) {
      if (els.closed.childNodes.length) els.closed.textContent = '';
      return;
    }

    const sign = closed.pnlSol >= 0 ? '+' : '';
    const pctSign = closed.pnlPct >= 0 ? '+' : '';
    const badge = closed.kind === 'round' ? 'POSITION CLOSED' : 'PARTIAL EXIT';

    els.closed.textContent = '';
    const card = document.createElement('div');
    card.className = 'pt-closed';

    const head = document.createElement('div');
    head.className = 'pt-closed-head';
    const title = document.createElement('span');
    title.className = 'pt-closed-title';
    title.textContent = 'Closed P&L';
    const status = document.createElement('span');
    status.className = 'pt-closed-badge';
    status.textContent = badge;
    head.appendChild(title);
    head.appendChild(status);

    const pnl = document.createElement('div');
    pnl.className = `pt-closed-pnl ${closed.pnlSol >= 0 ? 'pt-green' : 'pt-red'}`;
    pnl.textContent = `${sign}${E.fmt(closed.pnlSol)} SOL (${pctSign}${closed.pnlPct.toFixed(1)}%)`;

    const meta = document.createElement('div');
    meta.className = 'pt-closed-meta';
    meta.textContent = `Returned ${E.fmt(closed.returnedSol, 4)} SOL · ${closedAgo(closed.closedAt)}`;

    card.appendChild(head);
    card.appendChild(pnl);
    card.appendChild(meta);
    els.closed.appendChild(card);
  }

  function closedAgo(ts) {
    const seconds = Math.max(0, Math.floor((Date.now() - Number(ts || 0)) / 1000));
    if (seconds < 5) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    return `${Math.floor(seconds / 3600)}h ago`;
  }

  /** Build the static structure of the position card exactly once. */
  function buildPositionCard(pos) {
    els.position.textContent = '';
    const card = document.createElement('div');
    card.className = 'pt-pos';
    card.innerHTML = `
      <div class="row"><span class="k">Position size</span><span class="v big" data-f="qty"></span></div>
      <div class="row"><span class="k">Avg entry</span><span class="v" data-f="entry"></span></div>
      <div class="row"><span class="k">Value</span><span class="v" data-f="value"></span></div>
      <div class="row row-pnl"><span class="k">Unrealized P&amp;L</span><span class="v pnl" data-f="pnl"></span></div>
      <div class="pt-label" style="margin-top:10px">Quick sell</div>
      <div class="pt-sell-row" data-f="sell"></div>
    `;
    els.position.appendChild(card);

    posEls = {
      qty: card.querySelector('[data-f="qty"]'),
      entry: card.querySelector('[data-f="entry"]'),
      value: card.querySelector('[data-f="value"]'),
      pnl: card.querySelector('[data-f="pnl"]'),
    };

    const row = card.querySelector('[data-f="sell"]');
    (settings.sellPcts || [25, 50, 75, 100]).forEach((p) => {
      const b = document.createElement('button');
      b.className = 'pt-sell';
      b.textContent = p + '%';
      b.addEventListener('click', () => {
        primeAudio();
        doSell(p / 100);
      });
      row.appendChild(b);
    });
  }

  let toastN = 0;
  function toast(msg) {
    const root = shadow && shadow.getElementById('pt-toast-root');
    if (!root) return;
    const d = document.createElement('div');
    d.className = 'pt-toast';
    d.style.top = 74 + toastN * 52 + 'px';
    toastN = (toastN + 1) % 4;
    d.textContent = msg;
    root.appendChild(d);
    setTimeout(() => d.remove(), 4200);
  }

  // Prices and market caps share one readable convention across the whole
  // overlay. Scientific notation ("3.97e-8") was reported as unreadable, so
  // sub-cent values use subscript-zero notation instead.
  function trimSci(p) { return Q.formatPrice(p); }
  function fmtMoney(n) { return Q.formatMarketCap(n); }

  /**
   * Market cap implied by a SOL-denominated price for the token on screen.
   *
   * Supply is constant on the timescale of a trade, so the live cap and the
   * live price move together. Scaling the current cap by the price ratio gives
   * the cap AT THAT PRICE without needing a second data source, which is what
   * keeps the entry figure consistent with the header.
   */
  function mcapAtPrice(priceNative) {
    if (!(priceNative > 0) || !token) return null;
    const nowPrice = Number(token.priceNative);
    const nowMcap = Number(token.mcap);
    if (!(nowPrice > 0) || !(nowMcap > 0)) return null;
    return nowMcap * (priceNative / nowPrice);
  }

  /** Entry figure in the unit traders actually use, price only as a fallback. */
  function entryText(priceNative) {
    const mcap = mcapAtPrice(priceNative);
    if (mcap) return `${fmtMoney(mcap)} MC`;
    return `${trimSci(priceNative)} SOL`;
  }

  if (contextAlive()) chrome.runtime.onMessage.addListener((msg) => {
    if (contextDead) return;
    if (msg?.type === 'pt_toggle_overlay') {
      // The popup / toolbar toggle flips the master overlay switch, so the
      // user can turn the whole thing on or off from the browser action.
      toggleOverlayEnabled().catch(() => {});
    }
  });

  function stopOverlays() {
    stopPriceLoop();
    if (fastDetectTimer) { clearInterval(fastDetectTimer); fastDetectTimer = null; }
    if (detectLoopTimer) { clearInterval(detectLoopTimer); detectLoopTimer = null; }
    if (barScanTimer) { clearInterval(barScanTimer); barScanTimer = null; }
    if (rowBuyObserver) { try { rowBuyObserver.disconnect(); } catch (_) {} rowBuyObserver = null; }
  }

  async function enableOverlay() {
    if (host) return;
    createUI();
    detectLoopTimer = managedInterval(detectLoop, DETECT_MS);

    // Sniping cadence: while an address is detected but not yet indexed by any
    // source, retry rapidly. This is the difference between being able to
    // paper-snipe a launch and watching it happen. It stops the moment the
    // token resolves, so steady-state cost is zero.
    // The host header may render after us, and SPA route changes can resize it.
    setTimeout(() => { if (contextAlive()) positionBar(); }, 400);
    setTimeout(() => { if (contextAlive()) positionBar(); }, 1500);
    window.addEventListener('resize', positionBar);
    onTeardown(() => { try { window.removeEventListener('resize', positionBar); } catch (_) {} });

    fastDetectTimer = managedInterval(() => {
      if (!token || !token.pending || resolving) return;
      // Give up the rapid cadence after a while; the 800ms loop still retries.
      if (pendingSince && Date.now() - pendingSince > FAST_RETRY_WINDOW_MS) return;
      detectLoop();
    }, FAST_RETRY_MS);

    // The positions bar runs on its own cadence, independent of the price
    // heartbeat: it must keep working on pages where no token is detected at
    // all, which is exactly when the user is browsing for the next trade.
    barScanTimer = managedInterval(() => {
      pollPositionPrices();
      // Cheap no-op when nothing changed, so an idle bar does not churn the
      // DOM (and cannot fight the user's horizontal scroll or a live click).
      renderPositionsBar();
      // Screener rows render continuously; catch new ones on this cadence.
      scanRowBuys();
    }, 1000);
    pollPositionPrices();
    startRowBuyObserver();

    await detectLoop();
  }

  function disableOverlay() {
    if (!host) return;
    stopOverlays();
    try { host.remove(); } catch (_) {}
    host = null; shadow = null; els = {};
  }

  async function init() {
    // price-bridge.js is declared by the manifest in MAIN world at
    // document_start, before Padre creates its WebSocket and TradingView feed.
    await reloadState();
    // Storage must be watched even when the overlay is disabled, so toggling
    // settings from the dashboard or popup reaches this tab immediately.
    watchStorage();
    if (!settings.overlayEnabled) return;
    await enableOverlay();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => init().catch(() => {}));
  else init().catch(() => {});
})();
