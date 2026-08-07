'use strict';
// The verifier — the one-shot payoff. It loads the REAL, shipped sites.js the
// same way the extension's own sitegating.test.js does (vm sandbox with a
// `location`), runs `currentSite().detect()` over every page the site actually
// served during the capture, and flags decisions that disagree with the
// evidence the capture recorded. It catches the exact class we keep fixing by
// hand — a token page the adapter refuses, a wallet/holders page it mounts —
// automatically, over the REAL url corpus, before the live pass.
//
// It reports. It does not decide: a flag is a "check this", grounded in what
// the capture saw, not a verdict. The sitegating locks still own the truth.

const vm = require('node:vm');
const { normalizeUrl } = require('./schema');

// Load the shipped adapter source into a fresh sandbox pinned to `href`, and
// return its detection at that URL. Mirrors extension/test/sitegating.test.js
// so the verifier sees exactly what the extension sees.
function detectAt(adapterSrc, href) {
  let url;
  try { url = new URL(href); } catch { return { error: 'bad url' }; }
  const sandbox = {
    window: {}, self: {},
    location: { href, hostname: url.hostname, pathname: url.pathname, search: url.search },
    URL, URLSearchParams, console: { log() {}, warn() {}, error() {} },
  };
  try {
    vm.createContext(sandbox);
    vm.runInContext(adapterSrc, sandbox, { filename: 'sites.js', timeout: 2000 });
    const api = sandbox.window.PaperTrenchSites || sandbox.self.PaperTrenchSites;
    if (!api || typeof api.currentSite !== 'function') return { error: 'sites.js did not expose PaperTrenchSites.currentSite' };
    const site = api.currentSite();
    if (!site) return { siteId: null, token: null };
    let token = null;
    try { token = typeof site.detect === 'function' ? site.detect() : null; } catch (e) { return { siteId: site.id, error: 'detect() threw: ' + e.message }; }
    return { siteId: site.id, token };
  } catch (e) {
    return { error: 'sites.js failed to load: ' + e.message };
  }
}

// examples: [{ rawUrl, display, ann }] where ann is the corpus annotation
// { looksTokenPage, looksListPage, looksHistoryPage, hadLivePrice, priceNodeCount, chain }.
// Returns { rows, summary }.
function runVerify(adapterSrc, examples) {
  const rows = [];
  for (const ex of examples) {
    const res = detectAt(adapterSrc, ex.rawUrl);
    const mounted = !!(res.token && (res.token.kind || res.token.address));
    const flags = [];

    if (res.error) {
      flags.push({ level: 'error', code: 'ADAPTER_ERROR', why: res.error });
    } else {
      const a = ex.ann || {};
      // A page with an address in its path AND a live-ticking price that the
      // adapter refuses is the highest-confidence miss.
      if (!mounted && a.looksTokenPage && a.hadLivePrice) {
        flags.push({ level: 'high', code: 'MISSED_TOKEN_PAGE', why: 'address-in-path page with a LIVE price, but detect() refused it' });
      } else if (!mounted && a.looksTokenPage) {
        flags.push({ level: 'medium', code: 'MAYBE_MISSED', why: 'address-in-path page, but detect() refused (no live price was seen here — confirm it is a token page)' });
      }
      // A wallet/holders/portfolio page that mounts is the O-10 over-mount bug.
      if (mounted && a.looksHistoryPage) {
        flags.push({ level: 'high', code: 'OVER_MOUNT', why: 'history/wallet/holders page MOUNTED — O-10: these must refuse' });
      }
      // A pure list/screener page that mounts is usually wrong too.
      if (mounted && a.looksListPage && !a.looksTokenPage) {
        flags.push({ level: 'medium', code: 'LIST_MOUNT', why: 'list/screener page mounted — usually should refuse (confirm against the route)' });
      }
      // Detected a chain the URL did not name (post-canonicalization mismatch
      // is expected; only flag when the adapter names a chain and the URL named
      // a different, recognizable one).
      if (mounted && res.token.chain && a.chain && !chainsAgree(res.token.chain, a.chain)) {
        flags.push({ level: 'low', code: 'CHAIN_NAME', why: `detect() said chain "${res.token.chain}" but the URL segment was "${a.chain}" — confirm the slug map` });
      }
    }

    rows.push({
      display: ex.display || ex.rawUrl,
      siteId: res.siteId || null,
      mounted,
      kind: res.token ? res.token.kind : null,
      address: res.token ? res.token.address : null,
      chain: res.token ? res.token.chain : null,
      ann: ex.ann || {},
      error: res.error || null,
      flags,
    });
  }

  const summary = {
    total: rows.length,
    mounted: rows.filter((r) => r.mounted).length,
    refused: rows.filter((r) => !r.mounted && !r.error).length,
    tokenPagesMounted: rows.filter((r) => r.ann.looksTokenPage && r.mounted).length,
    tokenPagesTotal: rows.filter((r) => r.ann.looksTokenPage).length,
    refuseCandidatesRefused: rows.filter((r) => (r.ann.looksHistoryPage || (r.ann.looksListPage && !r.ann.looksTokenPage)) && !r.mounted).length,
    refuseCandidatesTotal: rows.filter((r) => r.ann.looksHistoryPage || (r.ann.looksListPage && !r.ann.looksTokenPage)).length,
    high: rows.reduce((n, r) => n + r.flags.filter((f) => f.level === 'high').length, 0),
    medium: rows.reduce((n, r) => n + r.flags.filter((f) => f.level === 'medium').length, 0),
    errors: rows.filter((r) => r.error).length,
  };
  summary.verdict = summary.errors ? 'ADAPTER ERROR'
    : summary.high ? 'DISAGREEMENTS — review the high flags'
    : summary.tokenPagesTotal === 0 ? 'INCONCLUSIVE — no token page in the corpus to test against'
    : 'AGREES with the capture';
  return { rows, summary };
}

