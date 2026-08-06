/* Ranking doctrine: process over outcome. These tests lock the properties
 * that make the board teach the right lesson — a lottery ticket must not
 * outrank a sustained record, tilt must cost, and thin samples must not rank.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { roundsFromChain, recordStats, seasonScore, revengeRatio, maxDrawdown,
        MIN_RANKED_ROUNDS } = require('../core/ranking.js');
const { appendFill, GENESIS, verifyChain } = require('../core/chain.js');

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
  // Committed basis: 1.00 gross out on the buy, 1.98 net in on the sell.
  assert.ok(Math.abs(rounds[0].pnlSol - 0.98) < 1e-9);
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

test('scaling out books EVERY leg, not just the last one', async () => {
  // The disciplined exit this product teaches is taking profit in pieces.
  // Booking only the closing leg understated those rounds, so the board
  // disagreed with replayChain for precisely the best-behaved traders.
  seq = 0;
  const scaled = await chainOf([
    buy('M1', 1, 10 * MIN),
    sell('M1', 500, 0.004, 20 * MIN),   // half out at 4x
    sell('M1', 500, 0.004, 30 * MIN),   // rest out at 4x
  ]);
  const [round] = roundsFromChain(scaled);

  // Committed basis: 1.00 gross out; each leg returns 500 x 0.004 = 2 gross,
  // 1.98 net in, against half the basis each time.
  const expected = (1.98 - 0.5) + (1.98 - 0.5);
  assert.ok(Math.abs(round.pnlSol - expected) < 1e-9,
    `round P&L ${round.pnlSol} should book both legs (${expected})`);
  assert.ok(Math.abs(round.costIn - 1.0) < 1e-9, 'cost basis is the whole position');

  // The round total is the committed cash flow: net in on sells minus gross
  // out on buys. That is the money that actually moved, fees included.
  const summed = roundsFromChain(scaled).reduce((s, r) => s + r.pnlSol, 0);
  assert.ok(Math.abs(summed - expected) < 1e-9);
});

test('ranked stats are immune to the fields the chain does not hash', async () => {
  // attest.js commits gross on a buy and net on a sell. Buy-side solNet,
  // txCostSol and the `amount` copy ride along UNHASHED, so an attacker can
  // set them to anything and every link still re-hashes. Driving a buy's
  // cost basis to nothing is the highest-leverage edit available, so the
  // ranked book must not read those fields at all.
  seq = 700;
  const honest = await chainOf([
    buy('M1', 1, 10 * MIN), sell('M1', 1000, 0.002, 20 * MIN),
  ]);
  const before = recordStats(honest, 10);

  // Tamper with every uncommitted money field on the buy.
  const tampered = honest.map((l) => Object.assign({}, l));
  tampered[0].solNet = 0.000001;
  tampered[0].txCostSol = 0;
  tampered[0].amount = 0.000001;
  tampered[1].amount = 9999;

  // The chain still verifies — that is exactly what makes this dangerous.
  const check = await verifyChain(tampered);
  assert.equal(check.valid, true, 'the tamper must be invisible to the hash check');

  const after = recordStats(tampered, 10);
  assert.ok(Math.abs(after.realizedPnlSol - before.realizedPnlSol) < 1e-12,
    `edited uncommitted fields moved ranked P&L from ${before.realizedPnlSol} to ${after.realizedPnlSol}`);
  assert.ok(Math.abs(after.roiPct - before.roiPct) < 1e-12);
  assert.ok(Math.abs(after.score - before.score) < 1e-12);
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
