/* Dashboard/popup/background defect-fix regression tests.
 *
 * Covers the DEFECTS.md batch fixed together in this change:
 *
 *   D-04  AI-review click disabled the NOTES button (shared data-id)
 *   D-05  replay button always read "▶ 0 moments" (checkpoints never written)
 *   D-07  Best/Worst tiles hardcoded green/red and dropped the sign
 *   D-10  quick-sell presets accepted > 100%
 *   D-11  negative fee/slippage accepted — negative fees MINT free SOL
 *   D-15  failed storage read fabricated a fresh wallet, then persisted it
 *   D-16  init() unawaited/uncaught — any throw = permanently blank dashboard
 *   D-21  AI sendMessage rejections hung the UI at "Analyzing…" forever
 *   D-23  slippage ≥ 10000 made every sell throw a misleading feed error
 *   D-24  Settings rendered blank (and unbindable) on corrupt preset arrays
 *   D-25  a failed settings save was completely invisible
 *   D-29  "Test AI endpoint" persisted the entire unsaved form
 *   D-30  popup toggle label went stale on the storage-fallback path
 *   D-32  journal "Market cap" column mixed mcap and SOL prices
 *   D-33  calendar month chip broke in year-first locales ("202")
 *   D-38  reset ignored the starting balance typed into the form
 *   D-42  silent input coercions (0 balance → 10, uncapped preset lists)
 *   D-47  "Saved." written into the AI-test span and never cleared
 *   D-51  dashboard reset double-bumped seq (engine owns the bump)
 *   D-52  sessionStats counted break-even rounds as losses
 *
 * Engine fixes are exercised behaviourally through the real API; the
 * background override path is driven through the real service worker in a vm
 * sandbox; dashboard.js/popup.js (no DOM harness exists) are pinned with
 * source contracts in the statepersist.test.js style: assert the fixed shape
 * exists and the buggy shape is gone.
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

const dashJs = fs.readFileSync(path.join(ROOT, 'dashboard.js'), 'utf8');
const popupJs = fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8');

/** Slice a top-level function body (functions in these files close at col 0). */
function fnBlock(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start !== -1, `${marker} must exist`);
  const end = source.indexOf('\n}', start);
  assert.ok(end !== -1, `${marker} must terminate`);
  return source.slice(start, end + 2);
}

/* ---------------- D-52: break-even rounds (engine, behavioural) ------------ */

test('D-52: a break-even round is neither a win nor a loss', () => {
  const settings = E.defaultSettings();
  const state = E.defaultState(settings);
  state.rounds = [
    { pnlSol: 1.5, pnlPct: 15 },
    { pnlSol: -0.5, pnlPct: -5 },
    { pnlSol: 0, pnlPct: 0 }, // scratched — exactly break-even
  ];
  const stats = E.sessionStats(state, settings);
  assert.equal(stats.rounds, 3);
  assert.equal(stats.wins, 1);
  assert.equal(stats.losses, 1, 'a scratched trade must not be branded a loss');
  assert.equal(stats.winRate, 50, 'the win rate is judged over decided rounds only');
});

test('D-52: all-break-even and empty sessions report a 0 win rate, not NaN', () => {
  const settings = E.defaultSettings();
  const scratched = E.defaultState(settings);
  scratched.rounds = [{ pnlSol: 0 }, { pnlSol: 0 }];
  const stats = E.sessionStats(scratched, settings);
  assert.equal(stats.wins, 0);
  assert.equal(stats.losses, 0);
  assert.equal(stats.winRate, 0);

  const empty = E.sessionStats(E.defaultState(settings), settings);
  assert.equal(empty.winRate, 0);
  assert.ok(!Number.isNaN(empty.winRate));
});

/* ---------------- D-29: endpoint test overrides (background, behavioural) --
 *
 * The real service worker is booted in a vm sandbox (same shape as
 * background.test.js) so the pt_ai_models message path runs for real: the
 * probe must hit the OVERRIDE endpoint, honour the override key and local
 * opt-in through the same isAllowedEndpoint gate, and write NOTHING.
 */
