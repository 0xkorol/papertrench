/* Turbo receipts, Tier 3 — page jank sampling + the dashboard card.
 *
 * The content script counts the browser's own 'longtask' entries (main-thread
 * tasks over 50 ms) in memory and flushes ONE aggregate per minute at most;
 * the background folds the flush into pt_turbo_stats.pageJank on the same
 * write chain as the route timings; the dashboard renders both as a card
 * whose copy states exactly what each number is. This suite locks:
 *
 *   - the merge: totals + a bounded window ring per site, a bounded site
 *     table (stalest evicted), and garbage flushes merging nothing
 *   - the sampler: in-memory aggregation with no per-event writes, a
 *     visible-time-only denominator, a 60 s flush cadence, idempotent
 *     start, clean stop (disconnect + final flush), and a refusal to run
 *     where 'longtask' is unsupported
 *   - the dashboard helpers: medians, per-route rows, and the per-site
 *     long-task rates with their earlier-vs-lately before/after split
 *
 * The no-fetch / no-direct-storage source contract for all three blocks
 * lives with its siblings in warmdest.test.js ("receipts stay local").
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const contentJs = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
const backgroundJs = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
const dashJs = fs.readFileSync(path.join(ROOT, 'dashboard.js'), 'utf8');

/** Rehome a vm-realm value so deepEqual is not tripped by realm prototypes. */
const plain = (value) => JSON.parse(JSON.stringify(value));

/* ---------------- background: the pt_turbo_jank merge ---------------- */

function jankWorker(opts = {}) {
  const values = {
    pt_settings: { framesEnabled: false, recordingEnabled: false, autoReview: false },
    pt_state: { positions: {}, rounds: [], journal: [] },
  };
  const session = {};
  let messageListener = null;

  // With slowStorage, get/set complete on a LATER tick, the way real
  // chrome.storage behaves. That is what makes an unserialized pair of
  // read-modify-writes actually interleave — synchronous stubs would hide
  // the race the shared write chain exists to prevent.
  const defer = opts.slowStorage ? (fn) => setImmediate(fn) : (fn) => fn();
  const sandbox = {
    console: { debug: () => {}, warn: () => {}, error: () => {}, log: () => {} },
    Promise, JSON, Math, Date, Number, String, Array, Object, Boolean, RegExp,
    Error, Set, Map, URL, URLSearchParams, AbortController, Uint8Array,
    setTimeout: () => 1, clearTimeout: () => {},
    setInterval: () => 1, clearInterval: () => {},
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    chrome: {
      storage: {
        local: {
          get: (keys, callback) => defer(() => {
            const names = Array.isArray(keys) ? keys : Object.keys(keys || {});
            const result = {};
            for (const key of names) if (Object.hasOwn(values, key)) result[key] = values[key];
            callback(result);
          }),
          set: (update, callback) => defer(() => { Object.assign(values, update); if (callback) callback(); }),
        },
        session: {
          get: (keys, callback) => {
            const result = {};
            for (const key of keys) if (Object.hasOwn(session, key)) result[key] = session[key];
            callback(result);
          },
          set: (update, callback) => { Object.assign(session, update); if (callback) callback(); },
          remove: (key, callback) => { delete session[key]; if (callback) callback(); },
        },
      },
      runtime: {
        id: 'papertrench-test',
        openOptionsPage: () => {},
        onMessage: { addListener: (listener) => { messageListener = listener; } },
        onStartup: { addListener: () => {} },
        onInstalled: { addListener: () => {} },
        sendMessage: async () => ({}),
      },
      tabs: {
        create: async (props) => ({ id: 1, ...props }),
        update: async (id, props) => ({ id, ...props }),
        get: async (id) => ({ id }),
        remove: async () => {},
        query: (query, callback) => callback([]),
        sendMessage: async () => ({}),
        captureVisibleTab: async () => 'data:image/jpeg;base64,',
        onRemoved: { addListener: () => {} },
        onUpdated: { addListener: () => {} },
        onActivated: { addListener: () => {} },
      },
      windows: { update: async () => {} },
      offscreen: { hasDocument: async () => false, createDocument: async () => {} },
    },
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  sandbox.importScripts = (...files) => {
    for (const file of files) {
      vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: file });
    }
  };
  vm.runInContext(backgroundJs, context, { filename: 'background.js' });

  return {
    values,
    get listener() { return messageListener; },
    settle() { return new Promise((resolve) => setImmediate(resolve)); },
  };
}

