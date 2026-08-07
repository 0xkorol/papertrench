#!/usr/bin/env node
'use strict';
// pt-recon — capture a real browsing session in full, distill it into a
// read-first, evidence-cited site dossier. See docs/RECON.md.
//
// Zero dependencies. Node >= 22 (global WebSocket), any Chrome/Chromium binary.
//
//   node tools/recon/ptrecon.js capture --site <id> [--url U | --auto U1,U2]
//                                       [--headless] [--minutes N] [--chrome PATH]
//   node tools/recon/ptrecon.js distill --site <id> [--capture DIR]
//   node tools/recon/ptrecon.js list

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { runCapture } = require('./lib/capture');
const { distill } = require('./lib/distill');
const { runVerify, assembleExamples } = require('./lib/verify');
const { makeScrubber, loadDenylist } = require('./lib/scrub');
const { scaffold } = require('./lib/scaffold');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
// Raw captures hold cookies/auth/balances. Default location is recon-data/
// (gitignored), but PT_RECON_DATA moves the whole store off the repo tree
// entirely — preferred, so secrets never sit inside a public working copy.
const DATA_ROOT = process.env.PT_RECON_DATA
  ? path.resolve(process.env.PT_RECON_DATA)
  : path.join(REPO_ROOT, 'recon-data');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

function findChrome(explicit) {
  const candidates = [
    explicit,
    process.env.PT_RECON_CHROME,
    process.env.CHROME_PATH,
    // Playwright's cached Chromium (present on this machine).
    ...playwrightChromium(),
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    // WSL-visible Windows Chrome (for a Linux node).
    '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
    '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    // Native Windows paths (for a win32 node, e.g. the split-brain shim here).
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* keep looking */ }
  }
  throw new Error('no Chrome/Chromium found — pass --chrome PATH or set PT_RECON_CHROME');
}

function playwrightChromium() {
  const base = path.join(process.env.HOME || '', '.cache', 'ms-playwright');
  const out = [];
  try {
    for (const dir of fs.readdirSync(base)) {
      if (!dir.startsWith('chromium-') || dir.includes('headless')) continue;
      const bin = path.join(base, dir, 'chrome-linux', 'chrome');
      if (fs.existsSync(bin)) out.push(bin);
    }
  } catch { /* no playwright cache */ }
  return out;
}

function siteDir(site) {
  if (!site || site === true) throw new Error('--site <id> is required');
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(site)) throw new Error(`bad --site id: ${site}`);
  return path.join(DATA_ROOT, 'sites', site);
}

