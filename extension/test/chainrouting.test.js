/* The OTHER terminals go multichain (maintainer order, 2026-08-06).
 *
 * docs/MULTICHAIN.md took fomo across chains. Terp's follow-up order was
 * "same thing on terminal, and padre, and gmgn, and axiom" — so the rest of
 * the supported terminals must stop refusing their own non-Solana token
 * pages. Every route shape below was verified against the LIVE site on
 * 2026-08-06 through the in-app browser; nothing here is inferred:
 *
 *   GMGN        gmgn.ai/{sol,eth,bsc,base}/token/<addr>   all four rendered
 *   Birdeye     birdeye.so/<chain>/token/<addr>           NEW scheme — the
 *               old ?chain= form 308-redirects onto it, which had quietly
 *               turned our chain gate into dead code (see below)
 *   DexScreener dexscreener.com/<chain>/<pairAddress>     slug vocabulary
 *               harvested from DexScreener's own chain nav
 *
 * Two safety properties are locked here because both were live defects:
 *
 *   1. Birdeye's gate was UNREACHABLE. It read ?chain=, which the site no
 *      longer emits, so the only thing keeping an EVM address out of the
 *      Solana resolver was hex accidentally failing base58 — which by our
 *      own O-11 note fails for ~13% of EVM addresses.
 *   2. An unknown chain must FAIL CLOSED. quote.js resolved
 *      `CHAIN_MAP[chain] || 'solana'`, so a slug it did not recognise was
 *      silently priced on Solana — a wrong-chain price is exactly the class
 *      of wrong number this product refuses to show.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SITES = fs.readFileSync(path.join(ROOT, 'sites.js'), 'utf8');

const SOL_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
// Live addresses from the verification pass.
const USDT_ETH = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const USDT_BSC = '0x55d398326f99059ff775485246999027b3197955';
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH_PAIR = '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640';
const WALLET = 'MfDuWeqSHEqTFVYZ7LoexgAK9dxk7cy4DFJWjWMGVWa';
// 40 hex chars with no '0': the whole run passes base58, which is how EVM
// addresses leaked into the Solana resolver in the first place (O-11).
const EVM_B58ISH = '0xabcdef1234567891abcdef1234567891abcdef12';

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
  return { id: site.id, token: site.detect() };
}

function sitesApi() {
  const sandbox = {
    window: {}, self: {},
    location: { href: 'https://gmgn.ai/', hostname: 'gmgn.ai', pathname: '/', search: '' },
    URLSearchParams, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(SITES, sandbox, { filename: 'sites.js' });
  return sandbox.window.PaperTrenchSites;
}

/* [href, site id, kind|null, address|null, chain|null, why] */
const MATRIX = [
  // ---- GMGN: all four chains rendered live ----
  [`https://gmgn.ai/sol/token/${SOL_MINT}`, 'gmgn', 'mint', SOL_MINT, 'solana', 'the Solana route still works exactly as before'],
  [`https://gmgn.ai/eth/token/${USDT_ETH}`, 'gmgn', 'mint', USDT_ETH, 'ethereum', 'live-verified ethereum token page'],
  [`https://gmgn.ai/bsc/token/${USDT_BSC}`, 'gmgn', 'mint', USDT_BSC, 'bsc', 'live-verified bsc token page'],
  [`https://gmgn.ai/base/token/${USDC_BASE}`, 'gmgn', 'mint', USDC_BASE, 'base', 'live-verified base token page'],
  // Shape strictness per slug survives multichain (O-11): a chain never
  // accepts the other family's address shape.
  [`https://gmgn.ai/sol/token/${USDT_ETH}`, 'gmgn', null, null, null, 'an EVM address under the solana slug is not ours'],
  [`https://gmgn.ai/eth/token/${SOL_MINT}`, 'gmgn', null, null, null, 'a base58 mint under an EVM slug is not ours'],
  [`https://gmgn.ai/eth/token/${EVM_B58ISH}`, 'gmgn', 'mint', EVM_B58ISH, 'ethereum', 'a base58-passing EVM address routes to ETHEREUM, never Solana'],
  [`https://gmgn.ai/sol/address/${WALLET}`, 'gmgn', null, null, null, 'wallet routes never mount (O-10)'],
  [`https://gmgn.ai/tron/token/${USDT_ETH}`, 'gmgn', null, null, null, 'an unsupported chain slug fails closed rather than guessing'],

  // ---- Birdeye: the NEW path scheme, plus the legacy query form ----
  [`https://birdeye.so/solana/token/${SOL_MINT}`, 'birdeye', 'mint', SOL_MINT, 'solana', 'live scheme, solana'],
  [`https://birdeye.so/ethereum/token/${USDT_ETH}`, 'birdeye', 'mint', USDT_ETH, 'ethereum', 'live scheme, ethereum'],
  [`https://birdeye.so/base/token/${USDC_BASE}`, 'birdeye', 'mint', USDC_BASE, 'base', 'live scheme, base'],
  [`https://birdeye.so/token/${SOL_MINT}?chain=solana`, 'birdeye', 'mint', SOL_MINT, 'solana', 'legacy query form still resolves (old links, bookmarks)'],
  // THE defect: this shape reached the Solana resolver because ?chain= was
  // gone and the hex happened to pass base58.
  [`https://birdeye.so/ethereum/token/${EVM_B58ISH}`, 'birdeye', 'mint', EVM_B58ISH, 'ethereum', 'a base58-passing EVM address must route to ETHEREUM, never Solana'],
  [`https://birdeye.so/profile/${WALLET}`, 'birdeye', null, null, null, 'profile routes never mount (O-10)'],

  // ---- DexScreener: pair pages across its own chain vocabulary ----
  [`https://dexscreener.com/solana/${SOL_MINT}`, 'dexscreener', 'pair', SOL_MINT, 'solana', 'solana pair page, unchanged'],
  [`https://dexscreener.com/ethereum/${WETH_PAIR}`, 'dexscreener', 'pair', WETH_PAIR, 'ethereum', 'live-verified ethereum pair page'],
  [`https://dexscreener.com/bsc/${USDT_BSC}`, 'dexscreener', 'pair', USDT_BSC, 'bsc', 'bsc pair page'],
  [`https://dexscreener.com/base/${USDC_BASE}`, 'dexscreener', 'pair', USDC_BASE, 'base', 'base pair page'],
  [`https://dexscreener.com/ethereum/${EVM_B58ISH}`, 'dexscreener', 'pair', EVM_B58ISH, 'ethereum', 'base58-passing EVM address routes to ETHEREUM, never Solana'],
  ['https://dexscreener.com/gainers', 'dexscreener', null, null, null, 'utility routes are not token pages (O-10)'],
  ['https://dexscreener.com/watchlist', 'dexscreener', null, null, null, 'utility routes are not token pages (O-10)'],
  [`https://dexscreener.com/notachain/${USDT_ETH}`, 'dexscreener', null, null, null, 'an unknown chain slug fails closed'],
];