function send(listener, message, sender = { tab: { id: 1, windowId: 1, index: 0 } }) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('background response timed out')), 2000);
    const asyncResponse = listener(message, sender, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
    assert.equal(asyncResponse, true, 'background messages must keep the response channel open');
  });
}

test('a jank flush folds into pageJank[site]: totals plus a window ring', async () => {
  const worker = jankWorker();
  const first = await send(worker.listener, {
    type: 'pt_turbo_jank', site: 'axiom.trade', count: 3, blockedMs: 430, sampledMs: 60_000,
  });
  assert.deepEqual(plain(first), { ok: true });
  await worker.settle();

  let entry = worker.values.pt_turbo_stats.pageJank['axiom.trade'];
  assert.equal(entry.count, 3);
  assert.equal(entry.blockedMs, 430);
  assert.equal(entry.sampledMs, 60_000);
  assert.equal(entry.ring.length, 1);
  assert.equal(entry.ring[0].c, 3);
  assert.equal(entry.ring[0].b, 430);
  assert.equal(entry.ring[0].s, 60_000);
  assert.ok(entry.updatedAt > 0);

  await send(worker.listener, {
    type: 'pt_turbo_jank', site: 'axiom.trade', count: 2, blockedMs: 100, sampledMs: 30_000,
  });
  await send(worker.listener, {
    type: 'pt_turbo_jank', site: 'gmgn.ai', count: 1, blockedMs: 55, sampledMs: 45_000,
  });
  await worker.settle();

  entry = worker.values.pt_turbo_stats.pageJank['axiom.trade'];
  assert.equal(entry.count, 5, 'totals accumulate across flushes');
  assert.equal(entry.blockedMs, 530);
  assert.equal(entry.sampledMs, 90_000);
  assert.equal(entry.ring.length, 2, 'each flush is one ring window');
  const other = worker.values.pt_turbo_stats.pageJank['gmgn.ai'];
  assert.equal(other.count, 1, 'sites never share an entry');
});

test('garbage flushes merge nothing', async () => {
  const worker = jankWorker();
  const garbage = [
    { type: 'pt_turbo_jank', count: 1, blockedMs: 10, sampledMs: 60_000 },                      // no site
    { type: 'pt_turbo_jank', site: '', count: 1, blockedMs: 10, sampledMs: 60_000 },            // empty site
    { type: 'pt_turbo_jank', site: 'a.example', count: -1, blockedMs: 10, sampledMs: 60_000 },  // negative count
    { type: 'pt_turbo_jank', site: 'a.example', count: 1, blockedMs: -5, sampledMs: 60_000 },   // negative blocked
    { type: 'pt_turbo_jank', site: 'a.example', count: 1, blockedMs: 10, sampledMs: 0 },        // no watched time
    { type: 'pt_turbo_jank', site: 'a.example', count: NaN, blockedMs: 10, sampledMs: 60_000 }, // NaN
  ];
  for (const message of garbage) {
    const response = await send(worker.listener, message);
    assert.deepEqual(plain(response), { ok: true }, 'the ack is unconditional; the drop is silent');
  }
  await worker.settle();
  assert.equal(worker.values.pt_turbo_stats, undefined,
    'not one of those flushes may reach storage');
});

test('the jank window ring stays bounded while totals keep the whole history', async () => {
  const worker = jankWorker();
  for (let i = 0; i < 55; i++) {
    await send(worker.listener, {
      type: 'pt_turbo_jank', site: 's.example', count: 1, blockedMs: 10, sampledMs: 60_000,
    });
  }
  await worker.settle();
  const entry = worker.values.pt_turbo_stats.pageJank['s.example'];
  assert.equal(entry.ring.length, 50, 'the ring holds the last 50 windows');
  assert.equal(entry.count, 55, 'totals still count the windows the ring dropped');
  assert.equal(entry.sampledMs, 55 * 60_000);
});

