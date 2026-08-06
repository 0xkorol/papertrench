/* The weekly sprint slices the SAME committed chain everyone already has —
 * nothing extra to trust. These tests lock the window grid to real ISO weeks
 * and the entry math to "rounds fully inside the window, ROI on window-start
 * equity".
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { weekIdOf, windowOf, sprintEntry, WEEK_MS } = require('../core/sprint.js');
const { appendFill, GENESIS } = require('../core/chain.js');

test('windows are UTC Monday-to-Monday and contain their timestamp', () => {
  for (const ts of [Date.UTC(2026, 7, 5, 12), Date.UTC(2026, 0, 1), Date.UTC(1999, 11, 31, 23, 59)]) {
    const w = windowOf(ts);
    assert.ok(w.startTs <= ts && ts < w.endTs);
    assert.equal(w.endTs - w.startTs, WEEK_MS);
    assert.equal(new Date(w.startTs).getUTCDay(), 1); // Monday
    assert.equal(new Date(w.startTs).getUTCHours(), 0);
  }
});

test('week ids follow ISO 8601, including the awkward year boundaries', () => {
  // ISO rule: Jan 4 is always in week 1.
  assert.equal(weekIdOf(Date.UTC(2026, 0, 4)), '2026-W01');
  // Known ISO facts: 2020 had 53 weeks; Jan 1 2021 belongs to 2020-W53.
  assert.equal(weekIdOf(Date.UTC(2020, 11, 31)), '2020-W53');
  assert.equal(weekIdOf(Date.UTC(2021, 0, 1)), '2020-W53');
});

/* ---------------- entries ---------------- */

async function chainOf(fills) {
  const links = [];
  let prev = GENESIS;
  for (const f of fills) {
    const link = await appendFill(prev, f);
    link.seq = links.length;
    links.push(link);
    prev = link.hash;
  }
  return links;
}

let seq = 0;
function buy(mint, sol, ts) {
  return { id: 'f' + (seq++), sessionId: 's', mint, side: 'buy',
           qty: sol * 1000, priceNative: 0.001, solGross: sol, solNet: sol * 0.99, ts };
}
function sell(mint, qty, price, ts) {
  const gross = qty * price;
  return { id: 'f' + (seq++), sessionId: 's', mint, side: 'sell',
           qty, priceNative: price, solGross: gross, solNet: gross * 0.99, ts };
}

const H = 3600000;

test('only rounds opened AND closed inside the window count', async () => {
  const window = windowOf(Date.UTC(2026, 7, 5)); // week of Mon 2026-08-03
  const links = await chainOf([
    // Before the window: a closed win — must not leak in.
    buy('OLD', 1, window.startTs - 50 * H),
    sell('OLD', 1000, 0.003, window.startTs - 49 * H),
    // Straddles the boundary: opened before, closed inside — excluded.
    buy('STRAD', 1, window.startTs - 2 * H),
    sell('STRAD', 1000, 0.002, window.startTs + 2 * H),
    // Fully inside: counts.
    buy('IN', 1, window.startTs + 10 * H),
    sell('IN', 1000, 0.002, window.startTs + 12 * H),
    // Opened inside, still open at window end: no realized number, excluded.
    buy('OPEN', 1, window.endTs - 2 * H),
  ]);
  const entry = sprintEntry(links, 10, window);
  assert.equal(entry.rounds, 1);
  assert.equal(entry.wins, 1);
  assert.ok(Math.abs(entry.pnlSol - (1.98 - 1.0)) < 1e-9);
});

test('ROI is on window-start equity, so bankroll size is not an edge', async () => {
  seq = 0;
  const window = windowOf(Date.UTC(2026, 7, 5));
  const fills = [
    buy('CARRY', 2, window.startTs - 5 * H), // carried in at cost ≈ 1.98 + tx
    buy('IN', 1, window.startTs + 1 * H),
    sell('IN', 1000, 0.002, window.startTs + 3 * H),
  ];
  const links = await chainOf(fills);
  const entry = sprintEntry(links, 10, window);
  // Start equity = cash after the carry buy (10 − 2) + its committed cost
  // basis (2.00 gross). Committed-basis accounting makes these cancel.
  assert.ok(Math.abs(entry.equityAtStart - (10 - 2 + 2.0)) < 1e-9);
  const expectedRoi = (entry.pnlSol / entry.equityAtStart) * 100;
  assert.ok(Math.abs(entry.roiPct - expectedRoi) < 1e-9);
});

test('an empty week scores zero, not NaN', async () => {
  const window = windowOf(Date.UTC(2026, 7, 5));
  const entry = sprintEntry([], 10, window);
  assert.equal(entry.rounds, 0);
  assert.equal(entry.score, 0);
  assert.ok(Number.isFinite(entry.roiPct));
});
