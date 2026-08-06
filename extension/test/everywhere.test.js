/* Instant Links beyond the terminals — the opt-in spread (Turbo II).
 *
 * The contract this suite pins is the O-09 survival story: the MANIFEST's
 * content scripts stay narrow, nothing registers anywhere by default, every
 * runtime registration exists only while its own toggle is on, and turning a
 * toggle off unregisters immediately. The registration lifecycle runs against
 * the real background.js in a vm sandbox with a fake chrome.scripting.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

/* ---------------- manifest: the O-09 property, restated ---------------- */

test('the manifest itself stays narrow — the spread is runtime-only', () => {
  assert.ok(manifest.permissions.includes('scripting'),
    'runtime registration needs the scripting permission');
  for (const cs of manifest.content_scripts) {
    assert.ok(!cs.matches.includes('<all_urls>'),
      'no static content script may match <all_urls> (DEFECT O-09)');
    assert.ok(!cs.matches.some((m) => m === 'https://*/*' || m === '*://*/*'),
      'no static content script may match every site (DEFECT O-09)');
  }
});

/* ---------------- background registration lifecycle ---------------- */

function spreadWorker(opts = {}) {
  const values = {
    pt_settings: {
      framesEnabled: false, recordingEnabled: false, autoReview: false,
      ...(opts.settings || {}),
    },
    pt_state: { positions: {}, rounds: [], journal: [] },
  };
  const session = {};
  const registered = [];
  let messageListener = null;

  const sandbox = {
    console: { debug: () => {}, warn: () => {}, error: () => {}, log: () => {} },
    Promise, JSON, Math, Date, Number, String, Array, Object, Boolean, RegExp,
    Error, Set, Map, URL, URLSearchParams, AbortController, Uint8Array,
    setTimeout: () => 1, clearTimeout: () => {},
    setInterval: () => 1, clearInterval: () => {},
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    chrome: {
      storage: {
        local: {
          get: (keys, callback) => {
            const names = Array.isArray(keys) ? keys : Object.keys(keys || {});
            const result = {};
            for (const key of names) if (Object.hasOwn(values, key)) result[key] = values[key];
            callback(result);
          },
          set: (update, callback) => { Object.assign(values, update); if (callback) callback(); },
        },
        session: {
          get: (keys, callback) => {
            const result = {};
            for (const key of keys) if (Object.hasOwn(session, key)) result[key] = session[key];
            callback(result);
          },
          set: (update, callback) => { Object.assign(session, update); if (callback) callback(); },
          remove: (key, callback) => { delete session[key]; if (callback) callback(); },
        },
      },
      runtime: {
        id: 'papertrench-test',
        openOptionsPage: () => {},
        onMessage: { addListener: (listener) => { messageListener = listener; } },
        onStartup: { addListener: () => {} },
        onInstalled: { addListener: () => {} },
        sendMessage: async () => ({}),
      },
      tabs: {
        create: async (props) => ({ id: 1, ...props }),
        update: async () => ({}),
        get: async () => { throw new Error('no tab'); },
        remove: async () => {},
        query: (query, callback) => callback([]),
        sendMessage: async () => ({}),
        captureVisibleTab: async () => 'data:image/jpeg;base64,',
        onRemoved: { addListener: () => {} },
        onUpdated: { addListener: () => {} },
        onActivated: { addListener: () => {} },
      },
      windows: { update: async () => {} },
      offscreen: { hasDocument: async () => false, createDocument: async () => {} },
      scripting: {
        getRegisteredContentScripts: async (filter) => {
          const ids = filter && filter.ids;
          return registered.filter((s) => !ids || ids.includes(s.id)).map((s) => ({ ...s }));
        },
        registerContentScripts: async (scripts) => {
          for (const s of scripts) {
            if (registered.some((r) => r.id === s.id)) throw new Error('duplicate id ' + s.id);
            registered.push(JSON.parse(JSON.stringify(s)));
          }
        },
        unregisterContentScripts: async (filter) => {
          const ids = (filter && filter.ids) || [];
          for (const id of ids) {
            const at = registered.findIndex((r) => r.id === id);
            if (at !== -1) registered.splice(at, 1);
          }
        },
      },
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
    values, registered,
    get listener() { return messageListener; },
    settle() { return new Promise((resolve) => setImmediate(resolve)); },
  };
}

function send(listener, message, sender = { tab: { id: 1, windowId: 1, index: 0 } }) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('background response timed out')), 2000);
    const asyncResponse = listener(message, sender, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
    assert.equal(asyncResponse, true, 'background messages must keep the response channel open');
  });
}

