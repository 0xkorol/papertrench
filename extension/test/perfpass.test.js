/* Turbo III — the audit pass: contracts for the wins, so they cannot silently
 * regress.
 *
 * Each lock here guards a specific piece of work that was REMOVED from a hot
 * path. The failure mode for all of them is the same and it is quiet: someone
 * "simplifies" the gate away, nothing breaks, no test fails, and the megabyte
 * comes back. So every assertion below is written against the mechanism that
 * does the skipping, not against a timing.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const dashJs = fs.readFileSync(path.join(ROOT, 'dashboard.js'), 'utf8');
const perpsContentJs = fs.readFileSync(path.join(ROOT, 'perps-content.js'), 'utf8');
const attestJs = fs.readFileSync(path.join(ROOT, 'attest.js'), 'utf8');

const AT = require('../attest.js');
const P = require('../perps.js');

/* ---------------- dashboard: stop re-reading the world ---------------- */

test('a HIDDEN dashboard does no work on a storage echo', () => {
  const watch = dashJs.slice(
    dashJs.indexOf('function watchDashboardStorage()'),
    dashJs.indexOf('async function loadAll(changedKeys)'),
  );
  assert.ok(watch, 'watchDashboardStorage must exist');
  assert.match(watch, /if \(document\.hidden\) return;/,
    'a hidden dashboard paints nothing — re-reading the wallet, the frame ring and the '
    + 'chain ~75x/min to repaint an invisible tab is pure cost');
  // Nothing may be missed by that early return: the visibility handler owns the
  // catch-up, and it must do a FULL read (no changedKeys) so a skipped echo
  // cannot leave a stale frame ring or chain on screen.
  const init = dashJs.slice(dashJs.indexOf('setInterval(() => {'), dashJs.indexOf('const flexMatch'));
  assert.match(init, /visibilitychange/, 'returning to the tab must refresh');
  assert.match(init, /if \(!document\.hidden\) refreshIfChanged\(\)/,
    'the visibility catch-up must call refreshIfChanged with NO changed-key set — a full read');
});

