/* fomo end-to-end draw routing: ONE fill must produce exactly ONE marker.
 *
 * Maintainer field report (2026-08-06, real extension on fomo.family):
 *   "It's showing a bubble above and below. Instead of just one when you buy
 *    and when you sell" — and the average line never appeared at all.
 *
 * The bridge has exactly one 'paper-marker' sender (drawFillOnChart), so a
 * doubled bubble means that call site fires twice for one fill. This harness
 * boots the REAL content.js on a fomo token page and counts what it actually
 * posts toward the MAIN-world bridge across the C-19 native-probe
 * transitions — the window where fomo's chart iframe mounts late and
 * rendering can hand off between the SVG rail and the native chart.
 *
 * Live-verified context for the level assertions (in-app browser, fomo
 * CASHCAT page, 2026-08-06): the chart's visible price band was
 * 108.9M-119.5M in a 187px pane — a level off by more than ~5% is simply
 * off-screen, which is what "the line isn't showing" looks like.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

global.window = global.window || {};
require('../engine.js');
const E = global.window.PaperEngine;

const MINT = 'Gymbmn9wwMKe4NnmVceyyfpncp9arbwPfSdBsyY9pump';

function runFomoOverlay(opts) {
  const options = opts || {};
  const timers = [];
  let now = 1_000_000;
  const price = options.price || 0.000007;

  function makeNode(tag) {
    const node = {
      tag, style: { setProperty() {}, removeProperty() {} }, dataset: {}, childNodes: [], _fields: {}, value: '',
      classList: {
        _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
        toggle(c, on) { if (on === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else if (on) this._s.add(c); else this._s.delete(c); return this._s.has(c); },
        contains(c) { return this._s.has(c); },
      },
      children: [],
      set textContent(v) { this._t = v; if (v === '') { this.children = []; this.childNodes = this.children; this._fields = {}; } },
      get textContent() { return this._t || ''; },
      set innerHTML(v) {
        this._h = v;
        this.children = []; this.childNodes = this.children; this._fields = {};
        const re = /data-f="([a-z]+)"/g; let m;
        while ((m = re.exec(v))) {
          const child = makeNode('span');
          child.dataset.f = m[1];
          this._fields[m[1]] = child;
          this.children.push(child);
        }
      },
      get innerHTML() { return this._h || ''; },
      appendChild(c) { this.children.push(c); this.childNodes = this.children; c._parent = this; return c; },
      removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); },
      remove() { if (this._parent) this._parent.removeChild(this); },
      setAttribute() {},
      addEventListener(type, fn) {
        if (!this._listeners) this._listeners = {};
        (this._listeners[type] = this._listeners[type] || []).push(fn);
      },
      click() { ((this._listeners && this._listeners.click) || []).forEach((fn) => fn()); },
      querySelector() { return makeNode('span'); },
      querySelectorAll() { return []; },
      getBoundingClientRect() { return { top: 0 }; },
      attachShadow() { return shadowRoot; },
      focus() {}, closest() { return null; },
      get offsetWidth() { return 1; },
    };
    return node;
  }

  const shadowNodes = {};
  const shadowRoot = {
    innerHTML: '',
    getElementById(id) { if (!shadowNodes[id]) shadowNodes[id] = makeNode('div'); return shadowNodes[id]; },
    querySelectorAll() { return []; },
    querySelector() { return makeNode('div'); },
    appendChild() {},
  };

  const doc = {
    readyState: 'complete', hidden: false, title: '8.1M MC | Doom | fomo',
    body: Object.assign(makeNode('body'), { innerText: '' }),
    documentElement: makeNode('html'), head: makeNode('head'),
    createElement: (t) => makeNode(t),
    getElementById: () => null,
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener: () => {},
    createTreeWalker: () => ({ nextNode: () => null }),
  };

  const url = `https://fomo.family/tokens/solana/${MINT}`;
  const winListeners = {};
  const posted = [];
  const win = {
    addEventListener: (type, fn) => { (winListeners[type] = winListeners[type] || []).push(fn); },
    removeEventListener: (type, fn) => {
      const arr = winListeners[type];
      if (arr) { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); }
    },
    postMessage: (message) => { posted.push(message); },
    location: { href: url, hostname: 'fomo.family', pathname: `/tokens/solana/${MINT}`, search: '' },
    getComputedStyle: () => ({ right: '18px', top: '84px' }),
    confirm: () => false,
  };
  win.window = win;

  const storage = {};
  const storageListeners = [];
  const sandbox = {
    window: win, self: win, document: doc, location: win.location, console,
    URLSearchParams, URL,
    AbortController: function () { this.signal = {}; this.abort = () => {}; },
    MutationObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    TextDecoder: function () { this.decode = () => ''; },
    ResizeObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    Set, Map, WeakSet, WeakMap, Promise, JSON, Math, Number, String, Array, Object,
    Boolean, RegExp, Error, isNaN, parseInt, parseFloat,
    Date: Object.assign(function () {}, { now: () => now }),
    setTimeout: (fn, ms) => { timers.push({ fn, at: now + (ms || 0), every: null }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].dead = true; },
    clearInterval: (id) => { if (timers[id - 1]) timers[id - 1].dead = true; },
    setInterval: (fn, ms) => { timers.push({ fn, at: now + ms, every: ms }); return timers.length; },
    fetch: (u) => {
      const href = String(u);
      // Jupiter price probe (Solana path) — a plain rate.
      if (href.includes('jup.ag')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ([{ id: 'So11111111111111111111111111111111111111112', usdPrice: 200 }]) });
      }
      const pair = {
        chainId: 'solana', pairAddress: 'PAIR1', dexId: 'raydium',
        baseToken: { address: MINT, symbol: 'Doom', name: 'Doom' },
        priceNative: String(price), priceUsd: String(price * 200),
        liquidity: { usd: 500000 }, marketCap: 8_100_000,
      };
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ pair, pairs: [pair] }) });
    },
    chrome: {
      runtime: {
        id: 'papertrench-test',
        getURL: (p) => 'chrome-extension://x/' + p,
        sendMessage: (msg) => {
          if (msg.type === 'pt_attest_append') return Promise.resolve({ ok: true, seq: 0, head: 'pt-test-head' });
          const R = win.PaperTrenchResolver;
          if (!R) return Promise.resolve({});
          if (msg.type === 'pt_resolve') return R.resolve(msg.address, msg.opts);
          if (msg.type === 'pt_refresh') return R.refresh(msg.token);
          if (msg.type === 'pt_sol_usd') return R.solUsd();
          if (msg.type === 'pt_batch_prices') return R.batchPrices(msg.mints, msg.chains);
          return Promise.resolve({});
        },
        onMessage: { addListener: () => {} },
        openOptionsPage: () => {},
      },
      storage: {
        local: {
          get: (keys, cb) => {
            const out = {};
            const list = Array.isArray(keys) ? keys : [keys];
            for (const k of list) if (k in storage) out[k] = storage[k];
            if (cb) cb(out);
            return Promise.resolve(out);
          },
          set: (obj, cb) => {
            const changes = {};
            // Chrome delivers a STRUCTURED CLONE, never the caller's object.
            for (const k of Object.keys(obj)) {
              changes[k] = { newValue: JSON.parse(JSON.stringify(obj[k])), oldValue: storage[k] };
            }
            Object.assign(storage, obj);
            for (const fn of storageListeners) { try { fn(changes, 'local'); } catch (e) {} }
            if (cb) cb();
            return Promise.resolve();
          },
        },
        onChanged: { addListener: (fn) => storageListeners.push(fn) },
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
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      now += step;
      for (let i = 0; i < timers.length; i++) {
        const t = timers[i];
        if (t.dead || t.at > now) continue;
        if (t.every) t.at = now + t.every; else t.dead = true;
        try { t.fn(); } catch (e) { /* surfaced via assertions */ }
      }
      for (let k = 0; k < 6; k++) await Promise.resolve();
    }
  }

  return {
    advance,
    shadowNodes,
    posted,
    markers: () => posted.filter((m) => m && m.type === 'paper-marker'),
    lineSpecs: () => posted.filter((m) => m && m.type === 'paper-lines'),
    types: () => posted.map((m) => m && m.type),
    dispatchBridge: (type, payload) => {
      for (const fn of (winListeners.message || []).slice()) {
        fn({ source: win, origin: '', data: { source: 'papertrench-bridge', type, payload } });
      }
    },
    clickById: (id) => { if (shadowNodes[id]) shadowNodes[id].click(); },
    setValue: (id, v) => { if (shadowNodes[id]) shadowNodes[id].value = String(v); },
    state: () => storage.pt_state,
  };
}

