/* Lute (lute.gg) site adapter tests + pollution guard locks.
 *
 * Every shape in this fake was captured from the LIVE site on 2026-08-06:
 *
 *  - Token page URL: lute.gg/trade/<base58Address>
 *  - Named routes (compass, momentum, portfolio, discover) are NOT token pages.
 *  - Holder rows carry avgBuyPriceUSD, avgSellPriceUSD, pnlUSD, realizedPnlUSD
 *    — all position-shaped, never market data.
 *  - POSITION_SUBTREE_KEY includes "toptraders" (lute's token event domain).
 *
 * The pollution locks come in the fomo pair-form: the polluted shape never
 * ticks, AND a genuine market snapshot still ticks (the guard must not
 * over-reach). The API routes are NOT in the capture set — the walker is
 * URL-agnostic (the fomo fixtures ship response.url = '' for the same
 * reason), so these locks pin SHAPE behavior; route truth is a live-probe
 * item on the QA matrix.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SITES = fs.readFileSync(path.join(ROOT, 'sites.js'), 'utf8');

const LUTE_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

function detectAt(href) {
  const url = new URL(href);
  const sandbox = {
    window: {}, self: {},
    location: { href, hostname: url.hostname, pathname: url.pathname, search: url.search },
    URLSearchParams, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(SITES, sandbox, { filename: 'sites.js' });
  const site = sandbox.window.PaperTrenchSites.currentSite();
  return { site, token: site.detect() };
}

/* ====================== Detection ====================== */

test('lute adapter detects a Solana token page', () => {
  const { site, token } = detectAt(`https://lute.gg/trade/${LUTE_MINT}`);
  assert.equal(site.id, 'lute');
  assert.ok(token, 'a token page must produce a detection');
  assert.equal(token.kind, 'mint');
  assert.equal(token.address, LUTE_MINT);
  assert.equal(token.chain, 'solana', 'lute is always Solana');
});

test('lute adapter detects a token page with query string', () => {
  const { site, token } = detectAt(`https://lute.gg/trade/${LUTE_MINT}?ref=abc`);
  assert.equal(site.id, 'lute');
  assert.ok(token);
  assert.equal(token.address, LUTE_MINT);
});

test('lute adapter refuses all named routes (O-10)', () => {
  const named = ['compass', 'momentum', 'portfolio', 'discover'];
  for (const route of named) {
    const { site, token } = detectAt(`https://lute.gg/trade/${route}`);
    assert.equal(site.id, 'lute', `must match lute host for /trade/${route}`);
    assert.equal(token, null, `/trade/${route} must return null (O-10)`);
  }
});

test('lute adapter refuses non-trade routes (O-10)', () => {
  for (const href of [
    'https://lute.gg/',
    'https://lute.gg/login',
    'https://lute.gg/signup',
    'https://lute.gg/trade',
  ]) {
    const { token } = detectAt(href);
    assert.equal(token, null, `${href} must return null (O-10)`);
  }
});

test('lute adapter refuses short path segments that are not base58', () => {
  const { token } = detectAt('https://lute.gg/trade/sol');
  assert.equal(token, null, 'short slug "sol" must fail the {32,44} length gate');
});

test('lute adapter tokenUrl builds the correct URL', () => {
  const { site } = detectAt(`https://lute.gg/trade/${LUTE_MINT}`);
  const url = site.tokenUrl(LUTE_MINT);
  assert.equal(url, `https://lute.gg/trade/${LUTE_MINT}`);
});

test('lute adapter tokenUrl works for chip navigation', () => {
  const { site } = detectAt(`https://lute.gg/trade/${LUTE_MINT}`);
  const mint = 'Gymbmn9wwMKe4NnmVceyyfpncp9arbwPfSdBsyY9pump';
  const url = site.tokenUrl(mint);
  assert.equal(url, `https://lute.gg/trade/${mint}`);
});

/* ====================== Contract ====================== */

test('lute adapter satisfies the detect() contract shape', () => {
  const { token } = detectAt(`https://lute.gg/trade/${LUTE_MINT}`);
  assert.ok(token);
  assert.equal(typeof token.kind, 'string');
  assert.ok(token.kind === 'mint' || token.kind === 'pair');
  assert.equal(typeof token.address, 'string');
  assert.ok(token.address.length > 0);
  assert.equal(typeof token.chain, 'string');
  assert.equal(token.chain, token.chain.toLowerCase(),
    'chain must be lowercase — it is a map key in quote.js CHAIN_MAP');
});

test('lute adapter always sets chain (foreign chain field)', () => {
  const { token } = detectAt(`https://lute.gg/trade/${LUTE_MINT}`);
  assert.ok(token);
  assert.ok('chain' in token, 'chain field must be present');
  assert.equal(token.chain, 'solana');
});

/* ====================== Pollution guard locks ====================== */

