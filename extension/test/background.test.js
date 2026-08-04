const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

function serviceWorker() {
  const values = {
    pt_settings: {
      framesEnabled: false,
      recordingEnabled: false,
      autoReview: false,
    },
    pt_state: { positions: {}, rounds: [], journal: [] },
  };
  let messageListener = null;
  const fetchCalls = [];
  const captureCalls = [];
  const get = (keys, callback) => {
    const names = Array.isArray(keys) ? keys : Object.keys(keys || {});
    const result = {};
    for (const key of names) if (Object.hasOwn(values, key)) result[key] = values[key];
    if (callback) { callback(result); return undefined; }
    return Promise.resolve(result);
  };
  const set = (update, callback) => {
    Object.assign(values, update);
    if (callback) callback();
    return Promise.resolve();
  };

  const sandbox = {
    console,
    Promise,
    JSON,
    Math,
    Date,
    Number,
    String,
    Array,
    Object,
    Boolean,
    RegExp,
    Error,
    Set,
    Map,
    URL,
    URLSearchParams,
    AbortController,
    Uint8Array,
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval: () => {},
    fetch: async (url) => {
      fetchCalls.push(String(url));
      if (String(url).includes('/topics/history?')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            topic: 'dog coins', start_at: 1_800_000_000, end_at: 1_800_003_600,
            requested_start_at: 1_800_000_000, requested_end_at: 1_800_000_120,
            resolution: 'hour', points: [], coverage: {},
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          generated_at: 1_800_000_001,
          broadcast_mode: false,
          readiness: [],
          sources: {},
          tokens: [{ mint: MINT, name: 'Bonk', symbol: 'BONK', status: 'graduated' }],
          signals: [],
          narratives: [],
          social: {
            topics: [{
              topic: 'dog coins', score: 50, stage: 'rising', platforms: ['tiktok'],
              token_versions: [{ mint: MINT, name: 'Bonk', symbol: 'BONK' }], evidence: [],
            }],
            company_posts: [], platforms: [],
          },
          chat_intelligence: { settings: { enabled: false, window_minutes: 60 }, recent: [], platforms: {} },
        }),
      };
    },
    chrome: {
      storage: { local: { get, set } },
      runtime: {
        id: 'papertrench-test',
        openOptionsPage: () => {},
        onMessage: { addListener: (listener) => { messageListener = listener; } },
        onStartup: { addListener: () => {} },
        onInstalled: { addListener: () => {} },
        sendMessage: async () => ({}),
      },
      tabs: {
        query: (query, callback) => callback([]),
        sendMessage: async () => ({}),
        // Records WHICH window is asked for: the whole point of the
        // wrong-tab-screenshot fix is that this argument decides what gets
        // photographed.
        captureVisibleTab: async (windowId) => {
          captureCalls.push(windowId);
          return 'data:image/jpeg;base64,';
        },
        get: async (id) => {
          const tab = values.tabsById && values.tabsById[id];
          if (!tab) throw new Error('no tab ' + id);
          return tab;
        },
      },
      offscreen: {
        hasDocument: async () => false,
        createDocument: async () => {},
      },
      alarms: {
        clear: async () => true,
        create: () => {},
        onAlarm: { addListener: () => {} },
      },
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
  return { values, fetchCalls, captureCalls, get listener() { return messageListener; }, get isAllowedEndpoint() { return context.isAllowedEndpoint; } };
}

function send(listener, message) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('background response timed out')), 2000);
    const asyncResponse = listener(message, { tab: { id: 1 } }, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
    assert.equal(asyncResponse, true, 'background messages must keep the response channel open');
  });
}

test('service worker captures a real pt_trade_event into the replay store', async () => {
  const worker = serviceWorker();
  assert.equal(typeof worker.listener, 'function');
  const openedAt = 1_800_000_000_000;
  const response = await send(worker.listener, {
    type: 'pt_trade_event',
    kind: 'buy',
    opened: true,
    session: {
      sessionId: 'pts-worker-fixture',
      mint: MINT,
      symbol: 'BONK',
      name: 'Bonk',
      site: 'padre',
      openedAt,
    },
    trade: { id: 't1', sessionId: 'pts-worker-fixture', ts: openedAt, side: 'buy' },
  });

  assert.equal(response.ok, true);
  const replays = worker.values.pt_replays;
  assert.equal(replays.length, 1, 'a paper fill must create one session replay');
  assert.equal(replays[0].sessionId, 'pts-worker-fixture');
  assert.equal(replays[0].mint, MINT);

  const closedAt = openedAt + 120_000;
  const closed = await send(worker.listener, {
    type: 'pt_trade_event', kind: 'sell', opened: false,
    session: { sessionId: 'pts-worker-fixture', mint: MINT, symbol: 'BONK', name: 'Bonk',
      site: 'padre', openedAt, closedAt },
    trade: { id: 't2', sessionId: 'pts-worker-fixture', ts: closedAt, side: 'sell' },
    round: { id: 'round-worker', sessionId: 'pts-worker-fixture', mint: MINT, symbol: 'BONK',
      name: 'Bonk', site: 'padre', openedAt, closedAt, heldMs: 120_000,
      investedSol: 1, returnedSol: 1.2, pnlSol: 0.2, pnlPct: 20 },
  });
  assert.equal(closed.ok, true);
  assert.equal(worker.values.pt_replays[0].status, 'closed');
  assert.equal(worker.values.pt_replays[0].roundId, 'round-worker');
});

