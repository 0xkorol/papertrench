/* Levels teleporting when the chart's axis BASIS flaps.
 *
 * Field report (fomo.family, 2026-08-06): "the avg fill line and where the
 * entry thought it was just keeps teleporting everywhere — completely
 * unusable."
 *
 * F-32 already established that a drawn level is a CONSTANT in axis units:
 * recomputing `close x avg/current` on every sweep from a MOVING close makes
 * the level ride the candle at ratio ~= 1 instead of holding. The fix froze
 * the level once and re-asserted the same number.
 *
 * But BOTH freezes are keyed on axisBasis, and a basis change discards them:
 *   price-bridge.js  — a changed basis clears every mark's frozenLevel
 *   price-bridge.js  — frozenBuy/SellLevel survive only when basis is equal
 *
 * That is correct for a REAL unit switch (a Price<->MCap toggle genuinely
 * changes what the number means). The defect is that basis is not declared
 * by the chart — it is INFERRED per tick from which band the value lands in
 * (quote.js), and `mcap` vs `native-mcap` are separated by a boundary that
 * moves with the SOL/USD rate. A value near that boundary flaps between the
 * two classifications tick to tick. Each flap wipes both freezes and
 * recomputes from a close that has moved since — so the level walks.
 *
 * These tests pin the BRIDGE half: given a basis flap, a level whose
 * underlying averages never changed must not move. Whether fomo's basis
 * actually flaps is a separate question about quote.js; the bridge must be
 * robust either way, because a real unit toggle and a misclassification are
 * indistinguishable from here.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function runBridge() {
  const timers = [];
  const emitted = [];
  const listeners = {};
  const orderLines = [];
  let realtimeCallback = null;

  function makeOrderLine() {
    const line = { removed: false, values: {} };
    for (const m of ['setText', 'setQuantity', 'setLineColor', 'setLineStyle', 'setLineWidth',
      'setPrice', 'setBodyFont', 'setBodyTextColor', 'setBodyBorderColor',
      'setBodyBackgroundColor', 'setEditable']) {
      line[m] = function (v) { this.values[m] = v; return this; };
    }
    line.getPrice = function () { return this.values.setPrice; };
    line.onMove = function () { return this; };
    line.onCancel = function () { return this; };
    line.remove = function () { this.removed = true; return this; };
    orderLines.push(line);
    return line;
  }

  const datafeed = { subscribeBars(s, r, cb) { realtimeCallback = cb; }, getMarks(s, f, t, cb) { cb([]); } };
  const chart = { clearMarks() {}, refreshMarks() {}, createOrderLine: makeOrderLine };

  function FakeWebSocket() {}
  FakeWebSocket.prototype.addEventListener = () => {};
  FakeWebSocket.CONNECTING = 0; FakeWebSocket.OPEN = 1;
  FakeWebSocket.CLOSING = 2; FakeWebSocket.CLOSED = 3;
  function FakeSharedWorker() { this.port = { addEventListener() {}, start() {} }; }
  function FakeXHR() {}
  FakeXHR.prototype.send = function () {};
  FakeXHR.prototype.addEventListener = function () {};

  const win = {
    tvWidget: { _options: { datafeed }, activeChart: () => chart },
    fetch: () => Promise.resolve({
      url: '', headers: { get: () => 'application/json' },
      clone: () => ({ text: () => Promise.resolve('{}') }),
    }),
    XMLHttpRequest: FakeXHR, WebSocket: FakeWebSocket,
    SharedWorker: FakeSharedWorker, EventSource: undefined,
    addEventListener(type, fn) { listeners[type] = fn; },
    postMessage(m) { emitted.push(m); },
  };
  win.window = win;

  const sandbox = {
    window: win,
    location: { href: 'https://fomo.family/token/Mint1', hostname: 'fomo.family' },
    console, Date, Math, Number, String, Array, Object, Boolean, RegExp, Error,
    Set, WeakSet, WeakMap, Map, Symbol, JSON, Promise, isFinite,
    setInterval(fn) { timers.push(fn); return timers.length; },
    clearInterval() {}, setTimeout(fn) { fn(); return 1; },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'price-bridge.js'), 'utf8'), sandbox,
    { filename: 'price-bridge.js' });
  for (const fn of timers.slice()) fn();

  const send = (type, payload) => {
    listeners.message({ source: win, data: { source: 'papertrench-content', type, payload } });
  };
  const tickBar = (close) => {
    datafeed.subscribeBars({}, '15S', () => {}, 'sub', () => {});
    realtimeCallback({ time: 1_700_000_000_000, close });
  };
  // The bridge's own 1 s sweeps, which re-assert every drawn level.
  const sweep = () => { for (const fn of timers.slice()) fn(); };
  return { emitted, orderLines, send, tickBar, sweep, win };
}

/** Several bridge sweeps, as a second or two of wall clock would produce. */
function runSweeps(env, n = 3) { for (let i = 0; i < n; i += 1) env.sweep(); }

