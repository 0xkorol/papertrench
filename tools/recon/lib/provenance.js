'use strict';
// The provenance correlator — the piece that automates the market-vs-history
// call that cost us the fomo arc by hand.
//
// Method: every price-shaped DOM value (from the probe's domsig stream) is
// matched against the network values that could have produced it — REST bodies
// and WS frames that carry the same number, arriving shortly BEFORE the DOM
// showed it. An origin that keeps re-emitting a changing value that then ticks
// the same DOM node is a live market feed; an origin that emitted the value
// once, inside a trades/holders/positions payload, is HISTORY. The correlator
// reports evidence with hit counts; it never issues the verdict — the pair-form
// pollution locks still decide (RECON honesty rule 4).

const CORRELATION_WINDOW_MS = 6000; // a DOM value is explained by traffic up to 6s before it appeared

// Pull every numeric token out of a payload string, normalized to a bare
// number form so "$1,234.56", "1234.56", and "1.23456e3" can be compared.
function extractNumbers(text, cap = 20000) {
  const nums = new Set();
  if (typeof text !== 'string' || !text) return nums;
  const slice = text.length > 500000 ? text.slice(0, 500000) : text;
  const re = /-?\d[\d,]*\.?\d*(?:[eE][-+]?\d+)?/g;
  let m;
  let n = 0;
  while ((m = re.exec(slice)) && n < cap) {
    const raw = m[0].replace(/,/g, '');
    if (!/\d/.test(raw)) continue;
    const val = Number(raw);
    if (!Number.isFinite(val)) continue;
    nums.add(canonNum(val));
    n++;
  }
  return nums;
}

// Canonical key for a number: round to 6 significant figures so 1.2345 and
// 1.23450001 (float/render noise) land on the same bucket, then render as a
// plain number. Crucially it does NOT strip integer trailing zeros — the old
// version turned 120000 into "12", collapsing distinct market-caps into one
// bucket and making real mcap/volume values non-distinctive.
function canonNum(val) {
  if (!Number.isFinite(val) || val === 0) return '0';
  const r = Number(val.toPrecision(6));
  let s = r.toString();
  if (s.indexOf('e') !== -1 || s.indexOf('E') !== -1) {
    // Expand exponential to plain decimal so a tiny memecoin price (2e-7) keeps
    // its fractional form and stays distinctive. Strip only FRACTIONAL trailing
    // zeros (the run after the dot) — never integer magnitude.
    s = r.toFixed(20).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  }
  return s;
}

// Parse a DOM price string ("$12.3K", "1,234", "45%") into its numeric value(s).
function domValueToNumbers(txt) {
  const out = new Set();
  if (typeof txt !== 'string') return out;
  const cleaned = txt.replace(/[$€,\s]/g, '');
  const m = cleaned.match(/^-?\d*\.?\d+/);
  if (!m) return out;
  let base = Number(m[0]);
  if (!Number.isFinite(base)) return out;
  out.add(canonNum(base));
  // Suffix-expanded forms so a DOM "$12.3K" matches a raw 12300 in a payload.
  if (/k$/i.test(cleaned)) out.add(canonNum(base * 1e3));
  if (/m$/i.test(cleaned)) out.add(canonNum(base * 1e6));
  if (/b$/i.test(cleaned)) out.add(canonNum(base * 1e9));
  return out;
}

function classifyOriginRole(url, kind) {
  // A match against the page document is the INITIAL server-rendered value, not
  // a live feed — never mistake it for a market API.
  if (kind === 'doc') return 'initial-html';
  const u = (url || '').toLowerCase();
  // Strong HISTORY signals by route vocabulary.
  if (/\b(trades?|history|holders?|holding|positions?|portfolio|activity|txns?|transactions?|fills?|orders?|pnl|leaderboard|top-?traders?|wallet)\b/.test(u)) return 'history-shaped';
  // Strong MARKET signals.
  if (/\b(price|quote|ticker|ohlc|kline|candles?|marketcap|market-?data|stats|pair|pool|realtime|stream|feed)\b/.test(u)) return 'market-shaped';
  if (kind === 'ws') return 'ws-stream';
  return 'unclassified';
}

