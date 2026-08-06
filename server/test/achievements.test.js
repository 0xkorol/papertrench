/* Achievements are where a trading product usually starts lying to its users:
 * a badge for a lucky 10x teaches the coin flip. These tests lock the doctrine
 * (process only, never profit) and lock every award to evidence the chain
 * actually proves.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const A = require('../core/achievements.js');
const { appendFill, GENESIS } = require('../core/chain.js');

const MIN = 60000;
const DAY = 24 * 60 * MIN;

async function chainOf(fills) {
  const links = [];
  let prev = GENESIS;
  for (const f of fills) {
    const link = await appendFill(prev, f);
    link.seq = links.length;
    links.push(link);
    prev = link.hash;
  }
  return links;
}

let seq = 0;
function buy(mint, sol, ts) {
  return { id: 'f' + (seq++), sessionId: 's', mint, side: 'buy',
           qty: sol * 1000, priceNative: 0.001, solGross: sol, solNet: sol * 0.99, ts };
}
function sell(mint, qty, price, ts) {
  const gross = qty * price;
  return { id: 'f' + (seq++), sessionId: 's', mint, side: 'sell',
           qty, priceNative: price, solGross: gross, solNet: gross * 0.99, ts };
}

/** n rounds, one per day, alternating outcome by the `wins` predicate. */
async function record(n, opts) {
  const options = opts || {};
  seq += 1000;
  const fills = [];
  for (let i = 0; i < n; i++) {
    const openTs = i * DAY + 10 * MIN;
    const holdMin = options.holdMin || 30;
    const win = options.win ? options.win(i) : i % 2 === 0;
    const size = options.size ? options.size(i) : 1;
    fills.push(buy('M' + i, size, openTs));
    fills.push(sell('M' + i, size * 1000, win ? 0.002 : 0.0006, openTs + holdMin * MIN));
  }
  const chain = await chainOf(fills);
  return {
    chain, startingSol: 100, chainLen: chain.length,
    pricingStatus: options.pricingStatus || 'verified',
    coverage: options.coverage === undefined ? 1 : options.coverage,
  };
}

const ids = (badges) => badges.map((b) => b.id).sort();

/* ---------------- doctrine ---------------- */

