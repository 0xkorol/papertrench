/* The server verifies the exact bytes the extension commits. These tests lock
 * the shared contract from the server's side of the fence: if the import path
 * ever stops resolving to the extension's attest.js — a copy, a fork, a
 * "cleanup" — the byte-for-byte preimage lock below breaks loudly.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const chain = require('../core/chain.js');

test('server chain module IS the extension module, not a copy', () => {
  const ext = require('../../extension/attest.js');
  assert.equal(chain.verifyChain, ext.verifyChain);
  assert.equal(chain.replayChain, ext.replayChain);
  assert.equal(chain.GENESIS, ext.GENESIS);
});

test('preimage format is locked byte-for-byte (the public contract)', () => {
  const preimage = chain.fillPreimage({
    id: 't1', sessionId: 'pts-a', mint: 'MINTAAA', side: 'buy',
    qty: 1000, priceNative: 0.001, solGross: 1, ts: 1000000,
  }, chain.GENESIS);
  assert.equal(preimage,
    'v1|papertrench-genesis-v1|t1|pts-a|MINTAAA|buy|1000.000000000000|1.000000000000e-3|1.000000000000|1000000');
});

test('a chain the extension would build verifies on the server', async () => {
  let prev = chain.GENESIS;
  const links = [];
  for (const fill of [
    { id: 'a', sessionId: 's', mint: 'M1', side: 'buy', qty: 100, priceNative: 0.01, solGross: 1, solNet: 0.99, ts: 1000 },
    { id: 'b', sessionId: 's', mint: 'M1', side: 'sell', qty: 100, priceNative: 0.02, solGross: 2, solNet: 1.98, ts: 2000 },
  ]) {
    const link = await chain.appendFill(prev, fill);
    link.seq = links.length;
    links.push(link);
    prev = link.hash;
  }
  const result = await chain.verifyChain(links);
  assert.equal(result.valid, true);
  const replayed = chain.replayChain(links, 10);
  assert.equal(replayed.wins, 1);
  assert.ok(Math.abs(replayed.realizedPnlSol - (1.98 - 0.99)) < 1e-9);
});
