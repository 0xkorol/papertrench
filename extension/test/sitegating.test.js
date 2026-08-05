/* Site gating — where the overlay may exist (DEFECTS O-09..O-13, F-24).
 *
 * The Phase-1 audit mapped every URL shape that wrongly mounted the panel:
 * wallet/portfolio/leaderboard routes ending in base58 addresses, EVM routes
 * whose hex addresses contain base58-passing runs (~13% of them), and — via
 * the <all_urls> manifest — literally any page on the internet with an
 * address-shaped string in its URL. This file is the overlay presence matrix
 * from ROADMAP.md Phase 3, as an executable table.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'sites.js'), 'utf8');

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const PAIR = 'PooLAddress1111111111111111111111111111111';
const WALLET = 'MfDuWeqSHEqTFVYZ7LoexgAK9dxk7cy4DFJWjWMGVWa';
// An EVM address whose 40 hex chars contain no '0': the whole run passes
// base58, which is exactly how EVM routes leaked into the Solana resolver.
const EVM_B58ISH = '0xabcdef1234567891abcdef1234567891abcdef12';

function detectAt(href) {
  const url = new URL(href);
  const sandbox = {
    window: {},
    self: {},
    location: {
      href,
      hostname: url.hostname,
      pathname: url.pathname,
      search: url.search,
    },
    URLSearchParams,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'sites.js' });
  const site = sandbox.window.PaperTrenchSites.currentSite();
  return { id: site.id, token: site.detect() };
}

/* [href, expected site id, expected kind|null, expected address|null, why] */
const MATRIX = [
  // Axiom
  ['https://axiom.trade/meme/' + PAIR, 'axiom', 'pair', PAIR, 'meme route is a pair page'],
  ['https://axiom.trade/t/' + MINT, 'axiom', 'mint', MINT, '/t/ carries a MINT — was mislabeled kind:pair (O-13)'],
  ['https://axiom.trade/', 'axiom', null, null, 'home is not a token page'],
  ['https://axiom.trade/pulse', 'axiom', null, null, 'screener is not a token page'],
  ['https://axiom.trade/tracker/' + WALLET, 'axiom', null, null, 'wallet tracker must not mount (O-10)'],
  // Padre
  ['https://trade.padre.gg/trade/solana/' + MINT, 'padre', 'mint', MINT, 'trade route'],
  ['https://trade.padre.gg/trade/' + MINT, 'padre', 'mint', MINT, 'trade route without chain segment'],
  ['https://trade.padre.gg/trenches', 'padre', null, null, 'screener is not a token page'],
  ['https://trade.padre.gg/wallet/' + WALLET, 'padre', null, null, 'wallet route must not mount (O-10)'],
  ['https://trade.padre.gg/leaderboard/' + WALLET, 'padre', null, null, 'leaderboard must not mount (O-10)'],
  // Photon
  ['https://photon-sol.tinyastro.io/en/lp/' + PAIR, 'photon', 'pair', PAIR, 'lp route'],
  ['https://photon-sol.tinyastro.io/en/r/' + MINT, 'photon', 'mint', MINT, "Photon's own tokenUrl shape must detect (O-12)"],
  ['https://photon-sol.tinyastro.io/en/memescope', 'photon', null, null, 'screener is not a token page'],
  // GMGN
  ['https://gmgn.ai/sol/token/' + MINT, 'gmgn', 'mint', MINT, 'token route'],
  ['https://gmgn.ai/sol/address/' + WALLET, 'gmgn', null, null, 'wallet analysis must not mount (O-10)'],
  ['https://gmgn.ai/eth/token/' + EVM_B58ISH, 'gmgn', null, null, 'EVM chain must never reach the Solana resolver (O-11)'],
  // BullX
  ['https://neo.bullx.io/terminal?chainId=1399811149&address=' + PAIR, 'bullx', 'pair', PAIR, 'solana terminal'],
  ['https://neo.bullx.io/terminal?address=' + PAIR, 'bullx', 'pair', PAIR, 'no chainId defaults to accepting solana'],
  ['https://neo.bullx.io/terminal?chainId=1&address=' + EVM_B58ISH, 'bullx', null, null, 'EVM chainId is not ours (O-11)'],
  ['https://neo.bullx.io/terminal?chainId=1399811149&address=' + EVM_B58ISH, 'bullx', null, null, 'address must be WHOLE base58, not contain a run (O-11)'],
  ['https://neo.bullx.io/portfolio/' + WALLET, 'bullx', null, null, 'portfolio must not mount (O-10)'],
  // Dexscreener
  ['https://dexscreener.com/solana/' + PAIR, 'dexscreener', 'pair', PAIR, 'solana pair page'],
  ['https://dexscreener.com/ethereum/' + EVM_B58ISH, 'dexscreener', null, null, 'EVM route must not reach the Solana resolver (O-11)'],
  ['https://dexscreener.com/watchlist', 'dexscreener', null, null, 'watchlist is not a token page'],
  // Birdeye
  ['https://birdeye.so/token/' + MINT + '?chain=solana', 'birdeye', 'mint', MINT, 'token route'],
  ['https://birdeye.so/token/' + MINT + '?chain=ethereum', 'birdeye', null, null, 'explicit foreign chain is not ours'],
  ['https://birdeye.so/profile/' + WALLET, 'birdeye', null, null, 'profile must not mount (O-10)'],
  // Jupiter
  ['https://jup.ag/swap?inputMint=So11111111111111111111111111111111111111112&outputMint=' + MINT, 'jupiter', 'mint', MINT, 'swap output mint'],
  ['https://jup.ag/portfolio/' + WALLET, 'jupiter', null, null, 'portfolio must not mount (O-10)'],
  // Pump.fun — had NO adapter at all (F-24)
  ['https://pump.fun/coin/' + MINT, 'pumpfun', 'mint', MINT, 'coin route'],
  ['https://pump.fun/' + MINT, 'pumpfun', 'mint', MINT, 'legacy bare mint route'],
  ['https://pump.fun/board', 'pumpfun', null, null, 'board is not a token page'],
];

