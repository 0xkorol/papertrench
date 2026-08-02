/* Native chart integration for the sites that broke in production.
 *
 * Three verified-on-site failure modes are locked down here:
 *
 *  1. GMGN upgraded its TradingView build to the ASYNC widget API:
 *     createOrderLine() / createExecutionShape() return Promises. The bridge
 *     must tolerate both the sync and async shapes, or every native line and
 *     fill bubble dies in a swallowed TypeError.
 *
 *  2. Axiom publishes NO window global for its TradingView widget — instances
 *     live in React fiber refs. Discovery must walk the fiber tree from the
 *     standard `tradingview_*` iframe, then patch subscribeBars/getMarks.
 *
 *  3. GMGN's realtime WebSocket announces every trade on `token_activity`
 *     with terse keys (`a` mint, `pu` USD price) that the generic collector
 *     cannot see; the bridge must translate them into mint-tagged USD ticks.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function microtasks(n = 4) {
  let p = Promise.resolve();
  for (let i = 0; i < n; i++) p = p.then(() => {});
  return p;
}

function makeAsyncAdapter(record) {
  const adapter = { removed: false, values: {}, calls: [] };
  const methods = [
    'setText', 'setQuantity', 'setLineColor', 'setLineStyle', 'setLineWidth',
    'setPrice', 'setBodyFont', 'setBodyTextColor', 'setBodyBorderColor',
    'setBodyBackgroundColor', 'setEditable', 'setTextColor', 'setArrowColor',
    'setDirection', 'setTime',
  ];
  for (const method of methods) {
    adapter[method] = function (value) {
      this.values[method] = value;
      this.calls.push([method, value]);
      return this;
    };
  }
  adapter.remove = function () { this.removed = true; return this; };
  record.push(adapter);
  return adapter;
}

/**
 * Boot the shipped price-bridge.js inside a sandbox that mimics the parts of
 * GMGN and Axiom the bridge touches. Everything is opt-in via `opts`.
 */
