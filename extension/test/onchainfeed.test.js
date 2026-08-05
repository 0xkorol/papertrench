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

/* ---------------- DEFECTS F-09 / F-21: RPC amplification ---------------- */

test("F-09: vault discovery is cached per pool and scans aligned offsets first", () => {
  const src = fs.readFileSync(path.join(ROOT, "onchain-feed.js"), "utf8");
  const fnStart = src.indexOf("async function findVaults(");
  assert.ok(fnStart !== -1);
  const block = src.slice(fnStart, src.indexOf("\n  }", fnStart) + 4);

  assert.match(block, /vaultCache\.has\(poolAddress\)/,
    "revisiting a coin must not re-derive its vaults (the scan is the most RPC-expensive call in the feed)");
  assert.match(block, /await scan\(8\)/,
    "the first pass must scan 8-byte-aligned offsets — one round trip instead of eight to fifteen");
  assert.match(block, /poolBytes\.length <= 1024[\s\S]*?scan\(1\)/,
    "the exhaustive fallback must be bounded to small pool accounts");
  // The caller must actually pass the pool address or the cache never hits.
  assert.match(src, /findVaults\(bytes, mint, poolAddress\)/,
    "describePool must key the vault cache by pool address");
});

test("F-21: a subscribe on a cold socket must not orphan a pending entry", () => {
  const src = fs.readFileSync(path.join(ROOT, "onchain-feed.js"), "utf8");
  const fnStart = src.indexOf("function subscribe(");
  const block = src.slice(fnStart, src.indexOf("\n  }", fnStart) + 4);
  assert.match(block, /const sent = send\(/,
    "the send result must be observed");
  assert.match(block, /if \(sent\) pending\.set\(/,
    "pending acks are registered only for frames that actually went out — onopen resubscribes the rest");
  assert.doesNotMatch(block, /pending\.set\([\s\S]*?send\(\{/,
    "the old set-before-send order must be gone");
});

/* ---------------- F-33: per-vault slot guard (lev, stale Padre fills) ----
 *
 * A swap moves BOTH vaults of a constant-product pool in the SAME slot, and
 * the RPC delivers them as two separate accountNotifications carrying that
 * same slot. The old guard compared each frame against one shared entry.slot,
 * so the first leg of every trade was accepted and its sibling was dropped as
 * out-of-order. Whichever vault kept losing the race stayed frozen at its
 * last first-arrival while the other tracked every trade — the computed
 * price walked away from the chart by the whole drift between them. Reported
 * from a live Padre session as paper buys filling ~13% below the on-screen
 * chart with instant fake profit.
 */

const Onchain = require('../onchain.js');

function tokenAccountB64(amount) {
  // 165-byte SPL token account: mint pubkey at 0 (zeroed — decoder tolerates
  // it), u64 LE amount at 64.
  const bytes = Buffer.alloc(165);
  bytes.writeBigUInt64LE(BigInt(amount), 64);
  return bytes.toString('base64');
}

function vaultNotification(subscription, slot, amount) {
  return JSON.stringify({
    method: 'accountNotification',
    params: {
      subscription,
      result: { context: { slot }, value: { data: [tokenAccountB64(amount)] } },
    },
  });
}

function seedCpPool(mint) {
  Feed._watched.set(mint, {
    desc: {
      kind: 'cp-vaults', watch: 'BASEVAULT', watchQuote: 'QUOTEVAULT', mint,
      decimals: { [mint]: 6, [Onchain.WSOL_MINT]: 9 },
    },
    slot: 0,
    subIds: [901, 902],
  });
  Feed._subToMint.set(901, { mint, account: 'BASEVAULT' });
  Feed._subToMint.set(902, { mint, account: 'QUOTEVAULT' });
}

function cleanupCpPool(mint, off) {
  Feed._watched.delete(mint);
  Feed._subToMint.delete(901);
  Feed._subToMint.delete(902);
  if (off) off();
}

test('F-33: the second vault leg of a same-slot trade must be accepted, not dropped', () => {
  const MINT = 'LevMint111111111111111111111111111111111111';
  const quotes = [];
  const off = Feed.onQuote((q) => { if (q.mint === MINT) quotes.push(q); });
  seedCpPool(MINT);
  try {
    // One swap: both vault frames carry slot 100.
    Feed._handleMessage(vaultNotification(901, 100, 1_000_000_000_000)); // 1M tokens (6dp)
    Feed._handleMessage(vaultNotification(902, 100, 5_000_000_000));     // 5 SOL (9dp)

    // Both legs present -> the price MUST exist and be quote/base.
    const entry = Feed._watched.get(MINT);
    assert.equal(entry.baseAmount, 1_000_000_000_000,
      'the base leg must be recorded');
    assert.equal(entry.quoteAmount, 5_000_000_000,
      'the quote leg of the SAME slot must be recorded — this is the frame the old shared-slot guard dropped');
    assert.ok(quotes.length >= 1, 'a complete vault pair must emit a quote');
    const last = quotes[quotes.length - 1];
    assert.ok(Math.abs(last.priceNative - 5 / 1_000_000) < 1e-12,
      'price must be computed from the same-slot vault PAIR');

    // Next swap, slot 101: the quote leg arrives FIRST this time. Both must
    // land regardless of arrival order.
    Feed._handleMessage(vaultNotification(902, 101, 6_000_000_000));
    Feed._handleMessage(vaultNotification(901, 101, 900_000_000_000));
    assert.ok(Math.abs(entry.priceNative - 6 / 0.9 / 1_000_000) < 1e-12,
      'both legs of the next slot must update the price');

    // A genuinely stale frame (older slot for a leg we already saw) is
    // still refused — per leg.
    Feed._handleMessage(vaultNotification(901, 99, 111));
    assert.equal(entry.baseAmount, 900_000_000_000,
      'an out-of-order frame for a leg must not rewind that leg');

    const fresh = Feed.currentQuote(MINT);
    assert.ok(fresh, 'a just-updated pool must serve a fill-fresh quote');
    assert.ok(Math.abs(fresh.priceNative - 6 / 0.9 / 1_000_000) < 1e-12);
  } finally {
    cleanupCpPool(MINT, off);
  }
});

test('F-33: single-account pools keep the strict newer-slot guard', () => {
  const src = fs.readFileSync(path.join(ROOT, 'onchain-feed.js'), 'utf8');
  const fnStart = src.indexOf('function handleMessage(');
  const block = src.slice(fnStart, src.indexOf('\n  }', fnStart) + 4);
  // The per-entry guard must survive for whirlpool/CLMM/pump-curve (one
  // account = one frame per slot), and the cp branch must guard per leg.
  assert.match(block, /isNewerObservation\(slot, entry\.slot\)/,
    'single-account pools still refuse out-of-order frames');
  assert.match(block, /legKey/,
    'cp-vaults frames must be guarded per vault leg, not per entry');
});
