/* Wallet state durability — the "sell button disappears" defect.
 *
 * Reported from live use: while holding a position, the quick-sell buttons
 * (the whole position card) would intermittently vanish. The card renders
 * from `state.positions[token.mint]`, so the real failure was the wallet
 * state itself being replaced or clobbered:
 *
 *   1. FABRICATION. store.get resolved {} for ANY failure, and reloadState()
 *      treated "nothing read" as "fresh wallet". One transient storage error
 *      swapped the live state for an empty default, and the very next
 *      heartbeat mark persisted that wipe to storage.
 *
 *   2. BLIND OVERWRITE. persistSoon() wrote the in-memory state after an
 *      800ms debounce without checking that another tab/popup had written a
 *      NEWER state in the meantime. When the adoption event was missed or
 *      raced, the stale copy clobbered the fresher wallet.
 *
 * The fix makes a failed read distinguishable from an empty result, never
 * fabricates state mid-session, stamps every write with a monotonic `seq`,
 * and makes the debounced writer adopt-and-re-mark instead of clobbering.
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

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

/**
 * Boot the real content.js with a fake clock, stub network, and a real
 * storage backing. Same shape as the livepnl harness, plus hooks to fail
 * storage reads on demand and to write behind the storage listener's back
 * (simulating a missed adoption event).
 */
