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
  // Wave-1 de-jargon: the card is titled plainly now.
  assert.match(dash, /<h3>Guardrails<\/h3>/);
  for (const id of ["set-guard-tilt", "set-guard-tilt-losses", "set-guard-tilt-minutes", "set-guard-max-pct", "set-guard-daily-loss", "set-post-exit-watch"]) {
    assert.ok(dash.includes(`id="${id}"`), `${id} must exist in settings`);
  }
  assert.match(dash, /guardTiltEnabled: document\.getElementById/);
  assert.match(dash, /postExitWatchEnabled: document\.getElementById/);
});

/* ---------------- Fees & costs emulation (gas + tip) ----------------
 *
 * Real fills cost a platform %, PLUS flat per-transaction gas and tip — and
 * on small entries the flat costs dominate. The model under test: flat costs
 * join the cost basis on buys and reduce net proceeds on sells, so per-sell
 * P&L, rounds, the calendar, the equity identity, and the attest chain all
 * account for them with no special cases.
 */

test("buys debit amount + flat costs; the tokens bought are unchanged", () => {
  const settings = settingsWith({ gasSolPerTx: 0.001, tipSolPerTx: 0.002 });
  const state = E.defaultState(settings);
  const { trade } = E.buy(state, settings, { ts: T0, mint: MINT, symbol: "B", site: "padre", solAmount: 1, priceNative: 0.001 });

  assert.ok(Math.abs(state.cashSol - (10 - 1.003)) < 1e-12, "cash pays amount + gas + tip");
  assert.ok(Math.abs(trade.qty - (0.99 / 0.001)) < 1e-9, "flat costs buy no tokens (qty from net swap only)");
  assert.equal(trade.txCostSol, 0.003);
  const pos = state.positions[MINT];
  assert.ok(Math.abs(pos.costSol - 0.993) < 1e-12, "cost basis = net + flat");
  assert.ok(Math.abs(state.stats.feesPaidSol - 0.013) < 1e-12, "fees paid = platform fee + flat");
});

test("insufficient balance counts the flat costs and says so", () => {
  const settings = settingsWith({ gasSolPerTx: 0.05, tipSolPerTx: 0.05 });
  const state = E.defaultState(settings); // 10 SOL
  assert.throws(() => E.buy(state, settings, { ts: T0, mint: MINT, solAmount: 9.95, priceNative: 0.001 }),
    /tx costs/, "the refusal must name the tx costs");
});

test("a dust sell can net NEGATIVE — you paid gas to exit a worthless bag", () => {
  const settings = settingsWith({ gasSolPerTx: 0.001, tipSolPerTx: 0 });
  const state = E.defaultState(settings);
  E.buy(state, settings, { ts: T0, mint: MINT, symbol: "B", site: "padre", solAmount: 0.1, priceNative: 0.001 });
  const cashBefore = state.cashSol;
  // Price collapses 1000x; selling the bag grosses ~0.0001 SOL, gas is 0.001.
  const { trade } = E.sell(state, settings, { ts: T0 + 1000, mint: MINT, qtyFraction: 1, priceNative: 0.000001 });
  assert.ok(trade.solNet < 0, "net proceeds below zero are the honest outcome");
  assert.ok(state.cashSol < cashBefore, "cash goes DOWN on the exit");
});

test("the equity identity holds exactly with costs on", () => {
  const settings = settingsWith({ gasSolPerTx: 0.0015, tipSolPerTx: 0.001, feeBps: 100 });
  const state = E.defaultState(settings);
  E.buy(state, settings, { ts: T0, mint: MINT, symbol: "B", site: "padre", solAmount: 1, priceNative: 0.001 });
  E.sell(state, settings, { ts: T0 + 60_000, mint: MINT, qtyFraction: 0.5, priceNative: 0.002 });
  E.buy(state, settings, { ts: T0 + 120_000, mint: MINT, symbol: "B", site: "padre", solAmount: 0.5, priceNative: 0.0018 });
  E.markPosition(state, MINT, 0.0021, null);

  const pts = E.equityCurvePoints(state, settings.balanceStartSol, { now: T0 + 180_000 });
  const eq = E.equitySol(state);
  assert.ok(Math.abs(pts[pts.length - 1].eq - eq) < 1e-9,
    "the curve final point must equal equity EXACTLY, flats included");
});

test("the attest chain replay agrees with the engine when costs are on", async () => {
  const AT = require("../attest.js");
  const settings = settingsWith({ gasSolPerTx: 0.002, tipSolPerTx: 0.001, feeBps: 100 });
  const state = E.defaultState(settings);
  const b = E.buy(state, settings, { ts: T0, mint: MINT, symbol: "B", site: "padre", solAmount: 1, priceNative: 0.001 });
  const s = E.sell(state, settings, { ts: T0 + 60_000, mint: MINT, qtyFraction: 1, priceNative: 0.002 });

  let prev = AT.GENESIS;
  const chain = [];
  for (const trade of [b.trade, s.trade]) {
    const link = await AT.appendFill(prev, trade);
    link.seq = chain.length;
    chain.push(link);
    prev = link.hash;
  }
  const replay = AT.replayChain(chain);
  assert.ok(Math.abs(replay.realizedPnlSol - state.stats.realizedPnlSol) < 1e-9,
    "chain-derived realized P&L must match the engine accumulator, flats included");
});

test("the Fees & costs card exists with honest copy and gathered keys", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const dash = fs.readFileSync(path.join(__dirname, "..", "dashboard.js"), "utf8");
  assert.match(dash, /Fees &amp; costs/);
  for (const id of ["set-fee", "set-gas", "set-tip", "set-slippage", "set-fee-preset"]) {
    assert.ok(dash.includes(`id="${id}"`), `${id} must exist`);
  }
  assert.match(dash, /gasSolPerTx: \(\(\) =>/, "gas must be gathered with validation");
  assert.match(dash, /tipSolPerTx: \(\(\) =>/, "tip must be gathered with validation");
  assert.match(dash, /never storage — Save still/i, "presets fill fields, never storage");
});