// A number only discriminates origins if it is DISTINCTIVE: a fractional price
// or a large value (market-cap / volume scale). Bare small integers — counts,
// single digits, percentages like "5", "12" — appear in nearly every payload,
// so correlating on them ties a DOM node to unrelated origins and manufactures
// spurious market/history "mixed" verdicts. (Measured on a live DexScreener
// token page: filtering these collapsed the false correlations dramatically.)
function isDistinctive(canonStr) {
  if (typeof canonStr !== 'string' || !canonStr) return false;
  if (canonStr.includes('.')) return true;      // a fractional value — a real price
  return canonStr.replace('-', '').length >= 4; // >= 1000: mcap / volume scale
}

const AMBIENT_URL_SPREAD = 8; // a number across more origins than this cannot discriminate

// events: parsed domsig lines [{t, sid, prices:[[path,txt],...]}]
// origins: [{ t, kind:'rest'|'ws', url, numbers:Set<string>, updates:number }]
//   For WS, callers should pre-group frames per channel and pass one origin per
//   frame occurrence (we count how many distinct frames carried each number).
function correlate(sigEvents, origins) {
  // Index origins by number -> list of origins, keeping only distinctive numbers.
  const byNumber = new Map();
  for (const o of origins) {
    for (const num of o.numbers) {
      if (!isDistinctive(num)) continue;
      if (!byNumber.has(num)) byNumber.set(num, []);
      byNumber.get(num).push(o);
    }
  }
  // Drop ambient numbers that appear across too many DISTINCT origins — they
  // cannot tell one source from another (a value echoed everywhere).
  for (const [num, list] of byNumber) {
    if (new Set(list.map((o) => o.url)).size > AMBIENT_URL_SPREAD) byNumber.delete(num);
  }

  // node path -> aggregate evidence
  const nodes = new Map();

  for (const ev of sigEvents) {
    if (!ev.prices || !Array.isArray(ev.prices)) continue;
    const domT = ev.t;
    for (const [path, txt] of ev.prices) {
      if (!path) continue;
      let node = nodes.get(path);
      if (!node) {
        node = { path, samples: new Set(), observations: 0, changes: 0, lastTxt: null, origins: new Map() };
        nodes.set(path, node);
      }
      node.observations++;
      if (node.samples.size < 6) node.samples.add(txt);
      if (node.lastTxt !== null && node.lastTxt !== txt) node.changes++;
      node.lastTxt = txt;

      const wanted = domValueToNumbers(txt);
      for (const num of wanted) {
        if (!isDistinctive(num)) continue;
        const candidates = byNumber.get(num);
        if (!candidates) continue;
        for (const o of candidates) {
          if (o.t <= domT && domT - o.t <= CORRELATION_WINDOW_MS) {
            const key = o.kind + ' ' + o.url;
            let agg = node.origins.get(key);
            if (!agg) { agg = { kind: o.kind, url: o.url, hits: 0, role: classifyOriginRole(o.url, o.kind) }; node.origins.set(key, agg); }
            agg.hits++;
          }
        }
      }
    }
  }

  // Reduce to a report: per node, the best-supported origin and a role tally.
  const report = [];
  for (const node of nodes.values()) {
    const origins = [...node.origins.values()].sort((a, b) => b.hits - a.hits);
    const roleTally = {};
    for (const o of origins) roleTally[o.role] = (roleTally[o.role] || 0) + o.hits;
    report.push({
      path: node.path,
      samples: [...node.samples],
      observations: node.observations,
      changes: node.changes, // a node that never changes is a static label, not a live price
      correlated: origins.length > 0,
      topOrigins: origins.slice(0, 4),
      roleTally,
    });
  }
  // Most-active, best-correlated nodes first.
  report.sort((a, b) => (b.changes - a.changes) || (b.observations - a.observations));
  return report;
}

module.exports = { correlate, extractNumbers, domValueToNumbers, canonNum, classifyOriginRole, isDistinctive, CORRELATION_WINDOW_MS };