test('overlay presence matrix: every audited URL shape gates correctly', () => {
  for (const [href, id, kind, address, why] of MATRIX) {
    const got = detectAt(href);
    assert.equal(got.id, id, `${href} must route to the ${id} adapter`);
    if (kind === null) {
      assert.equal(got.token, null, `${href}: ${why}`);
    } else {
      assert.ok(got.token, `${href}: ${why}`);
      assert.equal(got.token.kind, kind, `${href}: wrong kind — ${why}`);
      assert.equal(got.token.address, address, `${href}: wrong address — ${why}`);
    }
  }
});

test('the manifest no longer injects into every page on the internet', () => {
  // DEFECTS O-08/O-09/F-24: <all_urls> ran the bridge's listeners, three
  // intervals and a body-wide MutationObserver on every website the user
  // visited, and the generic adapter mounted the panel wherever a URL
  // contained an address-shaped string. The manifest is the structural fix.
  //
  // v2.4.0 adds a second injection surface: passive viewer bridges on
  // x.com/twitter.com for the opt-in warm-links feature, joined in v2.6.0 by
  // the X-Ray observer and panel. The rule stays the same shape — every entry
  // is either the trading surface or the X surface, each pinned to its own
  // host list, and nothing runs anywhere else. The X allowlist is explicit
  // and closed: a new file only reaches x.com by being named here, which is
  // the review step that keeps the trading engine off X by construction.
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const X_VIEWER_FILES = new Set([
    'xwarm-main.js', 'xwarm-relay.js',
    'xray-core.js', 'xray-main.js', 'xray-panel.js',
  ]);
  const isXEntry = (cs) => (cs.js || []).some((f) => X_VIEWER_FILES.has(f));

  for (const script of manifest.content_scripts) {
    assert.ok(!script.matches.includes('<all_urls>'),
      'content scripts must be limited to supported sites');
  }

  const trading = manifest.content_scripts.filter((cs) => !isXEntry(cs));
  const xViewer = manifest.content_scripts.filter(isXEntry);
  assert.ok(trading.length >= 2 && xViewer.length === 3,
    'expected the two trading-surface entries plus the three X surface entries');

  for (const script of trading) {
    assert.ok(script.matches.includes('https://pump.fun/*'),
      'pump.fun is a first-class supported site');
    assert.ok(!script.matches.some((m) => m.includes('x.com') || m.includes('twitter.com')),
      'the trading overlay must never run on X itself');
  }
  for (const script of xViewer) {
    assert.ok(script.matches.every((m) => /https:\/\/(\*\.)?(x|twitter)\.com\/\*/.test(m)),
      'X viewer entries must match only x.com/twitter.com');
    assert.ok(script.js.every((f) => X_VIEWER_FILES.has(f)),
      'X entries may carry ONLY the passive viewer bridges — never the trading engine or overlay');
  }
  for (const resource of manifest.web_accessible_resources) {
    assert.ok(!resource.matches.includes('<all_urls>'),
      'web-accessible resources must be limited to supported sites');
    assert.ok(!resource.matches.some((m) => m.includes('x.com') || m.includes('twitter.com')),
      'nothing is web-accessible to X pages');
  }
});
