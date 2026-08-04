/* On-chain feed robustness — issue #17.
 *
 * A user reported the sell options disappearing mid-session with a console
 * trace at onchain-feed.js:206: `Cannot read properties of undefined
 * (reading '<mint>')`. Root cause: the constant-product (cp-vaults) branch
 * of describePool returned a desc with NO decimals map, so the first vault
 * update crashed priceFromEntry. That throw ran inside the WebSocket
 * onmessage handler and silently ended live prices for every watched token —
 * starving the overlay until sell looked broken.
 *
 * Three fixes, three pinned behaviors:
 *   1. cp-vaults descs carry a full decimals map (token + WSOL).
 *   2. priceFromEntry returns null on a partial desc instead of throwing.
 *   3. The socket handler is isolated: one bad frame cannot kill the feed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');

// The feed resolves PTOnchain/PTRpcPool from globals or require(). Requiring
// it in Node pulls in the real onchain.js and rpc-pool.js modules, so these
// tests run the production decoders, not mocks.
const Feed = require('../onchain-feed.js');

test('a cp-vaults desc without a decimals map yields null price, never a throw (issue #17)', () => {
  // This is the exact shape that crashed in production: desc.kind is
  // cp-vaults, entry has vault amounts, but desc.decimals is undefined.
  const entry = {
    desc: { kind: 'cp-vaults', watch: 'baseVault', watchQuote: 'quoteVault', mint: 'SOMEmint11111111111111111111111111111111' },
    baseAmount: 1000000,
    quoteAmount: 5000000000,
  };

  let price;
  assert.doesNotThrow(() => { price = Feed._priceFromEntry(entry); },
    'a malformed desc must not throw inside the price path');
  assert.equal(price, null, 'no decimals -> no price, not a crash');
});

test('priceFromEntry tolerates a decimals map missing the WSOL entry', () => {
  const entry = {
    desc: { kind: 'cp-vaults', watch: 'b', watchQuote: 'q', mint: 'TokMint11111111111111111111111111111111111', decimals: { TokMint11111111111111111111111111111111111: 6 } },
    baseAmount: 1000000,
    quoteAmount: 5000000000,
  };

  let price;
  assert.doesNotThrow(() => { price = Feed._priceFromEntry(entry); });
  assert.equal(price, null, 'missing WSOL decimals -> null, not NaN/crash');
});

test('the cp-vaults branch of describePool must attach a decimals map', () => {
  const src = fs.readFileSync(path.join(ROOT, 'onchain-feed.js'), 'utf8');
  const cp = src.slice(src.indexOf('Constant product:'), src.indexOf('decimalsCache'));
  assert.ok(cp.length > 0, 'the cp-vaults branch of describePool must be locatable');
  // The returned desc object for the vaults branch must include decimals.
  assert.match(cp, /watchQuote: vaults\.quote, vaults, decimals, mint/,
    'cp-vaults desc must carry the decimals map');
  // And it must fetch both mints: the token and WSOL.
  assert.match(cp, /mintDecimals\(\[mint, O\.WSOL_MINT\]\)/,
    'vault pricing needs the token AND WSOL decimals');
});

test('one hostile frame must not kill the live-price stream', () => {
  const src = fs.readFileSync(path.join(ROOT, 'onchain-feed.js'), 'utf8');
  // The onmessage path must go through the isolated wrapper, never the raw
  // handler: an uncaught throw there silently ends every live price.
  assert.match(src, /socket\.onmessage = \(event\) => handleMessageSafe\(event\.data\)/,
    'the WebSocket handler must be crash-isolated');
  assert.match(src, /function handleMessageSafe\(data\) \{\s*try \{ handleMessage\(data\); \}/,
    'handleMessageSafe must wrap handleMessage in try/catch');
});
