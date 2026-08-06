/* Tests for the TA core (ta-core.js).
 *
 * Two contracts carry the mission weight and get the most locks here:
 *  - warm-up truth: no indicator value exists before its window is full;
 *  - detector silence: a setup appears only when EVERY stated rule holds,
 *    and every emitted setup carries a finite invalidation.
 * Indicator arithmetic is locked with small hand-derivable series so a
 * smoothing or off-by-one-bar change fails loudly. Expectations are derived
 * from the inputs inside each test, not pasted from the implementation.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

global.window = global.window || {};
require('../ta-core.js');
const TA = global.window.PaperTA;

const CLOSE = 1e-9;

/* Flat-body bar: o == c == px, wick w on each side. Keeps h/l ordering
 * identical to the close series so pivot fixtures stay hand-checkable. */
function flat(t, px, w, v) {
  const b = { t, o: px, h: px + w, l: px - w, c: px };
  if (v !== undefined) b.v = v;
  return b;
}
function series(pxs, w, v) {
  return pxs.map((px, i) => flat((i + 1) * 60, px, w, v));
}

test('ta core installs its public API on the browser global', () => {
  assert.equal(typeof TA, 'object');
  for (const fn of ['ema', 'rsi', 'atr', 'vwap', 'swings', 'structure', 'srLevels',
    'volumeRegime', 'regime', 'liqDistanceAtr', 'assembleReads']) {
    assert.equal(typeof TA[fn], 'function', `${fn} must be exported`);
  }
});

/* ------------------------------ EMA ------------------------------ */

test('EMA is null before its window and exact afterwards (hand-derived)', () => {
  const out = TA.ema([1, 2, 3, 4, 5], 3);
  assert.equal(out[0], null);
  assert.equal(out[1], null);
  // Seed = SMA(1,2,3) = 2; k = 2/(3+1) = 0.5.
  assert.ok(Math.abs(out[2] - 2) < CLOSE);
  assert.ok(Math.abs(out[3] - (2 + 0.5 * (4 - 2))) < CLOSE);   // 3
  assert.ok(Math.abs(out[4] - (3 + 0.5 * (5 - 3))) < CLOSE);   // 4
});

test('EMA of a constant series is the constant at every warm index', () => {
  const out = TA.ema([7, 7, 7, 7, 7, 7], 4);
  assert.deepEqual(out.slice(0, 3), [null, null, null]);
  for (let i = 3; i < out.length; i++) assert.ok(Math.abs(out[i] - 7) < CLOSE);
});

/* ------------------------------ RSI ------------------------------ */

test('RSI warm-up: needs n deltas, so the first value sits at index n', () => {
  const out = TA.rsi([10, 11, 12, 13, 14], 3);
  assert.deepEqual(out.slice(0, 3), [null, null, null]);
  assert.notEqual(out[3], null);
});

test('RSI reads 100 on all-gain, 0 on all-loss, 50 on flat', () => {
  const up = TA.rsi([10, 11, 12, 13, 14, 15], 3);
  for (let i = 3; i < up.length; i++) assert.equal(up[i], 100);
  const down = TA.rsi([15, 14, 13, 12, 11, 10], 3);
  for (let i = 3; i < down.length; i++) assert.equal(down[i], 0);
  const flatSeries = TA.rsi([10, 10, 10, 10, 10], 3);
  for (let i = 3; i < flatSeries.length; i++) assert.equal(flatSeries[i], 50);
});

/* ------------------------------ ATR ------------------------------ */

test('ATR is null before its window; constant-range bars read their range', () => {
  // o=c=10, h=11, l=9 every bar: TR = max(2, |11-10|, |9-10|) = 2 always.
  const bars = Array.from({ length: 6 }, (_, i) => ({ t: (i + 1) * 60, o: 10, h: 11, l: 9, c: 10 }));
  const out = TA.atr(bars, 3);
  assert.deepEqual(out.slice(0, 2), [null, null]);
  for (let i = 2; i < out.length; i++) assert.ok(Math.abs(out[i] - 2) < CLOSE);
});

