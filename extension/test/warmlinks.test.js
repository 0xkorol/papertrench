/* Warm X links — the instant-post-open path (v2.4.0).
 *
 * The reference design this feature clean-rooms had four defects this suite
 * pins shut: interception gated on userActivation (fires for every real click,
 * so the warm path never ran), a "lock" that was declared but never used, a
 * TTL that closed the tab out from under a reading user, and reveal-after-
 * verify (user waits on DOM polling before seeing anything). PaperTrench's
 * version: capture-phase click interception, a real serialization chain, a
 * single self-sustaining viewer tab with no TTL, and reveal-first with
 * repair-behind-the-eyes.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

/* ---------------- URL classifier ---------------- */

function loadXLinks() {
  const sandbox = { self: {}, URL, Set, String, RegExp };
  sandbox.self.self = sandbox.self;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'xlinks.js'), 'utf8'), sandbox, { filename: 'xlinks.js' });
  return sandbox.self.PTXLinks;
}

test('the classifier routes posts and profiles and refuses everything else', () => {
  const X = loadXLinks();
  // vm-realm objects have a foreign Object.prototype; compare structurally.
  const plain = (v) => (v === null ? null : JSON.parse(JSON.stringify(v)));

  const post = plain(X.classify('https://x.com/someuser/status/1234567890'));
  assert.deepEqual(post, { kind: 'post', handle: 'someuser', postId: '1234567890', url: 'https://x.com/someuser/status/1234567890' });

  // twitter.com and share params canonicalize onto x.com — pushState in the
  // viewer can only target its own origin.
  const legacy = X.classify('https://twitter.com/SomeUser/status/42?s=20');
  assert.equal(legacy.url, 'https://x.com/SomeUser/status/42?s=20');
  assert.equal(legacy.postId, '42');

  const embed = X.classify('https://x.com/i/web/status/777');
  assert.equal(embed.kind, 'post');
  assert.equal(embed.postId, '777');
  assert.equal(embed.handle, null);

  const profile = plain(X.classify('https://x.com/SomeToken'));
  assert.deepEqual(profile, { kind: 'profile', handle: 'sometoken', postId: null, url: 'https://x.com/SomeToken' });

  // System surfaces, other hosts, other protocols: never warm-routed.
  for (const href of [
    'https://x.com/home', 'https://x.com/search?q=bonk', 'https://x.com/compose/post',
    'https://x.com/i/communities/123', 'https://x.com/settings/account',
    'https://x.com/hashtag/bonk',
    'https://gmgn.ai/sol/token/abc', 'https://xcom.evil.example/user/status/1',
    'http://x.com/user/status/1', 'not a url', '',
  ]) {
    assert.equal(X.classify(href), null, `${JSON.stringify(href)} must not classify`);
  }
});

/* ---------------- manifest wiring ---------------- */

test('the warm-links scripts are wired into the right worlds in the right order', () => {
  const mainEntry = manifest.content_scripts.find((cs) => cs.js.includes('price-bridge.js'));
  assert.ok(mainEntry.js.indexOf('xlinks.js') < mainEntry.js.indexOf('warm-open-hook.js'),
    'the MAIN-world hook needs the classifier loaded before it');

  const isolatedEntry = manifest.content_scripts.find((cs) => cs.js.includes('content.js'));
  assert.ok(isolatedEntry.js.includes('warm-links.js'),
    'the click interceptor must load on the trading sites');
  assert.ok(isolatedEntry.js.indexOf('xlinks.js') < isolatedEntry.js.indexOf('warm-links.js'),
    'the click interceptor needs the classifier loaded before it');

  const xMain = manifest.content_scripts.find((cs) => cs.js.includes('xwarm-main.js'));
  const xRelay = manifest.content_scripts.find((cs) => cs.js.includes('xwarm-relay.js'));
  assert.equal(xMain.world, 'MAIN', 'the SPA driver must run in the page world to drive X\'s router');
  assert.equal((xRelay.world || 'ISOLATED'), 'ISOLATED', 'the relay needs chrome.runtime, so ISOLATED');
});

