/* Tests for the perps paper book engine (perps.js).
 *
 * The two maintainer scenarios are locked end-to-end with hand-derived
 * arithmetic: $10 at 20x on Hyperliquid, $5 at 100x on Jupiter — every fee,
 * funding/borrow charge, liquidation price, and payout derived inside the
 * test from the venue-cited constants. Plus refusal-path coverage (no
 * silent third state) and a seeded conservation walk: cash truth must hold
 * across any operation sequence.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

global.window = global.window || {};
require('../perps-venues.js');
require('../perps.js');
const P = global.window.PaperPerps;

const CLOSE = 1e-9;
const HL = { maxLeverage: 20 };
const JUP = { impactScalarAdjUsd: 125000000000 };

function fresh() { return P.defaultPerpsState({ perpsStartUsd: 1000 }); }

/* Cash truth over a book that may have been TRIMMED: the dollars a dropped
 * journal entry moved are carried in `archived`, so the reconciliation is
 * exact whether or not anything was ever dropped. Trimming may drop detail;
 * it may never drop dollars. */
function journalCashSum(state) {
  const archived = (state.archived && state.archived.journalCashUsd) || 0;
  return archived + state.journal.reduce((a, e) => a + e.cashDeltaUsd, 0);
}

test('perps engine installs its public API on the browser global', () => {
  for (const fn of ['defaultPerpsState', 'openPerp', 'perpMark', 'markPerp', 'applyHlFunding',
    'accrueJupBorrow', 'closePerp', 'liquidatePerp']) {
    assert.equal(typeof P[fn], 'function', `${fn} must be exported`);
  }
});

/* ------------------------------ retention ------------------------------ */

test('the book is capped, and trimming drops detail without dropping dollars', () => {
  // Funded through the opening balance so cash truth holds, and kept at a
  // realistic magnitude: a reconciliation asserted at 1e9 measures double
  // precision, not the engine.
  const START = 1000;
  const s = P.defaultPerpsState({ perpsStartUsd: START });
  let t = 1000;
  // Enough round trips to blow past the journal cap several times over.
  for (let i = 0; i < 600; i++) {
    t += 60;
    const r = P.openPerp(s, {
      venue: 'hyperliquid', market: 'SOL', side: i % 2 ? 'short' : 'long',
      marginUsd: 10, leverage: 5, price: 100, t, params: HL,
    });
    P.closePerp(s, r.id, { price: 100.5, t: t + 30 });
  }
  assert.ok(s.journal.length <= 400, `journal must stay capped, saw ${s.journal.length}`);
  assert.ok(s.archived.journalCount > 0, 'and must record what it dropped');
  assert.equal(s.archived.journalCount + s.journal.length, 1200,
    'every fill is either present or counted — never simply gone');

  // The whole point: the wallet still reconciles exactly.
  assert.ok(Math.abs(START + journalCashSum(s) - s.cashUsd) < 1e-6,
    'a trimmed book must still reconcile to the cent');
});

test('rounds — the track record — outlive the journal by a wide margin', () => {
  const s = P.defaultPerpsState({ perpsStartUsd: 1000 });
  let t = 1000;
  for (let i = 0; i < 600; i++) {
    t += 60;
    const r = P.openPerp(s, {
      venue: 'hyperliquid', market: 'SOL', side: 'long',
      marginUsd: 10, leverage: 5, price: 100, t, params: HL,
    });
    P.closePerp(s, r.id, { price: 101, t: t + 30 });
  }
  // Graduation asks for 50+ closed round trips and the mastery stats read the
  // most recent 30. A cap that could bite either would make the product lie
  // about its own sample.
  assert.equal(s.rounds.length, 600, 'no round is dropped anywhere near the sizes the product reads');
  assert.equal(s.archived.roundsCount, 0);
  assert.ok(s.journal.length < s.rounds.length,
    'per-fill detail is the cheap thing to drop; the record is not');
});