test('ATR of dead-flat bars is zero', () => {
  const bars = Array.from({ length: 5 }, (_, i) => ({ t: (i + 1) * 60, o: 10, h: 10, l: 10, c: 10 }));
  const out = TA.atr(bars, 3);
  for (let i = 2; i < out.length; i++) assert.equal(out[i], 0);
});

/* ------------------------------ VWAP ------------------------------ */

test('VWAP is volume-weighted typical price (hand-derived)', () => {
  const bars = [flat(60, 10, 0, 1), flat(120, 20, 0, 3)]; // zero wick: typical == px
  const out = TA.vwap(bars);
  assert.ok(Math.abs(out[0] - 10) < CLOSE);
  assert.ok(Math.abs(out[1] - (10 * 1 + 20 * 3) / 4) < CLOSE); // 17.5
});

test('a bar with unknown volume poisons VWAP from that bar on — no guessed weights', () => {
  const bars = [flat(60, 10, 0, 1), flat(120, 20, 0), flat(180, 30, 0, 5)];
  const out = TA.vwap(bars);
  assert.notEqual(out[0], null);
  assert.equal(out[1], null);
  assert.equal(out[2], null, 'volume resuming later must not resurrect a broken cumulative sum');
});

test('VWAP of an untraded session (all zero volume) is null, not NaN', () => {
  const out = TA.vwap([flat(60, 10, 0, 0), flat(120, 20, 0, 0)]);
  assert.deepEqual(out, [null, null]);
});

/* ------------------------------ swings ------------------------------ */

test('a pivot exists only once its right-side bars have printed', () => {
  // 5 dominates both sides, but with k=2 it needs two bars after it.
  const growing = series([1, 2, 5, 2], 0.1);
  assert.deepEqual(TA.swings(growing, 2), [], 'unconfirmable pivot must not exist yet');
  const confirmed = TA.swings(series([1, 2, 5, 2, 1], 0.1), 2);
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0].type, 'high');
  assert.equal(confirmed[0].i, 2);
  assert.equal(confirmed[0].confirmedAt, 4);
  assert.ok(Math.abs(confirmed[0].price - 5.1) < CLOSE, 'pivot price is the bar high');
});

test('consecutive same-type pivots collapse to the more extreme one', () => {
  // Highs at 5 and 6 with no strict pivot low between them (the 4,4 shelf
  // fails strict domination) — the list must keep only the higher high.
  const out = TA.swings(series([2, 5, 4, 4, 6, 3], 0.1), 1);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'high');
  assert.ok(Math.abs(out[0].price - 6.1) < CLOSE);
});

/* ------------------------------ structure ------------------------------ */

function pivot(type, i, price) { return { type, i, t: i * 60, price, confirmedAt: i + 1 }; }

test('structure classifies HH+HL as uptrend, LH+LL as downtrend, mixed or equal as range', () => {
  assert.equal(TA.structure([pivot('low', 1, 8), pivot('high', 2, 10), pivot('low', 3, 9), pivot('high', 4, 12)]), 'uptrend');
  assert.equal(TA.structure([pivot('high', 1, 12), pivot('low', 2, 9), pivot('high', 3, 10), pivot('low', 4, 8)]), 'downtrend');
  assert.equal(TA.structure([pivot('low', 1, 8), pivot('high', 2, 10), pivot('low', 3, 7), pivot('high', 4, 12)]), 'range');
  assert.equal(TA.structure([pivot('low', 1, 8), pivot('high', 2, 10), pivot('low', 3, 8), pivot('high', 4, 10)]), 'range',
    'equal pivots are a range statement, not a downtrend');
});

test('structure with fewer than two pivot pairs is unknown (null), never guessed', () => {
  assert.equal(TA.structure([]), null);
  assert.equal(TA.structure([pivot('low', 1, 8), pivot('high', 2, 10), pivot('low', 3, 9)]), null);
});

/* ------------------------------ S/R levels ------------------------------ */

test('levels cluster pivots within the ATR tolerance and drop single touches', () => {
  const pivots = [pivot('low', 1, 100), pivot('low', 3, 100.3), pivot('high', 5, 105)];
  const levels = TA.srLevels(pivots, 1.0, {}); // tol = 0.5 * 1.0
  assert.equal(levels.length, 1, 'the lone 105 pivot is noise, not a level');
  assert.ok(Math.abs(levels[0].price - 100.15) < CLOSE);
  assert.equal(levels[0].touches, 2);
});

