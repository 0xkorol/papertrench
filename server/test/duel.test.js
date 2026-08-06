/* Duels are the most cheatable-looking feature in the product: two people, real
 * stakes to their ego, and a result that has to come from evidence neither of
 * them controls. Every test here is an attack on that.
 *
 * The headline attack — "submit while I'm up, then go quiet when it turns" — is
 * the one the settlement rule exists to kill, and it gets the most coverage.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const D = require('../core/duel.js');
const { appendFill, GENESIS } = require('../core/chain.js');

const H = 3600000;
const START = Date.UTC(2026, 7, 3, 12); // mid-window anchor
const WINDOW = D.duelWindow(START, 24 * H);

async function chainOf(fills) {
  const links = [];
  let prev = GENESIS;
  for (const f of fills) {
    const link = await appendFill(prev, f);
    link.seq = links.length;
    links.push(link);
    prev = link.hash;
  }
  return links;
}

let seq = 0;
function buy(mint, sol, ts) {
  return { id: 'f' + (seq++), sessionId: 's', mint, side: 'buy',
           qty: sol * 1000, priceNative: 0.001, solGross: sol, solNet: sol * 0.99, ts };
}
function sell(mint, qty, price, ts) {
  const gross = qty * price;
  return { id: 'f' + (seq++), sessionId: 's', mint, side: 'sell',
           qty, priceNative: price, solGross: gross, solNet: gross * 0.99, ts };
}

/** A player whose chain holds one win and one loss inside the window. */
async function mixedPlayer(handle, userId) {
  seq += 50;
  return {
    handle, userId, startingSol: 10, status: 'verified',
    chain: await chainOf([
      buy('W', 1, WINDOW.startTs + 1 * H),
      sell('W', 1000, 0.002, WINDOW.startTs + 2 * H),   // +0.99
      buy('L', 1, WINDOW.startTs + 5 * H),
      sell('L', 1000, 0.0004, WINDOW.startTs + 6 * H),  // -0.59
    ]),
  };
}

/* ---------------- status machine ---------------- */

test('an unaccepted invite is open, then expires — it never silently starts', () => {
  const duel = { createdAt: START, acceptedAt: null, settledAt: null };
  assert.equal(D.statusOf(duel, START + H), D.STATUS.OPEN);
  assert.equal(D.statusOf(duel, START + D.INVITE_TTL_MS + 1), D.STATUS.EXPIRED);
});

test('accepting starts the clock; the window closing moves it to awaiting', () => {
  const duel = { createdAt: START, acceptedAt: START, settledAt: null,
                 startTs: WINDOW.startTs, endTs: WINDOW.endTs };
  assert.equal(D.statusOf(duel, WINDOW.startTs + H), D.STATUS.ACTIVE);
  assert.equal(D.statusOf(duel, WINDOW.endTs), D.STATUS.AWAITING);
  assert.equal(D.statusOf(duel, WINDOW.endTs + H), D.STATUS.AWAITING);
});

test('duration is clamped to sane bounds instead of trusting the request', () => {
  assert.equal(D.clampDuration(30 * 60000), D.MIN_DURATION_MS);
  assert.equal(D.clampDuration(999 * 24 * H), D.MAX_DURATION_MS);
  assert.equal(D.clampDuration('nonsense'), D.DEFAULT_DURATION_MS);
  assert.equal(D.clampDuration(-5), D.DEFAULT_DURATION_MS);
  assert.equal(D.clampDuration(6 * H), 6 * H);
});

test('you cannot duel yourself, join twice, or join a lapsed invite', () => {
  const open = { createdAt: START, acceptedAt: null, settledAt: null, challengerId: 1 };
  assert.equal(D.joinProblem(open, 2, START + H), null);
  assert.equal(D.joinProblem(open, 1, START + H), 'cannot-duel-yourself');
  assert.equal(D.joinProblem(open, 2, START + D.INVITE_TTL_MS + 1), 'invite-expired');
  const taken = Object.assign({}, open, { acceptedAt: START, startTs: WINDOW.startTs, endTs: WINDOW.endTs });
  assert.equal(D.joinProblem(taken, 3, START + H), 'already-accepted');
});

/* ---------------- THE attack: freeze a flattering snapshot ---------------- */

test('a mid-window submission is provisional and can never settle the duel', async () => {
  const player = await mixedPlayer('winner_early', 1);
  // Submitted right after the win, before the loss — the snapshot they want.
  player.submittedAt = WINDOW.startTs + 3 * H;
  const s = D.side(player, WINDOW, WINDOW.startTs + 4 * H);
  assert.equal(s.final, false, 'a mid-window submission must never be final');
  assert.equal(s.provisional, true);
});

