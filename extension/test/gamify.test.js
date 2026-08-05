/* Gamification derived from the journal (docs/GAMIFY.md as code).
 *
 * The doctrine under test: discipline is the loop, never volume, never luck.
 * A red round can grade S; a lucky win can grade F; a thesisless round can
 * never out-grade a C; reps diminish per day so grinding cannot game them;
 * and no function here mutates the state it reads.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const G = require('../gamify.js');

const MINT_A = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const MINT_B = 'MfDuWeqSHEqTFVYZ7LoexgAK9dxk7cy4DFJWjWMGVWa';

const THESIS = { text: 'breakout continuation', tags: [], plan: 'scalp', conviction: 3, targetPct: 50, stopPct: 30, at: 1 };

let seq = 0;
/** A closed round with engine-shaped fields. Chronological helpers below. */
function mkRound(opts = {}) {
  seq += 1;
  const investedSol = opts.investedSol ?? 1;
  const pnlSol = opts.pnlSol ?? 0.1;
  const closedAt = opts.closedAt ?? (1_800_000_000_000 + seq * 300_000);
  const heldMs = opts.heldMs ?? 60_000;
  return {
    id: 'r' + seq,
    mint: opts.mint || MINT_A,
    symbol: 'TEST',
    openedAt: opts.openedAt ?? (closedAt - heldMs),
    closedAt,
    heldMs,
    investedSol,
    returnedSol: investedSol + pnlSol,
    pnlSol,
    pnlPct: investedSol > 0 ? (pnlSol / investedSol) * 100 : 0,
    peakPnlSol: opts.peakPnlSol ?? Math.max(0, pnlSol),
    troughPnlSol: opts.troughPnlSol ?? Math.min(0, pnlSol),
    thesis: 'thesis' in opts ? opts.thesis : THESIS,
  };
}

/** State whose rounds arrive chronological; stored newest-first like the engine. */
function state(chronologicalRounds) {
  return { rounds: chronologicalRounds.slice().reverse(), journal: [], positions: {}, cashSol: 10 };
}

/* ---------------- round grades ---------------- */

test('a disciplined red round grades S — process, not P&L', () => {
  // Never went green, stop never breached, thesis written, size normal.
  const r = mkRound({ pnlSol: -0.2, peakPnlSol: 0, troughPnlSol: -0.25 });
  const grade = G.roundGrade(state([r]), r);
  assert.equal(grade.letter, 'S');
  assert.equal(grade.luckyWin, false);
  assert.equal(grade.parts.length, 0, 'no deductions: the loss followed the plan');
});

test('a lucky win grades F when it is revenge with no plan', () => {
  const loss = mkRound({ mint: MINT_B, pnlSol: -0.4, peakPnlSol: 0, troughPnlSol: -0.4, closedAt: 1_800_000_000_000 });
  const win = mkRound({
    mint: MINT_B,
    thesis: null,
    investedSol: 2,             // 2x the losing stake, minutes later
    openedAt: 1_800_000_000_000 + 4 * 60 * 1000,
    closedAt: 1_800_000_000_000 + 6 * 60 * 1000,
    pnlSol: 0.9,
    peakPnlSol: 0.9,
  });
  const grade = G.roundGrade(state([loss, win]), win);
  assert.equal(grade.letter, 'F', 'green P&L, F process');
  assert.equal(grade.luckyWin, true);
  assert.ok(grade.parts.some((p) => p.id === 'revenge'));
  assert.ok(grade.parts.some((p) => p.id === 'no-thesis'));
});

test('no thesis caps the grade at C even with a perfect exit', () => {
  const r = mkRound({ thesis: null, pnlSol: 0.9, peakPnlSol: 1.0 }); // 90% captured
  const grade = G.roundGrade(state([r]), r);
  assert.equal(grade.letter, 'C');
  assert.ok(grade.score <= 67);
});

test('breaking the written plan is penalized even on a green exit', () => {
  // Target 50% was reached in-trade (peak 60%), exit banked only 20%.
  const r = mkRound({ pnlSol: 0.2, peakPnlSol: 0.6 });
  const grade = G.roundGrade(state([r]), r);
  assert.ok(grade.parts.some((p) => p.id === 'plan-broken'));
  assert.ok(grade.parts.some((p) => p.id === 'exit-early'));
  assert.equal(grade.luckyWin, true, 'a win on a broken plan is lucky, and says so');
  assert.equal(grade.letter, 'C');
});

test('an outsized stake versus the trailing normal is a deduction', () => {
  const priors = Array.from({ length: 5 }, () => mkRound({ pnlSol: 0.05, peakPnlSol: 0.06 }));
  const big = mkRound({ investedSol: 3, pnlSol: -0.1, peakPnlSol: 0, troughPnlSol: -0.1 });
  const grade = G.roundGrade(state([...priors, big]), big);
  assert.ok(grade.parts.some((p) => p.id === 'outsized'));
});

/* ---------------- streaks ---------------- */

test('discipline streaks count and break honestly', () => {
  const rounds = [
    mkRound({}),                                     // thesis ok, clean
    mkRound({}),                                     // thesis ok, clean
    mkRound({ thesis: null }),                       // breaks the journal streak
    mkRound({ pnlSol: -0.1, peakPnlSol: 0.2, troughPnlSol: -0.1 }), // round-tripped
    mkRound({}),
  ];
  const st = G.streaks(state(rounds));
  assert.equal(st.journal.best, 2);
  assert.equal(st.journal.current, 2, 'the two rounds after the gap');
  assert.equal(st.cleanExit.best, 3);
  assert.equal(st.cleanExit.current, 1, 'reset by the round-trip, rebuilt once');
  assert.equal(st.noRevenge.current, 5, 'no revenge anywhere');
});

