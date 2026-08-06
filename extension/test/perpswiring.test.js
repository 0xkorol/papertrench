/* Wiring contracts for the perps surface.
 *
 * The perps feature must ride the extension's existing trust posture:
 * ZERO new permissions, ZERO new background message types, and a content
 * script stack whose load order satisfies each module's dependencies.
 * These are source contracts in the house style — a refactor that breaks
 * the posture fails here, not in a user's browser.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const contentSrc = fs.readFileSync(path.join(ROOT, 'perps-content.js'), 'utf8');

function perpsEntry() {
  return manifest.content_scripts.find((e) => (e.js || []).includes('perps-content.js'));
}

test('the manifest registers the perps stack on exactly the probed venue hosts', () => {
  const entry = perpsEntry();
  assert.ok(entry, 'a content_scripts entry must load perps-content.js');
  assert.deepEqual([...entry.matches].sort(), [
    'https://*.jup.ag/*',
    'https://app.hyperliquid.xyz/*',
    'https://jup.ag/*',
  ].sort());
  assert.equal(entry.world, 'ISOLATED');
  assert.equal(entry.run_at, 'document_idle');
  assert.equal(entry.all_frames, false);
});

test('the perps stack loads in dependency order', () => {
  const js = perpsEntry().js;
  const order = ['perps-venues.js', 'perps.js', 'bar-store.js', 'ta-core.js', 'perps-sites.js', 'perps-reconcile.js', 'perps-ticket.js', 'perps-content.js'];
  const positions = order.map((f) => js.indexOf(f));
  assert.ok(positions.every((p) => p >= 0), 'every perps module must be in the entry: ' + JSON.stringify(js));
  for (let i = 1; i < positions.length; i++) {
    assert.ok(positions[i] > positions[i - 1],
      order[i] + ' must load after ' + order[i - 1]);
  }
});

test('the perps feature adds ZERO new permissions', () => {
  // The permission list is the trust story; perps must not grow it. The
  // exact list is asserted by load.test.js — here we pin the deltas perps
  // could have been tempted to add.
  assert.ok(!manifest.permissions.includes('alarms'),
    'no background polling: reconciliation is on-wake only');
  const war = JSON.stringify(manifest.web_accessible_resources || []);
  assert.ok(!war.includes('perps'), 'no perps module is web-accessible');
});

test('the feed talks to the venue API directly and adds no background message types', () => {
  assert.match(contentSrc, /api\.hyperliquid\.xyz/, 'direct CORS fetch (verified allow-origin: *)');
  assert.ok(!/chrome\.runtime\.sendMessage/.test(contentSrc),
    'no new background chatter: the perps surface is self-contained');
  const backgroundSrc = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  assert.ok(!/pt_perps/.test(backgroundSrc), 'background.js stays untouched by perps');
});

/* ---------------- carry: leverage is never free while you hold it ----------
 *
 * The ticket quotes a funding/borrow cost per hour before every entry. If the
 * surface never charges it, the paper position is permanently cheaper than
 * the real venue and its liquidation price never drifts the way the real one
 * does — the exact "free leverage" lesson this product exists to prevent.
 */

test('a live Jupiter position is actually charged the borrow the ticket quoted', () => {
  assert.match(contentSrc, /P\.accrueJupBorrow\(/,
    'the content script must charge Jupiter borrow, not merely display a rate');
  assert.match(contentSrc, /hourlyRateFrac: jupBorrowFrac/,
    'and it must charge the venue\'s own displayed rate');
  const fn = contentSrc.slice(
    contentSrc.indexOf('async function accrueJupBorrowLive'),
    contentSrc.indexOf('async function reconcileOnBoot'),
  );
  assert.ok(fn, 'accrueJupBorrowLive must exist');
  assert.match(fn, /if \(!Number\.isFinite\(jupBorrowFrac\)/,
    'no live rate means no charge — an invented rate is worse than an honest gap');
});

test('the observed-until stamp advances ONLY as part of applying carry', () => {
  // A bare heartbeat that stamped lastSeenMs consumed the very window the
  // funding replay reads, so an open tab paid no funding at all. The stamp
  // must therefore live inside the carry paths, and nowhere else.
  const stamps = contentSrc.match(/lastSeenMs = nowMs/g) || [];
  assert.ok(stamps.length >= 3, 'the carry paths each stamp their own settlement');
  assert.ok(!/function persistSeen/.test(contentSrc),
    'the bare heartbeat must be gone — it silently skipped the carry window');
  const carry = contentSrc.slice(
    contentSrc.indexOf('async function carryTick()'),
    contentSrc.indexOf('/* ------------------------------- UI ---'),
  );
  assert.ok(carry, 'carryTick must exist');
  assert.match(carry, /reconcileHlPosition/, 'HL settles through the venue-history reconciler');
  assert.match(carry, /accrueJupBorrowLive/, 'Jupiter accrues at the live displayed rate');
  assert.match(contentSrc, /managedInterval\(carryTick, CARRY_TICK_MS\)/,
    'and the carry must run on its own cadence, not only at boot');
});

test('funding is applied with an explicit mark, never a stale stored one', () => {
  const calls = contentSrc.match(/P\.applyHlFunding\([^;]*?\);/gs) || [];
  assert.ok(calls.length >= 2, 'both reconciler verdicts settle funding');
  for (const call of calls) {
    assert.match(call, /markPx:/,
      'the caller observes the mark; the engine must not reach into stored state for it');
  }
});

test('the content script honors the orphaned-script doctrine', () => {
  assert.match(contentSrc, /chrome\.runtime\.id/, 'context-invalidation guard');
  assert.match(contentSrc, /visibilityState/, 'intervals defer while hidden');
});

test('storage writes are revision-guarded, and tick state persists lazily', () => {
  assert.match(contentSrc, /rev/, 'revision-guarded read-modify-write');
  assert.ok(!/set\(\{ \[STORE_KEY\][^}]*\}\)[\s\S]{0,80}onTitle/.test(contentSrc),
    'no storage write on the tick path');
});
