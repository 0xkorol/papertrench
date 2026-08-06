/* Fill receipts — the instrument the fill path never had.
 *
 * The product could time link routing and page jank, but nothing measured the
 * fill, so every claim about fill latency was an argument. These tests pin the
 * three properties that make the number trustworthy rather than merely present:
 * it rides the one write chain, it accepts nothing page-derived, and it can
 * never be mistaken for a wall clock.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
// vm-realm objects carry a foreign prototype; compare structurally.
const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const contentJs = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
const backgroundJs = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');

/* ---------------- the measurement, in content.js ---------------- */

test('the fill is measured on the real path, at both ends of both trades', () => {
  for (const fn of ['async function doBuy(', 'async function doSellInner(']) {
    const start = contentJs.indexOf(fn);
    assert.ok(start !== -1, `${fn} must exist`);
    const body = contentJs.slice(start, contentJs.indexOf('\n  }', start));
    assert.match(body, /const tClick = perfNow\(\);/,
      `${fn} must mark the click`);
    assert.match(body, /const tQuoted = perfNow\(\);/,
      `${fn} must mark the moment a fresh price is in hand`);
    assert.match(body, /const tCommitted = perfNow\(\);/,
      `${fn} must mark the moment the wallet write returned`);
    assert.match(body, /noteFillTiming\('(buy|sell)', tClick, tQuoted, tCommitted\)/,
      `${fn} must report its stages`);
    // The quote mark must come BEFORE the commit mark, or the stages are lies.
    assert.ok(body.indexOf('const tClick') < body.indexOf('const tQuoted'),
      'the click is marked before the quote');
    assert.ok(body.indexOf('const tQuoted') < body.indexOf('const tCommitted'),
      'the quote is marked before the commit');
  }
});

test('measurement never moves what it measures', () => {
  const start = contentJs.indexOf('function noteFillTiming(');
  const fn = contentJs.slice(start, contentJs.indexOf('\n  }', start));
  assert.ok(start !== -1, 'noteFillTiming must exist');
  assert.ok(!/\bawait\b/.test(fn),
    'the reporter must not be awaited into the fill path');
  assert.match(fn, /\.catch\(\(\) => \{\}\)/,
    'a failed report must never surface as a failed fill');
  // Reporting happens inside the SUCCESS branch, after the trader has been
  // told. (Deliberately not `lastIndexOf('toast(')` — the last toast in each
  // function is the catch block's failure message, which legitimately sits
  // after the measurement and would make this assertion lie.)
  for (const fn2 of ['async function doBuy(', 'async function doSellInner(']) {
    const at = contentJs.indexOf(fn2);
    const body = contentJs.slice(at, contentJs.indexOf('\n  }', at));
    const successAt = body.indexOf('if (result) {');
    const noteAt = body.indexOf('noteFillTiming(');
    assert.ok(successAt !== -1 && noteAt > successAt,
      'the measurement is only taken when a fill actually happened');
    const confirmAt = body.indexOf('toast(', successAt);
    assert.ok(confirmAt !== -1 && confirmAt < noteAt,
      'the confirmation reaches the trader before the measurement is sent');
  }
});

