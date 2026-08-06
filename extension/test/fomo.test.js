/* Fomo (fomo.family) native chart integration + feed honesty.
 *
 * Every shape in this fake was captured from the LIVE, logged-in site on
 * 2026-08-05 — none of it is guessed:
 *
 *  - The TradingView widget is reachable ONLY through React fiber refs near
 *    the standard `tradingview_*` iframe (no window global), like Axiom.
 *  - The datafeed exposes onReady/searchSymbols/resolveSymbol/getBars/
 *    subscribeBars/unsubscribeBars and NO getMarks — the native marks
 *    pipeline has nothing to patch, so fills MUST render as execution
 *    shapes or they render nowhere.
 *  - The chart symbol is the Codex composite "MINT:1399811149" (uppercased
 *    by the library), and bars are MARKET-CAP denominated: a 1.3M-cap token
 *    streams closes around 1.4e6, ~1/sec.
 *  - /feed/token responses are a SOCIAL TRADE FEED: items[] of historical,
 *    user-attributed trades (type swap_buy/swap_sell, tradeId, userId,
 *    createdAt) each carrying price/marketCap/fdv keys that are minutes to
 *    HOURS stale. Prices inside them are facts about past trades, not the
 *    market — the F-30 class, one layer out.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function microtasks(n = 6) {
  let p = Promise.resolve();
  for (let i = 0; i < n; i++) p = p.then(() => {});
  return p;
}

const FOMO_MINT = 'Gymbmn9wwMKe4NnmVceyyfpncp9arbwPfSdBsyY9pump';
const FOMO_NETWORK = '1399811149'; // Codex's Solana network id
// Live capture: title "1.3M MC", bar closes ~1.41-1.47e6, price ~$0.0014.
const LIVE_BAR_CLOSE = 1417171.26;
const CURRENT_MCAP = 1400000;
const CURRENT_PRICE_USD = 0.0014;
const CURRENT_PRICE_NATIVE = 0.0000070; // at ~$200/SOL

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
 * Boot the shipped price-bridge.js against a fomo-shaped page. The fake
 * REFUSES what the real site refuses: no window widget global, no getMarks
 * on the datafeed, and the chart symbol only ever the Codex composite.
 */
