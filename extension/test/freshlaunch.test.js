/* Brand-new coin handling — the sniping path.
 *
 * Two defects are covered here, both reported from live use:
 *
 *   1. FLASHING. A failed resolve called setToken(null), which tore down the
 *      panel and chart markers. The next detect tick rebuilt everything, so an
 *      unindexed coin produced a visible flash loop.
 *
 *   2. CONNECT DELAY. Dexscreener returns `pairs: null` until it has observed a
 *      pool, which on a fresh launch is measurably after the coin exists. With
 *      no anchor, every live chart tick was rejected as `no-anchor`, so the
 *      coin could not be paper-traded during exactly the window snipers care
 *      about.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

global.window = global.window || {};
const Q = require('../quote.js');
require('../engine.js');

const NEW_MINT = '3PTQpne3b7kjJEvDYDMBHSuRjTDUh6HSin2xMyW3pump';
const SOL_USD = 200;

/** The shape Jupiter actually returns (captured from the live API). */
function jupiterPayload(overrides) {
  return [
    {
      id: NEW_MINT,
      name: 'Bark',
      symbol: 'BARK',
      usdPrice: 0.0000021001275121451305,
      mcap: 2100.12,
      liquidity: 2204.47,
      firstPool: { id: 'PooLAddress1111111111111111111111111111111', createdAt: '2026-08-01T04:00:00Z' },
      ...(overrides || {}),
    },
    {
      id: Q.WSOL_MINT,
      name: 'Wrapped SOL',
      symbol: 'SOL',
      usdPrice: SOL_USD,
      firstPool: { id: 'sol', createdAt: '2020-01-01T00:00:00Z' },
    },
  ];
}

/** A Dexscreener pair, for the case where it HAS caught up. */
function dexPair() {
  return {
    chainId: 'solana',
    pairAddress: 'PooLAddress1111111111111111111111111111111',
    baseToken: { address: NEW_MINT, symbol: 'BARK', name: 'Bark' },
    priceNative: '0.0000000105',
    priceUsd: '0.0000021',
    liquidity: { usd: 2204.47 },
    marketCap: 2100.12,
  };
}

/* ---------------- Jupiter parsing ---------------- */

test('a fresh launch resolves from Jupiter when Dexscreener has no pairs yet', () => {
  // This is the exact payload Dexscreener returns for an unindexed mint.
  assert.equal(Q.tokenFromPayload({ schemaVersion: '1.0.0', pairs: null }, NEW_MINT), null,
    'Dexscreener genuinely cannot resolve a brand-new coin');

  const token = Q.tokenFromJupiter(jupiterPayload(), NEW_MINT, SOL_USD);
  assert.ok(token, 'Jupiter must resolve the same coin');
  assert.equal(token.symbol, 'BARK');
  assert.equal(token.mint, NEW_MINT);
  assert.equal(token.priceSource, 'jupiter');

  // Price is DERIVED, not pasted: USD quote converted at the SOL reference.
  const expected = 0.0000021001275121451305 / SOL_USD;
  assert.ok(Math.abs(token.priceNative - expected) / expected < 1e-12,
    'the SOL price must equal usdPrice / solUsd');
  assert.equal(token.priceUsd, 0.0000021001275121451305);
  assert.ok(token.launchedAt > 0, 'launch time must be surfaced');
});

test('the SOL reference rate is read from the same batched response', () => {
  assert.equal(Q.solUsdFromJupiter(jupiterPayload()), SOL_USD);
  assert.equal(Q.solUsdFromJupiter([]), null);
});

test('a coin with no price anywhere yields nothing rather than a fabricated price', () => {
  // Observed live: a launch so new it has no liquidity and no usdPrice field.
  const noPrice = Q.tokenFromJupiter(jupiterPayload({ usdPrice: undefined }), NEW_MINT, SOL_USD);
  assert.equal(noPrice, null, 'no price must mean no token, never a guess');

  const zero = Q.tokenFromJupiter(jupiterPayload({ usdPrice: 0 }), NEW_MINT, SOL_USD);
  assert.equal(zero, null);
});

