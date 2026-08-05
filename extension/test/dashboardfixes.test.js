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
 * Wave 2 (accounting semantics + refresh architecture):
 *
 *   D-01  equity curve floated above true equity by cumulative buy fees
 *   D-02  "Realized P&L" was rounds-only while calendar/journal counted
 *         partial exits — same trade, three different numbers
 *   D-03  the chain replay disagreed with honest local state (gross vs net
 *         buy cost + partial exits), flagging untampered wallets as edited,
 *         with the absurd "0 problems found · derived P&L differs" line
 *   D-08  open-position % (net-of-fee) vs closed-round % (gross invested)
 *   D-17  session AI review answer wiped by the staged refresh
 *   D-18  leaderboard verification flickered to "Checking…" ~1/s, re-running
 *         SHA-256 over the whole chain; in-flight verifies landed detached
 *   D-19  settings save clobbered every content-script settings write
 *   D-20  open round-note editor destroyed the moment focus left it
 *   D-22  saveState was read-modify-write with no conflict handling
 *   D-26  emptying replays mid-playback → TypeError loop every 1.1 s
 *   D-27  fingerprint blind to in-place round mutations (review/note/thesis)
 *   D-28  tables reset scroll/hover ~1/s (marks + timeAgo churn)
 *   D-34  any focused input froze the ENTIRE dashboard refresh
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
const AT = require('../attest.js');

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
  // (D-17 moved the output into module state: setSessionReview stores the
  // text/error pair and re-renders the coach section from it, so the error
  // both shows immediately AND survives later refreshes.)
  assert.match(session, /catch \(err\) \{[\s\S]*setSessionReview\('Error: '[\s\S]*true\);/,
    'a rejected session review must land in the persisted output state as an error');
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

  // D-22 restructured saveState() into mutateState(); the D-15 refusal must
  // survive the restructure — writing while blind is still how a fabricated
  // wallet destroys the real one.
  const saveStateBlock = fnBlock(dashJs, 'async function mutateState(');
  assert.match(saveStateBlock, /if \(storageReadFailed\) throw unreadable\(\);/,
    'mutateState must refuse while storage is unreadable — persisting a fabricated wallet destroys the real one');
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

/* ======================= wave 2 ======================= */

function wave2Settings(over) {
  return Object.assign(E.defaultSettings(), { balanceStartSol: 10, feeBps: 100, slippageBps: 0 }, over || {});
}

/* ---------------- D-02: realized P&L includes partial exits --------------- */

test('D-02: a partial exit shows up in realized P&L everywhere, immediately', () => {
  const settings = wave2Settings();
  const state = E.defaultState(settings);
  const t0 = 1_700_000_000_000;

  E.buy(state, settings, { ts: t0, mint: 'MintA', symbol: 'X', priceNative: 0.001, solAmount: 1 });
  const { trade } = E.sell(state, settings, { ts: t0 + 1000, mint: 'MintA', qtyFraction: 0.5, priceNative: 0.002 });

  const stats = E.sessionStats(state, settings);
  assert.equal(stats.rounds, 0, 'no round has closed — the old rounds-only sum reported +0 here');
  assert.ok(trade.pnlSol > 0, 'the partial exit banked real profit');
  assert.ok(Math.abs(stats.realizedPnlSol - trade.pnlSol) < 1e-9,
    'sessionStats must report the banked partial, not the rounds-only 0');
  assert.ok(Math.abs(stats.realizedPnlSol - state.stats.realizedPnlSol) < 1e-9,
    'the figure IS the per-sell accumulator sell() maintains');

  // Close the rest: the total stays the per-sell definition — the same one
  // the calendar and journal sum — so one trade shows ONE number.
  E.sell(state, settings, { ts: t0 + 2000, mint: 'MintA', qtyFraction: 1, priceNative: 0.002 });
  const closed = E.sessionStats(state, settings);
  const perSellSum = state.journal
    .filter((t) => t.side === 'sell')
    .reduce((s, t) => s + t.pnlSol, 0);
  assert.ok(Math.abs(closed.realizedPnlSol - perSellSum) < 1e-9,
    'realized P&L must equal the sum of per-sell results (the calendar definition)');
  // The rounds-only sum differs by exactly the buy fee (net cost basis);
  // that fee is reported separately in feesPaidSol, not hidden inside P&L.
  const roundSum = state.rounds.reduce((s, r) => s + r.pnlSol, 0);
  const buyFees = state.journal.filter((t) => t.side === 'buy').reduce((s, t) => s + t.feeSol, 0);
  assert.ok(Math.abs((closed.realizedPnlSol - roundSum) - buyFees) < 1e-9,
    'the definitions differ by the buy fee — the accumulator uses the net cost basis');
});

test('D-02: a legacy state without the accumulator falls back to the journal', () => {
  const settings = wave2Settings();
  const state = E.defaultState(settings);
  const t0 = 1_700_000_000_000;
  E.buy(state, settings, { ts: t0, mint: 'MintA', symbol: 'X', priceNative: 0.001, solAmount: 1 });
  const { trade } = E.sell(state, settings, { ts: t0 + 1000, mint: 'MintA', qtyFraction: 0.5, priceNative: 0.002 });

  delete state.stats.realizedPnlSol; // restored backup from an older build
  const stats = E.sessionStats(state, settings);
  assert.ok(Math.abs(stats.realizedPnlSol - trade.pnlSol) < 1e-9,
    'the journal sells carry the same per-sell definition and must back-fill it');
});

test('D-02: the popup uses the same per-sell definition', () => {
  const block = fnBlock(popupJs, 'function computeStats(state, settings)');
  assert.doesNotMatch(block, /rounds\.reduce\(\(s, r\) => s \+ \(r\.pnlSol \|\| 0\), 0\)/,
    'the rounds-only sum reported +0 for a trade the dashboard calendar showed as +2');
  assert.match(block, /state\.stats \|\| \{\}\)\.realizedPnlSol/,
    'the popup must read the per-sell accumulator');
  assert.match(block, /t\.side === 'sell' \? \(Number\(t\.pnlSol\) \|\| 0\) : 0/,
    'with the journal fallback for legacy states');
});

