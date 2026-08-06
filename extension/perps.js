/* PaperTrench — perps paper book engine (pure).
 *
 * Pure functions over a serializable perps state object — no DOM, no chrome
 * APIs. Venue math (fees, funding, borrow, liquidation) comes from
 * perps-venues.js, which carries the dated venue citations; this module owns
 * the book: cash, positions, fills, rounds.
 *
 * Doctrine, inherited from the spot engine and the spec:
 *  - SEPARATE BOOK. Perps cash, rounds and totals never touch the spot
 *    wallet. Margin is venue-native USD (USDC on both first-wave venues).
 *  - Fill integrity: every operation either executes against validated
 *    inputs or is refused with a machine-readable reason. No third state.
 *  - A position past its liquidation price cannot be "closed" — it must be
 *    liquidated. closePerp refuses with 'beyond-liquidation' so the caller
 *    is forced through the honest path.
 *  - Isolated margin only (v1): the maximum loss on any position is the
 *    margin/collateral committed to it. Payouts clamp at zero and the
 *    clamped amount is recorded, never invented back.
 *  - Venue fidelity beats symmetry: Hyperliquid debits fees from the wallet
 *    and funding from isolated margin; Jupiter debits fees and borrow from
 *    the position's collateral, and a Jupiter liquidation forfeits ALL
 *    remaining collateral. The two venues are modeled as they are, not
 *    averaged into one convenient shape.
 */