test('a missing or invalid SOL rate refuses to convert rather than corrupting the price', () => {
  assert.equal(Q.tokenFromJupiter(jupiterPayload(), NEW_MINT, 0), null);
  assert.equal(Q.tokenFromJupiter(jupiterPayload(), NEW_MINT, NaN), null);
  assert.equal(Q.tokenFromJupiter(jupiterPayload(), NEW_MINT, -5), null);
});

test('a Jupiter response for a different mint never resolves this address', () => {
  const other = Q.tokenFromJupiter(jupiterPayload({ id: 'SomeOtherMint111' }), NEW_MINT, SOL_USD);
  assert.equal(other, null, 'entries are matched by mint, not by array position');
});

test('malformed Jupiter payloads are handled without throwing', () => {
  for (const bad of [null, undefined, {}, [], 'nope', { tokens: null }]) {
    assert.equal(Q.tokenFromJupiter(bad, NEW_MINT, SOL_USD), null);
    assert.equal(Q.solUsdFromJupiter(bad), null);
  }
});

/* ---------------- source preference ---------------- */

test('an established token prefers the observed pool quote over the derived one', () => {
  const dex = { mint: NEW_MINT, priceNative: 0.000005, priceSource: 'resolver' };
  const jup = { mint: NEW_MINT, priceNative: 0.0000049, priceSource: 'jupiter' };

  assert.equal(Q.preferResolved(dex, jup).priceSource, 'resolver',
    'the venue price wins when both sources know the token');
  assert.equal(Q.preferResolved(null, jup).priceSource, 'jupiter',
    'Jupiter is used exactly when it is the only source — the fresh-launch case');
  assert.equal(Q.preferResolved(null, null), null);
  assert.equal(Q.preferResolved({ priceNative: 0 }, jup).priceSource, 'jupiter',
    'a zero-priced record must not beat a usable one');
});

/* ---------------- once resolved, the coin is tradeable ---------------- */

test('a Jupiter-resolved anchor lets live chart ticks be accepted immediately', () => {
  const token = Q.tokenFromJupiter(jupiterPayload(), NEW_MINT, SOL_USD);

  // Before the fix there was no anchor at all, so every tick was rejected.
  const noAnchor = Q.validateTick(null, { candidates: [{ value: token.priceNative * 1.1, unit: 'unknown' }] });
  assert.equal(noAnchor.accepted, false);
  assert.equal(noAnchor.reason, 'no-anchor');

  // With the Jupiter anchor the same tick is accepted, so the coin trades.
  const verdict = Q.validateTick(token, {
    candidates: [{ value: token.priceNative * 1.1, unit: 'native' }],
  });
  assert.equal(verdict.accepted, true, 'a fresh launch must be tradeable once anchored');
  assert.ok(Math.abs(verdict.priceNative - token.priceNative * 1.1) < 1e-18);
});

test('an absurd tick is still rejected on a fresh launch', () => {
  const token = Q.tokenFromJupiter(jupiterPayload(), NEW_MINT, SOL_USD);
  const bogus = Q.validateTick(token, { candidates: [{ value: 0.44, unit: 'native' }] });
  assert.equal(bogus.accepted, false,
    'the anchor band must still protect fills on brand-new coins');
  assert.equal(bogus.priceNative, token.priceNative);
});

/* ---------------- honest header while waiting ---------------- */

