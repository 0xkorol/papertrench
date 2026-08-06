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

global.window = global.window || {};
require('../perps-venues.js');
require('../perps.js');
const P = global.window.PaperPerps;

const CLOSE = 1e-9;
const HL = { maxLeverage: 20 };
const JUP = { impactScalarAdjUsd: 125000000000 };

function fresh() { return P.defaultPerpsState({ perpsStartUsd: 1000 }); }

function journalCashSum(state) {
  return state.journal.reduce((a, e) => a + e.cashDeltaUsd, 0);
}

test('perps engine installs its public API on the browser global', () => {
  for (const fn of ['defaultPerpsState', 'openPerp', 'markPerp', 'applyHlFunding',
    'accrueJupBorrow', 'closePerp', 'liquidatePerp']) {
    assert.equal(typeof P[fn], 'function', `${fn} must be exported`);
  }
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
  const f = P.applyHlFunding(s, pos.id, [{ t: 4600, hourlyRateFrac: 0.0000125, oraclePx: 99 }]);
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
        P.applyHlFunding(s, pos.id, [{ t, hourlyRateFrac: (rnd() - 0.5) * 0.0002, oraclePx: px }]);
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