test('multichain overlay matrix: every live-verified route gates correctly', () => {
  for (const [href, id, kind, address, chain, why] of MATRIX) {
    const got = detectAt(href);
    assert.equal(got.id, id, `${href} must route to the ${id} adapter`);
    if (kind === null) {
      assert.equal(got.token, null, `${href}: ${why}`);
      continue;
    }
    assert.ok(got.token, `${href}: ${why}`);
    assert.equal(got.token.kind, kind, `${href}: wrong kind — ${why}`);
    assert.equal(got.token.address, address, `${href}: wrong address — ${why}`);
    assert.equal(got.token.chain, chain,
      `${href}: the chain must be carried, or the price layer prices it on the wrong chain — ${why}`);
  }
});

test('no adapter may report a chain the price layer cannot map', () => {
  // A chain string that quote.js does not know resolves to Solana under the
  // old `|| 'solana'` fallback. Every chain any adapter can emit must be in
  // the map, or that token gets priced on the wrong chain.
  const quote = fs.readFileSync(path.join(ROOT, 'quote.js'), 'utf8');
  const mapBlock = quote.slice(quote.indexOf('CHAIN_MAP = {'), quote.indexOf('};', quote.indexOf('CHAIN_MAP = {')));
  const mapped = new Set([...mapBlock.matchAll(/^\s*([a-z0-9]+)\s*:/gm)].map((m) => m[1]));

  const emitted = new Set();
  for (const [href, , kind] of MATRIX) {
    if (kind === null) continue;
    const got = detectAt(href);
    if (got.token && got.token.chain) emitted.add(got.token.chain);
  }
  assert.ok(emitted.size >= 4, 'the matrix must actually exercise several chains');
  for (const chain of emitted) {
    assert.ok(mapped.has(chain),
      `sites.js can emit chain "${chain}" but quote.js CHAIN_MAP has no entry for it — `
      + 'it would be priced on Solana');
  }
});