function runOverlay(priceSeries, opts) {
  const options = opts || {};
  const timers = [];
  let now = 1_000_000;
  let failGets = 0;

  function makeNode(tag) {
    const node = {
      tag, style: { setProperty() {}, removeProperty() {} }, dataset: {}, childNodes: [], _fields: {}, value: '',
      classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
        toggle(c, on) { if (on === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else if (on) this._s.add(c); else this._s.delete(c); return this._s.has(c); },
        contains(c) { return this._s.has(c); } },
      children: [],
      set textContent(v) {
        this._t = v;
        if (v === '') { this.children = []; this.childNodes = this.children; this._fields = {}; }
      },
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
        if (!this._listeners[type]) this._listeners[type] = [];
        this._listeners[type].push(fn);
      },
      click() { ((this._listeners && this._listeners.click) || []).forEach((fn) => fn()); },
      querySelector(sel) {
        const m = /data-f="([a-z]+)"/.exec(sel);
        if (m && this._fields && this._fields[m[1]]) return this._fields[m[1]];
        return makeNode('span');
      },
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
    getElementById(id) {
      if (!shadowNodes[id]) shadowNodes[id] = makeNode('div');
      return shadowNodes[id];
    },
    querySelectorAll() { return []; },
    querySelector() { return makeNode('div'); },
    appendChild() {},
  };

  const doc = {
    readyState: 'complete', hidden: false, title: 'BONK',
    body: Object.assign(makeNode('body'), { innerText: '' }),
    documentElement: makeNode('html'), head: makeNode('head'),
    createElement: (t) => makeNode(t),
    getElementById: () => null,
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener: () => {},
    createTreeWalker: () => ({ nextNode: () => null }),
  };

  const url = `https://trade.padre.gg/trade/${BONK}`;
  const win = {
    addEventListener: () => {}, removeEventListener: () => {}, postMessage: () => {},
    location: { href: url, hostname: 'trade.padre.gg', pathname: `/trade/${BONK}`, search: '' },
    getComputedStyle: () => ({ right: '18px', top: '84px' }),
    confirm: () => false,
  };
  win.window = win;

  let priceIdx = 0;
  const storage = {};
  // Settings the install already has before the content script boots.
  if (options.initialSettings) {
    storage.pt_settings = Object.assign(E.defaultSettings(), options.initialSettings);
  }
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
    clearTimeout: () => {}, clearInterval: (id) => { if (timers[id - 1]) timers[id - 1].dead = true; },
    setInterval: (fn, ms) => { timers.push({ fn, at: now + ms, every: ms }); return timers.length; },
    fetch: () => {
      const p = priceSeries[Math.min(priceIdx, priceSeries.length - 1)];
      const body = {
        pair: {
          chainId: 'solana', pairAddress: 'PAIR1', dexId: 'raydium',
          baseToken: { address: BONK, symbol: 'BONK', name: 'Bonk' },
          priceNative: String(p), priceUsd: String(p * 200), liquidity: { usd: 500000 }, marketCap: 1e8,
        },
      };
      return Promise.resolve({ ok: true, status: 200, json: async () => body });
    },
    chrome: {
      runtime: {
        id: 'papertrench-test',
        getURL: (p) => 'chrome-extension://x/' + p,
        sendMessage: (msg) => {
          const R = win.PaperTrenchResolver;
          if (!R) return Promise.resolve({});
          if (msg.type === 'pt_resolve') return R.resolve(msg.address);
          if (msg.type === 'pt_refresh') return R.refresh(msg.token);
          if (msg.type === 'pt_sol_usd') return R.solUsd();
          if (msg.type === 'pt_batch_prices') return R.batchPrices(msg.mints);
          return Promise.resolve({});
        },
        onMessage: { addListener: () => {} },
        openOptionsPage: () => {},
      },
      storage: {
        local: {
          get: (keys, cb) => {
            // Emulate a transient storage failure: lastError set, empty value.
            if (failGets > 0) {
              failGets--;
              sandbox.chrome.runtime.lastError = { message: 'transient failure' };
              if (cb) cb({});
              sandbox.chrome.runtime.lastError = undefined;
              return Promise.resolve({});
            }
            const out = {};
            const list = Array.isArray(keys) ? keys : [keys];
            for (const k of list) if (k in storage) out[k] = storage[k];
            if (cb) cb(out);
            return Promise.resolve(out);
          },
          set: (obj, cb) => {
            const changes = {};
            for (const k of Object.keys(obj)) changes[k] = { newValue: obj[k], oldValue: storage[k] };
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

  /** Write a paper position through the normal storage path (listeners fire). */
  function openPaperPosition(spendSol) {
    const settings = E.defaultSettings();
    const state = E.defaultState(settings);
    const entry = priceSeries[Math.min(priceIdx, priceSeries.length - 1)];
    E.buy(state, settings, {
      ts: now, mint: BONK, symbol: 'BONK', site: 'padre',
      priceNative: entry, priceUsd: entry * 200, solAmount: spendSol,
    });
    storage.pt_settings = settings;
    sandbox.chrome.storage.local.set({ pt_state: state });
    return Boolean(state.positions[BONK]);
  }

  /** The position card's quick-sell buttons currently in the DOM. */
  function sellButtons() {
    const host = shadowNodes['pt-position'];
    const card = host && host.children[0];
    const row = card && card._fields && card._fields.sell;
    if (!row) return [];
    return row.children.filter((c) => c.className === 'pt-sell');
  }

  return {
    advance,
    openPaperPosition,
    sellButtons,
    storage: () => storage,
    shadowNodes,
    /** Fail the next N storage reads the way a transient Chrome error would. */
    failGets: (n) => { failGets = n; },
    /** A write from "another tab" whose adoption event this tab misses. */
    externalWriteSilently: (obj) => Object.assign(storage, obj),
    setValue: (id, v) => { if (shadowNodes[id]) shadowNodes[id].value = String(v); },
    clickById: (id) => { if (shadowNodes[id]) shadowNodes[id].click(); },
    nextPrice: () => { priceIdx++; },
  };
}

test('a transient storage read failure must not fabricate an empty wallet', async () => {
  const ov = runOverlay([0.001, 0.0012]);

  await ov.advance(1200);                  // resolve the token
  assert.ok(ov.openPaperPosition(1), 'position opens before the failure');
  await ov.advance(600);
  const qtyBefore = ov.storage().pt_state.positions[BONK].qty;
  assert.ok(qtyBefore > 0);

  // The next reloadState() happens inside the buy's withState. Before the
  // fix it read {} (failure) and swapped in a default state; the fill then
  // persisted over the real wallet, deleting the open position.
  ov.failGets(1);
  ov.setValue('pt-custom', '0.5');
  ov.clickById('pt-buy');
  await ov.advance(1500);

  const st = ov.storage().pt_state;
  const pos = st && st.positions && st.positions[BONK];
  assert.ok(pos, 'the open position must survive a failed storage read');
  assert.ok(pos.qty > qtyBefore, 'the new buy must add to the existing stack');
  assert.ok(st.cashSol < 9.5, 'cash must reflect BOTH fills, not a fresh wallet');
});

test('the debounced writer adopts newer external state instead of clobbering it', async () => {
  const ov = runOverlay([0.001, 0.0012]);

  await ov.advance(1200);                  // resolve; this tab holds no position

  // Another tab opens a position and writes a newer seq, but this tab misses
  // the onChanged adoption (throttled event, startup race). The in-memory
  // state here is still the empty wallet.
  const settings = E.defaultSettings();
  const foreign = E.defaultState(settings);
  E.buy(foreign, settings, {
    ts: 1_500_000, mint: BONK, symbol: 'BONK', site: 'axiom',
    priceNative: 0.001, priceUsd: 0.2, solAmount: 2,
  });
  foreign.seq = 500;
  ov.externalWriteSilently({ pt_state: foreign });

  ov.nextPrice();
  await ov.advance(3000);                  // heartbeat re-quotes, marks, persists

  const st = ov.storage().pt_state;
  assert.ok(st.positions && st.positions[BONK],
    'the heartbeat persist must never clobber a newer wallet state');
  assert.ok(Number(st.seq) > 500, 'the adopted write must carry the seq lineage forward');
});

test('the quick-sell buttons render for a position adopted from another tab', async () => {
  const ov = runOverlay([0.001, 0.0012]);

  await ov.advance(1200);
  assert.equal(ov.sellButtons().length, 0, 'no position, no sell buttons');

  assert.ok(ov.openPaperPosition(1));
  await ov.advance(600);

  const buttons = ov.sellButtons();
  assert.equal(buttons.length, 4, 'the position card must offer the four quick-sell buttons');
  assert.deepEqual(buttons.map((b) => b.textContent), ['25%', '50%', '75%', '100%']);
});

/* ---------------- overlay buy-section toggles ----------------
 *
 * The user-facing option to remove the quick buys. Drives the shipped
 * content.js with the toggles already saved, and asserts exactly which
 * controls disappear.
 */

test('the whole buy section disappears when panelBuyEnabled is off', async () => {
  // Saved at the current revision, so the one-time migration does not
  // re-adopt the defaults over this opt-out.
  const ov = runOverlay([0.001], {
    initialSettings: { panelBuyEnabled: false, settingsRevision: E.SETTINGS_REVISION },
  });

  await ov.advance(1200);                  // token resolves, panel renders

  for (const id of ['pt-buy-label', 'pt-buy-presets', 'pt-custom', 'pt-buy']) {
    assert.equal(ov.shadowNodes[id].style.display, 'none',
      `${id} must be hidden when the buy section is switched off`);
  }
});

test('the preset row hides alone while the BUY button stays', async () => {
  const ov = runOverlay([0.001], {
    initialSettings: { panelPresetsEnabled: false, settingsRevision: E.SETTINGS_REVISION },
  });

  await ov.advance(1200);

  assert.equal(ov.shadowNodes['pt-buy-presets'].style.display, 'none',
    'the one-tap presets must be hidden');
  assert.notEqual(ov.shadowNodes['pt-buy'].style.display, 'none',
    'the BUY button must remain available');
  assert.notEqual(ov.shadowNodes['pt-custom'].style.display, 'none',
    'the custom amount input must remain available');
});

test('with both toggles on, every buy control is visible', async () => {
  const ov = runOverlay([0.001]);

  await ov.advance(1200);

  for (const id of ['pt-buy-label', 'pt-buy-presets', 'pt-custom', 'pt-buy']) {
    assert.notEqual(ov.shadowNodes[id].style.display, 'none',
      `${id} must be visible with default settings`);
  }
});

/* ---------------- reported: panel forgets its place on refresh ----------------
 *
 * levv6x: "make it remember its place — every time I refresh or open a new
 * tab it gets back to top right". The panel drag only updated the DOM; the
 * positions bar already persists its dragged position, but the panel's drop
 * handler threw it away, so every page booted at the CSS default (top-right).
 * Two contracts pin the fix:
 *   1. behavioral — a saved panelRight/panelTop is applied at mount;
 *   2. source — the drop handler persists both coordinates to storage.
 */
test('a saved panel position is restored at mount instead of top-right', async () => {
  const ov = runOverlay([0.001], { initialSettings: { panelRight: 320, panelTop: 240 } });

  await ov.advance(1200);

  assert.equal(ov.shadowNodes['pt-box'].style.right, '320px',
    'the dragged horizontal position must survive a page load');
  assert.equal(ov.shadowNodes['pt-box'].style.top, '240px',
    'the dragged vertical position must survive a page load');
});

test('a saved panel position never lands off-screen on a smaller window', async () => {
  // Saved on a wide monitor, opened in an 800x600 window: the clamp keeps the
  // header reachable so the panel can always be dragged back.
  const ov = runOverlay([0.001], { initialSettings: { panelRight: 5000, panelTop: 4000 } });

  await ov.advance(1200);

  const right = parseInt(ov.shadowNodes['pt-box'].style.right);
  const top = parseInt(ov.shadowNodes['pt-box'].style.top);
  assert.ok(Number.isFinite(right) && right <= 760,
    'the panel must stay horizontally reachable');
  assert.ok(Number.isFinite(top) && top <= 552,
    'the panel header must stay vertically grabbable');
});

test('the panel drop handler persists the dragged position', () => {
  // The window mouseup listener cannot be driven from this harness, so pin
  // the contract in source: the drop must write BOTH coordinates to settings
  // and then persist them — the exact shape the positions bar uses.
  const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  assert.match(content, /settings\.panelRight = parseInt\(boxStyle\.right\)/,
    'the drop must record the horizontal position');
  assert.match(content, /settings\.panelTop = parseInt\(boxStyle\.top\)/,
    'the drop must record the vertical position');
  const drop = content.indexOf('settings.panelRight = parseInt(');
  const persist = content.indexOf('store.set({ [E.STORAGE_KEYS.settings]: settings })', drop);
  assert.ok(drop !== -1 && persist !== -1 && persist - drop < 400,
    'the recorded position must be written to storage immediately after the drop');
});

/* ---------------- requested: Axiom-style focus mode ----------------
 *
 * levv6x: "make the trading tab like axiom and other platforms for more
 * optimised and less distracted trades". Focus mode (opt-in setting
 * panelFocusMode) toggles the .pt-focus class on the panel box, and the
 * shipped CSS hides every decoration under it. The execution controls
 * (token, price, balance, buy, sell) must stay.
 */
test('focus mode off keeps the decorated panel', async () => {
  const ov = runOverlay([0.001]);
  await ov.advance(1200);
  assert.equal(ov.shadowNodes['pt-box'].classList.contains('pt-focus'), false,
    'the default panel keeps its banner, sparkline and info cards');
});

test('focus mode strips the decoration via the pt-focus class', async () => {
  const ov = runOverlay([0.001], {
    initialSettings: { panelFocusMode: true, settingsRevision: E.SETTINGS_REVISION },
  });
  await ov.advance(1200);
  assert.equal(ov.shadowNodes['pt-box'].classList.contains('pt-focus'), true,
    'the setting must land on the panel box as a class');

  // The shipped CSS must actually hide every decoration under that class,
  // and leave the execution controls alone.
  const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  for (const selector of ['.pt-banner', '.pt-watermark', '.pt-spark', '.pt-footer', '#pt-thesis', '#pt-closed']) {
    assert.ok(content.includes(`.pt-box.pt-focus ${selector}`),
      `focus mode must hide ${selector}`);
  }
});

test('the dashboard exposes and persists the focus mode toggle', () => {
  const E2 = require('../engine.js');
  assert.equal(E2.DEFAULT_SETTINGS.panelFocusMode, false,
    'focus mode is opt-in: the decorated panel stays the default');
  const dashJs = fs.readFileSync(path.join(ROOT, 'dashboard.js'), 'utf8');
  assert.match(dashJs, /id="set-focus-mode"/);
  assert.match(dashJs, /panelFocusMode: document\.getElementById\('set-focus-mode'\)\.checked/,
    'the toggle must be persisted with the rest of the settings');
});

/* ---------------- reported: sell button disappearing (saannta, v1.2.13) ----
 *
 * Root cause: disableOverlay() and shutdown() destroyed the shadow DOM but
 * left posEls pointing to detached nodes. On re-enable, renderPosition()
 * saw a truthy posEls and skipped buildPositionCard — so the new card was
 * built without sell buttons (the rebuild was short-circuited by the stale
 * cache). The user sees an empty position card with no way to sell.
 *
 * The fix nulls posEls in both teardown paths. Pin the contract in source
 * because the harness cannot drive the full disable/enable cycle through
 * the storage listener (externalWriteSilently intentionally skips it).
 */
test('disableOverlay and shutdown null posEls so sell buttons rebuild', () => {
  const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');

  // disableOverlay must null posEls after destroying the shadow tree.
  const disableFn = content.indexOf('function disableOverlay()');
  assert.ok(disableFn !== -1, 'disableOverlay must exist');
  const disableBlock = content.slice(disableFn, content.indexOf('\n  }', disableFn) + 4);
  assert.match(disableBlock, /posEls\s*=\s*null/,
    'disableOverlay must null posEls to prevent stale-cache sell-button loss');

  // shutdown must do the same — it also destroys the shadow tree.
  const shutdownFn = content.indexOf('function shutdown(reason)');
  assert.ok(shutdownFn !== -1, 'shutdown must exist');
  const shutdownBlock = content.slice(shutdownFn, content.indexOf('\n  }', shutdownFn) + 4);
  assert.match(shutdownBlock, /posEls\s*=\s*null/,
    'shutdown must null posEls to prevent stale-cache sell-button loss');
});

/* ---------------- DEFECTS O-01 / O-02: wrong token after fast navigation ----
 *
 * O-02: detectLoop committed lastHref BEFORE its `if (resolving) return`
 * guard. A navigation landing while a resolve was in flight was recorded as
 * handled and then ignored on every later tick — the panel kept showing (and
 * doBuy kept FILLING) the previous token on the new token's page.
 *
 * O-01: a resolve that finished after the user navigated away was adopted
 * unconditionally, resurrecting the old token — price loop, markers, panel —
 * on a page it does not belong to.
 *
 * Pinned in source because the harness cannot drive detectLoop's async timing
 * (real timers + an in-flight resolver promise racing a location change).
 */
test('detectLoop cannot swallow a navigation or adopt a stale resolve', () => {
  const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  const fnStart = content.indexOf('async function detectLoop()');
  assert.ok(fnStart !== -1, 'detectLoop must exist');
  const block = content.slice(fnStart, content.indexOf('\n  }', fnStart) + 4);

  // O-02 — the old shape: lastHref committed on the line right after the
  // same-URL early return, i.e. before the resolving guard. Must be gone.
  assert.doesNotMatch(block,
    /if \(location\.href === lastHref && settled\) return;\s*\n\s*lastHref = location\.href;/,
    'lastHref must not be committed before the resolving guard — a navigation during an in-flight resolve would be swallowed forever');

  // O-02 — the new shape: the main commit happens only after the resolving
  // gate has been passed.
  assert.match(block, /resolving = true;\s*\n\s*lastHref = location\.href;/,
    'lastHref for a resolve tick is committed only once the tick actually starts the resolve');

  // O-01 — a resolve landing after navigation must be discarded, not adopted.
  assert.match(block, /await R\.resolve\([^)]*\);[\s\S]*?if \(location\.href !== resolveHref\) return;/,
    'a resolve result must be dropped when the page navigated while it was in flight');
});

/* ---------------- DEFECT F-15: double-tap sell fills twice ----------------
 *
 * doBuy is guarded by buyInFlight, but doSell had no guard at all. Two fast
 * taps on "SELL 50%" both quoted and both committed — the second sold 50% of
 * the REMAINDER (75% total), silently, with two success toasts.
 */
test('doSell carries a re-entrancy guard symmetric with buyInFlight', () => {
  const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  const fnStart = content.indexOf('async function doSell(fraction)');
  assert.ok(fnStart !== -1, 'doSell must exist');
  const block = content.slice(fnStart, content.indexOf('\n  }', fnStart) + 4);

  assert.match(block, /if \(sellInFlight\) return toast/,
    'a sell while one is in flight must be refused, not stacked');
  assert.match(block, /sellInFlight = true;/,
    'doSell must arm the guard before quoting');
  assert.match(block, /finally\s*\{\s*\n?\s*sellInFlight = false;/,
    'the guard must clear in finally so a failed sell does not brick selling');
});

/* ---------------- DEFECT D-14: restore resurrection race ------------------
 *
 * resetWallet lands its write strictly ahead of every open tab
 * (fresh.seq = baseSeq + 1), but restoreWallet wrote the backup's seq
 * verbatim. A backup taken at seq 40 restored over a live wallet at seq 900
 * was silently overwritten by the trading tab's next heartbeat — the user's
 * restore vanished within a second.
 */
test('restoreWallet lands the restored wallet ahead of every live writer', () => {
  const popup = fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8');
  const fnStart = popup.indexOf('async function restoreWallet');
  assert.ok(fnStart !== -1, 'restoreWallet must exist');
  const block = popup.slice(fnStart, popup.indexOf('\n}', fnStart) + 2);

  assert.match(block, /chrome\.storage\.local\.get\(\['pt_state'\]\)/,
    'restore must read the live wallet seq before writing');
  assert.match(block, /Math\.max\(liveSeq, backupSeq\) \+ 1/,
    'the restored seq must land strictly greater than both the live and backup counters');
});