test('levels need a warm ATR — without a noise unit there is no "close together"', () => {
  const pivots = [pivot('low', 1, 100), pivot('low', 3, 100.3)];
  assert.deepEqual(TA.srLevels(pivots, null, {}), []);
  assert.deepEqual(TA.srLevels(pivots, 0, {}), []);
});

/* ------------------------------ volume regime ------------------------------ */

test('volume regime compares the last bar to the median of the window before it', () => {
  const base = [1, 1, 1, 1, 1];
  const mk = (curV) => series([10, 10, 10, 10, 10, 10], 0.1).map((b, i) =>
    Object.assign(b, { v: i < 5 ? base[i] : curV }));
  assert.equal(TA.volumeRegime(mk(3), 5), 'elevated');   // 3x median
  assert.equal(TA.volumeRegime(mk(0.4), 5), 'quiet');    // 0.4x median
  assert.equal(TA.volumeRegime(mk(1), 5), 'normal');
});

test('volume regime is unknown with missing volumes or a short window', () => {
  assert.equal(TA.volumeRegime(series([10, 10, 10], 0.1), 5), null);
  const bars = series([10, 10, 10, 10, 10, 10], 0.1, 1);
  delete bars[2].v;
  assert.equal(TA.volumeRegime(bars, 5), null);
});

/* ------------------------------ regime + liq distance ------------------------------ */

test('regime requires both EMA relation and structure; unknown inputs mean unknown regime', () => {
  assert.equal(TA.regime(11, 10, 'uptrend'), 'uptrend');
  assert.equal(TA.regime(9, 10, 'downtrend'), 'downtrend');
  assert.equal(TA.regime(11, 10, 'downtrend'), 'range', 'disagreement is a range read');
  assert.equal(TA.regime(null, 10, 'uptrend'), null);
  assert.equal(TA.regime(11, 10, null), null);
});

test('liquidation distance in ATRs (the ATR × leverage bridge)', () => {
  assert.ok(Math.abs(TA.liqDistanceAtr(100, 95, 2) - 2.5) < CLOSE);
  assert.ok(Math.abs(TA.liqDistanceAtr(95, 100, 2) - 2.5) < CLOSE);
  assert.equal(TA.liqDistanceAtr(100, 95, 0), null);
  assert.equal(TA.liqDistanceAtr(100, 95, null), null);
});

/* ------------------------------ assembleReads warm-up truth ------------------------------ */

test('assembleReads on a cold store: every latest value null, no setups, warm counts honest', () => {
  const reads = TA.assembleReads(series([10, 10.1, 10.05, 10.2, 10.15], 0.1));
  assert.equal(reads.warm.bars, 5);
  assert.equal(reads.emaFast, null);
  assert.equal(reads.emaSlow, null);
  assert.equal(reads.rsi, null);
  assert.equal(reads.atr, null);
  assert.equal(reads.vwap, null, 'no volume data means no VWAP');
  assert.equal(reads.regime, null);
  assert.equal(reads.structure, null);
  assert.equal(reads.volume, null);
  assert.deepEqual(reads.levels, []);
  assert.deepEqual(reads.setups, []);
  assert.equal(reads.warm.needed.emaSlow, TA.DEFAULTS.emaSlow);
});

test('assembleReads of an empty bar array does not throw and reports zero bars', () => {
  const reads = TA.assembleReads([]);
  assert.equal(reads.warm.bars, 0);
  assert.equal(reads.setups.length, 0);
});

/* ------------------------------ detectors ------------------------------
 *
 * Small windows so fixtures stay hand-checkable. Every fixture has a
 * perturbed twin with exactly one stated condition broken, locking both the
 * detection and the silence default.
 */

const OPTS = { emaFast: 3, emaSlow: 5, rsiPeriod: 3, atrPeriod: 3, swingK: 1 };

function setupsOf(reads, name) { return reads.setups.filter((s) => s.setup === name); }

/* The framing contract (§6 of the spec): every emitted setup carries a
 * direction and a finite invalidation. Asserted inside every fixture. */