test('the feature adds ZERO new permissions', () => {
  // The whole design bends around this: static content scripts instead of
  // `scripting`, lazy validation instead of `alarms`. Least privilege is a
  // release property (load.test.js pins the exact list; this states the why).
  assert.deepEqual([...manifest.permissions].sort(),
    ['activeTab', 'offscreen', 'storage', 'tabs', 'unlimitedStorage'].sort());
});

/* ---------------- message contract (string level, wiring.test.js style) ---- */

test('every warm message type sent has a handler on the other side', () => {
  const background = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  const warmLinks = fs.readFileSync(path.join(ROOT, 'warm-links.js'), 'utf8');
  const relay = fs.readFileSync(path.join(ROOT, 'xwarm-relay.js'), 'utf8');

  for (const type of ['pt_warm_open', 'pt_warm_hint', 'pt_warm_prewarm']) {
    assert.match(warmLinks, new RegExp(`type: '${type}'`), `warm-links.js must send ${type}`);
    assert.match(background, new RegExp(`case '${type}'`), `background.js must handle ${type}`);
  }
  assert.match(background, /type: 'pt_warm_spa'/, 'background must send the SPA request');
  assert.match(relay, /msg\.type !== 'pt_warm_spa'/, 'the relay must accept the SPA request');
  assert.match(relay, /type: 'pt_warm_spa_result'/, 'the relay must report the result');
  assert.match(background, /case 'pt_warm_spa_result'/, 'background must consume the result');
});

/* ---------------- background warm flows ---------------- */

