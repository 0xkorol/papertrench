/* Ranking doctrine: process over outcome. These tests lock the properties
 * that make the board teach the right lesson — a lottery ticket must not
 * outrank a sustained record, tilt must cost, and thin samples must not rank.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { roundsFromChain, recordStats, seasonScore, revengeRatio, maxDrawdown,
        MIN_RANKED_ROUNDS } = require('../core/ranking.js');
const { appendFill, GENESIS } = require('../core/chain.js');

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

const MIN = 60000;

test('rounds reconstruct from fills alone: open→flat, with net-basis P&L', async () => {
  const links = await chainOf([
    buy('M1', 1, 10 * MIN),
    sell('M1', 1000, 0.002, 20 * MIN),   // ~2x win
    buy('M2', 1, 30 * MIN),
    sell('M2', 1000, 0.0005, 40 * MIN),  // loss
  ]);
  const rounds = roundsFromChain(links);
  assert.equal(rounds.length, 2);
  assert.equal(rounds[0].win, true);
  assert.equal(rounds[1].win, false);
  assert.equal(rounds[0].mint.length > 0, true);
  // Net basis: 0.99 in, 1.98 out → +0.99.
  assert.ok(Math.abs(rounds[0].pnlSol - 0.99) < 1e-9);
});

test('a partial sell does not close the round; going flat does', async () => {
  const links = await chainOf([
    buy('M1', 1, 10 * MIN),
    sell('M1', 400, 0.002, 20 * MIN),
    sell('M1', 600, 0.002, 30 * MIN),
  ]);
  const rounds = roundsFromChain(links);
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].closedTs, 30 * MIN);
});

test('one lottery win does not outrank a sustained record', async () => {
  seq = 0;
  // One 10x and done.
  const lottery = await chainOf([
    buy('L1', 1, 10 * MIN), sell('L1', 1000, 0.01, 20 * MIN),
  ]);
  // Eight modest, spaced wins on different mints.
  const grinderFills = [];
  for (let i = 0; i < 8; i++) {
    grinderFills.push(buy('G' + i, 1, (100 + i * 60) * MIN));
    grinderFills.push(sell('G' + i, 1000, 0.0018, (130 + i * 60) * MIN));
  }
  const grinder = await chainOf(grinderFills);
  const lotteryStats = recordStats(lottery, 10);
  const grinderStats = recordStats(grinder, 10);
  assert.equal(lotteryStats.rankable, false); // 1 round < MIN_RANKED_ROUNDS
  assert.ok(grinderStats.rankable);
  assert.ok(grinderStats.score > 0);
});

test('sustained losing sinks below brief losing — no hiding in volume', () => {
  const brief = seasonScore({ roiPct: -20, rounds: 5, revengeRatio: 0, maxDrawdown: 0.2 });
  const sustained = seasonScore({ roiPct: -20, rounds: 50, revengeRatio: 0, maxDrawdown: 0.2 });
  assert.ok(sustained < brief);
});

test('revenge trading and drawdown discount the score, floored at 0.25', () => {
  const clean = seasonScore({ roiPct: 30, rounds: 20, revengeRatio: 0, maxDrawdown: 0 });
  const tilted = seasonScore({ roiPct: 30, rounds: 20, revengeRatio: 0.8, maxDrawdown: 0.6 });
  assert.ok(tilted < clean);
  const floor = seasonScore({ roiPct: 30, rounds: 20, revengeRatio: 1, maxDrawdown: 1 });
  assert.ok(Math.abs(floor - 30 * Math.log(21) * 0.25) < 1e-9);
});

test('revenge = re-entering the SAME mint inside the window after a loss', () => {
  const rounds = [
    { mint: 'M1', openedTs: 0, closedTs: 10 * MIN, pnlSol: -1, win: false, costIn: 1 },
    { mint: 'M1', openedTs: 15 * MIN, closedTs: 30 * MIN, pnlSol: 1, win: true, costIn: 1 },
    { mint: 'M2', openedTs: 16 * MIN, closedTs: 31 * MIN, pnlSol: -1, win: false, costIn: 1 },
  ];
  assert.equal(revengeRatio(rounds), 0.5); // M1 revenged; M2's loss was not
  const patient = [
    { mint: 'M1', openedTs: 0, closedTs: 10 * MIN, pnlSol: -1, win: false, costIn: 1 },
    { mint: 'M1', openedTs: 40 * MIN, closedTs: 60 * MIN, pnlSol: 1, win: true, costIn: 1 },
  ];
  assert.equal(revengeRatio(patient), 0);
});

test('drawdown measures giving winnings back, as a fraction of the peak', () => {
  const rounds = [
    { pnlSol: 5 },   // 10 → 15 (peak)
    { pnlSol: -6 },  // 15 → 9: 40% off the peak
    { pnlSol: 2 },
  ];
  assert.ok(Math.abs(maxDrawdown(rounds, 10) - 0.4) < 1e-9);
  assert.equal(maxDrawdown([], 10), 0);
});

test('fewer than MIN_RANKED_ROUNDS closed rounds never ranks', async () => {
  seq = 0;
  const fills = [];
  for (let i = 0; i < MIN_RANKED_ROUNDS - 1; i++) {
    fills.push(buy('R' + i, 1, (10 + i * 30) * MIN));
    fills.push(sell('R' + i, 1000, 0.002, (20 + i * 30) * MIN));
  }
  const stats = recordStats(await chainOf(fills), 10);
  assert.equal(stats.rankable, false);
});
