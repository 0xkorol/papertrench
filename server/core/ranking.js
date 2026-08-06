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
 * The cash amount a fill actually COMMITTED to the hash chain.
 *
 * attest.js's preimage hashes exactly one money field per fill: gross on a
 * buy, net on a sell. Everything else a link carries — buy-side `solNet`,
 * `txCostSol`, and the convenience `amount` copy — is stored but NOT hashed,
 * so all three can be edited to any value while every link still re-hashes
 * and the chain still verifies.
 *
 * The extension replays with those fields because a user has no reason to
 * lie to themselves. A leaderboard does: shrinking a buy's uncommitted
 * `solNet` toward zero drives the cost basis to nothing and inflates the
 * reported return without limit. So the ranked book is built only from what
 * the chain proves.
 *
 * That is also the more honest measure: gross out on a buy and net in on a
 * sell is the cash that genuinely left and entered the wallet, fees included.
 */
function committedAmount(link) {
  const value = link.side === 'buy' ? link.solGross : link.solNet;
  return Number(value) || 0;
}

/**
 * Reconstruct closed rounds from chain links.
 *
 * A round is a mint's position going flat, carrying entry/exit times, cost
 * in, and realized P&L — all on the committed cash basis above.
 */
function roundsFromChain(links) {
  const list = Array.isArray(links) ? links : [];
  const open = new Map(); // mint -> { qty, cost, openedTs }
  const rounds = [];

  for (const link of list) {
    const qty = Number(link.qty) || 0;
    const price = Number(link.priceNative) || 0;
    const amount = committedAmount(link);
    if (!(qty > 0) || !(price > 0)) continue;

    if (link.side === 'buy') {
      const held = open.get(link.mint)
        || { qty: 0, cost: 0, openedTs: Number(link.ts) || 0, realized: 0, costOut: 0 };
      if (held.qty <= 0) held.openedTs = Number(link.ts) || 0;
      held.qty += qty;
      held.cost += amount;
      open.set(link.mint, held);
    } else if (link.side === 'sell') {
      const held = open.get(link.mint);
      if (!held || held.qty <= 0) continue;
      const share = Math.min(1, qty / held.qty);
      const costOut = held.cost * share;
      held.qty -= qty;
      held.cost -= costOut;
      // Every leg accumulates. Scaling out is the disciplined exit this
      // product teaches, and booking only the FINAL leg's P&L understated the
      // round by every take-profit before it — which made the board's realized
      // P&L, ROI and win rate disagree with replayChain for exactly the
      // traders behaving best.
      held.realized += amount - costOut;
      held.costOut += costOut > 0 ? costOut : 0;
      if (held.qty <= 1e-12) {
        rounds.push({
          mint: String(link.mint),
          openedTs: held.openedTs,
          closedTs: Number(link.ts) || 0,
          costIn: held.costOut,
          pnlSol: held.realized,
          win: held.realized > 0,
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
  committedAmount, roundsFromChain, maxDrawdown, revengeRatio, seasonScore, recordStats,
};
