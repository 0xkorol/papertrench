/* Leaderboard attestation.
 *
 * A paper-trading leaderboard is only meaningful if the record can be checked.
 * These tests exercise the properties the chain is supposed to guarantee, and
 * — more importantly — prove it actually REJECTS the cheats it claims to catch.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const AT = require('../attest.js');

const MINT_A = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const MINT_B = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm';

function fill(over) {
  return Object.assign({
    id: 't1', sessionId: 'pts-a', mint: MINT_A, side: 'buy',
    qty: 1000, priceNative: 0.001, solGross: 1, ts: 1_000_000,
  }, over || {});
}

/** Build a valid chain from a list of fills. */
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

/* ---------------- basic integrity ---------------- */

test('a chain built from real fills verifies', async () => {
  const chain = await chainOf([
    fill({ id: 't1', ts: 1_000_000 }),
    fill({ id: 't2', side: 'sell', priceNative: 0.002, solGross: 2, ts: 1_060_000 }),
  ]);

  const result = await AT.verifyChain(chain);
  assert.equal(result.valid, true, result.problems.map((p) => p.reason).join(','));
  assert.equal(result.length, 2);
  assert.equal(chain[0].prev, AT.GENESIS, 'the first fill anchors to genesis');
  assert.equal(chain[1].prev, chain[0].hash, 'each fill commits to the previous');
});

test('an empty chain is trivially valid and heads at genesis', async () => {
  const result = await AT.verifyChain([]);
  assert.equal(result.valid, true);
  assert.equal(result.head, AT.GENESIS);
});

test('the same fill always produces the same digest', async () => {
  const a = await AT.appendFill(AT.GENESIS, fill());
  const b = await AT.appendFill(AT.GENESIS, fill());
  assert.equal(a.hash, b.hash, 'verification requires a deterministic preimage');
});

/* ---------------- the cheats it must catch ---------------- */

test('editing a recorded price invalidates the chain', async () => {
  const chain = await chainOf([fill({ id: 't1' }), fill({ id: 't2', ts: 1_060_000 })]);

  // The classic cheat: rewrite history so the entry looks better.
  chain[0].priceNative = 0.0000001;

  const result = await AT.verifyChain(chain);
  assert.equal(result.valid, false, 'a rewritten price must not verify');
  assert.ok(result.problems.some((p) => p.reason === 'hash-mismatch'));
});

test('inserting a fabricated winning trade breaks every following link', async () => {
  const chain = await chainOf([
    fill({ id: 't1', ts: 1_000_000 }),
    fill({ id: 't2', ts: 1_060_000 }),
    fill({ id: 't3', ts: 1_120_000 }),
  ]);

  const forged = await AT.appendFill(chain[0].hash, fill({ id: 'forged', ts: 1_030_000 }));
  chain.splice(1, 0, forged);

  const result = await AT.verifyChain(chain);
  assert.equal(result.valid, false, 'an inserted trade must be detectable');
  assert.ok(result.problems.some((p) => p.reason === 'broken-link'),
    'the links after the insertion no longer chain');
});

test('deleting a losing trade is detected', async () => {
  const chain = await chainOf([
    fill({ id: 't1', ts: 1_000_000 }),
    fill({ id: 'loser', ts: 1_060_000 }),
    fill({ id: 't3', ts: 1_120_000 }),
  ]);

  chain.splice(1, 1); // quietly drop the loss

  const result = await AT.verifyChain(chain);
  assert.equal(result.valid, false, 'cherry-picking must not verify');
});

test('reordering trades is detected', async () => {
  const chain = await chainOf([
    fill({ id: 't1', ts: 1_000_000 }),
    fill({ id: 't2', ts: 1_060_000 }),
  ]);
  const swapped = [chain[1], chain[0]];

  const result = await AT.verifyChain(swapped);
  assert.equal(result.valid, false, 'order is part of what is committed');
});

test('a backdated timestamp is rejected even if the hash is recomputed', async () => {
  // A sophisticated attacker rebuilds the chain — but time must still move
  // forward, which is what stops "buy at yesterday's low with today's info".
  const chain = await chainOf([
    fill({ id: 't1', ts: 1_060_000 }),
    fill({ id: 't2', ts: 1_000_000 }), // earlier than the fill before it
  ]);

  const result = await AT.verifyChain(chain);
  assert.equal(result.valid, false);
  assert.ok(result.problems.some((p) => p.reason === 'out-of-order-timestamp'));
});

/* ---------------- independent recomputation ---------------- */

test('the result is recomputed from the chain, not trusted from the claim', async () => {
  const chain = await chainOf([
    fill({ id: 't1', side: 'buy', qty: 1000, priceNative: 0.001, solGross: 1, ts: 1_000_000 }),
    fill({ id: 't2', side: 'sell', qty: 1000, priceNative: 0.002, solGross: 2, ts: 1_060_000 }),
  ]);

  const replayed = AT.replayChain(chain, 10);
  // Derived from the fills themselves: spent 1, received 2.
  assert.ok(Math.abs(replayed.realizedPnlSol - 1) < 1e-9);
  assert.equal(replayed.rounds, 1);
  assert.equal(replayed.wins, 1);
  assert.ok(Math.abs(replayed.cashSol - 11) < 1e-9);
});