test('POSITION_SUBTREE_KEY includes toptraders (lute domain)', () => {
  const source = fs.readFileSync(path.join(ROOT, 'price-bridge.js'), 'utf8');
  assert.ok(source.includes('toptraders'),
    'POSITION_SUBTREE_KEY must include toptraders for lute holder/toptrader data');
});

test('looksLikePositionRecord catches avgBuyPriceUSD (lute holder shape)', () => {
  const source = fs.readFileSync(path.join(ROOT, 'price-bridge.js'), 'utf8');
  assert.ok(source.includes('avgBuyPriceUSD'),
    'looksLikePositionRecord must recognize avgBuyPriceUSD from lute holder rows');
  assert.ok(source.includes('realizedPnlUSD'),
    'looksLikePositionRecord must recognize realizedPnlUSD from lute holder rows');
});

/* ============ Bounds lock — the {32,44} gate holds BOTH ends ============ */

test('lute adapter length gate is exact at both bounds', () => {
  // 32 is the shortest valid Solana address shape — it must detect...
  const ok = detectAt('https://lute.gg/trade/' + '1'.repeat(32));
  assert.ok(ok.token, '32-char base58 is a valid address shape and must mount');
  // ...and one char outside either bound must refuse. A widened upper bound
  // ({32,45}) or lowered floor would mount the panel on garbage segments.
  assert.equal(detectAt('https://lute.gg/trade/' + '1'.repeat(31)).token, null,
    '31 chars is not an address');
  assert.equal(detectAt('https://lute.gg/trade/' + '1'.repeat(45)).token, null,
    '45 chars is not an address');
});

/* ============ Behavioral pollution locks (the fomo pair-form) ============
 *
 * Boot the shipped price-bridge.js on a lute-shaped page with NO chart
 * surface at all — lute's widget internals are not in the capture set, and
 * the fake must not implement what was never observed (F-39). The generic
 * collect() walker runs on network JSON regardless, which is exactly the
 * surface these guards defend. */

function microtasks(n = 6) {
  let p = Promise.resolve();
  for (let i = 0; i < n; i++) p = p.then(() => {});
  return p;
}

function jsonResponse(body) {
  return {
    url: '',
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'application/json' : String(body.length)) },
    clone: () => ({ text: () => Promise.resolve(body) }),
  };
}

function runLuteBridge(opts = {}) {
  const emitted = [];
  const listeners = {};
  const timers = [];
  const timeouts = new Map();
  let timeoutSeq = 0;

  function makeFakeEl(tag) {
    return {
      tag,
      style: {},
      attrs: {},
      children: [],
      parentNode: null,
      textContent: '',
      title: '',
      setAttribute(k, v) { this.attrs[k] = v; },
      appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
      remove() {
        const p = this.parentNode;
        if (!p) return;
        const i = p.children.indexOf(this);
        if (i >= 0) p.children.splice(i, 1);
        this.parentNode = null;
      },
    };
  }

  const doc = {
    getElementById: () => null,
    querySelector: () => null,     // no widget iframe: nothing was captured, so nothing exists
    querySelectorAll: () => [],
    createElement: (tag) => makeFakeEl(tag),
    body: makeFakeEl('body'),
  };

  function FakeWebSocket() {}
  FakeWebSocket.prototype.addEventListener = () => {};
  FakeWebSocket.CONNECTING = 0; FakeWebSocket.OPEN = 1;
  FakeWebSocket.CLOSING = 2; FakeWebSocket.CLOSED = 3;
  function FakeXHR() {}
  FakeXHR.prototype.send = function () {};
  FakeXHR.prototype.addEventListener = function () {};

  const win = {
    fetch: (...args) => Promise.resolve(opts.fetchResponse ? opts.fetchResponse(args[0]) : {
      url: '', headers: { get: () => 'application/json' },
      clone: () => ({ text: () => Promise.resolve('{}') }),
    }),
    XMLHttpRequest: FakeXHR,
    WebSocket: FakeWebSocket,
    SharedWorker: undefined,
    EventSource: undefined,
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener(type, fn) { listeners[type] = fn; },
    postMessage(message) { emitted.push(message); },
  };
  win.window = win;

  const sandbox = {
    window: win,
    document: doc,
    location: { href: `https://lute.gg/trade/${LUTE_MINT}`, hostname: 'lute.gg' },
    console, Date, Math, Number, String, Array, Object, Boolean, RegExp,
    Error, Set, WeakSet, WeakMap, Map, Symbol, JSON, Promise, isFinite,
    MutationObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    setInterval(fn) { timers.push(fn); return timers.length; },
    clearInterval(id) { if (timers[id - 1]) timers[id - 1] = () => {}; },
    setTimeout(fn) { timeouts.set(++timeoutSeq, fn); return timeoutSeq; },
    clearTimeout(id) { timeouts.delete(id); },
  };
  vm.runInContext(
    fs.readFileSync(path.join(ROOT, 'price-bridge.js'), 'utf8'),
    vm.createContext(sandbox),
    { filename: 'price-bridge.js' }
  );

  return {
    win,
    send(type, payload) {
      listeners.message({
        source: win,
        data: { source: 'papertrench-content', type, payload },
      });
    },
    statuses(type) { return emitted.filter((m) => m.source === 'papertrench-bridge' && m.type === type).map((m) => m.payload); },
  };
}