function runBridge(opts = {}) {
  const timers = [];
  const emitted = [];
  const listeners = {};
  const orderLines = [];
  const execShapes = [];

  // ---- GMGN chart manager behind a React fiber on #global-tv-overlay ----
  const gmgnChart = {
    createOrderLine: () => Promise.resolve(makeAsyncAdapter(orderLines)),
    createExecutionShape: () => Promise.resolve(makeAsyncAdapter(execShapes)),
  };
  let gmgnMounted = Boolean(opts.gmgnMounted);
  const gmgnHost = {};
  Object.defineProperty(gmgnHost, '__reactFiber$test', {
    value: {
      return: null,
      child: null,
      sibling: null,
      memoizedState: {
        memoizedState: {
          current: {
            widgetSubject: {},
            activeChartSubject: {},
            chartsSubject: {},
            getActiveChart: () => gmgnChart,
          },
        },
        next: null,
      },
    },
    enumerable: true,
  });

  // ---- Axiom widgets behind fiber refs near the tradingview iframe ----
  // Axiom keeps a visible chart AND a broken preload chart ("UNKNOWN-..."
  // symbol; every draw call throws "Value is null"). The bridge must rank
  // the real chart first and never die on the preload.
  let axiomRealtime = null;
  let axiomGetMarksCalls = 0;
  let exportRows = opts.exportRows || null; // [[time, o, h, l, close], ...]
  const AXIOM_PAIR = 'H6NXABY6J8MKD2HOMS71R7K3FY9DGVFBQHJYUXZN2S2R';
  const axiomDatafeed = {
    subscribeBars(symbolInfo, resolution, callback) { axiomRealtime = callback; },
    getMarks(symbolInfo, from, to, callback) {
      axiomGetMarksCalls += 1;
      callback([]);
    },
  };
  const axiomChart = {
    clearMarks() {},
    refreshMarks() {},
    symbol: () => `${AXIOM_PAIR}-USD-123`,
    createOrderLine: () => Promise.resolve(makeAsyncAdapter(orderLines)),
    createExecutionShape: () => Promise.resolve(makeAsyncAdapter(execShapes)),
    exportData: () => Promise.resolve({
      schema: ['time', 'open', 'high', 'low', 'close'],
      data: exportRows || [],
    }),
  };
  // The preload chart: normally a seriesless shell, but Axiom also preloads
  // charts for OTHER tokens — a real symbol and working API, wrong token.
  let preloadRealtime = null;
  const preloadLines = [];
  const preloadExportRows = opts.preloadExportRows || [];
  const preloadDatafeed = {
    subscribeBars(symbolInfo, resolution, callback) { preloadRealtime = callback; },
    getMarks(symbolInfo, from, to, callback) { callback([]); },
  };
  const preloadChart = opts.wrongTokenPreload
    ? {
        clearMarks() {},
        refreshMarks() {},
        symbol: () => 'ZZZWRONGTOKEN999-USD-1',
        createOrderLine: () => Promise.resolve(makeAsyncAdapter(preloadLines)),
        createExecutionShape: () => { throw new Error('Value is null'); },
        exportData: () => Promise.resolve({ schema: ['time', 'open', 'high', 'low', 'close'], data: preloadExportRows }),
      }
    : {
        clearMarks() {},
        refreshMarks() {},
        symbol: () => 'UNKNOWN-USD-999',
        createOrderLine: () => { throw new Error('Value is null'); },
        createExecutionShape: () => { throw new Error('Value is null'); },
        exportData: () => Promise.resolve({ schema: ['time', 'open', 'high', 'low', 'close'], data: [] }),
      };
  const axiomWidget = opts.swapAccessors
    ? {
        // Some TradingView widgets expose a seriesless shell through
        // activeChart() while chart() carries the real series (Axiom's own
        // drawing code uses chart() exclusively).
        _options: { datafeed: axiomDatafeed },
        activeChart: () => preloadChart,
        chart: () => axiomChart,
        onChartReady: () => {},
      }
    : {
        _options: { datafeed: axiomDatafeed },
        activeChart: () => axiomChart,
        onChartReady: () => {},
      };
  const preloadWidget = {
    _options: { datafeed: preloadDatafeed },
    activeChart: () => preloadChart,
    onChartReady: () => {},
  };
  const axiomParent = {};
  Object.defineProperty(axiomParent, '__reactFiber$ax', {
    value: {
      return: null,
      child: null,
      sibling: null,
      memoizedState: {
        // The PRELOAD widget is deliberately encountered FIRST so ranking,
        // not discovery order, decides which chart gets drawn on.
        memoizedState: { current: preloadWidget },
        next: {
          memoizedState: { current: axiomWidget },
          next: null,
        },
      },
    },
    enumerable: true,
  });
  const axiomIframe = { id: 'tradingview_ab12', parentElement: axiomParent, contentWindow: null };

  const doc = {
    getElementById: (id) => (id === 'global-tv-overlay' && gmgnMounted ? gmgnHost : null),
    querySelector: (sel) => (opts.axiom && String(sel).includes('iframe[id^="tradingview_"]') ? axiomIframe : null),
    querySelectorAll: (sel) => (opts.axiom && String(sel).includes('iframe[id^="tradingview_"]') ? [axiomIframe] : []),
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
    fetch: () => Promise.resolve({
      url: '', headers: { get: () => 'application/json' },
      clone: () => ({ text: () => Promise.resolve('{}') }),
    }),
    XMLHttpRequest: FakeXHR,
    WebSocket: FakeWebSocket,
    SharedWorker: undefined,
    EventSource: undefined,
    addEventListener(type, fn) { listeners[type] = fn; },
    postMessage(message) { emitted.push(message); },
  };
  win.window = win;

  // Timeouts are collected, not executed: the bridge's retry loops would
  // recurse unboundedly under a synchronous fake. Tests advance them with
  // env.runTimeouts().
  const timeouts = new Map();
  let timeoutSeq = 0;

  const href = opts.href || 'https://gmgn.ai/sol/token/Mint1';
  const sandbox = {
    window: win,
    document: doc,
    location: { href, hostname: new URL(href).hostname },
    console, Date, Math, Number, String, Array, Object, Boolean, RegExp,
    Error, Set, WeakSet, WeakMap, Map, Symbol, JSON, Promise, isFinite,
    setInterval(fn) { timers.push(fn); return timers.length; },
    clearInterval() {},
    setTimeout(fn) { timeouts.set(++timeoutSeq, fn); return timeoutSeq; },
    clearTimeout(id) { timeouts.delete(id); },
  };

  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'price-bridge.js'), 'utf8'), ctx, {
    filename: 'price-bridge.js',
  });

  return {
    emitted,
    listeners,
    orderLines,
    execShapes,
    win,
    timers,
    mountGmgn: () => { gmgnMounted = true; },
    axiomRealtime: () => axiomRealtime,
    axiomGetMarksCalls: () => axiomGetMarksCalls,
    axiomDatafeed,
    preloadDatafeed,
    preloadRealtime: () => preloadRealtime,
    preloadLines,
    AXIOM_PAIR,
    setExportRows: (rows) => { exportRows = rows; },
    send(type, payload) {
      listeners.message({
        source: win,
        data: { source: 'papertrench-content', type, payload },
      });
    },
    runTimers() { for (const fn of timers.slice()) fn(); },
    runTimeouts() {
      const pending = [...timeouts.values()];
      timeouts.clear();
      for (const fn of pending) fn();
    },
  };
}

