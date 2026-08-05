/* "The After" (post-exit truth) and Guardrails (training wheels).
 *
 * The After: when a round closes, the coin stays on a bounded watch and the
 * OBSERVED extremes are recorded onto the round. Doctrine under test: a watch
 * that saw nothing records nothing; sample counts are stored; nothing is
 * interpolated or invented.
 *
 * Guardrails: pure decision function for the three rules every surviving
 * trader eventually adopts — tilt breaker, size cap, daily loss limit — all
 * opt-in and enforced at buy time with an honest message.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

global.window = global.window || {};
const E = require('../engine.js');

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const T0 = 1_800_000_000_000;

function settingsWith(over) {
  return Object.assign(E.defaultSettings(), over || {});
}

/** A wallet with one full round trip closed at T0 (buy 0.001 → sell 0.002). */
function closedRoundState(over) {
  const settings = settingsWith(over);
  const state = E.defaultState(settings);
  E.buy(state, settings, { ts: T0 - 60_000, mint: MINT, symbol: 'BONK', site: 'padre', solAmount: 1, priceNative: 0.001, priceUsd: 0.2 });
  const { round } = E.sell(state, settings, { ts: T0, mint: MINT, site: 'padre', qtyFraction: 1, priceNative: 0.002, priceUsd: 0.4 });
  return { state, settings, round };
}

/* ---------------- The After ---------------- */

test('closing a round begins a post-exit watch at the effective exit price', () => {
  const { state } = closedRoundState();
  assert.equal(state.postWatch.length, 1);
  assert.equal(state.postWatch[0].mint, MINT);
  // slippageBps is 0 in defaults, so the effective exit price is the tick.
  assert.equal(state.postWatch[0].exitPriceNative, 0.002);
  assert.equal(state.postWatch[0].samples, 0);
});

test('the watch respects the opt-out', () => {
  const { state } = closedRoundState({ postExitWatchEnabled: false });
  assert.ok(!state.postWatch || state.postWatch.length === 0,
    'no watch when the setting is off');
});

test('observed extremes are recorded; out-of-window samples are refused', () => {
  const { state } = closedRoundState();
  assert.equal(E.notePostExitPrice(state, MINT, 0.004, T0 + 10 * 60_000), true);
  assert.equal(E.notePostExitPrice(state, MINT, 0.0012, T0 + 20 * 60_000), true);
  assert.equal(E.notePostExitPrice(state, MINT, 9.9, T0 + 2 * 60 * 60_000), false,
    'a sample after the window must be refused');
  assert.equal(E.notePostExitPrice(state, 'SomeOtherMint1111111111111111111111111111', 5, T0 + 60_000), false,
    'a different mint never touches the watch');
  const w = state.postWatch[0];
  assert.equal(w.maxPriceNative, 0.004);
  assert.equal(w.minPriceNative, 0.0012);
  assert.equal(w.samples, 2);
});

test('finalize moves observed truth onto the round, with honest percentages', () => {
  const { state, round } = closedRoundState();
  E.notePostExitPrice(state, MINT, 0.004, T0 + 10 * 60_000); // +100% after exit
  E.notePostExitPrice(state, MINT, 0.001, T0 + 30 * 60_000); // -50% after exit
  assert.equal(E.finalizePostWatches(state, T0 + 30 * 60_000), 0,
    'nothing finalizes while the window is still open');
  assert.equal(E.finalizePostWatches(state, T0 + E.POST_WATCH_WINDOW_MS + 1), 1);

  const done = state.rounds.find((r) => r.id === round.id);
  assert.ok(done.afterExit, 'the observed truth lands on the round');
  assert.ok(Math.abs(done.afterExit.maxPct - 100) < 1e-9);
  assert.ok(Math.abs(done.afterExit.minPct - (-50)) < 1e-9);
  assert.equal(done.afterExit.samples, 2);
  assert.equal(state.postWatch.length, 0, 'the finished watch leaves the list');
});

test('a watch that observed nothing records nothing — an honest gap, not a guess', () => {
  const { state, round } = closedRoundState();
  assert.equal(E.finalizePostWatches(state, T0 + E.POST_WATCH_WINDOW_MS + 1), 0);
  const done = state.rounds.find((r) => r.id === round.id);
  assert.equal(done.afterExit, undefined, 'no samples means no afterExit field at all');
  assert.equal(state.postWatch.length, 0);
});

test('postWatchMints lists only live watches', () => {
  const { state } = closedRoundState();
  assert.deepEqual(E.postWatchMints(state, T0 + 60_000), [MINT]);
  assert.deepEqual(E.postWatchMints(state, T0 + E.POST_WATCH_WINDOW_MS + 1), []);
});

/* ---------------- Guardrails ---------------- */

function lossRounds(n, lastClosedAt) {
  const rounds = [];
  for (let i = 0; i < n; i++) {
    rounds.push({ id: 'L' + i, mint: MINT, pnlSol: -0.2, closedAt: lastClosedAt - i * 60_000, investedSol: 1 });
  }
  return rounds;
}

