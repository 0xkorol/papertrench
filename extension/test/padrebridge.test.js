/* Padre-specific MAIN-world integration.
 *
 * Padre's production app exposes TradingView as window.tvWidget. These tests
 * drive the shipped price-bridge.js against a faithful fake of the two APIs we
 * rely on: datafeed.subscribeBars for decoded live bars, datafeed.getMarks /
 * activeChart().refreshMarks() for native chart bubbles, and createOrderLine()
 * for Padre-style average fill and exit lines.
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
  let realtimeCallback = null;
  let clearMarksCount = 0;
  let refreshMarksCount = 0;
  const orderLines = [];

  function makeOrderLine() {
    const line = { removed: false, values: {}, calls: [] };
    const methods = [
      'setText', 'setQuantity', 'setLineColor', 'setLineStyle', 'setLineWidth',
      'setPrice', 'setBodyFont', 'setBodyTextColor', 'setBodyBorderColor',
      'setBodyBackgroundColor', 'setEditable',
    ];
    for (const method of methods) {
      line[method] = function (value) {
        this.values[method] = value;
        this.calls.push([method, value]);
        return this;
      };
    }
    line.remove = function () { this.removed = true; return this; };
    orderLines.push(line);
    return line;
  }

  const datafeed = {
    subscribeBars(symbolInfo, resolution, callback) {
      realtimeCallback = callback;
    },
    getMarks(symbolInfo, from, to, callback) {
      callback([{ id: 'padre-site-mark', time: from + 1, label: 'M' }]);
    },
  };
  const chart = {
    clearMarks() { clearMarksCount += 1; },
    refreshMarks() { refreshMarksCount += 1; },
    createOrderLine: makeOrderLine,
  };

  function FakeWebSocket() {}
  FakeWebSocket.prototype.addEventListener = () => {};
  FakeWebSocket.CONNECTING = 0;
  FakeWebSocket.OPEN = 1;
  FakeWebSocket.CLOSING = 2;
  FakeWebSocket.CLOSED = 3;

  function FakeXHR() {}
  FakeXHR.prototype.send = function () {};
  FakeXHR.prototype.addEventListener = function () {};

  const win = {
    tvWidget: {
      _options: { datafeed },
      activeChart: () => chart,
    },
    fetch: () => Promise.resolve({
      headers: { get: () => 'application/json' },
      clone: () => ({ text: () => Promise.resolve('{}') }),
    }),
    XMLHttpRequest: FakeXHR,
    WebSocket: FakeWebSocket,
    EventSource: undefined,
    addEventListener(type, fn) { listeners[type] = fn; },
    postMessage(message) { emitted.push(message); },
  };
  win.window = win;

  const sandbox = {
    window: win,
    location: { href: 'https://trade.padre.gg/trade/Mint1' },
    console,
    Date,
    Math,
    Number,
    String,
    Array,
    Object,
    Boolean,
    RegExp,
    Error,
    Set,
    WeakSet,
    Symbol,
    JSON,
    Promise,
    isFinite,
    setInterval(fn, ms) { timers.push(fn); return timers.length; },
    clearInterval() {},
    setTimeout(fn) { fn(); return 1; },
  };

  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'price-bridge.js'), 'utf8'), ctx, {
    filename: 'price-bridge.js',
  });
  // Run the startup hook after evaluation, like a real interval task.
  for (const fn of timers.slice()) fn();

  return {
    datafeed,
    emitted,
    listeners,
    chart,
    realtime: () => realtimeCallback,
    clearMarksCount: () => clearMarksCount,
    refreshMarksCount: () => refreshMarksCount,
    orderLines,
    win,
  };
}

test('Padre decoded TradingView bars emit an immediate PaperTrench tick', () => {
  const env = runBridge();
  let delivered = null;

  env.datafeed.subscribeBars({}, '15S', (bar) => { delivered = bar; }, 'sub-1', () => {});
  assert.equal(typeof env.realtime(), 'function', 'bridge must wrap subscribeBars before subscription');

  const bar = { time: 1_700_000_000_000, close: 12_345_678 };
  env.realtime()(bar);

  assert.equal(delivered, bar, 'Padre must still receive its original callback unchanged');
  const message = env.emitted.find((m) => m.type === 'tick' && m.payload?.source === 'padre-chart-bar');
  assert.ok(message, 'decoded chart bar must be forwarded immediately');
  assert.equal(message.payload.candidates[0].value, bar.close);
  assert.equal(message.payload.mcap, bar.close,
    'the unknown chart close is offered as mcap so quote validation can identify chart mode');
});

test('paper buys are merged into Padre native getMarks with hover details', () => {
  const env = runBridge();
  const ts = Date.now();

  env.listeners.message({
    source: env.win,
    data: {
      source: 'papertrench-content',
      type: 'paper-marker',
      payload: {
        ts,
        side: 'buy',
        priceNative: 0.00001234,
        solAmount: 0.5,
        symbol: 'TEST',
      },
    },
  });

  assert.ok(env.clearMarksCount() >= 1, 'adding a marker must clear TradingView mark cache');
  assert.ok(env.refreshMarksCount() >= 1, 'adding a marker must refresh native chart marks');

  let marks = null;
  env.datafeed.getMarks({}, Math.floor(ts / 1000) - 60, Math.floor(ts / 1000) + 60, (result) => {
    marks = result;
  });

  assert.ok(Array.isArray(marks));
  assert.ok(marks.some((m) => m.id === 'padre-site-mark'), 'Padre marks must be preserved');
  const paper = marks.find((m) => String(m.id).startsWith('papertrench-buy-'));
  assert.ok(paper, 'paper buy must be returned through Padre getMarks');
  assert.equal(paper.label, 'B');
  assert.match(paper.text, /Buy \(Paper\)/);
  assert.match(paper.text, /0\.5000 SOL/);
  assert.match(paper.text, /TEST/);
  assert.deepEqual(JSON.parse(JSON.stringify(paper.color)), {
    background: '#17C671',
    border: '#17C671',
  });
});

test('paper sells use Padre native red S marks', () => {
  const env = runBridge();
  const ts = Date.now();

  env.listeners.message({
    source: env.win,
    data: {
      source: 'papertrench-content',
      type: 'paper-marker',
      payload: {
        ts,
        side: 'sell',
        priceNative: 0.00002,
        solAmount: 0.75,
        symbol: 'TEST',
      },
    },
  });

  let marks = null;
  env.datafeed.getMarks({}, Math.floor(ts / 1000) - 1, Math.floor(ts / 1000) + 1, (result) => {
    marks = result;
  });
  const paper = marks.find((m) => String(m.id).startsWith('papertrench-sell-'));
  assert.ok(paper);
  assert.equal(paper.label, 'S');
  assert.match(paper.text, /Sell \(Paper\)/);
  assert.equal(paper.color.background, '#E73A44');
});

test('average paper fills use Padre native order-line styling exactly', () => {
  const env = runBridge();

  env.listeners.message({
    source: env.win,
    data: {
      source: 'papertrench-content',
      type: 'paper-lines',
      payload: { enabled: true, avgBuyUsd: 0.00042, avgSellUsd: 0.00069 },
    },
  });

  assert.equal(env.orderLines.length, 2, 'fill and exit must each create one native line');
  const [fill, exit] = env.orderLines;

  assert.equal(fill.values.setText, 'Avg. Fill Price');
  assert.equal(fill.values.setPrice, 0.00042);
  assert.equal(fill.values.setLineColor, '#90A8FA99');
  assert.equal(fill.values.setLineStyle, 2);
  assert.equal(fill.values.setLineWidth, 1);
  assert.equal(fill.values.setQuantity, '');
  assert.equal(fill.values.setBodyFont, '11px Inter, sans-serif');
  assert.equal(fill.values.setBodyTextColor, '#90A8FA99');
  assert.equal(fill.values.setBodyBorderColor, '#FFFFFF00');
  assert.equal(fill.values.setBodyBackgroundColor, '#FFFFFF00');
  assert.equal(fill.values.setEditable, false);

  assert.equal(exit.values.setText, 'Avg. Exit Price');
  assert.equal(exit.values.setPrice, 0.00069);
  assert.equal(exit.values.setLineColor, '#F7DC8599');
});

test('average lines update in place and are removed when disabled', () => {
  const env = runBridge();
  const send = (type, payload) => env.listeners.message({
    source: env.win,
    data: { source: 'papertrench-content', type, payload },
  });

  send('paper-lines', { enabled: true, avgBuyUsd: 1, avgSellUsd: 2 });
  const [fill, exit] = env.orderLines;
  send('paper-lines', { enabled: true, avgBuyUsd: 1.5, avgSellUsd: null });

  assert.equal(env.orderLines.length, 2, 'updating must not create duplicate lines');
  assert.equal(fill.values.setPrice, 1.5, 'average fill line must update in place');
  assert.equal(fill.removed, false);
  assert.equal(exit.removed, true, 'missing exit average must remove only the exit line');

  send('paper-lines-clear');
  assert.equal(fill.removed, true, 'disabling must remove the remaining native line');
});