/* ---------------- D-03: the chain agrees with honest local state ---------- */

/** Build a verifiable chain from the engine journal (oldest first). */
async function chainFromJournal(state) {
  const chain = [];
  let prev = AT.GENESIS;
  for (const t of [...state.journal].reverse()) {
    const link = await AT.appendFill(prev, t);
    link.seq = chain.length;
    chain.push(link);
    prev = link.hash;
  }
  return chain;
}

test('D-03: partial exits and fees no longer read as TAMPERING', async () => {
  const settings = wave2Settings(); // 1% per side — the default
  const state = E.defaultState(settings);
  const t0 = 1_700_000_000_000;

  E.buy(state, settings, { ts: t0, mint: 'MintA', symbol: 'X', priceNative: 0.001, solAmount: 1 });
  E.sell(state, settings, { ts: t0 + 1000, mint: 'MintA', qtyFraction: 0.5, priceNative: 0.002 });

  // Mid-round, partial exit banked, fees paid — an honest wallet.
  let chain = await chainFromJournal(state);
  let stats = E.sessionStats(state, settings);
  let match = AT.claimMatchesChain(
    { realizedPnlSol: stats.realizedPnlSol }, chain, settings.balanceStartSol, 1e-6
  );
  assert.equal(match.ok, true,
    `an untampered wallet must verify mid-round; derived differs by ${match.diff} SOL`);

  // And after the round closes, with a second position still open.
  E.sell(state, settings, { ts: t0 + 2000, mint: 'MintA', qtyFraction: 1, priceNative: 0.0015 });
  E.buy(state, settings, { ts: t0 + 3000, mint: 'MintB', symbol: 'Y', priceNative: 0.005, solAmount: 2 });
  chain = await chainFromJournal(state);
  stats = E.sessionStats(state, settings);
  match = AT.claimMatchesChain(
    { realizedPnlSol: stats.realizedPnlSol }, chain, settings.balanceStartSol, 1e-6
  );
  assert.equal(match.ok, true,
    `the chain replay must agree by construction; derived differs by ${match.diff} SOL`);

  // Actual tampering is still caught.
  const inflated = AT.claimMatchesChain(
    { realizedPnlSol: stats.realizedPnlSol + 5 }, chain, settings.balanceStartSol, 1e-6
  );
  assert.equal(inflated.ok, false, 'an edited claim must still be flagged');
});

