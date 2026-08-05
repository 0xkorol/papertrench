/* PaperTrench — warm destination classifier (Instant Everything links).
 *
 * The X classifier (xlinks.js) proved the pattern: a tiny, shared, paranoid
 * URL classifier loaded by every layer that must agree on what a link IS —
 * the background (routing), and the terminal-side ISOLATED world (click and
 * hover interception). This is the same contract for the two NON-X cold
 * destinations every token row on the supported terminals carries:
 *
 *   pumpfun — pump.fun coin pages (and the board / profiles)
 *   solscan — solscan.io token / account / tx pages
 *
 * Contract, identical to xlinks.js:
 *   - https only; anything else is not ours.
 *   - Path and query pass through BYTE-FOR-BYTE onto the canonical host.
 *     Classification must never be the reason a page looks different.
 *   - Unknown shapes return null and the click stays native. A warm route
 *     that guesses is worse than a cold tab that works.
 */
(() => {
  'use strict';

  const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

  const PUMP_HOSTS = new Set(['pump.fun', 'www.pump.fun']);
  const SOLSCAN_HOSTS = new Set(['solscan.io', 'www.solscan.io']);

  function parse(href, baseHref) {
    try {
      const url = baseHref ? new URL(href, baseHref) : new URL(href);
      return url.protocol === 'https:' ? url : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Classify a link into a warm destination.
   * Returns { family, url, kind } or null. `url` is canonical (bare host),
   * path + search preserved byte-for-byte.
   */
  function classify(href, baseHref) {
    const url = parse(href, baseHref);
    if (!url) return null;
    const host = url.hostname.toLowerCase();
    const path = url.pathname;

    if (PUMP_HOSTS.has(host)) {
      // Coin pages: /coin/<mint> plus the legacy bare /<mint> route; profiles
      // and the board are cheap wins too (all fully public).
      const coin = path.match(/^\/coin\/([1-9A-HJ-NP-Za-km-z]{32,44})(?:$|[/?#])/);
      const bare = path.match(/^\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
      const profile = /^\/profile\//.test(path);
      const board = path === '/board' || path === '/' || path === '/advanced';
      if (!coin && !bare && !profile && !board) return null;
      return {
        family: 'pumpfun',
        kind: coin || bare ? 'coin' : (profile ? 'profile' : 'board'),
        url: 'https://pump.fun' + path + url.search,
      };
    }

    if (SOLSCAN_HOSTS.has(host)) {
      const m = path.match(/^\/(token|account|address|tx)\/([^/?#]+)/);
      if (!m) return null;
      // Token/account segments must be whole base58; tx signatures are longer
      // base58 runs — accept 32..96 there.
      const seg = m[2];
      if (m[1] === 'tx') {
        if (!/^[1-9A-HJ-NP-Za-km-z]{43,96}$/.test(seg)) return null;
      } else if (!BASE58_RE.test(seg)) {
        return null;
      }
      return {
        family: 'solscan',
        kind: m[1],
        url: 'https://solscan.io' + path + url.search,
      };
    }

    return null;
  }

  function isWarmDestHost(hostname) {
    const h = String(hostname || '').toLowerCase();
    return PUMP_HOSTS.has(h) || SOLSCAN_HOSTS.has(h);
  }

  /** Which family a hostname belongs to, or null. The terminal-side
   * interceptor uses this for the same-site guard: a pump.fun link clicked ON
   * pump.fun stays native — the site's own SPA router beats a tab swap. */
  function familyOfHost(hostname) {
    const h = String(hostname || '').toLowerCase();
    if (/(^|\.)pump\.fun$/.test(h)) return 'pumpfun';
    if (/(^|\.)solscan\.io$/.test(h)) return 'solscan';
    return null;
  }

  const api = { classify, isWarmDestHost, familyOfHost };
  const root = typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis);
  root.PTWarmDest = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