function runFomoBridge(opts = {}) {
  const timers = [];
  const emitted = [];
  const listeners = {};
  const orderLines = [];
  const execShapes = [];

  let subscribed = null; // { symbolInfo, resolution, callback, uid }
  const fomoDatafeed = {
    onReady() {}, searchSymbols() {}, resolveSymbol() {}, getBars() {},
    subscribeBars(symbolInfo, resolution, callback, uid) {
      subscribed = { symbolInfo, resolution, callback, uid };
    },
    unsubscribeBars() {},
    // NO getMarks — live-verified absence (dfKeys capture 2026-08-05).
  };
  const fomoChart = {
    symbol: () => `${FOMO_MINT.toUpperCase()}:${FOMO_NETWORK}`,
    createOrderLine: () => Promise.resolve(makeAsyncAdapter(orderLines)),
    createExecutionShape: () => Promise.resolve(makeAsyncAdapter(execShapes)),
    exportData: () => Promise.resolve({
      schema: ['time', 'open', 'high', 'low', 'close'],
      data: [],
    }),
  };
  const fomoWidget = {
    _options: { datafeed: fomoDatafeed },
    activeChart: () => fomoChart,
    onChartReady: () => {},
  };
  const fiberParent = {};
  // opts.liveShape models what the REAL site showed on 2026-08-05 (probed in
  // a live browser): NO fiber anywhere, the widget api only reachable as
  // contentWindow.tradingViewApi, and the options bag (with the datafeed)
  // parked in window[frameId]. The fiber shape below is kept for the legacy
  // tests but is NOT what production serves.
  if (!opts.liveShape) {
    Object.defineProperty(fiberParent, '__reactFiber$fomo', {
      value: {
        return: null,
        child: null,
        sibling: null,
        memoizedState: { memoizedState: { current: fomoWidget }, next: null },
      },
      enumerable: true,
    });
  }
  const fomoIframe = {
    id: 'tradingview_90d6a',
    parentElement: fiberParent,
    contentWindow: opts.liveShape ? { tradingViewApi: { activeChart: () => fomoChart } } : null,
    getClientRects: () => [{}],
    clientWidth: 800,
  };

  const doc = {
    getElementById: () => null,
    querySelector: (sel) => (String(sel).includes('iframe[id^="tradingview_"]') ? fomoIframe : null),
    querySelectorAll: (sel) => (String(sel).includes('iframe[id^="tradingview_"]') ? [fomoIframe] : []),
  };

  function FakeWebSocket() {}
  FakeWebSocket.prototype.addEventListener = () => {};
  FakeWebSocket.CONNECTING = 0; FakeWebSocket.OPEN = 1;
  FakeWebSocket.CLOSING = 2; FakeWebSocket.CLOSED = 3;
  function FakeXHR() {}
  FakeXHR.prototype.send = function () {};
  FakeXHR.prototype.addEventListener = function () {};

  const win = {
    fetch: (...args) => Promise.resolve(opts.fetchResponse ? opts.fetchResponse(args[0]) : {
      url: '', headers: { get: () => 'application/json' },
      clone: () => ({ text: () => Promise.resolve('{}') }),
    }),
    XMLHttpRequest: FakeXHR,
    WebSocket: FakeWebSocket,
    SharedWorker: undefined,
    EventSource: undefined,
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener(type, fn) { listeners[type] = fn; },
    postMessage(message) { emitted.push(message); },
  };
  win.window = win;
  if (opts.liveShape) win[fomoIframe.id] = { datafeed: fomoDatafeed };

  const timeouts = new Map();
  let timeoutSeq = 0;
  // Controllable clock (nativecharts pattern): the stale-clamp tests need
  // minutes to pass between a live bar and a fill, deterministically.
  const RealDate = Date;
  let fakeNow = null;
  class TestDate extends RealDate {
    constructor(...args) {
      if (args.length === 0 && fakeNow !== null) { super(fakeNow); } else { super(...args); }
    }
    static now() { return fakeNow !== null ? fakeNow : RealDate.now(); }
  }
  const sandbox = {
    window: win,
    document: doc,
    location: {
      href: `https://fomo.family/tokens/solana/${FOMO_MINT}`,
      hostname: 'fomo.family',
    },
    console, Date: TestDate, Math, Number, String, Array, Object, Boolean, RegExp,
    Error, Set, WeakSet, WeakMap, Map, Symbol, JSON, Promise, isFinite,
    MutationObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    setInterval(fn) { timers.push(fn); return timers.length; },
    clearInterval(id) { if (timers[id - 1]) timers[id - 1] = () => {}; },
    setTimeout(fn) { timeouts.set(++timeoutSeq, fn); return timeoutSeq; },
    clearTimeout(id) { timeouts.delete(id); },
  };
  vm.runInContext(
    fs.readFileSync(path.join(ROOT, 'price-bridge.js'), 'utf8'),
    vm.createContext(sandbox),
    { filename: 'price-bridge.js' }
  );

  return {
    emitted,
    orderLines,
    execShapes,
    win,
    fomoDatafeed,
    setNow(t) { fakeNow = t; },
    advance(ms) { fakeNow = (fakeNow === null ? RealDate.now() : fakeNow) + ms; },
    subscribed: () => subscribed,
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
    statuses(type) { return emitted.filter((m) => m.source === 'papertrench-bridge' && m.type === type).map((m) => m.payload); },
  };
}

function announceToken(env) {
  env.send('paper-axis', { mint: FOMO_MINT, symbol: 'Doom', pairAddress: null });
}

/** Run the sweep until discovery, then drive one live mcap bar through the
 *  patched datafeed exactly as fomo's own chart does. */
function bootWithLiveBar(env, close = LIVE_BAR_CLOSE) {
  announceToken(env);
  env.runTimers(); // widget sweep: fiber discovery + datafeed patch
  const sub = {
    symbolInfo: { ticker: `${FOMO_MINT.toUpperCase()}:${FOMO_NETWORK}` },
    resolution: '1',
    uid: `${FOMO_MINT}_#_USD_-_1`,
  };
  env.fomoDatafeed.subscribeBars(sub.symbolInfo, sub.resolution, () => {}, sub.uid);
  const live = env.subscribed();
  live.callback({ time: Date.now(), close, volume: 9556.58 });
  return live;
}

/* ------------------------------------------------------------------ *
 * 1. Discovery and hook status
 * ------------------------------------------------------------------ */