test('the header explains a new coin is waiting instead of looking broken', () => {
  const pendingToken = { mint: NEW_MINT, symbol: null, name: null, priceNative: null, pending: true };
  const now = 1_000_000;

  const early = Q.headerFields(pendingToken, { now, pendingSince: now - 300 });
  assert.equal(early.pending, true);
  assert.equal(early.searching, false, 'a brief resolve must not shout "new coin"');

  const waiting = Q.headerFields(pendingToken, { now, pendingSince: now - 4000 });
  assert.equal(waiting.searching, true);
  assert.match(waiting.priceText, /new coin/i,
    'after a beat the panel must say plainly that it is waiting on a first quote');
  assert.doesNotMatch(waiting.priceText, /\d/, 'a pending header must never show a number');
});

test('a Jupiter-priced token is flagged as a fresh launch in the header', () => {
  const token = Q.tokenFromJupiter(jupiterPayload(), NEW_MINT, SOL_USD);
  const fields = Q.headerFields(token, { now: Date.now(), lastPriceAt: Date.now() });
  assert.equal(fields.freshLaunch, true);
  assert.equal(fields.hasTrustedPrice, true);
  assert.equal(fields.titleIsAddress, false);

  const established = Q.headerFields(
    { mint: NEW_MINT, symbol: 'OLD', priceNative: 0.001, priceSource: 'resolver' },
    { now: Date.now(), lastPriceAt: Date.now() }
  );
  assert.equal(established.freshLaunch, false);
});

/* ---------------- the SHIPPED overlay stops flashing ---------------- */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');

/**
 * Boot the real content.js against a token that no source can resolve yet,
 * and count how many times the overlay tears the chart down. Before the fix
 * every failed resolve fired a teardown; that loop was the visible flashing.
 */