/* ------------------------------------------------------------------ *
 * 1. GMGN async TradingView API
 * ------------------------------------------------------------------ */

test('GMGN average lines survive the async createOrderLine API', async () => {
  const env = runBridge({ gmgnMounted: true });

  env.send('gmgn-lines', {
    enabled: true,
    avgBuyMcap: 250_000_000,
    avgSellMcap: 300_000_000,
    avgBuyText: 'PT Avg Buy $250M',
    avgSellText: 'PT Avg Sell $300M',
  });
  await microtasks();

  assert.equal(env.orderLines.length, 2, 'both average lines must be created');
  const buy = env.orderLines.find((l) => l.values.setPrice === 250_000_000);
  const sell = env.orderLines.find((l) => l.values.setPrice === 300_000_000);
  assert.ok(buy, 'buy line must sit at the buy market cap');
  assert.ok(sell, 'sell line must sit at the sell market cap');
  assert.equal(buy.values.setText, 'PT Avg Buy $250M');
  assert.equal(buy.removed, false);
});

test('GMGN fill markers survive the async createExecutionShape API', async () => {
  const env = runBridge({ gmgnMounted: true });
  const ts = Date.now();

  env.send('gmgn-marker', { ts, mcap: 250_000_000, side: 'buy', text: 'PT Buy $250M' });
  await microtasks();

  assert.equal(env.execShapes.length, 1, 'the fill must be drawn as an execution shape');
  const shape = env.execShapes[0];
  assert.equal(shape.values.setPrice, 250_000_000);
  assert.equal(shape.values.setDirection, 'buy');
  assert.equal(shape.values.setTime, Math.floor(ts / 1000));
  assert.equal(shape.values.setText, 'PT Buy $250M');
  assert.equal(shape.removed, false);
});

test('GMGN markers queued before the chart mounts are drawn once it appears', async () => {
  const env = runBridge({ gmgnMounted: false });
  const ts = Date.now();

  // Journal restore fires before GMGN's chart manager exists.
  env.send('gmgn-marker', { ts, mcap: 100_000_000, side: 'sell', text: 'PT Sell $100M' });
  await microtasks();
  assert.equal(env.execShapes.length, 0, 'no chart yet, nothing to draw');

  env.mountGmgn();
  env.runTimeouts(); // the pending drain retry fires once the chart exists
  await microtasks();

  assert.equal(env.execShapes.length, 1, 'the queued fill must be drawn after mount');
  assert.equal(env.execShapes[0].values.setDirection, 'sell');
});

