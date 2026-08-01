/* Tests for the shipped quote logic (quote.js).
 *
 * These drive the real exported functions the extension loads in the browser —
 * nothing is re-implemented here, and expectations are computed from the
 * fixture inputs rather than pasted from a previous run.
 *
 * Fixtures are real Dexscreener responses captured from the live API, so the
 * payload shape under test is the shape production actually receives.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Q = require('../quote.js');

const FIX = path.join(__dirname, 'fixtures');
const tokensPayload = JSON.parse(fs.readFileSync(path.join(FIX, 'tokens-bonk.json'), 'utf8'));
const pairPayload = JSON.parse(fs.readFileSync(path.join(FIX, 'pair-bonk.json'), 'utf8'));

/* ---------------- criterion 1: identity + anchor quote ---------------- */

test('resolves identity and anchor quote from the /tokens payload shape', () => {
  const token = Q.tokenFromPayload(tokensPayload, 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');

  assert.ok(token, 'expected a resolved token record');
  assert.equal(typeof token.symbol, 'string');
  assert.ok(token.symbol.length > 0, 'symbol must be present');
  assert.ok(token.name && token.name.length > 0, 'name must be present');
  assert.ok(token.priceNative > 0, 'anchor price must be positive');

  // The symbol must be a real ticker, never a stand-in for the address.
  assert.notEqual(token.symbol, token.mint);
  assert.ok(!token.symbol.includes('…'), 'symbol must not be a truncated address');

  // Identity must match the fixture's own data, not a hardcoded literal.
  const expected = tokensPayload.pairs.find((p) => p.pairAddress === token.pairAddress);
  assert.ok(expected, 'selected pair must come from the payload');
  assert.equal(token.symbol, expected.baseToken.symbol);
  assert.equal(token.name, expected.baseToken.name);
  assert.equal(token.mint, expected.baseToken.address);
  assert.equal(token.priceNative, Number(expected.priceNative));
});

test('resolves identity from the single-pair payload shape', () => {
  const token = Q.tokenFromPayload(pairPayload, 'ignored-fallback');

  assert.ok(token, 'expected a resolved token record');
  assert.equal(token.symbol, pairPayload.pair.baseToken.symbol);
  assert.equal(token.mint, pairPayload.pair.baseToken.address);
  assert.equal(token.pairAddress, pairPayload.pair.pairAddress);
  assert.ok(token.priceNative > 0);
});

test('selects the deepest-liquidity solana pair when several are present', () => {
  const solana = tokensPayload.pairs.filter(
    (p) => p.chainId === 'solana' && Number(p.priceNative) > 0
  );
  assert.ok(solana.length > 1, 'fixture must contain multiple candidate pairs');

  // Compute the expected winner from the fixture itself.
  const deepest = solana.reduce((a, b) =>
    Number((b.liquidity || {}).usd || 0) > Number((a.liquidity || {}).usd || 0) ? b : a
  );

  // The fixture must not let "return the first pair" pass by coincidence,
  // otherwise this assertion proves nothing.
  assert.notEqual(
    solana[0].pairAddress,
    deepest.pairAddress,
    'fixture must order a non-deepest pair first for this test to be meaningful'
  );

  const picked = Q.pickBestPair(tokensPayload.pairs);
  assert.equal(picked.pairAddress, deepest.pairAddress);
});

test('ignores non-solana pairs and pairs without a usable price', () => {
  const mixed = {
    pairs: [
      { chainId: 'ethereum', priceNative: '999', liquidity: { usd: 1e12 }, baseToken: { symbol: 'ETH' } },
      { chainId: 'solana', priceNative: '0', liquidity: { usd: 1e11 }, baseToken: { symbol: 'ZERO' } },
      {
        chainId: 'solana', priceNative: '0.5', liquidity: { usd: 10 }, pairAddress: 'good',
        baseToken: { address: 'MintGood', symbol: 'GOOD', name: 'Good Token' },
      },
    ],
  };
  const token = Q.tokenFromPayload(mixed, 'fallback');
  assert.equal(token.symbol, 'GOOD');
  assert.equal(token.priceNative, 0.5);
});

test('returns null when no usable pair exists', () => {
  assert.equal(Q.tokenFromPayload({ pairs: [] }, 'x'), null);
  assert.equal(Q.tokenFromPayload(null, 'x'), null);
});

/* ---------------- criterion 2: tick validation ---------------- */

// Anchor built from the real fixture, so the magnitudes under test are real.
function anchor() {
  return Q.tokenFromPayload(tokensPayload, 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
}

test('accepts a page tick consistent with the anchor and adopts its price', () => {
  const a = anchor();
  const moved = a.priceNative * 1.35; // a plausible intra-session move

  const verdict = Q.validateTick(a, { candidates: [{ value: moved, unit: 'native' }] });

  assert.equal(verdict.accepted, true, 'in-band tick must be accepted');
  assert.equal(verdict.priceNative, moved, 'accepted tick must become the price');
});

test('rejects the bogus 0.44 SOL tick and leaves the trusted price unchanged', () => {
  const a = anchor();
  // This is the exact defect observed in the shipped build: a ~3.9e-8 SOL token
  // displaying 0.44 SOL scraped from an unrelated number on the page.
  assert.ok(a.priceNative < 1e-6, 'fixture anchor should be a sub-micro price');

  const verdict = Q.validateTick(a, { candidates: [{ value: 0.44, unit: 'native' }] });

  assert.equal(verdict.accepted, false, '0.44 SOL must be rejected');
  assert.equal(verdict.reason, 'out-of-band');
  assert.equal(verdict.priceNative, a.priceNative, 'previously trusted price must survive');
});

test('rejects a tick belonging to a different mint', () => {
  const a = anchor();
  const verdict = Q.validateTick(a, {
    mint: 'SomeOtherMintAddressThatIsNotOurs11111111',
    candidates: [{ value: a.priceNative, unit: 'native' }],
  });

  assert.equal(verdict.accepted, false);
  assert.equal(verdict.reason, 'mint-mismatch');
  assert.equal(verdict.priceNative, a.priceNative);
});

test('rejects ticks when there is no anchor to validate against', () => {
  const verdict = Q.validateTick(null, { candidates: [{ value: 0.44, unit: 'native' }] });
  assert.equal(verdict.accepted, false);
  assert.equal(verdict.reason, 'no-anchor');
  assert.equal(verdict.priceNative, null);
});

test('rejects an empty candidate list', () => {
  const verdict = Q.validateTick(anchor(), { candidates: [] });
  assert.equal(verdict.accepted, false);
  assert.equal(verdict.reason, 'no-candidates');
});

test('a USD-only live tick immediately moves the SOL price by the same ratio', () => {
  const a = anchor();
  assert.ok(a.priceUsd > 0, 'fixture should carry a usd price');
  const verdict = Q.validateTick(a, { candidates: [{ value: a.priceUsd * 1.1, unit: 'usd' }] });

  assert.equal(verdict.accepted, true);
  assert.equal(verdict.basis, 'usd');
  assert.ok(Math.abs(verdict.priceNative - a.priceNative * 1.1) / a.priceNative < 1e-12,
    'USD ticks must update SOL P&L instead of leaving the native price frozen');
});

test('a Padre market-cap chart tick derives the live token price instantly', () => {
  const a = anchor();
  assert.ok(a.mcap > 0, 'fixture should carry a market cap anchor');
  const verdict = Q.validateTick(a, { candidates: [], mcap: a.mcap * 1.25, source: 'padre-chart-bar' });

  assert.equal(verdict.accepted, true);
  assert.equal(verdict.basis, 'mcap');
  assert.ok(Math.abs(verdict.priceNative - a.priceNative * 1.25) / a.priceNative < 1e-12);
  assert.equal(verdict.mcap, a.mcap * 1.25);
});

test('band edges: just-inside is accepted, just-outside is rejected', () => {
  const a = anchor();
  const ratio = Q.ACCEPT_RATIO;

  const inside = Q.validateTick(a, {
    candidates: [{ value: a.priceNative * (ratio * 0.9), unit: 'native' }],
  });
  assert.equal(inside.accepted, true, 'inside the band must be accepted');

  const outside = Q.validateTick(a, {
    candidates: [{ value: a.priceNative * (ratio * 1.1), unit: 'native' }],
  });
  assert.equal(outside.accepted, false, 'outside the band must be rejected');

  // Symmetric on the downside.
  const belowOutside = Q.validateTick(a, {
    candidates: [{ value: a.priceNative / (ratio * 1.1), unit: 'native' }],
  });
  assert.equal(belowOutside.accepted, false, 'band must be symmetric');
});

/* ---------------- criterion 3: header fields ---------------- */

test('header shows the real name and the address as DISTINCT fields', () => {
  const token = anchor();
  const h = Q.headerFields(token);

  assert.equal(h.title, token.symbol, 'title must be the real ticker');
  assert.equal(h.address, Q.shortAddress(token.mint));
  assert.notEqual(h.title, h.address, 'name and address must not be the same field');
  assert.equal(h.titleIsAddress, false, 'title must never be the contract address');
  assert.equal(h.pending, false);
  assert.equal(h.hasTrustedPrice, true);
  assert.match(h.priceText, /SOL$/);
});

test('header reports an explicit pending state instead of a fabricated price', () => {
  const h = Q.headerFields({ mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'Bonk', priceNative: null });

  assert.equal(h.pending, true);
  assert.equal(h.hasTrustedPrice, false);
  assert.doesNotMatch(h.priceText, /\d/, 'pending header must contain no numeric price');
});

test('header with no token at all is a clean empty state', () => {
  const h = Q.headerFields(null);
  assert.equal(h.title, 'No token');
  assert.equal(h.address, '');
  assert.equal(h.pending, true);
});

test('header never substitutes the address when identity is unknown', () => {
  const h = Q.headerFields({ mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: null, name: null, priceNative: 1 });
  assert.equal(h.title, 'Unknown token');
  assert.equal(h.titleIsAddress, false);
});