test('when the rounds cap DOES bite, every dropped round is counted', () => {
  // The cap sits far above what the product reads, but "far above" is not
  // "never" — a heavy account reaches it eventually, and a sample size that
  // silently shrinks is the product lying about its own track record.
  const s = P.defaultPerpsState({ perpsStartUsd: 1000 });
  let t = 1000;
  const TRIPS = 1100;
  for (let i = 0; i < TRIPS; i++) {
    t += 60;
    const r = P.openPerp(s, {
      venue: 'hyperliquid', market: 'SOL', side: 'long',
      marginUsd: 10, leverage: 5, price: 100, t, params: HL,
    });
    P.closePerp(s, r.id, { price: 100.2, t: t + 30 });
  }
  assert.equal(s.rounds.length, 1000, 'the rounds ring must actually cap');
  assert.equal(s.archived.roundsCount, TRIPS - 1000, 'and must count exactly what it dropped');
  assert.equal(s.rounds.length + s.archived.roundsCount, TRIPS,
    'every closed round is either kept or counted — a shrinking sample must never be silent');
  // The oldest survivor is the (TRIPS-1000)th round, not the first.
  assert.equal(s.rounds[0].openT, 1000 + (TRIPS - 1000 + 1) * 60,
    'the ring drops from the front, keeping the most recent record');
});