function warmWorker(opts = {}) {
  const values = {
    pt_settings: {
      framesEnabled: false, recordingEnabled: false, autoReview: false,
      warmXLinksEnabled: opts.enabled !== false,
      ...(opts.settings || {}),
    },
    pt_state: { positions: {}, rounds: [], journal: [] },
  };
  const session = {};
  const tabsById = new Map();
  let nextTabId = 500;
  const calls = { created: [], updated: [], removed: [], sent: [], windows: [] };
  const listeners = {};
  const timers = [];
  let messageListener = null;

  const sandbox = {
    console: { debug: () => {}, warn: () => {}, error: () => {}, log: () => {} },
    Promise, JSON, Math, Date, Number, String, Array, Object, Boolean, RegExp,
    Error, Set, Map, URL, URLSearchParams, AbortController, Uint8Array,
    setTimeout: (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length; },
    clearTimeout: (id) => { const t = timers[id - 1]; if (t) t.cleared = true; },
    setInterval: () => 1,
    clearInterval: () => {},
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    chrome: {
      storage: {
        local: {
          get: (keys, callback) => {
            const names = Array.isArray(keys) ? keys : Object.keys(keys || {});
            const result = {};
            for (const key of names) if (Object.hasOwn(values, key)) result[key] = values[key];
            callback(result);
          },
          set: (update, callback) => { Object.assign(values, update); if (callback) callback(); },
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
        create: async (props) => {
          const tab = {
            id: nextTabId++, windowId: props.windowId ?? 1, index: 0,
            active: !!props.active, url: props.url, discarded: false, status: 'complete',
          };
          tabsById.set(tab.id, tab);
          calls.created.push({ ...props, id: tab.id });
          return tab;
        },
        update: async (id, props) => {
          calls.updated.push({ id, props });
          const tab = tabsById.get(id);
          if (!tab) throw new Error('no tab ' + id);
          if (props.url) tab.url = props.url;
          if (props.active) tab.active = true;
          return tab;
        },
        get: async (id) => {
          const tab = tabsById.get(id);
          if (!tab) throw new Error('no tab ' + id);
          return tab;
        },
        remove: async (id) => { calls.removed.push(id); tabsById.delete(id); },
        query: (query, callback) => callback(opts.platformTabs || []),
        sendMessage: async (id, msg) => {
          calls.sent.push({ id, msg });
          if (opts.spaSendFails) throw new Error('Receiving end does not exist');
          return { forwarded: true };
        },
        captureVisibleTab: async () => 'data:image/jpeg;base64,',
        onRemoved: { addListener: (fn) => { listeners.onRemoved = fn; } },
        onUpdated: { addListener: (fn) => { listeners.onUpdated = fn; } },
        onActivated: { addListener: (fn) => { listeners.onActivated = fn; } },
      },
      windows: { update: async (id, props) => { calls.windows.push({ id, props }); } },
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
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'), context, { filename: 'background.js' });

  return {
    values, session, tabsById, calls, listeners, timers,
    get listener() { return messageListener; },
    seedViewer(props = {}) {
      const tab = {
        id: nextTabId++, windowId: props.windowId ?? 1, index: 0, active: false,
        url: props.url || 'https://x.com/home', discarded: !!props.discarded, status: 'complete',
      };
      tabsById.set(tab.id, tab);
      session.pt_warm_tab = { tabId: tab.id, used: !!props.used, createdAt: 1 };
      return tab;
    },
    fireTimers(ms) {
      for (const t of timers) {
        if (!t.cleared && t.ms === ms) { t.cleared = true; t.fn(); }
      }
    },
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

const POST = 'https://x.com/degentoken/status/999888777';

test('feature off: an X click opens a plain new tab and registers nothing', async () => {
  const worker = warmWorker({ enabled: false });
  const response = await send(worker.listener, { type: 'pt_warm_open', url: POST });
  assert.equal(response.route, 'new_tab');
  assert.equal(worker.calls.created.length, 1);
  assert.equal(worker.calls.created[0].url, POST);
  assert.equal(worker.session.pt_warm_tab, undefined, 'no viewer registration when the feature is off');
});

test('background refuses to warm-route anything that is not an X post/profile', async () => {
  // The content script is not trusted: URLs are re-classified at this boundary.
  const worker = warmWorker();
  const response = await send(worker.listener, { type: 'pt_warm_open', url: 'https://evil.example/x.com/status/1' });
  assert.equal(response.ok, false);
  assert.equal(worker.calls.created.length, 0, 'nothing may be opened for a non-X URL');
});

test('first click is cold but the new tab immediately becomes the viewer', async () => {
  const worker = warmWorker();
  const response = await send(worker.listener, { type: 'pt_warm_open', url: POST });
  assert.equal(response.route, 'cold_tab');
  const created = worker.calls.created[0];
  assert.equal(created.url, POST);
  assert.equal(created.active, true);
  assert.equal(worker.session.pt_warm_tab.tabId, created.id, 'the cold tab is now the viewer');
  assert.equal(worker.session.pt_warm_tab.used, true);
});

test('with a live viewer: SPA request goes out and the tab is revealed FIRST', async () => {
  const worker = warmWorker();
  const viewer = worker.seedViewer();
  const response = await send(worker.listener, { type: 'pt_warm_open', url: POST });

  assert.equal(response.route, 'spa');
  assert.equal(worker.calls.sent.length, 1);
  assert.equal(worker.calls.sent[0].id, viewer.id);
  assert.equal(worker.calls.sent[0].msg.type, 'pt_warm_spa');
  assert.equal(worker.calls.sent[0].msg.postId, '999888777');

  // Reveal: active + unmuted + window focused — BEFORE any verification result.
  const reveal = worker.calls.updated.find((u) => u.id === viewer.id && u.props.active === true);
  assert.ok(reveal, 'the viewer must be activated immediately');
  assert.equal(reveal.props.muted, false, 'a visible viewer must not stay muted');
  assert.ok(worker.calls.windows.some((w) => w.id === viewer.windowId && w.props.focused === true),
    'the viewer\'s WINDOW must be focused too — multi-monitor setups otherwise see nothing');
  assert.equal(worker.calls.created.length, 0, 'no new tab: the viewer is reused');
  assert.equal(worker.session.pt_warm_tab.tabId, viewer.id, 'the viewer stays registered for the NEXT click');
});

test('a failed SPA result repairs with a full load of the same URL', async () => {
  const worker = warmWorker();
  const viewer = worker.seedViewer();
  await send(worker.listener, { type: 'pt_warm_open', url: POST });
  const requestId = worker.calls.sent[0].msg.requestId;

  await send(worker.listener, { type: 'pt_warm_spa_result', requestId, ok: false, reason: 'verify_timeout' },
    { tab: { id: viewer.id } });
  await worker.settle();
  assert.ok(worker.calls.updated.some((u) => u.id === viewer.id && u.props.url === POST),
    'the repair must navigate the viewer to the exact clicked URL');
});

test('a successful SPA result leaves the viewer alone and disarms the timeout', async () => {
  const worker = warmWorker();
  const viewer = worker.seedViewer();
  await send(worker.listener, { type: 'pt_warm_open', url: POST });
  const requestId = worker.calls.sent[0].msg.requestId;
  const updatesBefore = worker.calls.updated.length;

  await send(worker.listener, { type: 'pt_warm_spa_result', requestId, ok: true }, { tab: { id: viewer.id } });
  worker.fireTimers(6000);
  await worker.settle();
  assert.equal(worker.calls.updated.length, updatesBefore, 'no repair after success, even when the timer fires');
});

test('silence repairs too: the timeout alone triggers the full load', async () => {
  const worker = warmWorker();
  const viewer = worker.seedViewer();
  await send(worker.listener, { type: 'pt_warm_open', url: POST });
  worker.fireTimers(6000);
  await worker.settle();
  assert.ok(worker.calls.updated.some((u) => u.id === viewer.id && u.props.url === POST),
    'no result within the window must fall back to a full load');
});

test('a result from a tab we never messaged is ignored', async () => {
  const worker = warmWorker();
  const viewer = worker.seedViewer();
  await send(worker.listener, { type: 'pt_warm_open', url: POST });
  const requestId = worker.calls.sent[0].msg.requestId;
  const updatesBefore = worker.calls.updated.length;

  await send(worker.listener, { type: 'pt_warm_spa_result', requestId, ok: false, reason: 'spoofed' },
    { tab: { id: 31337 } });
  await worker.settle();
  assert.equal(worker.calls.updated.length, updatesBefore,
    'only the messaged tab may influence the repair decision');
});

test('a second rapid click supersedes the first — no repair back to a stale target', async () => {
  const worker = warmWorker();
  const viewer = worker.seedViewer();
  const POST2 = 'https://x.com/other/status/111222333';

  await send(worker.listener, { type: 'pt_warm_open', url: POST });
  const firstRequest = worker.calls.sent[0].msg.requestId;
  await send(worker.listener, { type: 'pt_warm_open', url: POST2 });

  // The first request's late failure must NOT navigate the tab back to POST.
  await send(worker.listener, { type: 'pt_warm_spa_result', requestId: firstRequest, ok: false, reason: 'late' },
    { tab: { id: viewer.id } });
  worker.fireTimers(6000); // includes the first request's (cleared) timer
  await worker.settle();
  assert.ok(!worker.calls.updated.some((u) => u.props.url === POST),
    'the user clicked past POST; nothing may drag them back to it');
});

test('re-clicking a link the viewer already shows reveals it — no message, no reload', async () => {
  // Seen on video during first manual QA: click a token's X link, go back,
  // click it again — the viewer full-reloaded the same post because the SPA
  // relay was not answering yet. The already-open check must run in the
  // BACKGROUND, before any messaging, so this is instant regardless of the
  // viewer's load state.
  const worker = warmWorker();
  const viewer = worker.seedViewer({ url: POST });
  const response = await send(worker.listener, { type: 'pt_warm_open', url: POST });
  assert.equal(response.route, 'already_open');
  assert.equal(worker.calls.sent.length, 0, 'no SPA round-trip for a target already on screen');
  assert.ok(!worker.calls.updated.some((u) => u.props.url),
    'nothing may be re-navigated — that is the reload this guards against');
  assert.ok(worker.calls.updated.some((u) => u.id === viewer.id && u.props.active === true),
    'the viewer is simply revealed');

  // Same page under the legacy host or a trailing slash still counts.
  const workerB = warmWorker();
  workerB.seedViewer({ url: 'https://twitter.com/degentoken/status/999888777/' });
  const responseB = await send(workerB.listener, { type: 'pt_warm_open', url: POST });
  assert.equal(responseB.route, 'already_open');
});

test('a viewer with no live relay gets a full load in place, not a new tab', async () => {
  const worker = warmWorker({ spaSendFails: true });
  const viewer = worker.seedViewer();
  const response = await send(worker.listener, { type: 'pt_warm_open', url: POST });
  assert.equal(response.route, 'warm_reload');
  // Reveal and navigation are separate calls now (reveal runs concurrently
  // with the ack attempt); both must land on the same viewer tab.
  assert.ok(worker.calls.updated.some((u) => u.id === viewer.id && u.props.active === true),
    'the viewer is revealed');
  assert.ok(worker.calls.updated.some((u) => u.id === viewer.id && u.props.url === POST),
    'and driven to the target with a full load');
  assert.equal(worker.calls.created.length, 0);
});

test('a discarded viewer (Chrome memory pressure) full-loads instead of SPA', async () => {
  const worker = warmWorker();
  worker.seedViewer({ discarded: true });
  const response = await send(worker.listener, { type: 'pt_warm_open', url: POST });
  assert.equal(response.route, 'warm_reload');
  assert.equal(worker.calls.sent.length, 0, 'no SPA message to a tab with no live scripts');
});

test('prewarm is idempotent: many trading tabs, one hidden muted viewer', async () => {
  const worker = warmWorker();
  await send(worker.listener, { type: 'pt_warm_prewarm' });
  await send(worker.listener, { type: 'pt_warm_prewarm' });
  await worker.settle();
  assert.equal(worker.calls.created.length, 1, 'exactly one viewer regardless of how many tabs ask');
  const created = worker.calls.created[0];
  assert.equal(created.active, false, 'the pre-warmed viewer must stay hidden');
  assert.ok(worker.calls.updated.some((u) => u.id === created.id && u.props.muted === true),
    'the hidden viewer must be muted — a background feed must never make a sound');
});

test('closing the viewer clears the registration; the next click recovers cold', async () => {
  const worker = warmWorker();
  const viewer = worker.seedViewer();
  worker.tabsById.delete(viewer.id);
  worker.listeners.onRemoved(viewer.id);
  await worker.settle();
  assert.equal(worker.session.pt_warm_tab, undefined);

  const response = await send(worker.listener, { type: 'pt_warm_open', url: POST });
  assert.equal(response.route, 'cold_tab');
});

test('toggling off closes only a never-used hidden viewer', async () => {
  // Unused idle tab: ours, close it.
  const workerA = warmWorker({ enabled: false });
  const idle = workerA.seedViewer({ used: false });
  await send(workerA.listener, { type: 'pt_settings_changed' });
  await workerA.settle();
  assert.ok(workerA.calls.removed.includes(idle.id), 'the hidden idle tab is released on opt-out');

  // Used viewer: the user's tab now — must survive the toggle.
  const workerB = warmWorker({ enabled: false });
  const used = workerB.seedViewer({ used: true });
  await send(workerB.listener, { type: 'pt_settings_changed' });
  await workerB.settle();
  assert.ok(!workerB.calls.removed.includes(used.id), 'a tab the user has seen is never closed by us');
  assert.equal(workerB.session.pt_warm_tab, undefined, 'but the registration is dropped');
});

test('the viewer navigating off X releases it', async () => {
  const worker = warmWorker();
  const viewer = worker.seedViewer();
  worker.listeners.onUpdated(viewer.id, { status: 'loading', url: 'https://example.com/' }, viewer);
  await worker.settle();
  assert.equal(worker.session.pt_warm_tab, undefined, 'a tab steered off X is the user\'s, not our viewer');
});

test('the app-wide master switch outranks the warm-links toggle', async () => {
  // appEnabled=false with warmXLinksEnabled=true: clicks behave natively,
  // hovers do nothing, and the hidden idle viewer is released.
  const worker = warmWorker({ settings: { appEnabled: false } });
  const idle = worker.seedViewer({ used: false });

  const response = await send(worker.listener, { type: 'pt_warm_open', url: POST });
  assert.equal(response.route, 'new_tab', 'master off must mean plain native-style opens');

  await send(worker.listener, { type: 'pt_warm_hint', url: POST });
  await worker.settle();
  assert.equal(worker.calls.sent.length, 0, 'no prefetch under master off');

  await send(worker.listener, { type: 'pt_settings_changed' });
  await worker.settle();
  assert.ok(worker.calls.removed.includes(idle.id),
    '"PaperTrench off" includes the hidden viewer tab');
});

/* ---------------- hover prefetch (background side) ---------------- */

test('a hint drives the HIDDEN viewer without revealing or claiming it', async () => {
  const worker = warmWorker();
  const viewer = worker.seedViewer();
  await send(worker.listener, { type: 'pt_warm_hint', url: POST });
  await worker.settle();

  assert.equal(worker.calls.sent.length, 1, 'the hint dispatches the SPA prefetch');
  assert.equal(worker.calls.sent[0].id, viewer.id);
  assert.ok(!worker.calls.updated.some((u) => u.props.active === true),
    'a hover must NEVER bring the viewer forward');
  assert.equal(worker.calls.windows.length, 0, 'nor focus any window');
  assert.equal(worker.session.pt_warm_tab.used, false,
    'a prefetched-but-unrevealed viewer is still ours to close on opt-out');
});

test('a hint never touches a viewer the user is looking at', async () => {
  const worker = warmWorker();
  const viewer = worker.seedViewer();
  viewer.active = true;
  await send(worker.listener, { type: 'pt_warm_hint', url: POST });
  await worker.settle();
  assert.equal(worker.calls.sent.length, 0,
    'redirecting a tab mid-read because a cursor crossed a link is hijacking');
});

test('a hint never creates tabs and a dead relay costs nothing', async () => {
  const workerA = warmWorker();
  await send(workerA.listener, { type: 'pt_warm_hint', url: POST });
  await workerA.settle();
  assert.equal(workerA.calls.created.length, 0, 'hover is not intent enough to open a tab');

  const workerB = warmWorker({ spaSendFails: true });
  workerB.seedViewer();
  await send(workerB.listener, { type: 'pt_warm_hint', url: POST });
  await workerB.settle(); // hint responds before its serialized body runs
  workerB.fireTimers(6000);
  await workerB.settle();
  assert.ok(!workerB.calls.updated.some((u) => u.props.url),
    'hover is not intent enough to spend a full reload on either');
});

test('a failed prefetch repairs while still hidden — the fallback IS a prefetch', async () => {
  const worker = warmWorker();
  const viewer = worker.seedViewer();
  await send(worker.listener, { type: 'pt_warm_hint', url: POST });
  await worker.settle(); // hint responds before its serialized body runs
  worker.fireTimers(6000); // SPA route never confirmed
  await worker.settle();
  assert.ok(worker.calls.updated.some((u) => u.id === viewer.id && u.props.url === POST),
    'the hidden viewer full-loads the target, so the click still lands warm');
  assert.ok(!worker.calls.updated.some((u) => u.props.active === true),
    'and stays hidden throughout');
});

/* ---------------- trading-site click interception ---------------- */

function loadWarmLinks(opts = {}) {
  const posted = [];
  const sent = [];
  const timers = [];
  const domListeners = {};
  const winListeners = {};
  const win = {
    addEventListener: (type, fn) => { winListeners[type] = fn; },
    postMessage: (data) => posted.push(data),
    location: { href: 'https://axiom.trade/meme/PAIR', origin: 'https://axiom.trade' },
  };
  win.window = win;
  win.self = win;
  const sandbox = {
    window: win, self: win,
    document: { addEventListener: (type, fn, capture) => { domListeners[type] = { fn, capture }; } },
    chrome: {
      runtime: { id: 'papertrench-test', sendMessage: (msg) => { sent.push(msg); return Promise.resolve({}); }, lastError: undefined },
      storage: {
        local: { get: (keys, cb) => cb({ pt_settings: { warmXLinksEnabled: opts.enabled !== false } }) },
        onChanged: { addListener: () => {} },
      },
    },
    setTimeout: (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length; },
    clearTimeout: (id) => { const t = timers[id - 1]; if (t) t.cleared = true; },
    Date,
    URL, console, Promise, JSON, Object, String, Boolean,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'xlinks.js'), 'utf8'), sandbox, { filename: 'xlinks.js' });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'warm-links.js'), 'utf8'), sandbox, { filename: 'warm-links.js' });
  const fireTimers = () => { for (const t of timers) if (!t.cleared) { t.cleared = true; t.fn(); } };
  return { posted, sent, timers, fireTimers, domListeners, winListeners, win };
}

