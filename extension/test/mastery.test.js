/* Mastery statistics and the graduation bar (docs/GRADUATION.md as code).
 *
 * The doctrine under test: never fabricate a verdict. Where the journal
 * cannot support a criterion, the answer is 'unknown' — not a silent pass and
 * not a guess. And the numbers themselves must be exactly what the doc says
 * they are: expectancy that survives removing the best round, hold symmetry,
 * revenge detection, and sizing discipline through a cold streak.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const M = require('../mastery.js');

const MINT_A = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const MINT_B = 'MfDuWeqSHEqTFVYZ7LoexgAK9dxk7cy4DFJWjWMGVWa';

/** Build a closed round. Storage order is newest-first, like the engine's. */
function round(pnlSol, opts = {}) {
  return {
    id: 'r' + Math.abs(pnlSol) + (opts.mint || MINT_A) + (opts.closedAt || 0),
    mint: opts.mint || MINT_A,
    pnlSol,
    heldMs: opts.heldMs ?? 60_000,
    investedSol: opts.investedSol ?? 1,
    openedAt: (opts.closedAt ?? 1_800_000_000_000) - (opts.heldMs ?? 60_000),
    closedAt: opts.closedAt ?? 1_800_000_000_000,
    thesis: 'thesis' in opts ? opts.thesis : 'a plan',
  };
}

function state(rounds, journal = []) {
  return { rounds, journal, positions: {}, cashSol: 10, stats: {} };
}

test('expectancy must survive removing the best round', () => {
  // Nine small losers carried by one moonshot: mean is positive, but the
  // edge IS the outlier — the doc says cover it with your hand.
  const rounds = [round(9.1), ...Array.from({ length: 9 }, () => round(-1))];
  const g = M.graduation(state(rounds));
  const exp = g.criteria.find((c) => c.id === 'expectancy');
  assert.equal(exp.status, 'fail', 'outlier-carried expectancy must not pass');

  const honest = [round(0.5), round(0.4), round(-0.2), round(0.6), round(-0.3)];
  const g2 = M.graduation(state(honest));
  assert.equal(g2.criteria.find((c) => c.id === 'expectancy').status, 'pass');
});

test('hold symmetry flags watering weeds', () => {
  const rounds = [
    round(0.5, { heldMs: 30_000 }), round(0.4, { heldMs: 30_000 }),
    round(-0.5, { heldMs: 600_000 }), round(-0.4, { heldMs: 500_000 }),
  ];
  const s = M.stats(state(rounds));
  assert.ok(s.holdRatio > M.HOLD_SYMMETRY_MAX, 'losers held 15x longer must exceed the bar');
  const g = M.graduation(state(rounds));
  assert.equal(g.criteria.find((c) => c.id === 'holdSymmetry').status, 'fail');
});

test('revenge detection: same mint, minutes later, sized up', () => {
  const closedAt = 1_800_000_000_000;
  const rounds = [round(-1, { mint: MINT_A, closedAt, investedSol: 1 })];
  const revengeBuy = { side: 'buy', mint: MINT_A, ts: closedAt + 120_000, solGross: 2 };
  const calmBuy = { side: 'buy', mint: MINT_A, ts: closedAt + 120_000, solGross: 1 };
  const otherCoin = { side: 'buy', mint: MINT_B, ts: closedAt + 120_000, solGross: 5 };
  const nextDay = { side: 'buy', mint: MINT_A, ts: closedAt + 86_400_000, solGross: 5 };

  assert.equal(M.stats(state(rounds, [revengeBuy])).revengeCount, 1, 'the classic pattern must be caught');
  assert.equal(M.stats(state(rounds, [calmBuy])).revengeCount, 0, 'same size is a re-entry, not revenge');
  assert.equal(M.stats(state(rounds, [otherCoin])).revengeCount, 0, 'a different coin is not revenge');
  assert.equal(M.stats(state(rounds, [nextDay])).revengeCount, 0, 'outside the window is not revenge');
});

test('cold streak: discipline means no tilt-sizing through the losses', () => {
  // Newest-first storage; the streak sits in the middle, sized like normal.
  const disciplined = [
    round(0.5, { closedAt: 9 }),
    round(-0.3, { closedAt: 8, investedSol: 1 }),
    round(-0.4, { closedAt: 7, investedSol: 1 }),
    round(-0.2, { closedAt: 6, investedSol: 1.1 }),
    round(0.6, { closedAt: 5 }),
    round(0.2, { closedAt: 4 }),
  ];
  const s = M.stats(state(disciplined));
  assert.equal(s.coldStreak.length, 3);
  assert.equal(s.coldStreak.disciplined, true);

  const tilted = disciplined.map((r) => ({ ...r }));
  tilted[1].investedSol = 4; // doubled down inside the streak
  assert.equal(M.stats(state(tilted)).coldStreak.disciplined, false,
    'sizing up inside the streak is exactly the failure the criterion exists for');
});