test('every journal write goes through the capping helper', () => {
  // A source contract: a new operation that pushes directly would grow the
  // book without bound, and the defect would only show up months later as a
  // slow account.
  const src = fs.readFileSync(path.join(__dirname, '..', 'perps.js'), 'utf8');
  const body = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const direct = body.match(/state\.journal\.push\(/g) || [];
  assert.equal(direct.length, 1,
    'state.journal.push may appear ONLY inside noteJournal, which caps as it writes');
  assert.match(body, /function noteJournal\(state, entry\) \{\s*state\.journal\.push\(entry\);\s*trimBook\(state\);/,
    'noteJournal must push and then trim');
});

/* ------------------- the pure mark and its committing twin -------------------
 *
 * perpMark answers "where does this position stand?" without a book and
 * without a write; markPerp is the same arithmetic, stamped. Two numbers for
 * the same question computed two different ways is how a screen and a fill
 * come to disagree, so the equivalence is pinned here rather than assumed.
 */

function siblingBook() {
  const s = fresh();
  const a = P.openPerp(s, {
    venue: 'hyperliquid', market: 'SOL', side: 'long',
    marginUsd: 10, leverage: 20, price: 100, t: 1000, params: HL,
  });
  const b = P.openPerp(s, {
    venue: 'hyperliquid', market: 'SOL', side: 'short',
    marginUsd: 25, leverage: 5, price: 100, t: 1000, params: HL,
  });
  const c = P.openPerp(s, {
    venue: 'jupiter', market: 'SOL', side: 'long',
    marginUsd: 20, leverage: 10, price: 100, t: 1000, params: JUP,
  });
  assert.ok(a.ok && b.ok && c.ok, 'the sibling fixture must open');
  // History the old whole-book clone used to copy on every single render.
  s.journal = s.journal.concat(new Array(300).fill(0).map((_, i) => ({ t: i, kind: 'noise' })));
  return { state: s, ids: [a.id, b.id, c.id] };
}

test('perpMark equals markPerp on a SIBLING book and on a LONE book alike', () => {
  // Both shapes are required. With only the sibling book, an edit that reads
  // a neighbouring position could still agree with itself; with only a lone
  // book, a cross-margin edit is invisible because there is nothing to cross
  // to. The fixture sizes are asserted so neither can silently decay.
  const { state: sib, ids } = siblingBook();
  assert.equal(Object.keys(sib.positions).length, 3, 'the sibling book must really have siblings');

  const lone = fresh();
  const only = P.openPerp(lone, {
    venue: 'hyperliquid', market: 'SOL', side: 'long',
    marginUsd: 10, leverage: 20, price: 100, t: 1000, params: HL,
  });
  assert.equal(Object.keys(lone.positions).length, 1, 'the lone book must really be alone');

  const cases = [[sib, ids[0]], [sib, ids[1]], [sib, ids[2]], [lone, only.id]];
  let sawLiquidatable = false;
  for (const [book, id] of cases) {
    for (const px of [100, 101.5, 99.4, 97.2, 60, 1]) {
      const pure = P.perpMark(book.positions[id], px);
      const committing = P.markPerp(JSON.parse(JSON.stringify(book)), id, { price: px });
      assert.equal(pure.ok, committing.ok, `ok must match (id ${id} @ ${px})`);
      if (!pure.ok) { assert.equal(pure.reason, committing.reason); continue; }
      assert.equal(pure.liquidatable, committing.liquidatable,
        `the liquidation verdict must be identical (id ${id} @ ${px}) — this is the whole point`);
      assert.equal(pure.liqBreached, committing.liqBreached, `liqBreached (id ${id} @ ${px})`);
      for (const k of ['uPnlUsd', 'equityUsd', 'liqPx']) {
        const a = pure[k], b = committing[k];
        if (a === null || b === null) assert.equal(a, b, `${k} (id ${id} @ ${px})`);
        else assert.ok(Math.abs(a - b) < CLOSE, `${k} must match (id ${id} @ ${px})`);
      }
      if (pure.liquidatable) sawLiquidatable = true;
    }
  }
  assert.ok(sawLiquidatable, 'some case must actually be liquidatable, or this passes vacuously');
});

test('perpMark writes NOTHING — proven against a frozen position', () => {
  const { state, ids } = siblingBook();
  const pos = state.positions[ids[0]];
  Object.freeze(pos);
  // perps.js is strict mode, so a write throws rather than failing silently.
  const m = P.perpMark(pos, 97);
  assert.equal(m.ok, true, 'the pure mark must answer against a frozen position');
  assert.ok(Number.isFinite(m.liqPx));
  // And its twin must genuinely be the mutating one — if markPerp stopped
  // committing, the two would be indistinguishable and the split pointless.
  assert.throws(() => P.markPerp({ positions: { [ids[0]]: pos } }, ids[0], { price: 97 }),
    /read only|not extensible|Cannot assign/,
    'markPerp must still write: the commit paths depend on it');
});

test('markPerp still stamps the book (lastPx, liqPx, liqBreached)', () => {
  const s = fresh();
  const { id } = P.openPerp(s, {
    venue: 'hyperliquid', market: 'SOL', side: 'long',
    marginUsd: 10, leverage: 20, price: 100, t: 1000, params: HL,
  });
  const m = P.markPerp(s, id, { price: 98.5 });
  assert.equal(m.ok, true);
  const pos = s.positions[id];
  assert.equal(pos.lastPx, 98.5, 'the stored mark must advance on a committed mark');
  assert.ok(Math.abs(pos.liqPx - m.liqPx) < CLOSE, 'and the stored liq price must be what it reported');
  assert.equal(pos.liqBreached, m.liqBreached);
});

test('perpMark takes a position and a price — no book in its signature', () => {
  // A source tripwire for the property the equivalence test proves: a book in
  // scope is what would let a future edit read a sibling position.
  assert.equal(P.perpMark.length, 2, 'perpMark(pos, px)');
  const src = P.perpMark.toString().replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/\bstate\b/.test(src), 'no book may appear inside the pure mark');
});

/* ------------------- scenario: $10 at 20x on Hyperliquid ------------------- */

test('$10 at 20x long on Hyperliquid: notional, fee, liq price, funding, close — hand-derived', () => {
  const s = fresh();
  const r = P.openPerp(s, {
    venue: 'hyperliquid', market: 'SOL', side: 'long',
    marginUsd: 10, leverage: 20, price: 100, t: 1000, params: HL,
  });
  assert.equal(r.ok, true);
  const pos = r.position;

  // Notional $200 → 2 units; taker fee 200 * 0.00045 = $0.09 off the WALLET.
  assert.ok(Math.abs(pos.sizeUnits - 2) < CLOSE);
  assert.ok(Math.abs(pos.feesUsd - 0.09) < CLOSE);
  assert.ok(Math.abs(s.cashUsd - (1000 - 10 - 0.09)) < CLOSE, 'HL fee debits cash, margin arrives intact');
  assert.ok(Math.abs(pos.marginUsd - 10) < CLOSE);

  // liq = 100 - ((10 - 0.025*2*100)/2)/(1-0.025): a 2.56% adverse move.
  const liqExpected = 100 - ((10 - 0.025 * 2 * 100) / 2) / 0.975;
  assert.ok(Math.abs(pos.liqPx - liqExpected) < CLOSE);
  assert.ok(100 - pos.liqPx < 2.6, '20x means ~2.5% of adverse move to liquidation');

  // Mark at 99: uPnL = 2*(99-100) = -$2, equity $8, not liquidatable.
  const m = P.markPerp(s, pos.id, { price: 99 });
  assert.ok(Math.abs(m.uPnlUsd - -2) < CLOSE);
  assert.ok(Math.abs(m.equityUsd - 8) < CLOSE);
  assert.equal(m.liquidatable, false);

  // One hourly funding event at the fixture-observed rate: long pays
  // 2 * 99 * 0.0000125 = $0.002475 out of isolated margin.
  const f = P.applyHlFunding(s, pos.id, [{ t: 4600, hourlyRateFrac: 0.0000125, oraclePx: 99 }], { markPx: 99 });
  assert.equal(f.ok, true);
  assert.ok(Math.abs(pos.marginUsd - (10 - 0.002475)) < CLOSE);
  assert.ok(Math.abs(f.fundingPaidUsd - 0.002475) < CLOSE);

  // Close at 105: pnl = 2*5 = $10; fee = 210*0.00045 = $0.0945;
  // payout = margin + pnl - fee.
  const c = P.closePerp(s, pos.id, { price: 105, t: 9000 });
  assert.equal(c.ok, true);
  assert.equal(c.fullyClosed, true);
  const expectedPayout = (10 - 0.002475) + 10 - 0.0945;
  assert.ok(Math.abs(c.payoutUsd - expectedPayout) < CLOSE);
  assert.ok(Math.abs(s.cashUsd - (1000 - 10.09 + expectedPayout)) < CLOSE);

  // Round record: cash truth — payout minus the $10 that went in.
  assert.equal(s.rounds.length, 1);
  const round = s.rounds[0];
  assert.equal(round.cause, 'close');
  assert.ok(Math.abs(round.netUsd - (expectedPayout - 10)) < CLOSE);
  assert.ok(Math.abs(round.feesUsd - (0.09 + 0.0945)) < CLOSE);
  assert.ok(Math.abs(round.carryUsd - 0.002475) < CLOSE);

  // Journal cash deltas reconcile with the wallet to the cent and beyond.
  assert.ok(Math.abs(1000 + journalCashSum(s) - s.cashUsd) < CLOSE);
});

test('Hyperliquid liquidation: fill at liq price, taker fee, residual returned, round stamped', () => {
  const s = fresh();
  const { position: pos } = P.openPerp(s, {
    venue: 'hyperliquid', market: 'SOL', side: 'long',
    marginUsd: 10, leverage: 20, price: 100, t: 1000, params: HL,
  });
  const liqPx = pos.liqPx;

  // Price crosses the liquidation price: a voluntary close must refuse…
  const blocked = P.closePerp(s, pos.id, { price: liqPx - 0.01, t: 2000 });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'beyond-liquidation');

  // …and the liquidation path executes at the liquidation price.
  const cashBefore = s.cashUsd;
  const l = P.liquidatePerp(s, pos.id, { price: liqPx - 0.01, t: 2000 });
  assert.equal(l.ok, true);
  const pnlAtLiq = 2 * (liqPx - 100);
  const fee = 2 * liqPx * 0.00045;
  const residual = Math.max(0, 10 + pnlAtLiq - fee);
  assert.ok(Math.abs(l.payoutUsd - residual) < CLOSE);
  assert.ok(Math.abs(s.cashUsd - (cashBefore + residual)) < CLOSE);
  assert.equal(s.rounds[0].cause, 'liquidated');
  assert.ok(Math.abs(s.rounds[0].netUsd - (residual - 10)) < CLOSE);
});