test('clearing GMGN markers also cancels shapes still being created', async () => {
  const env = runBridge({ gmgnMounted: true });
  env.send('gmgn-marker', { ts: Date.now(), mcap: 100_000_000, side: 'buy' });
  env.send('gmgn-marker-clear', null);
  await microtasks();
  // The shape may resolve after the clear; it must remove itself.
  assert.ok(env.execShapes.every((s) => s.removed), 'late-resolving shapes must self-remove');
});

/* ------------------------------------------------------------------ *
 * 2. Axiom fiber widget discovery
 * ------------------------------------------------------------------ */

test('the Axiom widget is discovered through React fibers and its bars are hooked', () => {
  const env = runBridge({ axiom: true, gmgnMounted: false, href: 'https://axiom.trade/meme/Pair1' });
  env.runTimers();

  assert.equal(typeof env.axiomDatafeed.subscribeBars, 'function');
  // The patch marks itself; subscribing must reach our wrapper.
  let delivered = null;
  env.axiomDatafeed.subscribeBars({}, '1S', (bar) => { delivered = bar; }, 'sub', () => {});
  assert.equal(typeof env.axiomRealtime(), 'function', 'subscribeBars must be wrapped via fiber discovery');

  const bar = { time: 1_700_000_000_000, close: 0.0000042 };
  env.axiomRealtime()(bar);
  assert.equal(delivered, bar, 'Axiom must still receive its own callback');
  const tick = env.emitted.find((m) => m.type === 'tick' && m.payload?.source === 'padre-chart-bar');
  assert.ok(tick, 'Axiom chart bars must emit live ticks');
});

test('fiber-discovered datafeeds serve paper fills through getMarks on non-forced hosts', () => {
  const env = runBridge({ axiom: true, href: 'https://trade.padre.gg/trade/Mint1' });
  env.runTimers();
  const ts = Date.now();

  env.send('paper-marker', {
    ts, side: 'buy', priceNative: 0.00001, priceUsd: 0.0021, mcap: 2_100_000, solAmount: 0.5, symbol: 'AX',
  });

  let marks = null;
  env.axiomDatafeed.getMarks({}, Math.floor(ts / 1000) - 60, Math.floor(ts / 1000) + 60, (r) => { marks = r; });
  assert.ok(Array.isArray(marks));
  assert.ok(marks.some((m) => String(m.id).startsWith('papertrench-buy-')),
    'the paper fill must be served through the fiber-discovered datafeed');
});

test('fills fall back to execution shapes when the site never pulls marks', async () => {
  const env = runBridge({ axiom: true, href: 'https://trade.padre.gg/trade/Mint1' });
  env.runTimers();
  const ts = Date.now();

  // Feed a live bar first so the fallback knows the chart's Y-axis unit
  // (this chart plots market cap).
  env.axiomDatafeed.subscribeBars({}, '1S', () => {}, 'sub', () => {});
  env.axiomRealtime()({ time: ts, close: 2_000_000 });

  env.send('paper-marker', {
    ts, side: 'buy', priceNative: 0.00001, priceUsd: 0.0021, mcap: 2_100_000, solAmount: 0.5, symbol: 'AX',
  });
  // Let the fallback check fire; the site's getMarks was never invoked by the
  // library itself, so the pipeline counts as dead.
  env.runTimeouts();
  await microtasks();

  const shape = env.execShapes.find((s) => s.values.setDirection === 'buy');
  assert.ok(shape, 'with a dead marks pipeline the fill must be drawn as an execution shape');
  assert.equal(shape.values.setPrice, 2_100_000,
    'the shape must sit on the market-cap axis the chart actually displays');
});

