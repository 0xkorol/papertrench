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
  let token = null; // {kind, address, mint, pairAddress, symbol, priceNative, priceUsd, mcap}
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
  let resolving = false;
  // Fresh-launch tracking: how long the current address has been unresolved.
  let pendingSince = 0;
  let pendingAttempts = 0;
  let fastDetectTimer = null;
  let lastCmTickPrice = 0; // avoids feeding chart markers the same price repeatedly
  const CM = window.PTChartMarkers; // chart bubble markers
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
   */
  const store = {
    get: (keys) => new Promise((resolve) => {
      if (!contextAlive()) { shutdown('invalidated'); resolve({}); return; }
      try {
        chrome.storage.local.get(keys, (value) => {
          if (chrome.runtime && chrome.runtime.lastError) { resolve({}); return; }
          resolve(value || {});
        });
      } catch (_) { shutdown('invalidated'); resolve({}); }
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
    if (ev.type === 'tick') handlePageTick(ev.payload);
    else if (ev.type === 'padre-hook-status') {
      padreHookStatus = { ...padreHookStatus, ...(ev.payload || {}) };
      renderSiteStatus();
    } else if (ev.type === 'paper-marker-status') {
      lastMarkerStatus = ev.payload || null;
      renderSiteStatus();
    } else if (ev.type === 'paper-lines-status') {
      lastLineStatus = ev.payload || null;
      renderSiteStatus();
    }
  }
  window.addEventListener('message', onBridgeMessage);

  function sendPadreMarker(type, payload) {
    window.postMessage({ source: 'papertrench-content', type, payload: payload || null }, '*');
  }

  /* -------------------- price handling -------------------- */

  /**
   * A tick from the page's own feed may only refine a price we already trust.
   * Until the resolver has produced an anchor there is nothing to validate
   * against, so ticks are ignored rather than guessed at — that is what keeps
   * a stray page number off the display and out of fills.
   */
  function handlePageTick(payload) {
    if (!payload || !token || !token.priceNative) return;

    const verdict = Q.validateTick(token, payload);
    if (!verdict.accepted) return;

    const oldNative = Number(token.priceNative);
    token.priceNative = verdict.priceNative;
    if (verdict.priceUsd) token.priceUsd = verdict.priceUsd;
    if (verdict.mcap) token.mcap = verdict.mcap;
    token.priceSource = payload.source || 'page-feed';

    lastPriceAt = Date.now();
    flushArmedBuy();
    // A duplicate tick still proves the feed is alive, but it does not need a
    // position mark, storage write, or DOM render.
    if (token.priceNative === oldNative) return;

    series.push({ t: lastPriceAt, p: token.priceNative, usd: token.priceUsd });
    if (series.length > SERIES_CAP) series.shift();
    E.markPosition(state, token.mint, token.priceNative, token.priceUsd);
    maybeProfitAlert(token.mint);
    if (CM && (!site || site.id !== 'padre')) CM.tickPrice(token.priceNative);
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
    } finally { resolving = false; }
  }



  function setToken(data) {
    const prevMint = token?.mint;
    const hadPrice = Boolean(token && token.priceNative);
    token = data;
    // Navigating to a different token invalidates any armed intent.
    if (token && prevMint && token.mint !== prevMint) armedBuy = null;
    if (!token) armedBuy = null;
    void hadPrice;
    if (!token || token.mint !== prevMint) {
      // The cached card belongs to the previous token; force a rebuild.
      posEls = null;
      lastRenderedPrice = null;
    }
    if (token && token.mint !== prevMint) {
      series = []; marks = [];
      lastPriceAt = 0;
      lastCmTickPrice = 0;
      if (site && site.id === 'padre') {
        // Padre uses its own TradingView getMarks pipeline. Clear native paper
        // marks for the previous token; do not mount the generic SVG overlay.
        sendPadreMarker('paper-marker-clear');
        sendPadreMarker('paper-lines-clear');
        if (CM) CM.destroyChartMarkers();
      } else if (CM) {
        CM.clearMarkers();
        CM.initChartMarkers();
      }
      startPriceLoop();
    }
    if (!token) {
      stopPriceLoop();
      if (CM) CM.destroyChartMarkers();
      if (site && site.id === 'padre') {
        sendPadreMarker('paper-marker-clear');
        sendPadreMarker('paper-lines-clear');
      }
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
      if (CM && (!site || site.id !== 'padre') && token.priceNative && token.priceNative !== lastCmTickPrice) {
        lastCmTickPrice = token.priceNative;
        CM.tickPrice(token.priceNative);
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

      token.priceNative = fresh.priceNative;
      if (fresh.priceUsd) token.priceUsd = fresh.priceUsd;
      if (fresh.mcap) token.mcap = fresh.mcap;
      token.priceSource = 'resolver';

      lastPriceAt = Date.now();
      series.push({ t: lastPriceAt, p: token.priceNative, usd: token.priceUsd });
      if (series.length > SERIES_CAP) series.shift();
      E.markPosition(state, token.mint, token.priceNative, token.priceUsd);
      maybeProfitAlert(token.mint);
      if (CM && (!site || site.id !== 'padre')) CM.tickPrice(token.priceNative);
      persistSoon();
      renderHeader();
      renderPosition();
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

  /* -------------------- fills -------------------- */

  let mutationChain = Promise.resolve();
  function withState(fn) {
    mutationChain = mutationChain.then(async () => { await reloadState(); return fn(); }).catch(() => {});
    return mutationChain;
  }

  async function reloadState() {
    const stored = await store.get([E.STORAGE_KEYS.state, E.STORAGE_KEYS.settings]);
    settings = E.mergeSettings(stored[E.STORAGE_KEYS.settings]);
    state = stored[E.STORAGE_KEYS.state] || E.defaultState(settings);
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
        if (els.buyPresets) renderPresets();
        syncAveragePriceLines();
      }

      const stateChange = changes[E.STORAGE_KEYS.state];
      if (!stateChange) return;
      const next = stateChange.newValue;
      if (!next || next === state) return;
      if (lastWrittenState && next === lastWrittenState) return; // our own write

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
    if (!CM || !token || !token.mint) return;
    const fills = (state.journal || []).filter(
      (t) => t.mint === token.mint && (t.side === 'buy' || t.side === 'sell')
    ).reverse(); // journal is newest-first; we want chronological
    for (const f of fills) {
      const marker = {
        ts: f.ts,
        priceNative: f.priceNative,
        side: f.side,
        solAmount: f.solGross,
        symbol: f.symbol || token.symbol,
      };
      if (site && site.id === 'padre') sendPadreMarker('paper-marker', marker);
      else CM.addMarker({ ...marker, price: marker.priceNative });
    }
  }

  function syncAveragePriceLines() {
    if (!site || site.id !== 'padre') return;
    if (!settings.averagePriceLinesEnabled || !token || !token.mint) {
      sendPadreMarker('paper-lines-clear');
      return;
    }

    const averages = E.averageFillPrices(state, token.mint);
    if (!averages) {
      sendPadreMarker('paper-lines-clear');
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

    sendPadreMarker('paper-lines', {
      enabled: true,
      avgBuyUsd,
      avgSellUsd,
    });
  }

  let persistTimer = null;
  let lastWrittenState = null;
  function persistSoon() {
    if (persistTimer) return;
    persistTimer = setTimeout(async () => {
      persistTimer = null;
      if (!contextAlive()) { shutdown('invalidated'); return; }
      lastWrittenState = state;
      await store.set({ [E.STORAGE_KEYS.state]: state });
    }, 800);
  }

  async function doBuy(solAmount) {
    if (!token) return toast('No token detected on this page');
    if (!token.priceNative) return toast('Need SOL-denominated price to paper buy. Try waiting one tick or refresh the chart.');
    try {
      const result = await withState(async () => {
        const hadPosition = Boolean(state.positions[token.mint]);
        const { trade, position } = E.buy(state, settings, {
          ts: Date.now(), mint: token.mint, pairAddress: token.pairAddress,
          symbol: token.symbol, name: token.name, site: site.id,
          priceNative: token.priceNative, priceUsd: token.priceUsd, mcap: token.mcap,
          solAmount,
        });
        // Commit the fill to the evidence chain before persisting, so the
        // stored snapshot and its attestation are written atomically.
        await commitFill(trade);
        await store.set({ [E.STORAGE_KEYS.state]: state });
        const markerTs = Date.now();
        marks.push({ t: markerTs, p: trade.priceNative, side: 'buy' });
        if (site && site.id === 'padre') {
          sendPadreMarker('paper-marker', {
            ts: markerTs,
            priceNative: trade.priceNative,
            side: 'buy',
            solAmount,
            symbol: token.symbol,
          });
        } else if (CM) {
          CM.addMarker({ ts: markerTs, price: trade.priceNative, side: 'buy', solAmount, symbol: token.symbol });
        }
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
        toast(`Bought ${E.fmt(solAmount, 3)} SOL of ${token.symbol} (paper)`);
      }
    } catch (err) { toast(err.message || 'Buy failed'); }
    renderAll();
  }

  async function doSell(fraction) {
    if (!token) return toast('No token detected on this page');
    if (!token.priceNative) return toast('Need SOL-denominated price to paper sell. Try waiting one tick or refresh the chart.');
    try {
      const result = await withState(async () => {
        const { trade, position, round } = E.sell(state, settings, {
          ts: Date.now(), mint: token.mint, site: site.id,
          qtyFraction: fraction, priceNative: token.priceNative, priceUsd: token.priceUsd,
        });
        await commitFill(trade);
        await store.set({ [E.STORAGE_KEYS.state]: state });
        const markerTs = Date.now();
        marks.push({ t: markerTs, p: trade.priceNative, side: 'sell' });
        if (site && site.id === 'padre') {
          sendPadreMarker('paper-marker', {
            ts: markerTs,
            priceNative: trade.priceNative,
            side: 'sell',
            solAmount: trade.solGross,
            symbol: token.symbol,
          });
        } else if (CM) {
          CM.addMarker({ ts: markerTs, price: trade.priceNative, side: 'sell', solAmount: trade.solGross, symbol: token.symbol });
        }
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
        toast(`Sold ${Math.round(fraction * 100)}% — ${pnl >= 0 ? '+' : ''}${E.fmt(pnl)} SOL paper`);
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

    .pt-body { position: relative; z-index: 2; padding: 13px 12px 14px; }

    .pt-token-row {
      display: flex; align-items: flex-start; justify-content: space-between; gap: 10px;
      margin-bottom: 11px;
    }
    .pt-token { min-width: 0; }
    .pt-token > div:first-child {
      font-size: 17px; font-weight: 800; letter-spacing: -0.3px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 165px;
    }
    .pt-mint {
      display: inline-block; margin-top: 4px; padding: 2px 7px;
      max-width: 165px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
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
      position: fixed; top: 7px; left: var(--pt-bar-left, 210px); right: auto; z-index: 2147483645;
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
      position: fixed; top: 7px; left: var(--pt-bar-left, 210px); right: auto;
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
    els.barTotal = shadow.getElementById('pt-bar-total');
    els.barRail = shadow.getElementById('pt-bar-rail');
    els.barTab = shadow.getElementById('pt-bar-tab');
    els.liveDot = shadow.getElementById('pt-live-dot');
    els.delta = shadow.getElementById('pt-delta');
    els.pillText = shadow.getElementById('pt-pill-text');

    bindUI();
    renderPresets();
    renderAll();
  }

  function bindUI() {
    // A user gesture unlocks Web Audio so a later hidden-tab profit bell is
    // allowed to play. Creating/resuming here is silent.
    els.box.addEventListener('pointerdown', primeAudio);

    shadow.getElementById('pt-min').addEventListener('click', () => {
      els.box.classList.add('pt-hidden');
      els.pill.style.display = 'block';
    });
    els.pill.addEventListener('click', () => {
      els.box.classList.remove('pt-hidden');
      els.pill.style.display = 'none';
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

    shadow.getElementById('pt-dash').addEventListener('click', openDashboard);
    shadow.getElementById('pt-settings').addEventListener('click', openDashboard);
    shadow.getElementById('pt-reset').addEventListener('click', async () => {
      if (!confirm(`Reset paper wallet to ${settings.balanceStartSol} SOL? All history is wiped.`)) return;
      await withState(async () => { state = E.resetState(settings); await store.set({ [E.STORAGE_KEYS.state]: state }); });
      syncAveragePriceLines();
      renderAll(); toast('Paper wallet reset');
    });
    els.btnBuy.addEventListener('click', () => {
      const custom = Number(els.custom.value);
      const sel = els.buyPresets.querySelector('.pt-preset.sel');
      const amt = custom > 0 ? custom : sel ? Number(sel.dataset.amt) : 0;
      if (!(amt > 0)) return toast('Pick a SOL amount first');
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
      doBuy(amt);
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

  function openDashboard() { sendMessage({ type: 'pt_open_dashboard' }); }

  function renderPresets() {
    const list = settings.presetsBuy || [0.1, 0.5, 1, 2];
    els.buyPresets.innerHTML = list.map((a, i) => `<button class="pt-preset${i === 1 ? ' sel' : ''}" data-amt="${a}">${a} SOL</button>`).join('');
    els.buyPresets.querySelectorAll('.pt-preset').forEach((b) => {
      b.addEventListener('click', () => {
        els.buyPresets.querySelectorAll('.pt-preset').forEach((x) => x.classList.remove('sel'));
        b.classList.add('sel'); els.custom.value = '';
      });
    });
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
    renderPositionsBar();
  }

  function renderSiteStatus() {
    if (!els.footSite) return;
    if (!site) {
      els.footSite.textContent = '';
      if (els.subtitle) els.subtitle.textContent = 'Open a token page to begin';
      return;
    }
    if (site.id !== 'padre') {
      els.footSite.textContent = `Site: ${site.name}`;
      if (els.subtitle) els.subtitle.textContent = site.name;
      return;
    }
    const live = padreHookStatus.barsHooked ? 'LIVE ✓' : 'live connecting…';
    const markersReady = padreHookStatus.marksHooked ? 'MARKS ✓' : 'marks connecting…';
    const lines = settings.averagePriceLinesEnabled
      ? ` · ${(lastLineStatus && lastLineStatus.ok) || padreHookStatus.linesReady ? 'LINES ✓' : 'lines connecting…'}`
      : '';
    els.footSite.textContent = `Padre · ${live} · ${markersReady}${lines}`;
    if (els.subtitle) {
      els.subtitle.textContent = padreHookStatus.barsHooked
        ? 'Padre · live feed connected'
        : 'Padre · connecting…';
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
    const usdLine = f.priceUsdText
      ? `${f.priceUsdText}${token && token.mcap ? ' · MC ' + fmtMoney(token.mcap) : ''}`
      : '';
    els.priceUsd.textContent = f.stale ? `${usdLine} · reconnecting…`.trim() : usdLine;
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
        await store.set({ [E.STORAGE_KEYS.state]: state });
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
    const left = measureBarLeft();
    els.bar.style.setProperty('--pt-bar-left', left + 'px');
    if (els.barTab) els.barTab.style.setProperty('--pt-bar-left', left + 'px');
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
    posEls.entry.textContent = `${trimSci(mark.avgEntry)} SOL`;
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

  function trimSci(p) { return p < 0.0001 ? p.toExponential(2) : p.toFixed(8); }
  function fmtMoney(n) { return n >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? '$' + (n / 1e3).toFixed(1) + 'K' : '$' + Number(n).toFixed(0); }

  if (contextAlive()) chrome.runtime.onMessage.addListener((msg) => {
    if (contextDead) return;
    if (msg?.type === 'pt_toggle_overlay') {
      if (els.box.classList.contains('pt-hidden')) { els.box.classList.remove('pt-hidden'); els.pill.style.display = 'none'; }
      else { els.box.classList.add('pt-hidden'); els.pill.style.display = 'block'; }
    }
  });

  async function init() {
    // price-bridge.js is declared by the manifest in MAIN world at
    // document_start, before Padre creates its WebSocket and TradingView feed.
    await reloadState();
    if (!settings.overlayEnabled) return;
    createUI();
    watchStorage();
    managedInterval(detectLoop, DETECT_MS);

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
    managedInterval(() => {
      pollPositionPrices();
      // Cheap no-op when nothing changed, so an idle bar does not churn the
      // DOM (and cannot fight the user's horizontal scroll or a live click).
      renderPositionsBar();
    }, 1000);
    pollPositionPrices();

    await detectLoop();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => init().catch(() => {}));
  else init().catch(() => {});
})();