test('F-38: the LIVE fomo shape — options bag + contentWindow api, NO fiber — hooks bars and draws lines', async () => {
  // Maintainer: "FOMO still doesn't show the buys on the chart nor the
  // line." Reverse-engineered on the real site (2026-08-05): production
  // serves NO fiber; the widget api is contentWindow.tradingViewApi and the
  // datafeed rides the options bag in window[frameId]. The old fiber-shaped
  // fixture passed while production showed nothing — this test IS the live
  // shape, and the composite discovery must hook bars and draw from it.
  const env = runFomoBridge({ liveShape: true });
  env.runTimers(); // sweep: discovery finds the pseudo widget + patches the bag's datafeed

  // The site (re)subscribes after the patch — the next subscription in prod.
  env.fomoDatafeed.subscribeBars({ ticker: 'LIVE' }, '1S', () => {}, 'live-sub');
  const sub = env.subscribed();
  assert.ok(sub, 'the subscription flows through the patched datafeed');
  sub.callback({ time: 1_800_000_032_000, close: 8_200_000 }); // mcap-unit close
  assert.ok(env.emitted.some((m) => m.type === 'tick' && m.payload && m.payload.source === 'padre-chart-bar'),
    'a live fomo bar becomes a bridge tick without any fiber in sight');

  env.send('paper-lines', {
    enabled: true,
    axisBasis: 'mcap',
    currentPriceNative: 5e-9,
    currentPriceUsd: 0.0082,
    avgBuyUsd: 0.0164, // entry at 2x current => line at 2x the close
  });
  await microtasks();
  const line = env.orderLines.find((l) => l.values.setPrice !== undefined);
  assert.ok(line, 'the mcap average line draws on fomo');
  assert.ok(Math.abs(line.values.setPrice - 16_400_000) < 1,
    'levelled from the vetted ledger close x price ratio');
});

test('fomo: fiber-only discovery hooks bars and reports marks UNHOOKED', () => {
  const env = runFomoBridge();
  announceToken(env);
  env.runTimers();

  const statuses = env.statuses('padre-hook-status');
  assert.ok(statuses.length, 'discovery must report a hook status');
  const last = statuses[statuses.length - 1];
  assert.equal(last.barsHooked, true, 'subscribeBars must be patched via the fiber-discovered widget');
  assert.equal(last.marksHooked, false, 'fomo has NO getMarks — claiming a marks hook would suppress every fallback');
  assert.equal(last.nativeCapable, true, 'a usable widget exists, so the content script may route natively');
});

/* ------------------------------------------------------------------ *
 * 2. Live bars through the composite Codex symbol
 * ------------------------------------------------------------------ */

test('fomo: mcap bars tick out under the RESOLVED identity, not the composite symbol', () => {
  const env = runFomoBridge();
  bootWithLiveBar(env);

  const ticks = env.statuses('tick').filter((t) => t && t.source === 'padre-chart-bar');
  assert.ok(ticks.length, 'a live bar must emit a tick');
  const tick = ticks[ticks.length - 1];
  assert.equal(tick.mint, FOMO_MINT, 'the tick must carry the content-resolved mint so the token gate passes');
  assert.equal(tick.mcap, LIVE_BAR_CLOSE, 'the mcap-denominated close must be offered as a cap candidate');
  assert.equal(tick.candidates[0].unit, 'unknown', 'the close is offered for anchor-banding, never asserted as a price');
});

/* ------------------------------------------------------------------ *
 * 3. Fills: execution shapes are the ONLY render path (no getMarks)
 * ------------------------------------------------------------------ */

test('fomo: a paper fill renders as an execution shape at the MCAP level', async () => {
  const env = runFomoBridge();
  bootWithLiveBar(env);

  env.send('paper-lines', {
    enabled: true,
    axisBasis: 'mcap',
    currentPriceNative: CURRENT_PRICE_NATIVE,
    currentPriceUsd: CURRENT_PRICE_USD,
    avgBuyNative: 0.0000065,
    avgBuyUsd: 0.0013,
    avgBuyMcap: 1300000,
  });
  await microtasks();

  env.send('paper-marker', {
    side: 'buy',
    priceNative: 0.0000065,
    priceUsd: 0.0013,
    mcap: 1300000,
    solAmount: 0.5,
    ts: Date.now(),
    symbol: 'Doom',
  });
  // The marks pipeline can never run (nothing was patchable); the 2s
  // verification timer must hand rendering to execution shapes.
  env.runTimeouts();
  await microtasks();

  assert.ok(env.execShapes.length >= 1, 'with no getMarks, the fill MUST appear as an execution shape');
  const shape = env.execShapes[env.execShapes.length - 1];
  const level = shape.values.setPrice;
  // F-31 universal formula on the mcap axis: close x (fillNative/currentNative)
  // = 1417171.26 x (6.5/7.0) ~= 1_316_016. The essential truth: the arrow
  // sits on the MCAP axis, never at the raw USD/SOL price magnitude.
  assert.ok(level > 1e6 && level < 1.5e6,
    `fill level must land on the mcap axis near 1.32M, got ${level}`);
  assert.equal(shape.values.setDirection, 'buy');
});