function clickEvent(href, mods = {}) {
  const event = {
    button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
    defaultPrevented: false,
    target: { closest: (sel) => (sel === 'a[href]' ? { href } : null) },
    prevented: false, stopped: false,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; },
    ...mods,
  };
  return event;
}

test('a plain click on an X post link is claimed and routed', () => {
  const page = loadWarmLinks();
  const click = page.domListeners.click;
  assert.equal(click.capture, true,
    'must be capture phase: it runs before site handlers (no double open) and catches target=_blank anchors');

  const event = clickEvent(POST);
  click.fn(event);
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
  assert.equal(page.sent.filter((m) => m.type === 'pt_warm_open').length, 1);
  assert.equal(page.sent.find((m) => m.type === 'pt_warm_open').url, POST);
});

test('modified clicks and non-X links pass through untouched', () => {
  const page = loadWarmLinks();
  const click = page.domListeners.click.fn;

  for (const event of [
    clickEvent(POST, { ctrlKey: true }),
    clickEvent(POST, { metaKey: true }),
    clickEvent(POST, { shiftKey: true }),
    clickEvent(POST, { button: 1 }),
    clickEvent('https://gmgn.ai/sol/token/abc'),
    clickEvent('https://x.com/search?q=bonk'),
  ]) {
    click(event);
    assert.equal(event.prevented, false, 'native behavior must win');
  }
  assert.equal(page.sent.filter((m) => m.type === 'pt_warm_open').length, 0);
});