(() => {
  'use strict';

  const V = (typeof window !== 'undefined' && window.PaperPerpsVenues)
    || (typeof self !== 'undefined' && self.PaperPerpsVenues)
    || (typeof require === 'function' ? require('./perps-venues.js') : null);

  const EPS = 1e-9;
  const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

  const DEFAULT_PERPS_SETTINGS = {
    perpsStartUsd: 1000,
  };

  function defaultPerpsState(settings) {
    const s = Object.assign({}, DEFAULT_PERPS_SETTINGS, settings || {});
    return {
      cashUsd: s.perpsStartUsd,
      positions: {},
      nextId: 1,
      journal: [],
      rounds: [],
      totals: { feesUsd: 0, fundingPaidUsd: 0, borrowPaidUsd: 0, realizedUsd: 0 },
    };
  }

  function refuse(reason) { return { ok: false, reason }; }

  function sideNum(side) {
    if (side === 'long' || side === 1) return 1;
    if (side === 'short' || side === -1) return -1;
    return 0;
  }

  /* --------------------- per-venue liq refresh --------------------- */

  function refreshHl(pos, markPx) {
    const liq = V.hlLiqPrice({
      side: pos.side, markPx, entryPx: pos.entryPx, sizeUnits: pos.sizeUnits,
      marginUsd: pos.marginUsd, maxLeverage: pos.maxLeverage,
    });
    // When the mark is already past liquidation the venue formula has no
    // solution — keep the last true liquidation price so the fill still
    // happens where the venue would actually have triggered.
    if (liq && !liq.breached) pos.liqPx = liq.px;
    else if (!isNum(pos.liqPx)) pos.liqPx = liq ? liq.px : null;
    pos.liqBreached = liq ? liq.breached : true;
  }

  function jupCloseFeeEstUsd(pos) {
    // Estimated close cost for the liq formula [JUP-LIQ]: base fee plus the
    // linear impact on the full size. The additive impact component needs
    // live pool data; when it lands it is added, until then it is absent.
    const fee = V.jupTradeFeeUsd(pos.sizeUsd, { impactScalarAdjUsd: pos.impactScalarAdjUsd });
    return fee ? fee.knownUsd : null;
  }

  function refreshJup(pos) {
    const closeFee = jupCloseFeeEstUsd(pos);
    const liq = closeFee === null ? null : V.jupLiqPrice({
      side: pos.side, entryPx: pos.entryPx, sizeUsd: pos.sizeUsd,
      collateralUsd: pos.collateralUsd, closeFeeUsd: closeFee, borrowFeeUsd: pos.borrowUsd,
    });
    pos.closeFeeEstUsd = closeFee;
    if (liq && !liq.breached) pos.liqPx = liq.px;
    else if (!isNum(pos.liqPx)) pos.liqPx = liq ? liq.px : null;
    pos.liqBreached = liq ? liq.breached : true;
  }

  function pastLiq(pos, px) {
    if (pos.liqBreached) return true;
    if (!isNum(pos.liqPx)) return true;
    return pos.side === 1 ? px <= pos.liqPx + EPS : px >= pos.liqPx - EPS;
  }

  /* ------------------------------ open ------------------------------ */

  /* o: { venue, market, side, marginUsd, leverage, price, t, params }
   *   params (hyperliquid): { maxLeverage, maker?, builderFrac? }
   *   params (jupiter):     { impactScalarAdjUsd, additiveImpactUsd? }
   * The caller supplies venue params from live venue data (parsed by
   * perps-venues.js) — the engine never invents them. */
  function openPerp(state, o) {
    if (!o || typeof o !== 'object') return refuse('bad-params');
    const venue = V.VENUES[o.venue];
    if (!venue) return refuse('venue-unknown');
    if (!venue.verified) return refuse('venue-unverified');
    const side = sideNum(o.side);
    if (side === 0) return refuse('bad-side');
    if (!isNum(o.price) || o.price <= 0) return refuse('bad-price');
    if (!Number.isInteger(o.t) || o.t <= 0) return refuse('bad-time');
    if (!isNum(o.marginUsd) || o.marginUsd <= 0) return refuse('bad-margin');
    if (!isNum(o.leverage) || o.leverage <= 0) return refuse('bad-leverage');
    const p = o.params || {};

    const notionalUsd = o.marginUsd * o.leverage;
    let pos, openFeeUsd, cashOutUsd;

    if (o.venue === 'hyperliquid') {
      if (!Number.isInteger(p.maxLeverage) || p.maxLeverage <= 0) return refuse('max-leverage-unavailable');
      if (o.leverage < venue.leverage.min) return refuse('leverage-below-min');
      if (o.leverage > p.maxLeverage) return refuse('leverage-above-max');
      openFeeUsd = V.hlTradeFeeUsd(notionalUsd, { maker: !!p.maker, builderFrac: p.builderFrac });
      // [HL] fees debit the wallet; the isolated margin arrives intact.
      cashOutUsd = o.marginUsd + openFeeUsd;
      if (cashOutUsd > state.cashUsd + EPS) return refuse('insufficient-cash');
      pos = {
        id: state.nextId, venue: o.venue, market: o.market, side,
        entryPx: o.price, sizeUnits: notionalUsd / o.price,
        notionalEntryUsd: notionalUsd, marginUsd: o.marginUsd, marginUsd0: o.marginUsd,
        leverage: o.leverage, maxLeverage: p.maxLeverage,
        builderFrac: isNum(p.builderFrac) ? p.builderFrac : 0,
        openT: o.t, lastPx: o.price, feesUsd: openFeeUsd,
        fundingPaidUsd: 0, payoutAccumUsd: 0, status: 'open',
      };
      refreshHl(pos, o.price);
    } else if (o.venue === 'jupiter') {
      if (o.leverage < venue.leverage.min - EPS) return refuse('leverage-below-min');
      if (o.leverage > venue.leverage.max + EPS) return refuse('leverage-above-max');
      const scalarAdj = isNum(p.impactScalarAdjUsd) && p.impactScalarAdjUsd > 0
        ? p.impactScalarAdjUsd : null;
      // A fill whose cost we cannot state truthfully is refused, not
      // approximated — the linear impact scalar comes from the custody
      // account and must be supplied.
      if (scalarAdj === null) return refuse('impact-scalar-unavailable');
      const fee = V.jupTradeFeeUsd(notionalUsd, {
        impactScalarAdjUsd: scalarAdj,
        additiveImpactUsd: isNum(p.additiveImpactUsd) ? p.additiveImpactUsd : null,
      });
      openFeeUsd = fee.knownUsd;
      // [JUP-FEES] fees deduct from collateral; the deposit leaves the wallet whole.
      cashOutUsd = o.marginUsd;
      if (cashOutUsd > state.cashUsd + EPS) return refuse('insufficient-cash');
      const collateralUsd = o.marginUsd - openFeeUsd;
      const maintUsd = notionalUsd / V.VENUES.jupiter.leverage.protocolMax;
      if (collateralUsd <= maintUsd) return refuse('collateral-below-maintenance');
      pos = {
        id: state.nextId, venue: o.venue, market: o.market, side,
        entryPx: o.price, sizeUsd: notionalUsd,
        marginUsd: o.marginUsd, marginUsd0: o.marginUsd, collateralUsd,
        leverage: o.leverage, impactScalarAdjUsd: scalarAdj,
        openT: o.t, lastPx: o.price, lastAccrualT: o.t,
        feesUsd: openFeeUsd, borrowUsd: 0, payoutAccumUsd: 0, status: 'open',
      };
      refreshJup(pos);
    } else {
      return refuse('venue-unsupported');
    }

    state.cashUsd -= cashOutUsd;
    state.nextId += 1;
    state.positions[pos.id] = pos;
    state.totals.feesUsd += openFeeUsd;
    state.journal.push({
      type: 'open', t: o.t, id: pos.id, venue: o.venue, market: o.market,
      side: side === 1 ? 'long' : 'short', price: o.price,
      marginUsd: o.marginUsd, leverage: o.leverage,
      notionalUsd, feeUsd: openFeeUsd, cashDeltaUsd: -cashOutUsd,
    });
    return { ok: true, id: pos.id, position: pos };
  }

  /* ------------------------------ mark ------------------------------ */

  function unrealizedUsd(pos, px) {
    if (pos.venue === 'hyperliquid') return pos.side * pos.sizeUnits * (px - pos.entryPx);
    return V.jupUnrealizedPnlUsd({ side: pos.side, entryPx: pos.entryPx, px, sizeUsd: pos.sizeUsd });
  }

  /* px must be the venue's liquidation basis: HL mark price, Jupiter oracle
   * price. The caller labels its feed; the engine trusts the label. */
  function markPerp(state, id, o) {
    const pos = state.positions[id];
    if (!pos) return refuse('unknown-position');
    if (pos.status !== 'open') return refuse('position-not-open');
    if (!o || !isNum(o.price) || o.price <= 0) return refuse('bad-price');
    pos.lastPx = o.price;
    if (pos.venue === 'hyperliquid') refreshHl(pos, o.price); else refreshJup(pos);
    const uPnl = unrealizedUsd(pos, o.price);
    const equityUsd = pos.venue === 'hyperliquid'
      ? pos.marginUsd + uPnl
      : pos.collateralUsd - pos.borrowUsd + uPnl;
    return {
      ok: true, uPnlUsd: uPnl, equityUsd,
      liqPx: pos.liqPx, liqBreached: pos.liqBreached,
      liquidatable: pastLiq(pos, o.price),
    };
  }

  /* ------------------------- carry costs ------------------------- */

  /* [HL-FUND] events = [{ t, hourlyRateFrac, oraclePx }] — one per hourly
   * funding payment, rates from the venue (live feed or fundingHistory for
   * reconciliation). Funding settles against isolated margin. */
  function applyHlFunding(state, id, events) {
    const pos = state.positions[id];
    if (!pos) return refuse('unknown-position');
    if (pos.venue !== 'hyperliquid') return refuse('wrong-venue');
    if (pos.status !== 'open') return refuse('position-not-open');
    if (!Array.isArray(events)) return refuse('bad-params');
    let paid = 0;
    for (const ev of events) {
      const delta = V.hlFundingDeltaUsd({
        side: pos.side, sizeUnits: pos.sizeUnits,
        oraclePx: ev && ev.oraclePx, hourlyRateFrac: ev && ev.hourlyRateFrac,
      });
      if (delta === null) return refuse('bad-funding-event');
      pos.marginUsd += delta;
      paid -= delta;
    }
    pos.fundingPaidUsd += paid;
    state.totals.fundingPaidUsd += paid;
    refreshHl(pos, pos.lastPx);
    return { ok: true, fundingPaidUsd: paid, marginUsd: pos.marginUsd, liqPx: pos.liqPx, liqBreached: pos.liqBreached };
  }

  /* [JUP-FEES] borrow accrues continuously against collateral, pro-rata to
   * time at the supplied hourly rate (rate = base × utilization, from live
   * custody state). The liquidation price drifts as collateral shrinks —
   * that drift is the venue's behavior and the whole lesson. */
  function accrueJupBorrow(state, id, o) {
    const pos = state.positions[id];
    if (!pos) return refuse('unknown-position');
    if (pos.venue !== 'jupiter') return refuse('wrong-venue');
    if (pos.status !== 'open') return refuse('position-not-open');
    if (!o || !Number.isInteger(o.toT) || !isNum(o.hourlyRateFrac) || o.hourlyRateFrac < 0) return refuse('bad-params');
    if (o.toT < pos.lastAccrualT) return refuse('time-went-backwards');
    const hours = (o.toT - pos.lastAccrualT) / 3600;
    const fee = V.jupBorrowFeeUsd(o.hourlyRateFrac, pos.sizeUsd, hours);
    if (fee === null) return refuse('bad-params');
    pos.borrowUsd += fee;
    pos.lastAccrualT = o.toT;
    state.totals.borrowPaidUsd += fee;
    refreshJup(pos);
    return { ok: true, borrowUsd: pos.borrowUsd, liqPx: pos.liqPx, liqBreached: pos.liqBreached };
  }

  /* ------------------------------ close ------------------------------ */

  function recordRound(state, pos, o) {
    state.rounds.push({
      venue: pos.venue, market: pos.market,
      side: pos.side === 1 ? 'long' : 'short',
      entryPx: pos.entryPx, exitPx: o.exitPx,
      notionalUsd: pos.venue === 'hyperliquid' ? pos.notionalEntryUsd : pos.sizeUsd,
      marginUsd: pos.marginUsd0,
      leverage: pos.leverage,
      openT: pos.openT, closeT: o.t,
      netUsd: o.netUsd, feesUsd: o.feesUsd,
      carryUsd: pos.venue === 'hyperliquid' ? pos.fundingPaidUsd : pos.borrowUsd,
      cause: o.cause,
    });
  }

  function closePerp(state, id, o) {
    const pos = state.positions[id];
    if (!pos) return refuse('unknown-position');
    if (pos.status !== 'open') return refuse('position-not-open');
    if (!o || !isNum(o.price) || o.price <= 0) return refuse('bad-price');
    if (!Number.isInteger(o.t) || o.t < pos.openT) return refuse('bad-time');
    const fraction = o.fraction === undefined ? 1 : o.fraction;
    if (!isNum(fraction) || fraction <= 0 || fraction > 1) return refuse('bad-fraction');
    // Past the liquidation price there is no voluntary close — the venue
    // would have liquidated first, and paying out a manual close there
    // would teach that leverage forgives being late.
    if (pastLiq(pos, o.price)) return refuse('beyond-liquidation');

    let payoutUsd, feeUsd, pnlUsd, clampedUsd = 0;

    if (pos.venue === 'hyperliquid') {
      const closedUnits = pos.sizeUnits * fraction;
      const closeNotional = closedUnits * o.price;
      feeUsd = V.hlTradeFeeUsd(closeNotional, { maker: !!(o.params && o.params.maker), builderFrac: pos.builderFrac });
      pnlUsd = pos.side * closedUnits * (o.price - pos.entryPx);
      const marginReleased = pos.marginUsd * fraction;
      payoutUsd = marginReleased + pnlUsd - feeUsd;
      if (payoutUsd < 0) { clampedUsd = -payoutUsd; payoutUsd = 0; }
      pos.sizeUnits -= closedUnits;
      pos.notionalEntryUsd *= (1 - fraction);
      pos.marginUsd -= marginReleased;
    } else {
      const closedSizeUsd = pos.sizeUsd * fraction;
      const fee = V.jupTradeFeeUsd(closedSizeUsd, { impactScalarAdjUsd: pos.impactScalarAdjUsd });
      feeUsd = fee.knownUsd;
      pnlUsd = V.jupUnrealizedPnlUsd({ side: pos.side, entryPx: pos.entryPx, px: o.price, sizeUsd: closedSizeUsd });
      const collateralShare = pos.collateralUsd * fraction;
      const borrowShare = pos.borrowUsd * fraction;
      // [JUP-POS] realized = unrealized - (close fees + borrow due).
      payoutUsd = collateralShare + pnlUsd - feeUsd - borrowShare;
      if (payoutUsd < 0) { clampedUsd = -payoutUsd; payoutUsd = 0; }
      pos.sizeUsd -= closedSizeUsd;
      pos.collateralUsd -= collateralShare;
      pos.borrowUsd -= borrowShare;
    }

    state.cashUsd += payoutUsd;
    state.totals.feesUsd += feeUsd;
    state.totals.realizedUsd += pnlUsd;
    pos.payoutAccumUsd += payoutUsd;
    pos.feesUsd += feeUsd;
    state.journal.push({
      type: 'close', t: o.t, id, venue: pos.venue, market: pos.market,
      price: o.price, fraction, pnlUsd, feeUsd,
      cashDeltaUsd: payoutUsd, clampedUsd,
    });

    const remaining = pos.venue === 'hyperliquid' ? pos.sizeUnits : pos.sizeUsd;
    const fullyClosed = fraction === 1 || remaining <= EPS;
    if (fullyClosed) {
      pos.status = 'closed';
      // Cash truth: the round's net is what came back minus what went in.
      recordRound(state, pos, {
        exitPx: o.price, t: o.t, cause: 'close',
        netUsd: pos.payoutAccumUsd - pos.marginUsd0, feesUsd: pos.feesUsd,
      });
      delete state.positions[id];
    }
    return { ok: true, payoutUsd, pnlUsd, feeUsd, clampedUsd, fullyClosed };
  }

  /* --------------------------- liquidation --------------------------- */

  /* Called by the feed/reconciler when the venue-basis price crosses the
   * liquidation price (o.price is the crossing observation, stamped for the
   * round; the FILL uses the position's own liquidation price).
   *
   * Venue fidelity:
   *  - [HL-LIQ] the book attempts a market close; if maintenance is met the
   *    remainder stays with the trader. Paper convention: fill AT the
   *    liquidation price with a taker fee — the documented best case; real
   *    liquidations usually fare worse, and the UI must say so.
   *  - [JUP-LIQ] "all remaining collateral is forfeited": payout is zero,
   *    full stop. */
  function liquidatePerp(state, id, o) {
    const pos = state.positions[id];
    if (!pos) return refuse('unknown-position');
    if (pos.status !== 'open') return refuse('position-not-open');
    if (!o || !Number.isInteger(o.t) || o.t < pos.openT) return refuse('bad-time');
    if (!o.force && isNum(o.price) && !pastLiq(pos, o.price)) return refuse('not-liquidatable');

    let payoutUsd = 0, feeUsd = 0, netUsd;
    if (pos.venue === 'hyperliquid') {
      const fillPx = isNum(pos.liqPx) ? pos.liqPx : o.price;
      feeUsd = V.hlTradeFeeUsd(pos.sizeUnits * fillPx, { builderFrac: pos.builderFrac });
      const pnlUsd = pos.side * pos.sizeUnits * (fillPx - pos.entryPx);
      payoutUsd = Math.max(0, pos.marginUsd + pnlUsd - feeUsd);
      pos.payoutAccumUsd += payoutUsd;
      pos.feesUsd += feeUsd;
      netUsd = pos.payoutAccumUsd - pos.marginUsd0;
      state.totals.feesUsd += feeUsd;
      state.cashUsd += payoutUsd;
      state.journal.push({
        type: 'liquidation', t: o.t, id, venue: pos.venue, market: pos.market,
        price: fillPx, feeUsd, cashDeltaUsd: payoutUsd,
      });
      recordRound(state, pos, { exitPx: fillPx, t: o.t, cause: 'liquidated', netUsd, feesUsd: pos.feesUsd });
    } else {
      // Jupiter: everything remaining goes to the JLP. Zero back.
      netUsd = pos.payoutAccumUsd - pos.marginUsd0;
      state.journal.push({
        type: 'liquidation', t: o.t, id, venue: pos.venue, market: pos.market,
        price: pos.liqPx, feeUsd: 0, cashDeltaUsd: 0,
      });
      recordRound(state, pos, { exitPx: pos.liqPx, t: o.t, cause: 'liquidated', netUsd, feesUsd: pos.feesUsd });
    }
    pos.status = 'liquidated';
    delete state.positions[id];
    return { ok: true, payoutUsd, feeUsd };
  }

  const api = {
    DEFAULT_PERPS_SETTINGS,
    defaultPerpsState,
    openPerp,
    markPerp,
    applyHlFunding,
    accrueJupBorrow,
    closePerp,
    liquidatePerp,
  };

  if (typeof window !== 'undefined') window.PaperPerps = api;
  if (typeof self !== 'undefined') self.PaperPerps = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