/** The average-line spec for a position averaging 0.001 SOL, priced live. */
function linesSpec(basis, currentNative) {
  return {
    enabled: true,
    axisBasis: basis,
    currentPriceNative: currentNative,
    currentPriceUsd: currentNative * 240,
    currentMcap: null,
    avgBuyNative: 0.001,
    avgBuyUsd: 0.24,
    avgSellNative: null,
    avgSellUsd: null,
  };
}

/** The level the buy average line is currently drawn at. */
function drawnBuyLevel(env) {
  const live = env.orderLines.filter((l) => !l.removed);
  return live.length ? live[0].values.setPrice : null;
}

test('an unchanged average holds its level while the close moves (F-32, still good)', () => {
  const env = runBridge();
  env.tickBar(240_000);
  env.send('paper-lines', linesSpec('mcap', 0.001));
  const first = drawnBuyLevel(env);
  assert.ok(first > 0, 'a level was drawn');

  // The candle moves and the live price moves with it. Same averages, same
  // basis: the level is a constant and must not budge.
  env.tickBar(300_000);
  env.send('paper-lines', linesSpec('mcap', 0.00125));
  assert.equal(drawnBuyLevel(env), first, 'the entry level is a constant in axis units');
});

test('a basis FLAP must not move a level whose averages never changed', () => {
  // The fomo report. `mcap` and `native-mcap` are the two classifications
  // separated by a rate-dependent boundary, so a value near it alternates
  // between them tick to tick — while describing the SAME axis and the SAME
  // entry. The level must survive that.
  const env = runBridge();
  env.tickBar(240_000);
  env.send('paper-lines', linesSpec('mcap', 0.001));
  const first = drawnBuyLevel(env);
  assert.ok(first > 0);

  // One tick later: the close has moved, the live price has moved with it,
  // and the classifier flipped to the neighbouring basis. Nothing about the
  // user's position changed.
  env.tickBar(300_000);
  env.send('paper-lines', linesSpec('native-mcap', 0.00125));

  assert.equal(drawnBuyLevel(env), first,
    'a reclassification is not a move — the entry is still the same entry');
});

test('a flap followed by candle movement does not walk the level away', () => {
  // THIS is the shape that actually bites, and it is the one F-32 named:
  // "any staleness anywhere (a missed spec re-post, a frozen current) made
  // the line ride the candle at ratio ~= 1".
  //
  // A basis flap alone is harmless — close and current move together, so
  // `close x avg/current` is scale-invariant and recomputing lands on the
  // same number. The damage needs the two to move APART: the bar close
  // updates on every chart tick (fast), while the spec's currentPriceNative
  // only refreshes when the content script re-posts (throttled to ~2 s).
  //
  // So: flap the basis to wipe the freeze, then let the candle run while the
  // spec's current price stays where it was. Every 1 s sweep now recomputes
  // against a close that has moved and a current that has not — and the
  // entry line walks up the chart after the candle.
  const env = runBridge();
  env.tickBar(240_000);
  env.send('paper-lines', linesSpec('mcap', 0.001));
  const first = drawnBuyLevel(env);
  assert.ok(Math.abs(first - 240_000) < 1, 'entry drawn at its cap');

  // The classifier flips (same axis, same entry — a misclassification).
  env.send('paper-lines', linesSpec('native-mcap', 0.001));
  // Now the market runs 60% while no fresh spec arrives.
  env.tickBar(384_000);
  runSweeps(env);

  assert.ok(Math.abs(drawnBuyLevel(env) - first) < 1,
    `entry must hold at ${first}, not ride the candle (drew ${drawnBuyLevel(env)})`);
});

test('a REAL unit switch still re-projects the level into the new unit', () => {
  // The freeze must not become a straitjacket: flipping the chart from market
  // cap to native price genuinely changes what the axis number means, and the
  // line has to follow. 0.001 SOL on a native axis is 0.001 — not 240,000.
  const env = runBridge();
  env.tickBar(240_000);
  env.send('paper-lines', linesSpec('mcap', 0.001));
  assert.equal(drawnBuyLevel(env), 240_000, 'mcap axis: the entry is drawn as a cap');

  env.send('paper-lines', linesSpec('native', 0.001));
  assert.equal(drawnBuyLevel(env), 0.001,
    'native axis: the same entry, expressed in the axis unit now in force');
});