test('the shape fallback yields back to native marks when the pipeline revives', async () => {
  const env = runBridge({ axiom: true, href: 'https://trade.padre.gg/trade/Mint1' });
  env.runTimers();
  const ts = Date.now();

  env.send('paper-marker', {
    ts, side: 'buy', priceNative: 0.00001, priceUsd: 0.0021, mcap: 2_100_000, solAmount: 0.5, symbol: 'AX',
  });
  env.runTimeouts(); // fallback check fires, shapes get drawn
  await microtasks();

  // The library starts pulling marks after all (slow boot, not a dead pipeline).
  let marks = null;
  env.axiomDatafeed.getMarks({}, Math.floor(ts / 1000) - 60, Math.floor(ts / 1000) + 60, (r) => { marks = r; });
  await microtasks();

  assert.ok(marks.some((m) => String(m.id).startsWith('papertrench-buy-')),
    'native marks must serve the fill once the pipeline runs');
  assert.ok(env.execShapes.every((s) => s.removed),
    'fallback shapes must be removed so the fill is not drawn twice');
});

test('on Axiom, paper buys render as its native tracked-wallet bubbles', async () => {
  // Contract from Axiom's own bundle (settings atoms): user/tracked trades
  // are TradingView marks — B/S label on a colored circle (default user
  // colors #089981 buy / #f23645 sell, size 25) with "You bought $X at $Y
  // Market Cap" hover text, time snapped to the bar grid. Paper fills must be
  // indistinguishable, and must NOT double as execution shapes while the
  // marks pipeline is alive.
  const env = runBridge({ axiom: true, href: 'https://axiom.trade/meme/Pair1' });
  env.runTimers();
  // Simulate the chart subscribing at 1-minute so times snap to the grid.
  env.axiomDatafeed.subscribeBars({}, '1', () => {}, 'sub', () => {});
  const ts = Date.now();

  env.send('paper-marker', {
    ts, side: 'buy', priceNative: 0.00001, priceUsd: 0.0021, mcap: 2_100_000, solAmount: 0.5, symbol: 'AX',
  });
  await microtasks();
  assert.equal(env.execShapes.length, 0, 'with a live marks pipeline there must be no shape fallback');

  let marks = null;
  env.axiomDatafeed.getMarks({}, Math.floor(ts / 1000) - 120, Math.floor(ts / 1000) + 120, (r) => { marks = r; });
  const mark = marks.find((m) => String(m.id).startsWith('papertrench-buy-'));
  assert.ok(mark, 'the fill must be served through the marks pipeline');
  assert.equal(mark.label, 'B');
  assert.equal(mark.labelFontColor, 'white');
  assert.equal(mark.minSize, 25, 'must match the default userBubbleSize');
  assert.equal(mark.color.background, '#089981', 'must match userBuyBubbleColor');
  assert.equal(mark.color.border, '#08998180');
  assert.match(mark.text, /^You bought \$105\.00 at \$2\.10M Market Cap \(Paper\)$/,
    'hover text must read like Axiom prints its own trade bubbles');
  assert.equal(mark.time, Math.floor(ts / 60000) * 60, 'mark time must snap to the 1-minute bar grid');
});

test('on Axiom, paper sells use the native red sell bubble', () => {
  const env = runBridge({ axiom: true, href: 'https://axiom.trade/meme/Pair1' });
  env.runTimers();
  const ts = Date.now();

  env.send('paper-marker', {
    ts, side: 'sell', priceNative: 0.00002, priceUsd: 0.004, mcap: 4_000_000, solAmount: 0.25, symbol: 'AX',
  });

  let marks = null;
  env.axiomDatafeed.getMarks({}, Math.floor(ts / 1000) - 120, Math.floor(ts / 1000) + 120, (r) => { marks = r; });
  const mark = marks.find((m) => String(m.id).startsWith('papertrench-sell-'));
  assert.ok(mark);
  assert.equal(mark.label, 'S');
  assert.equal(mark.color.background, '#f23645', 'must match userSellBubbleColor');
  assert.match(mark.text, /^You sold \$50\.00 at \$4\.00M Market Cap \(Paper\)$/);
});