test('DOCTRINE: no badge rewards profit, win streaks, or raw volume', () => {
  const text = A.DEFINITIONS.map((d) => `${d.id} ${d.name} ${d.blurb}`.toLowerCase()).join(' | ');
  for (const forbidden of ['profit', 'pnl', 'gain', 'moon', 'win streak', 'winning streak']) {
    assert.ok(!new RegExp(`\\b${forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text),
      `a badge mentions "${forbidden}" — the doctrine is process over outcome`);
  }
  // And structurally: no badge may trigger on the bottom line.
  const src = require('node:fs').readFileSync(require.resolve('../core/achievements.js'), 'utf8');
  const body = src.slice(src.indexOf('const DEFINITIONS'), src.indexOf('const TIER_NAMES'));
  assert.ok(!/realizedPnl/.test(body), 'no badge may trigger on total realized P&L');
  assert.ok(!/roiPct/.test(body), 'no badge may trigger on return');
});

test('a wildly profitable but reckless record earns no profit-shaped badge', async () => {
  // Every round a win, every round revenge into the same mint, sizing up.
  seq = 5000;
  const fills = [];
  for (let i = 0; i < 12; i++) {
    const openTs = i * 12 * MIN;
    fills.push(buy('SAME', 1 + i, openTs));
    fills.push(sell('SAME', (1 + i) * 1000, 0.02, openTs + 60000)); // 20x every time
  }
  const chain = await chainOf(fills);
  const badges = A.awarded({ chain, startingSol: 100, chainLen: chain.length,
                             pricingStatus: 'verified', coverage: 1 });
  assert.ok(!badges.some((b) => b.id === 'clean-hands'),
    'a record with no losses has demonstrated no revenge discipline');
  assert.ok(!badges.some((b) => b.id === 'patience'),
    'one-minute flips cannot earn a patience badge');
  assert.ok(!badges.some((b) => b.id === 'iron-stomach'),
    'never drawing down is not the same as recovering from one');
  assert.ok(!badges.some((b) => b.id === 'cut-short'),
    'no losses means no win/loss asymmetry to prove');
  assert.ok(!badges.some((b) => b.id === 'long-haul'),
    'all of it happened inside one session');
  // The only badges left available to it are the two that describe process
  // facts rather than results: fills committed, and fills re-priced. A 20x
  // every single round buys nothing else.
  for (const badge of badges) {
    assert.ok(['committed', 'unbroken'].includes(badge.id),
      `a reckless record earned "${badge.id}" — that badge is outcome-shaped`);
  }
});

/* ---------------- individual badges ---------------- */

test('On the Record counts committed fills and tiers up with the chain', async () => {
  const small = A.awarded(await record(3));
  assert.ok(!ids(small).includes('committed'), '6 fills is under the floor');

  const big = A.awarded(await record(60));
  const badge = big.find((b) => b.id === 'committed');
  assert.ok(badge);
  assert.equal(badge.evidence.value, 120);
  assert.equal(badge.tier.name, 'silver'); // 120 fills: >=100, <500
});

test('Clean Hands counts losses NOT chased — a record with no losses proves nothing', () => {
  // Fifteen straight wins: zero losses, so zero evidence of revenge discipline.
  const allWins = [];
  for (let i = 0; i < 15; i++) {
    allWins.push({ mint: 'M' + i, openedTs: i * DAY, closedTs: i * DAY + MIN,
                   pnlSol: 1, win: true, costIn: 1 });
  }
  const spotless = A.lossDiscipline(allWins);
  assert.equal(spotless.losses, 0);
  assert.equal(spotless.clean, 0, 'no losses means no clean losses to brag about');

  // A loss then re-entering the same mint four minutes later is a chase.
  const tilted = [
    { mint: 'X', openedTs: 0, closedTs: 10 * MIN, pnlSol: -1, win: false, costIn: 1 },
    { mint: 'X', openedTs: 14 * MIN, closedTs: 20 * MIN, pnlSol: 1, win: true, costIn: 1 },
    { mint: 'Y', openedTs: 30 * MIN, closedTs: 40 * MIN, pnlSol: -1, win: false, costIn: 1 },
  ];
  const chased = A.lossDiscipline(tilted);
  assert.equal(chased.losses, 2);
  assert.equal(chased.chased, 1, 'only the X loss was chased');
  assert.equal(chased.clean, 1);
});

test('Clean Hands requires losses actually taken, and none of them chased', async () => {
  // 24 rounds, half losses, each on its own mint and its own day: never chased.
  const disciplined = await record(24, { win: (i) => i % 2 === 0 });
  const badge = A.awarded(disciplined).find((b) => b.id === 'clean-hands');
  assert.ok(badge, 'twelve unchased losses earns it');
  assert.equal(badge.evidence.value, 12);

  // One chase anywhere in the record disqualifies it — this is a clean-sheet badge.
  seq = 7000;
  const fills = [];
  for (let i = 0; i < 24; i++) {
    const open = i * DAY;
    fills.push(buy('M' + i, 1, open));
    fills.push(sell('M' + i, 1000, i % 2 === 0 ? 0.002 : 0.0006, open + 30 * MIN));
  }
  // Re-enter M1 (a loser) two minutes after closing it.
  fills.push(buy('M1', 1, DAY + 32 * MIN));
  fills.push(sell('M1', 1000, 0.002, DAY + 40 * MIN));
  const chain = await chainOf(fills);
  const tilted = A.awarded({ chain, startingSol: 100, chainLen: chain.length,
                             pricingStatus: 'verified', coverage: 1 });
  assert.ok(!tilted.some((b) => b.id === 'clean-hands'),
    'one chased loss ends the clean sheet');
});

test('Iron Stomach requires a drawdown that was actually recovered, not just survived', () => {
  // 100 → 130 (peak) → 91 (30% down) → 140 (new peak): recovered.
  const recovered = [{ pnlSol: 30 }, { pnlSol: -39 }, { pnlSol: 49 }];
  assert.ok(Math.abs(A.deepestRecoveredDrawdown(recovered, 100) - 0.3) < 1e-9);

  // Same drawdown, never recovered: no credit.
  const stillDown = [{ pnlSol: 30 }, { pnlSol: -39 }, { pnlSol: 5 }];
  assert.equal(A.deepestRecoveredDrawdown(stillDown, 100), 0);
});

test('Cut It Short needs a real sample on both sides before it says anything', async () => {
  const tiny = A.awarded(await record(6));
  assert.ok(!ids(tiny).includes('cut-short'), 'three wins and three losses is not a sample');

  // 20 rounds: wins 2x the size of losses.
  const asymmetric = await record(20, { win: (i) => i % 2 === 0 });
  const badge = A.awarded(asymmetric).find((b) => b.id === 'cut-short');
  assert.ok(badge, 'a genuinely asymmetric record earns it');
  assert.ok(badge.evidence.value >= 1.2);
});

test('Sized Down When Cold rejects tilt-sizing and requires enough samples', async () => {
  // Sizes up after every loss (losses on odd rounds → next round bigger).
  const tilting = await record(20, {
    win: (i) => i % 2 === 0,
    size: (i) => (i % 2 === 0 ? 3 : 1), // the round after a loss is the big one
  });
  assert.ok(!ids(A.awarded(tilting)).includes('sized-down'));

  const flat = await record(20, { win: (i) => i % 2 === 0, size: () => 1 });
  const badge = A.awarded(flat).find((b) => b.id === 'sized-down');
  assert.ok(badge);
  assert.ok(badge.evidence.value <= 1);
});

test('The Long Haul counts distinct days, not rounds crammed into one session', async () => {
  const oneDay = await record(20, { holdMin: 5 });
  // record() spaces rounds one per day, so build a same-day burst explicitly.
  seq = 9000;
  const burst = [];
  for (let i = 0; i < 20; i++) {
    burst.push(buy('B' + i, 1, i * 20 * MIN));
    burst.push(sell('B' + i, 1000, 0.002, i * 20 * MIN + 5 * MIN));
  }
  const chain = await chainOf(burst);
  const crammed = A.awarded({ chain, startingSol: 100, chainLen: chain.length,
                              pricingStatus: 'verified', coverage: 1 });
  assert.ok(!ids(crammed).includes('long-haul'),
    'twenty rounds in one sitting is one day of reps');

  const spread = A.awarded(oneDay).find((b) => b.id === 'long-haul');
  assert.ok(spread);
  assert.equal(spread.evidence.value, 20);
});

test('Unbroken Chain reports the coverage actually measured, never a flat 100', async () => {
  const near = await record(15, { pricingStatus: 'verified', coverage: 0.994 });
  const badge = A.awarded(near).find((b) => b.id === 'unbroken');
  assert.ok(badge, '99.4% clears the bar');
  assert.ok(badge.evidence.value < 100,
    `a 99.4% record must not claim ${badge.evidence.value}% of fills confirmed`);
  assert.ok(Math.abs(badge.evidence.value - 99.4) < 0.11);

  const perfect = await record(15, { pricingStatus: 'verified', coverage: 1 });
  assert.equal(A.awarded(perfect).find((b) => b.id === 'unbroken').evidence.value, 100);
});

test('Unbroken Chain is only for fully re-priced records, never pending or partial', async () => {
  const verified = await record(15, { pricingStatus: 'verified', coverage: 1 });
  assert.ok(ids(A.awarded(verified)).includes('unbroken'));

  const pending = await record(15, { pricingStatus: 'pending', coverage: 1 });
  assert.ok(!ids(A.awarded(pending)).includes('unbroken'),
    'a record still being verified has not earned a verification badge');

  const thin = await record(15, { pricingStatus: 'verified', coverage: 0.5 });
  assert.ok(!ids(A.awarded(thin)).includes('unbroken'),
    'half the fills unpriced is not an unbroken chain');
});

/* ---------------- evidence contract ---------------- */

test('every awarded badge carries the numbers that earned it', async () => {
  const badges = A.awarded(await record(40, { holdMin: 45 }));
  assert.ok(badges.length > 0);
  for (const badge of badges) {
    assert.ok(badge.evidence && typeof badge.evidence.value === 'number',
      `${badge.id} must show its evidence`);
    assert.ok(Number.isFinite(badge.evidence.value));
    assert.ok(typeof badge.evidence.unit === 'string' && badge.evidence.unit.length);
    assert.ok(A.TIER_NAMES.includes(badge.tier.name));
  }
});

test('an empty record earns nothing, and does not crash trying', () => {
  const badges = A.awarded({ chain: [], startingSol: 10, chainLen: 0 });
  assert.deepEqual(badges, []);
  assert.deepEqual(A.awarded({}), []);
});
