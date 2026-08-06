/* Tests for the bar store (bar-store.js).
 *
 * The store is the honesty foundation of the whole TA layer: what it refuses
 * to accept (off-grid bars, malformed OHLC, backfill over observation) is
 * what keeps every indicator downstream computed on true bars only. Every
 * expectation here is derived from the inputs inside the test.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

global.window = global.window || {};
require('../bar-store.js');
const B = global.window.PaperBars;

const RES = 60;

function flat(t, px, v) {
  const b = { t, o: px, h: px + 0.3, l: px - 0.3, c: px };
  if (v !== undefined) b.v = v;
  return b;
}

test('bar store installs its public API on the browser global', () => {
  assert.equal(typeof B, 'object');
  for (const fn of ['createStore', 'noteBar', 'bars', 'gaps', 'coverage', 'validateBar']) {
    assert.equal(typeof B[fn], 'function', `${fn} must be exported`);
  }
});

/* ------------------------- admission control ------------------------- */

test('a bar off the resolution grid is rejected, never snapped', () => {
  const s = B.createStore();
  const r = B.noteBar(s, 'mint1', RES, flat(90, 10), 'live'); // 90 % 60 !== 0
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'off-grid');
  assert.equal(B.bars(s, 'mint1', RES).length, 0);
});

test('malformed OHLC envelopes are rejected', () => {
  const s = B.createStore();
  const cases = [
    { t: 60, o: 10, h: 9, l: 11, c: 10 },          // h < l
    { t: 60, o: 10, h: 10.5, l: 9.5, c: 11 },       // c above h
    { t: 60, o: 9, h: 10.5, l: 9.5, c: 10 },        // o below l
    { t: 60, o: 10, h: NaN, l: 9.5, c: 10 },        // non-finite
    { t: 60, o: 0, h: 0, l: 0, c: 0 },              // zero price
  ];
  for (const bar of cases) {
    const r = B.noteBar(s, 'mint1', RES, bar, 'live');
    assert.equal(r.ok, false, JSON.stringify(bar));
    assert.equal(r.reason, 'bad-ohlc', JSON.stringify(bar));
  }
  assert.equal(B.noteBar(s, 'mint1', RES, { t: -60, o: 10, h: 10, l: 10, c: 10 }, 'live').reason, 'bad-time');
  const negVol = Object.assign(flat(60, 10), { v: -1 });
  assert.equal(B.noteBar(s, 'mint1', RES, negVol, 'live').reason, 'bad-volume');
  assert.equal(B.bars(s, 'mint1', RES).length, 0, 'nothing malformed may enter the ring');
});

test('provenance must be live or a named backfill source', () => {
  const s = B.createStore();
  for (const prov of ['guess', 'backfill:', 'backfill:UPPER', '', null, undefined]) {
    const r = B.noteBar(s, 'mint1', RES, flat(60, 10), prov);
    assert.equal(r.ok, false, String(prov));
    assert.equal(r.reason, 'bad-provenance', String(prov));
  }
  assert.equal(B.noteBar(s, 'mint1', RES, flat(60, 10), 'live').ok, true);
  assert.equal(B.noteBar(s, 'mint1', RES, flat(120, 10), 'backfill:gecko-1').ok, true);
});

/* ------------------------- precedence rules ------------------------- */

test('a live bar updates the same-time live bar (forming bar path)', () => {
  const s = B.createStore();
  B.noteBar(s, 'mint1', RES, flat(60, 10), 'live');
  const r = B.noteBar(s, 'mint1', RES, flat(60, 11), 'live');
  assert.equal(r.ok, true);
  assert.equal(r.replaced, true);
  const out = B.bars(s, 'mint1', RES);
  assert.equal(out.length, 1);
  assert.equal(out[0].c, 11);
});

test('backfill can never overwrite an observed bar', () => {
  const s = B.createStore();
  B.noteBar(s, 'mint1', RES, flat(60, 10), 'live');
  const r = B.noteBar(s, 'mint1', RES, flat(60, 99), 'backfill:venue');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'observed-bar-precedence');
  assert.equal(B.bars(s, 'mint1', RES)[0].c, 10, 'the observed close must survive');
});