test('hovering an X link for the dwell sends a prefetch hint; a graze does not', () => {
  const page = loadWarmLinks();
  const hover = page.domListeners.mouseover;
  assert.ok(hover && hover.capture, 'the hover listener must exist at capture phase');

  hover.fn(clickEvent(POST)); // same event shape works: target.closest is all it reads
  assert.equal(page.sent.filter((m) => m.type === 'pt_warm_hint').length, 0,
    'nothing may be sent before the dwell elapses — a cursor grazing links must not spam hints');
  page.fireTimers();
  const hints = page.sent.filter((m) => m.type === 'pt_warm_hint');
  assert.equal(hints.length, 1);
  assert.equal(hints[0].url, POST);

  // Hovering the same link again within the repeat window stays silent.
  hover.fn(clickEvent(POST));
  page.fireTimers();
  assert.equal(page.sent.filter((m) => m.type === 'pt_warm_hint').length, 1);

  // Non-X links never hint.
  hover.fn(clickEvent('https://gmgn.ai/sol/token/abc'));
  page.fireTimers();
  assert.equal(page.sent.filter((m) => m.type === 'pt_warm_hint').length, 1);
});

test('with the feature disabled the click listener touches nothing', () => {
  const page = loadWarmLinks({ enabled: false });
  const event = clickEvent(POST);
  page.domListeners.click.fn(event);
  assert.equal(event.prevented, false);
  assert.equal(page.sent.filter((m) => m.type === 'pt_warm_open').length, 0);
});

