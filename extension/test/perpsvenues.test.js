/* Tests for the perps venue models (perps-venues.js).
 *
 * Every lock here traces to a venue document or a recorded venue API
 * response (citations in perps-venues.js, retrieved 2026-08-05). The
 * venues' own worked examples are reproduced exactly — if our arithmetic
 * ever drifts from what Hyperliquid or Jupiter would actually charge,
 * these fail.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

global.window = global.window || {};
require('../perps-venues.js');
const V = global.window.PaperPerpsVenues;

const CLOSE = 1e-9;

test('venue registry: first-wave venues verified, axiom refused until its cut is read live', () => {
  assert.equal(V.VENUES.hyperliquid.verified, true);
  assert.equal(V.VENUES.jupiter.verified, true);
  assert.equal(V.VENUES.axiom.verified, false, 'axiom ships unverified until Pass B reads the builder cut');
  assert.equal(V.VENUES.hyperliquid.liqPriceBasis, 'mark', '[HL-LIQ] liquidations use mark');
  assert.equal(V.VENUES.hyperliquid.fundingBasis, 'oracle', '[HL-FUND] funding uses oracle');
  assert.equal(V.VENUES.jupiter.liqPriceBasis, 'oracle', '[JUP-LIQ] trigger vs oracle');
});

/* --------------------------- Hyperliquid --------------------------- */

test('[HL-SPEC] maintenance fraction is half the initial fraction at max leverage', () => {
  // The liquidation doc's own range: 1.25% at 40x, 16.7% at 3x.
  assert.ok(Math.abs(V.hlMaintenanceFraction(40) - 0.0125) < CLOSE);
  assert.ok(Math.abs(V.hlMaintenanceFraction(20) - 0.025) < CLOSE);
  assert.ok(Math.abs(V.hlMaintenanceFraction(3) - 1 / 6) < CLOSE);
  assert.equal(V.hlMaintenanceFraction(0), null);
  assert.equal(V.hlMaintenanceFraction(null), null);
});

test('[HL-FEES] base tier taker 4.5 bps, maker 1.5 bps, builder fee added on top', () => {
  assert.ok(Math.abs(V.hlTradeFeeUsd(10000, {}) - 4.5) < CLOSE);
  assert.ok(Math.abs(V.hlTradeFeeUsd(10000, { maker: true }) - 1.5) < CLOSE);
  assert.ok(Math.abs(V.hlTradeFeeUsd(10000, { builderFrac: 0.0005 }) - 9.5) < CLOSE);
  assert.equal(V.hlTradeFeeUsd(NaN, {}), null);
});

test('[HL-LIQ] liquidation price matches the documented formula, hand-derived both sides', () => {
  // Long at entry: P=100, 20x max (l=0.025), $10 isolated margin, 2 units.
  // equity = $10; maint = 0.025*2*100 = $5; avail = $5;
  // liq = 100 - (5/2)/(1-0.025).
  const long = V.hlLiqPrice({ side: 1, markPx: 100, entryPx: 100, sizeUnits: 2, marginUsd: 10, maxLeverage: 20 });
  assert.equal(long.breached, false);
  assert.ok(Math.abs(long.px - (100 - (5 / 2) / 0.975)) < CLOSE);
  assert.ok(long.px < 100, 'long liquidates below');

  // Short mirror: liq = 100 + (5/2)/(1+0.025) — the denominator flips sign.
  const short = V.hlLiqPrice({ side: -1, markPx: 100, entryPx: 100, sizeUnits: 2, marginUsd: 10, maxLeverage: 20 });
  assert.equal(short.breached, false);
  assert.ok(Math.abs(short.px - (100 + (5 / 2) / 1.025)) < CLOSE);
  assert.ok(short.px > 100, 'short liquidates above');
});

test('[HL-LIQ] the liquidation price is a fixed point — the same at any current mark', () => {
  // Equity-based margin_available makes the formula self-consistent: for a
  // fixed margin the liq price must not care which mark it is evaluated at.
  const base = { side: 1, entryPx: 100, sizeUnits: 2, marginUsd: 10, maxLeverage: 20 };
  const atEntry = V.hlLiqPrice(Object.assign({ markPx: 100 }, base));
  const below = V.hlLiqPrice(Object.assign({ markPx: 98.5 }, base));
  const above = V.hlLiqPrice(Object.assign({ markPx: 104 }, base));
  assert.ok(Math.abs(atEntry.px - below.px) < CLOSE, 'evaluated at 98.5 must agree with entry');
  assert.ok(Math.abs(atEntry.px - above.px) < CLOSE, 'evaluated at 104 must agree with entry');
  const short = { side: -1, entryPx: 100, sizeUnits: 2, marginUsd: 10, maxLeverage: 20 };
  assert.ok(Math.abs(
    V.hlLiqPrice(Object.assign({ markPx: 100 }, short)).px
    - V.hlLiqPrice(Object.assign({ markPx: 101.5 }, short)).px
  ) < CLOSE, 'short side invariance');
});