/* ---------------- Trench Rank ---------------- */

test('rank tiers gate on the graduation criteria and report progress', () => {
  assert.equal(G.rank(state([])).tier, 0);
  assert.equal(G.rank(state([])).name, 'Fresh Meat');

  const five = Array.from({ length: 5 }, () => mkRound({}));
  const r5 = G.rank(state(five));
  assert.equal(r5.tier, 0);
  const gate = r5.next.requirements.find((g) => g.label.indexOf('10+') === 0);
  assert.ok(Math.abs(gate.progress - 0.5) < 1e-9, 'five of ten rounds is half a gate');

  // Ten thesis-carrying rounds with wins outweighing losses: Journaler,
  // not yet Survivor (needs 25).
  const ten = Array.from({ length: 10 }, (_, i) => mkRound({
    pnlSol: i % 3 === 0 ? -0.1 : 0.3,
    peakPnlSol: i % 3 === 0 ? 0 : 0.3,
    troughPnlSol: i % 3 === 0 ? -0.1 : 0,
  }));
  const r10 = G.rank(state(ten));
  assert.equal(r10.tier, 1);
  assert.equal(r10.name, 'Journaler');
  assert.equal(r10.next.name, 'Survivor');
});

/* ---------------- reps ---------------- */

test('reps diminish per day: full to 10, half to 20, zero past 20', () => {
  const base = new Date(2026, 7, 5, 9, 0, 0).getTime(); // one local day
  const rounds = Array.from({ length: 22 }, (_, i) => mkRound({
    mint: i % 2 ? MINT_A : MINT_B,
    pnlSol: -0.01,
    peakPnlSol: 0,
    troughPnlSol: -0.01,
    openedAt: base + i * 60_000,
    closedAt: base + i * 60_000 + 30_000,
  }));
  const rep = G.reps(state(rounds), base + 23 * 60_000);
  // All rounds grade S (disciplined reds): 10 x 1.5 + 10 x 0.75 + 2 x 0.
  assert.ok(Math.abs(rep.total - 22.5) < 1e-9, `expected 22.5 rep points, got ${rep.total}`);
  assert.equal(rep.today.count, 22);
  assert.equal(rep.today.capped, true);
  assert.equal(rep.level, Math.floor(Math.sqrt(22.5 / 3)));
});

/* ---------------- badges ---------------- */

test('badges date what the journal can date, and exclude luck by design', () => {
  const first = mkRound({ pnlSol: 0.1, peakPnlSol: 0.2 }); // 50% captured: no sniper
  const sniper = mkRound({ pnlSol: 0.85, peakPnlSol: 1.0 }); // 85% captured
  const list = G.badges(state([first, sniper]));
  const byId = Object.fromEntries(list.map((b) => [b.id, b]));

  assert.equal(byId['first-thesis'].earned, true);
  assert.equal(byId['first-thesis'].earnedAt, first.closedAt);
  assert.equal(byId['sniper'].earned, true);
  assert.equal(byId['sniper'].earnedAt, sniper.closedAt);
  assert.equal(byId['fifty-club'].earned, false);
  // Doctrine: no profit/win-streak/volume badges exist to earn.
  assert.ok(!list.some((b) => /profit|win/i.test(b.id)));
});

/* ---------------- drills ---------------- */

test('the daily drill is deterministic for a day and measures honestly', () => {
  const now = new Date(2026, 7, 5, 12, 0, 0).getTime();
  const a = G.drills(state([]), now);
  const b = G.drills(state([]), now);
  assert.equal(a.id, b.id, 'same day, same drill');
  assert.equal(a.roundsToday, 0);
  assert.equal(a.done, false, 'an empty day completes nothing');

  // Find the next capture-day and satisfy it with three >=50% captures.
  let day = new Date(2026, 7, 5, 12, 0, 0);
  while (G.drills(state([]), day.getTime()).id !== 'capture-day') {
    day = new Date(day.getTime() + 24 * 60 * 60 * 1000);
  }
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9).getTime();
  const rounds = Array.from({ length: 3 }, (_, i) => mkRound({
    pnlSol: 0.6, peakPnlSol: 1.0, // 60% captured
    openedAt: dayStart + i * 600_000,
    closedAt: dayStart + i * 600_000 + 300_000,
  }));
  const done = G.drills(state(rounds), day.getTime());
  assert.equal(done.id, 'capture-day');
  assert.equal(done.done, true);
  assert.equal(done.progress, 3);
});

/* ---------------- purity ---------------- */

test('gamify never mutates the state it reads', () => {
  const rounds = [
    mkRound({}),
    mkRound({ thesis: null, pnlSol: -0.2, peakPnlSol: 0.3, troughPnlSol: -0.2 }),
  ];
  const s = state(rounds);
  const before = JSON.stringify(s);
  G.roundGrade(s, s.rounds[0]);
  G.streaks(s);
  G.rank(s);
  G.reps(s, Date.now());
  G.badges(s);
  G.drills(s, Date.now());
  assert.equal(JSON.stringify(s), before, 'derived means derived');
});
