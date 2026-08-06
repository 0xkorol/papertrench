/* Chart orders — take profit / stop loss, the Padre-style exit.
 *
 * The rules live in the engine so they can be tested without a chart, a
 * browser or a price feed. What is locked here:
 *
 *   - a level that would fire immediately is REFUSED, not armed
 *   - size is a percentage of the bag AT FIRE TIME, not a frozen token count
 *   - the fill price is the next OBSERVED price, never the trigger level,
 *     and the gap between the two is recorded on the trade
 *   - closing a position disarms everything attached to it
 *
 * The honest-fill rule is the one worth being loudest about. A paper stop
 * that always fills exactly where it was placed teaches an exit quality that
 * does not exist in memecoin liquidity, and this project treats a flattering
 * number as a safety defect.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

global.window = global.window || {};
require('../engine.js');
const E = global.window.PaperEngine;

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const T0 = 1_700_000_000_000;

/** A wallet holding one open position bought at `price`. */
function walletWithPosition(price = 0.001, sol = 1) {
  const settings = E.mergeSettings({ feeBps: 0, slippageBps: 0, gasSolPerTx: 0, tipSolPerTx: 0 });
  const state = E.defaultState(settings);
  E.buy(state, settings, { mint: MINT, symbol: 'BONK', solAmount: sol, priceNative: price, ts: T0 });
  return { state, settings };
}

/* ---------------- arming ---------------- */

test('a take profit must sit above the price and a stop below it', () => {
  const { state } = walletWithPosition(0.001);

  // The good cases.
  assert.ok(E.addOrder(state, MINT, { kind: 'tp', triggerPrice: 0.002 }, 0.001, T0));
  assert.ok(E.addOrder(state, MINT, { kind: 'sl', triggerPrice: 0.0005 }, 0.001, T0));

  // The refusals: either of these would fire on the very next tick, which is
  // a market sell wearing an order's costume.
  assert.throws(() => E.addOrder(state, MINT, { kind: 'tp', triggerPrice: 0.0009 }, 0.001, T0),
    /cannot be armed/, 'a take profit below the price is refused');
  assert.throws(() => E.addOrder(state, MINT, { kind: 'sl', triggerPrice: 0.0011 }, 0.001, T0),
    /cannot be armed/, 'a stop above the price is refused');
});

test('an order needs a position behind it', () => {
  const settings = E.mergeSettings(null);
  const state = E.defaultState(settings);
  assert.throws(() => E.addOrder(state, MINT, { kind: 'sl', triggerPrice: 0.0005 }, 0.001, T0),
    /No open paper position/);
});

test('junk never arms', () => {
  assert.equal(E.normalizeOrder(null, 1, T0), null);
  assert.equal(E.normalizeOrder({ kind: 'moon', triggerPrice: 2 }, 1, T0), null);
  assert.equal(E.normalizeOrder({ kind: 'tp', triggerPrice: 0 }, 1, T0), null);
  assert.equal(E.normalizeOrder({ kind: 'tp', triggerPrice: NaN }, 1, T0), null);
  assert.equal(E.normalizeOrder({ kind: 'sl', triggerPrice: -5 }, 1, T0), null);
});

test('size is clamped into 1..100 and defaults to the whole bag', () => {
  assert.equal(E.normalizeOrder({ kind: 'tp', triggerPrice: 2 }, 1, T0).sizePct, 100);
  assert.equal(E.normalizeOrder({ kind: 'tp', triggerPrice: 2, sizePct: 250 }, 1, T0).sizePct, 100);
  assert.equal(E.normalizeOrder({ kind: 'tp', triggerPrice: 2, sizePct: 0 }, 1, T0).sizePct, 100);
  assert.equal(E.normalizeOrder({ kind: 'tp', triggerPrice: 2, sizePct: 50 }, 1, T0).sizePct, 50);
});

/* ---------------- firing ---------------- */

test('a take profit fires at or above its level, a stop at or below', () => {
  const { state } = walletWithPosition(0.001);
  E.addOrder(state, MINT, { kind: 'tp', triggerPrice: 0.002, id: 'tp1' }, 0.001, T0);
  E.addOrder(state, MINT, { kind: 'sl', triggerPrice: 0.0005, id: 'sl1' }, 0.001, T0);

  assert.deepEqual(E.triggeredOrders(state, MINT, 0.001).map((o) => o.id), [], 'sitting still fires nothing');
  assert.deepEqual(E.triggeredOrders(state, MINT, 0.002).map((o) => o.id), ['tp1'], 'exactly at the level counts');
  assert.deepEqual(E.triggeredOrders(state, MINT, 0.005).map((o) => o.id), ['tp1']);
  assert.deepEqual(E.triggeredOrders(state, MINT, 0.0005).map((o) => o.id), ['sl1']);
  assert.deepEqual(E.triggeredOrders(state, MINT, 0.0001).map((o) => o.id), ['sl1'], 'a gap far past still fires');
});