test('average fill lines follow a SOL-denominated chart axis', async () => {
  // Axiom's USD/SOL toggle makes the chart plot the token in SOL. The line
  // candidates span USD price, USD market cap, SOL price and SOL market cap;
  // the SOL bar close must select the SOL fill price.
  const env = runBridge({ axiom: true, href: 'https://axiom.trade/meme/Pair1' });
  env.runTimers();
  env.axiomDatafeed.subscribeBars({}, '1', () => {}, 'sub', () => {});
  env.axiomRealtime()({ time: Date.now(), close: 8.2e-8 }); // SOL-mode chart

  env.send('paper-lines', {
    enabled: true,
    avgBuyUsd: 1.72e-5, avgBuyMcap: 17_200,
    avgBuyNative: 8e-8, avgBuyMcapNative: 80,
  });
  await microtasks();

  const line = env.orderLines.find((l) => l.values.setPrice !== undefined);
  assert.ok(line, 'the fill line must be created');
  assert.equal(line.values.setPrice, 8e-8,
    'on a SOL chart the average fill line must sit at the SOL fill price, not ~215x away at the USD one');
});

test('Axiom hover text prints SOL when the chart axis is SOL-denominated', () => {
  const env = runBridge({ axiom: true, href: 'https://axiom.trade/meme/Pair1' });
  env.runTimers();
  env.axiomDatafeed.subscribeBars({}, '1', () => {}, 'sub', () => {});
  env.axiomRealtime()({ time: Date.now(), close: 8.2e-8 });

  const ts = Date.now();
  env.send('paper-marker', {
    ts, side: 'buy', priceNative: 8e-8, priceUsd: 1.72e-5, mcap: 17_200, solAmount: 0.5, symbol: 'AX',
  });

  let marks = null;
  env.axiomDatafeed.getMarks({}, Math.floor(ts / 1000) - 120, Math.floor(ts / 1000) + 120, (r) => { marks = r; });
  const mark = marks.find((m) => String(m.id).startsWith('papertrench-buy-'));
  assert.ok(mark);
  assert.match(mark.text, /^You bought \$107\.50 at 0\.00000008 SOL \(Paper\)$/,
    'the hover price must be in the units the chart is displaying');
});

test('on Axiom, a dead marks pipeline still falls back to execution shapes', async () => {
  const env = runBridge({ axiom: true, href: 'https://axiom.trade/meme/Pair1' });
  env.runTimers();
  const ts = Date.now();

  env.send('paper-marker', {
    ts, side: 'buy', priceNative: 0.00001, priceUsd: 0.0021, mcap: 2_100_000, solAmount: 0.5, symbol: 'AX',
  });
  env.runTimeouts(); // fallback check fires; the harness's fake library never pulls marks
  await microtasks();

  assert.ok(env.execShapes.some((s) => s.values.setDirection === 'buy'),
    'if TradingView never requests marks the fill must still appear as a shape');
});

test('lines fall back to widget.chart() when activeChart() is a seriesless shell', async () => {
  // Axiom's own line-drawing code calls widget.chart(), not activeChart() —
  // on a multi-chart widget the "active" chart can refuse every draw call.
  const env = runBridge({ axiom: true, swapAccessors: true, href: 'https://axiom.trade/meme/Pair1' });
  env.runTimers();

  env.send('paper-lines', { enabled: true, avgBuyUsd: 0.0021, avgBuyMcap: 2_100_000 });
  await microtasks();

  const line = env.orderLines.find((l) => l.values.setPrice !== undefined);
  assert.ok(line, 'the average line must be created through the working chart accessor');
  assert.equal(line.removed, false);
});

