/* The submission pipeline is the door to the board. Every test here is a
 * cheat at the door: replaced histories, shrunk chains, tampered links,
 * absurd payloads — each must be turned away with a named reason, and the
 * honest path must sail through.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { fastChecks, priceRecord, shapeProblem, MAX_CHAIN_LINKS } =
  require('../core/submission.js');
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

async function honestPayload() {
  const chain = await chainOf([
    buy('M1', 1, 10 * MIN), sell('M1', 1000, 0.002, 20 * MIN),
  ]);
  return {
    version: 1,
    submittedAt: 21 * MIN,
    identity: { handle: 'someone', verified: true },
    claim: {
      equitySol: 10.99, realizedPnlSol: 0.99, rounds: 1, wins: 1, losses: 0,
      startingBalanceSol: 10,
    },
    chain,
    head: chain[chain.length - 1].hash,
  };
}

test('an honest submission is accepted with replayed stats', async () => {
  const result = await fastChecks(await honestPayload(), null);
  assert.equal(result.accepted, true);
  assert.equal(result.claimMismatch, false);
  assert.equal(result.stats.rounds, 1);
  assert.ok(Math.abs(result.replayed.realizedPnlSol - 0.99) < 1e-9);
});

test('a tampered link is rejected as chain-invalid', async () => {
  const payload = await honestPayload();
  payload.chain[0].qty = 999999; // the classic hand-edit
  const result = await fastChecks(payload, null);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'chain-invalid');
  assert.ok(result.problems.length > 0);
});

test('a replaced history is rejected: the new chain must extend the old head', async () => {
  const first = await honestPayload();
  const previous = { head: first.head, chainLen: first.chain.length };
  // A fresh, luckier chain of the same length — the oldest cheat.
  seq = 100;
  const lucky = await chainOf([
    buy('M9', 1, 30 * MIN), sell('M9', 1000, 0.01, 40 * MIN),
  ]);
  const payload = Object.assign({}, first, {
    chain: lucky, head: lucky[lucky.length - 1].hash,
    claim: Object.assign({}, first.claim, { realizedPnlSol: 8.9 }),
  });
  const result = await fastChecks(payload, previous);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'chain-replaced');
});

test('a shrunk chain is rejected even if internally valid', async () => {
  const first = await honestPayload();
  const previous = { head: first.head, chainLen: first.chain.length };
  const payload = Object.assign({}, first, {
    chain: first.chain.slice(0, 1), head: first.chain[0].hash,
  });
  const result = await fastChecks(payload, previous);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'chain-shrunk');
});

test('an extended chain from the committed head is accepted', async () => {
  const first = await honestPayload();
  const previous = { head: first.head, chainLen: first.chain.length };
  const extended = first.chain.slice();
  const next = await appendFill(first.head, buy('M2', 1, 30 * MIN));
  next.seq = extended.length;
  extended.push(next);
  const payload = Object.assign({}, first, {
    chain: extended, head: next.hash,
    claim: Object.assign({}, first.claim),
  });
  const result = await fastChecks(payload, previous);
  assert.equal(result.accepted, true);
});

test('a claim that disagrees with the replay is flagged, and replay wins', async () => {
  const payload = await honestPayload();
  payload.claim.realizedPnlSol = 42; // stated ≠ committed
  const result = await fastChecks(payload, null);
  assert.equal(result.accepted, true);
  assert.equal(result.claimMismatch, true);
  // Ranked stats come from the chain, not the brag.
  assert.ok(Math.abs(result.stats.realizedPnlSol - 0.99) < 1e-9);
});

test('shape gates turn absurd payloads away before any crypto runs', async () => {
  assert.equal(shapeProblem(null), 'not-an-object');
  assert.equal(shapeProblem({ version: 2 }), 'unknown-version');
  assert.equal(shapeProblem({ version: 1, chain: [] }), 'chain-empty');
  const payload = await honestPayload();
  assert.equal(shapeProblem(Object.assign({}, payload, {
    claim: Object.assign({}, payload.claim, { startingBalanceSol: 0 }),
  })), 'starting-balance-invalid');
  assert.equal(shapeProblem(Object.assign({}, payload, { head: 'nope' })), 'head-mismatch');
  const huge = Object.assign({}, payload, { chain: { length: MAX_CHAIN_LINKS + 1 } });
  assert.equal(shapeProblem(huge), 'chain-missing'); // not an array → gate fires
});

/* ---------------- resumable pricing ---------------- */

test('pricing resumes across budgeted runs and lands one final verdict', async () => {
  seq = 200;
  const chain = await chainOf([
    buy('A', 1, 10 * MIN), buy('B', 1, 20 * MIN), buy('C', 1, 30 * MIN),
    buy('D', 1, 40 * MIN),
  ]);
  const payload = { chain };
  // 0.001 SOL × [45,55] USD/SOL = [0.045, 0.055] USD — inside this candle.
  const okCandles = async () => ({ tokenUsd: { low: 0.045, high: 0.06 }, solUsd: { low: 45, high: 55 } });

  let progress = null;
  let runs = 0;
  while (!progress || !progress.done) {
    progress = await priceRecord(payload, okCandles, progress, { maxLookups: 2 });
    runs++;
    assert.ok(runs < 10, 'pricing must converge');
  }
  assert.equal(progress.verdicts.length, 4);
  assert.equal(progress.verdict.status, 'verified');
  assert.ok(runs >= 2, 'the budget must actually have split the work');
});