test('D-03: replayChain books buy cost at the NET amount, like the engine', async () => {
  // Buy 1 gross (0.99 net after the 1% fee), sell all for 1.9602 net.
  const buyLink = await AT.appendFill(AT.GENESIS, {
    id: 'b', mint: 'MintA', side: 'buy', qty: 990, priceNative: 0.001,
    solGross: 1, solNet: 0.99, ts: 1,
  });
  const sellLink = await AT.appendFill(buyLink.hash, {
    id: 's', mint: 'MintA', side: 'sell', qty: 990, priceNative: 0.002,
    solGross: 1.98, solNet: 1.9602, ts: 2,
  });
  const replayed = AT.replayChain([buyLink, sellLink], 10);
  // Engine definition: net proceeds − net cost = 1.9602 − 0.99 = 0.9702.
  // The old gross-cost replay derived 0.9602 — off by the buy fee, so every
  // fee-paying wallet was branded tampered.
  assert.ok(Math.abs(replayed.realizedPnlSol - 0.9702) < 1e-9,
    `expected the net-cost realized 0.9702, got ${replayed.realizedPnlSol}`);
  // Cash still moves by the committed cash-basis amounts (gross out, net in).
  assert.ok(Math.abs(replayed.cashSol - (10 - 1 + 1.9602)) < 1e-9);
});