test('Hyperliquid refuses liquidation when the price has not crossed', () => {
  const s = fresh();
  const { position: pos } = P.openPerp(s, {
    venue: 'hyperliquid', market: 'SOL', side: 'long',
    marginUsd: 10, leverage: 20, price: 100, t: 1000, params: HL,
  });
  const r = P.liquidatePerp(s, pos.id, { price: pos.liqPx + 1, t: 2000 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-liquidatable');
});

/* ------------------- scenario: $5 at 100x on Jupiter ------------------- */

test('$5 at 100x long on Jupiter: fees off collateral, liq under 0.7% away — hand-derived', () => {
  const s = fresh();
  const r = P.openPerp(s, {
    venue: 'jupiter', market: 'SOL', side: 'long',
    marginUsd: 5, leverage: 100, price: 100, t: 1000, params: JUP,
  });
  assert.equal(r.ok, true);
  const pos = r.position;

  // Size $500; open fee = 500*0.0006 + 500²/1.25e11 = $0.300002 from COLLATERAL.
  const openFee = 500 * 0.0006 + (500 * 500) / 125000000000;
  assert.ok(Math.abs(pos.sizeUsd - 500) < CLOSE);
  assert.ok(Math.abs(pos.collateralUsd - (5 - openFee)) < CLOSE);
  assert.ok(Math.abs(s.cashUsd - 995) < CLOSE, 'Jupiter deducts fees inside the position, cash pays margin only');

  // liq = 100 - ((collateral - closeFeeEst - maint) * 100)/500 — maint is
  // size/500 = $1. Six percent of the margin went to fees before the first
  // tick, and the liq price sits ~0.68% below entry. That is 100x.
  const free = (5 - openFee) - openFee - 500 / 500;
  const liqExpected = 100 - (free * 100) / 500;
  assert.ok(Math.abs(pos.liqPx - liqExpected) < CLOSE);
  assert.ok(100 - pos.liqPx < 0.7, 'under 0.7% adverse move liquidates $5 at 100x');

  // Two hours of borrow at the doc-example rate drags liq closer.
  const rate = (12 / 100000) * (200 / 1010);
  const liqBefore = pos.liqPx;
  const b = P.accrueJupBorrow(s, pos.id, { toT: 1000 + 7200, hourlyRateFrac: rate });
  assert.equal(b.ok, true);
  assert.ok(Math.abs(pos.borrowUsd - rate * 500 * 2) < CLOSE);
  assert.ok(pos.liqPx > liqBefore, 'borrow accrual drags a long liq price toward the market');

  // Close in profit at 102: pnl = 500*2/100 = $10;
  // payout = collateral + pnl - closeFee - borrow.
  const c = P.closePerp(s, pos.id, { price: 102, t: 1000 + 7200 });
  assert.equal(c.ok, true);
  const expectedPayout = (5 - openFee) + 10 - openFee - rate * 500 * 2;
  assert.ok(Math.abs(c.payoutUsd - expectedPayout) < CLOSE);
  assert.equal(s.rounds.length, 1);
  assert.ok(Math.abs(s.rounds[0].netUsd - (expectedPayout - 5)) < CLOSE);
  assert.ok(Math.abs(1000 + journalCashSum(s) - s.cashUsd) < CLOSE);
});

test('Jupiter liquidation forfeits ALL remaining collateral — zero back, net is the full margin', () => {
  const s = fresh();
  const { position: pos } = P.openPerp(s, {
    venue: 'jupiter', market: 'SOL', side: 'long',
    marginUsd: 5, leverage: 100, price: 100, t: 1000, params: JUP,
  });
  const m = P.markPerp(s, pos.id, { price: pos.liqPx - 0.01 });
  assert.equal(m.liquidatable, true);
  const cashBefore = s.cashUsd;
  const l = P.liquidatePerp(s, pos.id, { price: pos.liqPx - 0.01, t: 2000 });
  assert.equal(l.ok, true);
  assert.equal(l.payoutUsd, 0);
  assert.equal(s.cashUsd, cashBefore, 'nothing comes back from a Jupiter liquidation');
  assert.equal(s.rounds[0].cause, 'liquidated');
  assert.ok(Math.abs(s.rounds[0].netUsd - -5) < CLOSE, 'the entire $5 margin is gone');
});

/* --------------------------- refusal paths --------------------------- */

test('every invalid open is refused with a machine-readable reason — no third state', () => {
  const s = fresh();
  const base = { venue: 'hyperliquid', market: 'SOL', side: 'long', marginUsd: 10, leverage: 20, price: 100, t: 1000, params: HL };
  const cases = [
    [{ venue: 'axiom' }, 'venue-unverified'],
    [{ venue: 'binance' }, 'venue-unknown'],
    [{ side: 'sideways' }, 'bad-side'],
    [{ price: 0 }, 'bad-price'],
    [{ price: NaN }, 'bad-price'],
    [{ t: 1.5 }, 'bad-time'],
    [{ marginUsd: 0 }, 'bad-margin'],
    [{ marginUsd: 5000 }, 'insufficient-cash'],
    [{ leverage: 25 }, 'leverage-above-max'],
    [{ leverage: 0.5 }, 'leverage-below-min'],
    [{ params: {} }, 'max-leverage-unavailable'],
  ];
  for (const [over, reason] of cases) {
    const r = P.openPerp(s, Object.assign({}, base, over));
    assert.equal(r.ok, false, JSON.stringify(over));
    assert.equal(r.reason, reason, JSON.stringify(over));
  }
  assert.equal(Object.keys(s.positions).length, 0, 'no refused open may leave a position behind');
  assert.equal(s.cashUsd, 1000, 'no refused open may move cash');

  const jupBase = { venue: 'jupiter', market: 'ETH', side: 'long', marginUsd: 5, leverage: 100, price: 100, t: 1000, params: {} };
  assert.equal(P.openPerp(s, jupBase).reason, 'impact-scalar-unavailable',
    'a fill whose cost we cannot state truthfully is refused');
  assert.equal(P.openPerp(s, Object.assign({}, jupBase, { params: JUP, leverage: 300 })).reason, 'leverage-above-max');
  assert.equal(P.openPerp(s, Object.assign({}, jupBase, { params: JUP, leverage: 1.05 })).reason, 'leverage-below-min');
  const crushed = P.openPerp(s, Object.assign({}, jupBase, {
    params: Object.assign({ additiveImpactUsd: 0.4 }, JUP), marginUsd: 1, leverage: 250,
  }));
  assert.equal(crushed.reason, 'collateral-below-maintenance');
});

test('operations on missing or closed positions are refused', () => {
  const s = fresh();
  assert.equal(P.markPerp(s, 99, { price: 100 }).reason, 'unknown-position');
  assert.equal(P.closePerp(s, 99, { price: 100, t: 2000 }).reason, 'unknown-position');
  assert.equal(P.applyHlFunding(s, 99, []).reason, 'unknown-position');
  assert.equal(P.accrueJupBorrow(s, 99, { toT: 2000, hourlyRateFrac: 0 }).reason, 'unknown-position');

  const { id } = P.openPerp(s, { venue: 'hyperliquid', market: 'SOL', side: 'long', marginUsd: 10, leverage: 20, price: 100, t: 1000, params: HL });
  assert.equal(P.accrueJupBorrow(s, id, { toT: 2000, hourlyRateFrac: 0 }).reason, 'wrong-venue');
  P.closePerp(s, id, { price: 100, t: 2000 });
  assert.equal(P.closePerp(s, id, { price: 100, t: 3000 }).reason, 'unknown-position');
});

test('partial close: two slices settle like one, and the round records the whole trip', () => {
  const s = fresh();
  const { id } = P.openPerp(s, {
    venue: 'hyperliquid', market: 'SOL', side: 'long',
    marginUsd: 10, leverage: 20, price: 100, t: 1000, params: HL,
  });
  const half = P.closePerp(s, id, { price: 104, t: 2000, fraction: 0.5 });
  assert.equal(half.ok, true);
  assert.equal(half.fullyClosed, false);
  // Half the units at 104: pnl = 1*4; fee = 104*0.00045; margin released $5.
  assert.ok(Math.abs(half.payoutUsd - (5 + 4 - 104 * 0.00045)) < CLOSE);

  const rest = P.closePerp(s, id, { price: 102, t: 3000 });
  assert.equal(rest.fullyClosed, true);
  assert.ok(Math.abs(rest.payoutUsd - (5 + 2 - 102 * 0.00045)) < CLOSE);
  assert.equal(s.rounds.length, 1, 'one position, one round');
  const totalPayout = half.payoutUsd + rest.payoutUsd;
  assert.ok(Math.abs(s.rounds[0].netUsd - (totalPayout - 10)) < CLOSE, 'round net is cash truth across slices');
});

/* ------------------- carry and staleness: the stored copy ------------------- */

test('a partial close refreshes the stored liquidation price it just invalidated', () => {
  // closePerp moves every input of the Jupiter formula (size, collateral,
  // borrow owed). The commit paths — closePerp's own beyond-liquidation gate,
  // liquidatePerp, and the offline reconciler — all read the STORED copy, so
  // leaving it stale prices the survivor at a size it no longer has.
  const s = fresh();
  const { id } = P.openPerp(s, {
    venue: 'jupiter', market: 'SOL', side: 'long',
    marginUsd: 20, leverage: 20, price: 100, t: 1000, params: JUP,
  });
  P.accrueJupBorrow(s, id, { toT: 1000 + 7200, hourlyRateFrac: 0.00002 });
  const before = s.positions[id].liqPx;

  const r = P.closePerp(s, id, { price: 101, t: 1000 + 7200, fraction: 0.5 });
  assert.equal(r.ok, true);
  const pos = s.positions[id];
  assert.notEqual(pos.liqPx, before, 'halving the position must move its liquidation price');
  // The stored copy must equal what the pure mark computes from the position
  // as it now stands — one arithmetic, not a stale snapshot of an older one.
  const fresh2 = P.perpMark(pos, 101);
  assert.ok(Math.abs(pos.liqPx - fresh2.liqPx) < CLOSE,
    'the stored liq price must match what the position now implies');
  assert.ok(Math.abs(pos.closeFeeEstUsd - (pos.sizeUsd * 0.0006 + (pos.sizeUsd ** 2) / 125000000000)) < CLOSE,
    'and the stored close-fee estimate must be for the size that remains');
});

test('funding is applied at a mark the CALLER supplies, never a stale stored one', () => {
  const s = fresh();
  const { id } = P.openPerp(s, {
    venue: 'hyperliquid', market: 'SOL', side: 'long',
    marginUsd: 10, leverage: 20, price: 100, t: 1000, params: HL,
  });
  const ev = [{ t: 4600, hourlyRateFrac: 0.0000125, oraclePx: 99 }];
  // No mark, no funding: the engine must not reach for pos.lastPx, which the
  // read paths never advance (they mark their own copies), so it can be as
  // old as the position itself.
  assert.equal(P.applyHlFunding(s, id, ev).reason, 'bad-price');
  assert.equal(P.applyHlFunding(s, id, ev, {}).reason, 'bad-price');
  assert.equal(P.applyHlFunding(s, id, ev, { markPx: 0 }).reason, 'bad-price');
  assert.equal(s.positions[id].fundingPaidUsd, 0, 'a refused call must charge nothing');

  const ok = P.applyHlFunding(s, id, ev, { markPx: 99 });
  assert.equal(ok.ok, true);
  assert.ok(Math.abs(ok.fundingPaidUsd - 2 * 99 * 0.0000125) < CLOSE);
  assert.ok(Math.abs(s.positions[id].liqPx - P.perpMark(s.positions[id], 99).liqPx) < CLOSE,
    'the refreshed liq price must be the one the current position implies');
});

test('a bad funding event charges nothing at all — no half-applied batch', () => {
  const s = fresh();
  const { id } = P.openPerp(s, {
    venue: 'hyperliquid', market: 'SOL', side: 'long',
    marginUsd: 10, leverage: 20, price: 100, t: 1000, params: HL,
  });
  const marginBefore = s.positions[id].marginUsd;
  const r = P.applyHlFunding(s, id, [
    { t: 4600, hourlyRateFrac: 0.0000125, oraclePx: 99 },   // good
    { t: 8200, hourlyRateFrac: 'oops', oraclePx: 99 },      // bad
  ], { markPx: 99 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad-funding-event');
  assert.equal(s.positions[id].marginUsd, marginBefore,
    'the good event must not have been applied — margin moved with totals unmoved is a torn write');
  assert.equal(s.positions[id].fundingPaidUsd, 0);
  assert.equal(s.totals.fundingPaidUsd, 0);
});

test('borrow accrual refuses time running backwards', () => {
  const s = fresh();
  const { id } = P.openPerp(s, { venue: 'jupiter', market: 'SOL', side: 'long', marginUsd: 5, leverage: 50, price: 100, t: 5000, params: JUP });
  assert.equal(P.accrueJupBorrow(s, id, { toT: 4000, hourlyRateFrac: 0.0001 }).reason, 'time-went-backwards');
});

/* ------------------------- conservation walk ------------------------- */

test('cash truth holds across a seeded random walk of every operation', () => {
  // Deterministic LCG — no Math.random in tests.
  let seed = 42;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

  const s = fresh();
  let t = 10000;
  for (let step = 0; step < 400; step++) {
    t += 60;
    const ids = Object.keys(s.positions);
    const roll = rnd();
    if (roll < 0.3 && s.cashUsd > 20) {
      const jup = rnd() < 0.5;
      P.openPerp(s, {
        venue: jup ? 'jupiter' : 'hyperliquid', market: 'SOL',
        side: rnd() < 0.5 ? 'long' : 'short',
        marginUsd: 5 + Math.floor(rnd() * 10), leverage: jup ? 1.1 + rnd() * 90 : 1 + Math.floor(rnd() * 19),
        price: 90 + rnd() * 20, t, params: jup ? JUP : HL,
      });
    } else if (ids.length) {
      const pos = s.positions[ids[Math.floor(rnd() * ids.length)]];
      const px = 90 + rnd() * 20;
      const m = P.markPerp(s, pos.id, { price: px });
      if (m.ok && m.liquidatable) {
        P.liquidatePerp(s, pos.id, { price: px, t });
      } else if (roll < 0.6) {
        P.closePerp(s, pos.id, { price: px, t, fraction: rnd() < 0.3 ? 0.5 : 1 });
      } else if (pos.venue === 'hyperliquid') {
        P.applyHlFunding(s, pos.id, [{ t, hourlyRateFrac: (rnd() - 0.5) * 0.0002, oraclePx: px }], { markPx: px });
      } else {
        P.accrueJupBorrow(s, pos.id, { toT: t, hourlyRateFrac: rnd() * 0.0001 });
      }
    }
    assert.ok(Number.isFinite(s.cashUsd), 'cash must never go NaN');
    assert.ok(s.cashUsd > -CLOSE, 'isolated margin: the book cannot go negative');
  }
  // The wallet must reconcile with the journal to numerical precision:
  // every dollar is a journal line, every journal line is a dollar.
  assert.ok(Math.abs(1000 + journalCashSum(s) - s.cashUsd) < 1e-6,
    `journal says ${1000 + journalCashSum(s)}, wallet says ${s.cashUsd}`);
  // And the whole book survives persistence.
  const revived = JSON.parse(JSON.stringify(s));
  assert.equal(revived.cashUsd, s.cashUsd);
});