test('a claim that disagrees with the chain is flagged', async () => {
  const chain = await chainOf([
    fill({ id: 't1', side: 'buy', qty: 1000, priceNative: 0.001, solGross: 1, ts: 1_000_000 }),
    fill({ id: 't2', side: 'sell', qty: 1000, priceNative: 0.002, solGross: 2, ts: 1_060_000 }),
  ]);

  const honest = AT.claimMatchesChain({ realizedPnlSol: 1 }, chain, 10);
  assert.equal(honest.ok, true);

  // Hand-edited storage claiming a bigger win.
  const inflated = AT.claimMatchesChain({ realizedPnlSol: 99 }, chain, 10);
  assert.equal(inflated.ok, false, 'edited local state must not pass as truth');
  assert.ok(inflated.diff > 90);
});

test('a multi-token chain replays each position independently', async () => {
  const chain = await chainOf([
    fill({ id: 'a1', mint: MINT_A, side: 'buy', qty: 1000, priceNative: 0.001, solGross: 1, ts: 1_000 }),
    fill({ id: 'b1', mint: MINT_B, side: 'buy', qty: 500, priceNative: 0.004, solGross: 2, ts: 2_000 }),
    fill({ id: 'a2', mint: MINT_A, side: 'sell', qty: 1000, priceNative: 0.003, solGross: 3, ts: 3_000 }),
    fill({ id: 'b2', mint: MINT_B, side: 'sell', qty: 500, priceNative: 0.002, solGross: 1, ts: 4_000 }),
  ]);

  const replayed = AT.replayChain(chain, 10);
  assert.equal(replayed.wins, 1, 'token A won');
  assert.equal(replayed.losses, 1, 'token B lost');
  assert.equal(replayed.openPositions, 0);
  assert.ok(Math.abs(replayed.realizedPnlSol - 1) < 1e-9, '+2 on A, -1 on B');
});

/* ---------------- submission payload ---------------- */

test('a submission carries the full chain so a server can re-verify it', async () => {
  const chain = await chainOf([fill()]);
  const submission = AT.buildSubmission({
    chain,
    identity: { handle: 'someone', verified: true },
    stats: { equitySol: 11, realizedPnlSol: 1, rounds: 1, wins: 1, losses: 0 },
    startingBalanceSol: 10,
  });

  assert.equal(submission.chain.length, 1,
    'a summary alone would give a verifier nothing to check');
  assert.equal(submission.head, chain[0].hash);
  assert.equal(submission.identity.handle, 'someone');
  assert.match(submission.trustModel, /server must re-verify/,
    'the payload must state plainly that it is evidence, not proof');
});

test('every fill carries what a verifier needs to re-price it', async () => {
  const chain = await chainOf([fill()]);
  const link = chain[0];
  // Without these a server cannot check the price ever existed.
  for (const field of ['mint', 'side', 'qty', 'priceNative', 'ts']) {
    assert.ok(link[field] !== undefined && link[field] !== '',
      `a fill must record ${field} so its price can be re-checked against history`);
  }
});

test('partial sells are replayed with proportional cost basis', async () => {
  // Buy 1000 for 1 SOL, then exit in two halves at double the price.
  const chain = await chainOf([
    fill({ id: 'b', side: 'buy', qty: 1000, priceNative: 0.001, solGross: 1, ts: 1 }),
    fill({ id: 's1', side: 'sell', qty: 500, priceNative: 0.002, solGross: 1, ts: 2 }),
    fill({ id: 's2', side: 'sell', qty: 500, priceNative: 0.002, solGross: 1, ts: 3 }),
  ]);

  const replayed = AT.replayChain(chain, 10);
  // Derived: 2 SOL out against 1 SOL of cost.
  assert.ok(Math.abs(replayed.realizedPnlSol - 1) < 1e-9,
    `partial exits must split the cost basis; got ${replayed.realizedPnlSol}`);
  assert.ok(Math.abs(replayed.cashSol - 11) < 1e-9);
  assert.equal(replayed.openPositions, 0, 'the position must close on the final slice');
  assert.equal(replayed.rounds, 1, 'a scaled-out exit is still one round trip');
});

test('a sell with no matching position is ignored rather than inventing profit', async () => {
  const chain = await chainOf([
    fill({ id: 'ghost', side: 'sell', qty: 1000, priceNative: 0.002, solGross: 2, ts: 1 }),
  ]);
  const replayed = AT.replayChain(chain, 10);
  assert.equal(replayed.realizedPnlSol, 0, 'selling what was never bought must not credit P&L');
  assert.equal(replayed.cashSol, 10);
});
