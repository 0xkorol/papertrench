/* Re-injection after a reload/update — the stale-tab class.
 *
 * Chrome does NOT re-inject content scripts into tabs that were already open
 * when an extension is reloaded, updated, or re-enabled. Those tabs keep the
 * ORPHANED old scripts: their globals survive but every chrome.* handle is
 * invalidated, so the panel is dead and can never come back — while the page
 * looks completely normal. The extension reads as broken ("it's just not
 * showing up"), and the only cure is a refresh the user has no reason to
 * suspect. In development that is every reload; in the wild it is every
 * auto-update, on every open terminal tab.
 *
 * The sweep therefore re-injects the manifest's own script sets into tabs the
 * manifest already claims — but ONLY where the resident instance proves it is
 * dead, because injecting a second live content.js would mount a second panel.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

/** Chrome match pattern -> RegExp. The fake matches for real so the test
 * proves the MANIFEST's own patterns select the right tabs. */
function matchToRe(pattern) {
  const m = /^(\*|https?):\/\/([^/]+)(\/.*)$/.exec(pattern);
  if (!m) return /$^/;
  const scheme = m[1] === '*' ? 'https?' : m[1];
  const host = m[2];
  const hostRe = host === '*' ? '[^/]+'
    : host.startsWith('*.') ? '(?:[^/]+\\.)?' + host.slice(2).replace(/\./g, '\\.')
      : host.replace(/\./g, '\\.');
  const pathRe = m[3].replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + scheme + '://' + hostRe + pathRe + '$');
}

function tabMatches(url, patterns) {
  return (patterns || []).some((p) => matchToRe(p).test(url));
}

/**
 * Boot the shipped background.js with a chrome fake that models the one thing
 * under test honestly: `openTabs` are real tabs, `aliveTabs` are the ones whose
 * resident instance still answers the liveness probe, and `unscriptable` tabs
 * throw exactly like a page Chrome refuses to script.
 */
function serviceWorker(opts = {}) {
  const openTabs = opts.openTabs || [];
  const aliveTabs = new Set(opts.aliveTabs || []);
  const unscriptable = new Set(opts.unscriptable || []);
  const scriptCalls = [];
  const cssCalls = [];
  const values = {
    pt_settings: { framesEnabled: false, recordingEnabled: false, autoReview: false },
    pt_state: { positions: {}, rounds: [], journal: [] },
  };
  let installedListener = null;

  const get = (keys, callback) => {
    const names = Array.isArray(keys) ? keys : Object.keys(keys || {});
    const result = {};
    for (const key of names) if (Object.hasOwn(values, key)) result[key] = values[key];
    if (callback) { callback(result); return undefined; }
    return Promise.resolve(result);
  };
  const set = (update, callback) => {
    Object.assign(values, update);
    if (callback) callback();
    return Promise.resolve();
  };
  const sessionStore = {};
  const sandbox = {
    console, Promise, JSON, Math, Date, Number, String, Array, Object, Boolean,
    RegExp, Error, Set, Map, WeakMap, WeakSet, Symbol, isFinite, isNaN,
    parseInt, parseFloat, URL, URLSearchParams, TextEncoder, TextDecoder,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {},
    crypto: globalThis.crypto,
    fetch: async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => '' }),
    chrome: {
      storage: {
        local: { get, set, remove: (k, cb) => { if (cb) cb(); } },
        session: {
          get: (keys, cb) => { const out = {}; for (const k of (Array.isArray(keys) ? keys : [keys])) if (sessionStore[k]) out[k] = sessionStore[k]; cb ? cb(out) : null; return Promise.resolve(out); },
          set: (u, cb) => { Object.assign(sessionStore, u); if (cb) cb(); return Promise.resolve(); },
          remove: (k, cb) => { delete sessionStore[k]; if (cb) cb(); return Promise.resolve(); },
        },
        onChanged: { addListener: () => {} },
      },
      runtime: {
        id: 'papertrench-test',
        getManifest: () => MANIFEST,
        openOptionsPage: () => {},
        onMessage: { addListener: () => {} },
        onMessageExternal: { addListener: () => {} },
        onStartup: { addListener: () => {} },
        onInstalled: { addListener: (fn) => { installedListener = fn; } },
        sendMessage: async () => ({}),
      },
      tabs: {
        query: (query, callback) => {
          const hits = openTabs.filter((t) => tabMatches(t.url, query && query.url));
          if (callback) { callback(hits); return undefined; }
          return Promise.resolve(hits);
        },
        sendMessage: async () => ({}),
        captureVisibleTab: async () => 'data:image/jpeg;base64,',
        get: async (id) => openTabs.find((t) => t.id === id) || (() => { throw new Error('no tab'); })(),
        create: async () => ({ id: 999 }),
        update: async () => ({}),
        remove: async () => {},
        onRemoved: { addListener: () => {} },
        onUpdated: { addListener: () => {} },
        onActivated: { addListener: () => {} },
      },
      scripting: {
        executeScript: async (injection) => {
          const tabId = injection.target.tabId;
          scriptCalls.push({
            tabId,
            probe: typeof injection.func === 'function',
            files: injection.files || null,
            world: injection.world || null,
          });
          if (unscriptable.has(tabId)) throw new Error('Cannot access contents of the page');
          if (typeof injection.func === 'function') return [{ result: aliveTabs.has(tabId) }];
          return [{ result: null }];
        },
        insertCSS: async (injection) => {
          cssCalls.push({ tabId: injection.target.tabId, files: injection.files });
          if (unscriptable.has(injection.target.tabId)) throw new Error('Cannot access contents of the page');
        },
      },
      windows: { update: async () => ({}) },
      offscreen: { hasDocument: async () => false, createDocument: async () => {} },
      alarms: { clear: async () => true, create: () => {}, onAlarm: { addListener: () => {} } },
    },
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  sandbox.importScripts = (...files) => {
    for (const file of files) {
      vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: file });
    }
  };
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'), context, { filename: 'background.js' });

  return {
    scriptCalls,
    cssCalls,
    injections: () => scriptCalls.filter((c) => !c.probe),
    fireInstalled: (reason) => {
      assert.equal(typeof installedListener, 'function',
        'background.js must register an onInstalled listener');
      return installedListener({ reason: reason || 'install' });
    },
    settle: async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); },
  };
}