test('the site table stays bounded: the stalest site is evicted', async () => {
  const worker = jankWorker();
  for (let i = 0; i < 13; i++) {
    await send(worker.listener, {
      type: 'pt_turbo_jank', site: `site-${i}.example`, count: 1, blockedMs: 10, sampledMs: 60_000,
    });
  }
  await worker.settle();
  const jank = worker.values.pt_turbo_stats.pageJank;
  assert.equal(Object.keys(jank).length, 12);
  assert.ok(!('site-0.example' in jank), 'the first-seen (stalest) site is the one dropped');
  assert.ok('site-12.example' in jank);
});

test('both receipt writers serialize through ONE promise chain (source contract)', () => {
  const turboBlock = backgroundJs.slice(
    backgroundJs.indexOf('const TURBO_STATS_KEY'),
    backgroundJs.indexOf('warm X links (instant post opens)'),
  );
  // The property, not just the shape: ONE chain variable exists, and BOTH
  // writers append to it. A refactor that hands the jank merge its own
  // chain would still pass every sequential test — and lose interleaved
  // read-modify-writes on the shared key in the field.
  assert.equal((turboBlock.match(/let turboChain/g) || []).length, 1,
    'exactly one write chain may exist for the stats key');
  const noteFn = turboBlock.slice(
    turboBlock.indexOf('function turboNote('), turboBlock.indexOf('function turboJankNote('));
  const jankFn = turboBlock.slice(turboBlock.indexOf('function turboJankNote('));
  assert.match(noteFn, /turboChain = turboChain/, 'turboNote rides the chain');
  assert.match(jankFn, /turboChain = turboChain/, 'turboJankNote rides the SAME chain');
  assert.equal((turboBlock.match(/turboChain = turboChain/g) || []).length, 2,
    'no writer bypasses the chain');
});

test('concurrent flushes cannot lose each other: the chain serializes the round-trips', async () => {
  const worker = jankWorker({ slowStorage: true });
  // Two flushes for DIFFERENT sites, fired without awaiting in between.
  // Unserialized writers on tick-later storage would both read {} and the
  // second write would erase the first site. The shared chain forbids it.
  const a = send(worker.listener, {
    type: 'pt_turbo_jank', site: 'axiom.trade', count: 1, blockedMs: 60, sampledMs: 60_000,
  });
  const b = send(worker.listener, {
    type: 'pt_turbo_jank', site: 'gmgn.ai', count: 2, blockedMs: 120, sampledMs: 60_000,
  });
  await a; await b;
  for (let i = 0; i < 25; i++) await worker.settle();
  const jank = worker.values.pt_turbo_stats.pageJank;
  assert.ok(jank['axiom.trade'], 'the first concurrent flush must survive the second');
  assert.ok(jank['gmgn.ai'], 'and the second must land too');
  assert.equal(jank['axiom.trade'].count, 1);
  assert.equal(jank['gmgn.ai'].count, 2);
});

test('route timings and pageJank share the key without clobbering each other', async () => {
  const worker = jankWorker();
  // Seed a route entry the way turboNote leaves it, then merge a flush.
  worker.values.pt_turbo_stats = { 'x:spa': { count: 4, ring: [12, 9, 15] } };
  await send(worker.listener, {
    type: 'pt_turbo_jank', site: 'axiom.trade', count: 1, blockedMs: 60, sampledMs: 60_000,
  });
  await worker.settle();
  const stats = worker.values.pt_turbo_stats;
  assert.deepEqual(plain(stats['x:spa']), { count: 4, ring: [12, 9, 15] },
    'the merge must not disturb the route entries beside it');
  assert.equal(stats.pageJank['axiom.trade'].count, 1);
});

/* ---------------- content: the sampler itself ---------------- */

function jankBlock() {
  const start = contentJs.indexOf('/* -------------------- Turbo receipts: page jank sampling');
  const end = contentJs.indexOf('async function init()', start);
  assert.ok(start !== -1, 'the sampling block must exist');
  assert.ok(end !== -1, 'the sampling block must sit directly above init()');
  return contentJs.slice(start, end);
}

