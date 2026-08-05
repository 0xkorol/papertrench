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

  var WSOL_MINT = 'So11111111111111111111111111111111111111112';
  var BASE58_RE = /^[A-HJ-NP-Za-km-z1-9]{32,44}$/;

  /* ------------------------------------------------------------------ *
   * 1. Identity + anchor quote from a Dexscreener payload
   * ------------------------------------------------------------------ */

  /**
   * Choose the pair a trading UI would actually quote: the Solana pair with a
   * usable price and the deepest liquidity. Shallow pools produce wild prices,
   * so liquidity depth is the correct tiebreak rather than array order.
   *
   * When `requestedAddress` is supplied, prefer pairs where that token is the
   * base, or where it is the quote against wrapped SOL. This stops a stablecoin
   * or unrelated token from being returned as the resolved identity.
   */
  function pickBestPair(pairs, requestedAddress) {
    if (!Array.isArray(pairs)) return null;
    const usable = pairs.filter(
      (p) => p && p.chainId === 'solana' && Number(p.priceNative) > 0
    );
    if (!usable.length) return null;

    const requested = typeof requestedAddress === 'string' && BASE58_RE.test(requestedAddress)
      ? requestedAddress
      : null;
    if (requested) {
      const relevant = usable.filter((p) => {
        const base = (p.baseToken && p.baseToken.address) || '';
        const quote = (p.quoteToken && p.quoteToken.address) || '';
        if (base === requested) return true;
        if (quote === requested && base === WSOL_MINT) return true;
        return false;
      });
      if (relevant.length) {
        return relevant.reduce((best, p) => {
          const a = Number((p.liquidity && p.liquidity.usd) || 0);
          const b = Number((best.liquidity && best.liquidity.usd) || 0);
          return a > b ? p : best;
        });
      }
    }

    return usable.reduce((best, p) => {
      const a = Number((p.liquidity && p.liquidity.usd) || 0);
      const b = Number((best.liquidity && best.liquidity.usd) || 0);
      return a > b ? p : best;
    });
  }

  /** Normalize one Dexscreener pair into our token record, or null if unusable. */
  function normalizePair(pair, fallbackAddress) {
    if (!pair) return null;
    const rawPrice = Number(pair.priceNative);
    if (!(rawPrice > 0)) return null;

    const requested = typeof fallbackAddress === 'string' && BASE58_RE.test(fallbackAddress)
      ? fallbackAddress
      : null;
    const base = pair.baseToken || {};
    const quote = pair.quoteToken || {};

    let isQuote = false;
    if (requested) {
      if (requested === pair.pairAddress) {
        isQuote = false;
      } else if (base.address === requested) {
        isQuote = false;
      } else if (quote.address === requested && base.address === WSOL_MINT) {
        isQuote = true;
      } else if (quote.address === requested) {
        return null;
      } else {
        isQuote = false;
      }
    }

    const token = isQuote ? quote : base;
    const priceNative = isQuote ? 1 / rawPrice : rawPrice;
    const priceUsd = pair.priceUsd != null ? Number(pair.priceUsd) : null;
    const mcap = Number(pair.marketCap != null ? pair.marketCap : pair.fdv);

    return {
      mint: token.address || fallbackAddress || null,
      pairAddress: pair.pairAddress || null,
      symbol: token.symbol || null,
      name: token.name || token.symbol || null,
      priceNative,
      priceUsd: Number.isFinite(priceUsd) && priceUsd > 0 ? priceUsd : null,
      mcap: Number.isFinite(mcap) && mcap > 0 && !isQuote ? mcap : null,
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
    const pair = payload.pair || pickBestPair(payload.pairs, fallbackAddress);
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
   * 2. Fresh-launch bootstrap from the on-screen price
   * ------------------------------------------------------------------ */

  // A new coin has no Dexscreener/Jupiter anchor yet, but the page already
  // shows a live price on the chart. These thresholds are used to decide what
  // the on-screen number actually is, since TradingView bars come through as
  // unit 'unknown' and can represent USD price, native SOL price, or market cap.
  // Values below this are typical native SOL prices for memecoins (e.g. 1e-8);
  // values at or above are usually USD token prices. The gap exists because
  // a memecoin's native price is tiny while its USD price is 1..3 orders of
  // magnitude larger (SOL/USD ~200).
  var BOOTSTRAP_NATIVE_THRESHOLD = 1e-7;
  var BOOTSTRAP_MCAP_FLOOR = 1000;
  var BOOTSTRAP_USD_CEILING = 1e6;
  // DEFECT F-25: the sane USD unit-price band for a coin still in its
  // pre-index bootstrap window. The old heuristic hardcoded today's SOL/USD
  // scale ("anything in [1e-7, 1000) is USD"), so a genuinely SOL-denominated
  // close just past the threshold was divided by the rate twice (~200x low).
  // With a live rate the two readings are judged the same way: a value is
  // plausibly NATIVE when value x rate lands in this band, plausibly USD when
  // the value itself does. When BOTH readings are plausible the tick is
  // REFUSED rather than guessed — the fast-retry loop delivers an anchored
  // quote within seconds, and a short honest absence beats a 200x-wrong fill.
  // Band intuition at 1e9 supply (the memecoin norm): $100 .. $100K market
  // cap, generous in both directions for a coin no aggregator has indexed.
  var BOOTSTRAP_SANE_USD_MIN = 1e-7;
  var BOOTSTRAP_SANE_USD_MAX = 1e-4;

  // Every pump.fun coin mints exactly 1e9 tokens (6 decimals) and its vanity
  // mint ends in "pump" — protocol facts, not scraped page data. They are the
  // one case where an mcap-scale chart close CAN honestly price a coin no
  // aggregator has indexed. `pumpCurve` is set when the on-chain feed has
  // positively identified the token's bonding curve (see prewatch), covering
  // pair-address pages where the mint is not known yet.
  var PUMP_FAMILY_SUPPLY = 1e9;
  // The mcap READINGS get their own band (as unit price at 1e9): a pump
  // curve launches near a $4K cap and is aggregator-indexed well past
  // migration, so below ~$3K or above $100K the "it's a market cap" reading
  // is not credible — without this floor a 0.5 chart close read as "0.5 SOL
  // of market cap = a $100 coin" would have slipped past the generous
  // unit-price band that F-25 deliberately keeps.
  var PUMP_MCAP_UNIT_MIN = 3e-6;
  var PUMP_MCAP_UNIT_MAX = 1e-4;
  function isPumpFamily(t) {
    if (!t) return false;
    if (t.pumpCurve === true) return true;
    return typeof t.mint === 'string' && /pump$/.test(t.mint);
  }

  /**
   * Accept the very first price for a coin no aggregator has indexed yet.
   *
   * The on-screen price is treated as the only truthful quote, so the trader
   * can buy the instant the chart starts printing. Stray page numbers are kept
   * out by requiring a trusted source or a matching mint, and absurd values are
   * refused rather than becoming a bogus fill.
   *
   * @param {object} pendingToken { mint } — the coin waiting for an anchor
   * @param {object} tick         bridge payload from the page's own feed
   * @param {number} solUsd       cached SOL/USD rate (0 if not available yet)
   */
  function bootstrapTick(pendingToken, tick, solUsd) {
    var reject = function (reason) {
      return {
        accepted: false,
        reason: reason,
        priceNative: null,
        priceUsd: null,
        mcap: null,
        basis: null,
      };
    };

    if (!pendingToken || !pendingToken.mint) return reject('no-token');
    if (!tick || typeof tick !== 'object') return reject('no-candidates');
    if (tick.mint && tick.mint !== pendingToken.mint) return reject('mint-mismatch');

    var rate = Number(solUsd) > 0 ? Number(solUsd) : null;
    var candidates = Array.isArray(tick.candidates) ? tick.candidates : [];
    var tickMcap = Number(tick.mcap);

    // Only trust chart/trade sources or mint-tagged payloads. A random number
    // scraped off the page must never price a brand-new coin.
    var trusted = tick.mint === pendingToken.mint
      || tick.source === 'padre-chart-bar'
      || tick.source === 'chart-export'
      || tick.source === 'gmgn-ws-trade'
      || tick.source === 'gmgn-mcap-candle';
    if (!trusted) return reject('untrusted-source');

    var accept = function (native, usd, mcap, basis) {
      return {
        accepted: true,
        reason: 'ok',
        priceNative: native > 0 ? native : null,
        priceUsd: usd > 0 ? usd : null,
        mcap: mcap > 0 ? mcap : null,
        basis: basis,
      };
    };

    // GMGN's live trade feed is mint-tagged and quotes in USD. Convert it to
    // the SOL price the engine trades in.
    if (tick.source === 'gmgn-ws-trade' && tick.mint === pendingToken.mint && candidates.length) {
      var usd = Number(candidates[0].value);
      if (!(usd > 0)) return reject('no-candidates');
      if (!rate) return reject('no-sol-rate');
      var native = usd / rate;
      if (!(native > 0)) return reject('no-sol-rate');
      return accept(native, usd, null, 'ws-usd');
    }

    for (var i = 0; i < candidates.length; i++) {
      var cand = candidates[i];
      var v = Number(cand && cand.value);
      if (!(v > 0)) continue;
      var unit = (cand && cand.unit) || 'unknown';

      if (unit === 'native') {
        // A memecoin native price is far below 1 SOL. Anything larger is almost
        // certainly a market cap or a mislabelled USD figure.
        if (v >= 1) return reject('native-looks-mcap');
        // F-25: this branch had no floor — dust values and rate-scale
        // mislabels became real fills. With a live rate an explicit native
        // price must still imply a sane USD price for a pre-index coin.
        // Without a rate there is nothing to judge against: keep the old
        // behavior rather than refusing a possibly-good declared unit.
        if (rate) {
          var usdEquiv = v * rate;
          if (usdEquiv < BOOTSTRAP_SANE_USD_MIN || usdEquiv > BOOTSTRAP_SANE_USD_MAX) {
            return reject('native-implausible');
          }
        }
        return accept(v, rate ? v * rate : null, null, 'native');
      }

      if (unit === 'usd') {
        if (!rate) return reject('no-sol-rate');
        if (v >= BOOTSTRAP_USD_CEILING) return reject('mcap-looks-usd');
        var native = v / rate;
        if (!(native > 0)) return reject('no-sol-rate');
        return accept(native, v, null, 'usd');
      }

      // unit === 'unknown' is the common TradingView chart close case.
      if (unit === 'unknown') {
        // Pump-family coins have a protocol-constant supply (1e9), so
        // mcap-scale closes CAN price them — the one thing the general path
        // below must refuse ("no implied supply"). An Axiom chart parked in
        // MCap mode was exactly the screen that could never bootstrap a
        // fresh launch: the armed buy sat on "waiting for first quote"
        // forever while the site's own chart ticked away (maintainer video,
        // 39-second-old coin). A SOL-denominated cap is a SMALL number (a
        // $7K cap is ~47 SOL), so this cannot hide behind a magnitude
        // floor: all four readings of the unlabelled value — native unit,
        // USD unit, SOL mcap, USD mcap — are judged against the same sane
        // band, and the tick is priced only when EXACTLY ONE fits (the
        // F-25 discipline, extended).
        if (rate && isPumpFamily(pendingToken)) {
          var readings = [
            { basis: 'native', usd: v * rate, native: v, mcap: null,
              min: BOOTSTRAP_SANE_USD_MIN, max: BOOTSTRAP_SANE_USD_MAX },
            { basis: 'usd', usd: v, native: v / rate, mcap: null,
              min: BOOTSTRAP_SANE_USD_MIN, max: BOOTSTRAP_SANE_USD_MAX },
            { basis: 'native-mcap', usd: (v * rate) / PUMP_FAMILY_SUPPLY, native: v / PUMP_FAMILY_SUPPLY, mcap: v * rate,
              min: PUMP_MCAP_UNIT_MIN, max: PUMP_MCAP_UNIT_MAX },
            { basis: 'mcap', usd: v / PUMP_FAMILY_SUPPLY, native: v / PUMP_FAMILY_SUPPLY / rate, mcap: v,
              min: PUMP_MCAP_UNIT_MIN, max: PUMP_MCAP_UNIT_MAX },
          ];
          var sane = readings.filter(function (r) {
            return r.usd >= r.min && r.usd <= r.max;
          });
          if (sane.length > 1) return reject('ambiguous-unit');
          if (sane.length === 1) {
            return accept(sane[0].native, sane[0].usd, sane[0].mcap, sane[0].basis);
          }
          return reject('implausible-unit');
        }
        // Market cap values are much larger than token prices and we cannot
        // derive a token price without an implied supply.
        if (v >= BOOTSTRAP_MCAP_FLOOR) return reject('mcap-no-supply');

        // F-25: with a live SOL/USD rate the disambiguation is RATE-AWARE,
        // not a hardcoded magnitude split. Judge both readings against the
        // sane pre-index USD band and only accept when exactly ONE fits.
        if (rate) {
          var usdIfNative = v * rate;
          var nativePlausible = usdIfNative >= BOOTSTRAP_SANE_USD_MIN
            && usdIfNative <= BOOTSTRAP_SANE_USD_MAX;
          var usdPlausible = v >= BOOTSTRAP_SANE_USD_MIN
            && v <= BOOTSTRAP_SANE_USD_MAX;
          // Both readings sane: guessing here is exactly the double-division
          // corruption. Refuse; the fast-retry loop anchors the coin soon.
          if (nativePlausible && usdPlausible) return reject('ambiguous-unit');
          if (nativePlausible) return accept(v, usdIfNative, null, 'native');
          if (usdPlausible) {
            var native = v / rate;
            if (native > 0) return accept(native, v, null, 'usd');
            return reject('no-sol-rate');
          }
          // Neither reading lands anywhere sane for a bootstrap coin: an
          // absurd value must never become the first fill price.
          return reject('implausible-unit');
        }

        // No rate yet: keep the original magnitude-only heuristic. Very
        // small values are native SOL prices for memecoins (e.g. 1e-8);
        // anything else needs the rate to be read at all.
        if (v < BOOTSTRAP_NATIVE_THRESHOLD) {
          return accept(v, null, null, 'native');
        }
        return reject('no-sol-rate');
      }
    }

    // A market-cap-only tick (GMGN/Axiom pre-index) can price a pump-family
    // coin through the constant supply — same exactly-one-sane discipline.
    if (tickMcap > 0 && rate && isPumpFamily(pendingToken)) {
      var usdMc = tickMcap / PUMP_FAMILY_SUPPLY;
      var solMc = (tickMcap * rate) / PUMP_FAMILY_SUPPLY;
      var usdOk = usdMc >= PUMP_MCAP_UNIT_MIN && usdMc <= PUMP_MCAP_UNIT_MAX;
      var solOk = solMc >= PUMP_MCAP_UNIT_MIN && solMc <= PUMP_MCAP_UNIT_MAX;
      if (usdOk && solOk) return reject('ambiguous-unit');
      if (usdOk) return accept(usdMc / rate, usdMc, tickMcap, 'mcap');
      if (solOk) return accept(tickMcap / PUMP_FAMILY_SUPPLY, solMc, tickMcap * rate, 'native-mcap');
    }
    // A market-cap-only tick has no token price, so nothing can be filled yet.
    if (tickMcap > 0) return reject('mcap-only-no-supply');

    return reject('no-candidates');
  }

  /* ------------------------------------------------------------------ *
   * 3. Tick validation against the trusted anchor
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

    // SOL-denominated market-cap charts (Axiom's USD/SOL toggle in MC mode)
    // plot the cap in SOL, which matches NEITHER the USD price band nor the
    // USD market-cap band — every such tick used to be rejected, freezing the
    // price to slow polling on exactly the charts the user trades on.
    const anchorNativeMcap = anchorMcap && anchorUsd
      ? anchorMcap * (anchorNative / anchorUsd)
      : null;
    if (nextNative === null && nextUsd === null
      && anchorNativeMcap && tickMcap > 0 && withinBand(tickMcap, anchorNativeMcap)) {
      const ratio = tickMcap / anchorNativeMcap;
      nextNative = anchorNative * ratio;
      nextUsd = anchorUsd ? anchorUsd * ratio : null;
      nextMcap = anchorMcap * ratio;
      basis = 'native-mcap';
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

    // Supply is constant during a normal tick, so an accepted price move IS a
    // market-cap move. Without this, a price-only feed (GMGN trades, Padre
    // bars) left the headline market cap frozen at the last resolver quote.
    if (nextMcap === null && anchorMcap && nextNative !== null) {
      nextMcap = anchorMcap * (nextNative / anchorNative);
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
   * 4. Live-price scheduling
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
  // Even when the page feed is delivering ticks, the trusted anchor (SOL/USD
  // rate, implied supply, validation band centre) must be re-fetched at a low
  // cadence, or a long session slowly drifts away from reality.
  var ANCHOR_REFRESH_MS = 30_000;

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
    // The page's own feed is fresher than anything we could fetch — but the
    // anchor itself still needs an occasional refresh (see requote(), which
    // in this situation re-anchors WITHOUT overriding the live price).
    if (s.lastPriceAt && now - s.lastPriceAt < FEED_FRESH_MS) {
      return !s.lastPollAt || now - s.lastPollAt >= ANCHOR_REFRESH_MS;
    }
    // Respect the poll interval.
    if (s.lastPollAt && now - s.lastPollAt < POLL_INTERVAL_MS) return false;
    return true;
  }

  /** True when the newest price is old enough that the P&L must not look live. */
  function isPriceStale(lastPriceAt, now) {
    if (!lastPriceAt) return true;
    return now - lastPriceAt > STALE_AFTER_MS;
  }

  // A chain-read fill price and an on-screen price from moments before the
  // click can legitimately differ by sub-second drift — never by double
  // digits. Beyond this ratio one of the two sources is broken (wrong pool,
  // starved vault leg, a decode fault), and the fill must side with the price
  // the trader is actually looking at: a fill 13% away from the chart books
  // instant fake P&L and teaches a wrong lesson, which is worse than losing
  // a few hundred milliseconds of freshness.
  var ONSCREEN_AGREE_RATIO = 1.06;

  /**
   * Comma-list preset parser — the ONE set of rules for preset editing
   * everywhere (dashboard form, popup quick settings, the panel's inline
   * editor): entries must be > 0 and ≤ max, at most 8 (500 presets would be
   * 500 buttons), optional dedupe where repeats are meaningless. Returns
   * null for an empty field ("keep the saved list") and { values, dropped }
   * otherwise so the caller can SAY when entries were rejected instead of
   * silently shrinking the list (D-42/D-06 semantics).
   */
  function parsePresetList(raw, max, opts) {
    var dedupe = Boolean(opts && opts.dedupe);
    var parts = String(raw == null ? '' : raw).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (!parts.length) return null;
    var values = parts.map(function (s) { return parseFloat(s); })
      .filter(function (n) { return isFinite(n) && n > 0 && n <= max; });
    if (dedupe) {
      var seen = {};
      values = values.filter(function (n) {
        if (seen[n]) return false;
        seen[n] = true;
        return true;
      });
    }
    if (values.length > 8) values = values.slice(0, 8);
    return { values: values, dropped: parts.length - values.length };
  }

  /**
   * Rug-guard verdict: holder concentration from getTokenLargestAccounts
   * plus the mint's raw supply. Liquidity is not a holder, so positively
   * identified pool/curve reserve accounts are excluded; with none known,
   * the single largest account is excluded as the assumed pool — and the
   * verdict SAYS which of the two it did (assumedPool), because a guard that
   * hides its own method is not a trustworthy guard.
   *
   * Missing data yields { known: false } — a rug check that cannot see the
   * chain must never block (or bless) a buy on an invented number.
   */
  function rugVerdict(input) {
    var largest = input && Array.isArray(input.largest) ? input.largest : null;
    var supply = Number(input && input.supply);
    var none = { known: false, pct: null, holders: 0, assumedPool: false };
    if (!largest || !largest.length || !(supply > 0)) return none;
    var reserves = {};
    var reserveList = (input && input.reserves) || [];
    for (var i = 0; i < reserveList.length; i++) reserves[reserveList[i]] = true;
    var rows = [];
    for (var j = 0; j < largest.length; j++) {
      var entry = largest[j];
      var amount = Number(entry && entry.amount);
      var address = entry && entry.address;
      if (!(amount > 0) || typeof address !== 'string') continue;
      if (reserves[address]) continue;
      rows.push({ address: address, amount: amount });
    }
    rows.sort(function (a, b) { return b.amount - a.amount; });
    var assumedPool = false;
    if (!reserveList.length && rows.length) {
      rows.shift();
      assumedPool = true;
    }
    if (!rows.length) return none;
    var topN = Math.max(1, Math.min(20, Number(input && input.topN) || 10));
    var top = rows.slice(0, topN);
    var sum = 0;
    for (var k = 0; k < top.length; k++) sum += top[k].amount;
    var pct = (sum / supply) * 100;
    if (!isFinite(pct)) return none;
    return {
      known: true,
      pct: Math.round(pct * 10) / 10,
      holders: top.length,
      assumedPool: assumedPool,
    };
  }

  /** True when the two prices are close enough to be the same market. */
  function fillSourcesAgree(onchainNative, screenNative) {
    if (!(onchainNative > 0) || !(screenNative > 0)) return true; // nothing to compare
    var ratio = onchainNative > screenNative
      ? onchainNative / screenNative
      : screenNative / onchainNative;
    return ratio <= ONSCREEN_AGREE_RATIO;
  }

  /* ------------------------------------------------------------------ *
   * 5. Live position mark
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
   * 6. Multi-position tracking (the positions bar)
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
   * 7. Header display fields
   * ------------------------------------------------------------------ */

  function shortAddress(addr) {
    if (typeof addr !== 'string' || addr.length <= 10) return addr || '';
    return addr.slice(0, 4) + '…' + addr.slice(-4);
  }

  var SUBSCRIPT_DIGITS = '₀₁₂₃₄₅₆₇₈₉';

  function toSubscript(n) {
    var out = '';
    var s = String(n);
    for (var i = 0; i < s.length; i++) out += SUBSCRIPT_DIGITS[Number(s[i])];
    return out;
  }

  /**
   * Human-readable token price.
   *
   * Memecoins live at 1e-9. `toExponential` renders that as "3.9690e-8", which
   * users reported as unreadable noise, and raw decimals render as an
   * uncountable run of zeros. Every Solana terminal solves this the same way —
   * subscript-zero notation — so PaperTrench matches that convention:
   *
   *   0.00000003969  ->  0.0₇3969
   *   0.00234        ->  0.00234
   *   1.5            ->  1.5
   */
  function formatPrice(p) {
    var value = Number(p);
    if (!(value > 0) || !isFinite(value)) return '';
    if (value >= 0.001) return String(Number(value.toPrecision(6)));

    // Count the zeros between the decimal point and the first significant digit.
    var exponent = Math.floor(Math.log10(value));
    var leadingZeros = -exponent - 1;
    var significant = value / Math.pow(10, exponent);
    var digits = String(Number(significant.toFixed(3))).replace('.', '');

    if (leadingZeros < 4) return String(Number(value.toPrecision(4)));
    return '0.0' + toSubscript(leadingZeros) + digits;
  }

  /**
   * Human-readable market cap / USD magnitude. Never scientific notation, and
   * never a wall of unseparated digits.
   */
  function formatMarketCap(n) {
    var value = Number(n);
    if (!(value > 0) || !isFinite(value)) return '';
    if (value >= 1e12) return '$' + (value / 1e12).toFixed(2) + 'T';
    if (value >= 1e9) return '$' + (value / 1e9).toFixed(2) + 'B';
    if (value >= 1e6) return '$' + (value / 1e6).toFixed(2) + 'M';
    if (value >= 1e3) return '$' + (value / 1e3).toFixed(1) + 'K';
    return '$' + value.toFixed(2);
  }

  /** USD price of one token, using the same readable convention as formatPrice. */
  function formatUsdPrice(p) {
    var text = formatPrice(p);
    return text ? '$' + text : '';
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

    /* Traders quote memecoins by market cap, not unit price. Nobody says
     * "I bought at 0.0₇3969" — they say "I bought at 240K". So market cap is
     * the headline figure whenever it is known, and the unit price moves to
     * the secondary line for the rare case someone wants it. */
    const hasMcap = Number(token.mcap) > 0;
    const mcapText = hasMcap ? formatMarketCap(Number(token.mcap)) : '';
    const priceText = hasMcap
      ? mcapText
      : (hasTrustedPrice
        ? formatPrice(Number(token.priceNative)) + ' SOL'
        : (searching ? 'New coin — waiting for first quote…' : 'Fetching live price…'));

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
      // What the headline number actually is, so the UI can label it honestly.
      priceIsMarketCap: hasMcap,
      mcapText,
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
    bootstrapTick,
    withinBand,
    shouldRequote,
    isPriceStale,
    fillSourcesAgree,
    isPumpFamily,
    rugVerdict,
    parsePresetList,
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
    formatMarketCap,
    formatUsdPrice,
    ACCEPT_RATIO,
    ONSCREEN_AGREE_RATIO,
    POLL_INTERVAL_MS,
    FEED_FRESH_MS,
    STALE_AFTER_MS,
    ANCHOR_REFRESH_MS,
  };

  // Always install the browser global; only export under CommonJS when present.
  if (typeof window !== 'undefined') window.PaperQuote = api;
  if (typeof self !== 'undefined') self.PaperQuote = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