function assertContract(reads) {
  for (const s of reads.setups) {
    assert.ok(s.direction === 'long' || s.direction === 'short', s.setup + ' direction');
    assert.ok(Number.isFinite(s.invalidation), s.setup + ' must carry a finite invalidation');
    assert.ok(Array.isArray(s.targets), s.setup + ' targets must be an array (possibly empty)');
    assert.ok(Array.isArray(s.entryZone) && s.entryZone.length === 2, s.setup + ' entry zone');
  }
}

test('trend-pullback: uptrend + EMA-slow touch + reclaim → long with swing-anchored stop', () => {
  const closes = [10, 10.8, 10.4, 11.2, 12, 11.4, 12.2, 13, 12.4, 13.2, 14, 13.4, 12.9, 13.8];
  const reads = TA.assembleReads(series(closes, 0.3), OPTS);
  assertContract(reads);
  assert.equal(reads.regime, 'uptrend', 'fixture must establish an uptrend regime');

  const found = setupsOf(reads, 'trend-pullback');
  assert.equal(found.length, 1);
  const s = found[0];
  assert.equal(s.direction, 'long');
  // The stop anchors to the last confirmed swing low below the close: the
  // 12.9 bar's low, 12.9 - 0.3.
  assert.ok(Math.abs(s.invalidation - 12.6) < CLOSE);
  // The target is the last confirmed swing high above the close: 14 + 0.3.
  assert.deepEqual(s.targets.length, 1);
  assert.ok(Math.abs(s.targets[0] - 14.3) < CLOSE);
  assert.ok(s.invalidation < closes[closes.length - 1]);
});

test('trend-pullback stays silent without the reclaim', () => {
  // Same fixture, but the last close sits below the fast EMA: no reclaim,
  // no read — a dip alone is not a setup.
  const closes = [10, 10.8, 10.4, 11.2, 12, 11.4, 12.2, 13, 12.4, 13.2, 14, 13.4, 12.9, 13.0];
  const reads = TA.assembleReads(series(closes, 0.3), OPTS);
  assert.equal(setupsOf(reads, 'trend-pullback').length, 0);
});

test('break-retest: range level broken with margin, retested, held → long off the level', () => {
  const closes = [10, 11, 10.05, 10.95, 10.02, 11.03, 10.0];
  const bars = series(closes, 0.3);
  let t = bars[bars.length - 1].t;
  // The break bar clears the clustered pivot-high level by well over the
  // ATR margin, the next bar retests the level zone, the last bar holds.
  bars.push({ t: (t += 60), o: 12.6, h: 12.9, l: 12.3, c: 12.6 });
  bars.push({ t: (t += 60), o: 11.7, h: 12.0, l: 11.4, c: 11.7 });
  bars.push({ t: (t += 60), o: 11.9, h: 12.2, l: 11.6, c: 11.9 });
  const reads = TA.assembleReads(bars, OPTS);
  assertContract(reads);

  const found = setupsOf(reads, 'break-retest');
  assert.equal(found.length, 1);
  const s = found[0];
  assert.equal(s.direction, 'long');
  // The level clusters the three range pivot highs PLUS the retest bar's own
  // confirmed pivot low — a retest touch is another touch of the level
  // (support/resistance role reversal), so it sharpens the level rather
  // than being ignored.
  const level = (11.3 + 11.25 + 11.33 + 11.4) / 4;
  assert.ok(Math.abs(s.basis.level - level) < CLOSE);
  assert.equal(s.basis.touches, 4);
  assert.ok(s.invalidation < level);
  assert.ok(s.entryZone[0] <= level && level <= s.entryZone[1] + CLOSE);
});

test('break-retest stays silent when price never comes back to the level', () => {
  const closes = [10, 11, 10.05, 10.95, 10.02, 11.03, 10.0];
  const bars = series(closes, 0.3);
  let t = bars[bars.length - 1].t;
  bars.push({ t: (t += 60), o: 12.6, h: 12.9, l: 12.3, c: 12.6 });
  bars.push({ t: (t += 60), o: 13.0, h: 13.3, l: 12.7, c: 13.0 }); // runs away instead
  bars.push({ t: (t += 60), o: 13.4, h: 13.7, l: 13.1, c: 13.4 });
  const reads = TA.assembleReads(bars, OPTS);
  assert.equal(setupsOf(reads, 'break-retest').length, 0, 'a breakout without a retest is a chase, not this setup');
});