test('the MAIN-world hook forwards only after the ISOLATED world says enabled', () => {
  const posted = [];
  const winListeners = [];
  const nativeCalls = [];
  const win = {
    addEventListener: (type, fn) => { if (type === 'message') winListeners.push(fn); },
    postMessage: (data) => posted.push(data),
    open: (...args) => { nativeCalls.push(args); return { native: true }; },
    location: { href: 'https://axiom.trade/meme/PAIR', origin: 'https://axiom.trade' },
  };
  win.window = win;
  win.self = win;
  const sandbox = { window: win, self: win, URL, console, String, Object, Boolean, JSON };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'xlinks.js'), 'utf8'), sandbox, { filename: 'xlinks.js' });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'warm-open-hook.js'), 'utf8'), sandbox, { filename: 'warm-open-hook.js' });

  // Before any state message: fail-safe native passthrough.
  win.open(POST);
  assert.equal(nativeCalls.length, 1, 'unknown state must behave natively');

  for (const fn of winListeners) fn({ source: win, data: { source: 'papertrench-warmstate', enabled: true } });

  const fake = win.open(POST, '_blank');
  assert.equal(nativeCalls.length, 1, 'an X post open is intercepted once enabled');
  assert.equal(fake.closed, false, 'callers get a workable stand-in window');
  const forwarded = posted.find((m) => m && m.source === 'papertrench-warmhook');
  assert.equal(forwarded.url, POST);

  win.open('https://google.com');
  assert.equal(nativeCalls.length, 2, 'non-X opens stay native even when enabled');
});

