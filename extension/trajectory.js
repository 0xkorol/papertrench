/* PaperTrench — pointer trajectory predictor (Turbo II).
 *
 * Pure geometry, no DOM: warm-links.js feeds it pointer samples and asks
 * where the cursor will be in ~200ms. A prediction comes back only when the
 * recent motion is FAST enough to be going somewhere and STRAIGHT enough to
 * mean it — everything else returns null and the caller falls back to the
 * plain hover dwell. A prediction can only ever fire the same hint a hover
 * would have fired a beat later; this module exists so that judgment call is
 * testable arithmetic instead of a magic number buried in a listener.
 */
(() => {
  'use strict';

  const HISTORY_MS = 160;     // samples older than this no longer describe intent
  const MAX_SAMPLES = 12;     // bound memory under high-frequency mice
  const MIN_SAMPLES = 3;      // two points is a line; three is a direction
  const MIN_SPEED = 0.15;     // px/ms — a drifting cursor is not going anywhere
  const MAX_SPEED = 5;        // px/ms — a flick is a gesture, not an aim
  const MIN_ALIGNMENT = 0.85; // cosine between half-window velocities

  function velocity(list) {
    const a = list[0];
    const b = list[list.length - 1];
    const dt = b.t - a.t;
    if (dt <= 0) return null;
    return { vx: (b.x - a.x) / dt, vy: (b.y - a.y) / dt };
  }

  function createTracker() {
    let samples = [];

    function sample(x, y, t) {
      samples.push({ x, y, t });
      while (samples.length && samples[0].t < t - HISTORY_MS) samples.shift();
      if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
    }

    /** Where the pointer will be horizonMs from the LAST sample, or null when
     * the motion does not justify a guess. Never extrapolates beyond what the
     * gates allow: slow drift, flicks, and direction changes all return null. */
    function predict(horizonMs) {
      if (samples.length < MIN_SAMPLES) return null;
      const v = velocity(samples);
      if (!v) return null;
      const speed = Math.hypot(v.vx, v.vy);
      if (speed < MIN_SPEED || speed > MAX_SPEED) return null;
      // Straightness: the early half and the late half of the window must
      // agree on direction, or the cursor is turning and the target unknown.
      const mid = Math.floor(samples.length / 2);
      const early = velocity(samples.slice(0, mid + 1));
      const late = velocity(samples.slice(mid));
      if (!early || !late) return null;
      const earlySpeed = Math.hypot(early.vx, early.vy);
      const lateSpeed = Math.hypot(late.vx, late.vy);
      if (!earlySpeed || !lateSpeed) return null;
      const cos = (early.vx * late.vx + early.vy * late.vy) / (earlySpeed * lateSpeed);
      if (cos < MIN_ALIGNMENT) return null;
      const last = samples[samples.length - 1];
      return {
        x: last.x + v.vx * horizonMs,
        y: last.y + v.vy * horizonMs,
        speed,
      };
    }

    function reset() { samples = []; }

    return { sample, predict, reset };
  }

  const api = { createTracker, MIN_SPEED, MAX_SPEED, MIN_ALIGNMENT };
  if (typeof window !== 'undefined') window.PTTrajectory = api;
  if (typeof self !== 'undefined') self.PTTrajectory = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