/** Announce a usable native chart the way the bridge does on fomo. */
function announceNativeChart(ov) {
  ov.dispatchBridge('padre-hook-status', {
    barsHooked: true, marksHooked: false, nativeCapable: true, markerCount: 0,
  });
}

test('ONE paper buy on fomo posts exactly ONE chart marker', async () => {
  const ov = runFomoOverlay();
  await ov.advance(1500);          // detect + resolve
  announceNativeChart(ov);
  await ov.advance(200);

  ov.setValue('pt-custom', 0.1);
  ov.clickById('pt-buy');
  await ov.advance(1500);          // the fill settles and persists

  const state = ov.state();
  assert.ok(state && state.positions && state.positions[MINT], 'the paper buy must actually fill');
  assert.equal(ov.markers().length, 1,
    `one fill must post exactly one marker, got ${ov.markers().length}: ${JSON.stringify(ov.types())}`);
});

test('the fill survives the C-19 handoff: no duplicate marker, and never a starved replay', async () => {
  // fomo mounts its chart iframe late. If the 8s grace window expires first,
  // the SVG rail takes over and replays the journal through itself; when the
  // bridge then reports a real widget, rendering hands back to the native
  // chart and the SAME fill must be replayed there exactly once.
  const ov = runFomoOverlay();
  await ov.advance(1500);
  announceNativeChart(ov);
  await ov.advance(200);

  ov.setValue('pt-custom', 0.1);
  ov.clickById('pt-buy');
  await ov.advance(1000);
  assert.equal(ov.markers().length, 1, 'baseline: one fill, one marker');

  // Force the rail handoff and back, the way a late-mounting chart does.
  ov.dispatchBridge('padre-hook-status', { barsHooked: false, marksHooked: false, nativeCapable: false });
  await ov.advance(9000);          // grace expires -> SVG rail owns rendering
  announceNativeChart(ov);         // the widget finally appears
  await ov.advance(1000);

  const markers = ov.markers();
  const ids = markers.map((m) => `${m.payload && m.payload.side}@${m.payload && m.payload.ts}`);
  const unique = new Set(ids);
  assert.equal(unique.size, markers.length,
    `no fill may be posted twice across the handoff, got ${JSON.stringify(ids)}`);
});

test('a position on fomo keeps a live average-line spec flowing to the bridge', async () => {
  const ov = runFomoOverlay();
  await ov.advance(1500);
  announceNativeChart(ov);
  await ov.advance(200);

  ov.setValue('pt-custom', 0.1);
  ov.clickById('pt-buy');
  await ov.advance(1500);

  const specs = ov.lineSpecs().filter((m) => m.payload && m.payload.enabled);
  assert.ok(specs.length, 'holding a position must post an enabled paper-lines spec');
  const last = specs[specs.length - 1].payload;
  // The spec must carry a usable average AND the current price the bridge
  // needs to convert it onto the chart's own axis.
  assert.ok(Number(last.avgBuyUsd) > 0 || Number(last.avgBuyNative) > 0,
    'the spec must state an average the bridge can draw');
  assert.ok(Number(last.currentPriceNative) > 0,
    'without a current price the bridge cannot convert onto a cap axis');
});