test('a storage echo only re-reads the keys that actually changed', () => {
  const watch = dashJs.slice(
    dashJs.indexOf('function watchDashboardStorage()'),
    dashJs.indexOf('async function loadAll(changedKeys)'),
  );
  assert.match(watch, /refreshIfChanged\(new Set\(Object\.keys\(changes\)\)\)/,
    'the echo must hand its changed-key set down so the read can be scoped');

  const load = dashJs.slice(
    dashJs.indexOf('async function loadAll(changedKeys)'),
    dashJs.indexOf('let lastRecordingsFingerprint'),
  );
  // The frame ring is up to 80 base64 JPEGs and changes only on a fill; the
  // wallet heartbeat writes ~75x/min while a position is open.
  assert.match(load, /const wantFrames = !changedKeys \|\| changedKeys\.has\('pt_frames'\)/,
    'frames are re-read only when the frames key changed');
  assert.match(load, /if \(wantFrames\) frames = /,
    'and the in-memory ring is kept untouched when the read was skipped');
  assert.ok(!/const s = await store\.get\(\['pt_state', 'pt_settings', 'pt_frames'/.test(load),
    'the frame ring must no longer ride the unconditional key list');

  // Same for the attestation chain, with the two cases that MUST still read it.
  assert.match(load, /const wantChain = !changedKeys \|\| changedKeys\.has\(AT\.CHAIN_META_KEY\)/,
    'the chain is re-read when its own meta key changed');
  assert.match(load, /\|\| legacyInState \|\| !attestChainLoaded/,
    'a legacy in-state chain, and the very first load, must always read');
  assert.match(load, /attestChainLoaded = true/,
    'the loaded flag must latch only after a SUCCESSFUL read, so a failed read retries');
});

test('D-15 survives the scoping: a failed read is still not "empty storage"', () => {
  const load = dashJs.slice(
    dashJs.indexOf('async function loadAll(changedKeys)'),
    dashJs.indexOf('let lastRecordingsFingerprint'),
  );
  assert.match(load, /if \(s === null\)/, 'a null read is still detected');
  assert.match(load, /storageReadFailed = true/, 'and still raises the banner and blocks writes');
  // Skipping a read is knowing the answer already; it must never be conflated
  // with a read that FAILED.
  assert.ok(load.indexOf('storageReadFailed = true') < load.indexOf('const wantChain'),
    'the failed-read bail must come before any scoped work');
});

/* ---------------- attest: parallel digests, identical verdicts ---------- */

test('verifyChain hashes in parallel and reports problems in the same order', async () => {
  assert.match(attestJs, /await Promise\.all\(\s*list\.map\(/,
    'the digests are independent — they must not be awaited one at a time');

  // A good chain verifies. appendFill returns ONE link; the caller owns the
  // chain, so build it the way the engine does.
  const chain = [];
  let prev = null;
  for (let i = 0; i < 6; i++) {
    const link = await AT.appendFill(prev, {
      id: 'f' + i, ts: 1000 + i * 10, mint: 'M' + i, side: i % 2 ? 'sell' : 'buy',
      qty: 1 + i, priceNative: 0.01 * (i + 1), solGross: 0.5,
    });
    chain.push(link);
    prev = link.hash;
  }
  const clean = await AT.verifyChain(chain);
  assert.equal(clean.valid, true, 'an untampered chain must verify');
  assert.equal(clean.length, 6);
  assert.equal(clean.head, chain[5].hash);

  // Editing a payload field breaks THAT link's digest.
  const edited = chain.map((l) => ({ ...l }));
  edited[2] = { ...edited[2], qty: 999 };
  const bad = await AT.verifyChain(edited);
  assert.equal(bad.valid, false, 'an altered fill must not verify');
  assert.ok(bad.problems.some((p) => p.index === 2 && p.reason === 'hash-mismatch'),
    'the altered link is named by index');

  // Re-pointing a link breaks the CHAINING check, which is the sequential half
  // the parallel digests must not have disturbed.
  const relinked = chain.map((l) => ({ ...l }));
  relinked[3] = { ...relinked[3], prev: relinked[0].hash };
  const broken = await AT.verifyChain(relinked);
  assert.ok(broken.problems.some((p) => p.index === 3 && p.reason === 'broken-link'),
    'a re-pointed link is still caught as broken-link');

  // A backdated fill is the classic cheat and is still caught.
  const backdated = chain.map((l) => ({ ...l }));
  backdated[4] = { ...backdated[4], ts: 0 };
  const outOfOrder = await AT.verifyChain(backdated);
  assert.ok(outOfOrder.problems.some((p) => p.index === 4 && p.reason === 'out-of-order-timestamp'),
    'a backdated fill is still caught');

  // Whatever the problems are, they must be reported index-ascending — the
  // parallel pass must not have reordered the sequential report.
  for (const result of [bad, broken, outOfOrder]) {
    const indexes = result.problems.map((p) => p.index);
    assert.deepEqual(indexes, [...indexes].sort((a, b) => a - b),
      'problems must stay in index order');
  }
});

test('an empty chain still verifies to GENESIS', async () => {
  const empty = await AT.verifyChain([]);
  assert.equal(empty.valid, true);
  assert.equal(empty.length, 0);
  assert.ok(typeof empty.head === 'string' && empty.head.length > 0);
});

/* ---------------- perps: probe one position, not the whole book -------- */

test('the liquidation probe clones ONE position, never the whole book', () => {
  const fn = perpsContentJs.slice(
    perpsContentJs.indexOf('function watchLiquidations()'),
    perpsContentJs.indexOf('/* ------------------------------- UI ---'),
  );
  assert.ok(fn, 'watchLiquidations must exist');
  assert.ok(!/JSON\.parse\(JSON\.stringify\(state\)\)/.test(fn),
    'cloning the entire perps state per position per tick scales the cost of asking '
    + '"am I liquidated?" with the size of the journal — it must clone the position only');
  assert.match(fn, /const probe = \{ positions: \{ \[pos\.id\]: JSON\.parse\(JSON\.stringify\(pos\)\) \} \}/,
    'the probe carries exactly the one position markPerp touches');
  assert.match(fn, /P\.markPerp\(probe, pos\.id/, 'and markPerp is asked about that probe');
});

test('a one-position probe gives markPerp the same answer as the whole book, and mutates nothing', () => {
  // Build a real book: the position under test plus unrelated ones that the
  // probe deliberately does not carry.
  const state = P.defaultPerpsState();
  const opened = P.openPerp(state, {
    venue: 'hyperliquid', market: 'SOL', side: 'long',
    marginUsd: 100, leverage: 10, price: 100, t: 1_700_000_000,
    params: { maxLeverage: 20, markPx: 100, oraclePx: 100 },
  });
  assert.equal(opened.ok, true, `the fixture position must open (${opened.reason || ''})`);
  const id = Object.keys(state.positions)[0];
  // Noise the probe deliberately does NOT carry — this is the cost that used to
  // be cloned on every tick.
  state.journal = new Array(500).fill(0).map((_, i) => ({ t: i, kind: 'noise' }));
  const before = JSON.parse(JSON.stringify(state));

  for (const px of [100, 1]) { // flat, then far past a 10x long's liquidation
    const whole = JSON.parse(JSON.stringify(state));
    const fromWhole = P.markPerp(whole, id, { price: px });
    const probe = { positions: { [id]: JSON.parse(JSON.stringify(state.positions[id])) } };
    const fromProbe = P.markPerp(probe, id, { price: px });
    assert.equal(fromProbe.ok, fromWhole.ok, `ok must match at ${px}`);
    assert.equal(fromProbe.liquidatable, fromWhole.liquidatable,
      `the liquidation verdict must be identical at ${px} — this is the whole point`);
    assert.equal(fromProbe.liqBreached, fromWhole.liqBreached, `liqBreached must match at ${px}`);
    assert.equal(Math.round(Number(fromProbe.uPnlUsd) * 1e6), Math.round(Number(fromWhole.uPnlUsd) * 1e6),
      `unrealized PnL must match at ${px}`);
  }
  assert.equal(P.markPerp({ positions: { [id]: JSON.parse(JSON.stringify(state.positions[id])) } },
    id, { price: 1 }).liquidatable, true, 'the deep-loss case must actually be liquidatable, '
    + 'or this test would pass vacuously');

  // And the probe must never have touched the live book: marking is a question,
  // not a commitment. Only the committed applyOp path may write.
  assert.deepEqual(state, before,
    'probing must not mutate the real perps state in any way');
});
