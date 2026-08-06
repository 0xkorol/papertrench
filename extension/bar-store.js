/* PaperTrench — bar store (pure core).
 *
 * Serializable ring buffer of OHLCV bars per (market, resolution), with
 * per-bar provenance. Pure functions over a plain object — no DOM, no
 * chrome APIs; the feed layer and the dashboard drive it and persist it.
 *
 * The TA layer's honesty rests on what this store refuses to do:
 *  - a bar whose time is off the resolution grid is rejected, not snapped;
 *  - backfill may fill holes but never overwrites an observed (live) bar;
 *  - a live bar may replace the same-time live bar (the forming bar) or a
 *    backfilled one (observation beats retrieval), nothing else;
 *  - coverage() reports observed vs backfilled vs missing, so indicator
 *    warm-up can say exactly what its numbers are computed on.
 *
 * Bar shape: { t, o, h, l, c, v?, prov } — t is the bar OPEN time in epoch
 * seconds aligned to the resolution grid; v is base volume and may be
 * omitted when the feed does not carry volume (never invented as 0).
 */
(() => {
  'use strict';

  const DEFAULT_CAP = 500;
  const PROV_LIVE = 'live';
  const BACKFILL_RE = /^backfill:[a-z0-9][a-z0-9-]*$/;

  function createStore(opts) {
    const cap = opts && Number.isInteger(opts.cap) && opts.cap > 1 ? opts.cap : DEFAULT_CAP;
    return { cap, buffers: {} };
  }

  function bufKey(market, resSec) { return market + '@' + resSec; }

  function isFiniteNum(x) { return typeof x === 'number' && Number.isFinite(x); }

  /* A bar is admissible only when it is internally consistent. A violated
   * OHLC envelope means the feed handed us something that is not a bar, and
   * storing it would poison every indicator window it ever appears in. */
  function validateBar(bar, resSec) {
    if (!bar || typeof bar !== 'object') return 'not-a-bar';
    const { t, o, h, l, c, v } = bar;
    if (!Number.isInteger(t) || t <= 0) return 'bad-time';
    if (!Number.isInteger(resSec) || resSec <= 0) return 'bad-resolution';
    if (t % resSec !== 0) return 'off-grid';
    for (const x of [o, h, l, c]) if (!isFiniteNum(x) || x <= 0) return 'bad-ohlc';
    if (h < l) return 'bad-ohlc';
    if (h < o || h < c || l > o || l > c) return 'bad-ohlc';
    if (v !== undefined && (!isFiniteNum(v) || v < 0)) return 'bad-volume';
    return null;
  }

  function validProv(prov) {
    return prov === PROV_LIVE || (typeof prov === 'string' && BACKFILL_RE.test(prov));
  }

  /* Insert or update one bar. Returns { ok } or { ok: false, reason }.
   * Mutates the store in place (engine.js convention); callers persist. */
  function noteBar(store, market, resSec, bar, prov) {
    const invalid = validateBar(bar, resSec);
    if (invalid) return { ok: false, reason: invalid };
    if (!validProv(prov)) return { ok: false, reason: 'bad-provenance' };

    const key = bufKey(market, resSec);
    const buf = store.buffers[key] || (store.buffers[key] = { bars: [] });
    const bars = buf.bars;
    const rec = { t: bar.t, o: bar.o, h: bar.h, l: bar.l, c: bar.c, prov };
    if (bar.v !== undefined) rec.v = bar.v;

    // Binary search for the grid slot (bars stay sorted by t, unique).
    let lo = 0, hi = bars.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (bars[mid].t < rec.t) lo = mid + 1; else hi = mid;
    }
    const existing = bars[lo] && bars[lo].t === rec.t ? bars[lo] : null;

    if (existing) {
      // The precedence rule in one place: an observed bar outranks a
      // retrieved one, and nothing outranks an observed bar except a fresher
      // observation of the same bar (the forming-bar update path).
      if (existing.prov === PROV_LIVE && prov !== PROV_LIVE) {
        return { ok: false, reason: 'observed-bar-precedence' };
      }
      bars[lo] = rec;
      return { ok: true, replaced: true };
    }

    // A bar older than everything a full ring has already evicted would
    // reappear as a false "oldest observation" — refuse it.
    if (bars.length >= store.cap && rec.t < bars[0].t) {
      return { ok: false, reason: 'below-ring-horizon' };
    }

    bars.splice(lo, 0, rec);
    if (bars.length > store.cap) bars.splice(0, bars.length - store.cap);
    return { ok: true, replaced: false };
  }

  /* Copy out — callers may not mutate the ring through the return value. */
  function bars(store, market, resSec) {
    const buf = store.buffers[bufKey(market, resSec)];
    return buf ? buf.bars.map((b) => Object.assign({}, b)) : [];
  }

  /* Missing grid slots between the oldest and newest kept bar, as
   * inclusive [fromT, toT] spans. This is the backfiller's work order. */
  function gaps(store, market, resSec) {
    const buf = store.buffers[bufKey(market, resSec)];
    if (!buf || buf.bars.length < 2) return [];
    const out = [];
    for (let i = 1; i < buf.bars.length; i++) {
      const prevT = buf.bars[i - 1].t;
      const curT = buf.bars[i].t;
      if (curT - prevT > resSec) out.push({ fromT: prevT + resSec, toT: curT - resSec });
    }
    return out;
  }

  function coverage(store, market, resSec) {
    const buf = store.buffers[bufKey(market, resSec)];
    if (!buf || buf.bars.length === 0) {
      return { total: 0, live: 0, backfilled: 0, oldestT: null, newestT: null, contiguous: true };
    }
    let live = 0;
    for (const b of buf.bars) if (b.prov === PROV_LIVE) live++;
    return {
      total: buf.bars.length,
      live,
      backfilled: buf.bars.length - live,
      oldestT: buf.bars[0].t,
      newestT: buf.bars[buf.bars.length - 1].t,
      contiguous: gaps(store, market, resSec).length === 0,
    };
  }

  const api = {
    createStore,
    noteBar,
    bars,
    gaps,
    coverage,
    validateBar,
    PROV_LIVE,
    DEFAULT_CAP,
  };

  if (typeof window !== 'undefined') window.PaperBars = api;
  if (typeof self !== 'undefined') self.PaperBars = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