test('a genuinely new average DOES move the line', () => {
  // A DCA changes the entry, and the line must move to the new one — the
  // freeze protects a constant, it does not ignore new facts.
  const env = runBridge();
  env.tickBar(240_000);
  env.send('paper-lines', linesSpec('mcap', 0.001));
  const first = drawnBuyLevel(env);

  const dca = { ...linesSpec('mcap', 0.001), avgBuyNative: 0.0015, avgBuyUsd: 0.36 };
  env.send('paper-lines', dca);

  assert.notEqual(drawnBuyLevel(env), first, 'a new average is a new level');
  assert.equal(drawnBuyLevel(env), 360_000, 'and it is the level the new average implies');
});

/* ---------------------------------------------------------------------------
 * F-43 — the ordering that actually reproduces the field report.
 *
 * The tests above post the flapped spec BEFORE the candle moves, so the level
 * is (re)frozen while the close is still where it started and the walk cannot
 * show itself — they pass with the freeze mechanism disabled entirely, which
 * is to say they never exercised it.
 *
 * In the field the order is the other way round: the chart ticks continuously
 * while the content script's re-post is throttled to ~2 s, so the repost that
 * carries the flapped classification LANDS AFTER the close has already moved.
 * That is the sequence that teleports.
 * ------------------------------------------------------------------------ */

test('F-43: a flapped repost landing AFTER the candle moved must not teleport the entry', () => {
  const env = runBridge();
  env.tickBar(240_000);
  env.send('paper-lines', linesSpec('mcap', 0.001));
  const first = drawnBuyLevel(env);
  assert.ok(Math.abs(first - 240_000) < 1, 'entry drawn at its cap');

  // The market runs 60% while the re-post is still throttled.
  env.tickBar(384_000);
  // Now the throttled re-post lands: same position, same averages, same stale
  // current price — only the band classifier flipped.
  env.send('paper-lines', linesSpec('native-mcap', 0.001));
  runSweeps(env);

  assert.ok(Math.abs(drawnBuyLevel(env) - first) < 1,
    `entry must hold at ${first}, not ride the candle (drew ${drawnBuyLevel(env)})`);
});

test('F-43: the flap does not teleport the entry back the other way either', () => {
  const env = runBridge();
  env.tickBar(240_000);
  env.send('paper-lines', linesSpec('native-mcap', 0.001));
  const first = drawnBuyLevel(env);

  env.tickBar(384_000);
  env.send('paper-lines', linesSpec('mcap', 0.001));
  runSweeps(env);

  assert.ok(Math.abs(drawnBuyLevel(env) - first) < 1,
    `entry must hold at ${first} (drew ${drawnBuyLevel(env)})`);
});

test('F-43: a REAL unit switch after the candle moved still re-projects', () => {
  // The guard must not swallow genuine unit changes. Crossing out of the cap
  // family into an explicit price axis is a real switch, and its branch reads
  // the recorded average directly — so it is both correct and stale-proof.
  const env = runBridge();
  env.tickBar(240_000);
  env.send('paper-lines', linesSpec('mcap', 0.001));
  assert.equal(drawnBuyLevel(env), 240_000, 'mcap axis: drawn as a cap');

  env.tickBar(384_000);
  env.send('paper-lines', linesSpec('native', 0.001));
  runSweeps(env);

  assert.equal(drawnBuyLevel(env), 0.001,
    'native axis: the same entry in the unit now in force, not a held cap');
});

test('F-43: a DCA across a flap still moves the line to the new average', () => {
  // sameAverages remains the thing that decides whether a level may move; the
  // basis-family guard only stops a RECLASSIFICATION from counting as news.
  const env = runBridge();
  env.tickBar(240_000);
  env.send('paper-lines', linesSpec('mcap', 0.001));
  const first = drawnBuyLevel(env);

  env.tickBar(384_000);
  const dca = { ...linesSpec('native-mcap', 0.001), avgBuyNative: 0.0015, avgBuyUsd: 0.36 };
  env.send('paper-lines', dca);
  runSweeps(env);

  assert.notEqual(drawnBuyLevel(env), first, 'a new average is still a new level');
});
