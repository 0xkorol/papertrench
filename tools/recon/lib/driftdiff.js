'use strict';
// Drift watch — diff two dossiers so a site redesign surfaces as a review, not
// a user bug report. A renamed route, a dropped DOM anchor, a WS that went from
// live to rejected: these are how a landed adapter silently rots. Re-capture on
// a schedule, diff, and the change is a work order with the evidence attached.
//
// Reads the machine sidecars (routes/endpoints/ws/anchors/summary), not the
// prose, so the diff is structural. REMOVED things (a route/endpoint/anchor the
// shipped adapter may depend on) are warnings; ADDED things are informational.

const fs = require('node:fs');
const path = require('node:path');

function readJson(dir, name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { return fallback; }
}

function setDiff(oldArr, newArr, keyFn) {
  const oldKeys = new Map(oldArr.map((x) => [keyFn(x), x]));
  const newKeys = new Map(newArr.map((x) => [keyFn(x), x]));
  const added = [...newKeys.keys()].filter((k) => !oldKeys.has(k));
  const removed = [...oldKeys.keys()].filter((k) => !newKeys.has(k));
  return { added, removed };
}

function diffDossiers(oldDir, newDir) {
  const oldRoutes = readJson(oldDir, 'routes.json', []);
  const newRoutes = readJson(newDir, 'routes.json', []);
  const oldEps = readJson(oldDir, 'endpoints.json', []);
  const newEps = readJson(newDir, 'endpoints.json', []);
  const oldWs = readJson(oldDir, 'ws.json', []);
  const newWs = readJson(newDir, 'ws.json', []);
  const oldAnch = readJson(oldDir, 'anchors.json', []);
  const newAnch = readJson(newDir, 'anchors.json', []);
  const oldSum = readJson(oldDir, 'summary.json', {});
  const newSum = readJson(newDir, 'summary.json', {});

  const routes = setDiff(oldRoutes, newRoutes, (r) => `${r.host}${r.pattern}`);
  const endpoints = setDiff(oldEps, newEps, (e) => `${e.method} ${e.host}${e.pattern}`);
  const ws = setDiff(oldWs, newWs, (c) => hostOf(c.url));

  // Anchors that mattered (high observation count) and vanished — the dock /
  // selector class most likely to silently break on a redesign.
  const STABLE_OBS = 10;
  const oldStable = oldAnch.filter((a) => (a.count || 0) >= STABLE_OBS);
  const anchorsGone = oldStable
    .filter((a) => !newAnch.some((b) => b.path === a.path))
    .map((a) => ({ path: a.path, count: a.count }));

  // Scalar shifts worth naming.
  const shifts = [];
  const oc = new Set(oldSum.chains || []);
  const nc = new Set(newSum.chains || []);
  const chainsAdded = [...nc].filter((c) => !oc.has(c));
  const chainsRemoved = [...oc].filter((c) => !nc.has(c));
  if (chainsRemoved.length) shifts.push({ severity: 'warn', what: `chain slug(s) no longer seen: ${chainsRemoved.join(', ')}` });
  if (chainsAdded.length) shifts.push({ severity: 'info', what: `new chain slug(s): ${chainsAdded.join(', ')}` });
  if (oldSum.titleDefaultFits !== undefined && oldSum.titleDefaultFits !== newSum.titleDefaultFits) {
    shifts.push({ severity: 'warn', what: `tab-title pattern fit changed (${oldSum.titleDefaultFits} → ${newSum.titleDefaultFits}) — title-feed.js may need attention` });
  }
  if (oldSum.hasWsFrames && !newSum.hasWsFrames) shifts.push({ severity: 'warn', what: 'WebSocket that delivered frames before now delivers none (rejected or gone) — the live price source may have moved' });
  if (!oldSum.hasWsFrames && newSum.hasWsFrames) shifts.push({ severity: 'info', what: 'a WebSocket now delivers frames where before none did' });

  const removedCount = routes.removed.length + endpoints.removed.length + ws.removed.length + anchorsGone.length + shifts.filter((s) => s.severity === 'warn').length;
  const verdict = removedCount === 0
    ? (routes.added.length + endpoints.added.length + ws.added.length ? 'NO REGRESSIONS — only additions' : 'NO DRIFT')
    : `${removedCount} thing(s) the adapter may rely on changed or vanished — review`;

  return { routes, endpoints, ws, anchorsGone, shifts, verdict, removedCount };
}

function hostOf(u) { try { return new URL(u).host; } catch { return String(u || '').slice(0, 40); } }

module.exports = { diffDossiers };