/* ------------------------------------------------------------------ *
 * 4. Average lines on the mcap axis
 * ------------------------------------------------------------------ */

test('fomo: the average line lands on the mcap axis via the vetted live close', async () => {
  const env = runFomoBridge();
  bootWithLiveBar(env);

  env.send('paper-lines', {
    enabled: true,
    axisBasis: 'mcap',
    currentPriceNative: CURRENT_PRICE_NATIVE,
    currentPriceUsd: CURRENT_PRICE_USD,
    avgBuyNative: 0.0000065,
    avgBuyUsd: 0.0013,
    avgBuyMcap: 1300000,
  });
  await microtasks();

  assert.ok(env.orderLines.length >= 1, 'the buy average must draw a native order line');
  const line = env.orderLines[env.orderLines.length - 1];
  const level = line.values.setPrice;
  assert.ok(level > 1e6 && level < 1.5e6,
    `average line must land on the mcap axis near 1.32M, got ${level}`);
});

/* ------------------------------------------------------------------ *
 * 5. Stale live-bar state must not drag fresh fills into the past
 * ------------------------------------------------------------------ */

test('fomo: a fill placed while live bars are STALE keeps its own time', async () => {
  const env = runFomoBridge();
  const t0 = Date.now();
  env.setNow(t0);
  bootWithLiveBar(env); // live bar stamped at t0

  env.send('paper-lines', {
    enabled: true,
    axisBasis: 'mcap',
    currentPriceNative: CURRENT_PRICE_NATIVE,
    currentPriceUsd: CURRENT_PRICE_USD,
    avgBuyNative: 0.0000065,
    avgBuyUsd: 0.0013,
    avgBuyMcap: 1300000,
  });
  await microtasks();

  // Five minutes pass with NO live bars (fomo subscribed before the patch,
  // or volume died) — the export peg owns the price now. F-31's clamp
  // guards millisecond feed skew; clamping a fresh SELL back onto a
  // five-minute-old candle renders it far left of the action — the user
  // reads that as "my sell never showed up".
  env.advance(5 * 60_000);
  const sellTs = t0 + 5 * 60_000;
  env.send('paper-marker', {
    side: 'sell',
    priceNative: 0.0000072,
    priceUsd: 0.00144,
    mcap: 1440000,
    solAmount: 0.5,
    ts: sellTs,
    symbol: 'Doom',
  });
  env.runTimeouts();
  await microtasks();

  const sell = env.execShapes.find((s) => s.values.setDirection === 'sell');
  assert.ok(sell, 'the sell must draw as a shape');
  const drawnSec = sell.values.setTime;
  assert.ok(Math.abs(drawnSec - Math.floor(sellTs / 1000)) <= 60,
    `a stale live-bar time must not drag the fill back: drawn at ${drawnSec}, `
    + `fill was at ${Math.floor(sellTs / 1000)} (delta ${Math.floor(sellTs / 1000) - drawnSec}s)`);
});

/* ------------------------------------------------------------------ *
 * 6. The status surface must name what it is doing (X-Ray dock lesson)
 * ------------------------------------------------------------------ */

