/* Rug guard — refuse paper BUYS on obvious rugs, with the number that says so.
 *
 * Maintainer call: "when it's an obvious rug like this I'd rather it not let
 * you buy and it says a RUG WARNING". The guard reads holder concentration
 * from chain state (getTokenLargestAccounts + mint supply), excludes
 * liquidity, and refuses buys — never sells — above a settable threshold.
 *
 * The honesty invariants pinned here:
 *   1. Liquidity is not a holder: positively-identified reserve accounts are
 *      excluded; with none known the single largest is excluded as the
 *      assumed pool, and the verdict SAYS which method it used.
 *   2. No data, no verdict: a failed chain read blocks nothing and blesses
 *      nothing.
 *   3. Sells are never gated — exiting a rug is the right move.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const Q = require('../quote.js');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const SUPPLY = 1_000_000_000_000_000; // 1e9 tokens at 6dp, raw

function holders(...amounts) {
  return amounts.map((amount, i) => ({ address: 'Holder' + i, amount }));
}

test('concentrated float flags; distributed float does not', () => {
  // Pool holds 40%, next ten wallets hold 4.5% each (45%): flagged at 40.
  const concentrated = Q.rugVerdict({
    largest: [{ address: 'POOL', amount: SUPPLY * 0.4 }, ...holders(...Array(10).fill(SUPPLY * 0.045))],
    supply: SUPPLY,
    reserves: ['POOL'],
  });
  assert.equal(concentrated.known, true);
  assert.equal(concentrated.assumedPool, false, 'a positively-identified pool is not "assumed"');
  assert.ok(Math.abs(concentrated.pct - 45) < 0.11, 'top-10 share is 45%');

  // Same pool, next ten hold 1.5% each: nowhere near the threshold.
  const distributed = Q.rugVerdict({
    largest: [{ address: 'POOL', amount: SUPPLY * 0.4 }, ...holders(...Array(10).fill(SUPPLY * 0.015))],
    supply: SUPPLY,
    reserves: ['POOL'],
  });
  assert.ok(distributed.pct < 16);
});

test('with no known reserve, the single largest account is excluded as the assumed pool — and says so', () => {
  const verdict = Q.rugVerdict({
    largest: [{ address: 'PROBABLY_POOL', amount: SUPPLY * 0.5 }, ...holders(SUPPLY * 0.3, SUPPLY * 0.1)],
    supply: SUPPLY,
    reserves: [],
  });
  assert.equal(verdict.known, true);
  assert.equal(verdict.assumedPool, true, 'the verdict must disclose the exclusion was a heuristic');
  assert.ok(Math.abs(verdict.pct - 40) < 0.11, 'the assumed pool is not counted against holders');
});

test('no data, no verdict — a blind guard must stand aside', () => {
  assert.equal(Q.rugVerdict({ largest: [], supply: SUPPLY }).known, false);
  assert.equal(Q.rugVerdict({ largest: holders(1), supply: 0 }).known, false);
  assert.equal(Q.rugVerdict(null).known, false);
  // A reserve-only list leaves nothing to judge.
  assert.equal(Q.rugVerdict({
    largest: [{ address: 'POOL', amount: SUPPLY }], supply: SUPPLY, reserves: ['POOL'],
  }).known, false);
});

test('the buy paths are both gated; the sell path never is', () => {
  const content = read('content.js');
  const requestBuyAt = content.indexOf('function requestBuy(');
  const requestBuyBlock = content.slice(requestBuyAt, content.indexOf('\n  }', requestBuyAt));
  assert.match(requestBuyBlock, /rugRefusalMessage\(\)/, 'requestBuy must consult the rug verdict before arming');

  const doBuyAt = content.indexOf('async function doBuy(');
  const doBuyBlock = content.slice(doBuyAt, content.indexOf('quoteForTrade', doBuyAt));
  assert.match(doBuyBlock, /rugRefusalMessage\(\)/,
    'doBuy must re-check at fire time — the armed path skips requestBuy and the verdict may land after arming');

  const doSellAt = content.indexOf('async function doSellInner(');
  const doSellBlock = content.slice(doSellAt, content.indexOf('\n  }', doSellAt));
  assert.doesNotMatch(doSellBlock, /rugRefusal/, 'exiting a rug is the right move — sells are never gated');
});

test('the refusal names the number and the exclusion method', () => {
  const content = read('content.js');
  const fnAt = content.indexOf('function rugRefusalMessage(');
  const block = content.slice(fnAt, content.indexOf('\n  }', fnAt));
  assert.match(block, /RUG WARNING/, 'the toast says RUG WARNING, as requested');
  assert.match(block, /hold \$\{verdict\.pct\}% of supply/, 'the measured share is in the message');
  assert.match(block, /assumedPool/, 'the exclusion method is disclosed');
  assert.match(block, /Guardrails/, 'the message points at the off-switch');
});

test('the guard fails open on a dead chain read and respects the off-switch', () => {
  const content = read('content.js');
  const fnAt = content.indexOf('function rugRefusalMessage(');
  const block = content.slice(fnAt, content.indexOf('\n  }', fnAt));
  assert.match(block, /settings\.guardRugEnabled === false/, 'the off-switch is honored');
  assert.match(block, /!verdict \|\| !verdict\.known/, 'no verdict -> no refusal');

  const background = read('background.js');
  assert.match(background, /case 'pt_rug_check'/, 'the background must serve the chain read');
  assert.match(background, /RUG_CACHE_MS/, 'reads are cached so arming and buying do not multiply RPC calls');
});

test('the dashboard exposes the rug guard with its threshold, defaulted ON', () => {
  const dash = read('dashboard.js');
  assert.match(dash, /id="set-guard-rug"[^>]*\$\{settings\.guardRugEnabled !== false \? 'checked' : ''\}/,
    'checkbox present and checked unless explicitly disabled');
  assert.match(dash, /guardRugTopPct: clampInt\('set-guard-rug-pct', 10, 90, 40/,
    'threshold saved with dashboard-standard clamping');
  const engine = read('engine.js');
  assert.match(engine, /guardRugEnabled: true/, 'ON by default — the maintainer call');
  assert.match(engine, /guardRugTopPct: 40/);
});