test('vwap-reversion: stretched beyond the ATR threshold with a counter bar → fade toward VWAP', () => {
  const bars = [];
  let t = 0;
  for (let i = 0; i < 12; i++) bars.push(flat((t += 60), 10, 0.05, 1));
  bars.push({ t: (t += 60), o: 10, h: 10.55, l: 9.95, c: 10.5, v: 1 });
  bars.push({ t: (t += 60), o: 10.5, h: 11.05, l: 10.45, c: 11, v: 1 });
  bars.push({ t: (t += 60), o: 11, h: 11.55, l: 10.95, c: 11.5, v: 1 });
  bars.push({ t: (t += 60), o: 11.5, h: 11.55, l: 11.25, c: 11.3, v: 1 }); // counter bar
  const opts = Object.assign({}, OPTS, { atrPeriod: 10 });
  const reads = TA.assembleReads(bars, opts);
  assertContract(reads);

  const found = setupsOf(reads, 'vwap-reversion');
  assert.equal(found.length, 1);
  const s = found[0];
  assert.equal(s.direction, 'short', 'stretched above VWAP fades short');
  assert.ok(Math.abs(s.targets[0] - reads.vwap) < CLOSE, 'the target IS the vwap, nothing invented');
  assert.ok(s.basis.stretchAtr >= TA.DEFAULTS.stretchAtr);
  assert.ok(s.invalidation > bars[bars.length - 1].c, 'short invalidates above');
});

test('vwap-reversion stays silent while the move is still going (no counter bar, no RSI turn)', () => {
  const bars = [];
  let t = 0;
  for (let i = 0; i < 12; i++) bars.push(flat((t += 60), 10, 0.05, 1));
  bars.push({ t: (t += 60), o: 10, h: 10.55, l: 9.95, c: 10.5, v: 1 });
  bars.push({ t: (t += 60), o: 10.5, h: 11.05, l: 10.45, c: 11, v: 1 });
  bars.push({ t: (t += 60), o: 11, h: 11.55, l: 10.95, c: 11.5, v: 1 });
  bars.push({ t: (t += 60), o: 11.5, h: 11.85, l: 11.45, c: 11.8, v: 1 }); // still climbing
  const reads = TA.assembleReads(bars, Object.assign({}, OPTS, { atrPeriod: 10 }));
  assert.equal(setupsOf(reads, 'vwap-reversion').length, 0,
    'stretch alone is a trend, not a reversion setup');
});

test('rsi-divergence: lower low with higher RSI from an extreme, anchored at a level → long', () => {
  const closes = [15, 14.9, 14.7, 14.0, 12.0, 13.2, 13.0, 11.9, 12.9, 13.1];
  const reads = TA.assembleReads(series(closes, 0.1), OPTS);
  assertContract(reads);

  const found = setupsOf(reads, 'rsi-divergence');
  assert.equal(found.length, 1);
  const s = found[0];
  assert.equal(s.direction, 'long');
  // Price made a lower low (11.9 < 12.0 at the pivot lows)…
  assert.ok(s.basis.pivot2 < s.basis.pivot1);
  // …while RSI refused to follow.
  assert.ok(s.basis.rsi2 > s.basis.rsi1);
  assert.ok(s.basis.rsi1 <= TA.DEFAULTS.rsiOversold, 'the first pivot must come from an RSI extreme');
  assert.ok(s.invalidation < s.basis.pivot2);
});

test('rsi-divergence stays silent when the second low is not actually lower', () => {
  const closes = [15, 14.9, 14.7, 14.0, 12.0, 13.2, 13.0, 12.1, 12.9, 13.1];
  const reads = TA.assembleReads(series(closes, 0.1), OPTS);
  assert.equal(setupsOf(reads, 'rsi-divergence').length, 0,
    'a higher low is not a divergence — price must extend while momentum refuses');
});
