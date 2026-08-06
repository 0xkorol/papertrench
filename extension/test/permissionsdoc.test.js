/* The permissions document must describe every host we actually inject into.
 *
 * docs/PERMISSIONS.md is not decoration: it is the text quoted near-verbatim
 * into the Chrome Web Store permission-justification fields, and it is the
 * privacy-facing answer in a public repo to "what does this thing touch?".
 *
 * v3.0.0 added a content-script entry for app.hyperliquid.xyz (paper perps)
 * and the doc still listed only the v2.4.0-era set — so the justification we
 * were about to submit UNDER-DECLARED a host the extension injects into.
 * Nothing caught it, because nothing checked the doc against the manifest.
 * This is that check: add a host, document the host.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const doc = fs.readFileSync(path.join(ROOT, '..', 'docs', 'PERMISSIONS.md'), 'utf8');

/** "https://*.axiom.trade/*" -> "axiom.trade"; "https://app.hyperliquid.xyz/*"
 *  -> "app.hyperliquid.xyz". */
function hostOf(pattern) {
  return String(pattern)
    .replace(/^[a-z*]+:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/^\*\./, '');
}

/** The doc may name the exact host or its registrable domain. */
function documented(host) {
  if (doc.includes(host)) return true;
  const labels = host.split('.');
  return labels.length > 2 && doc.includes(labels.slice(-2).join('.'));
}

test('every host the manifest injects into is described in docs/PERMISSIONS.md', () => {
  const hosts = new Set();
  for (const cs of manifest.content_scripts || []) {
    for (const pattern of cs.matches || []) hosts.add(hostOf(pattern));
  }
  assert.ok(hosts.size > 0, 'the manifest must declare content scripts');

  const undocumented = [...hosts].filter((h) => !documented(h));
  assert.deepEqual(undocumented, [],
    'these hosts are injected into but appear nowhere in docs/PERMISSIONS.md — '
    + 'the store justification quoted from it would under-declare them: '
    + undocumented.join(', '));
});

test('every manifest permission is justified in the permissions table', () => {
  // Same contract one column over: a permission the store asks us to justify
  // must have text to justify it with. `scripting` reached the pinned set in
  // Turbo II and needed its row written before the listing could be honest.
  const perms = manifest.permissions || [];
  assert.ok(perms.length > 0, 'the manifest must declare permissions');
  const missing = perms.filter((p) => !doc.includes(`\`${p}\``));
  assert.deepEqual(missing, [],
    `these permissions have no justification row in docs/PERMISSIONS.md: ${missing.join(', ')}`);
});
