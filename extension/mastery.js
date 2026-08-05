/* PaperTrench — mastery statistics and the graduation bar.
 *
 * Pure functions over the serializable state object (like engine.js): no DOM,
 * no chrome APIs. The dashboard renders what these return.
 *
 * This module implements docs/GRADUATION.md as code. The doctrine carries
 * over from the rest of the product: never fabricate a number. Where the
 * journal cannot support a criterion (not enough data, missing fields), the
 * criterion reports status 'unknown' — it does not pass by default, and it
 * does not guess.
 */
(() => {
  'use strict';

  const WINDOW_ROUNDS = 30;      // the recency window for performance criteria
  const SAMPLE_MIN = 50;         // closed rounds before any verdict means much
  const REVENGE_WINDOW_MS = 10 * 60 * 1000;
  const REVENGE_SIZE_RATIO = 1.5;
  const HOLD_SYMMETRY_MAX = 3;   // losers held >3x longer than winners = fail
  const STREAK_MIN = 3;          // adversity sample: a streak this long must exist
  const STREAK_SIZE_TOLERANCE = 1.25;
  const THESIS_COVERAGE_MIN = 0.6;

  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

  /** Rounds newest-first is the storage order; work on a defensive copy. */
  function closedRounds(state) {
    const rounds = Array.isArray(state && state.rounds) ? state.rounds : [];
    return rounds.filter((r) => r && num(r.pnlSol) !== null);
  }

  function mean(xs) {
    return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
  }

  /**
   * Performance statistics over the last `windowRounds` closed rounds.
   * Every field is null when the journal cannot support it — never a guess.
   */
  function stats(state, windowRounds = WINDOW_ROUNDS) {
    const all = closedRounds(state);
    const recent = all.slice(0, windowRounds); // storage order: newest first
    const pnls = recent.map((r) => num(r.pnlSol)).filter((x) => x !== null);

    const wins = recent.filter((r) => num(r.pnlSol) > 0);
    const losses = recent.filter((r) => num(r.pnlSol) < 0);
    const decided = wins.length + losses.length;

    const expectancySol = mean(pnls);
    // Cover the best round with your hand: is it still positive?
    let expectancyExBestSol = null;
    if (pnls.length > 1) {
      const best = Math.max(...pnls);
      const rest = pnls.slice();
      rest.splice(rest.indexOf(best), 1);
      expectancyExBestSol = mean(rest);
    }

    const holdOf = (r) => num(r.heldMs);
    const winHolds = wins.map(holdOf).filter((x) => x !== null && x > 0);
    const lossHolds = losses.map(holdOf).filter((x) => x !== null && x > 0);
    const avgWinHoldMs = mean(winHolds);
    const avgLossHoldMs = mean(lossHolds);

    return {
      totalRounds: all.length,
      windowRounds: recent.length,
      expectancySol,
      expectancyExBestSol,
      winRate: decided > 0 ? wins.length / decided : null,
      avgWinSol: mean(wins.map((r) => num(r.pnlSol)).filter((x) => x !== null)),
      avgLossSol: mean(losses.map((r) => Math.abs(num(r.pnlSol))).filter((x) => x !== null)),
      avgWinHoldMs,
      avgLossHoldMs,
      holdRatio: avgWinHoldMs && avgLossHoldMs ? avgLossHoldMs / avgWinHoldMs : null,
      revengeCount: countRevenge(state, recent),
      thesisCoverage: thesisCoverage(recent),
      coldStreak: coldStreak(all),
    };
  }

  /**
   * A revenge re-entry: after a losing round closes, a buy on the SAME mint
   * within the window, sized at >= ratio x that round's invested amount.
   * This is the pattern that turns small losses into large ones.
   */
  function countRevenge(state, rounds) {
    const journal = Array.isArray(state && state.journal) ? state.journal : [];
    const buys = journal.filter((t) => t && t.side === 'buy' && num(t.ts) !== null);
    let count = 0;
    for (const round of rounds) {
      if (!(num(round.pnlSol) < 0)) continue;
      const closedAt = num(round.closedAt);
      const invested = num(round.investedSol);
      if (closedAt === null || invested === null || !round.mint) continue;
      const hit = buys.some((t) => t.mint === round.mint
        && num(t.ts) > closedAt
        && num(t.ts) - closedAt <= REVENGE_WINDOW_MS
        && num(t.solGross) !== null
        && num(t.solGross) >= invested * REVENGE_SIZE_RATIO);
      if (hit) count += 1;
    }
    return count;
  }

  /** Fraction of rounds that carried a written thesis; null when unknowable. */
  function thesisCoverage(rounds) {
    if (!rounds.length) return null;
    const carrying = rounds.filter((r) => 'thesis' in r);
    // If the schema never records a thesis on rounds, say so instead of
    // failing everyone silently.
    if (!carrying.length) return null;
    // The engine stores the NORMALIZED OBJECT (normalizeThesis) on rounds;
    // bare strings are the legacy shape. Both count — but only with
    // substance: an empty object thesis is still an empty thesis box.
    const hasSubstance = (t) => {
      if (typeof t === 'string') return t.trim().length > 0;
      if (t && typeof t === 'object') {
        return Boolean((typeof t.text === 'string' && t.text.trim().length > 0)
          || (Array.isArray(t.tags) && t.tags.length > 0)
          || t.plan);
      }
      return false;
    };
    const withText = rounds.filter((r) => hasSubstance(r.thesis));
    return withText.length / rounds.length;
  }

  /**
   * The longest losing streak and whether position sizing stayed disciplined
   * through it (no tilt-doubling). Rounds arrive newest-first; walk oldest
   * to newest so "streak" means consecutive in time.
   */
  function coldStreak(allRounds) {
    const rounds = allRounds.slice().reverse();
    const overallInvested = mean(rounds.map((r) => num(r.investedSol)).filter((x) => x !== null && x > 0));
    let best = { length: 0, disciplined: null };
    let run = [];
    const evaluate = () => {
      if (run.length > best.length) {
        const stakes = run.map((r) => num(r.investedSol)).filter((x) => x !== null && x > 0);
        const disciplined = overallInvested && stakes.length
          ? Math.max(...stakes) <= overallInvested * STREAK_SIZE_TOLERANCE
          : null;
        best = { length: run.length, disciplined };
      }
    };
    for (const r of rounds) {
      if (num(r.pnlSol) < 0) { run.push(r); } else { evaluate(); run = []; }
    }
    evaluate();
    return best;
  }

  /**
   * The graduation bar (docs/GRADUATION.md), evaluated. Each criterion:
   * { id, label, status: 'pass'|'fail'|'unknown', value, detail }.
   * Overall passes only when every criterion passes — an 'unknown' is not a
   * pass, it is missing evidence.
   */
  function graduation(state) {
    const s = stats(state);
    const criteria = [];
    const push = (id, label, status, value, detail) => criteria.push({ id, label, status, value, detail });

    push('sample', `${SAMPLE_MIN}+ closed round trips`,
      s.totalRounds >= SAMPLE_MIN ? 'pass' : 'fail',
      s.totalRounds,
      `${s.totalRounds} closed — ten trades prove nothing; ${SAMPLE_MIN} start to.`);

    push('expectancy', 'Positive expectancy over the recent window',
      s.expectancySol === null ? 'unknown'
        : (s.expectancySol > 0 && (s.expectancyExBestSol === null || s.expectancyExBestSol > 0)) ? 'pass' : 'fail',
      s.expectancySol,
      s.expectancyExBestSol !== null && s.expectancySol > 0 && s.expectancyExBestSol <= 0
        ? 'Positive only because of one outlier round — cover it with your hand and the edge disappears.'
        : 'Average P&L per round, after fees, over the recent window — and still positive without the best round.');

    push('lossSize', 'Average loss smaller than average win',
      s.avgWinSol === null || s.avgLossSol === null ? 'unknown'
        : s.avgLossSol < s.avgWinSol ? 'pass' : 'fail',
      s.avgWinSol !== null && s.avgLossSol !== null ? s.avgLossSol / s.avgWinSol : null,
      'Many small wins and one account-ender is the classic blow-up profile.');

    push('holdSymmetry', 'Not holding losers far longer than winners',
      s.holdRatio === null ? 'unknown' : s.holdRatio <= HOLD_SYMMETRY_MAX ? 'pass' : 'fail',
      s.holdRatio,
      'Cutting flowers and watering weeds: losers held much longer than winners.');

    push('revenge', 'No revenge re-entries',
      s.windowRounds === 0 ? 'unknown' : s.revengeCount === 0 ? 'pass' : 'fail',
      s.revengeCount,
      'Re-entering the same coin within minutes of a loss, bigger, converts small losses into large ones.');

    push('thesis', 'A written thesis on most entries',
      s.thesisCoverage === null ? 'unknown' : s.thesisCoverage >= THESIS_COVERAGE_MIN ? 'pass' : 'fail',
      s.thesisCoverage,
      'An empty thesis box means clicking, not trading a plan.');

    push('coldStreak', 'Survived a losing streak without sizing up',
      s.coldStreak.length < STREAK_MIN ? 'unknown'
        : s.coldStreak.disciplined === null ? 'unknown'
          : s.coldStreak.disciplined ? 'pass' : 'fail',
      s.coldStreak.length,
      s.coldStreak.length < STREAK_MIN
        ? 'No real cold streak in the journal yet — adversity untested.'
        : 'Position size through the worst streak stayed near your normal size.');

    const overall = criteria.every((c) => c.status === 'pass');
    return { criteria, overall, stats: s };
  }

  const api = {
    stats, graduation,
    WINDOW_ROUNDS, SAMPLE_MIN, REVENGE_WINDOW_MS, REVENGE_SIZE_RATIO,
    HOLD_SYMMETRY_MAX, STREAK_MIN, THESIS_COVERAGE_MIN,
  };

  if (typeof window !== 'undefined') window.PTMastery = api;
  if (typeof self !== 'undefined') self.PTMastery = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
