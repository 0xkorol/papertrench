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

test('the content script honors the orphaned-script doctrine', () => {
  assert.match(contentSrc, /chrome\.runtime\.id/, 'context-invalidation guard');
  assert.match(contentSrc, /visibilityState/, 'intervals defer while hidden');
});

test('storage writes are revision-guarded, and tick state persists lazily', () => {
  assert.match(contentSrc, /rev/, 'revision-guarded read-modify-write');
  assert.ok(!/set\(\{ \[STORE_KEY\][^}]*\}\)[\s\S]{0,80}onTitle/.test(contentSrc),
    'no storage write on the tick path');
});