test('[HL-LIQ] equity at or below the maintenance requirement reports breached, not a fake price', () => {
  // At entry: equity $5 == maint $5 — nothing available.
  const atEntry = V.hlLiqPrice({ side: 1, markPx: 100, entryPx: 100, sizeUnits: 2, marginUsd: 5, maxLeverage: 20 });
  assert.equal(atEntry.breached, true);
  // Healthy margin but the mark has collapsed through the liq price:
  // equity = 10 + 2*(96-100) = $2 < maint $4.8.
  const under = V.hlLiqPrice({ side: 1, markPx: 96, entryPx: 100, sizeUnits: 2, marginUsd: 10, maxLeverage: 20 });
  assert.equal(under.breached, true);
});

test('[HL-FUND] positive funding: longs pay, shorts receive, on oracle notional', () => {
  const long = V.hlFundingDeltaUsd({ side: 1, sizeUnits: 2, oraclePx: 100, hourlyRateFrac: 0.0000125 });
  const short = V.hlFundingDeltaUsd({ side: -1, sizeUnits: 2, oraclePx: 100, hourlyRateFrac: 0.0000125 });
  assert.ok(Math.abs(long - -0.0025) < CLOSE, 'long pays 2*100*0.0000125');
  assert.ok(Math.abs(short - 0.0025) < CLOSE, 'short receives the same');
  // Negative rate flips the flow.
  const longNeg = V.hlFundingDeltaUsd({ side: 1, sizeUnits: 2, oraclePx: 100, hourlyRateFrac: -0.0000125 });
  assert.ok(Math.abs(longNeg - 0.0025) < CLOSE);
});

/* ----------------------------- Jupiter ----------------------------- */

test('[JUP-FEES] doc example: $10,000 trade → $6 base + $0.0008 linear impact (SOL scalar)', () => {
  const fee = V.jupTradeFeeUsd(10000, { impactScalarAdjUsd: 125000000000 });
  assert.ok(Math.abs(fee.baseUsd - 6) < CLOSE);
  assert.ok(Math.abs(fee.impactLinearUsd - 0.0008) < CLOSE);
  assert.ok(Math.abs(fee.knownUsd - 6.0008) < CLOSE);
  assert.equal(fee.hasLinear, true);
  assert.equal(fee.hasAdditive, false, 'additive impact needs live pool data — absent, not zero');
});

test('[JUP-FEES] an unknown impact scalar yields an absent component, never a guessed zero', () => {
  const fee = V.jupTradeFeeUsd(10000, {});
  assert.equal(fee.impactLinearUsd, null);
  assert.equal(fee.hasLinear, false);
  assert.ok(Math.abs(fee.knownUsd - 6) < CLOSE, 'knownUsd carries only what is provable');
});

test('[JUP-FEES] doc worked example: borrow ≈ $0.238/hour at 200/1010 utilization on $10,000', () => {
  const rate = V.jupHourlyBorrowRateFrac(12, 200 / 1010);
  const hourly = V.jupBorrowFeeUsd(rate, 10000, 1);
  // The doc rounds utilization to 19.8% and prints $0.238; exact is $0.2376.
  assert.ok(Math.abs(hourly - 0.238) < 0.001, `got ${hourly}`);
  assert.ok(Math.abs(V.jupBorrowFeeUsd(rate, 10000, 2) - 2 * hourly) < CLOSE, 'linear in hours');
  assert.equal(V.jupHourlyBorrowRateFrac(-1, 0.5), null);
});

