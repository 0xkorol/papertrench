/* Segmented attestation storage (DEFECT F-14).
 *
 * The chain used to ride inside pt_state, so every fill and every heartbeat
 * serialized the full lifetime record — fill latency grew forever. These
 * tests lock the replacement: an append-only segment store whose per-fill
 * cost is bounded by the segment size, which STILL never loses a link, and
 * which yields byte-identical chains to the old in-state array.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const AT = require('../attest.js');

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

function fill(over) {
  return Object.assign({
    id: 't1', sessionId: 'pts-a', mint: MINT, side: 'buy',
    qty: 1000, priceNative: 0.001, solGross: 1, ts: 1_000_000,
  }, over || {});
}

/** In-memory storage with the async get/set/remove contract the helpers use,
 * plus a log of every key each get asked for — the F-14 bound is about what
 * an append READS, and only a spy can prove it. */
function memoryStore(initial) {
  const values = Object.assign({}, initial);
  const reads = [];
  return {
    values,
    reads,
    get: async (keys) => {
      const list = Array.isArray(keys) ? keys : [keys];
      reads.push(list.slice());
      const out = {};
      for (const key of list) if (Object.hasOwn(values, key)) out[key] = values[key];
      return out;
    },
    set: async (obj) => { Object.assign(values, obj); },
  };
}

/* ---------------- append + read round trip ---------------- */

test('appends round-trip through the store and verify end to end', async () => {
  const store = memoryStore();
  const a = await AT.appendToChainStore(store.get, store.set, fill({ id: 't1', ts: 1_000 }));
  const b = await AT.appendToChainStore(store.get, store.set, fill({ id: 't2', side: 'sell', solGross: 2, ts: 2_000 }));

  assert.equal(a.seq, 0);
  assert.equal(a.prev, AT.GENESIS, 'the first link anchors to genesis');
  assert.equal(b.seq, 1);
  assert.equal(b.prev, a.hash, 'each link commits to the previous');

  const { meta, chain } = await AT.readChainStore(store.get);
  assert.equal(meta.length, 2);
  assert.equal(meta.head, b.hash);
  assert.deepEqual(chain.map((l) => l.id), ['t1', 't2']);

  const result = await AT.verifyChain(chain);
  assert.equal(result.valid, true, result.problems.map((p) => p.reason).join(','));
});

test('an empty store reads as an empty chain heading at genesis', async () => {
  const store = memoryStore();
  const { meta, chain } = await AT.readChainStore(store.get);
  assert.equal(chain.length, 0);
  assert.equal(meta.head, AT.GENESIS);
  assert.equal(meta.segCount, 0);
});

/* ---------------- segmentation ---------------- */

test('a full segment rolls to a fresh one and the chain stays whole', async () => {
  const store = memoryStore();
  const total = AT.CHAIN_SEG_SIZE + 2;
  for (let i = 0; i < total; i++) {
    await AT.appendToChainStore(store.get, store.set, fill({ id: 't' + i, ts: 1_000 + i }));
  }

  const meta = AT.normalizeChainMeta(store.values[AT.CHAIN_META_KEY]);
  assert.equal(meta.segCount, 2, 'link SEG_SIZE+1 must start a second segment');
  assert.equal(meta.length, total);
  assert.equal(store.values[AT.chainSegKey(0)].length, AT.CHAIN_SEG_SIZE,
    'a full segment is never rewritten past its size');
  assert.equal(store.values[AT.chainSegKey(1)].length, 2);

  const { chain } = await AT.readChainStore(store.get);
  assert.equal(chain.length, total);
  for (let i = 0; i < total; i++) {
    assert.equal(chain[i].seq, i, 'seq must be global across segments, not per segment');
    assert.equal(chain[i].id, 't' + i, 'segment order must reassemble the exact chain');
  }
  const result = await AT.verifyChain(chain);
  assert.equal(result.valid, true, 'segmentation must be invisible to verification');
});