/* ---------------- x.com SPA driver ---------------- */

function loadSpaDriver(opts = {}) {
  const posted = [];
  const pushes = [];
  const dispatched = [];
  const intervals = [];
  let now = 1000;
  const winListeners = [];
  const win = {
    addEventListener: (type, fn) => { if (type === 'message') winListeners.push(fn); },
    postMessage: (data) => posted.push(data),
    dispatchEvent: (ev) => dispatched.push(ev),
    history: { pushState: (state, title, url) => pushes.push(url) },
    location: {
      origin: 'https://x.com', pathname: opts.pathname || '/home', search: '',
    },
  };
  win.window = win;
  win.self = win;
  const doc = {
    title: opts.title || 'Home / X',
    body: {},
    querySelector: (sel) => (opts.matches && opts.matches(sel)) || null,
  };
  const sandbox = {
    window: win, self: win, document: doc,
    MutationObserver: function (fn) { this.observe = () => {}; this.disconnect = () => {}; this.fn = fn; },
    PopStateEvent: function (type, init) { this.type = type; this.state = init && init.state; },
    performance: { now: () => (now += 300) },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval: () => {},
    URL, console, String, Object, Boolean, JSON,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'xwarm-main.js'), 'utf8'), sandbox, { filename: 'xwarm-main.js' });
  return {
    posted, pushes, dispatched, intervals, doc, win,
    request(msg) { for (const fn of winListeners) fn({ source: win, data: msg }); },
    tick() { for (const i of intervals) i.fn(); },
  };
}