test('when a crash trips two stops the lower one is reported first', () => {
  const { state } = walletWithPosition(0.001);
  E.addOrder(state, MINT, { kind: 'sl', triggerPrice: 0.0008, id: 'near' }, 0.001, T0);
  E.addOrder(state, MINT, { kind: 'sl', triggerPrice: 0.0004, id: 'far' }, 0.001, T0);
  assert.deepEqual(E.triggeredOrders(state, MINT, 0.0002).map((o) => o.id), ['far', 'near']);
});

test('an unarmed price fires nothing, and junk prices fire nothing', () => {
  const { state } = walletWithPosition(0.001);
  E.addOrder(state, MINT, { kind: 'sl', triggerPrice: 0.0005 }, 0.001, T0);
  assert.deepEqual(E.triggeredOrders(state, MINT, 0), []);
  assert.deepEqual(E.triggeredOrders(state, MINT, NaN), []);
  assert.deepEqual(E.triggeredOrders(state, 'other-mint', 0.0001), []);
});

/* ---------------- the honest fill ---------------- */

test('a stop that gaps fills at the OBSERVED price, not its level', () => {
  const { state, settings } = walletWithPosition(0.001, 1);
  const order = E.addOrder(state, MINT, { kind: 'sl', triggerPrice: 0.0008 }, 0.001, T0);

  // The market gapped straight through 0.0008 and the next price this
  // machine actually saw was 0.0006.
  const observed = 0.0006;
  assert.deepEqual(E.triggeredOrders(state, MINT, observed).map((o) => o.id), [order.id]);

  const { trade } = E.sell(state, settings, {
    mint: MINT, qtyFraction: order.sizePct / 100, priceNative: observed, ts: T0 + 1000, order,
  });

  assert.equal(trade.priceNative, observed, 'the fill is the price the market gave');
  assert.equal(trade.triggerPrice, 0.0008, 'the level asked for is preserved beside it');
  assert.equal(trade.orderKind, 'sl');
  assert.ok(trade.triggerSlipPct < 0, 'a gap past a stop reads as WORSE than asked');
  assert.equal(Math.round(trade.triggerSlipPct * 10) / 10, -25, '0.0006 vs 0.0008 is -25%');
});

test('slip reads negative for a take profit that filled below its target too', () => {
  // Same disappointment, opposite side of the number line — it must read the
  // same way, or a trader scanning the journal misreads one of them.
  const tp = { kind: 'tp', triggerPrice: 0.002 };
  assert.ok(E.orderSlipPct(tp, 0.0018) < 0, 'filled under target = worse');
  assert.ok(E.orderSlipPct(tp, 0.0022) > 0, 'filled over target = better');

  const sl = { kind: 'sl', triggerPrice: 0.0008 };
  assert.ok(E.orderSlipPct(sl, 0.0006) < 0, 'gapped below stop = worse');
  assert.ok(E.orderSlipPct(sl, 0.00082) > 0, 'filled above stop = better');

  assert.equal(E.orderSlipPct(sl, 0), null, 'no fill price, no claim');
  assert.equal(E.orderSlipPct({ triggerPrice: 0 }, 1), null);
});

test('a hand sell before the order fires leaves the percentage meaning what it says', () => {
  // "Take profit on half" must still mean half of whatever is left, not half
  // of the bag as it stood when the level was armed.
  const { state, settings } = walletWithPosition(0.001, 1);
  const order = E.addOrder(state, MINT, { kind: 'tp', triggerPrice: 0.002, sizePct: 50 }, 0.001, T0);

  // Sell 60% by hand first.
  E.sell(state, settings, { mint: MINT, qtyFraction: 0.6, priceNative: 0.0015, ts: T0 + 500 });
  const left = state.positions[MINT].qty;

  E.sell(state, settings, {
    mint: MINT, qtyFraction: order.sizePct / 100, priceNative: 0.002, ts: T0 + 1000, order,
  });
  assert.ok(Math.abs(state.positions[MINT].qty - left * 0.5) < 1e-9,
    'half of what remained, not half of the original bag');
});

