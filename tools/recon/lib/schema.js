'use strict';
// Payload shape inference + URL/route normalization. Turns a pile of captured
// JSON bodies into a compact schema sketch, and a pile of URLs into normalized
// route patterns with the variable segments identified (the route atlas that
// feeds sites.js match()/detect() and warmdest classify()).

// ---- value shape ----------------------------------------------------------

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v; // string | number | boolean | object | undefined
}

// Merge a value into an accumulating shape node. Objects track per-key shapes
// and how often each key was present (so "optional" is evidence, not a guess).
function mergeShape(node, value, samples) {
  const t = typeOf(value);
  if (!node) node = { types: {}, count: 0 };
  node.count++;
  node.types[t] = (node.types[t] || 0) + 1;
  if (t === 'object') {
    node.props = node.props || {};
    node.keyPresence = node.keyPresence || {};
    node.objCount = (node.objCount || 0) + 1;
    for (const [k, v] of Object.entries(value)) {
      node.keyPresence[k] = (node.keyPresence[k] || 0) + 1;
      node.props[k] = mergeShape(node.props[k], v, samples);
    }
  } else if (t === 'array') {
    node.itemCount = (node.itemCount || 0) + 1;
    node.lenSum = (node.lenSum || 0) + value.length;
    for (const item of value.slice(0, 40)) node.item = mergeShape(node.item, item, samples);
  } else if (t === 'string') {
    node.samples = node.samples || new Set();
    if (node.samples.size < 5) node.samples.add(value.slice(0, 40));
    node.strClass = classifyString(node.strClass, value);
  } else if (t === 'number') {
    node.min = node.min === undefined ? value : Math.min(node.min, value);
    node.max = node.max === undefined ? value : Math.max(node.max, value);
  }
  return node;
}

function classifyString(prev, s) {
  let cls = 'text';
  if (/^0x[a-fA-F0-9]{40}$/.test(s)) cls = 'evm-address';
  else if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) cls = 'base58-address';
  else if (/^\d{10,13}$/.test(s)) cls = 'epoch';
  else if (/^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s)) cls = 'numeric-string';
  else if (/^https?:\/\//.test(s)) cls = 'url';
  else if (/^#[0-9a-fA-F]{6}$/.test(s)) cls = 'color';
  if (prev && prev !== cls) return 'mixed';
  return cls;
}

// Render a shape node into terse lines for the dossier.
function renderShape(node, name = '$', depth = 0, out = [], maxDepth = 4) {
  if (!node || depth > maxDepth) return out;
  const pad = '  '.repeat(depth);
  const types = Object.entries(node.types).sort((a, b) => b[1] - a[1]).map(([t]) => t).join('|');
  let extra = '';
  if (node.strClass && node.strClass !== 'text') extra += ` «${node.strClass}»`;
  if (node.min !== undefined) extra += ` [${node.min}..${node.max}]`;
  if (node.item && node.itemCount) extra += ` avgLen=${(node.lenSum / node.itemCount).toFixed(1)}`;
  out.push(`${pad}${name}: ${types}${extra}`);
  if (node.props) {
    const total = node.objCount || node.count;
    const keys = Object.keys(node.props).sort((a, b) => (node.keyPresence[b] || 0) - (node.keyPresence[a] || 0));
    for (const k of keys.slice(0, 40)) {
      const presence = node.keyPresence[k] || 0;
      const opt = presence < total ? `?(${presence}/${total})` : '';
      renderShape(node.props[k], k + opt, depth + 1, out, maxDepth);
    }
    if (keys.length > 40) out.push(`${'  '.repeat(depth + 1)}… ${keys.length - 40} more keys`);
  }
  if (node.item) renderShape(node.item, '[]', depth + 1, out, maxDepth);
  return out;
}

// Collect the leaf key spellings in an object shape (for pollution-key hints).
function collectKeys(node, acc = new Set()) {
  if (!node) return acc;
  if (node.props) for (const [k, child] of Object.entries(node.props)) { acc.add(k); collectKeys(child, acc); }
  if (node.item) collectKeys(node.item, acc);
  return acc;
}

// ---- URL / route normalization --------------------------------------------

function isVarSegment(seg) {
  if (/^0x[a-fA-F0-9]{40}$/.test(seg)) return 'evm';
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(seg)) return 'address';
  if (/^\d+$/.test(seg) && seg.length >= 3) return 'num';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return 'uuid';
  if (/[0-9]/.test(seg) && /[a-zA-Z]/.test(seg) && seg.length >= 12) return 'mixed-id';
  return null;
}

const KNOWN_CHAINS = new Set([
  'solana', 'sol', 'ethereum', 'eth', 'base', 'bsc', 'bnb', 'polygon', 'matic',
  'arbitrum', 'arb', 'avax', 'avalanche', 'blast', 'optimism', 'op', 'sui',
  'ton', 'tron', 'trx', 'pulse', 'pulsechain', 'hyperliquid', 'hyperevm', 'abstract', 'berachain', 'sonic', 'ink', 'unichain',
]);

// Returns { pattern, host, segs:[{raw,var}], chainCandidates:[...] }
function normalizeUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  const segs = u.pathname.split('/').filter(Boolean);
  const chainCandidates = [];
  const patternSegs = segs.map((seg, i) => {
    const low = seg.toLowerCase();
    if (KNOWN_CHAINS.has(low)) { chainCandidates.push({ seg: low, index: i }); return `{chain}`; }
    const v = isVarSegment(seg);
    return v ? `{${v}}` : seg;
  });
  return {
    host: u.host,
    origin: u.origin,
    pattern: '/' + patternSegs.join('/'),
    path: u.pathname,
    query: u.search ? [...u.searchParams.keys()].sort() : [],
    segs,
    chainCandidates,
  };
}

module.exports = { mergeShape, renderShape, collectKeys, typeOf, normalizeUrl, isVarSegment, KNOWN_CHAINS };