// Site slugs canonicalize (sol→solana, eth→ethereum). Treat a slug as agreeing
// if one is a prefix of the other or they share a known alias.
const CHAIN_ALIASES = { sol: 'solana', eth: 'ethereum', bnb: 'bsc', matic: 'polygon', arb: 'arbitrum', avax: 'avalanche', op: 'optimism', trx: 'tron' };
function chainsAgree(a, b) {
  const na = CHAIN_ALIASES[a] || a;
  const nb = CHAIN_ALIASES[b] || b;
  return na === nb || na.startsWith(nb) || nb.startsWith(na);
}

// Assemble the examples list from raw capture URLs + corpus annotations.
// rawUrls: [{url}] distinct nav/doc urls (unscrubbed, local only).
// corpusUrls: the dossier corpus entries (annotations, keyed by host+pattern).
// scrub: scrubber for the DISPLAY url only (raw is used for detect()).
function assembleExamples(rawUrls, corpusUrls, scrub) {
  const annByKey = new Map();
  for (const c of corpusUrls) annByKey.set(c.host + c.pattern, c);
  const seen = new Map();
  for (const u of rawUrls) {
    const raw = u.url || u;
    if (!raw || /^about:|^chrome:|^data:/.test(raw)) continue;
    const norm = normalizeUrl(raw);
    if (!norm) continue;
    const key = norm.host + norm.pattern;
    if (seen.has(key)) continue; // one example per pattern
    const ann = annByKey.get(key) || {};
    seen.set(key, {
      rawUrl: raw,
      display: scrub ? scrub.scrubUrl(raw) : raw,
      ann: {
        looksTokenPage: !!ann.looksTokenPage,
        looksListPage: !!ann.looksListPage,
        looksHistoryPage: !!ann.looksHistoryPage,
        hadLivePrice: !!ann.hadLivePrice,
        priceNodeCount: ann.priceNodeCount || 0,
        chain: ann.chain || norm.chainCandidates.map((c) => c.seg)[0] || null,
      },
    });
  }
  return [...seen.values()];
}

module.exports = { detectAt, runVerify, assembleExamples, chainsAgree };
