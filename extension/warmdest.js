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
  // The main terminals people actually trade on (maintainer's call): a token
  // link to one of these clicked on ANOTHER terminal warm-routes instead of
  // cold-loading — and the positions-bar chip hop between terminals stops
  // costing the tab you were on. Route shapes mirror sites.js adapters
  // (same O-10/O-11 discipline: token routes only, wallet/portfolio never).
  const AXIOM_HOST_RE = /(^|\.)axiom\.trade$/;
  const PADRE_HOST_RE = /(^|\.)padre\.gg$/;
  const GMGN_HOST_RE = /(^|\.)gmgn\.ai$/;
  const FOMO_HOST_RE = /(^|\.)fomo\.family$/;

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

    if (AXIOM_HOST_RE.test(host)) {
      // axiom.trade/meme/<pair> and /t/<mint> — token pages only (the wallet
      // and profile routes also end in base58 and must never warm-route).
      const m = path.match(/^\/(meme|t)\/([1-9A-HJ-NP-Za-km-z]{32,44})(?:$|[/?#])/);
      if (!m) return null;
      return { family: 'axiom', kind: 'token', url: 'https://axiom.trade' + path + url.search };
    }

    if (PADRE_HOST_RE.test(host)) {
      // trade.padre.gg/trade/<chain>/<mint> (and legacy /terminal/ routes).
      const m = path.match(/^\/(?:trade|terminal)\/(?:[a-z0-9-]+\/)*([1-9A-HJ-NP-Za-km-z]{32,44})(?:$|[/?#])/);
      if (!m) return null;
      return { family: 'padre', kind: 'token', url: 'https://trade.padre.gg' + path + url.search };
    }

    if (GMGN_HOST_RE.test(host)) {
      // gmgn.ai/sol/token/<mint> — Solana only, same gate as the adapter.
      const m = path.match(/^\/sol\/token\/([1-9A-HJ-NP-Za-km-z]{32,44})(?:$|[/?#])/);
      if (!m) return null;
      return { family: 'gmgn', kind: 'token', url: 'https://gmgn.ai' + path + url.search };
    }

    if (FOMO_HOST_RE.test(host)) {
      // fomo.family/tokens/solana/<mint> — the solana chain slug only, same
      // gate as the sites.js adapter (fomo is multichain and its own /token
      // entry point lands users on EVM pages routinely), and token pages
      // only: /u/ and /profile/ handle routes are never warm-routed.
      const m = path.match(/^\/tokens\/solana\/([1-9A-HJ-NP-Za-km-z]{32,44})(?:$|[/?#])/);
      if (!m) return null;
      return { family: 'fomo', kind: 'token', url: 'https://fomo.family' + path + url.search };
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
    return familyOfHost(hostname) !== null;
  }

  /** Which family a hostname belongs to, or null. The terminal-side
   * interceptor uses this for the same-site guard: a pump.fun link clicked ON
   * pump.fun stays native — the site's own SPA router beats a tab swap. */
  function familyOfHost(hostname) {
    const h = String(hostname || '').toLowerCase();
    if (/(^|\.)pump\.fun$/.test(h)) return 'pumpfun';
    if (/(^|\.)solscan\.io$/.test(h)) return 'solscan';
    if (AXIOM_HOST_RE.test(h)) return 'axiom';
    if (PADRE_HOST_RE.test(h)) return 'padre';
    if (GMGN_HOST_RE.test(h)) return 'gmgn';
    if (FOMO_HOST_RE.test(h)) return 'fomo';
    return null;
  }

  const api = { classify, isWarmDestHost, familyOfHost };
  if (typeof window !== 'undefined') window.PTWarmDest = api;
  if (typeof self !== 'undefined') self.PTWarmDest = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