test('fomo: marker status admits shapes own rendering on a no-getMarks site', async () => {
  const env = runFomoBridge();
  bootWithLiveBar(env);
  env.send('paper-marker', {
    side: 'buy', priceNative: 0.0000065, priceUsd: 0.0013, mcap: 1300000,
    solAmount: 0.5, ts: Date.now(), symbol: 'Doom',
  });
  env.runTimeouts();
  await microtasks();
  // A second fill reports status AFTER the fallback engaged.
  env.send('paper-marker', {
    side: 'buy', priceNative: 0.0000066, priceUsd: 0.00132, mcap: 1320000,
    solAmount: 0.5, ts: Date.now(), symbol: 'Doom',
  });
  await microtasks();

  const statuses = env.statuses('paper-marker-status').filter((s) => s && s.action === 'add');
  const last = statuses[statuses.length - 1];
  assert.equal(last.shapeFallback, true,
    'the status must say execution shapes own rendering, or the UI shows "marks connecting…" forever');
  assert.ok(last.shapesDrawn >= 1, 'and how many fills are actually on the chart');
});

test('fomo: a lines refusal names its reason', async () => {
  const env = runFomoBridge();
  announceToken(env);
  env.runTimers(); // discovery, but NO bar has ever ticked and exports are empty

  // A fresh-launch fill: only the NATIVE average is known (C-07's shape —
  // no USD rate yet), no resolver mcap, and no bar close has ever arrived.
  // The level is genuinely uncomputable; the status must say so.
  env.send('paper-lines', {
    enabled: true,
    axisBasis: 'mcap',
    currentPriceNative: CURRENT_PRICE_NATIVE,
    avgBuyNative: 0.0000065,
  });
  await microtasks();

  const statuses = env.statuses('paper-lines-status').filter((s) => s && s.action === 'sync');
  const last = statuses[statuses.length - 1];
  assert.ok(last, 'a sync attempt must report');
  assert.equal(last.ok, false,
    'a wanted level with no close is NOT ok — "LINES ✓" with nothing drawn is a silent false-success');
  assert.ok(typeof last.reason === 'string' && last.reason.startsWith('no-level'),
    'a refused line must NAME the reason — "lines connecting…" forever is the X-Ray dock failure again');
});

/* ------------------------------------------------------------------ *
 * 7. The social feed must never tick the price
 * ------------------------------------------------------------------ */

// Shaped exactly like the live /feed/token response (items abridged, ids and
// handles anonymized, magnitudes preserved: this token trades at ~$0.0014 /
// 1.4M cap NOW; the feed carries trades from when it was ~$0.00118 / 1.18M).
const FEED_FIXTURE = JSON.stringify({
  success: true,
  message: 'Token feed retrieved successfully',
  responseObject: {
    items: [
      {
        type: 'swap_buy',
        id: '00000000-1111-2222-3333-444444444444',
        tradeId: '55555555-6666-7777-8888-999999999999',
        createdAt: '2026-08-05T16:01:00.000Z',
        userId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        displayName: 'trader one',
        userHandle: 'traderone',
        profilePictureLink: 'https://example.invalid/p1.jpg',
        usdAmount: 30,
        marketCap: 1180000,
        fdv: 1180000,
        price: 0.00118,
      },
      {
        type: 'swap_sell',
        id: '10000000-1111-2222-3333-444444444444',
        tradeId: '65555555-6666-7777-8888-999999999999',
        createdAt: '2026-08-05T14:22:00.000Z',
        userId: 'baaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        displayName: 'trader two',
        userHandle: 'tradertwo',
        profilePictureLink: 'https://example.invalid/p2.jpg',
        usdAmount: 21.85,
        marketCap: 1620000,
        fdv: 1620000,
        price: 0.00162,
      },
    ],
    hasNextPage: false,
  },
  statusCode: 200,
});

// Positive control, shaped like /proxy/filterTokens: a genuine MARKET
// snapshot (no trade attribution) whose price must keep flowing, tagged.
const OTHER_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const SNAPSHOT_FIXTURE = JSON.stringify({
  success: true,
  message: 'Successfully fetched 1 cached, 0 fresh',
  responseObject: [{
    change5m: '-0.004',
    liquidity: '250000',
    marketCap: '13000000',
    priceUSD: '0.0161',
    token: { address: OTHER_MINT, decimals: 9, networkId: 1399811149, name: 'Bonk', symbol: 'BONK' },
  }],
  statusCode: 200,
});

function jsonResponse(body) {
  return {
    url: '',
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'application/json' : String(body.length)) },
    clone: () => ({ text: () => Promise.resolve(body) }),
  };
}

