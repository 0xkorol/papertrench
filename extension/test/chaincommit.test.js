/* F-44 — the fill's CHAIN is committed, and the bump does not orphan anyone.
 *
 * Reported via the community Discord (amogus0471, 2026-08-06) while probing
 * what the attestation actually protects.
 *
 * v1 stored `chain` on the link but left it OUT of the preimage, under the
 * solNet precedent. That precedent is safe for the opposite reason to the one
 * assumed: `committedAmount()` refuses to read solNet, so nothing downstream
 * trusts it. `chain`, by its own comment, exists so "a verifier prices the fill
 * against the RIGHT chain's history" — a field the verifier is MEANT to
 * consume. Recorded-but-unhashed meant it could be relabelled (a Base fill
 * called Solana) while every digest still verified, steering re-pricing toward
 * whichever network's candles made a fabricated price plausible.
 *
 * Two things have to be true at once, and the second is the hard one:
 *   1. v2 commits the chain, so editing it breaks the digest.
 *   2. Chains already in the wild keep verifying. A real wallet SPANS the
 *      upgrade — v1 links beside v2 links — so the preimage dispatches on each
 *      link's own version, and a v1 link is Solana BY DEFINITION rather than by
 *      reading its unhashed label.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const AT = require('../attest.js');

const BASE = {
  id: 'f1', sessionId: 'pts-1', mint: 'Mint1', side: 'buy',
  qty: 1000, priceNative: 0.001, solGross: 1, solNet: 0.9975, ts: 1_700_000_000_000,
};

/* A link exactly as v1 wrote it: version 1, chain stored, chain NOT hashed. */
async function v1Link(prev, over = {}) {
  const fill = { ...BASE, ...over };
  const preimage = AT.fillPreimage({ ...fill, version: 1 }, prev);
  return {
    version: 1, seq: null, id: fill.id, sessionId: fill.sessionId, mint: fill.mint,
    side: fill.side, qty: fill.qty, priceNative: fill.priceNative,
    solGross: fill.solGross, solNet: fill.solNet, txCostSol: 0,
    chain: over.chain || 'solana',
    amount: fill.solGross, ts: fill.ts, prev, hash: await AT.sha256(preimage),
  };
}

test('v1 preimages are byte-identical after the bump — nobody is orphaned', () => {
  // The exact v1 string, written out rather than regenerated, so a future edit
  // to fillPreimage that changes the historical format fails here.
  const prev = 'papertrench-genesis-v1';
  const expected = [
    'v1', prev, 'f1', 'pts-1', 'Mint1', 'buy',
    (1000).toFixed(12), (0.001).toExponential(12), (1).toFixed(12),
    '1700000000000',
  ].join('|');
  assert.equal(AT.fillPreimage({ ...BASE, version: 1 }, prev), expected);
});

test('the v2 preimage is byte-exact too — chain is APPENDED, never inserted', () => {
  // v1's format is frozen because chains exist in it. v2's has to be frozen for
  // the same reason the moment this ships, and the ordering is the fragile
  // part: moving `chain` anywhere but the end would silently orphan every v2
  // chain later, repeating the mistake this whole change exists to avoid.
  const prev = 'papertrench-genesis-v1';
  const expected = [
    'v2', prev, 'f1', 'pts-1', 'Mint1', 'buy',
    (1000).toFixed(12), (0.001).toExponential(12), (1).toFixed(12),
    '1700000000000',
    'base', // last field, after ts — appended, not inserted
  ].join('|');
  assert.equal(AT.fillPreimage({ ...BASE, version: 2, chain: 'base' }, prev), expected);
});

test('a v1 link still verifies after the bump', async () => {
  const link = await v1Link(AT.GENESIS);
  const { valid: ok, problems } = await AT.verifyChain([link]);
  assert.equal(ok, true, `a pre-v2 chain must keep verifying: ${JSON.stringify(problems)}`);
});

test('v2 COMMITS the chain — relabelling a fill breaks its digest', async () => {
  const link = await AT.appendFill(AT.GENESIS, { ...BASE, chain: 'base' });
  link.prev = AT.GENESIS;
  assert.equal(link.version, 2);
  assert.equal(link.chain, 'base');

  const honest = await AT.verifyChain([link]);
  assert.equal(honest.valid, true, 'the untampered v2 link verifies');

  // The attack: call a Base fill a Solana one so it re-prices against Solana
  // candles. Under v1 this changed nothing. Under v2 it must break the hash.
  const relabelled = { ...link, chain: 'solana' };
  const tampered = await AT.verifyChain([relabelled]);
  assert.equal(tampered.valid, false, 'a relabelled chain must not verify');
  assert.ok(tampered.problems.some((p) => p.reason === 'hash-mismatch'),
    'and it must fail as a hash mismatch, naming the tamper');
});

test('a v1 link is Solana by DEFINITION — its unhashed label is never read', async () => {
  // A v1 link whose label says 'base'. It verifies, because v1 never committed
  // the field — which is exactly why the field cannot be believed.
  const link = await v1Link(AT.GENESIS, { chain: 'base' });
  const { valid: ok } = await AT.verifyChain([link]);
  assert.equal(ok, true, 'editing an uncommitted field cannot break a v1 digest');
  assert.equal(AT.chainOf(link), 'solana',
    'so the consumer must answer Solana regardless of what the label claims');
});

test('chainOf reads the label only when the label is committed', async () => {
  const v2 = await AT.appendFill(AT.GENESIS, { ...BASE, chain: 'base' });
  assert.equal(AT.chainOf(v2), 'base', 'a v2 label IS evidence');
  assert.equal(AT.chainOf({ version: 2 }), 'solana', 'missing chain falls back to Solana');
  assert.equal(AT.chainOf({}), 'solana', 'a versionless link is treated as v1');
});

test('a chain that SPANS the upgrade verifies end to end', async () => {
  // The shape every real wallet will have: traded before v2, traded after.
  const first = await v1Link(AT.GENESIS);
  const second = await AT.appendFill(first.hash, { ...BASE, id: 'f2', side: 'sell', ts: BASE.ts + 1000 });
  second.prev = first.hash;
  const third = await AT.appendFill(second.hash, { ...BASE, id: 'f3', chain: 'base', ts: BASE.ts + 2000 });
  third.prev = second.hash;

  const { valid: ok, problems } = await AT.verifyChain([first, second, third]);
  assert.equal(ok, true, `mixed-version chain must verify: ${JSON.stringify(problems)}`);
  assert.equal(AT.chainOf(first), 'solana');
  assert.equal(AT.chainOf(third), 'base');
});