function runFreshLaunch(opts) {
  const options = opts || {};
  const timers = [];
  let now = 5_000_000;
  const nodesById = {};
  const messages = [];       // postMessage traffic to the MAIN-world bridge
  let resolveCalls = 0;
  let jupiterCalls = 0;
  let attempts = 0;
  let lastAttemptAt = -1;

  function makeNode(tag) {
    const node = {
      tag, style: { setProperty() {}, removeProperty() {} }, dataset: {},
      children: [], childNodes: [], _fields: {},
      classList: {
        _s: new Set(),
        add(...c) { c.forEach((x) => this._s.add(x)); },
        remove(...c) { c.forEach((x) => this._s.delete(x)); },
        toggle(c, on) { if (on === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else if (on) this._s.add(c); else this._s.delete(c); },
        contains(c) { return this._s.has(c); },
      },
      set textContent(v) { this._t = v; },
      get textContent() { return this._t || ''; },
      set innerHTML(v) {
        this._h = v;
        const re = /data-f="([a-z]+)"/g; let m;
        while ((m = re.exec(v))) { const c = makeNode('span'); c.dataset.f = m[1]; this._fields[m[1]] = c; }
      },
      get innerHTML() { return this._h || ''; },
      appendChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); if (c._parent && c._parent !== this) c._parent.removeChild(c); c._parent = this; this.children.push(c); this.childNodes = this.children; return c; },
      removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); if (c._parent === this) c._parent = null; },
      remove() { if (this._parent) this._parent.removeChild(this); },
      setAttribute() {}, getAttribute() { return null; },
      addEventListener() {}, querySelectorAll() { return []; },
      querySelector(sel) {
        const m = /data-f="([a-z]+)"/.exec(sel);
        if (m && this._fields[m[1]]) return this._fields[m[1]];
        const cls = /\.([a-z-]+)/.exec(sel);
        if (cls) { this._syn = this._syn || {}; if (!this._syn[cls[1]]) this._syn[cls[1]] = makeNode('span'); return this._syn[cls[1]]; }
        return makeNode('span');
      },
      getBoundingClientRect() { return { top: 0 }; },
      attachShadow() { return shadowRoot; },
      focus() {}, closest() { return null; },
      get offsetWidth() { return 1; },
    };
    return node;
  }

  const shadowRoot = {
    set innerHTML(v) { this._h = v; }, get innerHTML() { return this._h || ''; },
    getElementById(id) { if (!nodesById[id]) nodesById[id] = makeNode('div'); return nodesById[id]; },
    querySelector() { return makeNode('div'); }, querySelectorAll() { return []; }, appendChild() {},
  };

  const doc = {
    readyState: 'complete', hidden: false, title: 'new coin',
    body: Object.assign(makeNode('body'), { innerText: '' }),
    documentElement: makeNode('html'), head: makeNode('head'),
    createElement: (t) => makeNode(t),
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener: () => {}, createTreeWalker: () => ({ nextNode: () => null }),
  };

  const url = `https://trade.padre.gg/trade/solana/${NEW_MINT}`;
  const win = {
    addEventListener: () => {}, removeEventListener: () => {},
    postMessage: (msg) => { if (msg && msg.source === 'papertrench-content') messages.push(msg.type); },
    location: { href: url, hostname: 'trade.padre.gg', pathname: `/trade/solana/${NEW_MINT}`, search: '' },
    getComputedStyle: () => ({ right: '18px', top: '84px' }),
    confirm: () => false,
  };
  win.window = win;

  const storage = { pt_settings: global.window.PaperEngine.defaultSettings() };
  const sandbox = {
    window: win, self: win, document: doc, location: win.location, console,
    URLSearchParams, URL,
    AbortController: function () { this.signal = {}; this.abort = () => {}; },
    MutationObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    TextDecoder: function () { this.decode = () => ''; },
    ResizeObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    Set, Map, WeakSet, WeakMap, Promise, JSON, Math, Number, String, Array, Object,
    Boolean, RegExp, Error, isNaN, parseInt, parseFloat, Infinity, NaN,
    Date: Object.assign(function () {}, { now: () => now, parse: Date.parse }),
    setTimeout: (fn, ms) => { timers.push({ fn, at: now + (ms || 0) }); return timers.length; },
    clearTimeout: () => {}, clearInterval: (id) => { if (timers[id - 1]) timers[id - 1].dead = true; },
    setInterval: (fn, ms) => { timers.push({ fn, at: now + ms, every: ms }); return timers.length; },
    fetch: (u) => {
      const s = String(u);
      const isResolve = s.includes('/tokens/') || s.includes('/pairs/') || s.includes('jup.ag');
      if (isResolve) {
        resolveCalls++;
        // One resolve() fires its lookups in the same tick; count the tick.
        if (now !== lastAttemptAt) { attempts++; lastAttemptAt = now; }
      }
      if (s.includes('jup.ag')) jupiterCalls++;
      // Every source reports "not indexed yet" until the test says otherwise.
      if (options.resolved && options.resolved()) {
        if (s.includes('jup.ag')) {
          return Promise.resolve({ ok: true, status: 200, json: async () => jupiterPayload() });
        }
        // Dexscreener stays blind unless the test opts in, modelling the real
        // window where only Jupiter has indexed a brand-new launch.
        if (options.dexIndexes) {
          return Promise.resolve({ ok: true, status: 200, json: async () => ({ pairs: [dexPair()] }) });
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ pairs: null }) });
      }
      if (s.includes('jup.ag')) return Promise.resolve({ ok: true, status: 200, json: async () => [] });
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ schemaVersion: '1.0.0', pairs: null }) });
    },
    chrome: {
      runtime: {
        id: 'papertrench-test',
        getURL: (p) => 'x/' + p,
        sendMessage: (msg) => {
          const R = win.PaperTrenchResolver;
          if (!R) return Promise.resolve({});
          if (msg.type === 'pt_resolve') return R.resolve(msg.address);
          if (msg.type === 'pt_refresh') return R.refresh(msg.token);
          if (msg.type === 'pt_batch_prices') return R.batchPrices(msg.mints);
          return Promise.resolve({});
        },
        onMessage: { addListener: () => {} },
        openOptionsPage: () => {},
      },
      storage: {
        local: {
          get: (keys, cb) => { const out = {}; for (const k of (Array.isArray(keys) ? keys : [keys])) if (k in storage) out[k] = storage[k]; if (cb) cb(out); return Promise.resolve(out); },
          set: (obj, cb) => { Object.assign(storage, obj); if (cb) cb(); return Promise.resolve(); },
        },
        onChanged: { addListener: () => {} },
      },
      tabs: { query: () => Promise.resolve([{ id: 1 }]), sendMessage: () => Promise.resolve() },
    },
    NodeFilter: { SHOW_TEXT: 4 },
  };

  const ctx = vm.createContext(sandbox);
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const entry = manifest.content_scripts.find((cs) => (cs.js || []).includes('content.js'));
  for (const f of entry.js) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  }

  async function advance(ms, step) {
    step = step || 100;
    for (let e = 0; e < ms; e += step) {
      now += step;
      for (let i = 0; i < timers.length; i++) {
        const t = timers[i];
        if (t.dead || t.at > now) continue;
        if (t.every) t.at = now + t.every; else t.dead = true;
        try { t.fn(); } catch (err) { /* asserted below */ }
      }
      for (let k = 0; k < 8; k++) await Promise.resolve();
    }
  }

  return {
    advance,
    // Each teardown clears the chart — this is the flashing signal.
    teardowns: () => messages.filter((m) => m === 'paper-marker-clear').length,
    resolveCalls: () => resolveCalls,
    jupiterCalls: () => jupiterCalls,
    attempts: () => attempts,
    priceText: () => (nodesById['pt-price'] || {}).textContent,
    tokenName: () => (nodesById['pt-token-name'] || {}).textContent,
  };
}

