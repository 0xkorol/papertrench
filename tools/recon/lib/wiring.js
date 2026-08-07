'use strict';
// The landing-completeness checker — the "left on the table" guard. Adding a
// site touches ~10 files with NO central registry, so it is easy to wire the
// adapter and forget warmdest / xray-core / the manifest's third list. This
// greps every touch-list file for the new host and reports what is still
// missing, using the dossier to resolve the conditional ones.
//
// It is a CHECKLIST, not a lock: a presence grep proves spelling, not
// correctness (docs/ADDING-A-SITE.md). `check` verifies the adapter's logic;
// the extension's own tests (sitegating, permissionsdoc, threesites) own the
// contract. This just makes sure you did not skip a registration point.

const fs = require('node:fs');
const path = require('node:path');

// Registrable domain = last two labels (padre.gg from trade.padre.gg). Good
// enough for the presence grep; some files key on the bare label.
function registrable(host) {
  const parts = String(host || '').split('.').filter(Boolean);
  return parts.length <= 2 ? host : parts.slice(-2).join('.');
}

// The host appears in many legitimate forms: the bare origin (gmgn.ai), an
// escaped regex (gmgn\.ai in xray-core's CA_HOST_RE), a wildcard (*.gmgn.ai),
// and — in PROSE files (README, site, QA-MATRIX) — the DISPLAY NAME (GMGN), not
// the host at all. So: strip regex backslashes, case-fold, and match the host,
// the registrable domain, its distinctive label, or an explicit display name.
function present(content, host, name) {
  if (!content) return false;
  const norm = content.replace(/\\/g, '').toLowerCase();
  const hostL = String(host).toLowerCase();
  const reg = registrable(host).toLowerCase();
  const label = reg.split('.')[0]; // gmgn, dexscreener, padre, tinyastro
  if (norm.includes(hostL)) return { how: host };
  if (reg !== hostL && norm.includes(reg)) return { how: reg };
  if (label.length >= 4 && norm.includes(label)) return { how: label };
  if (name && norm.includes(String(name).toLowerCase())) return { how: name };
  return false;
}

// The manifest needs the origin in THREE places: a MAIN-world content_scripts
// block, an ISOLATED-world block, and web_accessible_resources.
function checkManifest(manifestPath, host) {
  let m;
  try { m = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { return { ok: false, error: 'manifest.json unreadable' }; }
  const reg = registrable(host);
  const hit = (arr) => (arr || []).some((s) => typeof s === 'string' && (s.includes(host) || s.includes(reg)));
  const cs = m.content_scripts || [];
  const inMain = cs.some((b) => (b.world === 'MAIN') && hit(b.matches));
  const inIsolated = cs.some((b) => (b.world !== 'MAIN') && hit(b.matches));
  const war = m.web_accessible_resources || [];
  const inWar = war.some((b) => hit(b.matches)); // WAR blocks gate by origin in `matches`
  return { ok: inMain && inIsolated && inWar, inMain, inIsolated, inWar };
}

function checkWiring(repoRoot, host, dossier, name) {
  const read = (rel) => { try { return fs.readFileSync(path.join(repoRoot, rel), 'utf8'); } catch { return null; } };
  const has = (rel) => !!present(read(rel), host, name);
  const summary = dossier || {};
  const titleFits = summary.titleDefaultFits !== false; // default: assume fits unless the dossier says otherwise
  const hasPollution = Array.isArray(summary.pollutionKeys) && summary.pollutionKeys.length > 0;

  const rows = [];
  const add = (file, label, status, need, note, kind) => rows.push({ file, label, status, need, note, kind: kind || 'code' });

  // sites.js — the adapter.
  add('extension/sites.js', 'adapter match()/detect()/tokenUrl()', has('extension/sites.js'), 'required');

  // manifest.json — the three lists.
  const man = checkManifest(path.join(repoRoot, 'extension/manifest.json'), host);
  const manStatus = man.ok;
  add('extension/manifest.json', 'origin in MAIN + ISOLATED content_scripts + web_accessible_resources', manStatus, 'required',
    man.error ? man.error : (manStatus ? null : `missing from: ${[!man.inMain && 'MAIN', !man.inIsolated && 'ISOLATED', !man.inWar && 'web_accessible_resources'].filter(Boolean).join(', ')}`));

  add('extension/background.js', 'WARM_PLATFORM_URLS + WARM_DEST_FAMILIES entry', has('extension/background.js'), 'required');
  add('extension/warmdest.js', 'host RegExp + classify() branch + familyOfHost line', has('extension/warmdest.js'), 'required');
  add('extension/xray-core.js', 'CA_HOST_RE (X links to it count as CA carriers)', has('extension/xray-core.js'), 'required');

  // title-feed.js — conditional on the dossier's title verdict.
  add('extension/title-feed.js', 'TITLE_PATTERNS entry', has('extension/title-feed.js'),
    titleFits ? 'optional' : 'required',
    titleFits ? 'dossier: default $-keyed title pattern FITS — only add an entry if the live title differs'
              : 'dossier: default $-keyed title pattern does NOT fit — a TITLE_PATTERNS entry is REQUIRED');

  add('docs/PERMISSIONS.md', 'host + justification (permissionsdoc.test.js enforces)', has('docs/PERMISSIONS.md'), 'required');
  // Prose files key on the DISPLAY NAME (often abbreviated — QA-MATRIX uses
  // "DexScr"), which is not derivable from a host, so a miss here is "confirm by
  // hand", not a hard failure. scripts/preflight.sh enforces the README/site
  // counters at build time regardless.
  const proseNote = 'keyed by display name (may be abbreviated) — confirm by hand' + (name ? '' : '; or pass --name <Name>');
  add('docs/QA-MATRIX.md', 'a column (stays empty until the live pass)', has('docs/QA-MATRIX.md'), 'required', proseNote, 'prose');
  add('README.md', 'supported-sites prose + counter', has('README.md'), 'required', proseNote, 'prose');
  add('site/index.html', 'marquee chip + data-check="sites" counter', has('site/index.html'), 'required', proseNote, 'prose');

  // price-bridge.js is NOT a host-presence check: the doctrine forbids a
  // site-named branch there (threesites.test.js locks against it). Instead,
  // remind the operator to fold the captured pollution key spellings into the
  // GENERIC guards, if the dossier found any.
  const priceBridgeNote = hasPollution
    ? `fold these captured history-key spellings into the GENERIC guards (never a site-named branch): ${summary.pollutionKeys.slice(0, 12).join(', ')}`
    : 'no history-shaped pollution keys captured — extend the generic guards only if a later capture finds some';

  // Code files are reliably checkable (the host appears literally); prose files
  // are best-effort. Only missing CODE registrations are a hard failure.
  const missingRequired = rows.filter((r) => r.kind === 'code' && r.need === 'required' && !r.status);
  const proseUnconfirmed = rows.filter((r) => r.kind === 'prose' && !r.status);
  const missingOptional = rows.filter((r) => r.need === 'optional' && !r.status);
  const verdict = missingRequired.length > 0
    ? `${missingRequired.length} REQUIRED code registration(s) missing`
    : proseUnconfirmed.length
      ? 'CODE FULLY WIRED — confirm the prose file(s) by hand'
      : 'FULLY WIRED';

  return { host, rows, priceBridgeNote, missingRequired, proseUnconfirmed, missingOptional, verdict };
}

module.exports = { checkWiring, registrable };
