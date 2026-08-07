'use strict';
// The landing-completeness checker — the "left on the table" guard. Adding a
// site touches many files with no central registry, so it is easy to wire the
// adapter and forget one. It greps every touch-list file (declared in the
// project's ptrecon.config.json) for the new host and reports what is missing,
// using the dossier to resolve the conditional ones.
//
// It is a CHECKLIST, not a lock: a presence grep proves spelling, not
// correctness. `check` verifies the adapter's logic; the project's own tests own
// the contract. This just makes sure you did not skip a registration point.

const fs = require('node:fs');
const path = require('node:path');

// Registrable domain = last two labels (padre.gg from trade.padre.gg).
function registrable(host) {
  const parts = String(host || '').split('.').filter(Boolean);
  return parts.length <= 2 ? host : parts.slice(-2).join('.');
}

// The host appears in many legitimate forms: the bare origin (gmgn.ai), an
// escaped regex (gmgn\.ai), a wildcard (*.gmgn.ai), and — in PROSE files — the
// DISPLAY NAME (GMGN), not the host at all. Strip regex backslashes, case-fold,
// and match the host, the registrable domain, its label, or an explicit name.
function present(content, host, name) {
  if (!content) return false;
  const norm = content.replace(/\\/g, '').toLowerCase();
  const hostL = String(host).toLowerCase();
  const reg = registrable(host).toLowerCase();
  const label = reg.split('.')[0];
  if (norm.includes(hostL)) return { how: host };
  if (reg !== hostL && norm.includes(reg)) return { how: reg };
  if (label.length >= 4 && norm.includes(label)) return { how: label };
  if (name && norm.includes(String(name).toLowerCase())) return { how: name };
  return false;
}

// Manifest list checks, keyed by name in config.wiring.touchList[].lists.
function manifestListHit(m, listName, host) {
  const reg = registrable(host);
  const hit = (arr) => (arr || []).some((s) => typeof s === 'string' && (s.includes(host) || s.includes(reg)));
  const cs = m.content_scripts || [];
  switch (listName) {
    case 'main-content-scripts': return cs.some((b) => b.world === 'MAIN' && hit(b.matches));
    case 'isolated-content-scripts': return cs.some((b) => b.world !== 'MAIN' && hit(b.matches));
    case 'content_scripts': return cs.some((b) => hit(b.matches));
    case 'web-accessible-resources':
    case 'web_accessible_resources': return (m.web_accessible_resources || []).some((b) => hit(b.matches));
    case 'host_permissions': return hit(m.host_permissions);
    default: return false;
  }
}

function checkManifest(manifestPath, host, lists) {
  let m;
  try { m = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { return { ok: false, error: 'manifest unreadable' }; }
  const missing = (lists || ['content_scripts']).filter((ln) => !manifestListHit(m, ln, host));
  return { ok: missing.length === 0, missing };
}

// checkWiring(projectRoot, host, dossier, name, wiringConfig)
function checkWiring(projectRoot, host, dossier, name, wiringConfig) {
  const read = (rel) => { try { return fs.readFileSync(path.join(projectRoot, rel), 'utf8'); } catch { return null; } };
  const summary = dossier || {};
  const rows = [];
  const wiring = wiringConfig || {};
  const touchList = Array.isArray(wiring.touchList) ? wiring.touchList : [];

  for (const t of touchList) {
    const kind = t.kind || 'code';
    // Conditional-required: `requiredWhenFalse` — or a STRING `required` — names a
    // dossier-summary flag; the entry is required only when that flag is FALSE
    // (e.g. title-feed only when the default title pattern does NOT fit).
    const condFlag = t.requiredWhenFalse || (typeof t.required === 'string' ? t.required : null);
    let required = t.required === true;
    let note = t.note || null;
    if (condFlag) {
      const flagTrue = summary[condFlag] !== false; // default true unless the dossier says otherwise
      required = !flagTrue;
      note = flagTrue ? (t.noteFits || note) : (t.noteMiss || note);
    }

    let status;
    if (kind === 'manifest') {
      const man = checkManifest(path.join(projectRoot, t.file), host, t.lists);
      status = man.ok;
      if (!status) note = man.error || `missing from: ${(man.missing || []).join(', ')}`;
    } else {
      status = !!present(read(t.file), host, name);
      if (kind === 'prose' && !status && !note) note = 'keyed by display name (may be abbreviated) — confirm by hand' + (name ? '' : '; or pass --name <Name>');
    }
    rows.push({ file: t.file, label: t.label || t.file, status, need: required ? 'required' : 'optional', note, kind });
  }

  const missingRequired = rows.filter((r) => r.kind !== 'prose' && r.need === 'required' && !r.status);
  const proseUnconfirmed = rows.filter((r) => r.kind === 'prose' && r.need === 'required' && !r.status);
  const missingOptional = rows.filter((r) => r.need === 'optional' && !r.status);
  const verdict = missingRequired.length > 0
    ? `${missingRequired.length} REQUIRED code registration(s) missing`
    : proseUnconfirmed.length
      ? 'CODE FULLY WIRED — confirm the prose file(s) by hand'
      : rows.length ? 'FULLY WIRED' : 'NO TOUCH LIST — declare wiring.touchList in ptrecon.config.json';

  // Restore the pre-refactor behavior: append the actual captured history-key
  // spellings from the dossier, so the note is actionable, not just static text.
  let priceBridgeNote = wiring.priceBridgeNote || null;
  const pk = summary.pollutionKeys;
  if (Array.isArray(pk) && pk.length) {
    priceBridgeNote = (priceBridgeNote ? priceBridgeNote + ' — ' : '') + `captured history-key spellings: ${pk.slice(0, 12).join(', ')}`;
  }

  return { host, rows, priceBridgeNote, missingRequired, proseUnconfirmed, missingOptional, verdict };
}

module.exports = { checkWiring, registrable };