test('tilt guard pauses after N straight losses, then lets go after the cooldown', () => {
  const settings = settingsWith({ guardTiltEnabled: true, guardTiltLosses: 4, guardTiltMinutes: 10 });
  const state = E.defaultState(settings);
  state.rounds = lossRounds(4, T0);

  const blocked = E.guardCheck(state, settings, { solAmount: 1, now: T0 + 2 * 60_000 });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'tilt');
  assert.ok(blocked.remainingMs > 0 && blocked.remainingMs <= 8 * 60_000);
  assert.match(blocked.message, /Tilt guard/);

  assert.equal(E.guardCheck(state, settings, { solAmount: 1, now: T0 + 11 * 60_000 }).ok, true,
    'the cooldown ends');
  state.rounds = lossRounds(3, T0).concat([{ id: 'W', mint: MINT, pnlSol: 0.5, closedAt: T0 - 10 }]);
  assert.equal(E.guardCheck(state, settings, { solAmount: 1, now: T0 + 60_000 }).ok, true,
    'three losses is not four');
  assert.equal(E.guardCheck(state, settingsWith({}), { solAmount: 1, now: T0 + 60_000 }).ok, true,
    'off by default');
});

test('size guard caps a single buy as a share of current equity', () => {
  const settings = settingsWith({ guardMaxPositionPct: 20 });
  const state = E.defaultState(settings); // 10 SOL cash, no positions → equity 10
  const over = E.guardCheck(state, settings, { solAmount: 3, now: T0 });
  assert.equal(over.ok, false);
  assert.equal(over.reason, 'size');
  assert.equal(E.guardCheck(state, settings, { solAmount: 1.9, now: T0 }).ok, true);
  assert.equal(E.guardCheck(state, settingsWith({}), { solAmount: 9, now: T0 }).ok, true, 'off when unset');
});

test('daily loss guard ends the day at the limit the trader set', () => {
  const settings = settingsWith({ guardDailyLossSol: 1 });
  const state = E.defaultState(settings);
  const todayNoon = (() => { const d = new Date(T0); d.setHours(12, 0, 0, 0); return d.getTime(); })();
  state.journal = [
    { side: 'sell', ts: todayNoon, pnlSol: -0.6 },
    { side: 'sell', ts: todayNoon + 60_000, pnlSol: -0.5 },
  ];
  const blocked = E.guardCheck(state, settings, { solAmount: 0.5, now: todayNoon + 120_000 });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'dailyLoss');

  // Yesterday's losses never count against today.
  state.journal = [{ side: 'sell', ts: todayNoon - 24 * 60 * 60_000, pnlSol: -5 }];
  assert.equal(E.guardCheck(state, settings, { solAmount: 0.5, now: todayNoon }).ok, true);
});

test('guards are wired into both buy paths in the overlay', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const content = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
  const reqStart = content.indexOf('function requestBuy(');
  const reqBlock = content.slice(reqStart, content.indexOf('\n  }', reqStart) + 4);
  assert.match(reqBlock, /E\.guardCheck\(state, settings/, 'panel buys must pass the guard');
  const rowStart = content.indexOf('async function doRowBuy(');
  const rowBlock = content.slice(rowStart, content.indexOf('\n  }', rowStart) + 4);
  assert.match(rowBlock, /E\.guardCheck\(state, settings/, 'chip buys must pass the guard');
  // The After wiring: watches ride the bar poll and the live tick path.
  assert.match(content, /E\.postWatchMints\(state\)/, 'the bar poll must include watch mints');
  assert.match(content, /E\.notePostExitPrice\(state, mint, quote\.priceNative, now\)/,
    'batch results must feed the watches');
  assert.match(content, /E\.finalizePostWatches\(state/, 'expired watches must settle');
});

test("the dashboard surfaces The After and the Guardrails honestly", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const dash = fs.readFileSync(path.join(__dirname, "..", "dashboard.js"), "utf8");

  // Rounds table: an After column driven by observed data, an em-dash or
  // watching state otherwise — never a fabricated number.
  assert.match(dash, /function renderAfterCell\(/);
  assert.match(dash, /After \(1h\)/, "the rounds table must carry the After column");
  assert.match(dash, /watching…/, "a live watch shows as watching, not as a number");

  // Discipline aggregate uses the MEDIAN so one outlier cannot flatter or
  // shame the record, and it needs at least 3 observed rounds.
  assert.match(dash, /function renderAfterAggregate\(/);
  assert.match(dash, /observed\.length < 3/, "no aggregate from fewer than 3 observations");
  assert.match(dash, /Dumps dodged/);

  // Guardrails settings card + gathered keys with engine-mirroring bounds.
  assert.match(dash, /Guardrails \(training wheels\)/);
  for (const id of ["set-guard-tilt", "set-guard-tilt-losses", "set-guard-tilt-minutes", "set-guard-max-pct", "set-guard-daily-loss", "set-post-exit-watch"]) {
    assert.ok(dash.includes(`id="${id}"`), `${id} must exist in settings`);
  }
  assert.match(dash, /guardTiltEnabled: document\.getElementById/);
  assert.match(dash, /postExitWatchEnabled: document\.getElementById/);
});