function sampler(opts = {}) {
  const observers = [];
  const messages = [];
  const teardowns = [];
  const intervals = [];
  const cleared = [];
  class FakePerformanceObserver {
    constructor(cb) { this.cb = cb; this.disconnected = false; observers.push(this); }
    observe(options) { this.observed = options; }
    disconnect() { this.disconnected = true; }
  }
  FakePerformanceObserver.supportedEntryTypes = opts.supported || ['longtask', 'paint'];
  const sandbox = {
    Math, Number, Date, Promise,
    __now: 0,
    document: { hidden: false, addEventListener: () => {}, removeEventListener: () => {} },
    window: { addEventListener: () => {}, removeEventListener: () => {} },
    location: { hostname: 'axiom.trade' },
    PerformanceObserver: FakePerformanceObserver,
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval: (id) => { cleared.push(id); },
    sendMessage: (payload) => { messages.push(payload); return Promise.resolve(null); },
    contextAlive: () => true,
    shutdown: () => {},
    onTeardown: (fn) => teardowns.push(fn),
  };
  sandbox.performance = { now: () => sandbox.__now };
  vm.createContext(sandbox);
  vm.runInContext(
    jankBlock() + '\nthis.api = { startJankSampling, stopJankSampling, flushJank, onJankVisibility };',
    sandbox, { filename: 'jank-block.js' },
  );
  return { sandbox, observers, messages, teardowns, intervals, cleared, api: sandbox.api };
}

test('the sampler aggregates in memory and flushes ONE message whose span matches', () => {
  const s = sampler();
  s.api.startJankSampling();
  assert.equal(s.observers.length, 1);
  assert.deepEqual(plain(s.observers[0].observed), { type: 'longtask' },
    'unbuffered on purpose: counting starts when watching starts');
  s.api.startJankSampling();
  assert.equal(s.observers.length, 1, 'start is idempotent');

  s.observers[0].cb({ getEntries: () => [{ duration: 120 }, { duration: 60 }, { duration: 250 }] });
  assert.equal(s.messages.length, 0, 'entries alone never leave memory');

  s.sandbox.__now = 90_000;
  s.api.flushJank();
  assert.equal(s.messages.length, 1);
  assert.deepEqual(plain(s.messages[0]), {
    type: 'pt_turbo_jank', site: 'axiom.trade', count: 3, blockedMs: 430, sampledMs: 90_000,
  });

  s.api.flushJank();
  assert.equal(s.messages.length, 1, 'nothing new gathered — nothing sent');
});

test('hidden time never inflates the watched denominator', () => {
  const s = sampler();
  s.api.startJankSampling();
  s.sandbox.__now = 10_000;
  s.sandbox.document.hidden = true;
  s.api.onJankVisibility();
  s.sandbox.__now = 60_000; // 50 s hidden — the browser throttles, we must not count it
  s.sandbox.document.hidden = false;
  s.api.onJankVisibility();
  s.sandbox.__now = 65_000;
  s.api.flushJank();
  assert.equal(s.messages.length, 1, 'a zero-jank visible minute is data too — it lowers the rate');
  assert.equal(s.messages[0].sampledMs, 15_000, 'only the visible 10 s + 5 s are in the span');
  assert.equal(s.messages[0].count, 0);
});

test('a sub-second sliver with nothing seen is not worth a write', () => {
  const s = sampler();
  s.api.startJankSampling();
  s.sandbox.__now = 500;
  s.api.flushJank();
  assert.equal(s.messages.length, 0);
});

test('stop disconnects, clears the cadence, flushes what it holds, then stays silent', () => {
  const s = sampler();
  s.api.startJankSampling();
  assert.equal(s.intervals.length, 1);
  assert.equal(s.intervals[0].ms, 60_000, 'the flush cadence is one minute');
  assert.equal(s.teardowns.length, 1, 'the sampler registers exactly one teardown');

  s.observers[0].cb({ getEntries: () => [{ duration: 80 }] });
  s.sandbox.__now = 2_000;
  s.api.stopJankSampling();

  assert.ok(s.observers[0].disconnected);
  assert.deepEqual(s.cleared, [1], 'the interval dies with the sampler');
  assert.equal(s.messages.length, 1, 'stopping flushes the remainder');
  assert.deepEqual(plain(s.messages[0]), {
    type: 'pt_turbo_jank', site: 'axiom.trade', count: 1, blockedMs: 80, sampledMs: 2_000,
  });

  s.api.flushJank();
  assert.equal(s.messages.length, 1, 'stopped means silent');
});

