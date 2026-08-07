'use strict';
// The URL corpus: the distinct pages the site actually served during a capture,
// each annotated with what the capture SAW there (did prices tick? how many?
// does it look like a token page / list / history page?). Two consumers:
//   - the coverage scorecard (§0): is this capture landable, or too thin?
//   - the verifier (`check`): run the real adapter over these real URLs and
//     flag decisions that disagree with the evidence.
// Keeping the classification here (not in distill) keeps both honest and lets
// the verifier reuse the exact same annotations the dossier showed.

const { normalizeUrl } = require('./schema');

const HISTORY_RE = /\b(wallet|holders?|holding|portfolio|leaderboard|positions?|activity|history|txns?|transactions?|pnl|top-?traders?|trader|profile|account|settings|watchlist)\b/i;
const LIST_RE = /\b(trending|screener|pulse|memescope|discover|explore|new-?pairs?|gainers|losers|movers|feed|home|markets?|tokens?|pairs?)\b/i;

function classifyUrl(rawUrl, priceInfo) {
  const norm = normalizeUrl(rawUrl);
  if (!norm) return null;
  const path = norm.path || '';
  const hasVar = /\{(address|evm|uuid|mixed-id)\}/.test(norm.pattern);
  const looksHistoryPage = HISTORY_RE.test(path);
  const priceNodeCount = priceInfo ? priceInfo.nodeCount : 0;
  const hadLivePrice = priceInfo ? priceInfo.hadLivePrice : false;
  // A list/screener page shows MANY prices (a table); a token page shows one
  // dominant ticker. Use both the URL vocabulary and the node count.
  const looksListPage = (LIST_RE.test(path) && !hasVar) || priceNodeCount >= 8;
  // A token page: a variable address segment, not a history/list route.
  const looksTokenPage = hasVar && !looksHistoryPage && !looksListPage;
  return {
    host: norm.host,
    pattern: norm.pattern,
    chain: norm.chainCandidates.map((c) => c.seg)[0] || null,
    hasVar,
    priceNodeCount,
    hadLivePrice,
    looksHistoryPage,
    looksListPage,
    looksTokenPage,
  };
}

// domsigEvents: parsed domsig lines [{t, href, prices:[[path,txt],...]}]
// Returns Map<href, {nodeCount, hadLivePrice}>.
function pricesByHref(domsigEvents) {
  const perHref = new Map(); // href -> Map<path, Set<txt>>
  for (const ev of domsigEvents) {
    if (!ev.href || !Array.isArray(ev.prices)) continue;
    let m = perHref.get(ev.href);
    if (!m) { m = new Map(); perHref.set(ev.href, m); }
    for (const [pathSel, txt] of ev.prices) {
      if (!pathSel) continue;
      let s = m.get(pathSel);
      if (!s) { s = new Set(); m.set(pathSel, s); }
      if (s.size < 8) s.add(txt);
    }
  }
  const out = new Map();
  for (const [href, m] of perHref) {
    let live = false;
    for (const s of m.values()) if (s.size > 1) { live = true; break; }
    out.set(href, { nodeCount: m.size, hadLivePrice: live });
  }
  return out;
}

// Build the corpus from a capture's nav/doc URLs.
// navEvents: events with .href or .url ; network: Document entries.
function buildCorpus(navEvents, domsigEvents, docEntries, scrubber) {
  const priceMap = pricesByHref(domsigEvents);
  const seen = new Map(); // scrubbedUrl -> entry (deduped)
  const chainsSeen = new Set(); // every chain slug across ALL urls, pre-dedup

  const consider = (rawUrl) => {
    if (!rawUrl || /^about:|^chrome:|^data:/.test(rawUrl)) return;
    const cls = classifyUrl(rawUrl, priceMap.get(rawUrl));
    if (!cls) return;
    if (cls.chain) chainsSeen.add(cls.chain);
    const scrubbed = scrubber ? scrubber.scrubUrl(rawUrl) : rawUrl;
    // Dedup on the normalized pattern+host so ten token pages collapse to the
    // shape, but keep one concrete example (the first) for detect().
    const key = cls.host + cls.pattern;
    const existing = seen.get(key);
    if (existing) {
      existing.count++;
      // Prefer to remember an example that actually ticked a price.
      if (!existing.hadLivePrice && cls.hadLivePrice) { existing.example = scrubbed; existing.hadLivePrice = true; existing.priceNodeCount = Math.max(existing.priceNodeCount, cls.priceNodeCount); }
      existing.priceNodeCount = Math.max(existing.priceNodeCount, cls.priceNodeCount);
      return;
    }
    seen.set(key, {
      example: scrubbed, host: cls.host, pattern: cls.pattern, chain: cls.chain,
      count: 1, hasVar: cls.hasVar, priceNodeCount: cls.priceNodeCount, hadLivePrice: cls.hadLivePrice,
      looksHistoryPage: cls.looksHistoryPage, looksListPage: cls.looksListPage, looksTokenPage: cls.looksTokenPage,
    });
  };

  for (const e of navEvents) consider(e.href || e.url);
  for (const n of docEntries) consider(n.url);

  const urls = [...seen.values()].sort((a, b) => b.count - a.count);

  // Coverage buckets: is this capture landable? Chains come from ALL urls
  // (pre-dedup) — collapsing /solana and /base into /{chain} must not hide
  // that two chains were browsed.
  const chains = chainsSeen;
  const tokenPages = urls.filter((u) => u.looksTokenPage);
  const listPages = urls.filter((u) => u.looksListPage);
  const historyPages = urls.filter((u) => u.looksHistoryPage);
  const refuseCandidates = urls.filter((u) => u.looksHistoryPage || (u.looksListPage && !u.looksTokenPage));
  const tokenWithLivePrice = tokenPages.filter((u) => u.hadLivePrice);

  const gaps = [];
  if (tokenPages.length === 0) gaps.push('no token page captured (a page with an address in the path) — the adapter\'s main job is unverifiable');
  if (tokenWithLivePrice.length === 0) gaps.push('no token page showed a LIVE-ticking price — the market-vs-history call and the price bridge cannot be grounded (browse a token page and sit ~30s)');
  if (historyPages.length === 0) gaps.push('no holders/wallet/history page captured — the O-10 refuse corpus and the pollution locks have nothing to bite on');
  if (chains.size < 2) gaps.push(`only ${chains.size} chain slug seen — if the site is multichain, the slug vocabulary is incomplete (browse a second chain)`);
  if (refuseCandidates.length === 0) gaps.push('no must-refuse route captured (settings/screener/wallet) — sitegating has no negative rows');

  const verdict = gaps.length === 0 ? 'LANDABLE'
    : (tokenPages.length === 0 || tokenWithLivePrice.length === 0) ? 'THIN — not landable yet'
    : 'PARTIAL — usable but has gaps';

  return {
    urls,
    coverage: {
      verdict, gaps,
      counts: {
        distinctPages: urls.length,
        tokenPages: tokenPages.length,
        tokenPagesWithLivePrice: tokenWithLivePrice.length,
        listPages: listPages.length,
        historyPages: historyPages.length,
        refuseCandidates: refuseCandidates.length,
        chains: chains.size,
      },
      chains: [...chains],
    },
  };
}

module.exports = { buildCorpus, classifyUrl, pricesByHref, HISTORY_RE, LIST_RE };
