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

test('a SOL-denominated market-cap chart tick is accepted and converted', () => {
  // Axiom's USD/SOL toggle in MC mode plots the cap in SOL. That value
  // matches neither the USD price band nor the USD market-cap band, and was
  // previously rejected — freezing the price (and the P&L) on SOL-MC charts.
  const a = anchor();
  assert.ok(a.mcap > 0 && a.priceUsd > 0);
  const solMcap = a.mcap * (a.priceNative / a.priceUsd);
  const moved = solMcap * 1.1;

  const verdict = Q.validateTick(a, {
    candidates: [{ value: moved, unit: 'unknown' }],
    mcap: moved,
    source: 'padre-chart-bar',
  });

  assert.equal(verdict.accepted, true, 'SOL market-cap ticks must validate');
  assert.equal(verdict.basis, 'native-mcap');
  assert.ok(Math.abs(verdict.priceNative - a.priceNative * 1.1) / a.priceNative < 1e-12,
    'the SOL price must move by the chart ratio');
  assert.ok(Math.abs(verdict.mcap - a.mcap * 1.1) / a.mcap < 1e-12,
    'the USD market cap must move by the same ratio');
});

test('a price-only tick moves the market cap by the same ratio', () => {
  // Supply is constant tick to tick, so the headline market cap must follow
  // every accepted price move. Before this, a live trade feed (GMGN
  // token_activity) updated the price while the displayed cap stayed frozen
  // at the last resolver quote.
  const a = anchor();
  assert.ok(a.mcap > 0, 'fixture should carry a market cap anchor');

  const native = Q.validateTick(a, { candidates: [{ value: a.priceNative * 1.2, unit: 'native' }] });
  assert.equal(native.accepted, true);
  assert.ok(Math.abs(native.mcap - a.mcap * 1.2) / a.mcap < 1e-12,
    'a native price move must scale the market cap');

  const usd = Q.validateTick(a, { candidates: [{ value: a.priceUsd * 0.9, unit: 'usd' }] });
  assert.equal(usd.accepted, true);
  assert.ok(Math.abs(usd.mcap - a.mcap * 0.9) / a.mcap < 1e-12,
    'a USD-only trade tick must scale the market cap too');
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

/* ---------------- bootstrap from an on-screen price ---------------- */

const SOL_USD = 200;

function pendingToken() {
  return { mint: '3PTQpne3b7kjJEvDYDMBHSuRjTDUh6HSin2xMyW3pump', pending: true };
}

test('a pending token boots from a tiny chart close treated as native SOL', () => {
  const v = 1.05e-8; // native SOL price
  const verdict = Q.bootstrapTick(pendingToken(), {
    source: 'chart-export',
    candidates: [{ value: v, unit: 'unknown', key: 'chartExportClose' }],
    mcap: v,
  }, SOL_USD);

  assert.equal(verdict.accepted, true, 'a tiny unknown close must bootstrap as native');
  assert.equal(verdict.priceNative, v);
  assert.equal(verdict.priceUsd, v * SOL_USD);
  assert.equal(verdict.basis, 'native');
});

test('a pending token boots from a USD chart close using the SOL rate', () => {
  const usd = 0.0000021;
  const verdict = Q.bootstrapTick(pendingToken(), {
    source: 'padre-chart-bar',
    candidates: [{ value: usd, unit: 'unknown', key: 'padreChartClose' }],
    mcap: usd,
  }, SOL_USD);

  assert.equal(verdict.accepted, true, 'a USD close must convert to native');
  assert.equal(verdict.priceUsd, usd);
  assert.ok(Math.abs(verdict.priceNative - usd / SOL_USD) < 1e-18);
  assert.equal(verdict.basis, 'usd');
});

test('a GMGN mint-tagged USD trade bootstraps without ambiguity', () => {
  const mint = pendingToken().mint;
  const usd = 0.000123;
  const verdict = Q.bootstrapTick(pendingToken(), {
    source: 'gmgn-ws-trade',
    mint,
    candidates: [{ value: usd, unit: 'usd', key: 'tokenActivityPriceUsd' }],
  }, SOL_USD);

  assert.equal(verdict.accepted, true);
  assert.equal(verdict.priceUsd, usd);
  assert.equal(verdict.priceNative, usd / SOL_USD);
  assert.equal(verdict.basis, 'ws-usd');
});

test('bootstrap refuses a USD price when the SOL rate is not yet available', () => {
  const usd = 0.0000021;
  const verdict = Q.bootstrapTick(pendingToken(), {
    source: 'chart-export',
    candidates: [{ value: usd, unit: 'unknown', key: 'chartExportClose' }],
    mcap: usd,
  }, 0);

  assert.equal(verdict.accepted, false);
  assert.equal(verdict.reason, 'no-sol-rate');
});

test('bootstrap refuses a market-cap-only tick because supply is unknown', () => {
  const verdict = Q.bootstrapTick(pendingToken(), {
    source: 'gmgn-mcap-candle',
    candidates: [],
    mcap: 1234567,
  }, SOL_USD);

  assert.equal(verdict.accepted, false);
  assert.equal(verdict.reason, 'mcap-only-no-supply');
});

test('bootstrap refuses an untrusted or mismatched source', () => {
  const other = 'SomeOtherMint11111111111111111111111111111';
  const own = pendingToken().mint;

  const mismatch = Q.bootstrapTick(pendingToken(), {
    source: 'gmgn-ws-trade',
    mint: other,
    candidates: [{ value: 0.0001, unit: 'usd' }],
  }, SOL_USD);
  assert.equal(mismatch.accepted, false, 'mint mismatch must be rejected');

  const stray = Q.bootstrapTick(pendingToken(), {
    source: 'ws',
    candidates: [{ value: 0.0001, unit: 'usd' }],
  }, SOL_USD);
  assert.equal(stray.accepted, false, 'untrusted generic source must be rejected');
});

test('the header switches from "waiting" to a price after bootstrap', () => {
  const token = { ...pendingToken(), priceNative: 1.05e-8, priceUsd: 1.05e-8 * SOL_USD };
  const h = Q.headerFields(token, { now: Date.now(), pendingSince: 0, lastPriceAt: Date.now() });

  assert.equal(h.pending, false);
  assert.equal(h.hasTrustedPrice, true);
  assert.doesNotMatch(h.priceText, /waiting for first quote/i, 'price must replace the waiting text');
  assert.match(h.priceText, /SOL/);
});

test('after bootstrap, later chart ticks refine the price like a normal anchor', () => {
  // A bootstrap token has a price but no Dexscreener anchor yet. The next
  // on-screen bar should still be validated against the bootstrap price.
  const native = 1.05e-8;
  const token = { ...pendingToken(), priceNative: native, priceUsd: native * SOL_USD };
  const moved = native * 1.3;

  const verdict = Q.validateTick(token, {
    source: 'chart-export',
    candidates: [{ value: moved, unit: 'unknown', key: 'chartExportClose' }],
    mcap: moved,
  });

  assert.equal(verdict.accepted, true);
  assert.ok(Math.abs(verdict.priceNative - moved) < 1e-18);
  assert.equal(verdict.basis, 'native');
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
  // Traders quote memecoins by market cap, so that is the headline figure.
  assert.equal(h.priceIsMarketCap, true);
  assert.match(h.priceText, /^\$/, 'the headline reads as a market cap');
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