test('an unknown chain fails CLOSED instead of being priced on Solana', () => {
  const quote = fs.readFileSync(path.join(ROOT, 'quote.js'), 'utf8');
  assert.doesNotMatch(quote, /CHAIN_MAP\[[^\]]*\]\s*\|\|\s*'solana'/,
    'a chain the map does not know must never silently become Solana — '
    + 'that is a wrong-chain price, the exact class of number this product refuses');
  assert.match(quote, /function chainIdFor/,
    'chain resolution must go through one named, testable function');
});

test('a positions-bar chip returns to the RIGHT chain, not always Solana', () => {
  const S = sitesApi();
  // A BSC position opened on GMGN must not build a /sol/ URL, and a fomo
  // chip must not build /tokens/solana/ for an EVM token (MULTICHAIN.md
  // flagged this as the assumption to revisit once other terminals moved).
  const gmgn = S.tokenUrlFor(USDT_BSC, { siteId: 'gmgn', chain: 'bsc' });
  assert.match(gmgn, /gmgn\.ai\/bsc\/token\//, `GMGN chip must return to bsc, got ${gmgn}`);
  assert.ok(gmgn.includes(USDT_BSC));

  const fomo = S.tokenUrlFor(USDT_BSC, { siteId: 'fomo', chain: 'bsc' });
  assert.ok(!/\/tokens\/solana\//.test(fomo),
    `a BSC token must never be linked as a fomo solana route, got ${fomo}`);

  const birdeye = S.tokenUrlFor(USDT_ETH, { siteId: 'birdeye', chain: 'ethereum' });
  assert.match(birdeye, /birdeye\.so\/ethereum\/token\//, `Birdeye chip must use the live scheme, got ${birdeye}`);

  const dex = S.tokenUrlFor(USDT_ETH, { siteId: 'dexscreener', chain: 'ethereum' });
  assert.match(dex, /dexscreener\.com\/ethereum\//, `DexScreener chip must carry the chain, got ${dex}`);

  // The universal fallback must not claim Solana for a foreign token either.
  const unknownSite = S.tokenUrlFor(USDT_ETH, { siteId: 'not-a-real-site', chain: 'ethereum' });
  assert.ok(!/dexscreener\.com\/solana\//.test(unknownSite),
    `the fallback link must not send an ethereum token to /solana/, got ${unknownSite}`);

  // Solana keeps its exact existing behaviour.
  assert.match(S.tokenUrlFor(SOL_MINT, { siteId: 'gmgn' }), /gmgn\.ai\/sol\/token\//);
  assert.match(S.tokenUrlFor(SOL_MINT, { siteId: 'fomo' }), /fomo\.family\/tokens\/solana\//);
});