test('unknown is not a pass: missing evidence never graduates anyone', () => {
  // A fresh wallet: no rounds at all.
  const g = M.graduation(state([]));
  assert.equal(g.overall, false);
  for (const c of g.criteria) {
    assert.notEqual(c.status, 'pass', `${c.id} must not pass on an empty journal`);
  }

  // Rounds whose schema never carried a thesis: the criterion must say
  // unknown, not fail everyone silently (and not pass them either).
  const bare = Array.from({ length: 60 }, (_, i) => {
    const r = round(i % 3 === 0 ? -0.1 : 0.2, { closedAt: 2_000_000_000 - i });
    delete r.thesis;
    return r;
  });
  const g2 = M.graduation(state(bare));
  assert.equal(g2.criteria.find((c) => c.id === 'thesis').status, 'unknown');
  assert.equal(g2.overall, false, 'unknown blocks graduation');
});

test('a genuinely qualifying journal graduates', () => {
  // 60 rounds, modest edge, symmetric holds, disciplined streaks, theses.
  const rounds = [];
  for (let i = 0; i < 60; i++) {
    const losing = i % 3 === 0; // every third round loses, smaller than wins
    rounds.push(round(losing ? -0.2 : 0.35, {
      closedAt: 2_000_000_000_000 - i * 3_600_000,
      heldMs: losing ? 80_000 : 70_000,
      investedSol: 1,
    }));
  }
  const g = M.graduation(state(rounds));
  const failing = g.criteria.filter((c) => c.status !== 'pass');
  // The cold-streak criterion may be unknown if the pattern above never
  // produced 3 consecutive losses — every third round loses, so streaks are
  // length 1 and adversity is genuinely untested. Verify precisely that.
  assert.deepEqual(failing.map((c) => c.id), ['coldStreak'],
    'only the untested-adversity criterion may hold this journal back');
  assert.equal(failing[0].status, 'unknown');

  // Give them a real, disciplined cold streak and they clear the whole bar.
  const withStreak = rounds.map((r) => ({ ...r }));
  withStreak[10] = round(-0.2, { closedAt: withStreak[10].closedAt, investedSol: 1 });
  withStreak[11] = round(-0.2, { closedAt: withStreak[11].closedAt, investedSol: 1 });
  withStreak[12] = round(-0.2, { closedAt: withStreak[12].closedAt, investedSol: 1 });
  const g2 = M.graduation(state(withStreak));
  assert.equal(g2.overall, true, 'the full bar is clearable by an honest journal');
});

/* ---------------- dashboard integration ---------------- */

const fs = require("node:fs");
const path = require("node:path");

test("the graduation bar is wired into the coach view", () => {
  const ROOT = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(ROOT, "dashboard.html"), "utf8");
  const dash = fs.readFileSync(path.join(ROOT, "dashboard.js"), "utf8");

  const masteryAt = html.indexOf('<script src="mastery.js">');
  const dashAt = html.indexOf('<script src="dashboard.js">');
  assert.ok(masteryAt !== -1, "dashboard.html must load mastery.js");
  assert.ok(masteryAt < dashAt, "mastery.js must load before dashboard.js");

  assert.match(dash, /function renderGraduationPanel\(\)/);
  assert.match(dash, /\$\{renderGraduationPanel\(\)\}/, "the coach view must render the panel");
  assert.match(dash, /PTMastery/, "the panel must consume the mastery module");
  assert.match(dash, /never counts as a pass/, "the unknown-is-not-a-pass doctrine must be stated to the user");
});

test('object-shaped theses (the engine schema since normalizeThesis) count toward coverage', () => {
  // engine.attachThesis stores the NORMALIZED OBJECT on the position, and
  // closeRound copies it onto the round — production rounds carry
  // { text, tags, plan, ... }, never a bare string. Coverage that only
  // counts strings silently fails every real journaler.
  const rounds = Array.from({ length: 12 }, (_, i) => round(i % 2 ? 0.2 : -0.1, {
    closedAt: 1_800_000_000_000 + i * 120_000,
    thesis: { text: 'breakout continuation', tags: [], plan: 'scalp', conviction: 3, targetPct: 50, stopPct: 30, at: 1 },
  }));
  const g = M.graduation(state(rounds));
  const thesis = g.criteria.find((c) => c.id === 'thesis');
  assert.equal(thesis.status, 'pass',
    'object theses are theses — the criterion must count the shipped schema, not the legacy string');
  // An object thesis with no substance is still not a thesis.
  const empty = Array.from({ length: 12 }, (_, i) => round(0.2, {
    closedAt: 1_800_000_000_000 + i * 120_000,
    thesis: { text: '', tags: [], plan: null, conviction: null, targetPct: null, stopPct: null, at: 1 },
  }));
  const g2 = M.graduation(state(empty));
  assert.notEqual(g2.criteria.find((c) => c.id === 'thesis').status, 'pass',
    'an empty thesis object must not count as a written thesis');
});