test('D-03: a mismatch renders as one coherent sentence', () => {
  assert.doesNotMatch(dashJs, /found · derived P&L differs by/,
    'the absurd "0 problems found · derived P&L differs by X SOL" line must be gone');
  const view = fnBlock(dashJs, 'function lbVerifyView(chain, stats)');
  assert.match(view, /every hash verifies, but the displayed realized P&L differs from the chain-derived result by/,
    'a value mismatch on an intact chain must say exactly that');
  assert.match(view, /found in the chain, and the P&L it derives differs from the displayed figure by/,
    'broken links plus a value mismatch must read as one sentence');
  assert.match(view, /found in the chain`/,
    'broken links alone must not drag in a P&L clause');
});

/* ---------------- D-01: the equity curve converges on equitySol ----------- */

test('D-01: the curve final point equals equitySol, open positions included', () => {
  const settings = wave2Settings();
  const state = E.defaultState(settings);
  const t0 = 1_700_000_000_000;

  E.buy(state, settings, { ts: t0, mint: 'MintA', symbol: 'A', priceNative: 0.001, solAmount: 1 });
  E.buy(state, settings, { ts: t0 + 1000, mint: 'MintB', symbol: 'B', priceNative: 0.002, solAmount: 2 });
  E.markPosition(state, 'MintA', 0.0015);
  E.sell(state, settings, { ts: t0 + 2000, mint: 'MintA', qtyFraction: 1, priceNative: 0.0015 });
  E.markPosition(state, 'MintB', 0.001); // open position, halved

  const pts = E.equityCurvePoints(state, settings.balanceStartSol, { now: t0 + 3000 });
  const last = pts[pts.length - 1].eq;
  assert.ok(Math.abs(last - E.equitySol(state)) < 1e-9,
    `the curve must land on equitySol; got ${last} vs ${E.equitySol(state)}`);

  // The old accumulation (sell pnlSol only, no buy-fee debit) floated above
  // true equity by exactly the cumulative buy fees.
  const buyFees = state.journal.filter((t) => t.side === 'buy').reduce((s, t) => s + t.feeSol, 0);
  const naive = settings.balanceStartSol
    + state.journal.filter((t) => t.side === 'sell').reduce((s, t) => s + t.pnlSol, 0)
    + Object.values(state.positions).reduce((s, p) => s + E.unrealizedPnl(p), 0);
  assert.ok(buyFees > 0, 'the scenario must actually pay buy fees');
  assert.ok(Math.abs((naive - last) - buyFees) < 1e-9,
    'the divergence being fixed is exactly the cumulative buy fees');

  // Fully closed: the curve ends on cash, which IS equity with nothing open.
  E.sell(state, settings, { ts: t0 + 4000, mint: 'MintB', qtyFraction: 1, priceNative: 0.001 });
  const flat = E.equityCurvePoints(state, settings.balanceStartSol, { now: t0 + 5000 });
  assert.ok(Math.abs(flat[flat.length - 1].eq - state.cashSol) < 1e-9,
    'with all positions closed the curve must end exactly on cash');
});

test('D-01: legacy buys without feeSol fall back to solGross − solNet', () => {
  const settings = wave2Settings();
  const state = E.defaultState(settings);
  const t0 = 1_700_000_000_000;
  E.buy(state, settings, { ts: t0, mint: 'MintA', symbol: 'A', priceNative: 0.001, solAmount: 1 });
  E.sell(state, settings, { ts: t0 + 1000, mint: 'MintA', qtyFraction: 1, priceNative: 0.002 });

  const withFee = E.equityCurvePoints(state, settings.balanceStartSol, { now: t0 + 2000 });
  for (const t of state.journal) if (t.side === 'buy') delete t.feeSol; // pre-feeSol journal
  const legacy = E.equityCurvePoints(state, settings.balanceStartSol, { now: t0 + 2000 });
  assert.ok(Math.abs(withFee[withFee.length - 1].eq - legacy[legacy.length - 1].eq) < 1e-9,
    'the solGross − solNet fallback must reproduce the same curve');
  assert.ok(Math.abs(legacy[legacy.length - 1].eq - state.cashSol) < 1e-9,
    'and still converge on equity');
});

test('D-01: the dashboard draws the engine curve, not its own walk', () => {
  const draw = fnBlock(dashJs, 'function drawEquityCurve()');
  assert.match(draw, /E\.equityCurvePoints\(state, start\)/,
    'the canvas must plot the fee-correct engine points');
  assert.doesNotMatch(draw, /pnl \+= \(t\.pnlSol \|\| 0\)/,
    'the old sell-only accumulation floated above equity by the buy fees');
});

/* ---------------- D-08: one percentage basis, open and closed ------------- */

test('D-08: open % uses the gross-invested basis; only the sell fee moves it at close', () => {
  const settings = wave2Settings(); // 1% per side
  const state = E.defaultState(settings);
  const t0 = 1_700_000_000_000;

  E.buy(state, settings, { ts: t0, mint: 'MintA', symbol: 'X', priceNative: 0.001, solAmount: 1 });
  const pos = state.positions.MintA;

  // Flat market: the position is worth its NET cost against a GROSS spend —
  // the buy fee is already a real 1% loss, exactly what a closed flat round
  // reports (minus the exit fee). The old pnl/costSol basis said 0%.
  const flatPct = E.positionPnlPct(pos);
  const expectedFlat = ((pos.qty * pos.lastPriceNative) / pos.investedSol - 1) * 100;
  assert.ok(Math.abs(flatPct - expectedFlat) < 1e-9);
  assert.ok(Math.abs(flatPct - (-settings.feeBps / 100)) < 1e-6,
    `a flat open position is down exactly the buy fee; got ${flatPct}%`);

  // A partial exit at an unchanged price must not move the percentage: the
  // surviving stack keeps its proportional gross basis.
  E.markPosition(state, 'MintA', 0.002);
  const beforePartial = E.positionPnlPct(pos);
  E.sell(state, settings, { ts: t0 + 1000, mint: 'MintA', qtyFraction: 0.5, priceNative: 0.002 });
  const afterPartial = E.positionPnlPct(pos);
  assert.ok(Math.abs(beforePartial - afterPartial) < 1e-9,
    'selling half at the same price must not change the remaining stack\'s %');

  // Full close at the same price: the % moves by the SELL fees alone — a
  // real cost — never by the ~2×feeBps accounting jump of the old bases.
  const beforeClose = E.positionPnlPct(pos);
  const { round } = E.sell(state, settings, { ts: t0 + 2000, mint: 'MintA', qtyFraction: 1, priceNative: 0.002 });
  const sellFees = state.journal.filter((t) => t.side === 'sell').reduce((s, t) => s + t.feeSol, 0);
  const expectedJump = (sellFees / round.investedSol) * 100;
  assert.ok(Math.abs((beforeClose - round.pnlPct) - expectedJump) < 1e-6,
    `the close must move the % by the sell fees only; open ${beforeClose}%, closed ${round.pnlPct}%`);
});

test('D-08: the dashboard open-positions % goes through the shared basis', () => {
  const open = fnBlock(dashJs, 'function renderOpenPositions()');
  assert.match(open, /E\.positionPnlPct\(p\)/,
    'the open % must come from the engine, on the gross-invested basis');
  assert.doesNotMatch(open, /pnl \/ p\.costSol/,
    'the net-of-fee denominator is what made the % jump ~2×feeBps at close');
});

/* ---------------- D-22: mutate-with-retry state writes -------------------- */

/** Run the SHIPPED mutateState against a scriptable storage stub. */
function mutateHarness(initialState) {
  const src = fnBlock(dashJs, 'async function mutateState(');
  const stored = { pt_state: initialState };
  const calls = { gets: 0, sets: 0 };
  let interfere = null;
  const store = {
    get: async () => {
      calls.gets += 1;
      if (interfere) interfere(calls.gets, stored);
      if (stored.pt_state === null) return null; // simulated unreadable storage
      return { pt_state: JSON.parse(JSON.stringify(stored.pt_state)) };
    },
    set: async (obj) => { calls.sets += 1; stored.pt_state = obj.pt_state; },
  };
  const sandbox = { store };
  vm.createContext(sandbox);
  vm.runInContext(
    `let storageReadFailed = false; let state = null;\n${src}\nthis.mutateState = mutateState; this.adopted = () => state;`,
    sandbox
  );
  return {
    mutate: (fn, retries) => sandbox.mutateState(fn, retries),
    adopted: () => sandbox.adopted(),
    stored, calls,
    setInterfere: (fn) => { interfere = fn; },
  };
}

test('D-22: a clean write reads fresh state, applies the mutation, bumps seq once', async () => {
  const h = mutateHarness({ seq: 5, rounds: [{ id: 'r1' }], journal: [], positions: {} });
  await h.mutate((fresh) => { fresh.rounds[0].note = { text: 'lesson', t: 1 }; });
  assert.equal(h.stored.pt_state.seq, 6, 'exactly one seq bump per write');
  assert.equal(h.stored.pt_state.rounds[0].note.text, 'lesson');
  assert.equal(h.adopted().seq, 6, 'the written state is adopted locally');
});

test('D-22: a concurrent seq bump triggers re-read and re-apply, not a lost write', async () => {
  const h = mutateHarness({ seq: 5, rounds: [{ id: 'r1' }], journal: [], positions: {} });
  // Between the base read (get #1) and the pre-write check (get #2), a
  // trading tab lands a fill: seq moves and a new round appears — exactly
  // the write the old blind read-modify-write would have destroyed.
  h.setInterfere((n, stored) => {
    if (n === 2) {
      stored.pt_state.seq = 6;
      stored.pt_state.rounds.unshift({ id: 'r2' });
    }
  });
  let applications = 0;
  await h.mutate((fresh) => {
    applications += 1;
    const target = fresh.rounds.find((r) => r.id === 'r1');
    target.note = { text: 'kept', t: 1 };
  });
  assert.equal(applications, 2, 'the mutation must be re-applied on the fresher state');
  assert.equal(h.stored.pt_state.seq, 7, 'written strictly above the concurrent write');
  assert.equal(h.stored.pt_state.rounds.length, 2, 'the concurrent fill survives');
  assert.equal(h.stored.pt_state.rounds.find((r) => r.id === 'r1').note.text, 'kept',
    'and the note survives WITH it — nobody loses');
});

test('D-22: retries are bounded and an unreadable read refuses to write', async () => {
  const contended = mutateHarness({ seq: 1, rounds: [], journal: [], positions: {} });
  contended.setInterfere((n, stored) => {
    if (n % 2 === 0) stored.pt_state.seq += 1; // every check sees a newer seq
  });
  await assert.rejects(
    () => contended.mutate((fresh) => { fresh.touched = true; }),
    /NOT saved/,
    'endless contention must surface, not spin forever'
  );
  assert.equal(contended.calls.sets, 0, 'nothing may be written under contention');

  const unreadable = mutateHarness(null);
  await assert.rejects(
    () => unreadable.mutate((fresh) => { fresh.touched = true; }),
    /unreadable/,
    'a failed read must refuse the write (D-15) — never fabricate and persist'
  );
});

test('D-22: the AI review write goes through the same retry path', () => {
  const review = fnBlock(dashJs, 'async function runReview(roundId)');
  assert.match(review, /await mutateState\(\(fresh\) => \{/,
    'the review annotation must be a retried mutation');
  assert.doesNotMatch(review, /await saveState\(\)/,
    'the blind read-modify-write saveState is gone');
});

/* ---------------- D-27/D-28: the fingerprint sees what matters ------------ */

/** Run the SHIPPED dataFingerprint against synthetic module state. */
function fingerprintOf(stateObj) {
  const src = fnBlock(dashJs, 'function dataFingerprint()');
  const sandbox = {
    state: stateObj, frames: [], replays: [], recordings: {}, settings: {},
    JSON, Number, Object,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${src}\nthis.fp = dataFingerprint();`, sandbox);
  return sandbox.fp;
}

function fpState(over) {
  return Object.assign({
    cashSol: 9,
    journal: [{ id: 't1' }],
    rounds: [{ id: 'r1' }],
    positions: { MintA: { mint: 'MintA', qty: 100, lastPriceNative: 0.001 } },
  }, over || {});
}

test('D-28: heartbeat price marks do not churn the fingerprint', () => {
  const a = fingerprintOf(fpState());
  const b = fingerprintOf(fpState({
    positions: { MintA: { mint: 'MintA', qty: 100, lastPriceNative: 0.002 } },
  }));
  assert.equal(a, b,
    'a live mark moves every 800 ms; including it rebuilt the visible table each second');

  const c = fingerprintOf(fpState({
    positions: { MintA: { mint: 'MintA', qty: 50, lastPriceNative: 0.001 } },
  }));
  assert.notEqual(a, c, 'a QUANTITY change is a real fill and must repaint');
});

test('D-27: in-place round mutations move the fingerprint', () => {
  const base = fingerprintOf(fpState());
  const cases = {
    aiReview: { id: 'r1', aiReview: { t: 123, text: 'x', ok: true } },
    note: { id: 'r1', note: { text: 'lesson', t: 124 } },
    thesis: { id: 'r1', thesis: { text: 'momentum', tags: ['momentum'] } },
    recordingFile: { id: 'r1', recordingFile: 'clip.webm' },
    recording: { id: 'r1', recording: { id: 'rec1' } },
  };
  for (const [field, round] of Object.entries(cases)) {
    const fp = fingerprintOf(fpState({ rounds: [round] }));
    assert.notEqual(fp, base,
      `a ${field} written in place must repaint — with D-13 fixed these writes land, but the dashboard never showed them`);
  }
});

test('D-28: live values update in place — no section rebuild on a price tick', () => {
  const live = fnBlock(dashJs, 'function updateOpenPositionMarks()');
  assert.match(live, /node\.textContent = /, 'live P&L is a text-node update');
  assert.doesNotMatch(live, /innerHTML/, 'the updater must never rebuild markup');

  const times = fnBlock(dashJs, 'function updateRelativeTimes()');
  assert.match(times, /dataset\.relTs/, 'relative labels refresh from their own timestamp');
  assert.doesNotMatch(times, /innerHTML/);

  const derived = fnBlock(dashJs, 'function refreshLiveDerived()');
  assert.match(derived, /renderSidebar\(\)/);
  assert.match(derived, /updateOpenPositionMarks\(\)/);
  assert.match(derived, /updateRelativeTimes\(\)/);

  const journal = fnBlock(dashJs, 'function renderJournal(el)');
  assert.match(journal, /data-rel-ts="\$\{Number\(t\.ts\) \|\| 0\}"/,
    'journal timestamps carry their ts so the label can refresh without a rebuild');
  const open = fnBlock(dashJs, 'function renderOpenPositions()');
  assert.match(open, /data-pos-row/, 'position rows are addressable for in-place updates');
  assert.match(open, /data-pos-pnl/, 'the live P&L node is addressable');
});

/* ---------------- D-20/D-34: per-section busy ----------------------------- */

test('D-20/D-34: busy is judged per section; an open note editor counts by presence', () => {
  const busy = fnBlock(dashJs, 'function isUserBusy()');
  assert.match(busy, /section && section\.contains\(active\)/,
    'a focused input only freezes the section that contains it (D-34)');
  assert.match(busy, /querySelector\('\.note-input'\)/,
    'an open note editor freezes rounds by DOM presence, focus or not (D-20)');
  assert.match(busy, /currentSection === 'rounds'/,
    'the editor check is scoped to the rounds section');
});

/* ---------------- D-17: the session review answer survives refreshes ------ */

test('D-17: the session review lives in module state and is re-injected on render', () => {
  const coach = fnBlock(dashJs, 'function renderCoach(el)');
  assert.match(coach, /sessionReview \? esc\(sessionReview\.text\) : ''/,
    'the staged coach markup must carry the stored answer — live-DOM-only writes were wiped');

  const helper = fnBlock(dashJs, 'function setSessionReview(text, error)');
  assert.match(helper, /sessionReview = \{ text, error: Boolean\(error\) \};/,
    'every stage of the review persists in module state');
  assert.match(helper, /renderSection\('coach'\)/,
    'the render path paints it, attached or not');

  const session = fnBlock(dashJs, 'async function runSessionReview()');
  assert.doesNotMatch(session, /out\.textContent/,
    'the answer must never be written into the live DOM alone');
});

/* ---------------- D-18: memoized chain verification ----------------------- */

test('D-18: verification is memoized by chain fingerprint and lands via re-render', () => {
  const keyFn = fnBlock(dashJs, 'function lbVerifyKey(chain, stats)');
  assert.match(keyFn, /chain\.length/, 'the fingerprint covers the length');
  assert.match(keyFn, /chain\[chain\.length - 1\]\.hash/,
    'and the head hash — each link commits to its predecessor, so head pins content');

  const bind = fnBlock(dashJs, 'async function bindLeaderboard(el)');
  assert.match(bind, /if \(lbVerifyCache && lbVerifyCache\.key === key\) return;/,
    'a cache hit must skip SHA-256 over the whole chain entirely');
  assert.match(bind, /lbVerifyInFlightKey === key\) return;/,
    'a verify already in flight for this chain must not be duplicated');
  assert.doesNotMatch(bind, /box\.innerHTML/,
    'the verdict must never be written into a possibly-detached node');
  assert.match(bind, /if \(currentSection === 'leaderboard'\) renderSection\('leaderboard'\);/,
    'the landing re-renders from the cache instead — the rebind cache hit stops recursion');

  const render = fnBlock(dashJs, 'function renderLeaderboard(el)');
  assert.match(render, /lbVerifyView\(chain, stats\)/,
    'the staged markup paints the memoized verdict synchronously, so "Checking…" never flickers back');
});

