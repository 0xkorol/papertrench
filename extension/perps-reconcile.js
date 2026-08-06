/* PaperTrench — offline perps reconciler (pure).
 *
 * Leverage's most important lesson happens while the browser is closed. On
 * wake, the feed layer fetches the venue's own history for the unobserved
 * window and this module decides — deterministically, from that data alone —
 * what happened to each open position: liquidated at a specific bar, or
 * survived with funding settled. It returns a PLAN; the caller applies it
 * through the engine's own operations, so reconciliation and live trading
 * share one arithmetic.
 *
 * Honesty rules:
 *  - Candles must COVER the window (start, end, no internal gaps at the
 *    declared interval). Anything less is 'unverified-gap' — a position is
 *    never resurrected through a hole in the data, and never killed by one.
 *  - Funding uses the venue's real per-hour rates (fundingHistory). The
 *    venue pays funding on the oracle notional; historical oracle prices
 *    are not in the funding records, so the covering candle's close stands
 *    proxy, and the plan says so (provenance flag) — the rate is exact, the
 *    notional is bar-close-approximate, the error is bps-of-bps.
 *  - Liquidation detection walks bar by bar IN ORDER, applying funding as
 *    it lands, because funding moves the liquidation price. The first bar
 *    whose extreme crosses the current liq price ends the walk.
 *  - Jupiter has no verified candle source yet [JUP-GAP]: at wake, a price
 *    past the liq price proves a liquidation happened (confirmed-at-wake);
 *    a price inside it proves nothing about the gap's wicks, so the
 *    position survives with the unobserved seconds RECORDED — and gap
 *    borrow is NOT invented; the caller records unaccrued gap time and the
 *    UI must say the real venue would have charged for it.
 */
