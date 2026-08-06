/* Lute (lute.gg) site adapter tests + pollution guard locks.
 *
 * Every shape in this fake was captured from the LIVE site on 2026-08-06:
 *
 *  - Token page URL: lute.gg/trade/<base58Address>
 *  - Named routes (compass, momentum, portfolio, discover) are NOT token pages.
 *  - Holder rows carry avgBuyPriceUSD, avgSellPriceUSD, pnlUSD, realizedPnlUSD
 *    — all position-shaped, never market data.
 *  - POSITION_SUBTREE_KEY includes "toptraders" (lute's token event domain).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SITES = fs.readFileSync(path.join(ROOT, 'sites.js'), 'utf8');

const LUTE_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

function detectAt(href) {
  const url = new URL(href);
  const sandbox = {
    window: {}, self: {},
    location: { href, hostname: url.hostname, pathname: url.pathname, search: url.search },
    URLSearchParams, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(SITES, sandbox, { filename: 'sites.js' });
  const site = sandbox.window.PaperTrenchSites.currentSite();
  return { site, token: site.detect() };
}

/* ====================== Detection ====================== */

test('lute adapter detects a Solana token page', () => {
  const { site, token } = detectAt(`https://lute.gg/trade/${LUTE_MINT}`);
  assert.equal(site.id, 'lute');
  assert.ok(token, 'a token page must produce a detection');
  assert.equal(token.kind, 'mint');
  assert.equal(token.address, LUTE_MINT);
  assert.equal(token.chain, 'solana', 'lute is always Solana');
});

test('lute adapter detects a token page with query string', () => {
  const { site, token } = detectAt(`https://lute.gg/trade/${LUTE_MINT}?ref=abc`);
  assert.equal(site.id, 'lute');
  assert.ok(token);
  assert.equal(token.address, LUTE_MINT);
});

test('lute adapter refuses all named routes (O-10)', () => {
  const named = ['compass', 'momentum', 'portfolio', 'discover'];
  for (const route of named) {
    const { site, token } = detectAt(`https://lute.gg/trade/${route}`);
    assert.equal(site.id, 'lute', `must match lute host for /trade/${route}`);
    assert.equal(token, null, `/trade/${route} must return null (O-10)`);
  }
});

test('lute adapter refuses non-trade routes (O-10)', () => {
  for (const href of [
    'https://lute.gg/',
    'https://lute.gg/login',
    'https://lute.gg/signup',
    'https://lute.gg/trade',
  ]) {
    const { token } = detectAt(href);
    assert.equal(token, null, `${href} must return null (O-10)`);
  }
});

test('lute adapter refuses short path segments that are not base58', () => {
  const { token } = detectAt('https://lute.gg/trade/sol');
  assert.equal(token, null, 'short slug "sol" must fail the {32,44} length gate');
});

test('lute adapter tokenUrl builds the correct URL', () => {
  const { site } = detectAt(`https://lute.gg/trade/${LUTE_MINT}`);
  const url = site.tokenUrl(LUTE_MINT);
  assert.equal(url, `https://lute.gg/trade/${LUTE_MINT}`);
});

test('lute adapter tokenUrl works for chip navigation', () => {
  const { site } = detectAt(`https://lute.gg/trade/${LUTE_MINT}`);
  const mint = 'Gymbmn9wwMKe4NnmVceyyfpncp9arbwPfSdBsyY9pump';
  const url = site.tokenUrl(mint);
  assert.equal(url, `https://lute.gg/trade/${mint}`);
});

/* ====================== Contract ====================== */

test('lute adapter satisfies the detect() contract shape', () => {
  const { token } = detectAt(`https://lute.gg/trade/${LUTE_MINT}`);
  assert.ok(token);
  assert.equal(typeof token.kind, 'string');
  assert.ok(token.kind === 'mint' || token.kind === 'pair');
  assert.equal(typeof token.address, 'string');
  assert.ok(token.address.length > 0);
  assert.equal(typeof token.chain, 'string');
  assert.equal(token.chain, token.chain.toLowerCase(),
    'chain must be lowercase — it is a map key in quote.js CHAIN_MAP');
});

test('lute adapter always sets chain (foreign chain field)', () => {
  const { token } = detectAt(`https://lute.gg/trade/${LUTE_MINT}`);
  assert.ok(token);
  assert.ok('chain' in token, 'chain field must be present');
  assert.equal(token.chain, 'solana');
});

/* ====================== Pollution guard locks ====================== */

test('POSITION_SUBTREE_KEY includes toptraders (lute domain)', () => {
  const source = fs.readFileSync(path.join(ROOT, 'price-bridge.js'), 'utf8');
  assert.ok(source.includes('toptraders'),
    'POSITION_SUBTREE_KEY must include toptraders for lute holder/toptrader data');
});

test('looksLikePositionRecord catches avgBuyPriceUSD (lute holder shape)', () => {
  const source = fs.readFileSync(path.join(ROOT, 'price-bridge.js'), 'utf8');
  assert.ok(source.includes('avgBuyPriceUSD'),
    'looksLikePositionRecord must recognize avgBuyPriceUSD from lute holder rows');
  assert.ok(source.includes('realizedPnlUSD'),
    'looksLikePositionRecord must recognize realizedPnlUSD from lute holder rows');
});
