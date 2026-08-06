/* PaperTrench — TA core (pure).
 *
 * Indicators, market structure, and deterministic setup detectors over bar
 * arrays from the bar store. Pure functions, no DOM, no chrome APIs, no
 * randomness, no clock — everything is reproducible from the bars passed in.
 *
 * Honesty rules enforced at this layer:
 *  - warm-up truth: an indicator returns null at every index where its full
 *    window is not yet available. No partial values, no padding, ever.
 *  - silence default: a detector returns null unless EVERY stated condition
 *    holds. No composite confidence scores — the only grounding shown to the
 *    user is their own journal record for the setup, computed elsewhere.
 *  - a read without an invalidation is not a read: assembleReads() drops any
 *    setup lacking a finite invalidation price (contract-tested).
 *
 * The split follows xray-core: this module decides, the card only formats.
 */
(() => {
  'use strict';

  const DEFAULTS = {
    emaFast: 9,
    emaSlow: 21,
    rsiPeriod: 14,
    atrPeriod: 14,
    swingK: 3,            // bars on each side that a pivot must dominate
    srClusterAtr: 0.5,    // pivots within this many ATRs cluster into a level
    srMinTouches: 2,      // a level below this many touches is noise
    volRegimePeriod: 20,
    pullbackWindow: 5,    // bars in which the EMA-slow touch must have happened
    pullbackTouchAtr: 0.25,
    invalidationAtr: 1.0, // fallback stop distance when no swing anchors one
    breakWindow: 12,      // bars in which break + retest must both occur
    breakAtr: 0.5,        // close must clear the level by this many ATRs
    retestTolAtr: 0.25,
    stretchAtr: 2.0,      // distance from VWAP that counts as stretched
    rsiOversold: 35,
    rsiOverbought: 65,
    divWindow: 40,        // max bars between the two divergence pivots
    divLevelTolAtr: 0.5,  // divergence must anchor this close to a level
  };

  const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
  const last = (arr) => (arr.length ? arr[arr.length - 1] : null);

  /* ------------------------------ indicators ------------------------------ */

  function sma(values, n) {
    const out = new Array(values.length).fill(null);
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= n) sum -= values[i - n];
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  }

  /* Standard EMA: seeded with the SMA of the first n values, recursive with
   * k = 2/(n+1) afterwards. Null until the seed index. */
  function ema(values, n) {
    const out = new Array(values.length).fill(null);
    if (n <= 0 || values.length < n) return out;
    let seed = 0;
    for (let i = 0; i < n; i++) seed += values[i];
    let prev = seed / n;
    out[n - 1] = prev;
    const k = 2 / (n + 1);
    for (let i = n; i < values.length; i++) {
      prev = prev + k * (values[i] - prev);
      out[i] = prev;
    }
    return out;
  }

  /* Wilder RSI. First value at index n (needs n deltas), Wilder-smoothed
   * afterwards. All-gain windows read 100, all-loss windows read 0. */
  function rsi(closes, n) {
    const out = new Array(closes.length).fill(null);
    if (n <= 0 || closes.length < n + 1) return out;
    let gain = 0, loss = 0;
    for (let i = 1; i <= n; i++) {
      const d = closes[i] - closes[i - 1];
      if (d >= 0) gain += d; else loss -= d;
    }
    let avgGain = gain / n, avgLoss = loss / n;
    const toRsi = () => {
      if (avgLoss === 0 && avgGain === 0) return 50;
      if (avgLoss === 0) return 100;
      return 100 - 100 / (1 + avgGain / avgLoss);
    };
    out[n] = toRsi();
    for (let i = n + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      avgGain = (avgGain * (n - 1) + Math.max(d, 0)) / n;
      avgLoss = (avgLoss * (n - 1) + Math.max(-d, 0)) / n;
      out[i] = toRsi();
    }
    return out;
  }

  function trueRanges(bars) {
    const out = new Array(bars.length).fill(null);
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      if (i === 0) { out[i] = b.h - b.l; continue; }
      const pc = bars[i - 1].c;
      out[i] = Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
    }
    return out;
  }

  /* Wilder ATR: seeded with the mean of the first n true ranges, smoothed
   * with (prev*(n-1)+tr)/n afterwards. */
  function atr(bars, n) {
    const out = new Array(bars.length).fill(null);
    if (n <= 0 || bars.length < n) return out;
    const tr = trueRanges(bars);
    let seed = 0;
    for (let i = 0; i < n; i++) seed += tr[i];
    let prev = seed / n;
    out[n - 1] = prev;
    for (let i = n; i < bars.length; i++) {
      prev = (prev * (n - 1) + tr[i]) / n;
      out[i] = prev;
    }
    return out;
  }

  /* Session VWAP over the bars given (the caller decides the session slice).
   * A bar without volume data makes VWAP null from that bar on: an unknown
   * weight poisons the cumulative sum, and a guessed weight would be a lie.
   * All-zero volume is also null — VWAP of an untraded session is undefined. */
  function vwap(bars) {
    const out = new Array(bars.length).fill(null);
    let pv = 0, vol = 0, poisoned = false;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      if (!isNum(b.v)) poisoned = true;
      if (poisoned) continue;
      pv += ((b.h + b.l + b.c) / 3) * b.v;
      vol += b.v;
      out[i] = vol > 0 ? pv / vol : null;
    }
    return out;
  }

  /* ------------------------------ structure ------------------------------ */

  /* Fractal pivots: a pivot high at i strictly dominates the k bars on each
   * side. A pivot only EXISTS once its k right-side bars have printed —
   * confirmedAt carries that index so nothing downstream can act on a pivot
   * before the market actually confirmed it. Consecutive same-type pivots
   * collapse to the more extreme one, so the list alternates. */
  function swings(bars, k) {
    const raw = [];
    for (let i = k; i < bars.length - k; i++) {
      let isHigh = true, isLow = true;
      for (let j = 1; j <= k; j++) {
        if (bars[i].h <= bars[i - j].h || bars[i].h <= bars[i + j].h) isHigh = false;
        if (bars[i].l >= bars[i - j].l || bars[i].l >= bars[i + j].l) isLow = false;
        if (!isHigh && !isLow) break;
      }
      if (isHigh) raw.push({ type: 'high', i, t: bars[i].t, price: bars[i].h, confirmedAt: i + k });
      else if (isLow) raw.push({ type: 'low', i, t: bars[i].t, price: bars[i].l, confirmedAt: i + k });
    }
    const out = [];
    for (const p of raw) {
      const prev = last(out);
      if (prev && prev.type === p.type) {
        const keepNew = p.type === 'high' ? p.price > prev.price : p.price < prev.price;
        if (keepNew) out[out.length - 1] = p;
      } else {
        out.push(p);
      }
    }
    return out;
  }

  /* Trend from the last two confirmed pivot pairs. null means "not enough
   * structure to say" — which is a different statement from 'range', and the
   * card is required to keep them different. */
  function structure(pivots) {
    const highs = pivots.filter((p) => p.type === 'high');
    const lows = pivots.filter((p) => p.type === 'low');
    if (highs.length < 2 || lows.length < 2) return null;
    const lastH = highs[highs.length - 1].price, prevH = highs[highs.length - 2].price;
    const lastL = lows[lows.length - 1].price, prevL = lows[lows.length - 2].price;
    if (lastH > prevH && lastL > prevL) return 'uptrend';
    if (lastH < prevH && lastL < prevL) return 'downtrend';
    // Equal pivots are a range statement, not a trend — strict on both sides.
    return 'range';
  }

  /* Support/resistance: pivot prices clustered within srClusterAtr ATRs.
   * Levels need a warm ATR — without a noise unit, "close together" is not a
   * statement we can make. */
  function srLevels(pivots, atrValue, opts) {
    const o = Object.assign({}, DEFAULTS, opts);
    if (!isNum(atrValue) || atrValue <= 0 || pivots.length === 0) return [];
    const tol = o.srClusterAtr * atrValue;
    const sorted = pivots.slice().sort((a, b) => a.price - b.price);
    const clusters = [];
    for (const p of sorted) {
      const cur = last(clusters);
      if (cur && p.price - cur.prices[cur.prices.length - 1] <= tol) {
        cur.prices.push(p.price);
        cur.lastT = Math.max(cur.lastT, p.t);
      } else {
        clusters.push({ prices: [p.price], lastT: p.t });
      }
    }
    return clusters
      .filter((c) => c.prices.length >= o.srMinTouches)
      .map((c) => ({
        price: c.prices.reduce((a, b) => a + b, 0) / c.prices.length,
        touches: c.prices.length,
        lastT: c.lastT,
      }))
      .sort((a, b) => b.touches - a.touches || b.lastT - a.lastT);
  }

  /* Current volume vs the median of the window before it. */
  function volumeRegime(bars, n) {
    if (bars.length < n + 1) return null;
    const windowBars = bars.slice(bars.length - 1 - n, bars.length - 1);
    const cur = last(bars);
    if (!isNum(cur.v)) return null;
    const vols = [];
    for (const b of windowBars) {
      if (!isNum(b.v)) return null;
      vols.push(b.v);
    }
    vols.sort((a, b) => a - b);
    const mid = vols.length >> 1;
    const median = vols.length % 2 ? vols[mid] : (vols[mid - 1] + vols[mid]) / 2;
    if (median === 0) return cur.v > 0 ? 'elevated' : 'quiet';
    const ratio = cur.v / median;
    if (ratio >= 2) return 'elevated';
    if (ratio <= 0.5) return 'quiet';
    return 'normal';
  }

  /* Regime = EMA relation and structure agreeing. Either input unavailable
   * means the regime is unknown, not "range". */
  function regime(emaFastVal, emaSlowVal, structureVal) {
    if (!isNum(emaFastVal) || !isNum(emaSlowVal) || structureVal === null) return null;
    if (emaFastVal > emaSlowVal && structureVal === 'uptrend') return 'uptrend';
    if (emaFastVal < emaSlowVal && structureVal === 'downtrend') return 'downtrend';
    return 'range';
  }

  /* The ATR × leverage bridge: liquidation distance in noise units. */
  function liqDistanceAtr(price, liqPrice, atrValue) {
    if (!isNum(price) || !isNum(liqPrice) || !isNum(atrValue) || atrValue <= 0) return null;
    return Math.abs(price - liqPrice) / atrValue;
  }

  /* ------------------------------ detectors ------------------------------
   *
   * Each detector takes the shared context assembled by assembleReads():
   *   { bars, closes, emaFastArr, emaSlowArr, rsiArr, atrArr, vwapArr,
   *     pivots, levels, structure, regime, opts }
   * and returns a setup object or null. Setup shape:
   *   { setup, direction, entryZone: [lo, hi], invalidation, targets: [],
   *     basis: { ...the numbers each rule fired on } }
   * Targets are never invented: no anchor above/below means an empty list.
   */

  function confirmedPivots(ctx) {
    const lastIdx = ctx.bars.length - 1;
    return ctx.pivots.filter((p) => p.confirmedAt <= lastIdx);
  }

  function detectPullback(ctx) {
    const o = ctx.opts;
    const i = ctx.bars.length - 1;
    const ef = ctx.emaFastArr[i], es = ctx.emaSlowArr[i], a = ctx.atrArr[i];
    if (!isNum(ef) || !isNum(es) || !isNum(a) || a <= 0) return null;
    if (ctx.regime !== 'uptrend' && ctx.regime !== 'downtrend') return null;
    const long = ctx.regime === 'uptrend';

    // The pullback: within the window, price must have touched the slow EMA
    // zone (slow EMA ± touch tolerance in ATRs).
    let touched = false;
    const from = Math.max(0, i - o.pullbackWindow + 1);
    for (let j = from; j <= i; j++) {
      const esj = ctx.emaSlowArr[j];
      if (!isNum(esj)) continue;
      if (long && ctx.bars[j].l <= esj + o.pullbackTouchAtr * a) touched = true;
      if (!long && ctx.bars[j].h >= esj - o.pullbackTouchAtr * a) touched = true;
    }
    if (!touched) return null;

    // The reclaim: the last close is back on the trend side of the fast EMA.
    const c = ctx.closes[i];
    if (long && c <= ef) return null;
    if (!long && c >= ef) return null;

    const pivots = confirmedPivots(ctx);
    const anchor = long
      ? last(pivots.filter((p) => p.type === 'low' && p.price < c))
      : last(pivots.filter((p) => p.type === 'high' && p.price > c));
    const invalidation = anchor
      ? anchor.price
      : (long ? es - o.invalidationAtr * a : es + o.invalidationAtr * a);
    const targetPivot = long
      ? last(pivots.filter((p) => p.type === 'high' && p.price > c))
      : last(pivots.filter((p) => p.type === 'low' && p.price < c));

    return {
      setup: 'trend-pullback',
      direction: long ? 'long' : 'short',
      entryZone: [Math.min(ef, es), Math.max(ef, es)],
      invalidation,
      targets: targetPivot ? [targetPivot.price] : [],
      basis: { emaFast: ef, emaSlow: es, atr: a, close: c, regime: ctx.regime },
    };
  }

  function detectBreakRetest(ctx) {
    const o = ctx.opts;
    const i = ctx.bars.length - 1;
    const a = ctx.atrArr[i];
    if (!isNum(a) || a <= 0 || ctx.levels.length === 0) return null;
    const c = ctx.closes[i];
    const from = Math.max(1, i - o.breakWindow + 1);

    for (const level of ctx.levels) {
      for (const long of [true, false]) {
        const cleared = (px) => (long ? px >= level.price + o.breakAtr * a : px <= level.price - o.breakAtr * a);
        // The break: a close that clears the level by the ATR margin, whose
        // PREVIOUS close sat strictly on the other side of the level. Merely
        // drifting out of the tolerance band is noise, not a break.
        const crossedFrom = (px) => (long ? px < level.price : px > level.price);
        let breakIdx = -1;
        for (let j = from; j <= i; j++) {
          if (cleared(ctx.closes[j]) && crossedFrom(ctx.closes[j - 1])) { breakIdx = j; break; }
        }
        if (breakIdx < 0 || breakIdx === i) continue;
        // The retest: after the break, price came back to the level...
        let retested = false;
        for (let j = breakIdx + 1; j <= i; j++) {
          const nearLevel = long
            ? ctx.bars[j].l <= level.price + o.retestTolAtr * a
            : ctx.bars[j].h >= level.price - o.retestTolAtr * a;
          if (nearLevel) { retested = true; break; }
        }
        if (!retested) continue;
        // ...and the last close still holds the break side of the level.
        if (long && c <= level.price) continue;
        if (!long && c >= level.price) continue;

        const beyond = ctx.levels
          .filter((lv) => (long ? lv.price > level.price : lv.price < level.price))
          .sort((x, y) => (long ? x.price - y.price : y.price - x.price));
        return {
          setup: 'break-retest',
          direction: long ? 'long' : 'short',
          entryZone: long
            ? [level.price, level.price + o.retestTolAtr * a]
            : [level.price - o.retestTolAtr * a, level.price],
          invalidation: long
            ? level.price - o.retestTolAtr * a
            : level.price + o.retestTolAtr * a,
          targets: beyond.length ? [beyond[0].price] : [],
          basis: { level: level.price, touches: level.touches, breakIdx, atr: a, close: c },
        };
      }
    }
    return null;
  }

  function detectVwapReversion(ctx) {
    const o = ctx.opts;
    const i = ctx.bars.length - 1;
    const a = ctx.atrArr[i], w = ctx.vwapArr[i];
    if (!isNum(a) || a <= 0 || !isNum(w)) return null;
    const c = ctx.closes[i];
    const stretch = (c - w) / a;
    if (Math.abs(stretch) < o.stretchAtr) return null;
    const short = stretch > 0; // stretched above VWAP → reversion is a short

    // Reversal hint: the last bar closed against the stretch, or RSI turned
    // back from its extreme. Stretch alone is a trend, not a setup.
    const bar = ctx.bars[i];
    const counterBar = short ? bar.c < bar.o : bar.c > bar.o;
    const r = ctx.rsiArr[i], rPrev = ctx.rsiArr[i - 1];
    const rsiTurn = isNum(r) && isNum(rPrev)
      && (short ? (rPrev >= o.rsiOverbought && r < rPrev) : (rPrev <= o.rsiOversold && r > rPrev));
    if (!counterBar && !rsiTurn) return null;

    return {
      setup: 'vwap-reversion',
      direction: short ? 'short' : 'long',
      entryZone: [c, c],
      invalidation: short ? c + o.invalidationAtr * a : c - o.invalidationAtr * a,
      targets: [w],
      basis: { vwap: w, stretchAtr: stretch, atr: a, close: c, counterBar, rsiTurn },
    };
  }

  function detectDivergence(ctx) {
    const o = ctx.opts;
    const i = ctx.bars.length - 1;
    const a = ctx.atrArr[i];
    if (!isNum(a) || a <= 0 || ctx.levels.length === 0) return null;
    const pivots = confirmedPivots(ctx);
    const c = ctx.closes[i];

    for (const long of [true, false]) {
      const type = long ? 'low' : 'high';
      const side = pivots.filter((p) => p.type === type && i - p.i <= o.divWindow);
      if (side.length < 2) continue;
      const p1 = side[side.length - 2], p2 = side[side.length - 1];
      const r1 = ctx.rsiArr[p1.i], r2 = ctx.rsiArr[p2.i];
      if (!isNum(r1) || !isNum(r2)) continue;

      // Price extends, momentum refuses: lower low with higher RSI (bullish)
      // or higher high with lower RSI (bearish), from an RSI extreme.
      const priceExtends = long ? p2.price < p1.price : p2.price > p1.price;
      const momentumRefuses = long ? r2 > r1 : r2 < r1;
      const fromExtreme = long ? r1 <= o.rsiOversold : r1 >= o.rsiOverbought;
      if (!priceExtends || !momentumRefuses || !fromExtreme) continue;

      // Grounded at structure: the second pivot must sit at a known level.
      const anchored = ctx.levels.some((lv) => Math.abs(p2.price - lv.price) <= o.divLevelTolAtr * a);
      if (!anchored) continue;

      const targetLevel = ctx.levels
        .filter((lv) => (long ? lv.price > c : lv.price < c))
        .sort((x, y) => (long ? x.price - y.price : y.price - x.price))[0];
      return {
        setup: 'rsi-divergence',
        direction: long ? 'long' : 'short',
        entryZone: [Math.min(p2.price, c), Math.max(p2.price, c)],
        invalidation: long
          ? p2.price - o.invalidationAtr * a
          : p2.price + o.invalidationAtr * a,
        targets: targetLevel ? [targetLevel.price] : [],
        basis: { pivot1: p1.price, pivot2: p2.price, rsi1: r1, rsi2: r2, atr: a },
      };
    }
    return null;
  }

  /* ------------------------------ assembly ------------------------------ */

  const DETECTORS = [detectPullback, detectBreakRetest, detectVwapReversion, detectDivergence];

  /* The context pack: everything the TA card and the AI narrator are allowed
   * to know, computed in one place. Latest-value fields are null until their
   * windows are genuinely full; `warm` says what is still missing so the
   * card can print "warming up: 14/21 bars" instead of a fabricated value. */
  function assembleReads(barsArr, opts) {
    const o = Object.assign({}, DEFAULTS, opts);
    const n = barsArr.length;
    const closes = barsArr.map((b) => b.c);
    const emaFastArr = ema(closes, o.emaFast);
    const emaSlowArr = ema(closes, o.emaSlow);
    const rsiArr = rsi(closes, o.rsiPeriod);
    const atrArr = atr(barsArr, o.atrPeriod);
    const vwapArr = vwap(barsArr);
    const pivots = swings(barsArr, o.swingK);
    const lastIdx = n - 1;
    const confirmed = pivots.filter((p) => p.confirmedAt <= lastIdx);
    const struct = structure(confirmed);
    const atrVal = lastIdx >= 0 ? atrArr[lastIdx] : null;
    const levels = srLevels(confirmed, atrVal, o);
    const reg = regime(
      lastIdx >= 0 ? emaFastArr[lastIdx] : null,
      lastIdx >= 0 ? emaSlowArr[lastIdx] : null,
      struct
    );

    const ctx = {
      bars: barsArr, closes, emaFastArr, emaSlowArr, rsiArr, atrArr, vwapArr,
      pivots, levels, structure: struct, regime: reg, opts: o,
    };

    // The framing contract: no invalidation, no read. A detector bug that
    // emits a stop-less setup gets filtered here and caught by tests.
    const setups = [];
    if (n > 0) {
      for (const detect of DETECTORS) {
        const s = detect(ctx);
        if (s && isNum(s.invalidation) && (s.direction === 'long' || s.direction === 'short')) {
          setups.push(s);
        }
      }
    }

    return {
      warm: {
        bars: n,
        needed: { emaFast: o.emaFast, emaSlow: o.emaSlow, rsi: o.rsiPeriod + 1, atr: o.atrPeriod },
      },
      regime: reg,
      structure: struct,
      emaFast: lastIdx >= 0 ? emaFastArr[lastIdx] : null,
      emaSlow: lastIdx >= 0 ? emaSlowArr[lastIdx] : null,
      rsi: lastIdx >= 0 ? rsiArr[lastIdx] : null,
      atr: atrVal,
      vwap: lastIdx >= 0 ? vwapArr[lastIdx] : null,
      volume: volumeRegime(barsArr, o.volRegimePeriod),
      pivots: confirmed,
      levels,
      setups,
    };
  }

  const api = {
    DEFAULTS,
    sma,
    ema,
    rsi,
    trueRanges,
    atr,
    vwap,
    swings,
    structure,
    srLevels,
    volumeRegime,
    regime,
    liqDistanceAtr,
    detectPullback,
    detectBreakRetest,
    detectVwapReversion,
    detectDivergence,
    assembleReads,
  };

  if (typeof window !== 'undefined') window.PaperTA = api;
  if (typeof self !== 'undefined') self.PaperTA = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