test('isAllowedEndpoint blocks SSRF targets and allows public endpoints', () => {
  const worker = serviceWorker();
  const allow = worker.isAllowedEndpoint;
  assert.equal(typeof allow, 'function');

  // Valid public endpoints.
  assert.equal(allow('https://api.openai.com/v1'), true);
  assert.equal(allow('http://api.openai.com/v1'), true);
  assert.equal(allow('https://ai.example.com:8443/path'), true);

  // Non-HTTP(S) and malformed URLs.
  assert.equal(allow('ftp://api.openai.com/v1'), false);
  assert.equal(allow('file:///etc/passwd'), false);
  assert.equal(allow('not a url'), false);
  assert.equal(allow(''), false);

  // URLs with credentials are rejected.
  assert.equal(allow('https://user:pass@api.openai.com/v1'), false);

  // Cloud metadata / link-local always blocked, even with local opt-in.
  assert.equal(allow('http://169.254.169.254/latest/meta-data/'), false);
  assert.equal(allow('http://169.254.169.254/latest/meta-data/', true), false);

  // Localhost / loopback blocked by default, allowed with opt-in.
  assert.equal(allow('http://127.0.0.1:8765/v1'), false);
  assert.equal(allow('http://127.1:8765/v1'), false);
  assert.equal(allow('http://0x7f000001:8765/v1'), false);
  assert.equal(allow('http://2130706433:8765/v1'), false);
  assert.equal(allow('http://localhost:8765/v1'), false);
  assert.equal(allow('http://localhost.:8765/v1'), false, 'trailing-dot localhost must be treated as localhost');
  assert.equal(allow('http://localhost.localdomain:8765/v1'), false);
  assert.equal(allow('http://127.0.0.1:8765/v1', true), true);
  assert.equal(allow('http://localhost:8765/v1', true), true);
  assert.equal(allow('http://localhost.:8765/v1', true), true);

  // Private ranges blocked by default, allowed with opt-in.
  assert.equal(allow('http://10.0.0.1/v1'), false);
  assert.equal(allow('http://172.16.0.1/v1'), false);
  assert.equal(allow('http://192.168.1.1/v1'), false);
  assert.equal(allow('http://100.64.0.1/v1'), false);
  assert.equal(allow('http://10.0.0.1/v1', true), true);
  assert.equal(allow('http://192.168.1.1/v1', true), true);

  // 0.0.0.0 always blocked.
  assert.equal(allow('http://0.0.0.0/v1'), false);
  assert.equal(allow('http://0.0.0.0/v1', true), false);

  // IPv6 loopback and link-local.
  assert.equal(allow('http://[::]/v1'), false, 'unspecified IPv6 must be blocked unconditionally');
  assert.equal(allow('http://[::]/v1', true), false);
  assert.equal(allow('http://[::1]/v1'), false);
  assert.equal(allow('http://[::1]/v1', true), true);
  assert.equal(allow('http://[fe80::1]/v1'), false);
  assert.equal(allow('http://[::ffff:127.0.0.1]/v1'), false);
  assert.equal(allow('http://[::ffff:192.168.1.1]/v1', true), true);
});

