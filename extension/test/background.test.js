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
      trenchBrainEnabled: true,
      trenchBrainEndpoint: 'http://127.0.0.1:8772/api',
      trenchBrainCaptureIntervalSec: 60,
    },
    pt_state: { positions: {}, rounds: [], journal: [] },
  };
  let messageListener = null;
  const fetchCalls = [];
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
        captureVisibleTab: async () => 'data:image/jpeg;base64,',
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
  return { values, fetchCalls, get listener() { return messageListener; } };
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

