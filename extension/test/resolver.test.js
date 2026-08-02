/* Tests for the resolver's I/O layer (resolver.js).
 *
 * The pure normalization logic is covered in quote.test.js. What matters here
 * is that the network wrapper feeds real API responses through that logic,
 * prefers the unambiguous pair lookup, caches, and degrades safely.
 *
 * fetch is stubbed with the recorded fixtures so these run offline and
 * deterministically. The live-API test skips (never fails) without a network.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FIX = path.join(__dirname, 'fixtures');
const tokensPayload = JSON.parse(fs.readFileSync(path.join(FIX, 'tokens-bonk.json'), 'utf8'));
const pairPayload = JSON.parse(fs.readFileSync(path.join(FIX, 'pair-bonk.json'), 'utf8'));

const BONK_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

// Captured before any test stubs it, so the live probe below always uses the
// real implementation rather than a leftover stub from an earlier test.
const REAL_FETCH = globalThis.fetch;

/** Load resolver.js fresh with a controlled fetch, mirroring the browser. */
function loadResolver(fetchImpl) {
  global.window = {};
  global.fetch = fetchImpl;
  delete require.cache[require.resolve('../resolver.js')];
  delete require.cache[require.resolve('../quote.js')];
  require('../quote.js');
  global.window.PaperQuote = require('../quote.js');
  require('../resolver.js');
  return global.window.PaperTrenchResolver;
}

function jsonResponse(body) {
  return Promise.resolve({ ok: true, status: 200, json: async () => body });
}
function notFound() {
  return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
}

test('resolves a mint address into verified identity and a positive anchor price', async () => {
  const calls = [];
  const R = loadResolver((url) => {
    calls.push(url);
    if (url.includes('/tokens/')) return jsonResponse(tokensPayload);
    return notFound(); // not a pair address
  });

  const token = await R.resolve(BONK_MINT);

  assert.ok(token, 'a mint must resolve');
  assert.ok(token.symbol && token.symbol.length > 0);
  assert.notEqual(token.symbol, token.mint, 'symbol must not be the address');
  assert.ok(token.priceNative > 0, 'must carry a positive anchor price');
  assert.ok(calls.some((u) => u.includes('/tokens/' + BONK_MINT)));
});

test('resolves a pair address, preferring the unambiguous pair lookup', async () => {
  const pairAddr = pairPayload.pair.pairAddress;
  const R = loadResolver((url) => {
    if (url.includes('/pairs/solana/')) return jsonResponse(pairPayload);
    // A token lookup on a pair address would return junk; ensure it is not used.
    return jsonResponse({
      pairs: [{
        chainId: 'solana', priceNative: '999', liquidity: { usd: 1e12 }, pairAddress: 'JUNK',
        baseToken: { address: 'JUNKMINT', symbol: 'JUNK', name: 'Junk' },
      }],
    });
  });

  const token = await R.resolve(pairAddr);

  assert.equal(token.pairAddress, pairAddr);
  assert.equal(token.symbol, pairPayload.pair.baseToken.symbol);
  assert.notEqual(token.symbol, 'JUNK', 'the pair lookup must win over the token lookup');
});

test('returns null when neither lookup yields a usable pair', async () => {
  const R = loadResolver(() => notFound());
  assert.equal(await R.resolve('NotARealAddress'), null);
});

test('survives a network failure without throwing', async () => {
  const R = loadResolver(() => Promise.reject(new Error('offline')));
  assert.equal(await R.resolve(BONK_MINT), null, 'a network error must resolve to null, not throw');
});

test('caches a resolved token so a second lookup makes no new request', async () => {
  let hits = 0;
  const R = loadResolver((url) => {
    hits++;
    if (url.includes('/tokens/')) return jsonResponse(tokensPayload);
    return notFound();
  });

  const first = await R.resolve(BONK_MINT);
  const hitsAfterFirst = hits;
  const second = await R.resolve(BONK_MINT);

  assert.equal(hits, hitsAfterFirst, 'a cached resolve must not hit the network again');
  assert.equal(second.mint, first.mint);
  assert.equal(second.priceNative, first.priceNative);
});

test('refresh re-quotes an already-resolved token', async () => {
  const R = loadResolver((url) => {
    if (url.includes('/pairs/solana/')) return jsonResponse(pairPayload);
    return notFound();
  });

  const fresh = await R.refresh({ mint: BONK_MINT, pairAddress: pairPayload.pair.pairAddress });
  assert.ok(fresh.priceNative > 0);
  assert.equal(fresh.symbol, pairPayload.pair.baseToken.symbol);
});

test('solUsd exposes the cached SOL/USD rate even when the token is unindexed', async () => {
  const WSOL = 'So11111111111111111111111111111111111111112';
  const R = loadResolver((url) => {
    if (!url.includes('jup.ag')) return notFound();
    return jsonResponse([
      { id: WSOL, name: 'Wrapped SOL', symbol: 'SOL', usdPrice: 198.5 },
    ]);
  });

  const rate = await R.solUsd();
  assert.ok(rate > 0, 'must return a positive SOL/USD rate');
  assert.ok(Math.abs(rate - 198.5) < 1e-9);

  // The rate is cached: a second call must not re-fetch.
  let hits = 0;
  const R2 = loadResolver((url) => {
    if (url.includes('jup.ag')) hits++;
    return jsonResponse([
      { id: WSOL, name: 'Wrapped SOL', symbol: 'SOL', usdPrice: 201.0 },
    ]);
  });
  const first = await R2.solUsd();
  const h1 = hits;
  const second = await R2.solUsd();
  assert.equal(hits, h1, 'cached rate must not trigger a second network call');
  assert.equal(second, first, 'repeated calls return the cached value');
});

/* ---------------- live API (skips cleanly when offline) ---------------- */

/** Probe the live API so the assertions can be skipped (not failed) offline. */
async function probeLiveToken() {
  global.window = {};
  delete require.cache[require.resolve('../resolver.js')];
  delete require.cache[require.resolve('../quote.js')];
  global.window.PaperQuote = require('../quote.js');
  global.fetch = REAL_FETCH; // the genuine network client, not a test stub
  require('../resolver.js');
  try {
    return await global.window.PaperTrenchResolver.resolve(BONK_MINT);
  } catch (e) {
    return null;
  }
}

// Offline / API unreachable SKIPS rather than fails, so the suite never goes
// flaky for reasons unrelated to this code.
test('live Dexscreener lookup returns a usable quote', async (t) => {
  const liveToken = await probeLiveToken();
  if (!liveToken) {
    t.diagnostic('SKIP: network unavailable or API returned no usable pair');
    return t.skip();
  }

  assert.ok(liveToken.symbol && liveToken.symbol.length > 0, 'live lookup must carry a symbol');
  assert.ok(liveToken.priceNative > 0, 'live lookup must carry a positive price');
  assert.notEqual(liveToken.symbol, liveToken.mint, 'live symbol must not be the address');
});