test('no wall clock may sit near a fill measurement', () => {
  const start = contentJs.indexOf('function noteFillTiming(');
  const fn = contentJs.slice(start, contentJs.indexOf('\n  }', start));
  assert.ok(!/Date\.now\(\)|new Date\(/.test(fn),
    'a fill already carries an attestation ts — a second time-like number beside it '
    + 'that could be read as the fill time is a footgun in the one record that must '
    + 'never be ambiguous. performance.now deltas only.');
  assert.match(fn, /perfNow\(\)/, 'stages are monotonic deltas');
  const clock = contentJs.slice(contentJs.indexOf('function perfNow()'), contentJs.indexOf('function noteFillTiming('));
  assert.ok(!/Date\.now\(\)/.test(clock),
    'the clock helper must never fall back to a wall clock — no clock means no receipt');
  assert.match(clock, /NaN/, 'a missing monotonic clock yields NaN, which the validation drops');
});

test('nothing page-derived enters the receipt', () => {
  const start = contentJs.indexOf('function noteFillTiming(');
  const fn = contentJs.slice(start, contentJs.indexOf('\n  }', start));
  for (const forbidden of ['mint', 'symbol', 'hostname', 'location.', 'token.']) {
    assert.ok(!fn.includes(forbidden),
      `${forbidden} must never ride a receipt — the stats key must gain no `
      + 'attacker-writable string, so there is nothing to escape at render time');
  }
  assert.match(fn, /kind: kind === 'sell' \? 'sell' : 'buy'/,
    'the only non-numeric field is a closed two-value enum, normalized here');
});

/* ---------------- the merge, in background.js ---------------- */

test('the fill merge rides the SAME write chain as the other receipts', () => {
  const start = backgroundJs.indexOf('function turboFillNote(');
  const fn = backgroundJs.slice(start, backgroundJs.indexOf('\n}', start));
  assert.ok(start !== -1, 'turboFillNote must exist');
  assert.match(fn, /turboChain = turboChain/,
    'three writers on one key must share one chain or they lose each others writes');
  assert.ok(!/fetch\(/.test(fn), 'receipts never leave the device');
  assert.match(fn, /TURBO_RING_MAX/, 'the rings stay bounded');
});

function fillWorker() {
  const values = { pt_settings: {}, pt_state: { positions: {}, rounds: [], journal: [] } };
  const session = {};
  let messageListener = null;
  const sandbox = {
    console: { debug: () => {}, warn: () => {}, error: () => {}, log: () => {} },
    Promise, JSON, Math, Date, Number, String, Array, Object, Boolean, RegExp,
    Error, Set, Map, URL, URLSearchParams, AbortController, Uint8Array,
    setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 1, clearInterval: () => {},
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    chrome: {
      storage: {
        local: {
          get: (keys, cb) => {
            const names = Array.isArray(keys) ? keys : Object.keys(keys || {});
            const out = {};
            for (const k of names) if (Object.hasOwn(values, k)) out[k] = values[k];
            // A tick later, so unserialized read-modify-writes could interleave.
            setImmediate(() => cb(out));
          },
          set: (u, cb) => { Object.assign(values, u); setImmediate(() => cb && cb()); },
        },
        session: {
          get: (k, cb) => cb({}), set: (u, cb) => cb && cb(), remove: (k, cb) => cb && cb(),
        },
      },
      runtime: {
        id: 'pt-test', openOptionsPage: () => {},
        onMessage: { addListener: (l) => { messageListener = l; } },
        onStartup: { addListener: () => {} }, onInstalled: { addListener: () => {} },
        sendMessage: async () => ({}),
      },
      tabs: {
        create: async () => ({ id: 1 }), update: async () => ({}),
        get: async () => { throw new Error('none'); }, remove: async () => {},
        query: (q, cb) => cb([]), sendMessage: async () => ({}),
        captureVisibleTab: async () => '',
        onRemoved: { addListener: () => {} }, onUpdated: { addListener: () => {} },
        onActivated: { addListener: () => {} },
      },
      windows: { update: async () => {} },
      offscreen: { hasDocument: async () => false, createDocument: async () => {} },
      scripting: {
        getRegisteredContentScripts: async () => [],
        registerContentScripts: async () => {}, unregisterContentScripts: async () => {},
      },
    },
  };
  sandbox.self = sandbox; sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  sandbox.importScripts = (...files) => {
    for (const f of files) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  };
  vm.runInContext(backgroundJs, ctx, { filename: 'background.js' });
  return {
    values,
    send: (msg) => new Promise((resolve) => {
      const async_ = messageListener(msg, { tab: { id: 1 } }, resolve);
      if (async_ !== true) resolve();
    }),
    settle: () => new Promise((r) => setTimeout(r, 0)),
  };
}

test('fills fold into bounded per-stage rings, per kind', async () => {
  const w = fillWorker();
  await w.send({ type: 'pt_turbo_fill', kind: 'buy', quoteMs: 120, commitMs: 40, paintMs: 5, totalMs: 165 });
  await w.settle(); await w.settle();
  await w.send({ type: 'pt_turbo_fill', kind: 'sell', quoteMs: 90, commitMs: 30, paintMs: 4, totalMs: 124 });
  await w.settle(); await w.settle();

  const fills = (w.values.pt_turbo_stats || {}).fills || {};
  assert.equal(fills.buy.count, 1, 'the buy is counted');
  assert.equal(fills.sell.count, 1, 'the sell is counted separately');
  assert.deepEqual(plain(fills.buy.commitMs), [40], 'the stage OURS to fix is recorded on its own');
  assert.deepEqual(plain(fills.buy.quoteMs), [120], 'the network stage stays separate — never folded into a total we take credit for');
  assert.deepEqual(plain(fills.sell.totalMs), [124]);
});

test('a broken measurement is dropped, not recorded as a fast fill', async () => {
  const w = fillWorker();
  for (const bad of [
    { type: 'pt_turbo_fill', kind: 'buy', quoteMs: -1, commitMs: 10, paintMs: 1, totalMs: 10 },
    { type: 'pt_turbo_fill', kind: 'buy', quoteMs: NaN, commitMs: 10, paintMs: 1, totalMs: 10 },
    { type: 'pt_turbo_fill', kind: 'buy', commitMs: 10, paintMs: 1, totalMs: 10 }, // missing stage
    { type: 'pt_turbo_fill', kind: 'buy', quoteMs: 'fast', commitMs: 10, paintMs: 1, totalMs: 10 },
  ]) {
    await w.send(bad);
    await w.settle(); await w.settle();
  }
  assert.equal((w.values.pt_turbo_stats || {}).fills, undefined,
    'a negative or non-finite stage is a broken measurement, not a fast one');
});

test('an unknown kind is normalized rather than trusted', async () => {
  const w = fillWorker();
  await w.send({ type: 'pt_turbo_fill', kind: '__proto__', quoteMs: 1, commitMs: 1, paintMs: 1, totalMs: 3 });
  await w.settle(); await w.settle();
  const fills = (w.values.pt_turbo_stats || {}).fills || {};
  assert.deepEqual(plain(Object.keys(fills)), ['buy'], 'anything that is not "sell" is a buy');
});

test('the ring is bounded and drops the OLDEST samples', async () => {
  const w = fillWorker();
  for (let i = 0; i < 60; i++) {
    await w.send({ type: 'pt_turbo_fill', kind: 'buy', quoteMs: i, commitMs: i, paintMs: 0, totalMs: i });
    await w.settle(); await w.settle();
  }
  const buy = w.values.pt_turbo_stats.fills.buy;
  assert.equal(buy.count, 60, 'the lifetime count keeps every fill');
  assert.equal(buy.commitMs.length, 50, 'the ring stays bounded');
  assert.equal(buy.commitMs[buy.commitMs.length - 1], 59, 'the newest sample survives');
  assert.equal(buy.commitMs[0], 10, 'the oldest were the ones dropped');
});