test('[JUP-LIQ] liquidation price hand-derived, and it sits terrifyingly close at 100x', () => {
  // $5 margin at 100x: size $500, open fee 0.300002 → collateral 4.699998;
  // maint = 500/500 = $1; close fee est 0.300002; free = 3.399994;
  // liq(long) = 100 - (3.399994*100)/500 = 99.3200012.
  const collateral = 5 - 0.300002;
  const closeFee = 0.300002;
  const r = V.jupLiqPrice({ side: 1, entryPx: 100, sizeUsd: 500, collateralUsd: collateral, closeFeeUsd: closeFee, borrowFeeUsd: 0 });
  assert.equal(r.breached, false);
  const free = collateral - closeFee - 500 / 500;
  assert.ok(Math.abs(r.px - (100 - (free * 100) / 500)) < CLOSE);
  assert.ok(100 - r.px < 0.7, 'less than a 0.7% adverse move liquidates $5 at 100x');

  const short = V.jupLiqPrice({ side: -1, entryPx: 100, sizeUsd: 500, collateralUsd: collateral, closeFeeUsd: closeFee, borrowFeeUsd: 0 });
  assert.ok(short.px > 100, 'short liquidates above');
});

test('[JUP-LIQ] accrued borrow fees drag the liquidation price toward the market', () => {
  const base = { side: 1, entryPx: 100, sizeUsd: 500, collateralUsd: 4.7, closeFeeUsd: 0.3 };
  const fresh = V.jupLiqPrice(Object.assign({ borrowFeeUsd: 0 }, base));
  const aged = V.jupLiqPrice(Object.assign({ borrowFeeUsd: 0.5 }, base));
  assert.ok(aged.px > fresh.px, 'borrow accrual must move a long liq price UP toward entry');
});

test('[JUP-LIQ] free collateral already gone reports breached instead of mirroring the abs()', () => {
  const r = V.jupLiqPrice({ side: 1, entryPx: 100, sizeUsd: 500, collateralUsd: 1.0, closeFeeUsd: 0.3, borrowFeeUsd: 0 });
  assert.equal(r.breached, true, 'maint alone is $1 — nothing free, liquidatable now');
});

test('[JUP-POS] unrealized PnL is sizeUsd-scaled price delta, signed by direction', () => {
  assert.ok(Math.abs(V.jupUnrealizedPnlUsd({ side: 1, entryPx: 100, px: 110, sizeUsd: 500 }) - 50) < CLOSE);
  assert.ok(Math.abs(V.jupUnrealizedPnlUsd({ side: 1, entryPx: 100, px: 90, sizeUsd: 500 }) - -50) < CLOSE);
  assert.ok(Math.abs(V.jupUnrealizedPnlUsd({ side: -1, entryPx: 100, px: 90, sizeUsd: 500 }) - 50) < CLOSE);
  assert.ok(Math.abs(V.jupUnrealizedPnlUsd({ side: -1, entryPx: 100, px: 110, sizeUsd: 500 }) - -50) < CLOSE);
});

/* --------------------- parsers vs recorded venue data --------------------- */

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'hl-meta-ctxs.json'), 'utf8'));

test('[HL-API] parseHlMeta reads real recorded meta: leverage tiers, delisted skipped', () => {
  const meta = V.parseHlMeta(FIXTURE);
  assert.equal(meta.BTC.maxLeverage, 40);
  assert.equal(meta.ETH.maxLeverage, 25);
  assert.equal(meta.SOL.maxLeverage, 20);
  assert.equal(meta.MATIC, undefined, 'delisted assets must not be tradable');
});

test('[HL-API] parseHlAssetCtxs aligns ctxs by universe index and keeps mark/oracle distinct', () => {
  const ctxs = V.parseHlAssetCtxs(FIXTURE);
  // SOL is index 5 in the recorded universe; its ctx must be the index-5
  // ctx (73.56 mark / 73.595 oracle in the recording), not a neighbor's.
  assert.ok(Math.abs(ctxs.SOL.markPx - 73.56) < CLOSE);
  assert.ok(Math.abs(ctxs.SOL.oraclePx - 73.595) < CLOSE);
  assert.equal(ctxs.SOL.maxLeverage, 20);
  assert.ok(Number.isFinite(ctxs.SOL.fundingHourlyFrac));
  assert.ok(Math.abs(ctxs.BTC.markPx - 64535.0) < CLOSE);
});

test('[HL-API] parsers drop what does not parse — never guess', () => {
  assert.equal(V.parseHlMeta(null), null);
  assert.equal(V.parseHlAssetCtxs({}), null);
  const mangled = JSON.parse(JSON.stringify(FIXTURE));
  mangled[1][0].markPx = 'not-a-price';
  const ctxs = V.parseHlAssetCtxs(mangled);
  assert.equal(ctxs.BTC, undefined, 'a mangled asset is dropped');
  assert.ok(ctxs.SOL, 'healthy assets survive');
});
