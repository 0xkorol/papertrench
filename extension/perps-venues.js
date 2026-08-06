/* PaperTrench — perps venue models (pure).
 *
 * Per-venue fee, funding/borrow, and liquidation math for the perps paper
 * book, plus parsers for the venues' own public data feeds. Pure functions,
 * no I/O — the feed layer fetches, this module computes.
 *
 * EVERY constant here is venue-verified with a dated citation. The doctrine
 * is the spec's (docs/PERPS-TA-SPEC.md §10 "verify-during-build"): venue
 * formulas are never trusted from memory, and a venue whose costs we cannot
 * state truthfully is refused, not approximated. If somebody trades on
 * Jupiter, they pay what Jupiter charges; on Hyperliquid, what Hyperliquid
 * charges — down to which price index (mark vs oracle) each venue uses.
 *
 * Citations (retrieved 2026-08-05):
 *  [HL-FEES]  hyperliquid.gitbook.io/hyperliquid-docs/trading/fees
 *             Base tier: taker 0.045%, maker 0.015%, charged on notional.
 *  [HL-LIQ]   .../trading/liquidations
 *             "liq_price = price - side * margin_available / position_size
 *              / (1 - l * side)", l = 1 / MAINTENANCE_LEVERAGE, maintenance
 *             margin is half the initial margin at max leverage; isolated
 *             margin_available = isolated_margin - maintenance_margin_
 *             required. Liquidations use the MARK price.
 *  [HL-FUND]  .../trading/funding
 *             Paid hourly at 1/8 of the 8h rate; payment = position_size *
 *             oracle_price * funding_rate (ORACLE price, not mark); interest
 *             component 0.00125%/hour; cap 4%/hour. Positive rate: longs pay.
 *  [HL-SPEC]  .../trading/contract-specifications
 *             Initial margin fraction = 1/leverage; maintenance fraction =
 *             half of maximum initial margin fraction. (The live meta API
 *             also carries marginTableId per asset — tiered maintenance for
 *             very large notional. Paper positions sit far below those
 *             tiers; base-tier maintenance is used here and the limitation
 *             is stated where it applies.)
 *  [HL-API]   POST api.hyperliquid.xyz/info {"type":"metaAndAssetCtxs"} —
 *             keyless; universe[i] aligns with assetCtxs[i]; maxLeverage per
 *             asset; funding is the CURRENT hourly rate as a decimal string.
 *             Recorded fixture: test/fixtures/hl-meta-ctxs.json.
 *  [JUP-FEES] docs.jup.ag/user-docs/trade/perps/fees.md
 *             Base fee 0.06% of trade size, open and close. Linear price
 *             impact: coefficient = tradeSize / (tradeImpactFeeScalar /
 *             10,000); fee = tradeSize * coefficient (SOL scalar raw
 *             1,250,000,000,000,000 at time of writing). Additive impact
 *             applies only past an OI-imbalance threshold (live pool data).
 *             Borrow: "Hourly Borrow Fee = (Total Tokens Locked / Total
 *             Tokens in Pool) * Hourly Borrow Rate * Position Size (USD)",
 *             hourly rate from fundingRateState.hourlyFundingDbps (worked
 *             example: util 200/1010, rate 0.012% (0.00012), $10,000 →
 *             $0.238/hour). Custody accounts for live scalars/rates:
 *             SOL 7xS2gz2bTp3fwCC7knJvUWTEU9Tycczu6VhJYKgi1wdz,
 *             BTC 5Pv3gM9JrFFH883SWAhvJC9RPYmo8UNxuFtv5bMMALkm,
 *             ETH AQCGyheWPLeo6Qp9WpYS9m3Qj479t7R636N9ey1rEjEn.
 *  [JUP-LIQ]  docs.jup.ag/user-docs/trade/perps/liquidation.md
 *             Long: liq = price - (|collateral - close_fee - borrow_fee -
 *             (size / max_lev)| * price) / size, short mirrored with +;
 *             max_lev = 500 (protocol). Trigger vs the ORACLE price. On
 *             liquidation ALL remaining collateral is forfeited to the JLP.
 *  [JUP-POS]  docs.jup.ag/user-docs/trade/perps/positions-and-collateral.md
 *             Leverage 1.1x–250x (UI). pnlDelta = sizeUsd * |Δpx| / avgPx.
 *             Shorts collateralized in USDC; collateral USD value fixed at
 *             deposit. Markets: SOL, wETH, wBTC.
 *  [AX-FEES]  Axiom perps route through Hyperliquid builder codes: HL base
 *             fees pass through with a builder fee added on top (protocol
 *             cap 0.1% for perps). Axiom's exact builder cut is NOT yet
 *             first-party verified — the venue ships verified:false until
 *             the Pass B adapter reads it from the live product.
 */
