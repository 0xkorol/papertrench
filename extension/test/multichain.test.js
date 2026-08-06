/* Multichain paper trading (docs/MULTICHAIN.md as code).
 *
 * The doctrine under test: an off-Solana token's SOL price is DERIVED
 * (priceUsd / solUsd) with the rate RECORDED — never guessed, never taken
 * from the pair's gas-token priceNative; the chain filter is strict; and
 * the resolver never asks Solana-only sources about a foreign token.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const Q = require('../quote.js');

const EVM = '0x32708538A107253b51a735A724330a23106CA4Ca'; // checksummed
const EVM_LOWER = EVM.toLowerCase();

function bnbPair(overrides = {}) {
  return {
    chainId: 'bsc',
    pairAddress: '0x' + 'ab'.repeat(20),
    baseToken: { address: EVM, symbol: 'MC', name: 'MultiChain' },
    quoteToken: { address: '0x' + 'cd'.repeat(20), symbol: 'WBNB' },
    priceNative: '0.000123', // BNB-denominated — must be DISCARDED
    priceUsd: '0.05',
    marketCap: 5_000_000,
    liquidity: { usd: 250_000 },
    dexId: 'pancakeswap',
    ...overrides,
  };
}

test('an EVM pair derives its SOL price from USD and records the rate — the gas-token priceNative is discarded', () => {
  const payload = { pairs: [bnbPair()] };
  const rec = Q.tokenFromPayload(payload, EVM_LOWER, { chain: 'bnb', solUsd: 200 });
  assert.ok(rec, 'the record resolves');
  assert.equal(rec.chain, 'bnb');
  assert.ok(Math.abs(rec.priceNative - 0.05 / 200) < 1e-15,
    'priceNative is priceUsd / solUsd — never the BNB-denominated pair price');
  assert.equal(rec.solUsdAtResolve, 200, 'the conversion rate is recorded on the record');
  assert.equal(rec.priceUsd, 0.05);
  assert.equal(rec.mcap, 5_000_000);
});

test('no SOL/USD rate means NO record — a wrong rate corrupts every fill downstream', () => {
  const payload = { pairs: [bnbPair()] };
  assert.equal(Q.tokenFromPayload(payload, EVM_LOWER, { chain: 'bnb', solUsd: 0 }), null);
  assert.equal(Q.tokenFromPayload(payload, EVM_LOWER, { chain: 'bnb' }), null);
});

test('the chain filter is strict: a bnb request ignores solana and ethereum pairs of the same address', () => {
  const payload = {
    pairs: [
      bnbPair({ chainId: 'solana', priceNative: '0.5' }),
      bnbPair({ chainId: 'ethereum', priceUsd: '9.99' }),
      bnbPair(), // the real one
    ],
  };
  const rec = Q.tokenFromPayload(payload, EVM_LOWER, { chain: 'bnb', solUsd: 200 });
  assert.ok(rec);
  assert.equal(rec.priceUsd, 0.05, 'only the bsc pair may answer a bnb request');
});

test('EVM address matching is case-tolerant; base58 stays case-SENSITIVE', () => {
  // Dexscreener returns checksummed addresses; page URLs are lowercase.
  const rec = Q.tokenFromPayload({ pairs: [bnbPair()] }, EVM_LOWER, { chain: 'bnb', solUsd: 200 });
  assert.ok(rec, 'lowercase URL address matches the checksummed pair base');
  assert.ok(Q.sameAddress(EVM, EVM_LOWER));
  assert.ok(!Q.sameAddress('So11111111111111111111111111111111111111112', 'so11111111111111111111111111111111111111112'),
    'base58 must never be compared case-insensitively');
});

test('pricesFromBatch groups one chain family per call and derives foreign prices', () => {
  // The solana-variant pair here has NO SOL-native price, so neither family
  // may quote from the other's pair.
  const payload = { pairs: [bnbPair(), bnbPair({ chainId: 'solana', priceNative: '0' })] };
  const out = Q.pricesFromBatch(payload, { chain: 'bnb', solUsd: 200 });
  const rec = out[EVM];
  assert.ok(rec, 'keyed by the pair base address');
  assert.ok(Math.abs(rec.priceNative - 0.05 / 200) < 1e-15);
  // And the default call still speaks Solana only — the bsc pair, whose
  // priceNative is BNB-denominated, must never leak into a solana batch.
  assert.deepEqual(Object.keys(Q.pricesFromBatch(payload)), []);
});

test('the resolver never asks Solana-only sources about a foreign token', async () => {
  const urls = [];
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    urls.push(String(url));
    if (String(url).includes('jup.ag')) {
      return { ok: true, json: async () => ([{ id: Q.WSOL_MINT, usdPrice: 200 }]) };
    }
    return { ok: true, json: async () => ({ pairs: [bnbPair()] }) };
  };
  try {
    delete require.cache[require.resolve('../resolver.js')];
    const R = require('../resolver.js');
    R.clearCache();
    const rec = await R.resolve(EVM_LOWER, { chain: 'bnb' });
    assert.ok(rec, 'the foreign token resolves');
    assert.equal(rec.chain, 'bnb');
    assert.ok(Math.abs(rec.priceNative - 0.05 / 200) < 1e-15, 'derived at the fetched rate');
    assert.ok(!urls.some((u) => u.includes('/pairs/solana/')),
      'the Solana pair endpoint can never answer for a foreign chain');
    assert.ok(!urls.some((u) => u.includes('jup.ag') && u.includes(EVM_LOWER)),
      'Jupiter is never asked about a foreign address — only the WSOL rate');
  } finally {
    global.fetch = realFetch;
  }
});

test('engine fills and rounds carry the chain, defaulting to solana', () => {
  const E = require('../engine.js');
  const settings = E.defaultSettings();
  const state = E.defaultState(settings);
  const { trade, position } = E.buy(state, settings, {
    ts: 1_800_000_000_000, mint: EVM, symbol: 'MC', site: 'fomo',
    priceNative: 0.00025, priceUsd: 0.05, chain: 'bnb', solAmount: 1,
  });
  assert.equal(trade.chain, 'bnb');
  assert.equal(position.chain, 'bnb');
  const sold = E.sell(state, settings, {
    ts: 1_800_000_060_000, mint: EVM, site: 'fomo',
    qtyFraction: 1, priceNative: 0.0003, priceUsd: 0.06,
  });
  assert.equal(sold.trade.chain, 'bnb', 'the sell inherits the position chain');
  assert.equal(sold.round.chain, 'bnb', 'the round records where it happened');

  const sol = E.buy(state, settings, {
    ts: 1_800_000_120_000, mint: 'So11111111111111111111111111111111111111112',
    symbol: 'SOL', site: 'padre', priceNative: 1, solAmount: 1,
  });
  assert.equal(sol.trade.chain, 'solana', 'no chain passed means solana');
});
