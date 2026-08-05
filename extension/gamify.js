/* PaperTrench — gamification derived from the journal (docs/GAMIFY.md).
 *
 * Pure functions over the serializable state object, like mastery.js: no DOM,
 * no chrome APIs, no timers. Every mechanic is DERIVED — nothing here writes
 * state, so there is nothing to migrate and nothing to cheat that the
 * attestation chain does not already cover.
 *
 * Doctrine (GAMIFY.md): discipline is the loop, never volume, never luck.
 * A red round can grade A; a lucky win can grade F. No mechanic may alter or
 * reinterpret a number surfaced elsewhere.
 */
(() => {
  'use strict';

  const REVENGE_WINDOW_MS = 10 * 60 * 1000;
  const REVENGE_SIZE_RATIO = 1.5;
  const OUTSIZED_RATIO = 2;
  const OUTSIZED_MIN_PRIORS = 5;

  const GRADE_BANDS = [
    ['S', 92], ['A', 80], ['B', 68], ['C', 55], ['D', 40], ['F', -Infinity],
  ];
  const NO_THESIS_CAP = 67; // a thesisless round can never out-grade a C

  const REP_WEIGHT = { S: 1.5, A: 1.25, B: 1, C: 0.75, D: 0.5, F: 0.25 };
  const REP_FULL_PER_DAY = 10;
  const REP_HALF_PER_DAY = 20;
  const REP_LEVEL_DIVISOR = 3;

  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

  /** Engine/mastery are load-order globals in the browser and requires in
   *  node; resolve lazily so gamify.js can load before either. */
  function deps() {
    if (typeof module !== 'undefined' && module.exports) {
      return { E: require('./engine.js'), M: require('./mastery.js') };
    }
    const g = typeof window !== 'undefined' ? window : self;
    return { E: g.PaperEngine, M: g.PTMastery };
  }

  function closedRounds(state) {
    const rounds = Array.isArray(state && state.rounds) ? state.rounds : [];
    return rounds.filter((r) => r && num(r.pnlSol) !== null);
  }

  /** Oldest-first copy; storage order is newest-first (engine unshift). */
  function chronological(state) {
    return closedRounds(state).slice().reverse();
  }

  /* ---------------- revenge detection (per round) ---------------- */

  /**
   * Was THIS round opened as a revenge re-entry: within the window after a
   * red close of the same mint, sized at >= ratio x that round's stake?
   * (mastery.countRevenge asks the mirrored question — "was this loss
   * revenged" — for the graduation bar; the grade needs it per-entry.)
   */
  function isRevengeEntry(state, round) {
    const openedAt = num(round && round.openedAt);
    const invested = num(round && round.investedSol);
    if (openedAt === null || invested === null || !round.mint) return false;
    return closedRounds(state).some((prior) => prior !== round
      && prior.mint === round.mint
      && num(prior.pnlSol) < 0
      && num(prior.closedAt) !== null
      && num(prior.closedAt) <= openedAt
      && openedAt - num(prior.closedAt) <= REVENGE_WINDOW_MS
      && num(prior.investedSol) !== null
      && invested >= num(prior.investedSol) * REVENGE_SIZE_RATIO);
  }

  /** Mean invested across the rounds closed BEFORE this one opened. */
  function trailingMeanInvested(state, round) {
    const openedAt = num(round && round.openedAt);
    if (openedAt === null) return null;
    const priors = closedRounds(state)
      .filter((r) => r !== round && num(r.closedAt) !== null && num(r.closedAt) <= openedAt)
      .map((r) => num(r.investedSol))
      .filter((x) => x !== null && x > 0);
    if (priors.length < OUTSIZED_MIN_PRIORS) return null;
    return priors.reduce((s, x) => s + x, 0) / priors.length;
  }

  /* ---------------- round grades ---------------- */

  function letterFor(score) {
    for (const [letter, floor] of GRADE_BANDS) if (score >= floor) return letter;
    return 'F';
  }

  /**
   * Grade one closed round's PROCESS. Every deduction names its evidence;
   * the parts array is the receipt the UI and the coach both read.
   */
  function roundGrade(state, round) {
    if (!round || num(round.pnlSol) === null) return null;
    const { E } = deps();
    const parts = [];
    let score = 100;
    const deduct = (id, delta, note) => { score += delta; parts.push({ id, delta, note }); };

    const hasThesis = Boolean(round.thesis
      && (typeof round.thesis === 'object' || String(round.thesis).trim().length));
    if (!hasThesis) {
      deduct('no-thesis', -30, 'No written thesis — clicking, not trading a plan.');
    }

    const plan = hasThesis && E && typeof E.gradeThesis === 'function' ? E.gradeThesis(round) : null;
    if (plan && plan.followedPlan === false) {
      deduct('plan-broken', -25, plan.notes && plan.notes.length
        ? plan.notes.join(' ')
        : 'The exit did not respect the stated plan.');
    }

    const exit = E && typeof E.exitQuality === 'function' ? E.exitQuality(round) : null;
    if (exit) {
      if (exit.verdict === 'round-tripped') {
        deduct('round-trip', -30, 'Green in-trade, closed red — the costliest habit.');
      } else if (exit.verdict === 'early') {
        deduct('exit-early', -12, `Captured ${exit.capturedPct === null ? '?' : exit.capturedPct.toFixed(0)}% of the peak.`);
      } else if (exit.verdict === 'good') {
        deduct('exit-good', -5, `Captured ${exit.capturedPct === null ? '?' : exit.capturedPct.toFixed(0)}% of the peak.`);
      }
    }

    if (isRevengeEntry(state, round)) {
      deduct('revenge', -35, 'Re-entered the same coin within minutes of a loss, bigger.');
    }

    const meanInvested = trailingMeanInvested(state, round);
    const invested = num(round.investedSol);
    if (meanInvested !== null && invested !== null && invested > meanInvested * OUTSIZED_RATIO) {
      deduct('outsized', -12, `Stake ${(invested / meanInvested).toFixed(1)}x your recent normal size.`);
    }

    score = Math.max(0, Math.min(100, score));
    if (!hasThesis && score > NO_THESIS_CAP) score = NO_THESIS_CAP;

    const letter = letterFor(score);
    const luckyWin = num(round.pnlSol) > 0
      && (Boolean(plan && plan.followedPlan === false) || !hasThesis || parts.some((p) => p.id === 'revenge'));
    return {
      score,
      letter,
      parts,
      luckyWin,
      capturedPct: exit ? exit.capturedPct : null,
      verdict: exit ? exit.verdict : null,
    };
  }

  /* ---------------- discipline streaks ---------------- */

  function streakOver(rounds, qualifies) {
    let current = 0;
    let best = 0;
    for (const r of rounds) {
      if (qualifies(r)) { current += 1; if (current > best) best = current; } else { current = 0; }
    }
    return { current, best };
  }

  /** Current/best streaks over closed rounds, oldest to newest. */
  function streaks(state) {
    const { E } = deps();
    const rounds = chronological(state);
    const hasThesis = (r) => Boolean(r.thesis
      && (typeof r.thesis === 'object' || String(r.thesis).trim().length));
    const notRoundTripped = (r) => {
      const exit = E && typeof E.exitQuality === 'function' ? E.exitQuality(r) : null;
      return !(exit && exit.roundTripped);
    };
    return {
      journal: streakOver(rounds, hasThesis),
      cleanExit: streakOver(rounds, notRoundTripped),
      noRevenge: streakOver(rounds, (r) => !isRevengeEntry(state, r)),
    };
  }

  /* ---------------- Trench Rank ---------------- */

  const RANKS = [
    { tier: 0, name: 'Fresh Meat' },
    { tier: 1, name: 'Journaler' },
    { tier: 2, name: 'Survivor' },
    { tier: 3, name: 'Operator' },
    { tier: 4, name: 'Veteran' },
    { tier: 5, name: 'Graduated' },
  ];

  const frac = (value, target) => {
    if (value === null || !(target > 0)) return 0;
    return Math.max(0, Math.min(1, value / target));
  };

  /**
   * The graduation bar (mastery.js) staged into a ladder, so there is always
   * a visible next gate. Requirements report progress fractions the UI can
   * draw; an unknown criterion is 0 progress, never a free pass.
   */
  function rank(state) {
    const { M } = deps();
    if (!M) return null;
    const grad = M.graduation(state);
    const s = grad.stats;
    const byId = {};
    for (const c of grad.criteria) byId[c.id] = c;
    const pass = (id) => Boolean(byId[id] && byId[id].status === 'pass');

    const gates = [
      null, // tier 0 is unconditional
      [
        { label: '10+ closed rounds', done: s.totalRounds >= 10, progress: frac(s.totalRounds, 10) },
        { label: 'Thesis on 60% of recent rounds', done: pass('thesis'), progress: frac(s.thesisCoverage, 0.6) },
      ],
      [
        { label: '25+ closed rounds', done: s.totalRounds >= 25, progress: frac(s.totalRounds, 25) },
        { label: 'Average loss smaller than average win', done: pass('lossSize'), progress: pass('lossSize') ? 1 : 0 },
      ],
      [
        { label: '35+ closed rounds', done: s.totalRounds >= 35, progress: frac(s.totalRounds, 35) },
        { label: 'No revenge re-entries in the window', done: pass('revenge'), progress: pass('revenge') ? 1 : 0 },
        { label: 'Losers not held 3x longer than winners', done: pass('holdSymmetry'), progress: pass('holdSymmetry') ? 1 : 0 },
      ],
      [
        { label: '50+ closed rounds', done: pass('sample'), progress: frac(s.totalRounds, M.SAMPLE_MIN) },
        { label: 'Survived a cold streak without sizing up', done: pass('coldStreak'), progress: pass('coldStreak') ? 1 : 0 },
      ],
      [
        { label: 'The full graduation bar', done: grad.overall, progress: frac(grad.criteria.filter((c) => c.status === 'pass').length, grad.criteria.length) },
      ],
    ];

    let tier = 0;
    for (let t = 1; t < gates.length; t += 1) {
      if (gates[t].every((g) => g.done)) tier = t; else break;
    }
    const next = tier + 1 < RANKS.length
      ? { name: RANKS[tier + 1].name, requirements: gates[tier + 1] }
      : null;
    return { tier, name: RANKS[tier].name, next, graduated: grad.overall };
  }

  /* ---------------- reps & level ---------------- */

  /** Local calendar day of a timestamp — reps diminish per DAY on purpose. */
  function dayKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /**
   * One closed graded round = one rep, weighted by grade. Diminishing per
   * day: full credit for the first 10, half to 20, zero past 20 — tired reps
   * don't count, and that is itself the lesson.
   */
  function reps(state, now) {
    const nowTs = num(now) !== null ? num(now) : Date.now();
    const rounds = chronological(state);
    const perDay = {};
    let total = 0;
    for (const r of rounds) {
      const closedAt = num(r.closedAt);
      if (closedAt === null) continue;
      const key = dayKey(closedAt);
      const nth = (perDay[key] = (perDay[key] || 0) + 1);
      if (nth > REP_HALF_PER_DAY) continue;
      const grade = roundGrade(state, r);
      if (!grade) continue;
      const weight = REP_WEIGHT[grade.letter] || 0;
      total += nth > REP_FULL_PER_DAY ? weight / 2 : weight;
    }
    const level = Math.floor(Math.sqrt(total / REP_LEVEL_DIVISOR));
    const nextLevelAt = REP_LEVEL_DIVISOR * (level + 1) * (level + 1);
    const todayCount = perDay[dayKey(nowTs)] || 0;
    return {
      total,
      level,
      nextLevelAt,
      today: {
        count: todayCount,
        counted: Math.min(todayCount, REP_HALF_PER_DAY),
        capped: todayCount >= REP_HALF_PER_DAY,
        diminished: todayCount >= REP_FULL_PER_DAY,
      },
    };
  }

  /* ---------------- badges ---------------- */

  /**
   * Earned/unearned with dates where the journal can actually date them.
   * Doctrine: no profit badges, no win-streak badges, no volume badges —
   * those train the habits this product exists to break.
   */
  function badges(state) {
    const { E } = deps();
    const rounds = chronological(state);
    const hasThesis = (r) => Boolean(r.thesis
      && (typeof r.thesis === 'object' || String(r.thesis).trim().length));
    const capture = (r) => {
      const exit = E && typeof E.exitQuality === 'function' ? E.exitQuality(r) : null;
      return exit ? exit.capturedPct : null;
    };
    const st = streaks(state);
    const firstWhere = (pred) => rounds.find(pred) || null;

    const firstThesis = firstWhere(hasThesis);
    const firstSniper = firstWhere((r) => capture(r) !== null && capture(r) >= 80);
    const sniperCount = rounds.filter((r) => capture(r) !== null && capture(r) >= 80).length;
    const last25 = rounds.slice(-25);
    const planRun = streakOver(rounds.filter(hasThesis), (r) => {
      const plan = E && typeof E.gradeThesis === 'function' ? E.gradeThesis(r) : null;
      return Boolean(plan && plan.followedPlan === true);
    });
    const { M } = deps();
    const cold = M ? M.stats(state).coldStreak : { length: 0, disciplined: null };

    const badge = (id, label, detail, earned, earnedAt) => (
      { id, label, detail, earned: Boolean(earned), earnedAt: earned && earnedAt ? earnedAt : null }
    );
    return [
      badge('first-thesis', 'On the record', 'Wrote a thesis before an entry.',
        Boolean(firstThesis), firstThesis && num(firstThesis.closedAt)),
      badge('journal-10', 'Ten on the record', '10 consecutive rounds with a written thesis.',
        st.journal.best >= 10, null),
      badge('cold-blooded', 'Cold-blooded', 'Survived a real losing streak without sizing up.',
        cold.length >= 3 && cold.disciplined === true, null),
      badge('fifty-club', 'Fifty club', '50 closed round trips — a sample that starts to mean something.',
        rounds.length >= 50, null),
      badge('sniper', 'Sniper exit', 'Captured 80%+ of what a trade offered.',
        Boolean(firstSniper), firstSniper && num(firstSniper.closedAt)),
      badge('sniper-10', 'Ten clean exits', '10 rounds capturing 80%+ of the peak.',
        sniperCount >= 10, null),
      badge('no-revenge-25', 'Held the line', '25 straight rounds without a revenge re-entry.',
        last25.length >= 25 && last25.every((r) => !isRevengeEntry(state, r)), null),
      badge('plan-master', 'Plan master', '10 consecutive rounds that respected their written plan.',
        planRun.best >= 10, null),
    ];
  }

  /* ---------------- daily drills ---------------- */

  const DRILLS = [
    {
      id: 'capture-day',
      label: 'Capture day',
      detail: 'Close 3 rounds capturing at least 50% of the peak.',
      minRounds: 3,
      evaluate(E, todays) {
        const hits = todays.filter((r) => {
          const exit = E && typeof E.exitQuality === 'function' ? E.exitQuality(r) : null;
          return exit && exit.capturedPct !== null && exit.capturedPct >= 50;
        }).length;
        return { progress: Math.min(hits, 3), target: 3, done: hits >= 3 };
      },
    },
    {
      id: 'journal-day',
      label: 'Journal day',
      detail: 'Every round today carries a written thesis (at least 3).',
      minRounds: 3,
      evaluate(E, todays) {
        const withThesis = todays.filter((r) => Boolean(r.thesis
          && (typeof r.thesis === 'object' || String(r.thesis).trim().length))).length;
        const done = todays.length >= 3 && withThesis === todays.length;
        return { progress: withThesis, target: Math.max(3, todays.length), done };
      },
    },
    {
      id: 'flat-size-day',
      label: 'Flat-size day',
      detail: 'Keep every stake within 1.25x of today\'s average (at least 3 rounds).',
      minRounds: 3,
      evaluate(_E, todays) {
        const stakes = todays.map((r) => num(r.investedSol)).filter((x) => x !== null && x > 0);
        if (stakes.length < 3) return { progress: stakes.length, target: 3, done: false };
        const mean = stakes.reduce((s, x) => s + x, 0) / stakes.length;
        const done = Math.max(...stakes) <= mean * 1.25;
        return { progress: stakes.length, target: stakes.length, done };
      },
    },
    {
      id: 'stop-respect-day',
      label: 'Stop-respect day',
      detail: 'No written stop gets held through (at least 2 thesis rounds).',
      minRounds: 2,
      evaluate(E, todays) {
        const planned = todays.filter((r) => r.thesis && typeof r.thesis === 'object');
        const breached = planned.filter((r) => {
          const plan = E && typeof E.gradeThesis === 'function' ? E.gradeThesis(r) : null;
          return Boolean(plan && plan.notes && plan.notes.some((n) => n.indexOf('Held past') === 0));
        }).length;
        return { progress: planned.length, target: 2, done: planned.length >= 2 && breached === 0 };
      },
    },
  ];

  /** Deterministic small hash so the day's drill is stable all day. */
  function drillIndexFor(key) {
    let h = 0;
    for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    return h % DRILLS.length;
  }

  /** Today's drill and honest progress against it. */
  function drills(state, now) {
    const { E } = deps();
    const nowTs = num(now) !== null ? num(now) : Date.now();
    const key = dayKey(nowTs);
    const todays = chronological(state).filter((r) => num(r.closedAt) !== null && dayKey(num(r.closedAt)) === key);
    const drill = DRILLS[drillIndexFor(key)];
    const result = drill.evaluate(E, todays);
    return {
      id: drill.id,
      label: drill.label,
      detail: drill.detail,
      day: key,
      roundsToday: todays.length,
      progress: result.progress,
      target: result.target,
      done: result.done,
    };
  }

  const api = {
    roundGrade, streaks, rank, reps, badges, drills,
    isRevengeEntry,
    RANKS, GRADE_BANDS, REP_FULL_PER_DAY, REP_HALF_PER_DAY,
    REVENGE_WINDOW_MS, REVENGE_SIZE_RATIO,
  };

  if (typeof window !== 'undefined') window.PTGamify = api;
  if (typeof self !== 'undefined') self.PTGamify = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