/* ---------------- lifecycle ---------------- */

test('closing the position disarms everything attached to it', () => {
  const { state, settings } = walletWithPosition(0.001, 1);
  E.addOrder(state, MINT, { kind: 'tp', triggerPrice: 0.002 }, 0.001, T0);
  E.addOrder(state, MINT, { kind: 'sl', triggerPrice: 0.0005 }, 0.001, T0);
  assert.equal(E.ordersFor(state, MINT).length, 2);

  E.sell(state, settings, { mint: MINT, qtyFraction: 1, priceNative: 0.0012, ts: T0 + 1000 });

  assert.equal(state.positions[MINT], undefined, 'position closed');
  assert.equal(E.ordersFor(state, MINT).length, 0,
    'orders with no bag behind them would fire phantom sells');
  assert.deepEqual(E.mintsWithOrders(state), []);
});

test('a partial exit leaves the orders armed', () => {
  const { state, settings } = walletWithPosition(0.001, 1);
  E.addOrder(state, MINT, { kind: 'tp', triggerPrice: 0.002 }, 0.001, T0);
  E.sell(state, settings, { mint: MINT, qtyFraction: 0.5, priceNative: 0.0012, ts: T0 + 1000 });
  assert.equal(E.ordersFor(state, MINT).length, 1, 'still holding, still armed');
});

test('dragging moves the level and nothing else', () => {
  const { state } = walletWithPosition(0.001);
  const order = E.addOrder(state, MINT, { kind: 'sl', triggerPrice: 0.0005, sizePct: 40 }, 0.001, T0);

  const moved = E.moveOrder(state, MINT, order.id, 0.0007, 210_000);
  assert.equal(moved.triggerPrice, 0.0007);
  assert.equal(moved.triggerMcap, 210_000);
  assert.equal(moved.sizePct, 40, 'a drag never silently resizes the order');
  assert.equal(moved.kind, 'sl');
  assert.equal(E.ordersFor(state, MINT).length, 1, 'a drag never adds a second order');

  assert.equal(E.moveOrder(state, MINT, order.id, 0), null, 'a junk level is refused');
  assert.equal(E.moveOrder(state, MINT, 'nope', 0.001), null, 'an unknown order id is refused');
  assert.equal(E.ordersFor(state, MINT)[0].triggerPrice, 0.0007, 'a refused move changes nothing');
});

test('orders are removable, and the mint drops out of the work list when empty', () => {
  const { state } = walletWithPosition(0.001);
  const a = E.addOrder(state, MINT, { kind: 'tp', triggerPrice: 0.002 }, 0.001, T0);
  const b = E.addOrder(state, MINT, { kind: 'sl', triggerPrice: 0.0005 }, 0.001, T0);
  assert.deepEqual(E.mintsWithOrders(state), [MINT]);

  assert.equal(E.removeOrder(state, MINT, a.id), true);
  assert.equal(E.removeOrder(state, MINT, 'nope'), false);
  assert.equal(E.ordersFor(state, MINT).length, 1);

  E.removeOrder(state, MINT, b.id);
  assert.deepEqual(E.mintsWithOrders(state), [], 'an empty mint leaves no husk behind');
});

test('there is a ceiling on orders per token', () => {
  const { state } = walletWithPosition(0.001);
  for (let i = 0; i < E.MAX_ORDERS_PER_MINT; i += 1) {
    E.addOrder(state, MINT, { kind: 'tp', triggerPrice: 0.002 + i * 0.0001 }, 0.001, T0);
  }
  assert.throws(() => E.addOrder(state, MINT, { kind: 'tp', triggerPrice: 0.01 }, 0.001, T0),
    /At most/);
});

test('a fresh wallet has an orders map, and old wallets survive without one', () => {
  assert.deepEqual(E.defaultState(E.mergeSettings(null)).orders, {});
  // A wallet saved before this feature existed has no `orders` key at all.
  const legacy = { positions: {}, journal: [], rounds: [] };
  assert.deepEqual(E.ordersFor(legacy, MINT), [], 'reading is safe');
  assert.deepEqual(E.mintsWithOrders(legacy), []);
  assert.equal(E.clearOrders(legacy, MINT), false);
});

test('background arming is OFF by default and the feature itself is ON', () => {
  const fresh = E.mergeSettings(null);
  assert.equal(fresh.chartOrdersEnabled, true,
    'chart orders are the exit half of paper trading');
  assert.equal(fresh.ordersBackgroundArmEnabled, false,
    'nothing runs behind the user until they ask for it');
});