test('fomo: historical social-feed trades never become price candidates', async () => {
  const env = runFomoBridge({
    fetchResponse: (url) => jsonResponse(String(url).includes('/feed/token') ? FEED_FIXTURE : SNAPSHOT_FIXTURE),
  });
  announceToken(env); // liveness + feed demand

  await env.win.fetch(`https://prod-api.fomo.family/feed/token?tokenAddress=${FOMO_MINT}`);
  await microtasks(10);

  const stale = [0.00118, 0.00162, 1180000, 1620000];
  const polluted = env.statuses('tick').filter((t) => {
    const values = [];
    if (t && Array.isArray(t.candidates)) for (const c of t.candidates) values.push(c.value);
    if (t && t.mcap) values.push(t.mcap);
    return values.some((v) => stale.includes(v));
  });
  assert.equal(polluted.length, 0,
    'user-attributed historical trades are facts about the PAST, never live price candidates: ' +
    JSON.stringify(polluted[0] || null));
});

// Shaped exactly like the live /hodlers/top response (captured 2026-08-05):
// per-token objects tagged with tokenAddress (the CURRENT mint), holding
// topHolders[] rows that each carry tradeId, a NESTED user object, and the
// holder's ENTRY `price` plus pnl/costBasis/averageEntryPrice. Entry prices
// near the live price pass the accept band — they ticked the P&L.
const HODLERS_FIXTURE = JSON.stringify({
  success: true,
  message: 'Successfully fetched top hodlers',
  responseObject: [{
    tokenAddress: FOMO_MINT,
    networkId: 1399811149,
    topHolders: [
      {
        user: { id: 'aaaa-1', handle: 'holderone', displayName: 'holder one' },
        tradeId: '11111111-2222-3333-4444-555555555555',
        humanAmount: 16100000,
        price: 0.00121, // entry price, hours old, inside the 3x band of 0.0014
        value: 3947.36,
        pnl: -1030.54,
        unrealizedPnl: -1030.54,
        realizedPnl: 0,
        costBasis: 4977.9,
        averageEntryPrice: 0.00121,
        comment: null,
        numReplies: 3,
        showComment: true,
        averageHoldTimeSeconds: 60180,
      },
      {
        user: { id: 'aaaa-2', handle: 'holdertwo', displayName: 'holder two' },
        tradeId: '61111111-2222-3333-4444-555555555555',
        humanAmount: 11500000,
        price: 0.00187,
        value: 2827.4,
        pnl: 5149.9,
        unrealizedPnl: 5149.9,
        realizedPnl: 0,
        costBasis: 1200.1,
        averageEntryPrice: 0.00187,
        comment: null,
        numReplies: 1,
        showComment: true,
        averageHoldTimeSeconds: 93720,
      },
    ],
    totalHolders: 768,
  }],
  statusCode: 200,
});

test('fomo: holder ENTRY prices never tick the live price, even mint-tagged', async () => {
  const env = runFomoBridge({
    fetchResponse: () => jsonResponse(HODLERS_FIXTURE),
  });
  announceToken(env);

  await env.win.fetch(`https://prod-api.fomo.family/hodlers/top?tokens=${FOMO_MINT}`);
  await microtasks(10);

  const stale = [0.00121, 0.00187];
  const polluted = env.statuses('tick').filter((t) => t
    && Array.isArray(t.candidates) && t.candidates.some((c) => stale.includes(c.value)));
  assert.equal(polluted.length, 0,
    'a holder record (tradeId + nested user + costBasis/pnl) is someone\'s POSITION, '
    + 'not the market — F-30, one shape out: ' + JSON.stringify(polluted[0] || null));
});

test('fomo: a genuine market snapshot still ticks, mint-tagged (guard must not over-reach)', async () => {
  const env = runFomoBridge({
    fetchResponse: () => jsonResponse(SNAPSHOT_FIXTURE),
  });
  announceToken(env);

  await env.win.fetch('https://prod-api.fomo.family/proxy/filterTokens');
  await microtasks(10);

  // filterTokens nests priceUSD BESIDE the token{address} record, so the
  // candidate legitimately flows untagged — downstream anchor-banding is the
  // validator. The guard must not stop it: no trade attribution here.
  const snapshotTicks = env.statuses('tick').filter((t) => t
    && Array.isArray(t.candidates) && t.candidates.some((c) => c.value === 0.0161));
  assert.ok(snapshotTicks.length >= 1,
    'market snapshots without trade attribution must keep flowing (downstream banding validates them)');
});
