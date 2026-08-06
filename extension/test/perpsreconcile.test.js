/* Tests for the offline perps reconciler (perps-reconcile.js).
 *
 * Two fixture classes: REAL recorded Hyperliquid API data (candles +
 * funding, 2026-08-05) locks the survived path against venue reality, and
 * synthetic bar series lock liquidation detection with hand-derived
 * arithmetic. The honesty contract under test: candles must cover the gap
 * or the verdict is 'unverified-gap' — a hole in the data can neither kill
 * a position nor save one.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

global.window = global.window || {};
require('../perps-venues.js');
require('../perps-reconcile.js');
const R = global.window.PaperPerpsReconcile;
const V = global.window.PaperPerpsVenues;

const CLOSE = 1e-9;
const CANDLES = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'hl-candles-sol.json'), 'utf8'));
const FUNDING = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'hl-funding-sol.json'), 'utf8'));
const IV = 300000; // the fixture's 5m interval

function hlPos(over) {
  return Object.assign({
    venue: 'hyperliquid', side: 1, entryPx: 100, sizeUnits: 2,
    marginUsd: 10, maxLeverage: 20,
  }, over);
}

/* Synthetic 5m bar in API shape (string prices, ms times). */
function bar(tMs, o, h, l, c) {
  return { t: tMs, T: tMs + IV - 1, s: 'SOL', i: '5m', o: String(o), h: String(h), l: String(l), c: String(c) };
}

test('parseHlCandles validates the recorded fixture and refuses mangled rows', () => {
  const bars = R.parseHlCandles(CANDLES);
  assert.equal(bars.length, CANDLES.length);
  assert.ok(bars.every((b) => Number.isFinite(b.l) && b.h >= b.l));
  for (let i = 1; i < bars.length; i++) assert.ok(bars[i].t > bars[i - 1].t, 'sorted');

  const mangled = JSON.parse(JSON.stringify(CANDLES));
  mangled[3].l = 'oops';
  assert.equal(R.parseHlCandles(mangled), null, 'one bad row poisons the parse — no partial data');
  assert.equal(R.parseHlCandles([]), null);
});

test('parseHlFunding validates the recorded fixture', () => {
  const ev = R.parseHlFunding(FUNDING);
  assert.equal(ev.length, FUNDING.length);
  assert.ok(ev.every((e) => Number.isFinite(e.hourlyRateFrac) && Number.isInteger(e.timeMs)));
});

test('coverage: the fixture covers its own window; holes and late starts are named', () => {
  const bars = R.parseHlCandles(CANDLES);
  const fromMs = bars[0].t, toMs = bars[bars.length - 1].T;
  assert.equal(R.coverage(bars, fromMs, toMs, IV).ok, true);
  assert.equal(R.coverage(bars, fromMs - IV, toMs, IV).why, 'starts-late');
  const holed = bars.slice(0, 30).concat(bars.slice(31));
  assert.equal(R.coverage(holed, fromMs, toMs, IV).why, 'internal-gap');
});

/* ------------------- survived path on REAL venue data ------------------- */

test('a sanely-margined 20x position survives the recorded 6h window with real funding settled', () => {
  const bars = R.parseHlCandles(CANDLES);
  const entry = bars[0].o;
  // 20x at the fixture's opening price: liq sits ~2.56% down, below the
  // fixture's worst low — assert that precondition, then the verdict.
  const margin = (2 * entry) / 20;
  const pos = hlPos({ entryPx: entry, marginUsd: margin });
  const liq0 = V.hlLiqPrice({ side: 1, markPx: entry, entryPx: entry, sizeUnits: 2, marginUsd: margin, maxLeverage: 20 });
  const minLow = Math.min(...bars.map((b) => b.l));
  assert.ok(liq0.px < minLow - 0.05, `fixture precondition: liq ${liq0.px} clears min low ${minLow}`);

  const plan = R.reconcileHl(pos, {
    candles: CANDLES, funding: FUNDING,
    fromMs: bars[0].t, toMs: bars[bars.length - 1].T, intervalMs: IV,
  });
  assert.equal(plan.verdict, 'survived');
  assert.equal(plan.fundingApplied.length, FUNDING.length, 'every recorded funding event settles');

  // Margin drift re-derived independently: each event pays size × close ×
  // rate at its covering bar's close.
  let expected = margin;
  for (const ev of FUNDING) {
    const covering = bars.find((b) => ev.time >= b.t && ev.time <= b.T);
    assert.ok(covering, 'every fixture event has a covering bar');
    expected -= 1 * 2 * covering.c * Number(ev.fundingRate);
  }
  assert.ok(Math.abs(plan.marginAfterUsd - expected) < CLOSE);
  assert.ok(Math.abs(plan.lastPx - bars[bars.length - 1].c) < CLOSE);
  assert.ok(/venue-candles/.test(plan.provenance));
});

/* ------------------- liquidation on synthetic series ------------------- */

const T0 = 1785900000000;