(() => {
  'use strict';

  const RETRIEVED_AT = '2026-08-05';

  const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

  const VENUES = {
    hyperliquid: {
      id: 'hyperliquid',
      label: 'Hyperliquid',
      marginCurrency: 'USDC',
      liqPriceBasis: 'mark',      // [HL-LIQ]
      fundingBasis: 'oracle',     // [HL-FUND]
      fundingCadenceSec: 3600,    // [HL-FUND] hourly
      fees: { takerFrac: 0.00045, makerFrac: 0.00015, builderFrac: 0 }, // [HL-FEES]
      leverage: { min: 1 },       // per-asset max from live meta [HL-API]
      feeSource: 'wallet',        // fees debit the account, not the isolated margin
      verified: true,
      retrievedAt: RETRIEVED_AT,
    },
    jupiter: {
      id: 'jupiter',
      label: 'Jupiter Perps',
      marginCurrency: 'USD',
      liqPriceBasis: 'oracle',    // [JUP-LIQ]
      fees: { baseFrac: 0.0006 }, // [JUP-FEES] 6 bps open AND close
      leverage: { min: 1.1, max: 250, protocolMax: 500 }, // [JUP-POS][JUP-LIQ]
      // Adjusted linear-impact scalars (raw scalar / 10,000), in USD terms.
      // SOL from the docs' dated example; ETH/WBTC must come from a live
      // custody read — null means "unknown", and unknown refuses the trade.
      markets: {
        SOL: { impactScalarAdjUsd: 125000000000, custody: '7xS2gz2bTp3fwCC7knJvUWTEU9Tycczu6VhJYKgi1wdz' },
        ETH: { impactScalarAdjUsd: null, custody: 'AQCGyheWPLeo6Qp9WpYS9m3Qj479t7R636N9ey1rEjEn' },
        WBTC: { impactScalarAdjUsd: null, custody: '5Pv3gM9JrFFH883SWAhvJC9RPYmo8UNxuFtv5bMMALkm' },
      },
      feeSource: 'collateral',    // [JUP-FEES] fees deduct from collateral
      liqForfeitsAllCollateral: true, // [JUP-LIQ]
      verified: true,
      retrievedAt: RETRIEVED_AT,
    },
    axiom: {
      id: 'axiom',
      label: 'Axiom Perps',
      basedOn: 'hyperliquid',     // [AX-FEES]
      fees: { builderFrac: null },// unknown until read from the live product
      verified: false,
      note: 'Hyperliquid base fees + an unverified builder cut. Refused until the Pass B adapter verifies the cut on the live product.',
      retrievedAt: RETRIEVED_AT,
    },
  };

  /* ---------------------------- Hyperliquid ---------------------------- */

  /* [HL-LIQ][HL-SPEC] maintenance fraction = half the initial fraction at
   * max leverage. 40x → 1.25%, 20x → 2.5%, 3x → 16.7% (doc's own examples).
   * Base tier only — marginTableId tiers for huge notional not modeled. */
  function hlMaintenanceFraction(maxLeverage) {
    if (!isNum(maxLeverage) || maxLeverage <= 0) return null;
    return 1 / (2 * maxLeverage);
  }

  function hlTradeFeeUsd(notionalUsd, o) {
    if (!isNum(notionalUsd) || notionalUsd < 0) return null;
    const v = VENUES.hyperliquid.fees;
    const rate = (o && o.maker ? v.makerFrac : v.takerFrac)
      + ((o && isNum(o.builderFrac)) ? o.builderFrac : 0);
    return notionalUsd * rate;
  }

  /* [HL-LIQ] liq_price = price - side*margin_available/size/(1 - l*side),
   * where isolated margin_available is EQUITY-based: isolated margin plus
   * unrealized PnL at the current mark, minus the maintenance requirement.
   * With equity in the numerator the formula has a fixed point — the same
   * liquidation price falls out at any current mark (locked by an
   * invariance test) — and it moves only when margin actually changes
   * (funding, add-margin). side: +1 long, -1 short. */
  function hlLiqPrice(o) {
    const { side, markPx, entryPx, sizeUnits, marginUsd, maxLeverage } = o || {};
    const l = hlMaintenanceFraction(maxLeverage);
    if (l === null || !isNum(markPx) || markPx <= 0) return null;
    if (!isNum(entryPx) || entryPx <= 0) return null;
    if (!isNum(sizeUnits) || sizeUnits <= 0 || !isNum(marginUsd)) return null;
    if (side !== 1 && side !== -1) return null;
    const equityUsd = marginUsd + side * sizeUnits * (markPx - entryPx);
    const maintUsd = l * sizeUnits * markPx;
    const availUsd = equityUsd - maintUsd;
    if (availUsd <= 0) return { px: markPx, breached: true };
    return { px: markPx - side * (availUsd / sizeUnits) / (1 - l * side), breached: false };
  }

  /* [HL-FUND] payment = size * oracle_price * rate; positive rate: longs
   * pay shorts. Returns the cash DELTA to the position holder. */
  function hlFundingDeltaUsd(o) {
    const { side, sizeUnits, oraclePx, hourlyRateFrac } = o || {};
    if ((side !== 1 && side !== -1) || !isNum(sizeUnits) || sizeUnits <= 0) return null;
    if (!isNum(oraclePx) || oraclePx <= 0 || !isNum(hourlyRateFrac)) return null;
    return -side * sizeUnits * oraclePx * hourlyRateFrac;
  }

  /* ------------------------------ Jupiter ------------------------------ */

  /* [JUP-FEES] base 6 bps + linear impact sizeUsd²/scalarAdj. The additive
   * imbalance component needs live pool OI — when it cannot be computed it
   * is ABSENT (null), never zero-that-means-unknown; `knownUsd` says what
   * the total provably contains and hasAdditive says what it does not. */
  function jupTradeFeeUsd(sizeUsd, o) {
    if (!isNum(sizeUsd) || sizeUsd < 0) return null;
    const scalarAdj = o && isNum(o.impactScalarAdjUsd) && o.impactScalarAdjUsd > 0
      ? o.impactScalarAdjUsd : null;
    const additive = o && isNum(o.additiveImpactUsd) ? o.additiveImpactUsd : null;
    const baseUsd = sizeUsd * VENUES.jupiter.fees.baseFrac;
    const impactLinearUsd = scalarAdj === null ? null : (sizeUsd * sizeUsd) / scalarAdj;
    return {
      baseUsd,
      impactLinearUsd,
      impactAdditiveUsd: additive,
      knownUsd: baseUsd + (impactLinearUsd || 0) + (additive || 0),
      hasLinear: impactLinearUsd !== null,
      hasAdditive: additive !== null,
    };
  }

  /* [JUP-FEES] worked example: dbps such that the base rate is 0.012%
   * (0.00012) with utilization 200/1010 on a $10,000 position → $0.238/h.
   * dbps are deci-bps: rateFrac = dbps / 100,000; effective = rate * util. */
  function jupHourlyBorrowRateFrac(hourlyFundingDbps, utilization) {
    if (!isNum(hourlyFundingDbps) || hourlyFundingDbps < 0) return null;
    if (!isNum(utilization) || utilization < 0) return null;
    return (hourlyFundingDbps / 100000) * Math.min(utilization, 1);
  }

  function jupBorrowFeeUsd(hourlyRateFrac, sizeUsd, hours) {
    if (!isNum(hourlyRateFrac) || !isNum(sizeUsd) || !isNum(hours)) return null;
    if (hourlyRateFrac < 0 || sizeUsd < 0 || hours < 0) return null;
    return hourlyRateFrac * sizeUsd * hours;
  }

  /* [JUP-LIQ] liq = entry -/+ (free_collateral * entry) / size, where
   * free = collateral - close_fee - borrow_fee - size/500. The docs wrap
   * the numerator in |…| — but a position whose free collateral is already
   * gone is liquidatable NOW, and mirroring it to the profitable side would
   * be a lie; that case reports breached instead. */
  function jupLiqPrice(o) {
    const { side, entryPx, sizeUsd, collateralUsd, closeFeeUsd, borrowFeeUsd } = o || {};
    if ((side !== 1 && side !== -1) || !isNum(entryPx) || entryPx <= 0) return null;
    if (!isNum(sizeUsd) || sizeUsd <= 0 || !isNum(collateralUsd)) return null;
    if (!isNum(closeFeeUsd) || !isNum(borrowFeeUsd)) return null;
    const maintUsd = sizeUsd / VENUES.jupiter.leverage.protocolMax;
    const freeUsd = collateralUsd - closeFeeUsd - borrowFeeUsd - maintUsd;
    if (freeUsd <= 0) return { px: entryPx, breached: true };
    return { px: entryPx - side * (freeUsd * entryPx) / sizeUsd, breached: false };
  }

  /* [JUP-POS] pnlDelta = sizeUsd * |Δpx| / avgPx, signed by direction. */
  function jupUnrealizedPnlUsd(o) {
    const { side, entryPx, px, sizeUsd } = o || {};
    if ((side !== 1 && side !== -1) || !isNum(entryPx) || entryPx <= 0) return null;
    if (!isNum(px) || px <= 0 || !isNum(sizeUsd) || sizeUsd < 0) return null;
    const delta = (sizeUsd * Math.abs(px - entryPx)) / entryPx;
    const inProfit = side === 1 ? px > entryPx : px < entryPx;
    return inProfit ? delta : -delta;
  }

  /* ------------------------------ parsers ------------------------------
   * [HL-API] Feed-layer payloads → validated param objects. A field that
   * does not parse to a finite number is dropped, never guessed. */

  function parseHlMeta(payload) {
    const universe = Array.isArray(payload) ? (payload[0] && payload[0].universe) : (payload && payload.universe);
    if (!Array.isArray(universe)) return null;
    const out = {};
    universe.forEach((a, i) => {
      if (!a || typeof a.name !== 'string' || a.isDelisted) return;
      if (!Number.isInteger(a.maxLeverage) || a.maxLeverage <= 0) return;
      out[a.name] = { index: i, maxLeverage: a.maxLeverage, szDecimals: a.szDecimals };
    });
    return out;
  }

  function parseHlAssetCtxs(payload) {
    if (!Array.isArray(payload) || payload.length < 2) return null;
    const meta = parseHlMeta(payload);
    const ctxs = payload[1];
    if (!meta || !Array.isArray(ctxs)) return null;
    const out = {};
    for (const name of Object.keys(meta)) {
      const ctx = ctxs[meta[name].index];
      if (!ctx) continue;
      const funding = Number(ctx.funding);
      const markPx = Number(ctx.markPx);
      const oraclePx = Number(ctx.oraclePx);
      if (!Number.isFinite(funding) || !Number.isFinite(markPx) || markPx <= 0) continue;
      if (!Number.isFinite(oraclePx) || oraclePx <= 0) continue;
      out[name] = { fundingHourlyFrac: funding, markPx, oraclePx, maxLeverage: meta[name].maxLeverage };
    }
    return out;
  }

  const api = {
    RETRIEVED_AT,
    VENUES,
    hlMaintenanceFraction,
    hlTradeFeeUsd,
    hlLiqPrice,
    hlFundingDeltaUsd,
    jupTradeFeeUsd,
    jupHourlyBorrowRateFrac,
    jupBorrowFeeUsd,
    jupLiqPrice,
    jupUnrealizedPnlUsd,
    parseHlMeta,
    parseHlAssetCtxs,
  };

  if (typeof window !== 'undefined') window.PaperPerpsVenues = api;
  if (typeof self !== 'undefined') self.PaperPerpsVenues = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
