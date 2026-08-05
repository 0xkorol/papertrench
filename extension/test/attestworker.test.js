/* The service worker as the attestation chain's single writer (DEFECT F-14).
 *
 * The chain used to live inside pt_state: every tab appended to its own copy
 * and full-state writes raced — last write wins, links lost, and every fill
 * paid for the whole lifetime record. These tests boot the REAL background.js
 * and prove the replacement: pt_attest_append is serialized in the worker,
 * the one-time migration moves a legacy in-state chain into segments without
 * changing a single hash, and a pre-update tab writing the chain back cannot
 * fork the record.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const AT = require('../attest.js');
const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

function fill(over) {
  return Object.assign({
    id: 't1', sessionId: 'pts-a', mint: MINT, side: 'buy',
    qty: 1000, priceNative: 0.001, solGross: 1, ts: 1_000_000,
  }, over || {});
}

/** A valid legacy chain, exactly as the old commitFill built it in-state. */
async function chainOf(fills) {
  const links = [];
  let prev = AT.GENESIS;
  for (const f of fills) {
    const link = await AT.appendFill(prev, f);
    link.seq = links.length;
    links.push(link);
    prev = link.hash;
  }
  return links;
}

function serviceWorker(opts = {}) {
  const values = Object.assign({
    pt_settings: { framesEnabled: false, recordingEnabled: false, autoReview: false },
    pt_state: { positions: {}, rounds: [], journal: [], seq: 7 },
  }, opts.values || {});
  let messageListener = null;
  const storageListeners = [];
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
    const changes = {};
    for (const key of Object.keys(update)) changes[key] = { newValue: update[key], oldValue: values[key] };
    Object.assign(values, update);
    for (const fn of storageListeners) { try { fn(changes, 'local'); } catch (_) {} }
    if (callback) callback();
    return Promise.resolve();
  };

  const sandbox = {
    console, Promise, JSON, Math, Date, Number, String, Array, Object, Boolean,
    RegExp, Error, Set, Map, URL, URLSearchParams, AbortController, Uint8Array,
    TextEncoder, crypto: globalThis.crypto,
    setTimeout, clearTimeout, setInterval: () => 1, clearInterval: () => {},
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    chrome: {
      storage: {
        local: { get, set },
        // The attest watcher re-arms migration when a pre-update tab writes
        // the chain back into pt_state — the fold path under test here.
        onChanged: { addListener: (fn) => storageListeners.push(fn) },
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
        query: (query, callback) => callback([]),
        sendMessage: async () => ({}),
        captureVisibleTab: async () => 'data:image/jpeg;base64,',
        get: async () => { throw new Error('no tab'); },
        onRemoved: { addListener: () => {} },
        onUpdated: { addListener: () => {} },
        onActivated: { addListener: () => {} },
      },
      windows: { update: async () => ({}) },
      offscreen: { hasDocument: async () => false, createDocument: async () => {} },
      alarms: { clear: async () => true, create: () => {}, onAlarm: { addListener: () => {} } },
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
    values,
    writeStorage: (update) => set(update),
    get listener() { return messageListener; },
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

/** The chain as a reader (dashboard, verifier) would reassemble it. */
async function storedChain(values) {
  const store = { get: async (keys) => {
    const out = {};
    for (const key of keys) if (Object.hasOwn(values, key)) out[key] = values[key];
    return out;
  } };
  return AT.readChainStore(store.get);
}

/* ---------------- the single writer ---------------- */

test('pt_attest_append commits into the segmented store, not into pt_state', async () => {
  const worker = serviceWorker();

  const first = await send(worker.listener, { type: 'pt_attest_append', trade: fill({ id: 't1', ts: 1_000 }) });
  assert.equal(first.ok, true);
  assert.equal(first.seq, 0);

  const second = await send(worker.listener, {
    type: 'pt_attest_append',
    trade: fill({ id: 't2', side: 'sell', solGross: 2, ts: 2_000 }),
  });
  assert.equal(second.ok, true);
  assert.equal(second.seq, 1);

  const { meta, chain } = await storedChain(worker.values);
  assert.equal(meta.length, 2);
  assert.equal(meta.head, second.head);
  assert.equal(chain[1].prev, chain[0].hash);
  assert.equal((await AT.verifyChain(chain)).valid, true);
  assert.equal(worker.values.pt_state.attestChain, undefined,
    'the wallet state must never carry the chain again — that ride is what F-14 removed');
});

test('concurrent appends serialize instead of forking the chain', async () => {
  const worker = serviceWorker();

  // Two tabs fill at once: both messages are in flight before either lands.
  // The old in-state design lost one of these to last-write-wins.
  const [a, b] = await Promise.all([
    send(worker.listener, { type: 'pt_attest_append', trade: fill({ id: 'tab-a', ts: 1_000 }) }),
    send(worker.listener, { type: 'pt_attest_append', trade: fill({ id: 'tab-b', ts: 1_001 }) }),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.deepEqual([a.seq, b.seq].sort(), [0, 1], 'both fills must land, in some serial order');

  const { chain } = await storedChain(worker.values);
  assert.equal(chain.length, 2, 'neither append may overwrite the other');
  assert.equal((await AT.verifyChain(chain)).valid, true, 'a fork would break the second link');
});

test('a storage write failure answers ok:false — commitFill needs it for the F-28 toast', async () => {
  const worker = serviceWorker({ failWrites: true });
  const response = await send(worker.listener, { type: 'pt_attest_append', trade: fill() });
  assert.equal(response.ok, false, 'a link that was not committed must never be reported as committed');
});

test('garbage trades are refused without disturbing the store', async () => {
  const worker = serviceWorker();
  const response = await send(worker.listener, { type: 'pt_attest_append', trade: null });
  assert.equal(response.ok, false);
  assert.equal(worker.values[AT.CHAIN_META_KEY], undefined);
});

/* ---------------- migration ---------------- */

test('migration moves the legacy in-state chain with every hash intact', async () => {
  const legacy = await chainOf([
    fill({ id: 't1', ts: 1_000 }),
    fill({ id: 't2', ts: 2_000 }),
    fill({ id: 't3', side: 'sell', solGross: 2, ts: 3_000 }),
  ]);
  const worker = serviceWorker({
    values: { pt_state: { positions: {}, rounds: [], journal: [], seq: 7, attestChain: legacy.map((l) => ({ ...l })) } },
  });

  const response = await send(worker.listener, { type: 'pt_attest_migrate' });
  assert.equal(response.ok, true);

  assert.equal(worker.values.pt_state.attestChain, undefined, 'the chain must leave pt_state');
  assert.equal(worker.values.pt_state.seq, 8,
    'the strip must advance the write counter, or open tabs clobber it on their next heartbeat');

  const { meta, chain } = await storedChain(worker.values);
  assert.equal(meta.length, 3);
  assert.deepEqual(chain.map((l) => l.hash), legacy.map((l) => l.hash),
    'a migration that re-derived hashes would invalidate every copy of the record');
  assert.equal((await AT.verifyChain(chain)).valid, true);
});

test('the first append migrates implicitly, then extends the moved chain', async () => {
  const legacy = await chainOf([fill({ id: 't1', ts: 1_000 }), fill({ id: 't2', ts: 2_000 })]);
  const worker = serviceWorker({
    values: { pt_state: { positions: {}, rounds: [], journal: [], seq: 3, attestChain: legacy.map((l) => ({ ...l })) } },
  });

  const response = await send(worker.listener, { type: 'pt_attest_append', trade: fill({ id: 't3', ts: 3_000 }) });
  assert.equal(response.ok, true);
  assert.equal(response.seq, 2, 'the new link must continue the migrated chain, not restart it');

  const { chain } = await storedChain(worker.values);
  assert.equal(chain.length, 3);
  assert.equal(chain[2].prev, legacy[1].hash, 'the append must chain from the migrated head');
  assert.equal((await AT.verifyChain(chain)).valid, true);
  assert.equal(worker.values.pt_state.attestChain, undefined);
});

test('a pre-update tab writing the chain back cannot fork the record', async () => {
  const legacy = await chainOf([
    fill({ id: 't1', ts: 1_000 }),
    fill({ id: 't2', ts: 2_000 }),
  ]);
  const worker = serviceWorker({
    values: { pt_state: { positions: {}, rounds: [], journal: [], seq: 5, attestChain: legacy.map((l) => ({ ...l })) } },
  });

  // Migrate, then let the worker commit one more fill the old tab never saw.
  await send(worker.listener, { type: 'pt_attest_migrate' });
  await send(worker.listener, { type: 'pt_attest_append', trade: fill({ id: 'worker-3', ts: 3_000 }) });

  // The pre-update tab still holds the 2-link chain in memory, fills once
  // more, and heartbeats the whole thing back into pt_state.
  const orphan = await AT.appendFill(legacy[1].hash, fill({ id: 'orphan-4', ts: 4_000 }));
  orphan.seq = 2;
  const resurrected = { positions: {}, rounds: [], journal: [], seq: 9, attestChain: [...legacy.map((l) => ({ ...l })), orphan] };
  await worker.writeStorage({ pt_state: resurrected });

  // The storage watcher re-arms migration; a serialized no-op message
  // afterwards guarantees the fold has finished before we look.
  await send(worker.listener, { type: 'pt_attest_migrate' });

  const { chain } = await storedChain(worker.values);
  assert.equal(chain.length, 4, 'the orphaned fill is evidence — it must be folded in, never dropped');
  assert.deepEqual(chain.slice(0, 2).map((l) => l.hash), legacy.map((l) => l.hash),
    'links already in the store must not be duplicated or rewritten');
  const folded = chain[3];
  assert.equal(folded.id, 'orphan-4', 'the fill facts must survive the fold');
  assert.equal(folded.ts, 4_000);
  assert.equal(folded.prev, chain[2].hash, 'the folded link must chain from the CURRENT head, resolving the fork');
  assert.equal((await AT.verifyChain(chain)).valid, true);
  assert.equal(worker.values.pt_state.attestChain, undefined, 'the resurrected copy must be stripped again');
});
