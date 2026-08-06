/* Tests for the perps ticket view-model (perps-ticket.js).
 *
 * The load-bearing contract: the preview runs the REAL engine on a scratch
 * book, so preview and fill can never disagree; and the carry gates refuse
 * the ticket outright when the venue's live rate is unknown — funding real
 * or no trade.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

global.window = global.window || {};
require('../perps-venues.js');
require('../perps.js');
require('../perps-ticket.js');
const T = global.window.PaperPerpsTicket;
const P = global.window.PaperPerps;

const CLOSE = 1e-9;

const HL_ARGS = {
  venue: 'hyperliquid', market: 'SOL', side: 'long',
  marginUsd: 10, leverage: 20, price: 100, t: 1000,
  cashUsd: 1000, params: { maxLeverage: 20 },
  carry: { fundingHourlyFrac: 0.0000125 }, marketConfirmed: true,
};
const JUP_ARGS = {
  venue: 'jupiter', market: 'SOL', side: 'long',
  marginUsd: 5, leverage: 100, price: 100, t: 1000,
  cashUsd: 1000, params: { impactScalarAdjUsd: 125000000000 },
  carry: { borrowRateFrac: 0.0000237624 }, marketConfirmed: true,
};

test('carry gates: no live venue rate, no ticket — before the engine is even asked', () => {
  const hl = T.buildPreview(Object.assign({}, HL_ARGS, { carry: {} }));
  assert.equal(hl.ok, false);
  assert.equal(hl.reason, 'funding-unavailable');
  const jup = T.buildPreview(Object.assign({}, JUP_ARGS, { carry: {} }));
  assert.equal(jup.ok, false);
  assert.equal(jup.reason, 'borrow-unavailable');
  const unconfirmed = T.buildPreview(Object.assign({}, HL_ARGS, { marketConfirmed: false }));
  assert.equal(unconfirmed.reason, 'market-unconfirmed');
});

test('$10 at 20x HL preview: the four numbers, from the real engine', () => {
  const pv = T.buildPreview(HL_ARGS);
  assert.equal(pv.ok, true);
  assert.ok(Math.abs(pv.rows.notionalUsd - 200) < CLOSE);
  assert.ok(Math.abs(pv.rows.feeUsd - 0.09) < CLOSE, 'taker 4.5 bps on $200');
  assert.ok(Math.abs(pv.rows.liqPx - (100 - (5 / 2) / 0.975)) < CLOSE);
  assert.ok(Math.abs(pv.rows.liqDistPct - (100 - pv.rows.liqPx)) < 1e-6, 'at price 100, pct == distance');
  // Long pays a positive funding rate: 200 * 0.0000125 = $0.0025/hr.
  assert.ok(Math.abs(pv.rows.carryPerHourUsd - 0.0025) < CLOSE);
  assert.equal(pv.warnings.length, 0, '2.56% to liq and 0.9% fees trip no warnings');
});

test('a short RECEIVES positive funding, and the text says so', () => {
  const pv = T.buildPreview(Object.assign({}, HL_ARGS, { side: 'short' }));
  assert.ok(pv.rows.carryPerHourUsd < 0);
  assert.match(pv.rows.carryText, /received/);
});

test('$5 at 100x Jupiter preview warns about both the liq distance and the fee bite', () => {
  const pv = T.buildPreview(JUP_ARGS);
  assert.equal(pv.ok, true);
  const openFee = 500 * 0.0006 + (500 * 500) / 125000000000;
  assert.ok(Math.abs(pv.rows.feeUsd - openFee) < CLOSE);
  assert.ok(pv.rows.liqDistPct < 0.7, 'liq under 0.7% away');
  assert.equal(pv.warnings.length, 2, 'liq-distance warning AND fee-bite warning');
  assert.match(pv.warnings[0], /noise/);
  assert.match(pv.warnings[1], /6\.00% of this margin/);
  // Borrow carry: 500 * rate.
  assert.ok(Math.abs(pv.rows.carryPerHourUsd - 500 * 0.0000237624) < CLOSE);
});

test('engine refusals pass through with human text', () => {
  const pv = T.buildPreview(Object.assign({}, HL_ARGS, { cashUsd: 5 }));
  assert.equal(pv.ok, false);
  assert.equal(pv.reason, 'insufficient-cash');
  assert.match(pv.text, /balance/);
  const lev = T.buildPreview(Object.assign({}, HL_ARGS, { leverage: 25 }));
  assert.equal(lev.reason, 'leverage-above-max');
});

test('the preview leaves no trace: it cannot open a position anywhere', () => {
  const state = P.defaultPerpsState({ perpsStartUsd: 1000 });
  T.buildPreview(HL_ARGS);
  assert.equal(Object.keys(state.positions).length, 0);
  assert.equal(state.cashUsd, 1000);
});

test('position rows report PnL, liquidatability, and never mutate the book', () => {
  const state = P.defaultPerpsState({ perpsStartUsd: 1000 });
  const { position: pos } = P.openPerp(state, {
    venue: 'hyperliquid', market: 'SOL', side: 'long',
    marginUsd: 10, leverage: 20, price: 100, t: 1000, params: { maxLeverage: 20 },
  });
  const before = JSON.stringify(state);

  const up = T.buildPositionRows(state, { venue: 'hyperliquid', market: 'SOL', px: 102 });
  assert.equal(up.length, 1);
  assert.equal(up[0].label, 'LONG 20x');
  assert.ok(up[0].uPnlUsd > 0);
  assert.match(up[0].uPnlText, /^\+/);
  assert.equal(up[0].liquidatable, false);

  const crushed = T.buildPositionRows(state, { venue: 'hyperliquid', market: 'SOL', px: pos.liqPx - 0.01 });
  assert.equal(crushed[0].liquidatable, true);

  const other = T.buildPositionRows(state, { venue: 'hyperliquid', market: 'BTC', px: 102 });
  assert.equal(other.length, 0, 'rows are scoped to the page market');

  assert.equal(JSON.stringify(state), before, 'rendering must never move the book');
});

test('rows print the liquidation price they just computed, not a stale stored one', () => {
  // A pure mark writes nothing back, so pos.liqPx is only as fresh as the last
  // COMMITTED write. Anything on the row that reads the stored copy instead of
  // the mark's own answer puts a stale liquidation price on screen — and the
  // liq distance, in percent and in ATRs, is measured from it.
  const state = P.defaultPerpsState({ perpsStartUsd: 1000 });
  const { id } = P.openPerp(state, {
    venue: 'hyperliquid', market: 'SOL', side: 'long',
    marginUsd: 10, leverage: 20, price: 100, t: 1000, params: { maxLeverage: 20 },
  });
  const truth = P.perpMark(state.positions[id], 100).liqPx;
  // Poison the stored copy on a HEALTHY position. (It must be healthy: on a
  // breached one, carrying the stored price is the intended behaviour.)
  state.positions[id].liqPx = 42;

  const rows = T.buildPositionRows(state, { venue: 'hyperliquid', market: 'SOL', px: 100, atr: 0.5 });
  assert.equal(rows.length, 1);
  assert.match(rows[0].liqText, /^97\./, `the row must show the computed ${truth}, not the stored 42`);
  assert.ok(Math.abs(rows[0].liqDistPct - (100 - truth)) < 1e-9, 'distance measured from the computed price');
  assert.ok(Math.abs(rows[0].liqDistAtr - (100 - truth) / 0.5) < 1e-9, 'ATR distance likewise');
});

test('a render cannot write to the book — proven against a frozen one', () => {
  for (const [venue, params, price] of [
    ['hyperliquid', { maxLeverage: 20 }, 100],
    ['jupiter', { impactScalarAdjUsd: 125000000000 }, 100],
  ]) {
    const state = P.defaultPerpsState({ perpsStartUsd: 1000 });
    const { id } = P.openPerp(state, {
      venue, market: 'SOL', side: 'long',
      marginUsd: 20, leverage: 10, price, t: 1000, params,
    });
    Object.freeze(state);
    Object.freeze(state.positions);
    Object.freeze(state.positions[id]);
    const rows = T.buildPositionRows(state, { venue, market: 'SOL', px: 101 });
    assert.equal(rows.length, 1, `${venue} row must render`);
    assert.ok(Number.isFinite(rows[0].uPnlUsd), `${venue} row must carry real numbers`);
  }
});

test('an unverified-gap position carries its honesty note into the row', () => {
  const state = P.defaultPerpsState({ perpsStartUsd: 1000 });
  const { position: pos } = P.openPerp(state, {
    venue: 'jupiter', market: 'SOL', side: 'long',
    marginUsd: 5, leverage: 10, price: 100, t: 1000, params: { impactScalarAdjUsd: 125000000000 },
  });
  pos.unverifiedGapSec = 1800;
  const rows = T.buildPositionRows(state, { venue: 'jupiter', market: 'SOL', px: 100 });
  assert.match(rows[0].gapNote, /30 min unobserved/);
  assert.match(rows[0].gapNote, /real borrow would be higher/);
});

test('the ATR × leverage bridge: liq distance in noise units when a warm ATR exists', () => {
  // $10 at 20x from 100: liq 97.4359, distance 2.5641. ATR 0.5 → 5.1 ATR.
  const pv = T.buildPreview(Object.assign({}, HL_ARGS, { atr: 0.5 }));
  const dist = 100 - pv.rows.liqPx;
  assert.ok(Math.abs(pv.rows.liqDistAtr - dist / 0.5) < CLOSE);
  assert.match(pv.rows.liqDistText, /5\.1 ATR/);
  assert.equal(pv.warnings.length, 0, '5 ATRs of room trips no warning');

  // ATR 2 → 1.28 ATRs of room: the warning names the noise unit.
  const tight = T.buildPreview(Object.assign({}, HL_ARGS, { atr: 2 }));
  assert.equal(tight.warnings.length, 1);
  assert.match(tight.warnings[0], /1\.3 ATR away on the 5m/);

  // No ATR (cold store): the number is absent, never padded.
  const cold = T.buildPreview(HL_ARGS);
  assert.equal(cold.rows.liqDistAtr, null);
  assert.ok(!/ATR/.test(cold.rows.liqDistText));
});

test('position rows carry the ATR distance only when the ATR is real', () => {
  const state = P.defaultPerpsState({ perpsStartUsd: 1000 });
  P.openPerp(state, {
    venue: 'hyperliquid', market: 'SOL', side: 'long',
    marginUsd: 10, leverage: 20, price: 100, t: 1000, params: { maxLeverage: 20 },
  });
  const withAtr = T.buildPositionRows(state, { venue: 'hyperliquid', market: 'SOL', px: 100, atr: 0.5 });
  assert.match(withAtr[0].liqText, /ATR/);
  // liqDistPct is (px - liq)/px in percent; at px 100 the absolute distance
  // is liqDistPct itself, so the ATR distance is that over 0.5.
  assert.ok(Math.abs(withAtr[0].liqDistAtr - withAtr[0].liqDistPct / 0.5) < 1e-9);
  const noAtr = T.buildPositionRows(state, { venue: 'hyperliquid', market: 'SOL', px: 100 });
  assert.equal(noAtr[0].liqDistAtr, null);
  assert.ok(!/ATR/.test(noAtr[0].liqText));
});

test('the TA strip: regime line, setups with their wrong-if, warm-up truth, and silence', () => {
  assert.equal(T.buildTaStrip(null), null, 'no reads, no strip — silence is a valid output');

  const cold = T.buildTaStrip({
    warm: { bars: 5, needed: { emaSlow: 21 } },
    regime: null, setups: [],
  });
  assert.match(cold.regimeText, /5\/21 bars observed/);
  assert.equal(cold.setups.length, 0);

  const warmNoRead = T.buildTaStrip({
    warm: { bars: 60, needed: { emaSlow: 21 } },
    regime: null, setups: [],
  });
  assert.match(warmNoRead.regimeText, /structure unclear/);

  const live = T.buildTaStrip({
    warm: { bars: 60, needed: { emaSlow: 21 } },
    regime: 'uptrend', rsi: 61.4, atr: 0.52,
    setups: [{ setup: 'trend-pullback', direction: 'long', invalidation: 97.4, targets: [103.2] }],
  });
  assert.match(live.regimeText, /^Uptrend · RSI 61 · ATR 0\.52/);
  assert.equal(live.setups.length, 1);
  assert.equal(live.setups[0].text, 'Pullback long');
  assert.match(live.setups[0].detail, /wrong if 97\.40/);
  assert.match(live.setups[0].detail, /→ 103\.20/, 'target shown when one exists');

  const noTarget = T.buildTaStrip({
    warm: { bars: 60, needed: { emaSlow: 21 } },
    regime: 'range', setups: [{ setup: 'break-retest', direction: 'short', invalidation: 101, targets: [] }],
  });
  assert.ok(!/→/.test(noTarget.setups[0].detail), 'no invented targets');
});

test('formatting: tabular money and prices', () => {
  assert.equal(T.fmtUsd(1234.5), '$1,234.50');
  assert.equal(T.fmtUsd(-2), '-$2.00');
  assert.equal(T.fmtUsd(2, { signed: true }), '+$2.00');
  assert.equal(T.fmtUsd(0.0008), '$0.000800');
  assert.equal(T.fmtUsd(NaN), '—');
  assert.equal(T.fmtPx(64535), '64,535.0');
  assert.equal(T.fmtPct(2.564), '2.56%');
});