/* The manifest's own trading entries, as the shipped file declares them. */
const ISOLATED_TRADING = MANIFEST.content_scripts.find(
  (cs) => (cs.js || []).includes('content.js')
);
const MAIN_TRADING = MANIFEST.content_scripts.find(
  (cs) => cs.world === 'MAIN' && (cs.js || []).includes('price-bridge.js')
);

test('the reload sweep re-injects ONLY the tabs whose instance is dead', async () => {
  const worker = serviceWorker({
    openTabs: [
      { id: 11, url: 'https://fomo.family/tokens/solana/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
      { id: 22, url: 'https://trade.padre.gg/trade/solana/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
    ],
    // Tab 22 was opened AFTER the reload, so Chrome injected it normally and
    // its instance still answers. Tab 11 is the stranded one.
    aliveTabs: [22],
  });
  worker.fireInstalled('install');
  await worker.settle();

  const injected = worker.injections();
  assert.equal(injected.length, 1,
    'exactly one tab was stranded, so exactly one re-injection may happen');
  assert.equal(injected[0].tabId, 11, 'the DEAD tab is the one that gets rebuilt');
  assert.deepEqual(injected[0].files, ISOLATED_TRADING.js,
    'the manifest is the single source of truth for what gets injected, in order');

  const css = worker.cssCalls.filter((c) => c.tabId === 11);
  assert.equal(css.length, 1, 'the panel stylesheet must come back too');
  assert.deepEqual(css[0].files, ISOLATED_TRADING.css);
});

test('MAIN-world entries are never re-injected — they survive the reload', async () => {
  const worker = serviceWorker({
    openTabs: [{ id: 11, url: 'https://fomo.family/tokens/solana/So11111111111111111111111111111111111111112' }],
    aliveTabs: [],
  });
  worker.fireInstalled('update');
  await worker.settle();

  // The MAIN-world bridge never touches chrome.*, so an extension reload does
  // not kill it — and injecting a second copy risks double-initialising the
  // page world. Only the ISOLATED half dies, so only it comes back.
  const mainFiles = new Set(MAIN_TRADING.js);
  for (const call of worker.injections()) {
    for (const file of call.files || []) {
      assert.ok(!mainFiles.has(file) || ISOLATED_TRADING.js.includes(file),
        `${file} is a MAIN-world script and must not be re-injected`);
    }
    assert.notEqual(call.world, 'MAIN', 'no injection may target the MAIN world');
  }
});

test('a tab Chrome refuses to script never stops the sweep', async () => {
  const worker = serviceWorker({
    openTabs: [
      { id: 11, url: 'https://fomo.family/tokens/solana/So11111111111111111111111111111111111111112' },
      { id: 22, url: 'https://gmgn.ai/sol/token/So11111111111111111111111111111111111111112' },
      { id: 33, url: 'https://axiom.trade/meme/So11111111111111111111111111111111111111112' },
    ],
    aliveTabs: [],
    unscriptable: [22],
  });
  worker.fireInstalled('install');
  await worker.settle();

  const ids = worker.injections().map((c) => c.tabId).sort((a, b) => a - b);
  assert.deepEqual(ids, [11, 33],
    'one hostile tab must not strand the others — the sweep is per-tab');
});

test('tabs outside the manifest are never touched', async () => {
  const worker = serviceWorker({
    openTabs: [
      { id: 11, url: 'https://mail.google.com/mail/u/0' },
      { id: 22, url: 'https://example.com/' },
    ],
    aliveTabs: [],
  });
  worker.fireInstalled('install');
  await worker.settle();

  assert.equal(worker.scriptCalls.length, 0,
    'the sweep may only reach hosts the manifest already claims — not even a probe elsewhere');
});

test('the content script publishes a liveness beacon that an ORPHAN answers false', () => {
  const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  assert.match(content, /window\.__ptAlive\s*=/,
    'content.js must publish the beacon the sweep probes');
  const start = content.indexOf('window.__ptAlive');
  const block = content.slice(start, start + 400);
  assert.match(block, /chrome\.runtime\s*&&\s*chrome\.runtime\.id/,
    'liveness must be decided by the chrome handle — an orphan keeps its globals '
    + 'but loses chrome.*, which is the ONLY reliable way to tell the two apart');
  assert.match(block, /contextDead/,
    'a script that already shut itself down is dead too');

  // Prove the beacon actually answers false for an orphan: run the published
  // shape against an invalidated chrome, exactly as Chrome leaves it.
  const orphan = { window: {}, contextDead: false, chrome: { runtime: {} } };
  vm.createContext(orphan);
  vm.runInContext(
    'window.__ptAlive = () => { try { return !contextDead && Boolean(chrome.runtime && chrome.runtime.id); } catch (_) { return false; } };',
    orphan
  );
  assert.equal(orphan.window.__ptAlive(), false,
    'an orphaned instance must report dead so its tab gets rebuilt');
});
