/* PaperTrench — perps ticket view-model (pure).
 *
 * Everything the ticket displays is computed here, testable without a DOM.
 * The preview does not re-implement any venue math: it runs the REAL
 * engine open on a scratch book and reads the resulting position, so the
 * preview can never disagree with the fill that follows it. The xray-core
 * split applies: this module decides numbers and labels, perps-content.js
 * only formats them into elements.
 *
 * Ticket-level honesty gates (spec §4): a venue carry rate that is not
 * currently known refuses the open — "funding real or no trade" — before
 * the engine is even consulted.
 */
(() => {
  'use strict';

  const P = (typeof window !== 'undefined' && window.PaperPerps)
    || (typeof self !== 'undefined' && self.PaperPerps)
    || (typeof require === 'function' ? require('./perps.js') : null);

  const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

  const REASON_TEXT = {
    'venue-unknown': 'Unknown venue.',
    'venue-unverified': 'This venue’s fees are not verified yet — paper trading here would use numbers we cannot stand behind.',
    'bad-side': 'Pick long or short.',
    'bad-price': 'No trusted price yet.',
    'bad-time': 'Clock error — refusing the fill.',
    'bad-margin': 'Enter a margin amount.',
    'bad-leverage': 'Enter a leverage.',
    'insufficient-cash': 'Not enough paper balance for margin + fees.',
    'leverage-above-max': 'Above this market’s maximum leverage.',
    'leverage-below-min': 'Below this venue’s minimum leverage.',
    'max-leverage-unavailable': 'Waiting for the venue’s leverage tiers…',
    'impact-scalar-unavailable': 'Waiting for the venue’s price-impact parameters…',
    'collateral-below-maintenance': 'After open fees this collateral is already below maintenance — lower the leverage or raise the margin.',
    'funding-unavailable': 'The venue’s live funding rate is unavailable — a perp without funding is not the real instrument, so the ticket is closed.',
    'borrow-unavailable': 'The venue’s live borrow rate is unavailable — borrow costs are most of what leverage costs, so the ticket is closed.',
    'market-unconfirmed': 'This market is not in the venue’s live perp universe.',
  };

  function groupInt(s) {
    const parts = s.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return parts.join('.');
  }

  function fmtUsd(n, opts) {
    if (!isNum(n)) return '—';
    const sign = n < 0 ? '-' : (opts && opts.signed && n > 0 ? '+' : '');
    const a = Math.abs(n);
    const digits = a >= 1000 ? 2 : a >= 1 ? 2 : a >= 0.01 ? 4 : 6;
    return sign + '$' + groupInt(a.toFixed(digits));
  }

  function fmtPx(n) {
    if (!isNum(n)) return '—';
    const a = Math.abs(n);
    const digits = a >= 1000 ? 1 : a >= 10 ? 2 : a >= 0.1 ? 4 : 6;
    return groupInt(n.toFixed(digits));
  }

  function fmtPct(n) {
    if (!isNum(n)) return '—';
    return (n >= 10 ? n.toFixed(1) : n.toFixed(2)) + '%';
  }

  /* o: { venue, market, side, marginUsd, leverage, price, t, cashUsd,
   *      params, carry: { fundingHourlyFrac? (hl) | borrowRateFrac? (jup) } }
   * → { ok:false, reason, text } | { ok:true, rows, warnings } */
  function buildPreview(o) {
    const refuse = (reason) => ({ ok: false, reason, text: REASON_TEXT[reason] || reason });

    // The carry gate comes FIRST: no live venue rate, no ticket.
    const carry = (o && o.carry) || {};
    if (o && o.venue === 'hyperliquid' && !isNum(carry.fundingHourlyFrac)) return refuse('funding-unavailable');
    if (o && o.venue === 'jupiter' && !isNum(carry.borrowRateFrac)) return refuse('borrow-unavailable');
    if (o && o.marketConfirmed === false) return refuse('market-unconfirmed');

    // Dry-run the real engine on a scratch book: the preview IS the fill.
    const scratch = P.defaultPerpsState({ perpsStartUsd: isNum(o && o.cashUsd) ? o.cashUsd : 0 });
    const r = P.openPerp(scratch, o);
    if (!r.ok) return refuse(r.reason);
    const pos = r.position;

    const notionalUsd = o.marginUsd * o.leverage;
    const liqDistPct = isNum(pos.liqPx) ? (Math.abs(o.price - pos.liqPx) / o.price) * 100 : null;
    // The ATR × leverage bridge (spec §5): liquidation distance in noise
    // units, when a warm ATR exists for this market. Null when it does not
    // — never a padded value.
    const atr = isNum(o.atr) && o.atr > 0 ? o.atr : null;
    const liqDistAtr = atr !== null && isNum(pos.liqPx)
      ? Math.abs(o.price - pos.liqPx) / atr : null;
    const carryPerHourUsd = o.venue === 'hyperliquid'
      ? (pos.side === 1 ? 1 : -1) * notionalUsd * carry.fundingHourlyFrac
      : notionalUsd * carry.borrowRateFrac;

    const warnings = [];
    if (liqDistAtr !== null && liqDistAtr < 1.5) {
      warnings.push('Liquidation is ' + liqDistAtr.toFixed(1)
        + ' ATR away on the 5m — this market moves that much routinely.');
    } else if (isNum(liqDistPct) && liqDistPct < 1) {
      warnings.push('Liquidation is ' + fmtPct(liqDistPct) + ' away — ordinary noise covers that.');
    }
    const feePctOfMargin = (pos.feesUsd / o.marginUsd) * 100;
    if (feePctOfMargin >= 2) {
      warnings.push('Open fees alone are ' + fmtPct(feePctOfMargin) + ' of this margin.');
    }

    return {
      ok: true,
      rows: {
        notionalUsd,
        notionalText: fmtUsd(notionalUsd),
        feeUsd: pos.feesUsd,
        feeText: fmtUsd(pos.feesUsd),
        feeLabel: o.venue === 'hyperliquid' ? 'taker fee' : 'base + impact fee',
        liqPx: pos.liqPx,
        liqText: fmtPx(pos.liqPx),
        liqDistPct,
        liqDistText: fmtPct(liqDistPct)
          + (liqDistAtr !== null ? ' · ' + liqDistAtr.toFixed(1) + ' ATR' : ''),
        liqDistAtr,
        carryPerHourUsd,
        carryText: fmtUsd(Math.abs(carryPerHourUsd)) + '/hr'
          + (o.venue === 'hyperliquid' && carryPerHourUsd < 0 ? ' (received)' : ''),
        carryLabel: o.venue === 'hyperliquid' ? 'funding now' : 'borrow now',
      },
      warnings,
    };
  }

  /* Rows for the open-positions section. Read-only by construction: perpMark
   * is pure, so no clone is needed to protect the caller's book — and the
   * cost of a render no longer grows with the journal and closed-round
   * history the way a whole-book clone did.
   *
   * Every liquidation number below comes from `m`, the mark's own answer,
   * never from the stored pos.liqPx: a pure mark writes nothing back, so
   * the stored copy is only as fresh as the last committed write, and
   * printing it would put a stale liquidation price on screen. */
  function buildPositionRows(state, o) {
    const rows = [];
    for (const id of Object.keys(state.positions)) {
      const pos = state.positions[id];
      if (pos.venue !== o.venue || pos.market !== o.market) continue;
      const m = P.perpMark(pos, o.px);
      if (!m.ok) continue;
      const uPnlPct = (m.uPnlUsd / pos.marginUsd0) * 100;
      const rowAtr = isNum(o.atr) && o.atr > 0 && isNum(m.liqPx)
        ? Math.abs(o.px - m.liqPx) / o.atr : null;
      rows.push({
        id: pos.id,
        label: (pos.side === 1 ? 'LONG' : 'SHORT') + ' ' + pos.leverage + 'x',
        side: pos.side,
        marginText: fmtUsd(pos.marginUsd0),
        uPnlUsd: m.uPnlUsd,
        uPnlText: fmtUsd(m.uPnlUsd, { signed: true }) + ' (' + fmtPct(Math.abs(uPnlPct)) + ')',
        equityText: fmtUsd(m.equityUsd),
        liqText: fmtPx(m.liqPx) + (rowAtr !== null ? ' · ' + rowAtr.toFixed(1) + ' ATR' : ''),
        liqDistPct: isNum(m.liqPx) ? (Math.abs(o.px - m.liqPx) / o.px) * 100 : null,
        liqDistAtr: rowAtr,
        liquidatable: m.liquidatable,
        gapNote: pos.unverifiedGapSec > 0
          ? Math.round(pos.unverifiedGapSec / 60) + ' min unobserved — real borrow would be higher'
          : null,
      });
    }
    rows.sort((a, b) => a.id - b.id);
    return rows;
  }

  /* The TA strip (spec §2): one line of regime truth, plus detected setups
   * with their invalidation in the same breath. Silence is a valid output —
   * null means "render nothing". Warm-up states say exactly what is
   * missing instead of faking a read. */
  const SETUP_LABEL = {
    'trend-pullback': 'Pullback',
    'break-retest': 'Break + retest',
    'vwap-reversion': 'VWAP reversion',
    'rsi-divergence': 'RSI divergence',
  };

  function buildTaStrip(reads) {
    if (!reads || !reads.warm) return null;
    if (reads.regime === null) {
      const needed = reads.warm.needed ? reads.warm.needed.emaSlow : 21;
      if (reads.warm.bars < needed) {
        return { regimeText: 'TA warming up: ' + reads.warm.bars + '/' + needed + ' bars observed', setups: [] };
      }
      return { regimeText: 'No trend read — structure unclear', setups: [] };
    }
    const label = { uptrend: 'Uptrend', downtrend: 'Downtrend', range: 'Range' }[reads.regime] || reads.regime;
    const bits = [label];
    if (isNum(reads.rsi)) bits.push('RSI ' + Math.round(reads.rsi));
    if (isNum(reads.atr)) bits.push('ATR ' + fmtPx(reads.atr));
    const setups = (reads.setups || []).map((s) => ({
      text: (SETUP_LABEL[s.setup] || s.setup) + ' ' + s.direction,
      detail: 'wrong if ' + fmtPx(s.invalidation)
        + (s.targets && s.targets.length ? ' → ' + fmtPx(s.targets[0]) : ''),
    }));
    return { regimeText: bits.join(' · '), setups };
  }

  const api = { buildPreview, buildPositionRows, buildTaStrip, fmtUsd, fmtPx, fmtPct, REASON_TEXT };

  if (typeof window !== 'undefined') window.PaperPerpsTicket = api;
  if (typeof self !== 'undefined') self.PaperPerpsTicket = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