function announceLuteToken(env) {
  env.send('paper-axis', { mint: LUTE_MINT, symbol: 'LUTE', pairAddress: null });
}

// Rows under lute's "toptraders" key, carrying plain entry `price` fields and
// NO other position markers — only the POSITION_SUBTREE_KEY taint stands
// between these numbers and the live price.
const TOPTRADERS_FIXTURE = JSON.stringify({
  data: {
    toptraders: [
      { address: LUTE_MINT, price: 0.00313, amountUSD: 3947.36, wallet: 'trader-one' },
      { address: LUTE_MINT, price: 0.00427, amountUSD: 2827.4, wallet: 'trader-two' },
    ],
  },
});

test('lute: toptraders entry prices never become price candidates, even mint-tagged', async () => {
  const env = runLuteBridge({ fetchResponse: () => jsonResponse(TOPTRADERS_FIXTURE) });
  announceLuteToken(env);

  await env.win.fetch('https://lute.gg/__shape_fixture__');
  await microtasks(10);

  const stale = [0.00313, 0.00427];
  const polluted = env.statuses('tick').filter((t) => t
    && Array.isArray(t.candidates) && t.candidates.some((c) => stale.includes(c.value)));
  assert.equal(polluted.length, 0,
    'a toptraders row is someone\'s HISTORY — its price must never tick: '
    + JSON.stringify(polluted[0] || null));
});

// Live rows carry avgBuyPriceUSD/avgSellPriceUSD/pnlUSD/realizedPnlUSD
// together (see header); each fixture below is reduced to a SINGLE marker so
// each looksLikePositionRecord clause is locked in isolation — removing one
// clause reds its own test instead of hiding behind the other.
const AVGBUY_ROW_FIXTURE = JSON.stringify({
  holderRow: { address: LUTE_MINT, price: 0.00358, avgBuyPriceUSD: 0.00358, amount: 1250000 },
});
const REALIZED_ROW_FIXTURE = JSON.stringify({
  holderRow: { address: LUTE_MINT, price: 0.00592, realizedPnlUSD: -220.4, amount: 88000 },
});

test('lute: a row carrying avgBuyPriceUSD is a position record — its price never ticks', async () => {
  const env = runLuteBridge({ fetchResponse: () => jsonResponse(AVGBUY_ROW_FIXTURE) });
  announceLuteToken(env);

  await env.win.fetch('https://lute.gg/__shape_fixture__');
  await microtasks(10);

  const polluted = env.statuses('tick').filter((t) => t
    && Array.isArray(t.candidates) && t.candidates.some((c) => c.value === 0.00358));
  assert.equal(polluted.length, 0,
    'avgBuyPriceUSD marks a position record — F-30, lute spelling');
});

test('lute: a row carrying realizedPnlUSD is a position record — its price never ticks', async () => {
  const env = runLuteBridge({ fetchResponse: () => jsonResponse(REALIZED_ROW_FIXTURE) });
  announceLuteToken(env);

  await env.win.fetch('https://lute.gg/__shape_fixture__');
  await microtasks(10);

  const polluted = env.statuses('tick').filter((t) => t
    && Array.isArray(t.candidates) && t.candidates.some((c) => c.value === 0.00592));
  assert.equal(polluted.length, 0,
    'realizedPnlUSD marks a position record — F-30, lute spelling');
});

// Positive control: a genuine mint-tagged market snapshot with none of the
// position markers must keep flowing — the lute guards must not over-reach.
const SNAPSHOT_FIXTURE = JSON.stringify({
  address: LUTE_MINT,
  symbol: 'LUTE',
  priceUSD: '0.0161',
  marketCap: '13000000',
  liquidity: '250000',
});

test('lute: a genuine market snapshot still ticks (guards must not over-reach)', async () => {
  const env = runLuteBridge({ fetchResponse: () => jsonResponse(SNAPSHOT_FIXTURE) });
  announceLuteToken(env);

  await env.win.fetch('https://lute.gg/__shape_fixture__');
  await microtasks(10);

  const snapshotTicks = env.statuses('tick').filter((t) => t
    && Array.isArray(t.candidates) && t.candidates.some((c) => c.value === 0.0161));
  assert.ok(snapshotTicks.length >= 1,
    'market snapshots without position markers must keep flowing');
});