test('a live observation replaces a backfilled bar, and backfill may refresh backfill', () => {
  const s = B.createStore();
  B.noteBar(s, 'mint1', RES, flat(60, 10), 'backfill:venue');
  assert.equal(B.noteBar(s, 'mint1', RES, flat(60, 10.5), 'backfill:venue').ok, true);
  assert.equal(B.bars(s, 'mint1', RES)[0].c, 10.5);
  assert.equal(B.noteBar(s, 'mint1', RES, flat(60, 11), 'live').ok, true);
  const out = B.bars(s, 'mint1', RES);
  assert.equal(out[0].c, 11);
  assert.equal(out[0].prov, 'live');
});

/* ------------------------- gaps and backfill ------------------------- */

test('gaps() names exactly the missing grid slots; backfill closes them', () => {
  const s = B.createStore();
  B.noteBar(s, 'mint1', RES, flat(60, 10), 'live');
  B.noteBar(s, 'mint1', RES, flat(240, 11), 'live');
  assert.deepEqual(B.gaps(s, 'mint1', RES), [{ fromT: 120, toT: 180 }]);
  assert.equal(B.coverage(s, 'mint1', RES).contiguous, false);

  B.noteBar(s, 'mint1', RES, flat(120, 10.4), 'backfill:venue');
  assert.deepEqual(B.gaps(s, 'mint1', RES), [{ fromT: 180, toT: 180 }]);
  B.noteBar(s, 'mint1', RES, flat(180, 10.7), 'backfill:venue');
  assert.deepEqual(B.gaps(s, 'mint1', RES), []);

  const cov = B.coverage(s, 'mint1', RES);
  assert.equal(cov.total, 4);
  assert.equal(cov.live, 2);
  assert.equal(cov.backfilled, 2);
  assert.equal(cov.contiguous, true);
  assert.equal(cov.oldestT, 60);
  assert.equal(cov.newestT, 240);

  const ts = B.bars(s, 'mint1', RES).map((b) => b.t);
  assert.deepEqual(ts, [60, 120, 180, 240], 'out-of-order inserts must land sorted');
});

/* ------------------------- the ring ------------------------- */

test('the ring evicts oldest at cap and refuses bars below its horizon', () => {
  const s = B.createStore({ cap: 5 });
  for (let i = 1; i <= 7; i++) B.noteBar(s, 'mint1', RES, flat(i * RES, 10 + i), 'live');
  const cov = B.coverage(s, 'mint1', RES);
  assert.equal(cov.total, 5);
  assert.equal(cov.oldestT, 3 * RES, 'the two oldest bars must be evicted');
  assert.equal(cov.newestT, 7 * RES);

  const r = B.noteBar(s, 'mint1', RES, flat(60, 11), 'backfill:venue');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'below-ring-horizon',
    'a bar older than the evicted horizon would masquerade as the oldest observation');
});

/* ------------------------- isolation ------------------------- */

test('buffers are independent per market and per resolution', () => {
  const s = B.createStore();
  B.noteBar(s, 'mintA', 60, flat(60, 10), 'live');
  B.noteBar(s, 'mintA', 300, flat(300, 20), 'live');
  B.noteBar(s, 'mintB', 60, flat(60, 30), 'live');
  assert.equal(B.bars(s, 'mintA', 60).length, 1);
  assert.equal(B.bars(s, 'mintA', 300).length, 1);
  assert.equal(B.bars(s, 'mintB', 60).length, 1);
  assert.equal(B.bars(s, 'mintA', 60)[0].c, 10);
  assert.equal(B.bars(s, 'mintA', 300)[0].c, 20);
  assert.equal(B.bars(s, 'mintB', 60)[0].c, 30);
});

test('bars() returns copies — the ring cannot be mutated from outside', () => {
  const s = B.createStore();
  B.noteBar(s, 'mint1', RES, flat(60, 10), 'live');
  const out = B.bars(s, 'mint1', RES);
  out[0].c = 999;
  assert.equal(B.bars(s, 'mint1', RES)[0].c, 10);
});

test('store round-trips through JSON (chrome.storage persistence contract)', () => {
  const s = B.createStore({ cap: 5 });
  B.noteBar(s, 'mint1', RES, flat(60, 10, 5), 'live');
  B.noteBar(s, 'mint1', RES, flat(120, 11), 'backfill:venue');
  const revived = JSON.parse(JSON.stringify(s));
  assert.deepEqual(B.bars(revived, 'mint1', RES), B.bars(s, 'mint1', RES));
  assert.equal(B.noteBar(revived, 'mint1', RES, flat(180, 12), 'live').ok, true);
});
