/* PaperTrench — page-title market-cap signal.
 *
 * Every supported terminal publishes the live market cap in document.title:
 *
 *   GMGN    "Bonk  $255.83M | GMGN.AI | The Fastest Multi-Chain Meme..."
 *   Padre   "... $1.2M ..."
 *   Photon  "MC: $412K ..."
 *   Axiom   "... $89.4K ..."
 *
 * A title change fires the instant the site re-renders — no network request, no
 * DOM traversal, no polling. It is the cheapest change signal available in the
 * page, and MutationObserver on <title> delivers it in the same task.
 *
 * WHAT THIS IS NOT
 *
 * This is a SIGNAL, never a source of truth. A competing extension parses this
 * same title and divides by a hardcoded 1e9 supply to infer a token price,
 * which is wrong for every token whose supply is not exactly one billion, and
 * wrong again whenever the title shows something other than market cap.
 *
 * PaperTrench uses the title only to (a) refresh the market cap it displays
 * between chain updates and (b) wake the on-chain reader early. Fills are
 * always priced from chain state. A title figure is accepted only when it is
 * within a sane band of the market cap already established on-chain, so a
 * mis-parse can never move the number the user trades against.
 */
(() => {
  'use strict';

  const MULTIPLIERS = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };

  /**
   * Title patterns per site, verified against live pages.
   * Each must capture a number plus an optional magnitude suffix.
   */
  const TITLE_PATTERNS = {
    gmgn: [/\$([0-9][0-9,.]*)\s*([KMBT])?\s*\|/i, /\$([0-9][0-9,.]*)\s*([KMBT])?/i],
    padre: [/\$([0-9][0-9,.]*)\s*([KMBT])?/i],
    photon: [/MC:\s*\$([0-9][0-9,.]*)\s*([KMBT])?/i, /\$([0-9][0-9,.]*)\s*([KMBT])?/i],
    axiom: [/\$([0-9][0-9,.]*)\s*([KMBT])?/i],
    bullx: [/\$([0-9][0-9,.]*)\s*([KMBT])?/i],
    dexscreener: [/\$([0-9][0-9,.]*)\s*([KMBT])?/i],
    birdeye: [/\$([0-9][0-9,.]*)\s*([KMBT])?/i],
    // Fomo titles lead with the cap and carry NO dollar sign
    // ("246.3M MC | BONK | fomo", verified live 2026-08-05). Only the
    // ^-anchored MC form is accepted: with no $ to key on, an unanchored
    // number pattern could read a numeric token name as the cap.
    fomo: [/^([0-9][0-9,.]*)([KMBT])?\s*MC\s*\|/i],
  };

  /**
   * A title number is only believable if it is close to the market cap chain
   * state already proved. 3x in either direction absorbs a genuine fast move
   * while rejecting a price/cap mix-up, which is off by many orders of
   * magnitude on a memecoin.
   */
  const ACCEPT_RATIO = 3;

  let observer = null;
  let headObserver = null;
  let listeners = new Set();
  let lastEmitted = null;

  /** Parse a market cap out of a page title. Returns null when unsure. */
  function parseTitle(title, siteId) {
    const candidates = parseTitleCandidates(title, siteId);
    return candidates.length ? candidates[0] : null;
  }

  /**
   * Every distinct dollar figure a title offers under the site's patterns.
   * Values within 5% of an already-collected one are treated as duplicates.
   * Earlier patterns are more specific (an "MC:" or "|"-anchored form), so
   * the first pattern that yields anything wins.
   */
  function parseTitleCandidates(title, siteId) {
    if (typeof title !== 'string' || !title) return [];
    const patterns = TITLE_PATTERNS[siteId] || TITLE_PATTERNS.gmgn;
    const values = [];
    for (const pattern of patterns) {
      const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g';
      const global = new RegExp(pattern.source, flags);
      let match;
      while ((match = global.exec(title)) !== null) {
        const digits = Number(String(match[1]).replace(/,/g, ''));
        if (!(digits > 0)) continue;
        const suffix = match[2] ? match[2].toUpperCase() : '';
        const value = digits * (MULTIPLIERS[suffix] || 1);
        if (!isFinite(value) || value <= 0) continue;
        // A market cap below $100 is not a market cap; it is a stray number.
        if (value < 100) continue;
        if (!values.some((v) => Math.abs(v - value) / value < 0.05)) values.push(value);
      }
      if (values.length) break;
    }
    return values;
  }

  /**
   * The one figure a title is allowed to contribute, or null.
   *
   * Ambiguity rule (DEFECT F-23): a tab title can carry several dollar
   * figures — the cap, a P&L, a position value. Accept only when exactly ONE
   * distinct candidate is consistent with the on-chain anchor; two in-band
   * but different figures mean we cannot know which is the cap, so refuse
   * rather than guess.
   */
  function acceptFromTitle(title, siteId, anchorMcap) {
    const candidates = parseTitleCandidates(title, siteId);
    const inBand = [];
    for (const c of candidates) {
      const v = validate(c, anchorMcap);
      if (v !== null && !inBand.some((x) => Math.abs(x - v) / v < 0.05)) inBand.push(v);
    }
    return inBand.length === 1 ? inBand[0] : null;
  }

  /**
   * Validate a parsed title figure against the market cap chain state already
   * established. Without an anchor there is nothing to check it against, so it
   * is refused rather than guessed at.
   */
  function validate(candidate, anchorMcap) {
    if (!(candidate > 0)) return null;
    if (!(anchorMcap > 0)) return null;
    const ratio = candidate > anchorMcap ? candidate / anchorMcap : anchorMcap / candidate;
    return ratio <= ACCEPT_RATIO ? candidate : null;
  }

  function emit(mcap) {
    lastEmitted = mcap;
    for (const fn of listeners) {
      try { fn(mcap); } catch (_) { /* one bad listener must not stop the feed */ }
    }
  }

  /**
   * Watch <title> for changes.
   *
   * `getAnchor()` supplies the current on-chain market cap so every candidate
   * can be validated before it reaches the UI.
   */
  function start(siteId, getAnchor) {
    stop();
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return false;

    const read = () => {
      const anchor = typeof getAnchor === 'function' ? getAnchor() : null;
      const accepted = acceptFromTitle(document.title, siteId, anchor);
      if (accepted && accepted !== lastEmitted) emit(accepted);
    };

    const attach = () => {
      const titleEl = document.querySelector('title');
      if (!titleEl) return false;
      observer = new MutationObserver(read);
      observer.observe(titleEl, { childList: true, characterData: true, subtree: true });
      read();
      return true;
    };

    if (attach()) return true;

    // An SPA that has not set <title> yet is the NORMAL case at document_idle
    // on several supported sites. Giving up permanently left the title signal
    // dead for the entire page load (DEFECT F-22) — wait for the element.
    headObserver = new MutationObserver(() => {
      if (attach() && headObserver) { headObserver.disconnect(); headObserver = null; }
    });
    headObserver.observe(document.head || document.documentElement, { childList: true, subtree: true });
    return true;
  }

  function stop() {
    if (observer) { observer.disconnect(); observer = null; }
    if (headObserver) { headObserver.disconnect(); headObserver = null; }
    lastEmitted = null;
  }

  function onMarketCap(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  const api = {
    parseTitle, parseTitleCandidates, acceptFromTitle, validate, start, stop,
    onMarketCap, ACCEPT_RATIO, TITLE_PATTERNS,
    _lastEmitted: () => lastEmitted,
  };

  if (typeof window !== 'undefined') window.PTTitleFeed = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
