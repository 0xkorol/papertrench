/* Service-worker globals.
 *
 * The on-chain feed shipped completely dead because onchain.js assigned its
 * API to `window`, which does not exist in a service worker. PTOnchain was
 * undefined there, describePool threw, watch() swallowed the error and
 * returned false — indistinguishable from "this pool has no decoder".
 *
 * Result: every price came from the aggregator, the position never re-marked,
 * and the P&L sat at zero. These tests make that impossible to repeat.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

/** Every script the background worker imports. */
function workerScripts() {
  const src = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  const m = /importScripts\(([^)]*)\)/.exec(src);
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

test('every worker-imported script installs itself on the worker global', () => {
  for (const file of workerScripts()) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const installsGlobal = /(window|self)\.[A-Za-z]/.test(src);
    if (!installsGlobal) continue;
    assert.match(src, /typeof self !== 'undefined'/,
      `${file} runs in the service worker but never assigns to self — its API would be undefined there`);
  }
});

test('the modules the feed depends on are actually reachable in a worker', () => {
  // Simulate the worker: `self` exists, `window` does not.
  const selfObj = {};
  selfObj.self = selfObj;
  const ctx = vm.createContext({
    self: selfObj,
    atob: (b) => Buffer.from(b, 'base64').toString('binary'),
    fetch: async () => ({ ok: true, json: async () => ({ result: null }) }),
    Uint8Array, Map, Set, Promise, JSON, Math, Date, Number, String, Array,
    Object, Boolean, Error, RegExp, Infinity, isFinite, parseInt, parseFloat,
    setTimeout, clearTimeout, AbortController: function () { this.signal = {}; this.abort = () => {}; },
    WebSocket: function () { this.close = () => {}; },
    console: { error: () => {}, warn: () => {}, log: () => {} },
  });

  for (const file of ['onchain.js', 'rpc-pool.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), ctx, { filename: file });
  }

  assert.equal(typeof selfObj.PTOnchain, 'object',
    'PTOnchain must exist in the worker or the feed cannot decode a single pool');
  assert.equal(typeof selfObj.PTRpcPool, 'object',
    'PTRpcPool must exist in the worker or no RPC call can be made');
  assert.equal(typeof selfObj.PTOnchain.poolKindForOwner, 'function',
    'the decoder entry point the feed calls must be present');
});

test('the feed reports a missing dependency instead of failing silently', () => {
  const src = fs.readFileSync(path.join(ROOT, 'onchain-feed.js'), 'utf8');
  assert.match(src, /if \(!O \|\| !POOL\)/,
    'a missing dependency must be detected explicitly');
  assert.match(src, /console\.error\('PaperTrench: on-chain feed disabled/,
    'a dead feed must announce itself rather than look like an unsupported pool');
});

test('a watch failure surfaces its real error rather than being swallowed', () => {
  const src = fs.readFileSync(path.join(ROOT, 'onchain-feed.js'), 'utf8');
  assert.doesNotMatch(src, /describePool\(poolAddress, mint\)\.catch\(\(\) => null\)/,
    'swallowing the error here is what hid a completely broken feed for a release');
  assert.match(src, /console\.error\('PaperTrench: on-chain watch failed:'/,
    'a real fault must be logged');
});

test('every shared library installs itself on window for the page', () => {
  const entry = manifest.content_scripts.find((cs) => (cs.js || []).includes('content.js'));
  for (const file of entry.js) {
    // content.js is the consumer, not a library: it reads these globals rather
    // than exporting any.
    if (file === 'content.js') continue;
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    // Only files that actually EXPORT an api need a guard.
    if (!/^\s*(if \(typeof (window|self)|(window|self)\.(PT|Paper)\w+ =)/m.test(src)) continue;
    assert.match(src, /typeof window !== 'undefined'/,
      `${file} is loaded into the page and must assign its API to window`);
  }
});