function serviceWorker() {
  const values = {
    pt_settings: { framesEnabled: false, recordingEnabled: false, autoReview: false, settingsRevision: 6 },
    pt_state: { positions: {}, rounds: [], journal: [] },
  };
  const writes = [];
  const fetchCalls = [];
  let messageListener = null;

  const sandbox = {
    console, Promise, JSON, Math, Date, Number, String, Array, Object, Boolean,
    RegExp, Error, Set, Map, URL, URLSearchParams, AbortController, Uint8Array,
    setTimeout, clearTimeout,
    setInterval: () => 1,
    clearInterval: () => {},
    fetch: async (url, opts) => {
      fetchCalls.push({ url: String(url), opts: opts || {} });
      if (String(url).endsWith('/models')) {
        return { ok: true, status: 200, json: async () => ({ data: [{ id: 'model-a' }, { id: 'model-b' }] }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    },
    chrome: {
      storage: {
        local: {
          get: (keys, callback) => {
            const names = Array.isArray(keys) ? keys : Object.keys(keys || {});
            const result = {};
            for (const key of names) if (Object.hasOwn(values, key)) result[key] = values[key];
            if (callback) { callback(result); return undefined; }
            return Promise.resolve(result);
          },
          set: (update, callback) => {
            writes.push(Object.keys(update));
            Object.assign(values, update);
            if (callback) callback();
            return Promise.resolve();
          },
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
        query: (query, callback) => callback([]),
        sendMessage: async () => ({}),
        captureVisibleTab: async () => 'data:image/jpeg;base64,',
        get: async () => { throw new Error('no tab'); },
      },
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
  return { values, writes, fetchCalls, get listener() { return messageListener; } };
}

function send(listener, message) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('background response timed out')), 2000);
    listener(message, { tab: { id: 1 } }, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
  });
}

test('D-29: pt_ai_models probes the override endpoint and writes nothing', async () => {
  const worker = serviceWorker();
  const response = await send(worker.listener, {
    type: 'pt_ai_models',
    overrides: {
      endpoint: 'https://ai.example.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-x',
      aiAllowLocalEndpoint: false,
    },
  });
  assert.deepEqual(response.models, ['model-a', 'model-b']);
  const modelCalls = worker.fetchCalls.filter((c) => c.url.endsWith('/models'));
  assert.equal(modelCalls.length, 1);
  assert.equal(modelCalls[0].url, 'https://ai.example.com/v1/models',
    'the probe must hit the OVERRIDE endpoint, not the (empty) saved one');
  assert.equal(modelCalls[0].opts.headers.Authorization, 'Bearer sk-test',
    'the override key must authorise the probe');
  assert.deepEqual(worker.writes, [],
    'testing the endpoint must not write ANY storage key — the old handler persisted the whole unsaved form');
});

test('D-29: override endpoints still pass the isAllowedEndpoint SSRF gate', async () => {
  const worker = serviceWorker();
  const blocked = await send(worker.listener, {
    type: 'pt_ai_models',
    overrides: { endpoint: 'http://127.0.0.1:8765/v1', aiAllowLocalEndpoint: false },
  });
  assert.ok(blocked.error, 'a local endpoint without the local opt-in must be refused');
  // .length, not deepEqual: the refusal array is built inside the vm realm,
  // so its prototype is the sandbox's Array and deepStrictEqual would reject
  // two identical-looking empties.
  assert.equal(blocked.models.length, 0);
  assert.equal(worker.fetchCalls.filter((c) => c.url.endsWith('/models')).length, 0,
    'no request may leave for a refused endpoint');

  const allowed = await send(worker.listener, {
    type: 'pt_ai_models',
    overrides: { endpoint: 'http://127.0.0.1:8765/v1', aiAllowLocalEndpoint: true },
  });
  assert.deepEqual(allowed.models, ['model-a', 'model-b'],
    'the explicit local opt-in carried by the form must be honoured');
  assert.deepEqual(worker.writes, [], 'still nothing written');
});

test('D-29: pt_ai_models without overrides keeps using saved settings', async () => {
  const worker = serviceWorker();
  worker.values.pt_settings.aiEndpoint = 'https://saved.example.com/v1';
  const response = await send(worker.listener, { type: 'pt_ai_models' });
  assert.deepEqual(response.models, ['model-a', 'model-b']);
  const modelCalls = worker.fetchCalls.filter((c) => c.url.endsWith('/models'));
  assert.equal(modelCalls[0].url, 'https://saved.example.com/v1/models');
});

test('D-29: the dashboard test button sends overrides instead of persisting the form', () => {
  const bind = fnBlock(dashJs, 'function bindSettings()');
  const testIdx = bind.indexOf("getElementById('test-ai')");
  assert.ok(testIdx !== -1, 'the test button handler must exist');
  const testBlock = bind.slice(testIdx);
  assert.doesNotMatch(testBlock, /store\.set\(/,
    'the endpoint test must not write storage at all');
  assert.match(testBlock, /type: 'pt_ai_models',\s*\n\s*overrides: \{/,
    'the form values must travel as message overrides');
  for (const field of [
    'endpoint: settingsNow.aiEndpoint',
    'apiKey: settingsNow.aiApiKey',
    'aiAllowLocalEndpoint: settingsNow.aiAllowLocalEndpoint',
  ]) {
    assert.ok(testBlock.includes(field), `the override must carry ${field}`);
  }
});

/* ---------------- D-04 / D-21: AI review button targeting + rejections ----- */

test('D-04: the AI-review button has its own attribute and runReview targets it', () => {
  const rounds = fnBlock(dashJs, 'function renderRounds(el)');
  assert.match(rounds, /class="btn-sec review-btn" data-review-id=/,
    'the review button must carry data-review-id, not the shared data-id');

  const review = fnBlock(dashJs, 'async function runReview(roundId)');
  assert.match(review, /button\.review-btn\[data-review-id=/,
    'runReview must select the review button by its own attribute');
  assert.doesNotMatch(review, /`button\[data-id="\$\{roundId\}"\]`/,
    'the old bare data-id selector grabbed the NOTES button (first in the row) instead');

  const rebind = fnBlock(dashJs, 'function rebindSection(id, el)');
  assert.match(rebind, /runReview\(button\.dataset\.reviewId\)/,
    'the click binding must pass the id from the new attribute');
});

test('D-21: both AI sendMessage calls handle rejection and restore the UI', () => {
  const review = fnBlock(dashJs, 'async function runReview(roundId)');
  assert.match(review, /try \{[\s\S]*pt_ai_chat[\s\S]*\} catch \(err\) \{\s*\n\s*fail\(err\);/,
    'a rejected review call must route through the failure path, not reject unhandled');
  assert.match(review, /b\.disabled = false;[\s\S]*b\.textContent = 'AI review';/,
    'the failure path must re-enable the button and restore its label');

  const session = fnBlock(dashJs, 'async function runSessionReview()');
  assert.match(session, /try \{\s*\n\s*resp = await chrome\.runtime\.sendMessage/,
    'the session review call must be wrapped');
  assert.match(session, /catch \(err\) \{[\s\S]*out\.textContent = 'Error: '[\s\S]*out\.classList\.add\('error'\)/,
    'a rejected session review must land in the output element as an error');
});

/* ---------------- D-05: replay button label ------------------------------- */

test('D-05: the replay button no longer counts the never-written checkpoints array', () => {
  const rounds = fnBlock(dashJs, 'function renderRounds(el)');
  assert.doesNotMatch(rounds, /checkpoints\.length|moments</,
    'replay.checkpoints is initialised [] and written nowhere — any count from it is a lie');
  assert.match(rounds, /replay-btn" data-session="\$\{esc\(replay\.sessionId\)\}">▶ Replay</,
    'the button reads plain "▶ Replay"');
});

/* ---------------- D-07: best/worst tiles ---------------------------------- */

test('D-07: best/worst tiles are coloured by actual sign and always signed', () => {
  const overview = fnBlock(dashJs, 'function renderOverview(el)');
  assert.match(overview, /statTile\('Best round'[\s\S]*?best && best\.pnlSol < 0 \? 'red' : 'green'/,
    'a negative best round (all-losing session) must render red');
  assert.match(overview, /statTile\('Worst round'[\s\S]*?worst && worst\.pnlSol >= 0 \? 'green' : 'red'/,
    'a positive worst round (all-winning session) must render green');
  assert.match(overview, /statTile\('Worst round', worst \? `\$\{worst\.pnlSol >= 0 \? '\+' : ''\}/,
    'the worst tile must carry an explicit sign');
  assert.doesNotMatch(overview, /: '—', 'green',/,
    'the hardcoded green tone must be gone');
  assert.doesNotMatch(overview, /: '—', 'red',/,
    'the hardcoded red tone must be gone');
});

/* ---------------- D-10/D-11/D-23/D-42: settings validation ---------------- */

test('D-10/D-11/D-23/D-42: form values are validated, never passed raw', () => {
  const gather = fnBlock(dashJs, 'function gatherSettingsFromForm(');

  // The exact coercions that minted free SOL / broke sells must be gone.
  assert.doesNotMatch(gather, /balanceStartSol: Number\(document\.getElementById\('set-balance'\)\.value\) \|\| 10/,
    'an invalid (or 0) balance must not silently become 10');
  assert.doesNotMatch(gather, /feeBps: Number\(document\.getElementById\('set-fee'\)\.value\) \|\| 0/,
    'a negative feeBps must be impossible — engine.js:214 turns it into free SOL');
  assert.doesNotMatch(gather, /slippageBps: Number\(document\.getElementById\('set-slippage'\)\.value\) \|\| 0/,
    'slippage ≥ 10000 makes every sell throw "No live price available"');

  // The fixed shape: bounded integers, bounded/deduped/capped preset lists.
  assert.match(gather, /clampInt\('set-fee', 0, 1000/, 'fee bps clamped to integer 0..1000');
  assert.match(gather, /clampInt\('set-slippage', 0, 2000/, 'slippage bps clamped to integer 0..2000');
  assert.match(gather, /numberList\('set-sellpcts', 100, [^,]+, \{ dedupe: true \}\)/,
    'quick-sell presets: > 0, ≤ 100, deduplicated');
  assert.match(gather, /numberList\('set-presets', 1000,/,
    'quick-buy presets: > 0, ≤ 1000');
  assert.match(gather, /values\.slice\(0, 8\)/, 'preset lists capped at 8 entries');
  assert.match(gather, /new Set\(values\)/, 'dedupe goes through a Set');
  assert.match(gather, /balanceNum >= 0\.1/, 'the balance floor is 0.1 SOL');
  assert.match(gather, /notes\.push\(`starting balance/,
    'a rejected balance must be reported, not silently replaced');
  assert.match(gather, /notes\.push/, 'every coercion is reported through notes');
});

/* ---------------- D-15: failed reads never fabricate a wallet ------------- */

test('D-15: dashboard storage reads fail soft and failed reads block writes', () => {
  const storeIdx = dashJs.indexOf('const store = {');
  assert.ok(storeIdx !== -1);
  const storeBlock = dashJs.slice(storeIdx, dashJs.indexOf('\n};', storeIdx) + 3);
  assert.match(storeBlock, /chrome\.runtime\.lastError\) \{ resolve\(null\); return; \}/,
    'store.get must resolve null on lastError — a failed read is NOT empty storage');

  const load = fnBlock(dashJs, 'async function loadAll()');
  assert.match(load, /if \(s === null\) \{/,
    'loadAll must branch on the failed-read sentinel instead of fabricating a fresh wallet');
  assert.match(load, /storageReadFailed = true;/, 'the failure must latch a module flag');
  assert.match(load, /renderStorageErrorBanner\(\)/, 'the failure must be visible');

  const saveStateBlock = fnBlock(dashJs, 'async function saveState()');
  assert.match(saveStateBlock, /if \(storageReadFailed\) \{\s*\n\s*throw new Error/,
    'saveState must refuse while storage is unreadable — persisting a fabricated wallet destroys the real one');
  const saveSettingsBlock = fnBlock(dashJs, 'async function saveSettings()');
  assert.match(saveSettingsBlock, /if \(storageReadFailed\) \{\s*\n\s*throw new Error/,
    'saveSettings must refuse for the same reason');

  const banner = fnBlock(dashJs, 'function renderStorageErrorBanner()');
  assert.match(banner, /Storage read failed/, 'the banner must say what happened');
  assert.match(banner, /banner\.remove\(\)/, 'the banner must clear once a read succeeds');
});

/* ---------------- D-16: boot failures are visible ------------------------- */

test('D-16: a throw during init renders an error card instead of a blank page', () => {
  assert.match(dashJs, /init\(\)\.catch\(renderInitError\);/,
    'init must be fired with a catch');
  assert.doesNotMatch(dashJs, /^init\(\);$/m,
    'the bare unawaited init() call must be gone');
  const card = fnBlock(dashJs, 'function renderInitError(err)');
  assert.match(card, /createElement\('button'\)/, 'the card must offer a reload button');
  assert.match(card, /location\.reload\(\)/);
  assert.match(card, /\.textContent = \(err && err\.message\) \? err\.message : String\(err\)/,
    'the message is set via textContent — plain DOM, no markup injection');
});

/* ---------------- D-24: settings render survives corrupt arrays ----------- */

test('D-24: Settings renders (and stays bindable) with corrupt preset arrays', () => {
  const rs = fnBlock(dashJs, 'function renderSettings(el)');
  assert.match(rs, /Array\.isArray\(settings\.sellPcts\) \? settings\.sellPcts : DEFAULTS\.sellPcts/,
    'sellPcts must fall back to defaults at render time');
  assert.match(rs, /Array\.isArray\(settings\.presetsBuy\) \? settings\.presetsBuy : DEFAULTS\.presetsBuy/,
    'presetsBuy must fall back to defaults at render time');
  assert.doesNotMatch(rs, /settings\.sellPcts\.join/,
    'no unguarded .join on possibly-corrupt settings — it blanked the whole tab');
  assert.doesNotMatch(rs, /settings\.presetsBuy\.join/);
});

/* ---------------- D-25 / D-47: save status -------------------------------- */

test('D-25/D-47: save reports into its own status element, shows failures, auto-clears', () => {
  const save = fnBlock(dashJs, 'async function saveFromForm()');
  assert.match(save, /getElementById\('save-status'\)/,
    'the save flow must use its own status element');
  assert.doesNotMatch(save, /ai-test-result/,
    'the AI-test output span must never receive save status again');
  assert.match(save, /catch \(err\) \{[\s\S]*Save failed/,
    'a failed save must be shown (the old "Saved." wrote after the await, unconditionally)');
  assert.match(save, /setTimeout\([\s\S]*?2500\)/,
    'the plain confirmation must clear itself after ~2.5s');

  const rs = fnBlock(dashJs, 'function renderSettings(el)');
  assert.match(rs, /id="save-status"/,
    'the status element must render next to the Save button');
});

/* ---------------- D-30: popup fallback label ------------------------------ */

test('D-30: the popup fallback toggle re-renders so the label matches reality', () => {
  const block = fnBlock(popupJs, 'async function toggleOverlay()');
  assert.match(block, /chrome\.storage\.local\.set\(\{ pt_settings: newSettings \}\);[\s\S]*await load\(\);/,
    'after the storage-only fallback write the button label must be refreshed');
});

/* ---------------- D-32: honest market-cap column -------------------------- */

test('D-32: the journal Market cap column never shows a SOL price', () => {
  const journal = fnBlock(dashJs, 'function renderJournal(el)');
  assert.match(journal, /\$\{mcapLevel\(t\)\}/,
    'the mcap column must render through the mcap-only helper');
  assert.doesNotMatch(journal, /fillLevel\(t\)/,
    'the price-fallback helper must not feed the Market cap column');

  const mcap = fnBlock(dashJs, 'function mcapLevel(trade)');
  assert.match(mcap, /'—'/, 'an unknown mcap renders a plain em-dash');
  assert.doesNotMatch(mcap, /SOL/,
    'a SOL price must never appear under the Market cap header');

  const fill = fnBlock(dashJs, 'function fillLevel(trade)');
  assert.match(fill, /price > 0 \? PC\.formatPrice\(price\) \+ ' SOL' : '—'/,
    'fillLevel itself can no longer emit the "— SOL" corpse for a missing price');
});

/* ---------------- D-33: locale-safe month chip ---------------------------- */

test('D-33: the calendar best/worst chip asks the locale for the short month', () => {
  const cal = fnBlock(dashJs, 'function renderCalendar(el)');
  assert.doesNotMatch(cal, /monthName\.split\(' '\)\[0\]\.slice\(0, 3\)/,
    'slicing the long locale string renders "202" in year-first locales (ja-JP, hu-HU)');
  assert.match(cal, /\{ month: 'short' \}/,
    'the short month must come from toLocaleDateString directly');
  assert.match(cal, /\$\{monthShort\} \$\{t\.bestDay\.day\}/);
  assert.match(cal, /\$\{monthShort\} \$\{t\.worstDay\.day\}/);
});

/* ---------------- D-38 / D-51: reset -------------------------------------- */

function resetBlock() {
  const bind = fnBlock(dashJs, 'function bindSettings()');
  const start = bind.indexOf("getElementById('reset-all')");
  const end = bind.indexOf("getElementById('test-ai')");
  assert.ok(start !== -1 && end !== -1 && end > start, 'reset handler must exist before the test handler');
  return bind.slice(start, end);
}

test('D-38: reset honours a valid starting balance typed into the form', () => {
  const block = resetBlock();
  assert.match(block, /getElementById\('set-balance'\)/,
    'reset must read the form balance, not only the stale saved settings');
  assert.match(block, /formBalance >= 0\.1/,
    'only a valid (≥ 0.1 SOL) form balance is adopted');
  assert.match(block, /write\.pt_settings = settings/,
    'the adopted balance must be persisted so the reset wallet and saved settings agree');
});

test('D-51: dashboard reset does not double-bump seq — the engine owns the bump', () => {
  const block = resetBlock();
  assert.match(block, /E\.resetState\(settings, state\.seq\)/,
    'the reset must inherit the live seq through resetState');
  assert.doesNotMatch(block, /state\.seq = \(Number\(state\.seq\) \|\| 0\) \+ 1/,
    'resetState already advanced seq past the inherited base; a second bump lies about write count');
});

test('D-51 companion: engine resetState advances seq past the inherited base', () => {
  const fresh = E.resetState(E.defaultSettings(), 41);
  assert.equal(fresh.seq, 42, 'resetState owns the single seq bump');
});
