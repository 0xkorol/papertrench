/* PaperTrench server — weekly Trench Sprint.
 *
 * One shared window (ISO week, UTC), one comparable number. A sprint entry is
 * NOT a separate wallet: it is the slice of a player's committed chain whose
 * rounds both opened and closed inside the window. That keeps the sprint
 * honest for free — the same chain that backs the all-time record backs the
 * sprint, so there is nothing extra to forge or to trust.
 *
 * Scoring uses ROI on window-start equity (cash implied by replaying the
 * chain up to the window's open, plus the cost basis of positions carried
 * in), so a small bankroll competes with a whale on equal terms.
 */
'use strict';

const { roundsFromChain, seasonScore, maxDrawdown, revengeRatio } = require('./ranking.js');
const { replayChain } = require('./chain.js');

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// Thursday 1970-01-01 was week 1 day 4; ISO weeks start Monday. 1970-01-05
// (the first Monday of the epoch) anchors the grid.
const FIRST_MONDAY_MS = 4 * 24 * 60 * 60 * 1000;

/** "2026-W32"-style id for the ISO week (UTC) containing ts. */
function weekIdOf(ts) {
  const d = new Date(Math.trunc(Number(ts) || 0));
  // ISO week-numbering year: shift to the Thursday of this week.
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86400000 + 1) / 7);
  return t.getUTCFullYear() + '-W' + String(week).padStart(2, '0');
}

/** [start, end) of the UTC Monday-to-Monday window containing ts. */
function windowOf(ts) {
  const t = Math.trunc(Number(ts) || 0);
  const sinceAnchor = t - FIRST_MONDAY_MS;
  const start = FIRST_MONDAY_MS + Math.floor(sinceAnchor / WEEK_MS) * WEEK_MS;
  return { weekId: weekIdOf(start), startTs: start, endTs: start + WEEK_MS };
}

/**
 * A player's sprint entry for a window, from their full chain.
 *
 * Only rounds opened AND closed inside the window count — a position carried
 * in was a decision made before the sprint existed, and a position carried
 * out has no honest realized number yet.
 */
function sprintEntry(links, startingSol, window) {
  const list = Array.isArray(links) ? links : [];
  const before = list.filter((l) => Number(l.ts) < window.startTs);
  const baseline = replayChain(before, startingSol);
  // Window-start equity: realized cash plus what the carried positions cost.
  const carriedCost = before.length
    ? roundsOpenCost(before)
    : 0;
  const equityAtStart = baseline.cashSol + carriedCost;

  const rounds = roundsFromChain(list).filter((r) =>
    r.openedTs >= window.startTs && r.closedTs < window.endTs);
  const pnl = rounds.reduce((s, r) => s + r.pnlSol, 0);
  const wins = rounds.filter((r) => r.win).length;
  const roiPct = equityAtStart > 0 ? (pnl / equityAtStart) * 100 : 0;
  const stats = {
    weekId: window.weekId,
    rounds: rounds.length,
    wins,
    losses: rounds.length - wins,
    pnlSol: pnl,
    roiPct,
    equityAtStart,
    maxDrawdown: maxDrawdown(rounds, equityAtStart),
    revengeRatio: revengeRatio(rounds),
  };
  stats.score = seasonScore({
    roiPct, rounds: rounds.length,
    revengeRatio: stats.revengeRatio, maxDrawdown: stats.maxDrawdown,
  });
  return stats;
}

/** Cost basis still open after replaying `links` (helper for window-start
 * equity; mirrors the replay book exactly). */
function roundsOpenCost(links) {
  const open = new Map();
  for (const link of links) {
    const qty = Number(link.qty) || 0;
    const amount = Number(link.amount !== undefined
      ? link.amount : (link.side === 'buy' ? link.solGross : link.solNet)) || 0;
    if (!(qty > 0)) continue;
    if (link.side === 'buy') {
      const held = open.get(link.mint) || { qty: 0, cost: 0 };
      held.qty += qty;
      held.cost += (Number(link.solNet) > 0 ? Number(link.solNet) : amount)
        + (Number(link.txCostSol) || 0);
      open.set(link.mint, held);
    } else if (link.side === 'sell') {
      const held = open.get(link.mint);
      if (!held || held.qty <= 0) continue;
      const share = Math.min(1, qty / held.qty);
      held.cost -= held.cost * share;
      held.qty -= qty;
      if (held.qty <= 1e-12) open.delete(link.mint);
      else open.set(link.mint, held);
    }
  }
  let cost = 0;
  for (const held of open.values()) cost += held.cost;
  return cost;
}

module.exports = { WEEK_MS, weekIdOf, windowOf, sprintEntry };