const SPA_REQUEST = {
  source: 'papertrench-xwarm-request', requestId: 'req-1',
  url: POST, kind: 'post', handle: 'degentoken', postId: '999888777',
};

test('the driver pushes state, wakes the router, and confirms on the post anchor', () => {
  let arrived = false;
  const page = loadSpaDriver({
    matches: (sel) => (arrived && sel.includes('/status/999888777') ? {} : null),
  });
  page.request(SPA_REQUEST);

  assert.deepEqual(page.pushes, ['/degentoken/status/999888777']);
  assert.ok(page.dispatched.some((ev) => ev.type === 'popstate'),
    'X\'s router listens on popstate; without the dispatch nothing navigates');
  assert.equal(page.posted.length, 0, 'no verdict before the content actually lands');

  arrived = true;
  page.tick();
  const result = page.posted.find((m) => m.source === 'papertrench-xwarm-result');
  assert.equal(result.ok, true);
  assert.equal(result.requestId, 'req-1');
});

test('a notification-count title change is NOT proof of navigation', () => {
  const page = loadSpaDriver({ title: 'Home / X' });
  page.request(SPA_REQUEST);
  // "(2) Home / X" is the same page with unread notifications — the defect
  // this guards against is declaring success while stranding the user on
  // their feed, which suppresses the repair that would have saved them.
  page.doc.title = '(2) Home / X';
  page.tick();
  assert.equal(page.posted.length, 0, 'count-prefix churn must not read as arrival');

  page.doc.title = 'degen (@degentoken) on X';
  page.tick();
  const result = page.posted.find((m) => m.source === 'papertrench-xwarm-result');
  assert.equal(result.ok, true, 'a genuine title change is the arrival fallback');
});

test('already on the target: instant success, no navigation', () => {
  const page = loadSpaDriver({ pathname: '/degentoken/status/999888777' });
  page.request(SPA_REQUEST);
  assert.equal(page.pushes.length, 0);
  const result = page.posted.find((m) => m.source === 'papertrench-xwarm-result');
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'already_here');
});

test('X\'s error surface is an explicit failure, not a shrug', () => {
  let errored = false;
  const page = loadSpaDriver({
    matches: (sel) => (errored && sel.includes('error-detail') ? {} : null),
  });
  page.request(SPA_REQUEST);
  errored = true;
  page.tick();
  const result = page.posted.find((m) => m.source === 'papertrench-xwarm-result');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'x_error_page');
});