test('going quiet after a good start forfeits — the snapshot is not a result', async () => {
  const sniper = await mixedPlayer('snapshot_sniper', 1);
  sniper.submittedAt = WINDOW.startTs + 3 * H;   // stopped submitting while ahead
  const honest = await mixedPlayer('submits_after', 2);
  honest.submittedAt = WINDOW.endTs + H;          // submitted after the close

  const now = WINDOW.endTs + 2 * H;
  const result = D.settle(D.side(sniper, WINDOW, now), D.side(honest, WINDOW, now));
  assert.equal(result.winner, 'submits_after');
  assert.equal(result.outcome, 'forfeit');
  assert.match(result.reason, /never filed a verified final record/);
});

test('a forfeit cannot be STOLEN by filing first at the bell', async () => {
  // The loser on returns files one minute after the close; the winner files
  // twenty minutes later. Declaring a forfeit in that gap would hand the duel
  // to whoever refreshed fastest, which has nothing to do with trading.
  seq = 900;
  const quick = {
    handle: 'quick_finger', userId: 1, startingSol: 10, status: 'verified',
    submittedAt: WINDOW.endTs + 60000,
    chain: await chainOf([
      buy('Q', 1, WINDOW.startTs + H), sell('Q', 1000, 0.0012, WINDOW.startTs + 2 * H),
    ]),
  };
  const betterChain = await chainOf([
    buy('B', 1, WINDOW.startTs + H), sell('B', 1000, 0.004, WINDOW.startTs + 2 * H),
  ]);
  const duel = { code: 'TRENCH-1234', createdAt: START, acceptedAt: WINDOW.startTs,
                 settledAt: null, startTs: WINDOW.startTs, endTs: WINDOW.endTs };

  // Five minutes after the bell, the server still holds `better`'s last
  // PRE-close submission — they simply have not filed again yet.
  const betterNotYet = {
    handle: 'traded_better', userId: 2, startingSol: 10, status: 'verified',
    submittedAt: WINDOW.startTs + 3 * H, chain: betterChain,
  };
  const gap = D.view(duel, quick, betterNotYet, WINDOW.endTs + 5 * 60000);
  assert.equal(gap.result, null, 'one filing must not settle the duel');
  assert.match(gap.awaiting, /traded_better still needs a verified record/);

  // Twenty minutes later they file, and the better trader wins on returns —
  // not the faster one.
  const betterFiled = Object.assign({}, betterNotYet, { submittedAt: WINDOW.endTs + 20 * 60000 });
  const done = D.view(duel, quick, betterFiled, WINDOW.endTs + 30 * 60000);
  assert.equal(done.result.outcome, 'by-return');
  assert.equal(done.result.winner, 'traded_better');
});

test('the post-close chain necessarily carries the losses — no hiding, only forfeiting', async () => {
  // Same player, same chain, judged from a post-close submission: the loss
  // that the mid-window snapshot omitted is unavoidably present.
  const player = await mixedPlayer('cannot_hide', 1);
  player.submittedAt = WINDOW.endTs + H;
  const s = D.side(player, WINDOW, WINDOW.endTs + 2 * H);
  assert.equal(s.final, true);
  assert.equal(s.entry.rounds, 2, 'both the win and the loss are in the window slice');
  assert.equal(s.entry.wins, 1);
  assert.equal(s.entry.losses, 1);
  assert.ok(s.entry.pnlSol < 0.99, 'the loss must drag the result below the win-only snapshot');
});

/* ---------------- outcomes ---------------- */

test('a real head-to-head is decided on window return, and says the numbers', async () => {
  seq = 200;
  const strong = {
    handle: 'strong', userId: 1, startingSol: 10, status: 'verified',
    submittedAt: WINDOW.endTs + H,
    chain: await chainOf([
      buy('A', 1, WINDOW.startTs + H), sell('A', 1000, 0.003, WINDOW.startTs + 2 * H),
    ]),
  };
  const weak = {
    handle: 'weak', userId: 2, startingSol: 10, status: 'verified',
    submittedAt: WINDOW.endTs + H,
    chain: await chainOf([
      buy('B', 1, WINDOW.startTs + H), sell('B', 1000, 0.0015, WINDOW.startTs + 2 * H),
    ]),
  };
  const now = WINDOW.endTs + 2 * H;
  const result = D.settle(D.side(strong, WINDOW, now), D.side(weak, WINDOW, now));
  assert.equal(result.winner, 'strong');
  assert.equal(result.outcome, 'by-return');
  assert.match(result.reason, /%/);
});