test('no longtask support: the sampler declines to run at all', () => {
  const s = sampler({ supported: ['paint'] });
  s.api.startJankSampling();
  assert.equal(s.observers.length, 0);
  assert.equal(s.intervals.length, 0);
});

test('the sampler rides the SPEED toggles (source contract)', () => {
  // Maintainer (2026-08-05): jank sampling is speed telemetry — it follows
  // the speed toggles and survives "PaperTrench off" like the rest of the
  // speed plane; with no speed feature on there is nothing to receipt.
  const initFn = contentJs.slice(
    contentJs.indexOf('async function init()'),
    contentJs.indexOf('if (document.readyState'),
  );
  assert.match(initFn, /if \(settings\.warmXLinksEnabled \|\| settings\.warmEverywhereEnabled\) startJankSampling\(\);/,
    'boot gates sampling on the speed toggles, before the overlay early-return');
  const initTail = initFn.slice(initFn.indexOf('startJankSampling()'));
  assert.match(initTail, /appEnabled === false \|\| !settings\.overlayEnabled\) return/,
    'the overlay-off return comes AFTER sampling starts — view-only pages still measure');

  const settingsFlip = contentJs.slice(
    contentJs.indexOf('function watchStorage()'),
    contentJs.indexOf('const stateChange'),
  );
  assert.match(settingsFlip, /if \(settings\.warmXLinksEnabled \|\| settings\.warmEverywhereEnabled\) startJankSampling\(\);/,
    'a settings flip re-derives sampling from the speed toggles');
  assert.match(settingsFlip, /else stopJankSampling\(\);/,
    'turning the last speed toggle off silences the sampler immediately');
});

test('the background routes pt_turbo_jank (source contract)', () => {
  assert.match(backgroundJs, /case 'pt_turbo_jank'/);
});

/* ---------------- dashboard: the receipts card ---------------- */

function dashApi() {
  const start = dashJs.indexOf('const TURBO_ROUTE_LABELS');
  const end = dashJs.indexOf('function renderTurboCard()');
  assert.ok(start !== -1 && end !== -1, 'the dashboard turbo helpers must exist');
  const sandbox = {};
  vm.runInNewContext(
    dashJs.slice(start, end)
      + '\nthis.api = { turboMedian, turboRouteRows, jankRows, TURBO_ROUTE_LABELS };',
    sandbox, { filename: 'dashboard-turbo.js' },
  );
  return sandbox.api;
}

test('turboMedian: empty null, odd exact, even upper, junk filtered', () => {
  const api = dashApi();
  assert.equal(api.turboMedian([]), null);
  assert.equal(api.turboMedian(null), null);
  assert.equal(api.turboMedian([5]), 5);
  assert.equal(api.turboMedian([9, 1, 2]), 2);
  assert.equal(api.turboMedian([1, 2, 3, 100]), 3, 'upper median, same convention as the popup');
  assert.equal(api.turboMedian([7, NaN, 'x', 3]), 7, 'non-numbers are filtered, not coerced');
});

test('route rows: only routes actually taken, labelled, with their median', () => {
  const api = dashApi();
  const rows = api.turboRouteRows({
    'x:spa': { count: 2, ring: [5, 7] },
    'dest:cold_tab': { count: 1, ring: [900] },
    'x:cold_tab': { count: 0, ring: [] },
    pageJank: { 'axiom.trade': { count: 3 } },
  });
  assert.equal(rows.length, 2, 'zero-count routes and the pageJank key are not rows');
  assert.deepEqual(plain(rows[0]), { key: 'x:spa', label: 'X link — warm in-page hop', count: 2, medianMs: 7 });
  assert.deepEqual(plain(rows[1]), { key: 'dest:cold_tab', label: 'Terminal / viewer — cold tab (first open)', count: 1, medianMs: 900 });
});