test('an unindexed coin never tears the chart down (the flashing bug)', async () => {
  const ov = runFreshLaunch({ resolved: () => false });

  await ov.advance(6000);

  // The panel must sit patiently in a pending state, not thrash.
  assert.ok(ov.teardowns() <= 1,
    `an unresolved coin must not repeatedly clear the chart; got ${ov.teardowns()} teardowns`);
  assert.match(ov.priceText() || '', /waiting|fetching/i,
    'the panel must show an honest waiting state while unindexed');
});

test('the overlay retries fast while a new coin is unindexed', async () => {
  const ov = runFreshLaunch({ resolved: () => false });

  await ov.advance(3000);
  const attempts = ov.attempts();

  // The ordinary 800ms detect cadence yields at most ~4 attempts in 3s.
  // Sniping requires materially more, so this threshold is only reachable
  // via the fast-retry loop.
  const ceilingWithoutFastRetry = Math.ceil(3000 / 800);
  assert.ok(attempts > ceilingWithoutFastRetry + 1,
    `a pending launch must be retried faster than the ${ceilingWithoutFastRetry}-attempt ` +
    `baseline; got ${attempts} attempts in 3s`);
});

test('a coin only Jupiter knows still resolves and becomes tradeable', async () => {
  // Dexscreener never indexes this coin during the test; only Jupiter has it.
  // This is the real-world fresh-launch case, and it must work end to end.
  const ov = runFreshLaunch({ resolved: () => true, dexIndexes: false });
  await ov.advance(2500);

  assert.equal(ov.tokenName(), 'BARK',
    'a coin only Jupiter knows must still resolve to a real identity');
  assert.match(ov.priceText() || '', /SOL/,
    'and must expose a SOL price so it can actually be paper-traded');
});

test('the coin becomes tradeable the moment any source indexes it', async () => {
  let indexed = false;
  const ov = runFreshLaunch({ resolved: () => indexed });

  await ov.advance(2000);
  assert.match(ov.priceText() || '', /waiting|fetching/i, 'still pending before indexing');

  indexed = true;               // the launch appears on Jupiter
  await ov.advance(2000);

  assert.equal(ov.tokenName(), 'BARK', 'the resolved identity must appear');
  assert.match(ov.priceText() || '', /SOL/,
    'a real SOL price must be shown once any source resolves the coin');
});