test('sitting out beats losing money, and the result says so', async () => {
  seq = 300;
  const patient = {
    handle: 'patient', userId: 1, startingSol: 10, status: 'verified',
    submittedAt: WINDOW.endTs + H,
    chain: await chainOf([buy('OLD', 1, WINDOW.startTs - 50 * H)]), // nothing in-window
  };
  const chaser = {
    handle: 'chaser', userId: 2, startingSol: 10, status: 'verified',
    submittedAt: WINDOW.endTs + H,
    chain: await chainOf([
      buy('C', 1, WINDOW.startTs + H), sell('C', 1000, 0.0002, WINDOW.startTs + 2 * H),
    ]),
  };
  const now = WINDOW.endTs + 2 * H;
  const result = D.settle(D.side(patient, WINDOW, now), D.side(chaser, WINDOW, now));
  assert.equal(result.winner, 'patient');
  assert.equal(result.outcome, 'by-inaction');
  assert.match(result.reason, /took no trades/);
});

test('neither settling is a no-contest, not a win for whoever bragged loudest', async () => {
  const a = await mixedPlayer('a', 1); a.submittedAt = WINDOW.startTs + H;
  const b = await mixedPlayer('b', 2); b.submittedAt = WINDOW.startTs + 2 * H;
  const now = WINDOW.endTs + H;
  const result = D.settle(D.side(a, WINDOW, now), D.side(b, WINDOW, now));
  assert.equal(result.winner, null);
  assert.equal(result.outcome, 'no-contest');
});

test('identical returns draw rather than tie-breaking on noise', async () => {
  seq = 400;
  const fills = [buy('T', 1, WINDOW.startTs + H), sell('T', 1000, 0.002, WINDOW.startTs + 2 * H)];
  const a = { handle: 'a', userId: 1, startingSol: 10, status: 'verified',
              submittedAt: WINDOW.endTs + H, chain: await chainOf(fills) };
  seq = 400; // identical fills → identical window entry
  const b = { handle: 'b', userId: 2, startingSol: 10, status: 'verified',
              submittedAt: WINDOW.endTs + H, chain: await chainOf(fills) };
  const now = WINDOW.endTs + 2 * H;
  const result = D.settle(D.side(a, WINDOW, now), D.side(b, WINDOW, now));
  assert.equal(result.winner, null);
  assert.equal(result.outcome, 'draw');
});

/* ---------------- the public view ---------------- */

test('an open invite exposes the challenger and nothing about a second player', () => {
  const duel = { code: 'TRENCH-1234', createdAt: START, acceptedAt: null, settledAt: null,
                 startTs: 0, endTs: 0 };
  const v = D.view(duel, { handle: 'challenger', status: 'verified' }, null, START + H);
  assert.equal(v.status, D.STATUS.OPEN);
  assert.equal(v.opponent, null);
  assert.equal(v.result, null);
});

test('a running duel shows a live leader that is explicitly not a result', async () => {
  const ahead = await mixedPlayer('ahead', 1);
  ahead.submittedAt = WINDOW.startTs + 3 * H;
  seq = 600;
  const behind = {
    handle: 'behind', userId: 2, startingSol: 10, status: 'verified',
    submittedAt: WINDOW.startTs + 3 * H,
    chain: await chainOf([
      buy('X', 1, WINDOW.startTs + H), sell('X', 1000, 0.0009, WINDOW.startTs + 2 * H),
    ]),
  };
  const duel = { code: 'TRENCH-1234', createdAt: START, acceptedAt: WINDOW.startTs,
                 settledAt: null, startTs: WINDOW.startTs, endTs: WINDOW.endTs };
  const v = D.view(duel, ahead, behind, WINDOW.startTs + 4 * H);
  assert.equal(v.status, D.STATUS.ACTIVE);
  assert.equal(v.leading, 'ahead');
  assert.equal(v.result, null, 'a running duel has no result, however far ahead someone is');
  assert.equal(v.challenger.provisional, true);
});

test('after the close with no final records, the view asks for them instead of inventing a winner', async () => {
  const a = await mixedPlayer('a', 1); a.submittedAt = WINDOW.startTs + H;
  const b = await mixedPlayer('b', 2); b.submittedAt = WINDOW.startTs + H;
  const duel = { code: 'TRENCH-1234', createdAt: START, acceptedAt: WINDOW.startTs,
                 settledAt: null, startTs: WINDOW.startTs, endTs: WINDOW.endTs };
  const v = D.view(duel, a, b, WINDOW.endTs + H);
  assert.equal(v.status, D.STATUS.AWAITING);
  assert.equal(v.result, null);
  assert.match(v.awaiting, /verified record from after the window closed/);
});