test('ai proxy blocks disallowed endpoints and fetches allowed ones', async () => {
  const worker = serviceWorker();

  // Malicious cloud metadata endpoint is rejected with no network call.
  worker.values.pt_settings = {
    aiEndpoint: 'http://169.254.169.254/latest/meta-data/',
    aiAllowLocalEndpoint: false,
  };
  const blocked = await send(worker.listener, { type: 'pt_ai_chat', messages: [], maxTokens: 100 });
  assert.ok(blocked.error, 'blocked endpoint must return an error');
  assert.equal(worker.fetchCalls.length, 0, 'no network call for blocked endpoint');

  // Public endpoint is fetched.
  worker.values.pt_settings = {
    aiEndpoint: 'https://api.openai.com/v1',
    aiAllowLocalEndpoint: false,
  };
  const models = await send(worker.listener, { type: 'pt_ai_models' });
  assert.equal(Array.isArray(models.models), true);
  assert.ok(worker.fetchCalls.some((u) => u.startsWith('https://api.openai.com/v1/models')), 'public endpoint is fetched');

  // Local endpoint is rejected unless explicitly allowed.
  worker.values.pt_settings = {
    aiEndpoint: 'http://127.0.0.1:8765/v1',
    aiAllowLocalEndpoint: false,
  };
  const localBlocked = await send(worker.listener, { type: 'pt_ai_models' });
  assert.ok(localBlocked.error, 'local endpoint blocked when opt-in is off');

  worker.values.pt_settings = {
    aiEndpoint: 'http://127.0.0.1:8765/v1',
    aiAllowLocalEndpoint: true,
  };
  worker.fetchCalls.length = 0;
  const localAllowed = await send(worker.listener, { type: 'pt_ai_models' });
  assert.equal(Array.isArray(localAllowed.models), true);
  assert.ok(worker.fetchCalls.some((u) => u.startsWith('http://127.0.0.1:8765/v1/models')), 'local endpoint fetched when opt-in is on');

  // Legacy default local endpoint is migrated to empty and rejected.
  worker.values.pt_settings = {
    aiEndpoint: 'http://127.0.0.1:8765/v1',
    aiAllowLocalEndpoint: false,
    settingsRevision: 3,
  };
  const migrated = await send(worker.listener, { type: 'pt_ai_chat', messages: [], maxTokens: 100 });
  assert.ok(migrated.error, 'legacy default endpoint is migrated away');
});

test('a blank endpoint keeps the coach off: chat errors, models return empty, no fetch', async () => {
  const worker = serviceWorker();
  worker.values.pt_settings = { aiEndpoint: '', aiAllowLocalEndpoint: true };

  const chat = await send(worker.listener, {
    type: 'pt_ai_chat', messages: [{ role: 'user', content: 'hi' }], maxTokens: 50,
  });
  assert.ok(chat.error, 'chat with no endpoint must error instead of guessing one');
  assert.match(chat.error, /No AI endpoint configured/i);

  const models = await send(worker.listener, { type: 'pt_ai_models' });
  assert.equal(models.models.length, 0, 'no endpoint means no models, silently');
  assert.equal(worker.fetchCalls.length, 0,
    'an empty endpoint must never reach the network — it is the coach being off');
});

/* -------------------- frame snapshots: right tab only -------------------- */

function fillEvent(sessionId) {
  const ts = 1_800_000_000_000;
  return {
    type: 'pt_trade_event', kind: 'buy', opened: true,
    session: { sessionId, mint: MINT, symbol: 'BONK', name: 'Bonk', site: 'padre', openedAt: ts },
    trade: { id: 't1', sessionId, ts, side: 'buy' },
  };
}

test('a fill snapshot photographs the trading tab’s own window, not the focused one', async () => {
  const worker = serviceWorker();
  worker.values.pt_settings = Object.assign({}, worker.values.pt_settings,
    { framesEnabled: true, recordingEnabled: false });
  // The trading tab is id 1 (that is what sender.tab.id reports), active in
  // window 3. Whatever window the user is actually looking at is irrelevant.
  worker.values.tabsById = { 1: { id: 1, active: true, windowId: 3 } };

  await send(worker.listener, fillEvent('pts-frame-window'));

  assert.deepEqual(worker.captureCalls, [3],
    'captureVisibleTab must be asked for the trading tab’s window (3), never the focused window');
});

test('when the trading tab is hidden there is no honest frame, so none is captured', async () => {
  const worker = serviceWorker();
  worker.values.pt_settings = Object.assign({}, worker.values.pt_settings,
    { framesEnabled: true, recordingEnabled: false });
  // The tab that traded is no longer the visible tab of its window.
  worker.values.tabsById = { 1: { id: 1, active: false, windowId: 3 } };

  await send(worker.listener, fillEvent('pts-frame-hidden'));

  assert.deepEqual(worker.captureCalls, [],
    'a hidden trading tab must skip the frame instead of photographing some other screen');
});

test('a closed trading tab yields no frame either', async () => {
  const worker = serviceWorker();
  worker.values.pt_settings = Object.assign({}, worker.values.pt_settings,
    { framesEnabled: true, recordingEnabled: false });
  worker.values.tabsById = {}; // tab 1 no longer exists

  await send(worker.listener, fillEvent('pts-frame-closed'));

  assert.deepEqual(worker.captureCalls, [],
    'a vanished tab cannot be depicted; the frame must be skipped, not guessed');
});