test('lines and shapes land on the real chart, never the broken preload chart', async () => {
  const env = runBridge({ axiom: true, href: 'https://axiom.trade/meme/Pair1' });
  env.runTimers();

  env.send('paper-lines', { enabled: true, avgBuyUsd: 0.0021, avgSellUsd: null });
  await microtasks();

  // The preload chart throws on createOrderLine; the ranked selection must
  // have routed the line to the chart with a real symbol.
  const line = env.orderLines.find((l) => l.values.setPrice === 0.0021);
  assert.ok(line, 'the average line must be created on the usable chart');
  assert.equal(line.removed, false);
});

/* ------------------------------------------------------------------ *
 * 2b. Chart-export price peg
 * ------------------------------------------------------------------ */

test('an explicit axis basis from the chart ticks wins over magnitude guessing', async () => {
  // Once a live chart tick validates, the content script knows whether the
  // chart plots price or market cap in USD or SOL — the line must use that,
  // even when the bar close would be ambiguous.
  const env = runBridge({ axiom: true, href: 'https://axiom.trade/meme/Pair1' });
  env.runTimers();

  env.send('paper-lines', {
    enabled: true,
    axisBasis: 'native-mcap',
    avgBuyUsd: 1.72e-5, avgBuyMcap: 17_200,
    avgBuyNative: 8e-8, avgBuyMcapNative: 80,
  });
  await microtasks();

  const line = env.orderLines.find((l) => l.values.setPrice !== undefined);
  assert.ok(line, 'the line must be created');
  assert.equal(line.values.setPrice, 80, 'the SOL market-cap candidate must win when the chart is SOL-MC');
});

test('ticks and lines ignore a preload chart showing a DIFFERENT token', async () => {
  // On a busy Axiom session the second widget preloads the previously viewed
  // token. Its closes must never become our ticks, and lines must never land
  // on it — that was the mechanism behind wrong P&L and misplaced avg lines.
  const now = Math.floor(Date.now() / 1000);
  const env = runBridge({
    axiom: true,
    wrongTokenPreload: true,
    href: 'https://axiom.trade/meme/Pair1',
    exportRows: [new Float64Array([now - 1, 1, 2, 0.5, 2_000_000])],
    preloadExportRows: [new Float64Array([now - 1, 1, 2, 0.5, 999_999_999])],
  });

  // The content script tells the bridge which address this page is about.
  env.send('paper-axis', { pairAddress: env.AXIOM_PAIR, mint: null });
  env.runTimers();
  await microtasks(8);

  const exportTicks = env.emitted.filter((m) => m.type === 'tick' && m.payload?.source === 'chart-export');
  assert.ok(exportTicks.length >= 1, 'the matching chart still exports');
  assert.ok(
    exportTicks.every((m) => m.payload.candidates[0].value === 2_000_000),
    'no tick may carry the wrong-token chart close'
  );

  // Bars from the wrong chart's subscription must not emit; ours must.
  env.preloadDatafeed.subscribeBars({ ticker: 'ZZZWRONGTOKEN999-USD-1' }, '1S', () => {}, 's1', () => {});
  env.preloadRealtime()({ time: now * 1000, close: 888_888_888 });
  assert.equal(
    env.emitted.filter((m) => m.type === 'tick' && m.payload?.source === 'padre-chart-bar').length,
    0,
    'wrong-token bars must not emit ticks'
  );
  env.axiomDatafeed.subscribeBars({ ticker: `${env.AXIOM_PAIR}-USD-1` }, '1S', () => {}, 's2', () => {});
  env.axiomRealtime()({ time: now * 1000, close: 2_000_000 });
  assert.ok(env.emitted.some((m) => m.type === 'tick' && m.payload?.source === 'padre-chart-bar'),
    'bars from the matching chart still emit');

  // Average lines land on the matching chart only.
  env.send('paper-lines', { enabled: true, avgBuyUsd: 1.9e6, avgBuyMcap: 1.9e6 });
  await microtasks();
  assert.equal(env.preloadLines.length, 0, 'the wrong-token chart must receive no lines');
  assert.ok(env.orderLines.length >= 1, 'the matching chart received the line');
});