test('a duel nobody settles becomes a no-contest instead of hanging forever', async () => {
  const a = await mixedPlayer('a', 1); a.submittedAt = WINDOW.startTs + H;
  const b = await mixedPlayer('b', 2); b.submittedAt = WINDOW.startTs + H;
  const duel = { code: 'TRENCH-1234', createdAt: START, acceptedAt: WINDOW.startTs,
                 settledAt: null, startTs: WINDOW.startTs, endTs: WINDOW.endTs };

  // Inside the grace period: still waiting, and it says so.
  const waiting = D.view(duel, a, b, WINDOW.endTs + D.SETTLE_GRACE_MS - H);
  assert.equal(waiting.result, null);
  assert.equal(waiting.status, D.STATUS.AWAITING);

  // Past it: settled as what it actually was.
  const done = D.view(duel, a, b, WINDOW.endTs + D.SETTLE_GRACE_MS + H);
  assert.equal(done.status, D.STATUS.SETTLED);
  assert.equal(done.result.outcome, 'no-contest');
  assert.equal(done.result.winner, null);
});

test('the grace period never overrides a real forfeit result', async () => {
  const ghosted = await mixedPlayer('ghosted', 1); ghosted.submittedAt = WINDOW.startTs + H;
  const honest = await mixedPlayer('honest', 2); honest.submittedAt = WINDOW.endTs + H;
  const duel = { code: 'TRENCH-1234', createdAt: START, acceptedAt: WINDOW.startTs,
                 settledAt: null, startTs: WINDOW.startTs, endTs: WINDOW.endTs };
  const view = D.view(duel, ghosted, honest, WINDOW.endTs + D.SETTLE_GRACE_MS + H);
  assert.equal(view.result.outcome, 'forfeit');
  assert.equal(view.result.winner, 'honest');
});

test('a player who never submitted at all is missing, not zeroed into a loss silently', () => {
  const ghost = { handle: 'ghost', userId: 2, startingSol: 10, chain: null, submittedAt: 0 };
  const s = D.side(ghost, WINDOW, WINDOW.endTs + H);
  assert.equal(s.missing, true);
  assert.equal(s.entry, null);
  assert.equal(s.final, false);
});

test('a stored entry and a freshly derived one produce the identical side', async () => {
  // The worker precomputes entries at submission time so a duel view never
  // re-walks a lifetime chain. That shortcut is only safe if both paths agree.
  const player = await mixedPlayer('both_paths', 1);
  player.submittedAt = WINDOW.endTs + H;
  const now = WINDOW.endTs + 2 * H;

  const derived = D.side(player, WINDOW, now);
  const stored = D.side(
    { handle: player.handle, userId: player.userId, status: player.status,
      submittedAt: player.submittedAt, entry: derived.entry },
    WINDOW, now
  );
  assert.deepEqual(stored, derived);
});

test('an unverified record cannot file final — partial is not a way to win a duel', async () => {
  // attest.js is public: a fabricated chain of unlisted mints hashes fine
  // and re-prices to 'partial' (all no-data, nothing disproved). If that
  // counted as filing, a fabricator would beat every honest record here —
  // and settlement persists, so the win would read the same forever.
  const fabricator = await mixedPlayer('fabricator', 1);
  fabricator.status = 'partial';
  fabricator.submittedAt = WINDOW.endTs + H;      // filed post-close, on time
  const honest = await mixedPlayer('honest_one', 2);
  honest.submittedAt = WINDOW.endTs + H;

  const inGrace = WINDOW.endTs + 2 * H;
  const fab = D.side(fabricator, WINDOW, inGrace);
  assert.equal(fab.final, false, 'a partial record must not be a final filing');

  // Inside the grace window nothing settles on it — their pricing may still
  // genuinely be running. Once grace is up, the unverified side forfeits.
  const duel = { code: 'TRENCH-1234', createdAt: START, acceptedAt: WINDOW.startTs,
                 settledAt: null, startTs: WINDOW.startTs, endTs: WINDOW.endTs };
  assert.equal(D.view(duel, fabricator, honest, inGrace).result, null,
    'an in-flight verification must not be rushed into a forfeit');
  const after = D.view(duel, fabricator, honest, WINDOW.endTs + D.SETTLE_GRACE_MS + H);
  assert.equal(after.result.winner, 'honest_one');
  assert.equal(after.result.outcome, 'forfeit');
});
