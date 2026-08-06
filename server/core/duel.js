/* PaperTrench server — head-to-head duels.
 *
 * Two players, one shared window, one committed chain each. A duel is the same
 * window slice the Sprint uses (window.js), so there is no separate duel book
 * to inflate and nothing extra to trust.
 *
 * ---------------------------------------------------------------------------
 * THE SETTLEMENT RULE, AND WHY IT IS THE WHOLE DESIGN
 *
 * The chain is append-only locally and extend-only on the server: a later
 * submission must contain the previously committed head at its committed
 * position. So a player CANNOT delete a losing round from inside the window —
 * removing a link breaks every hash after it, and swapping in a fresh history
 * is rejected as chain-replaced.
 *
 * That leaves exactly one gaming vector: submit early while you are up, then
 * go quiet when the trade turns against you, so the server's newest copy of
 * your chain predates your losses. The fix is to settle a duel ONLY from a
 * chain submitted AFTER the window closes. A post-close submission necessarily
 * carries every fill made inside the window, because the chain cannot skip
 * one. A player who refuses to submit after the close therefore forfeits
 * rather than freezing a flattering snapshot.
 *
 * Live standings DURING the window are still shown — they are the fun — but
 * they are labeled provisional, and they never decide the result.
 * ---------------------------------------------------------------------------
 */
'use strict';

const { windowEntry } = require('./window.js');

/** How long an unaccepted invite stays open. */
const INVITE_TTL_MS = 48 * 60 * 60 * 1000;

/**
 * How long after the window closes both players have to file a final record.
 *
 * This window is load-bearing in TWO directions. It stops a duel where nobody
 * ever submits from sitting in `awaiting` forever, and — more importantly — it
 * is why a forfeit cannot be stolen: settling the moment ONE side filed would
 * let whoever submits fastest at the bell take a forfeit win from an opponent
 * who was going to file ten minutes later, regardless of who actually traded
 * better. A forfeit has to mean "you had a day and never filed", so it can
 * only be declared once this has elapsed.
 */
const SETTLE_GRACE_MS = 24 * 60 * 60 * 1000;

const MIN_DURATION_MS = 60 * 60 * 1000;          // 1 hour
const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 1 week
const DEFAULT_DURATION_MS = 24 * 60 * 60 * 1000;

/** ROI difference below which a duel is a draw rather than a hairline win. */
const DRAW_EPSILON = 1e-9;

const STATUS = {
  OPEN: 'open',           // invite created, waiting for an opponent
  ACTIVE: 'active',       // both in, window running
  AWAITING: 'awaiting',   // window closed, waiting for final submissions
  SETTLED: 'settled',     // result final
  EXPIRED: 'expired',     // nobody accepted before the invite lapsed
};

function clampDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_DURATION_MS;
  return Math.min(MAX_DURATION_MS, Math.max(MIN_DURATION_MS, Math.trunc(value)));
}

/** The window a duel runs over. Accepting the invite starts the clock, so
 * both players face the same conditions from the same instant. */
function duelWindow(startTs, durationMs) {
  const start = Math.trunc(Number(startTs) || 0);
  return { startTs: start, endTs: start + clampDuration(durationMs) };
}

/**
 * Derive a duel's live status from its stored row and the current time.
 * Pure: the row records facts (accepted, settled), this decides what they mean
 * NOW, so a duel never sits in a stale state because no cron ran.
 */
function statusOf(duel, now) {
  const at = Math.trunc(Number(now) || 0);
  if (duel.settledAt) return STATUS.SETTLED;
  if (!duel.acceptedAt) {
    return at - Number(duel.createdAt || 0) > INVITE_TTL_MS ? STATUS.EXPIRED : STATUS.OPEN;
  }
  return at < Number(duel.endTs) ? STATUS.ACTIVE : STATUS.AWAITING;
}

/**
 * One side of the duel.
 *
 * `submittedAt` is when the server last received that player's chain. `final`
 * is the load-bearing flag: only a chain submitted after the window closed can
 * decide the result.
 */
function side(player, window, now) {
  const submittedAt = Number(player.submittedAt) || 0;
  // A precomputed entry (stored at submission time, so a duel view never
  // re-walks a lifetime chain) is used as-is; otherwise derive it here. Both
  // paths run the identical window math.
  const entry = player.entry !== undefined
    ? player.entry
    : (player.chain ? windowEntry(player.chain, player.startingSol, window) : null);
  const closed = Math.trunc(Number(now) || 0) >= window.endTs;
  return {
    handle: player.handle,
    userId: player.userId,
    status: player.status || 'pending',   // verification tier of their record
    entry,
    submittedAt,
    // Provisional while the window runs; final once a post-close submission
    // has landed AND survived re-pricing. Settlement writes a permanent
    // result, and a record the re-pricer could not check takes no position
    // here, exactly as on the boards — attest.js is public, so a fabricated
    // chain of unlisted mints hashes fine and lands 'partial', which must
    // not be a way to win a duel. Honest timing is safe: pricing completes
    // in minutes, and forfeits only fire once the grace period is up.
    final: Boolean(entry) && submittedAt >= window.endTs
      && player.status === 'verified',
    provisional: Boolean(entry) && !closed,
    missing: !entry,
  };
}