test('defaults register NOTHING — off is zero footprint', async () => {
  const worker = spreadWorker();
  await worker.settle();
  await worker.settle();
  assert.equal(worker.registered.length, 0,
    'no toggle on, no registration — the worker-start reconcile must not invent any');
});

test('a toggle registers its site with the interceptor bundle, in classifier order', async () => {
  const worker = spreadWorker({ settings: { instantDiscordEnabled: true } });
  await worker.settle();
  await worker.settle();
  const discord = worker.registered.find((s) => s.id === 'pt-instant-discord');
  assert.ok(discord, 'the worker-start reconcile registers what the settings ask for');
  assert.deepEqual(discord.js, ['xlinks.js', 'warmdest.js', 'trajectory.js', 'warm-links.js'],
    'the bundle is the classifiers, the predictor, then the interceptor — order is load order');
  assert.ok(discord.matches.includes('https://discord.com/*'));
  assert.equal(discord.persistAcrossSessions, true,
    'registrations survive browser restarts so the toggle does not silently lapse');
  assert.equal(worker.registered.length, 1, 'only the asked-for site registers');
});

test('settings changes register and unregister live', async () => {
  const worker = spreadWorker();
  await worker.settle();
  worker.values.pt_settings.instantTelegramEnabled = true;
  await send(worker.listener, { type: 'pt_settings_changed' });
  await worker.settle();
  assert.ok(worker.registered.some((s) => s.id === 'pt-instant-telegram'),
    'turning a toggle on registers its site');

  worker.values.pt_settings.instantTelegramEnabled = false;
  await send(worker.listener, { type: 'pt_settings_changed' });
  await worker.settle();
  assert.equal(worker.registered.length, 0, 'turning it off unregisters immediately');
});

test('a second reconcile with unchanged settings re-registers nothing (idempotent)', async () => {
  const worker = spreadWorker({ settings: { instantDiscordEnabled: true } });
  await worker.settle();
  await worker.settle();
  assert.equal(worker.registered.length, 1);
  // The fake scripting API throws on duplicate ids — a non-idempotent
  // reconcile would blow up right here.
  await send(worker.listener, { type: 'pt_settings_changed' });
  await worker.settle();
  assert.equal(worker.registered.length, 1);
});

test('the everywhere registration excludes the terminals and X — built-ins own those', async () => {
  const worker = spreadWorker({ settings: { instantAllSitesEnabled: true } });
  await worker.settle();
  await worker.settle();
  const everywhere = worker.registered.find((s) => s.id === 'pt-instant-everywhere');
  assert.ok(everywhere, 'the maximal opt-in registers');
  assert.deepEqual(everywhere.matches, ['https://*/*'], 'https only — the classifiers refuse http anyway');
  const excluded = everywhere.excludeMatches || [];
  for (const must of [
    'https://axiom.trade/*', 'https://*.padre.gg/*', 'https://gmgn.ai/*',
    'https://pump.fun/*', 'https://*.bullx.io/*', 'https://dexscreener.com/*',
    'https://x.com/*', 'https://twitter.com/*',
  ]) {
    assert.ok(excluded.includes(must), `${must} must be excluded — its static bundle owns it`);
  }
});

/* ---------------- the interceptor bundle is inert off-terminal ---------- */

test('the spread bundle carries no MAIN-world hook, no engine, no overlay', () => {
  const background = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  const block = background.slice(
    background.indexOf('const INSTANT_SITE_JS'),
    background.indexOf('function instantSitesReconcile'),
  );
  assert.match(block, /'xlinks\.js', 'warmdest\.js', 'trajectory\.js', 'warm-links\.js'/,
    'exactly the two classifiers, the predictor, and the interceptor');
  for (const never of ['content.js', 'engine.js', 'warm-open-hook.js', 'price-bridge.js', 'xray']) {
    assert.ok(!block.includes(never),
      `${never} must never ride the spread — trading machinery stays on trading sites`);
  }
});