function stamp() {
  // Filesystem-safe sortable timestamp. Date is allowed here (real CLI run).
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

function loadDenylistText() {
  const f = path.join(DATA_ROOT, 'DENYLIST.local');
  try { return fs.readFileSync(f, 'utf8'); } catch { return ''; }
}

async function cmdCapture(args) {
  const site = args.site;
  const sd = siteDir(site);
  const chrome = findChrome(args.chrome);
  // Chrome's profile (LevelDB, singleton locks) is unreliable on the WSL 9P
  // share seen as a UNC path by a win32 Chrome. Keep the profile on native
  // local storage; only the capture output needs to live in the data tree.
  let profileDir = path.join(sd, 'profile');
  if (process.platform === 'win32' && /^\\\\/.test(path.resolve(profileDir))) {
    profileDir = path.join(os.tmpdir(), 'ptrecon-profiles', site);
    process.stderr.write(`[pt-recon] profile relocated to native temp (data dir is a UNC share): ${profileDir}\n`);
  }
  const capDir = path.join(sd, 'captures', stamp());
  fs.mkdirSync(capDir, { recursive: true });

  const autoUrls = args.auto && args.auto !== true
    ? String(args.auto).split(',').map((s) => s.trim()).filter(Boolean)
    : null;
  const startUrl = args.url && args.url !== true ? String(args.url) : (autoUrls ? autoUrls[0] : 'about:blank');
  // Auto mode defaults to headless, but Cloudflare/DataDome-protected sites
  // (most terminals) challenge headless — `--headed` forces a real window so
  // the passive bot check passes. `--headless` forces the reverse.
  const headless = args.headed ? false : (!!args.headless || !!autoUrls);
  const minutes = args.minutes && args.minutes !== true ? Number(args.minutes) : (autoUrls ? 0 : 15);

  process.stderr.write(`\n[pt-recon] capture → ${path.relative(REPO_ROOT, capDir)}\n`);
  process.stderr.write(`[pt-recon] chrome: ${chrome}\n`);
  process.stderr.write(`[pt-recon] mode: ${autoUrls ? 'auto (' + autoUrls.length + ' urls)' : 'headed'}${headless ? ' [headless]' : ''}\n`);
  if (!autoUrls) {
    process.stderr.write('\n  BROWSE THE SITE to cover the dossier. Suggested script:\n');
    for (const step of [
      'Home / discover page.',
      'A token/pair page — sit on it ~30s so the live price ticks.',
      'The holders / top-traders tab (this is the HISTORY that must not price).',
      'Trade-history or your positions view if present.',
      'A second chain, if multichain (the chain-slug vocabulary).',
      'A URL that must NOT mount (settings, docs) — the refuse corpus.',
      'A logged-out → login wall, if you can, for the auth diff.',
    ]) process.stderr.write(`    • ${step}\n`);
    process.stderr.write('\n  Close the browser window (or Ctrl-C here) when done.\n\n');
  }

  const manifest = await runCapture({ site, capDir, chrome, profileDir, headless, startUrl, autoUrls, minutes });
  process.stderr.write(`\n[pt-recon] capture complete: ${JSON.stringify(manifest.counts)}\n`);
  process.stderr.write(`[pt-recon] next: node tools/recon/ptrecon.js distill --site ${site}\n`);
}

function newestCapture(site) {
  const capsDir = path.join(siteDir(site), 'captures');
  const dirs = fs.existsSync(capsDir)
    ? fs.readdirSync(capsDir).filter((d) => fs.existsSync(path.join(capsDir, d, 'manifest.json')))
    : [];
  if (!dirs.length) return null;
  dirs.sort();
  return path.join(capsDir, dirs[dirs.length - 1]);
}

async function cmdDistill(args) {
  const site = args.site;
  const capDir = args.capture && args.capture !== true
    ? path.resolve(String(args.capture))
    : newestCapture(site);
  if (!capDir) throw new Error(`no completed capture for site "${site}" — run capture first`);
  const outDir = path.join(siteDir(site), 'dossier');
  process.stderr.write(`[pt-recon] distilling ${path.relative(REPO_ROOT, capDir)} → ${path.relative(REPO_ROOT, outDir)}\n`);
  const res = distill(capDir, outDir, { denylistText: loadDenylistText() });
  if (res.captureBlocked) {
    process.stderr.write(`\n[pt-recon] ⚠️  CAPTURE VOID — the site served a bot challenge, not the app.\n`);
    process.stderr.write(`[pt-recon]     This dossier describes the challenge page. Re-run HEADED:\n`);
    process.stderr.write(`[pt-recon]     node tools/recon/ptrecon.js capture --site ${site} --url <URL> --headed\n`);
  }
  process.stderr.write(`\n[pt-recon] dossier written:\n`);
  process.stderr.write(`  endpoints=${res.counts.endpoints} ws=${res.counts.wsChannels} routes=${res.counts.routes} provNodes=${res.counts.provenanceNodes}\n`);
  process.stderr.write(`  chainSlugs=${res.counts.chainSlugs} redactions=${res.counts.redactions} injectionFlags=${res.counts.injectionHits}\n`);
  process.stderr.write(`  OPEN QUESTIONS: ${res.counts.openQuestions}\n`);
  for (const q of res.questions) process.stderr.write(`    [${q.id}] ${q.text.slice(0, 90)}…\n`);
  process.stderr.write(`\n[pt-recon] read: ${path.relative(REPO_ROOT, path.join(outDir, 'DOSSIER.md'))}\n`);
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* torn tail */ }
  }
  return out;
}