test('liquidation is detected at the FIRST bar whose low crosses, after funding moved the line', () => {
  // Entry 100, 2 units, $10 margin, 20x: liq = 97.4359. One real-rate
  // funding event lands before the crossing and nudges liq to ~97.437.
  const candles = [
    bar(T0, 100, 100.2, 99.8, 100),
    bar(T0 + IV, 100, 100.1, 99.4, 99.5),
    bar(T0 + 2 * IV, 99.5, 99.6, 98.9, 99),
    bar(T0 + 3 * IV, 99, 99.1, 97.5, 98.5),      // low 97.5 stays above liq
    bar(T0 + 4 * IV, 98.5, 98.6, 97.3, 97.6),    // low 97.3 crosses
    bar(T0 + 5 * IV, 97.6, 98.4, 97.5, 98.3),
  ];
  const funding = [{ coin: 'SOL', fundingRate: '0.0000125', premium: '0', time: T0 + 2 * IV + 1000 }];
  const plan = R.reconcileHl(hlPos(), {
    candles, funding, fromMs: T0, toMs: T0 + 6 * IV - 1, intervalMs: IV,
  });
  assert.equal(plan.verdict, 'liquidated');
  assert.equal(plan.atMs, T0 + 4 * IV, 'the first crossing bar, not a later or earlier one');
  assert.ok(Math.abs(plan.crossPx - 97.3) < CLOSE);
  assert.equal(plan.fundingBefore.length, 1, 'the pre-crossing funding event is part of the plan');
  // The nudged line: margin after funding = 10 - 2*99*0.0000125.
  const marginAfter = 10 - 2 * 99 * 0.0000125;
  assert.ok(Math.abs(plan.marginAfterUsd - marginAfter) < CLOSE);
  const liqAfter = V.hlLiqPrice({ side: 1, markPx: 99, entryPx: 100, sizeUnits: 2, marginUsd: marginAfter, maxLeverage: 20 });
  assert.ok(97.3 <= liqAfter.px && 97.5 > liqAfter.px, 'derivation sanity: the line sits between the two lows');
});

test('a short is liquidated when a bar HIGH crosses its line above', () => {
  // Short entry 100: liq = 100 + (5/2)/1.025 = 102.439.
  const candles = [
    bar(T0, 100, 101, 99.9, 100.8),
    bar(T0 + IV, 100.8, 102.4, 100.7, 102),      // high 102.4 stays under
    bar(T0 + 2 * IV, 102, 102.6, 101.9, 102.2),  // high 102.6 crosses
  ];
  const plan = R.reconcileHl(hlPos({ side: -1 }), {
    candles, funding: [], fromMs: T0, toMs: T0 + 3 * IV - 1, intervalMs: IV,
  });
  assert.equal(plan.verdict, 'liquidated');
  assert.equal(plan.atMs, T0 + 2 * IV);
  assert.ok(Math.abs(plan.crossPx - 102.6) < CLOSE);
});

test('a hole in the candle window is an unverified gap — nobody dies through missing data', () => {
  const candles = [
    bar(T0, 100, 100.2, 99.8, 100),
    // bar at T0+IV missing
    bar(T0 + 2 * IV, 99.5, 99.6, 90, 91),        // a low that WOULD liquidate
  ];
  const plan = R.reconcileHl(hlPos(), {
    candles, funding: [], fromMs: T0, toMs: T0 + 3 * IV - 1, intervalMs: IV,
  });
  assert.equal(plan.verdict, 'unverified-gap');
  assert.equal(plan.why, 'internal-gap');
});

test('unparseable candles are an unverified gap, never a guess', () => {
  const plan = R.reconcileHl(hlPos(), {
    candles: [{ t: T0, T: T0 + IV - 1, o: 'x', h: '1', l: '1', c: '1' }],
    funding: [], fromMs: T0, toMs: T0 + IV, intervalMs: IV,
  });
  assert.equal(plan.verdict, 'unverified-gap');
});

/* ------------------------------ Jupiter ------------------------------ */

function jupPos(over) {
  return Object.assign({
    venue: 'jupiter', side: 1, entryPx: 100, sizeUsd: 500,
    liqPx: 99.32, liqBreached: false,
  }, over);
}

test('[JUP-GAP] a wake price past the line proves the liquidation — confirmed at wake', () => {
  const plan = R.reconcileJup(jupPos(), { nowPx: 99.0, nowMs: 7200000, lastSeenMs: 0 });
  assert.equal(plan.verdict, 'liquidated');
  assert.equal(plan.gapSec, 7200);
  assert.ok(/confirmed-at-wake/.test(plan.provenance));
  assert.ok(/crossing-time-unknown/.test(plan.provenance), 'the timing uncertainty is stated, not hidden');
});

test('[JUP-GAP] a wake price inside the line proves nothing about the wicks — survived, gap recorded', () => {
  const plan = R.reconcileJup(jupPos(), { nowPx: 99.5, nowMs: 3600000, lastSeenMs: 0 });
  assert.equal(plan.verdict, 'survived');
  assert.equal(plan.gapSec, 3600);
  assert.equal(plan.unaccruedBorrowGapSec, 3600, 'gap borrow is recorded as UNCHARGED, never invented');
  assert.ok(/gap-wicks-unverified/.test(plan.provenance));
});

test('[JUP-GAP] a short is confirmed liquidated when the wake price is above its line', () => {
  const plan = R.reconcileJup(jupPos({ side: -1, liqPx: 100.68 }), { nowPx: 101, nowMs: 1000, lastSeenMs: 0 });
  assert.equal(plan.verdict, 'liquidated');
  const survived = R.reconcileJup(jupPos({ side: -1, liqPx: 100.68 }), { nowPx: 100.5, nowMs: 1000, lastSeenMs: 0 });
  assert.equal(survived.verdict, 'survived');
});

test('reconcilers refuse the wrong venue and missing wake data', () => {
  assert.equal(R.reconcileHl(jupPos(), {}).verdict, 'bad-position');
  assert.equal(R.reconcileJup(hlPos(), { nowPx: 100 }).verdict, 'bad-position');
  assert.equal(R.reconcileJup(jupPos(), { nowPx: NaN }).verdict, 'unverified-gap');
});