/* ---------------- D-19: settings save merges over a FRESH read ------------ */

test('D-19: save lays only form-controlled keys over freshly read settings', () => {
  const save = fnBlock(dashJs, 'async function saveFromForm()');
  assert.match(save, /await store\.get\(\['pt_settings'\]\)/,
    'the save must re-read pt_settings at save time — the module copy is frozen while the tab is open');
  assert.match(save, /E\.mergeSettings\(stored\.pt_settings\)/,
    'the fresh stored copy is the base');
  assert.match(save, /\{ \.\.\.freshSettings, \.\.\.gatherSettingsFromForm\(notes, freshSettings\) \}/,
    'only the form keys are laid over it');
  assert.match(save, /if \(stored === null\) \{/,
    'an unreadable read must refuse the save (D-15 discipline)');

  const gather = fnBlock(dashJs, 'function gatherSettingsFromForm(');
  assert.doesNotMatch(gather, /\.\.\.settings/,
    'gather spreading the stale module settings is what reverted every content-script write');
  for (const key of ['overlayWidth', 'overlayHeight', 'positionsBarLeft', 'positionsBarTop', 'positionsBarHidden', 'leaderboardIdentity']) {
    assert.ok(!gather.includes(key),
      `${key} is content-script/leaderboard state, not a form field — the form must not carry it`);
  }
});

/* ---------------- D-26: replay teardown ----------------------------------- */

test('D-26: emptying replays mid-playback stops the timer instead of looping TypeErrors', () => {
  const render = fnBlock(dashJs, 'function renderReplay(el)');
  const emptyBranch = render.slice(render.indexOf('if (!replays.length)'), render.indexOf('let replay ='));
  assert.match(emptyBranch, /stopReplayPlayback\(\);/,
    'the empty branch must stop frame playback before dropping the shell');
  assert.match(emptyBranch, /releaseReplayShell\(\);/,
    'and release the shell (which clears replayTimer and the video-sync rAF)');

  const toggle = fnBlock(dashJs, 'function toggleReplayPlayback()');
  assert.match(toggle, /const replay = currentReplay\(\);\s*\n\s*if \(!replay\) \{ stopReplayPlayback\(\); return; \}/,
    'the 1.1 s tick must stop itself when the current replay has vanished');

  const build = fnBlock(dashJs, 'function buildReplayView(replay)');
  assert.match(build, /if \(!replay\) \{/,
    'a missing replay degrades to an empty view, never a TypeError');
});

test("D-12: the replay shell identity covers the round outcome and session count", () => {
  const dash = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'dashboard.js'), 'utf8');
  const fnStart = dash.indexOf("function renderReplay(");
  const block = dash.slice(fnStart, dash.indexOf("\nfunction buildReplayView", fnStart));
  assert.match(block, /replay\.status/,
    "a round closing while the user watches must rebuild the hero (it showed OPEN forever)");
  assert.match(block, /replays\.length/,
    "a new session must be able to appear in the list");
  assert.doesNotMatch(block, /replayShell\.sessionId !== replay\.sessionId\) \{/,
    "the old sessionId-only reuse condition must be gone");
});