(() => {
  'use strict';

  const V = (typeof window !== 'undefined' && window.PaperPerpsVenues)
    || (typeof self !== 'undefined' && self.PaperPerpsVenues)
    || (typeof require === 'function' ? require('./perps-venues.js') : null);

  const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

  /* [HL-API] candleSnapshot rows: {t, T, s, i, o, c, h, l, v, n} with
   * string prices and ms times. Returns validated numeric bars sorted by t,
   * or null if anything fails to parse — never a partial parse. */
  function parseHlCandles(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const out = [];
    for (const r of rows) {
      if (!r || !Number.isInteger(r.t) || !Number.isInteger(r.T) || r.T <= r.t) return null;
      const o = Number(r.o), h = Number(r.h), l = Number(r.l), c = Number(r.c);
      for (const x of [o, h, l, c]) if (!Number.isFinite(x) || x <= 0) return null;
      if (h < l || h < o || h < c || l > o || l > c) return null;
      out.push({ t: r.t, T: r.T, o, h, l, c });
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }

  function coverage(bars, fromMs, toMs, intervalMs) {
    if (!bars || !bars.length) return { ok: false, why: 'no-bars' };
    if (bars[0].t > fromMs) return { ok: false, why: 'starts-late' };
    if (bars[bars.length - 1].T < toMs - intervalMs) return { ok: false, why: 'ends-early' };
    for (let i = 1; i < bars.length; i++) {
      if (bars[i].t !== bars[i - 1].t + intervalMs) return { ok: false, why: 'internal-gap' };
    }
    return { ok: true };
  }

  /* [HL-API] fundingHistory rows: {coin, fundingRate, premium, time}. */
  function parseHlFunding(rows) {
    if (!Array.isArray(rows)) return null;
    const out = [];
    for (const r of rows) {
      if (!r || !Number.isInteger(r.time)) return null;
      const rate = Number(r.fundingRate);
      if (!Number.isFinite(rate)) return null;
      out.push({ timeMs: r.time, hourlyRateFrac: rate });
    }
    out.sort((a, b) => a.timeMs - b.timeMs);
    return out;
  }

  /* Reconcile one Hyperliquid position across an unobserved window.
   *
   * pos: an open HL position (side, entryPx, sizeUnits, marginUsd,
   *      maxLeverage) — NOT mutated; the returned plan is applied by the
   *      caller through engine ops.
   * o:   { candles, funding, fromMs, toMs, intervalMs } — raw API rows.
   */
  function reconcileHl(pos, o) {
    if (!pos || pos.venue !== 'hyperliquid') return { verdict: 'bad-position' };
    const bars = parseHlCandles(o && o.candles);
    const events = parseHlFunding(o && o.funding) || [];
    if (!bars) return { verdict: 'unverified-gap', why: 'candles-unparseable' };
    const cov = coverage(bars, o.fromMs, o.toMs, o.intervalMs);
    if (!cov.ok) return { verdict: 'unverified-gap', why: cov.why };

    let marginUsd = pos.marginUsd;
    const applied = [];
    let evIdx = 0;

    const liqAt = (markPx) => V.hlLiqPrice({
      side: pos.side, markPx, entryPx: pos.entryPx,
      sizeUnits: pos.sizeUnits, marginUsd, maxLeverage: pos.maxLeverage,
    });

    let lastLiqPx = null;
    for (const bar of bars) {
      if (bar.T < o.fromMs) continue;         // history before the gap
      if (bar.t > o.toMs) break;
      // Funding lands at its own timestamp; settle every event due by the
      // end of this bar BEFORE testing the bar, at the bar-close proxy.
      while (evIdx < events.length && events[evIdx].timeMs <= bar.T) {
        const ev = events[evIdx++];
        if (ev.timeMs < o.fromMs) continue;   // already settled while live
        const delta = V.hlFundingDeltaUsd({
          side: pos.side, sizeUnits: pos.sizeUnits,
          oraclePx: bar.c, hourlyRateFrac: ev.hourlyRateFrac,
        });
        marginUsd += delta;
        applied.push({ t: Math.floor(ev.timeMs / 1000), hourlyRateFrac: ev.hourlyRateFrac, oraclePx: bar.c });
      }
      const liq = liqAt(bar.c);
      if (!liq) return { verdict: 'unverified-gap', why: 'liq-uncomputable' };
      if (!liq.breached) lastLiqPx = liq.px;
      const liqPx = lastLiqPx;
      if (liqPx === null || liq.breached
        || (pos.side === 1 ? bar.l <= liqPx : bar.h >= liqPx)) {
        return {
          verdict: 'liquidated',
          atMs: bar.t,
          crossPx: pos.side === 1 ? bar.l : bar.h,
          fundingBefore: applied,
          marginAfterUsd: marginUsd,
          provenance: 'reconstructed-from-venue-candles; funding-notional-from-candle-close',
        };
      }
    }
    return {
      verdict: 'survived',
      fundingApplied: applied,
      lastPx: bars[bars.length - 1].c,
      marginAfterUsd: marginUsd,
      provenance: 'reconstructed-from-venue-candles; funding-notional-from-candle-close',
    };
  }

  /* Reconcile one Jupiter position at wake. [JUP-GAP] No verified candle
   * source yet: the wake price can prove a liquidation, never disprove one. */
  function reconcileJup(pos, o) {
    if (!pos || pos.venue !== 'jupiter') return { verdict: 'bad-position' };
    if (!o || !isNum(o.nowPx) || o.nowPx <= 0) return { verdict: 'unverified-gap', why: 'no-wake-price' };
    const gapSec = Math.max(0, Math.round(((o.nowMs || 0) - (o.lastSeenMs || 0)) / 1000));
    const crossed = pos.liqBreached
      || (isNum(pos.liqPx) && (pos.side === 1 ? o.nowPx <= pos.liqPx : o.nowPx >= pos.liqPx));
    if (crossed) {
      return {
        verdict: 'liquidated',
        crossPx: o.nowPx,
        gapSec,
        provenance: 'confirmed-at-wake; crossing-time-unknown-within-gap',
      };
    }
    return { verdict: 'survived', gapSec, unaccruedBorrowGapSec: gapSec, provenance: 'wake-price-only; gap-wicks-unverified' };
  }

  const api = {
    parseHlCandles,
    parseHlFunding,
    coverage,
    reconcileHl,
    reconcileJup,
  };

  if (typeof window !== 'undefined') window.PaperPerpsReconcile = api;
  if (typeof self !== 'undefined') self.PaperPerpsReconcile = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
