/* PaperTrench server — chain-derived achievements.
 *
 * DOCTRINE, inherited verbatim from the extension's gamify.js: no profit
 * badges, no win-streak badges, no volume badges. A badge for making money
 * rewards the coin flip and teaches the exact lesson this product exists to
 * unteach. Every badge here is for PROCESS — discipline, patience, survival,
 * sizing, showing up — and every one is derivable from committed fills alone,
 * so nobody can claim one that the chain does not already prove.
 *
 * Every award carries its EVIDENCE: the numbers that earned it. A badge whose
 * reasoning cannot be shown is a badge that cannot be trusted, and this
 * product does not ship untrustworthy numbers.
 */
'use strict';

const { roundsFromChain, REVENGE_WINDOW_MS } = require('./ranking.js');

const DAY_MS = 24 * 60 * 60 * 1000;

/** Median of a numeric list (0 for empty). */
function median(values) {
  const list = values.slice().sort((a, b) => a - b);
  if (!list.length) return 0;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

/** Distinct UTC days on which a round was closed. */
function activeDays(rounds) {
  return new Set(rounds.map((r) => Math.floor(r.closedTs / DAY_MS))).size;
}

/**
 * Losses taken, and how many were chased back into within the revenge window.
 *
 * Counting LOSSES rather than clean rounds is deliberate. A "longest run of
 * non-revenge rounds" is trivially maxed by a record that never lost — which
 * would make a discipline badge secretly a profit badge, exactly the thing the
 * doctrine forbids. Revenge discipline is only demonstrated by someone who was
 * actually tempted, so the evidence here is "N losses taken, none chased."
 */
function lossDiscipline(rounds) {
  const losses = rounds.filter((r) => !r.win);
  let chased = 0;
  for (const loss of losses) {
    const chase = rounds.find((r) =>
      r.mint === loss.mint &&
      r.openedTs > loss.closedTs &&
      r.openedTs - loss.closedTs <= REVENGE_WINDOW_MS);
    if (chase) chased += 1;
  }
  return { losses: losses.length, chased, clean: losses.length - chased };
}

/**
 * Did the trader draw down hard and then make a NEW equity peak?
 * Returns the depth of the deepest drawdown that was fully recovered.
 */
function deepestRecoveredDrawdown(rounds, startingSol) {
  let equity = Number(startingSol) > 0 ? Number(startingSol) : 0;
  if (!(equity > 0)) return 0;
  let peak = equity;
  let trough = equity;
  let recovered = 0;
  for (const round of rounds) {
    equity += round.pnlSol;
    if (equity > peak) {
      // A new peak closes out whatever drawdown preceded it.
      if (trough < peak) recovered = Math.max(recovered, (peak - trough) / peak);
      peak = equity;
      trough = equity;
    } else if (equity < trough) {
      trough = equity;
    }
  }
  return recovered;
}

/** Average SOL committed on the first buy of each round, split by whether the
 * previous round was a loss. Sizing UP after a loss is the tell. */
function sizingAfterLoss(rounds) {
  const afterLoss = [];
  const afterWin = [];
  for (let i = 1; i < rounds.length; i++) {
    const size = rounds[i].costIn;
    if (!(size > 0)) continue;
    (rounds[i - 1].win ? afterWin : afterLoss).push(size);
  }
  const mean = (list) => list.length ? list.reduce((s, v) => s + v, 0) / list.length : 0;
  return { afterLoss: mean(afterLoss), afterWin: mean(afterWin),
           samples: afterLoss.length };
}

/*
 * Each definition: id, name, blurb, and a test(ctx) returning either null or
 * an evidence object. Tiers let one badge grow with the record instead of
 * spamming the profile with near-duplicates.
 */
const DEFINITIONS = [
  {
    id: 'committed',
    name: 'On the Record',
    blurb: 'Fills committed to the chain before their outcome was known.',
    tiers: [25, 100, 500, 2000],
    test: (ctx) => (ctx.chainLen >= 25
      ? { value: ctx.chainLen, unit: 'fills' } : null),
  },
  {
    id: 'clean-hands',
    name: 'Clean Hands',
    blurb: 'Losses taken without once chasing the mint that took them.',
    tiers: [8, 20, 50, 120],
    test: (ctx) => {
      const discipline = lossDiscipline(ctx.rounds);
      // Only a record that actually took losses can demonstrate not chasing them.
      if (discipline.losses < 8 || discipline.chased > 0) return null;
      return { value: discipline.losses, unit: 'losses, none chased' };
    },
  },
  {
    id: 'iron-stomach',
    name: 'Iron Stomach',
    blurb: 'Drew down hard and traded back to a new equity high without blowing up.',
    tiers: [20, 35, 50, 70],
    test: (ctx) => {
      const depth = deepestRecoveredDrawdown(ctx.rounds, ctx.startingSol) * 100;
      return depth >= 20 ? { value: Math.round(depth), unit: '% recovered' } : null;
    },
  },
  {
    id: 'cut-short',
    name: 'Cut It Short',
    blurb: 'Median loss smaller than median win — the asymmetry that actually pays.',
    tiers: [1.2, 1.5, 2, 3],
    test: (ctx) => {
      const wins = ctx.rounds.filter((r) => r.win).map((r) => r.pnlSol);
      const losses = ctx.rounds.filter((r) => !r.win).map((r) => Math.abs(r.pnlSol));
      if (wins.length < 5 || losses.length < 5) return null;
      const medLoss = median(losses);
      if (!(medLoss > 0)) return null;
      const ratio = median(wins) / medLoss;
      return ratio >= 1.2 ? { value: Math.round(ratio * 100) / 100, unit: 'x win/loss' } : null;
    },
  },
  {
    id: 'sized-down',
    name: 'Sized Down When Cold',
    blurb: 'Position size after a loss stayed at or below size after a win. No tilt-sizing.',
    tiers: [1, 1, 1, 1],
    test: (ctx) => {
      const sizing = sizingAfterLoss(ctx.rounds);
      if (sizing.samples < 8 || !(sizing.afterWin > 0)) return null;
      const ratio = sizing.afterLoss / sizing.afterWin;
      return ratio <= 1
        ? { value: Math.round(ratio * 100) / 100, unit: 'x size after loss' } : null;
    },
  },
  {
    id: 'long-haul',
    name: 'The Long Haul',
    blurb: 'Distinct days with a closed round. Reps beat sessions.',
    tiers: [7, 21, 60, 150],
    test: (ctx) => {
      const days = activeDays(ctx.rounds);
      return days >= 7 ? { value: days, unit: 'days' } : null;
    },
  },
  {
    id: 'patience',
    name: 'Let It Cook',
    blurb: 'Median hold time long enough that the thesis, not the candle, closed the trade.',
    tiers: [5, 20, 60, 240],
    test: (ctx) => {
      if (ctx.rounds.length < 10) return null;
      const holds = ctx.rounds.map((r) => (r.closedTs - r.openedTs) / 60000);
      const med = median(holds);
      return med >= 5 ? { value: Math.round(med), unit: 'min median hold' } : null;
    },
  },
  {
    id: 'unbroken',
    name: 'Unbroken Chain',
    blurb: 'Re-priced against real market history, with essentially every fill confirmed.',
    tiers: [99, 99.5, 99.9, 100],
    test: (ctx) => {
      if (ctx.pricingStatus !== 'verified' || ctx.chainLen < 20) return null;
      const pct = ctx.coverage * 100;
      if (pct < 99) return null;
      // Report the coverage that was actually measured. Printing a flat 100
      // for anything at or above the threshold would put a fabricated number
      // inside the badge whose entire subject is not fabricating numbers.
      return { value: Math.floor(pct * 10) / 10, unit: '% of fills confirmed' };
    },
  },
];

const TIER_NAMES = ['bronze', 'silver', 'gold', 'diamond'];

function tierFor(definition, value) {
  let tier = 0;
  for (let i = 0; i < definition.tiers.length; i++) {
    if (value >= definition.tiers[i]) tier = i;
  }
  return { index: tier, name: TIER_NAMES[tier] };
}

/**
 * Every badge a record has earned, with evidence.
 *
 * `record` is { chain, startingSol, chainLen, pricingStatus, coverage }.
 */
function awarded(record) {
  const rounds = roundsFromChain(record.chain || []);
  const ctx = {
    rounds,
    chainLen: Number(record.chainLen) || (record.chain ? record.chain.length : 0),
    startingSol: Number(record.startingSol) || 0,
    pricingStatus: record.pricingStatus || 'pending',
    coverage: Number(record.coverage) || 0,
  };

  const out = [];
  for (const definition of DEFINITIONS) {
    const evidence = definition.test(ctx);
    if (!evidence) continue;
    out.push({
      id: definition.id,
      name: definition.name,
      blurb: definition.blurb,
      tier: tierFor(definition, evidence.value),
      evidence,
    });
  }
  return out;
}

module.exports = {
  DEFINITIONS, TIER_NAMES,
  median, activeDays, lossDiscipline, deepestRecoveredDrawdown, sizingAfterLoss,
  tierFor, awarded,
};