/**
 * Decide the duel.
 *
 * Returns { decided, winner, reason }. `winner` is a handle, or null for a
 * draw / no-contest. Every outcome names its reason so the UI can say what
 * happened in plain language instead of showing a bare trophy.
 */
function settle(a, b) {
  if (!a.final && !b.final) {
    return { decided: true, winner: null, outcome: 'no-contest',
             reason: 'Neither player filed a verified record after the window closed, so there is nothing to compare.' };
  }
  if (a.final && !b.final) {
    return { decided: true, winner: a.handle, outcome: 'forfeit',
             reason: `${b.handle} never filed a verified final record after the window closed.` };
  }
  if (b.final && !a.final) {
    return { decided: true, winner: b.handle, outcome: 'forfeit',
             reason: `${a.handle} never filed a verified final record after the window closed.` };
  }

  const diff = a.entry.roiPct - b.entry.roiPct;
  if (Math.abs(diff) <= DRAW_EPSILON) {
    return { decided: true, winner: null, outcome: 'draw',
             reason: 'Both players finished the window at the same return.' };
  }
  const winner = diff > 0 ? a : b;
  const loser = diff > 0 ? b : a;
  // Not trading at all beats losing money — stated plainly, because that is
  // one of the real lessons this product exists to teach.
  const outcome = loser.entry.rounds === 0 || winner.entry.rounds === 0
    ? 'by-inaction' : 'by-return';
  return {
    decided: true,
    winner: winner.handle,
    outcome,
    reason: outcome === 'by-inaction' && winner.entry.rounds === 0
      ? `${winner.handle} took no trades in the window and still finished ahead.`
      : `${winner.handle} finished at ${winner.entry.roiPct.toFixed(1)}% against ${loser.entry.roiPct.toFixed(1)}%.`,
  };
}

/**
 * The full public view of a duel: status, both sides, and — once the window
 * has closed and final records are in — the result.
 */
function view(duel, challenger, opponent, now) {
  const at = Math.trunc(Number(now) || 0);
  const status = statusOf(duel, at);
  const window = { startTs: Number(duel.startTs) || 0, endTs: Number(duel.endTs) || 0 };

  if (status === STATUS.OPEN || status === STATUS.EXPIRED) {
    return {
      code: duel.code, status, window,
      durationMs: window.endTs - window.startTs,
      challenger: { handle: challenger.handle, status: challenger.status || 'pending' },
      opponent: null,
      result: null,
    };
  }

  const a = side(challenger, window, at);
  const b = side(opponent, window, at);
  const closed = at >= window.endTs;
  // Settle when BOTH sides have filed — that is a real comparison — or once
  // the filing window has lapsed, which is the only circumstance in which a
  // forfeit is an honest description of what happened.
  const bothFiled = a.final && b.final;
  const graceUp = at >= window.endTs + SETTLE_GRACE_MS;
  const result = closed && (bothFiled || graceUp) ? settle(a, b) : null;

  return {
    code: duel.code,
    status: result ? STATUS.SETTLED : status,
    window,
    durationMs: window.endTs - window.startTs,
    challenger: a,
    opponent: b,
    // Live leader while the window runs — explicitly not a result.
    leading: !closed && a.entry && b.entry
      ? (a.entry.roiPct === b.entry.roiPct ? null
        : (a.entry.roiPct > b.entry.roiPct ? a.handle : b.handle))
      : null,
    result,
    // What the UI should tell players to do next, when there is something to do.
    awaiting: closed && !result
      ? (a.final || b.final
        ? `${a.final ? b.handle : a.handle} still needs a verified record from after the window closed.`
        : 'Both players still need a verified record from after the window closed.')
      : null,
  };
}

/** Why a join attempt is refused, or null when it may proceed. */
function joinProblem(duel, userId, now) {
  const status = statusOf(duel, now);
  if (status === STATUS.EXPIRED) return 'invite-expired';
  if (status !== STATUS.OPEN) return 'already-accepted';
  if (Number(duel.challengerId) === Number(userId)) return 'cannot-duel-yourself';
  return null;
}

module.exports = {
  STATUS, INVITE_TTL_MS, SETTLE_GRACE_MS,
  MIN_DURATION_MS, MAX_DURATION_MS, DEFAULT_DURATION_MS,
  DRAW_EPSILON,
  clampDuration, duelWindow, statusOf, side, settle, view, joinProblem,
};
