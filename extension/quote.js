/* PaperTrench — pure quote logic.
 *
 * No DOM, no network, no chrome APIs. Everything here is a pure function so it
 * can be driven directly by tests, and it is the SAME code the extension runs
 * in the browser (browser global + guarded CommonJS export at the bottom).
 *
 * Three responsibilities:
 *   pickBestPair / normalizePair  — turn a Dexscreener payload into identity
 *                                   + anchor quote (criterion 1)
 *   validateTick                  — decide whether a page-feed tick may be
 *                                   trusted against that anchor (criterion 2)
 *   headerFields                  — derive what the overlay header shows
 *                                   (criterion 3)
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 1. Identity + anchor quote from a Dexscreener payload
   * ------------------------------------------------------------------ */

  /**
   * Choose the pair a trading UI would actually quote: the Solana pair with a
   * usable price and the deepest liquidity. Shallow pools produce wild prices,
   * so liquidity depth is the correct tiebreak rather than array order.
   */
  function pickBestPair(pairs) {
    if (!Array.isArray(pairs)) return null;
    const usable = pairs.filter(
      (p) => p && p.chainId === 'solana' && Number(p.priceNative) > 0
    );
    if (!usable.length) return null;
    return usable.reduce((best, p) => {
      const a = Number((p.liquidity && p.liquidity.usd) || 0);
      const b = Number((best.liquidity && best.liquidity.usd) || 0);
      return a > b ? p : best;
    });
  }

  /** Normalize one Dexscreener pair into our token record, or null if unusable. */
  function normalizePair(pair, fallbackAddress) {
    if (!pair) return null;
    const priceNative = Number(pair.priceNative);
    if (!(priceNative > 0)) return null;

    const base = pair.baseToken || {};
    const priceUsd = pair.priceUsd != null ? Number(pair.priceUsd) : null;
    const mcap = Number(pair.marketCap != null ? pair.marketCap : pair.fdv);

    return {
      mint: base.address || fallbackAddress || null,
      pairAddress: pair.pairAddress || null,
      symbol: base.symbol || null,
      name: base.name || base.symbol || null,
      priceNative,
      priceUsd: Number.isFinite(priceUsd) && priceUsd > 0 ? priceUsd : null,
      mcap: Number.isFinite(mcap) && mcap > 0 ? mcap : null,
      dex: pair.dexId || null,
      priceSource: 'resolver',
      resolvedAt: Date.now(),
    };
  }

  /**
   * Accept either Dexscreener response shape:
   *   /tokens/<mint>          -> { pairs: [...] }
   *   /pairs/solana/<pair>    -> { pair: {...} }  (or { pairs: [...] })
   */
  function tokenFromPayload(payload, fallbackAddress) {
    if (!payload || typeof payload !== 'object') return null;
    const pair = payload.pair || pickBestPair(payload.pairs);
    return normalizePair(pair, fallbackAddress);
  }

  /* ------------------------------------------------------------------ *
   * 1b. Fresh-launch identity from Jupiter
   *
   * Dexscreener does not index a token until a pool has been observed, which
   * on a brand-new pump.fun launch is measurably later than the coin exists.
   * That gap is exactly the window snipers care about, so a second source is
   * required. Jupiter's free token search returns new mints within seconds,
   * but quotes USD only — the SOL price is derived from a SOL/USD reference.
   * ------------------------------------------------------------------ */

  var WSOL_MINT = 'So11111111111111111111111111111111111111112';

  /** Pull the entry for `address` out of a Jupiter search response. */
  function jupiterEntry(payload, address) {
    var list = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.tokens) ? payload.tokens : null);
    if (!list) return null;
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (item && item.id === address) return item;
    }
    return null;
  }

  /**
   * Normalize one Jupiter token entry into our token record.
   *
   * `solUsd` is the SOL/USD rate used to convert Jupiter's USD quote into the
   * SOL-denominated price the engine trades in. Without a usable rate this
   * returns null rather than guessing, because a wrong rate silently corrupts
   * every fill and P&L number downstream.
   */
  function tokenFromJupiter(payload, address, solUsd) {
    var entry = jupiterEntry(payload, address);
    if (!entry) return null;

    var usd = Number(entry.usdPrice);
    var rate = Number(solUsd);
    if (!(usd > 0) || !(rate > 0)) return null;

    var priceNative = usd / rate;
    if (!(priceNative > 0) || !isFinite(priceNative)) return null;

    var mcap = Number(entry.mcap != null ? entry.mcap : entry.fdv);
    var createdAt = entry.firstPool && entry.firstPool.createdAt
      ? Date.parse(entry.firstPool.createdAt)
      : NaN;

    return {
      mint: entry.id || address || null,
      pairAddress: (entry.firstPool && entry.firstPool.id) || null,
      symbol: entry.symbol || null,
      name: entry.name || entry.symbol || null,
      priceNative: priceNative,
      priceUsd: usd,
      mcap: isFinite(mcap) && mcap > 0 ? mcap : null,
      dex: null,
      priceSource: 'jupiter',
      resolvedAt: Date.now(),
      // Surfaced so the UI can say "brand new" honestly instead of implying
      // an established market exists.
      launchedAt: isFinite(createdAt) ? createdAt : null,
      liquidityUsd: Number(entry.liquidity) > 0 ? Number(entry.liquidity) : null,
    };
  }

  /** Read the SOL/USD rate out of a Jupiter response that includes WSOL. */
  function solUsdFromJupiter(payload) {
    var entry = jupiterEntry(payload, WSOL_MINT);
    var usd = entry ? Number(entry.usdPrice) : NaN;
    return usd > 0 ? usd : null;
  }

  /**
   * Choose between two candidate token records for the same address.
   *
   * A record backed by an actual pool quote (Dexscreener) is preferred when
   * both exist, because it is the venue price. Jupiter wins only when it is
   * the sole source, which is precisely the fresh-launch case.
   */
  function preferResolved(dexRecord, jupRecord) {
    if (dexRecord && Number(dexRecord.priceNative) > 0) return dexRecord;
    if (jupRecord && Number(jupRecord.priceNative) > 0) return jupRecord;
    return null;
  }

  /* ------------------------------------------------------------------ *
   * 2. Tick validation against the trusted anchor
   * ------------------------------------------------------------------ */

  // A live price may drift far from the anchor during a memecoin move, but it
  // does not jump by orders of magnitude. A ratio band (not an absolute
  // epsilon) is required because these prices span 1e-9 .. 1e3.
  var ACCEPT_RATIO = 20;

  /**
   * Decide whether a tick from the page's own feed may update the price.
   *
   * @param {object} anchor  trusted token record { mint, priceNative, priceUsd }
   * @param {object} tick    bridge payload { mint?, candidates: [{value, unit}] }
   * @returns {{accepted: boolean, reason: string, priceNative: number|null, priceUsd: number|null}}
   *
   * Rejection is the default: a candidate must positively agree with the anchor.
   * This is what stops a stray page number (the observed bogus 0.44 SOL against
   * a ~0.00000004 SOL token) from ever becoming a displayed or fill price.
   */
  function validateTick(anchor, tick) {
    const reject = (reason) => ({
      accepted: false,
      reason,
      priceNative: anchor && Number(anchor.priceNative) > 0 ? Number(anchor.priceNative) : null,
      priceUsd: anchor && Number(anchor.priceUsd) > 0 ? Number(anchor.priceUsd) : null,
      mcap: anchor && Number(anchor.mcap) > 0 ? Number(anchor.mcap) : null,
      basis: null,
    });

    if (!anchor || !(Number(anchor.priceNative) > 0)) return reject('no-anchor');
    if (!tick || typeof tick !== 'object') return reject('no-candidates');
    // A tick carrying a different mint is about a different token entirely.
    if (tick.mint && anchor.mint && tick.mint !== anchor.mint) {
      return reject('mint-mismatch');
    }

    const candidates = Array.isArray(tick.candidates) ? tick.candidates : [];
    const anchorNative = Number(anchor.priceNative);
    const anchorUsd = Number(anchor.priceUsd) > 0 ? Number(anchor.priceUsd) : null;
    const anchorMcap = Number(anchor.mcap) > 0 ? Number(anchor.mcap) : null;

    let nextNative = null;
    let nextUsd = null;
    let nextMcap = null;
    let basis = null;

    for (const cand of candidates) {
      const v = Number(cand && cand.value);
      if (!(v > 0)) continue;
      const unit = (cand && cand.unit) || 'unknown';

      if (unit !== 'usd' && nextNative === null && withinBand(v, anchorNative)) {
        nextNative = v;
        basis = basis || 'native';
      }
      if (unit !== 'native' && anchorUsd && nextUsd === null && withinBand(v, anchorUsd)) {
        nextUsd = v;
        basis = basis || 'usd';
      }
    }

    // Padre's chart can display market cap instead of token price. Because
    // supply is constant during a normal tick, market-cap movement is exactly
    // price movement. Validate against the trusted mcap anchor, then derive
    // both SOL and USD token prices from the ratio.
    const tickMcap = Number(tick.mcap);
    if (anchorMcap && tickMcap > 0 && withinBand(tickMcap, anchorMcap)) {
      nextMcap = tickMcap;
      if (nextNative === null && nextUsd === null) {
        const ratio = tickMcap / anchorMcap;
        nextNative = anchorNative * ratio;
        nextUsd = anchorUsd ? anchorUsd * ratio : null;
        basis = 'mcap';
      }
    }

    if (nextNative === null && nextUsd === null) {
      return reject(candidates.length || tickMcap > 0 ? 'out-of-band' : 'no-candidates');
    }

    // A USD-only tick used to leave the SOL price frozen, which made SOL P&L
    // look delayed even though page ticks were arriving. Derive the missing
    // side from the anchor's SOL/USD ratio. The same works in reverse for a
    // native-only tick.
    if (nextNative === null && nextUsd !== null && anchorUsd) {
      nextNative = anchorNative * (nextUsd / anchorUsd);
    }
    if (nextUsd === null && nextNative !== null && anchorUsd) {
      nextUsd = anchorUsd * (nextNative / anchorNative);
    }

    return {
      accepted: true,
      reason: 'ok',
      priceNative: nextNative !== null ? nextNative : anchorNative,
      priceUsd: nextUsd !== null ? nextUsd : anchorUsd,
      mcap: nextMcap !== null ? nextMcap : anchorMcap,
      basis,
    };
  }

  /** True when `value` is within ACCEPT_RATIO x of `anchor` in either direction. */
  function withinBand(value, anchor) {
    if (!(value > 0) || !(anchor > 0)) return false;
    const ratio = value > anchor ? value / anchor : anchor / value;
    return ratio <= ACCEPT_RATIO;
  }

  /* ------------------------------------------------------------------ *
   * 2b. Live-price scheduling
   * ------------------------------------------------------------------ */

  // How often the anchor is re-quoted when the page's own feed is not
  // supplying usable ticks. At 400ms this is ~150 req/min, inside the
  // Dexscreener ~300 req/min budget. This is only the fallback — the
  // primary price path is event-driven via the DOM/WebSocket observer.
  var POLL_INTERVAL_MS = 400;
  // If the page feed is delivering ticks at least this often, polling the
  // network adds nothing, so it is suspended. 800ms means any feed tick
  // within the last 0.8s suppresses a redundant network poll.
  var FEED_FRESH_MS = 800;
  // Beyond this with no new price from any source, the quote is stale and the
  // UI must say so rather than implying the P&L is live.
  var STALE_AFTER_MS = 3000;

  /**
   * Decide, at a given moment, whether a fresh network quote should be issued.
   * Pure so the cadence is testable without timers.
   *
   * @param {object} s { lastPriceAt, lastPollAt, inFlight, hidden }
   * @param {number} now
   */
  function shouldRequote(s, now) {
    if (!s) return false;
    if (s.inFlight) return false;          // never stack requests
    if (s.hidden) return false;            // background tabs do not poll
    // The page's own feed is fresher than anything we could fetch.
    if (s.lastPriceAt && now - s.lastPriceAt < FEED_FRESH_MS) return false;
    // Respect the poll interval.
    if (s.lastPollAt && now - s.lastPollAt < POLL_INTERVAL_MS) return false;
    return true;
  }

  /** True when the newest price is old enough that the P&L must not look live. */
  function isPriceStale(lastPriceAt, now) {
    if (!lastPriceAt) return true;
    return now - lastPriceAt > STALE_AFTER_MS;
  }

  /* ------------------------------------------------------------------ *
   * 2c. Live position mark
   * ------------------------------------------------------------------ */

  /**
   * Compute everything the position card displays from a position and the
   * current price. Pure, so the P&L shown on screen is exactly what tests
   * assert — this is the number the user watches tick.
   */
  function positionMark(pos, priceNative, priceUsd) {
    if (!pos || !(pos.qty > 0)) return null;
    var px = Number(priceNative) > 0 ? Number(priceNative) : Number(pos.lastPriceNative);
    if (!(px > 0)) return null;

    var value = pos.qty * px;
    var pnl = value - pos.costSol;
    var pct = pos.costSol > 0 ? (pnl / pos.costSol) * 100 : 0;
    var avgEntry = pos.qty > 0 ? pos.costSol / pos.qty : 0;

    // Derive the SOL->USD rate from the token's own two quotes so the USD P&L
    // stays consistent with the SOL P&L.
    var rate = Number(priceUsd) > 0 && Number(priceNative) > 0
      ? Number(priceUsd) / Number(priceNative)
      : null;

    return {
      qty: pos.qty,
      avgEntry: avgEntry,
      price: px,
      valueSol: value,
      pnlSol: pnl,
      pnlPct: pct,
      pnlUsd: rate !== null ? pnl * rate : null,
      up: pnl >= 0,
    };
  }

  /* ------------------------------------------------------------------ *
   * 2b. Multi-position tracking (the positions bar)
   * ------------------------------------------------------------------ */

  /**
   * Parse a batched Dexscreener /tokens/<a>,<b>,... response into a
   * mint -> quote map, choosing the deepest-liquidity Solana pair per mint.
   *
   * The batch response mixes pairs for every requested mint together, so
   * grouping by baseToken.address is required; taking array order would quote
   * a token from whichever shallow pool happened to come back first.
   */
  function pricesFromBatch(payload) {
    const out = {};
    if (!payload || typeof payload !== 'object') return out;
    const pairs = Array.isArray(payload.pairs) ? payload.pairs : [];

    const byMint = new Map();
    for (const pair of pairs) {
      if (!pair || pair.chainId !== 'solana') continue;
      if (!(Number(pair.priceNative) > 0)) continue;
      const mint = pair.baseToken && pair.baseToken.address;
      if (!mint) continue;
      const prev = byMint.get(mint);
      const liq = Number((pair.liquidity && pair.liquidity.usd) || 0);
      const prevLiq = prev ? Number((prev.liquidity && prev.liquidity.usd) || 0) : -1;
      if (!prev || liq > prevLiq) byMint.set(mint, pair);
    }

    for (const [mint, pair] of byMint) {
      const quote = normalizePair(pair, mint);
      if (quote) out[mint] = quote;
    }
    return out;
  }

  /**
   * Build the rows the positions bar renders, newest position first.
   *
   * `livePrices` is an optional mint -> { priceNative, priceUsd } map from the
   * batch poller. When a mint has no fresh quote the stored mark is used and
   * the row is flagged `stale`, so the bar never invents a number.
   */
  function positionRows(state, livePrices, activeMint) {
    const positions = (state && state.positions) || {};
    const prices = livePrices || {};
    const rows = [];

    for (const mint of Object.keys(positions)) {
      const pos = positions[mint];
      if (!pos || !(pos.qty > 0)) continue;
      const live = prices[mint];
      const priceNative = live && Number(live.priceNative) > 0
        ? Number(live.priceNative)
        : Number(pos.lastPriceNative);
      const priceUsd = live && Number(live.priceUsd) > 0
        ? Number(live.priceUsd)
        : Number(pos.lastPriceUsd) || null;

      const mark = positionMark(pos, priceNative, priceUsd);
      if (!mark) continue;

      rows.push({
        mint,
        symbol: pos.symbol || shortAddress(mint),
        site: pos.site || null,
        pairAddress: pos.pairAddress || null,
        qty: mark.qty,
        priceNative: mark.price,
        valueSol: mark.valueSol,
        pnlSol: mark.pnlSol,
        pnlPct: mark.pnlPct,
        up: mark.up,
        openedAt: Number(pos.openedAt) || 0,
        active: Boolean(activeMint) && mint === activeMint,
        stale: !(live && Number(live.priceNative) > 0),
      });
    }

    rows.sort((a, b) => b.openedAt - a.openedAt);
    return rows;
  }

  /** Aggregate totals for the bar's summary segment. */
  function portfolioSummary(rows) {
    const list = Array.isArray(rows) ? rows : [];
    let valueSol = 0;
    let pnlSol = 0;
    let costSol = 0;
    let winners = 0;

    for (const row of list) {
      valueSol += Number(row.valueSol) || 0;
      pnlSol += Number(row.pnlSol) || 0;
      costSol += (Number(row.valueSol) || 0) - (Number(row.pnlSol) || 0);
      if ((Number(row.pnlSol) || 0) > 0) winners += 1;
    }

    return {
      count: list.length,
      valueSol,
      pnlSol,
      pnlPct: costSol > 0 ? (pnlSol / costSol) * 100 : 0,
      up: pnlSol >= 0,
      winners,
      losers: list.length - winners,
      anyStale: list.some((row) => row.stale),
    };
  }

  /* ------------------------------------------------------------------ *
   * 3. Header display fields
   * ------------------------------------------------------------------ */

  function shortAddress(addr) {
    if (typeof addr !== 'string' || addr.length <= 10) return addr || '';
    return addr.slice(0, 4) + '…' + addr.slice(-4);
  }

  function formatPrice(p) {
    if (!(p > 0)) return '';
    return p < 0.0001 ? p.toExponential(4) : String(Number(p.toPrecision(6)));
  }

  /**
   * Derive exactly what the overlay header shows. Kept pure so the display
   * contract is testable without building a Shadow DOM.
   *
   * `title` is the human name/symbol and `address` is the contract — they are
   * DISTINCT fields. The prior build printed the truncated CA in both, which is
   * the regression criterion 3 guards against.
   */
  function headerFields(token, opts) {
    if (!token || !token.mint) {
      return {
        title: 'No token',
        address: '',
        priceText: '—',
        pending: true,
        hasTrustedPrice: false,
        stale: false,
      };
    }

    const symbol = typeof token.symbol === 'string' ? token.symbol.trim() : '';
    const name = typeof token.name === 'string' ? token.name.trim() : '';
    // Only a real, resolved name may be shown. Never substitute the CA.
    const title = symbol || name || 'Unknown token';

    const hasTrustedPrice = Number(token.priceNative) > 0;
    // A brand-new launch is not an error state — it is a token no price source
    // has indexed YET. Saying so plainly beats a generic spinner, because the
    // user is deciding whether to wait or move on.
    const waitingMs = opts && opts.pendingSince ? Math.max(0, ((opts && opts.now) || Date.now()) - opts.pendingSince) : 0;
    const searching = !hasTrustedPrice && waitingMs > 1200;
    const priceText = hasTrustedPrice
      ? formatPrice(Number(token.priceNative)) + ' SOL'
      : (searching ? 'New coin — waiting for first quote…' : 'Fetching live price…');

    // A price we hold but can no longer refresh must be visibly marked, so a
    // frozen quote is never mistaken for a live one.
    var now = (opts && opts.now) || Date.now();
    var stale = hasTrustedPrice && opts && opts.lastPriceAt !== undefined
      ? isPriceStale(opts.lastPriceAt, now)
      : false;

    return {
      title,
      address: shortAddress(token.mint),
      fullAddress: token.mint,
      priceText,
      priceUsdText: Number(token.priceUsd) > 0 ? '$' + formatPrice(Number(token.priceUsd)) : '',
      pending: !hasTrustedPrice,
      hasTrustedPrice,
      stale,
      searching,
      waitingMs,
      // A token resolved only through Jupiter has no observed pool quote yet.
      freshLaunch: Boolean(token.priceSource === 'jupiter'),
      // Guard for the exact prior regression: name and address must differ.
      titleIsAddress: title === shortAddress(token.mint) || title === token.mint,
    };
  }

  var api = {
    pickBestPair,
    normalizePair,
    tokenFromPayload,
    validateTick,
    withinBand,
    shouldRequote,
    isPriceStale,
    positionMark,
    tokenFromJupiter,
    solUsdFromJupiter,
    jupiterEntry,
    preferResolved,
    WSOL_MINT,
    pricesFromBatch,
    positionRows,
    portfolioSummary,
    headerFields,
    shortAddress,
    formatPrice,
    ACCEPT_RATIO,
    POLL_INTERVAL_MS,
    FEED_FRESH_MS,
    STALE_AFTER_MS,
  };

  // Always install the browser global; only export under CommonJS when present.
  if (typeof window !== 'undefined') window.PaperQuote = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
