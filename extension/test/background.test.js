const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

function serviceWorker(opts = {}) {
  const values = {
    pt_settings: {
      framesEnabled: false,
      recordingEnabled: false,
      autoReview: false,
    },
    pt_state: { positions: {}, rounds: [], journal: [] },
  };
  let messageListener = null;
  let externalListener = null;
  const fetchCalls = [];
  const captureCalls = [];
  // Real Chrome exposes a storage failure by setting chrome.runtime.lastError
  // for the duration of the callback only; reading it outside a callback is
  // meaningless. The fail flags reproduce that exact shape.
  const failingCallback = (callback, result) => {
    sandbox.chrome.runtime.lastError = { message: 'quota exceeded (test)' };
    try { if (callback) callback(result); }
    finally { delete sandbox.chrome.runtime.lastError; }
  };
  const get = (keys, callback) => {
    if (opts.failReads) { failingCallback(callback, {}); return undefined; }
    const names = Array.isArray(keys) ? keys : Object.keys(keys || {});
    const result = {};
    for (const key of names) if (Object.hasOwn(values, key)) result[key] = values[key];
    if (callback) { callback(result); return undefined; }
    return Promise.resolve(result);
  };
  const set = (update, callback) => {
    if (opts.failWrites) { failingCallback(callback); return Promise.resolve(); }
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
    TextEncoder,
    crypto, // attest.js hashes through WebCrypto; Node's global implements it
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
        onMessageExternal: { addListener: (listener) => { externalListener = listener; } },
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
        // The warm-links viewer registers these at import time.
        onRemoved: { addListener: () => {} },
        onUpdated: { addListener: () => {} },
        onActivated: { addListener: () => {} },
      },
      windows: { update: async () => ({}) },
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
  return {
    values, fetchCalls, captureCalls,
    get listener() { return messageListener; },
    get external() { return externalListener; },
    get isAllowedEndpoint() { return context.isAllowedEndpoint; },
    get storage() {
      return {
        getSettings: context.getSettings,
        getState: context.getState,
        setState: context.setState,
        getReplays: context.getReplays,
        setReplays: context.setReplays,
      };
    },
  };
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

test('a failed storage read resolves to safe defaults instead of acting on garbage', async () => {
  // chrome.storage.local.get reports failure via chrome.runtime.lastError in
  // the callback; ignoring it means treating {} as real data. The worker must
  // fall back to defaults (settings), null (state), or an empty list (replays).
  const worker = serviceWorker({ failReads: true });

  const settings = await worker.storage.getSettings();
  assert.equal(settings.framesEnabled, true, 'a failed read falls back to default settings');
  assert.equal(settings.aiEndpoint, '', 'a failed read must not invent an AI endpoint');

  assert.equal(await worker.storage.getState(), null,
    'a failed state read resolves null, never a fake wallet');

  const replays = await worker.storage.getReplays();
  assert.equal(Array.isArray(replays), true, 'a failed replays read resolves a list');
  assert.equal(replays.length, 0, 'a failed replays read resolves an empty list');
});

test('background state writes advance the seq counter so tabs adopt them', async () => {
  // DEFECT D-13: content tabs adopt a stored state only when its seq is
  // STRICTLY greater than their own. The background's writers (AI review,
  // recording refs) wrote at the seq they read — invisible to every tab and
  // overwritten by the next 800 ms heartbeat. That is how AI reviews and
  // recording filenames vanished from the dashboard within a second.
  const worker = serviceWorker();

  await worker.storage.setState({ seq: 5, cashSol: 3 });
  assert.equal(worker.values.pt_state.seq, 6,
    'a background write must land strictly ahead of the seq it read');

  await worker.storage.setState({ cashSol: 3 });
  assert.equal(worker.values.pt_state.seq, 1,
    'a state missing seq starts the counter rather than staying invisible');
});

test('a failed storage write resolves instead of hanging the caller', async () => {
  const worker = serviceWorker({ failWrites: true });

  // Both writes must settle — an unresolved promise here would wedge every
  // awaiting message handler in the worker.
  await worker.storage.setState({ cashSol: 5 });
  await worker.storage.setReplays([]);

  assert.equal(worker.values.pt_state.positions instanceof Object, true,
    'the failed write must not corrupt what storage already held');
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

/* ---------------- site bridge (leaderboard sync) ----------------
 *
 * The one external surface the extension has. These tests lock its three
 * promises: only papertrench.com is answered, nothing is served until the
 * user turns Site sync on, and what IS served is the same buildSubmission
 * evidence the manual export produces — never a diverging second story.
 */

function sendExternal(listener, message, sender) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('bridge response timed out')), 2000);
    listener(message, sender, (response) => { clearTimeout(timeout); resolve(response); });
  });
}

const SITE_SENDER = { origin: 'https://papertrench.com' };

function bridgeTrade(over) {
  return Object.assign({
    id: 'bt1', sessionId: 'pts-bridge', mint: MINT, side: 'buy',
    qty: 1000, priceNative: 0.001, solGross: 1, solNet: 0.99, ts: 1_000_000,
  }, over || {});
}

test('the bridge refuses every origin but papertrench.com', async () => {
  const worker = serviceWorker();
  const res = await sendExternal(worker.external,
    { type: 'pt_bridge_get_record' }, { origin: 'https://evil.example' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'origin-not-allowed');
});

test('the bridge is off by default — the site is told, never served', async () => {
  const worker = serviceWorker();
  const res = await sendExternal(worker.external, { type: 'pt_bridge_get_record' }, SITE_SENDER);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'bridge-disabled');
  const ping = await sendExternal(worker.external, { type: 'pt_bridge_ping' }, SITE_SENDER);
  assert.equal(ping.ok, true);
  assert.equal(ping.bridgeEnabled, false);
});

test('with Site sync on, the bridge serves buildSubmission evidence from the real chain', async () => {
  const worker = serviceWorker();
  worker.values.pt_settings = Object.assign({}, worker.values.pt_settings,
    { leaderboardBridge: true, balanceStartSol: 10 });
  const first = await send(worker.listener, { type: 'pt_attest_append', trade: bridgeTrade() });
  assert.equal(first.ok, true, first.error);
  const second = await send(worker.listener, { type: 'pt_attest_append', trade: bridgeTrade({
    id: 'bt2', side: 'sell', priceNative: 0.002, solGross: 2, solNet: 1.98, ts: 1_060_000,
  }) });
  assert.equal(second.ok, true, second.error);

  const res = await sendExternal(worker.external, { type: 'pt_bridge_get_record' }, SITE_SENDER);
  assert.equal(res.ok, true);
  assert.equal(res.payload.chain.length, 2);
  assert.equal(res.payload.head, res.payload.chain[1].hash);
  assert.equal(res.payload.claim.startingBalanceSol, 10);
  // The claim mirrors the chain replay — one story, told twice.
  assert.ok(Math.abs(res.payload.claim.realizedPnlSol - (1.98 - 0.99)) < 1e-9);
  assert.equal(typeof res.payload.trustModel, 'string');
});

test('an empty chain is not served as evidence of anything', async () => {
  const worker = serviceWorker();
  worker.values.pt_settings = Object.assign({}, worker.values.pt_settings,
    { leaderboardBridge: true });
  const res = await sendExternal(worker.external, { type: 'pt_bridge_get_record' }, SITE_SENDER);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'chain-empty');
});

test('unknown bridge requests are refused by name', async () => {
  const worker = serviceWorker();
  const res = await sendExternal(worker.external, { type: 'pt_bridge_drop_tables' }, SITE_SENDER);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'unknown-request');
});