test('jank rows: no rate before 30 s watched — ever', () => {
  const api = dashApi();
  assert.deepEqual(plain(api.jankRows({
    'a.example': { count: 100, blockedMs: 9000, sampledMs: 29_999, ring: [] },
  })), [], 'a five-second sample must not print a per-minute rate with a straight face');
  assert.deepEqual(plain(api.jankRows(undefined)), []);
});

test('jank rows: the rate is count over watched minutes, exactly', () => {
  const api = dashApi();
  const rows = api.jankRows({
    'axiom.trade': { count: 12, blockedMs: 1200, sampledMs: 240_000, ring: [] },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ratePerMin, 3, '12 long tasks over 4 watched minutes');
  assert.equal(rows[0].blockedMsPerMin, 300);
});

test('jank rows: earlier vs lately splits on the last 15 windows and forgets nothing', () => {
  const api = dashApi();
  const ring = [];
  for (let i = 0; i < 5; i++) ring.push({ t: i, c: 8, b: 400, s: 60_000 });   // rough stretch
  for (let i = 0; i < 15; i++) ring.push({ t: 5 + i, c: 2, b: 100, s: 60_000 }); // calmer lately
  const rows = api.jankRows({
    'axiom.trade': { count: 70, blockedMs: 3500, sampledMs: 1_200_000, ring },
  });
  assert.equal(rows[0].recentPerMin, 2, 'lately: the last 15 windows');
  assert.equal(rows[0].earlierPerMin, 8, 'earlier: totals minus the recent windows');
  assert.equal(rows[0].ratePerMin, 70 / 20);

  // Windows the bounded ring already dropped still count as "earlier":
  // totals larger than the ring's sums land in the earlier bucket.
  const evicted = api.jankRows({
    'axiom.trade': { count: 100, blockedMs: 5000, sampledMs: 1_500_000, ring },
  });
  assert.equal(evicted[0].recentPerMin, 2);
  assert.equal(evicted[0].earlierPerMin, (100 - 30) / ((1_500_000 - 900_000) / 60_000));
});

test('jank rows: the most-watched site leads', () => {
  const api = dashApi();
  const rows = api.jankRows({
    'brief.example': { count: 1, blockedMs: 60, sampledMs: 60_000, ring: [] },
    'main.example': { count: 10, blockedMs: 600, sampledMs: 600_000, ring: [] },
  });
  assert.deepEqual(plain(rows.map((r) => r.site)), ['main.example', 'brief.example']);
});

test('the card says exactly what each number is (source contract)', () => {
  const card = dashJs.slice(
    dashJs.indexOf('function renderTurboCard()'),
    dashJs.indexOf('/* ---------- settings ---------- */'),
  );
  assert.match(card, /background routing latency/, 'the routing number is named for what it is');
  assert.match(card, /NOT page-ready time/, '…and for what it is not');
  assert.match(card, /never sent anywhere/, 'the local-only promise is on the card');
  assert.match(card, /long tasks\/min on/, 'the jank line leads with the honest unit');
  assert.match(card, /over 50 ms/, 'a long task is defined on the card, not assumed');
  assert.match(card, /earlier .*→.* lately|earlier \$\{|\(earlier /, 'before/after context is shown');

  const settingsFn = dashJs.slice(
    dashJs.indexOf('function renderSettings('),
    dashJs.indexOf('function bindSettings('),
  );
  assert.match(settingsFn, /\$\{renderTurboCard\(\)\}/, 'Settings actually mounts the card');
});

test('the dashboard reads pt_turbo_stats and repaints when it changes (source contract)', () => {
  const load = dashJs.slice(dashJs.indexOf('async function loadAll()'), dashJs.indexOf('let lastRecordingsFingerprint'));
  assert.match(load, /'pt_turbo_stats'/, 'loadAll fetches the stats key');
  const watch = dashJs.slice(dashJs.indexOf('function watchDashboardStorage()'), dashJs.indexOf('async function loadAll()'));
  assert.match(watch, /'pt_turbo_stats'/, 'a receipt landing while the dashboard is open refreshes it');
});