test('an append reads only the meta and the tail segment — the F-14 bound', async () => {
  const store = memoryStore();
  const total = AT.CHAIN_SEG_SIZE + 2;
  for (let i = 0; i < total; i++) {
    await AT.appendToChainStore(store.get, store.set, fill({ id: 't' + i, ts: 1_000 + i }));
  }

  store.reads.length = 0;
  await AT.appendToChainStore(store.get, store.set, fill({ id: 'next', ts: 9_000_000 }));

  const touched = new Set(store.reads.flat());
  assert.ok(touched.has(AT.CHAIN_META_KEY));
  assert.ok(touched.has(AT.chainSegKey(1)), 'the tail segment is the working set');
  assert.ok(!touched.has(AT.chainSegKey(0)),
    'reading a full earlier segment would make fills O(lifetime chain) again — the exact disease F-14 names');
});

/* ---------------- no truncation, ever ---------------- */

test('ten thousand simulated links later, every link is still present', async () => {
  // Not actual hashing 10k times (the suite must stay quick) — re-segment a
  // pre-built list and prove nothing is capped or dropped on the way through.
  const links = [];
  let prev = AT.GENESIS;
  for (let i = 0; i < 10_000; i++) {
    const link = { id: 't' + i, seq: i, prev, hash: 'h' + i, ts: i };
    links.push(link);
    prev = link.hash;
  }
  const write = AT.chainSegments(links);
  const meta = write[AT.CHAIN_META_KEY];
  assert.equal(meta.length, 10_000, 'chainSegments must never cap the record');
  assert.equal(meta.segCount, Math.ceil(10_000 / AT.CHAIN_SEG_SIZE));
  assert.equal(meta.head, 'h9999');

  const store = memoryStore(write);
  const { chain } = await AT.readChainStore(store.get);
  assert.equal(chain.length, 10_000);
  assert.equal(chain[0].id, 't0', 'the GENESIS anchor must survive — truncation is what F-14 explicitly forbids');
  assert.equal(chain[9_999].id, 't9999');
});

test('re-segmenting preserves every hash exactly as committed', async () => {
  // Verifiability is the product: a migration or restore that re-derived
  // hashes would break every replica of the record.
  const store = memoryStore();
  const original = [];
  for (let i = 0; i < 5; i++) {
    original.push(await AT.appendToChainStore(store.get, store.set, fill({ id: 't' + i, ts: 1_000 + i })));
  }

  const restoreTarget = memoryStore(AT.chainSegments(original));
  const { chain } = await AT.readChainStore(restoreTarget.get);
  assert.deepEqual(chain.map((l) => l.hash), original.map((l) => l.hash));
  assert.equal((await AT.verifyChain(chain)).valid, true);
});

test('chainSegments of an empty chain writes an empty meta, clearing the head', () => {
  const write = AT.chainSegments([]);
  assert.deepEqual(write[AT.CHAIN_META_KEY], { segCount: 0, length: 0, head: AT.GENESIS });
  assert.equal(Object.keys(write).length, 1, 'no ghost segments for an empty record');
});

/* ---------------- failure honesty ---------------- */

test('a failed read throws instead of re-anchoring the chain at genesis', async () => {
  // The evidence-store cousin of D-15: a failed read treated as "empty"
  // would make the next append fork the record from GENESIS.
  const failingGet = async () => null;
  await assert.rejects(() => AT.readChainMeta(failingGet));
  await assert.rejects(() => AT.appendToChainStore(failingGet, async () => {}, fill()));
  await assert.rejects(() => AT.readChainStore(failingGet));
});

test('a corrupt meta normalizes to safe values rather than NaN arithmetic', () => {
  const meta = AT.normalizeChainMeta({ segCount: 'many', length: -3, head: 42 });
  assert.deepEqual(meta, { segCount: 0, length: 0, head: AT.GENESIS });
});

/* ---------------- bookkeeping helpers ---------------- */

test('chainStorageKeys enumerates exactly the keys the chain occupies', () => {
  assert.deepEqual(AT.chainStorageKeys({ segCount: 2, length: 600, head: 'h' }),
    [AT.CHAIN_META_KEY, AT.chainSegKey(0), AT.chainSegKey(1)]);
  assert.deepEqual(AT.chainStorageKeys(null), [AT.CHAIN_META_KEY],
    'an empty record still owns its meta key');
});