async function cmdCheck(args) {
  const site = args.site;
  const capDir = args.capture && args.capture !== true ? path.resolve(String(args.capture)) : newestCapture(site);
  if (!capDir) throw new Error(`no completed capture for site "${site}" — run capture first`);
  const dossierDir = path.join(siteDir(site), 'dossier');
  const corpusPath = path.join(dossierDir, 'corpus.json');
  if (!fs.existsSync(corpusPath)) throw new Error(`no corpus.json — run distill --site ${site} first`);

  const adapterPath = args.adapter && args.adapter !== true
    ? path.resolve(String(args.adapter))
    : path.join(REPO_ROOT, 'extension', 'sites.js');
  if (!fs.existsSync(adapterPath)) throw new Error(`adapter not found: ${adapterPath} (pass --adapter PATH)`);
  const adapterSrc = fs.readFileSync(adapterPath, 'utf8');

  // Raw nav/doc URLs (unscrubbed, local only) give detect() faithful input;
  // the corpus supplies the annotations and the scrubber the display form.
  const events = readJsonl(path.join(capDir, 'raw', 'events.jsonl'));
  const network = readJsonl(path.join(capDir, 'raw', 'network.jsonl'));
  const rawUrls = [
    ...events.filter((e) => e.ev === 'nav' && (e.href || e.url)).map((e) => ({ url: e.href || e.url })),
    ...network.filter((n) => n.resourceType === 'Document' && n.url).map((n) => ({ url: n.url })),
  ];
  const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
  const scrubber = makeScrubber(loadDenylist(loadDenylistText()));

  const examples = assembleExamples(rawUrls, corpus.urls || [], scrubber);
  if (!examples.length) throw new Error('no testable URLs in the capture — the corpus is empty');
  const { rows, summary } = runVerify(adapterSrc, examples);

  process.stderr.write(`\n[pt-recon] check — ${path.relative(REPO_ROOT, adapterPath)} vs ${examples.length} real pages from ${path.basename(capDir)}\n\n`);
  const icon = (r) => r.error ? '⚠️ ' : r.mounted ? '● MOUNT ' : '○ refuse';
  for (const r of rows) {
    const detail = r.error ? r.error : r.mounted ? `${r.kind || '?'} ${short(r.address)} chain=${r.chain || '—'}` : '';
    const tag = r.ann.looksTokenPage ? '[token]' : r.ann.looksHistoryPage ? '[history]' : r.ann.looksListPage ? '[list]' : '[other]';
    process.stderr.write(`  ${icon(r)} ${tag}${r.ann.hadLivePrice ? '·live' : ''}  ${short(r.display, 66)}\n`);
    if (detail) process.stderr.write(`           → ${detail}\n`);
    for (const f of r.flags) process.stderr.write(`           ${f.level === 'high' ? '🔴' : f.level === 'medium' ? '🟡' : f.level === 'error' ? '⚠️ ' : '·'} ${f.code}: ${f.why}\n`);
  }
  process.stderr.write(`\n[pt-recon] ${summary.verdict}\n`);
  process.stderr.write(`  token pages mounted: ${summary.tokenPagesMounted}/${summary.tokenPagesTotal} · refuse-candidates refused: ${summary.refuseCandidatesRefused}/${summary.refuseCandidatesTotal}\n`);
  process.stderr.write(`  flags: ${summary.high} high, ${summary.medium} medium${summary.errors ? ', ' + summary.errors + ' adapter errors' : ''}\n`);
  if (summary.high || summary.errors) process.exitCode = 1;
}

function short(s, n = 44) {
  if (!s) return '—';
  s = String(s);
  return s.length > n ? '…' + s.slice(-n) : s;
}

function cmdScaffold(args) {
  const site = args.site;
  const dossierDir = path.join(siteDir(site), 'dossier');
  if (!fs.existsSync(path.join(dossierDir, 'corpus.json'))) throw new Error(`no dossier for "${site}" — run distill --site ${site} first`);
  const outDir = path.join(siteDir(site), 'scaffold');
  const res = scaffold(dossierDir, outDir, site);
  process.stderr.write(`\n[pt-recon] scaffold → ${path.relative(REPO_ROOT, outDir)}\n`);
  for (const f of res.files) process.stderr.write(`  ${f}\n`);
  process.stderr.write(`  from: ${res.tokenPages} token page(s), ${res.refuseRoutes} refuse route(s), ${res.endpoints} endpoint(s), ${res.wsChannels} WS channel(s)\n`);
  if (!res.tokenPages) process.stderr.write(`  ⚠️  no token page captured — the gating test has no positive rows. Capture one and re-run.\n`);
  process.stderr.write(`  These are DRAFTS with TODOs — confirm against the dossier + live site, prove the lock can fail, then copy into extension/test/.\n`);
}

function cmdList() {
  const sitesDir = path.join(DATA_ROOT, 'sites');
  if (!fs.existsSync(sitesDir)) { process.stderr.write('(no captures yet)\n'); return; }
  for (const site of fs.readdirSync(sitesDir).sort()) {
    const capsDir = path.join(sitesDir, site, 'captures');
    const caps = fs.existsSync(capsDir) ? fs.readdirSync(capsDir).sort() : [];
    const hasDossier = fs.existsSync(path.join(sitesDir, site, 'dossier', 'DOSSIER.md'));
    process.stderr.write(`${site}: ${caps.length} capture(s)${hasDossier ? ', dossier ✓' : ''}\n`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  try {
    if (cmd === 'capture') await cmdCapture(args);
    else if (cmd === 'distill') await cmdDistill(args);
    else if (cmd === 'check') await cmdCheck(args);
    else if (cmd === 'scaffold') cmdScaffold(args);
    else if (cmd === 'list') cmdList();
    else {
      process.stderr.write('pt-recon — capture a site, distill a dossier.\n\n');
      process.stderr.write('  capture --site <id> [--url U | --auto U1,U2] [--headed] [--minutes N] [--chrome PATH]\n');
      process.stderr.write('  distill --site <id> [--capture DIR]\n');
      process.stderr.write('  check    --site <id> [--adapter extension/sites.js]  # run your detect() over the real corpus\n');
      process.stderr.write('  scaffold --site <id>                                 # draft the gating test + fake from the dossier\n');
      process.stderr.write('  list\n\n');
      process.stderr.write('See docs/RECON.md.\n');
      process.exitCode = cmd ? 1 : 0;
    }
  } catch (e) {
    process.stderr.write(`\n[pt-recon] ERROR: ${e.message}\n`);
    process.exitCode = 1;
  }
}

main();