test('the price is pegged to the chart via exportData when live bars never flow', async () => {
  const now = Math.floor(Date.now() / 1000);
  const env = runBridge({
    axiom: true,
    href: 'https://axiom.trade/meme/Pair1',
    // TradingView returns each row as a Float64Array, not a plain Array.
    exportRows: [
      new Float64Array([now - 2, 1, 2, 0.5, 1.9]),
      new Float64Array([now - 1, 1.9, 2.2, 1.8, 2_150_000]),
    ],
  });
  env.runTimers(); // discovers widgets AND fires the export poll once
  await microtasks(8);

  const tick = env.emitted.find((m) => m.type === 'tick' && m.payload?.source === 'chart-export');
  assert.ok(tick, 'with no live bars the newest chart close must still become a tick');
  assert.equal(tick.payload.candidates[0].value, 2_150_000,
    'the tick must carry the last close from the exported series');
  assert.equal(tick.payload.mcap, 2_150_000,
    'the close is offered as mcap too so quote validation can identify chart mode');
});

test('the chart-export poll stands down while live bars are flowing', async () => {
  const now = Math.floor(Date.now() / 1000);
  const env = runBridge({
    axiom: true,
    href: 'https://axiom.trade/meme/Pair1',
    exportRows: [[now - 1, 1, 2, 0.5, 999]],
  });
  // Hook bars and deliver one — the live feed now owns the peg.
  env.runTimers();
  env.axiomDatafeed.subscribeBars({}, '1S', () => {}, 'sub', () => {});
  env.axiomRealtime()({ time: now * 1000, close: 2_000_000 });

  env.emitted.length = 0;
  env.runTimers(); // export poll fires again, must no-op
  await microtasks(8);

  const exportTick = env.emitted.find((m) => m.type === 'tick' && m.payload?.source === 'chart-export');
  assert.equal(exportTick, undefined, 'live bars must suppress the export poll');
});

/* ------------------------------------------------------------------ *
 * 3. GMGN token_activity realtime trades
 * ------------------------------------------------------------------ */

test('GMGN token_activity trades become mint-tagged USD ticks', async () => {
  const env = runBridge({ gmgnMounted: true });

  const frame = JSON.stringify({
    channel: 'token_activity',
    data: [
      {
        a: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
        pu: '0.000002888483390364',
        e: 'buy',
        ca: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
        m: 'MfDuWeqSHEqTFVYZ7LoexgAK9dxk7cy4DFJWjWMGVWa',
      },
    ],
  });

  // Drive the frame through the patched transport layer. The XHR intercept
  // shares forwardJson with the WebSocket wrapper, so this exercises the same
  // parsing the live socket feed hits.
  const XHR = env.win.XMLHttpRequest;
  const xhr = new XHR();
  const loadListeners = [];
  xhr.addEventListener = (type, fn) => { if (type === 'load') loadListeners.push(fn); };
  xhr.responseType = '';
  xhr.responseText = frame;
  xhr.responseURL = 'wss://ws.gmgn.ai/stream';
  xhr.send();
  for (const fn of loadListeners) fn.call(xhr);

  const tick = env.emitted.find((m) => m.type === 'tick' && m.payload?.source === 'gmgn-ws-trade');
  assert.ok(tick, 'a token_activity trade must be forwarded as a live tick');
  assert.equal(tick.payload.mint, 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    'the tick must carry the traded mint so quote validation can match it');
  assert.equal(tick.payload.candidates[0].unit, 'usd');
  assert.ok(Math.abs(tick.payload.candidates[0].value - 0.000002888483390364) < 1e-18);
});
