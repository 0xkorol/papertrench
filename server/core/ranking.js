/* PaperTrench server — ranking math.
 *
 * Doctrine (gamify.js): process over outcome. A raw-P&L board crowns whoever
 * hit one lottery ticket, which teaches exactly the wrong lesson. The score
 * here starts from ROI on the declared bankroll (the comparable number the
 * dashboard already shows), then weights it by sustained evidence (round
 * count, log-scaled) and by discipline signals that are derivable from the
 * committed fills alone — the chain records only fills, so every metric here
 * must be provable from fill timing and P&L, never from self-reported state.
 *
 * The formula is public and deterministic on purpose: an open-source
 * leaderboard with a secret score would invite exactly the distrust the hash
 * chain exists to remove.
 */
'use strict';

/** Re-entry into a mint this soon after closing it at a loss reads as
 * revenge — the chase pattern mastery.js flags locally. */
const REVENGE_WINDOW_MS = 10 * 60 * 1000;

/** Fewer closed rounds than this is a sample, not a record. */
const MIN_RANKED_ROUNDS = 5;

/**
 * Reconstruct closed rounds from chain links.
 *
 * Mirrors replayChain's book math (net-basis cost, share accounting) but
 * keeps per-round detail: a round is a mint's position going flat, carrying
 * entry/exit times, cost in, and realized P&L.
 */
function roundsFromChain(links) {
  const list = Array.isArray(links) ? links : [];
  const open = new Map(); // mint -> { qty, cost, openedTs }
  const rounds = [];

  for (const link of list) {
    const qty = Number(link.qty) || 0;
    const price = Number(link.priceNative) || 0;
    const amount = Number(link.amount !== undefined
      ? link.amount
      : (link.side === 'buy' ? link.solGross : link.solNet)
    ) || 0;
    if (!(qty > 0) || !(price > 0)) continue;

    if (link.side === 'buy') {
      const held = open.get(link.mint) || { qty: 0, cost: 0, openedTs: Number(link.ts) || 0 };
      if (held.qty <= 0) held.openedTs = Number(link.ts) || 0;
      held.qty += qty;
      held.cost += (Number(link.solNet) > 0 ? Number(link.solNet) : amount)
        + (Number(link.txCostSol) || 0);
      open.set(link.mint, held);
    } else if (link.side === 'sell') {
      const held = open.get(link.mint);
      if (!held || held.qty <= 0) continue;
      const share = Math.min(1, qty / held.qty);
      const costOut = held.cost * share;
      const pnl = amount - costOut;
      held.qty -= qty;
      held.cost -= costOut;
      if (held.qty <= 1e-12) {
        rounds.push({
          mint: String(link.mint),
          openedTs: held.openedTs,
          closedTs: Number(link.ts) || 0,
          costIn: costOut > 0 ? costOut : 0,
          pnlSol: pnl,
          win: pnl > 0,
        });
        open.delete(link.mint);
      } else {
        open.set(link.mint, held);
      }
    }
  }
  return rounds;
}

/** Largest peak-to-trough drop of the realized-equity curve, as a fraction
 * of the peak. 0 = never gave anything back. */
function maxDrawdown(rounds, startingSol) {
  let equity = Number(startingSol) > 0 ? Number(startingSol) : 0;
  if (!(equity > 0)) return 0;
  let peak = equity;
  let worst = 0;
  for (const r of rounds) {
    equity += r.pnlSol;
    if (equity > peak) peak = equity;
    else if (peak > 0) worst = Math.max(worst, (peak - equity) / peak);
  }
  return worst;
}

/** Fraction of losing rounds that were followed by re-entering the same mint
 * inside the revenge window. Derivable purely from fill times. */
function revengeRatio(rounds) {
  const losses = rounds.filter((r) => !r.win);
  if (!losses.length) return 0;
  let revenged = 0;
  for (const loss of losses) {
    const again = rounds.find((r) =>
      r.mint === loss.mint &&
      r.openedTs > loss.closedTs &&
      r.openedTs - loss.closedTs <= REVENGE_WINDOW_MS);
    if (again) revenged++;
  }
  return revenged / losses.length;
}

/**
 * The season score.
 *
 *   score = roiPct × ln(1 + rounds) × discipline
 *
 * ROI is the outcome; ln(1+rounds) rewards showing up repeatedly without
 * letting volume swamp skill; discipline (1 − ½·revengeRatio − ¼·drawdown)
 * discounts tilt and giving winnings back. A negative ROI sustained over many
 * rounds scores below a briefly negative one — sustained losing should sink,
 * not hide.
 */
function seasonScore(stats) {
  const roiPct = Number(stats.roiPct) || 0;
  const rounds = Math.max(0, Number(stats.rounds) || 0);
  const discipline = Math.max(0.25,
    1 - 0.5 * (Number(stats.revengeRatio) || 0) - 0.25 * (Number(stats.maxDrawdown) || 0));
  return roiPct * Math.log(1 + rounds) * discipline;
}

/** Everything the board shows for one record, from chain + declared start. */
function recordStats(links, startingSol) {
  const rounds = roundsFromChain(links);
  const wins = rounds.filter((r) => r.win).length;
  const pnl = rounds.reduce((s, r) => s + r.pnlSol, 0);
  const start = Number(startingSol) || 0;
  const roiPct = start > 0 ? (pnl / start) * 100 : 0;
  const perRound = rounds.filter((r) => r.costIn > 0);
  const expectancy = perRound.length
    ? perRound.reduce((s, r) => s + r.pnlSol / r.costIn, 0) / perRound.length
    : 0;
  const stats = {
    rounds: rounds.length,
    wins,
    losses: rounds.length - wins,
    winRate: rounds.length ? wins / rounds.length : 0,
    realizedPnlSol: pnl,
    roiPct,
    expectancy,
    maxDrawdown: maxDrawdown(rounds, start),
    revengeRatio: revengeRatio(rounds),
    rankable: rounds.length >= MIN_RANKED_ROUNDS,
  };
  stats.score = seasonScore(stats);
  return stats;
}

module.exports = {
  REVENGE_WINDOW_MS, MIN_RANKED_ROUNDS,
  roundsFromChain, maxDrawdown, revengeRatio, seasonScore, recordStats,
};
