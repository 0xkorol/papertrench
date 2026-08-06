/* PaperTrench — perps venue site adapters (pure).
 *
 * URL → market identity for the perps venues, plus extractors for the live
 * data each venue's own page exposes (title-carried price, Jupiter's
 * displayed borrow rate). Pure string functions — the content script feeds
 * them location/title/innerText and gets validated facts or null.
 *
 * Every URL contract and extractor pattern here was probed on the LIVE
 * venue on 2026-08-05 (verify-live-DOM doctrine — nothing guessed):
 *  [HL-URL]  app.hyperliquid.xyz/trade/SOL — market is the /trade/ tail.
 *            Whether a tail is a real PERP market is decided against the
 *            live perp universe (parseHlMeta), not assumed — HL spot pairs
 *            share the /trade/ namespace.
 *  [HL-TTL]  document.title observed: "73.483 | SOL | Hyperliquid" —
 *            live price | market | venue.
 *  [JUP-URL] jup.ag/perps/long/SOL-SOL, /perps/short/USDC-ETH,
 *            /perps/long/SOL-WBTC all probed live: pattern is
 *            /perps/<long|short>/<COLLATERAL>-<MARKET>, market ∈
 *            {SOL, ETH, WBTC}; bare /perps client-redirects to long/SOL-SOL.
 *  [JUP-TTL] document.title observed: "73.33 - SOL" / "1896.48 - ETH" /
 *            "64446.36 - WBTC" — live price - market.
 *  [JUP-BRW] page innerText observed (logged out): "Borrow Rate" then
 *            "0.0014% / hr" — the venue's displayed EFFECTIVE hourly rate
 *            (base × utilization per [JUP-FEES]), exactly what multiplies
 *            position size in the engine's accrual.
 *  [AX-URL]  axiom.trade/perpetuals and /perps both return RESOURCE NOT
 *            FOUND logged out; the perps route is not discoverable without
 *            auth. Axiom stays a pending stub until a logged-in recon —
 *            consistent with its venue entry shipping verified:false.
 */
(() => {
  'use strict';

  const JUP_MARKETS = new Set(['SOL', 'ETH', 'WBTC']);

  /* --------------------------- URL detection --------------------------- */

  /* The market a Hyperliquid page is showing lives in its TITLE, not its
   * URL. Verified live 2026-08-06: the app trades from a bare `/trade`
   * route ("55.063 | HYPE | Hyperliquid") and switching markets in the UI
   * does not change the path at all. An earlier version required
   * `/trade/<COIN>`, so on the real site detect() returned null and the
   * ticket could never mount — the URL form exists (it deep-links) but is
   * not what a trading session actually sits on. The title is therefore
   * authoritative and the path segment is only a fallback. */
  function hlTitleMarket(title) {
    if (typeof title !== 'string') return null;
    const m = title.match(/^[0-9][0-9,]*\.?[0-9]*\s*\|\s*([A-Za-z0-9:_-]{1,32})\s*\|\s*Hyperliquid$/);
    return m ? m[1] : null;
  }

  function detectHyperliquid(host, pathname, title) {
    if (!/(^|\.)app\.hyperliquid\.xyz$/.test(host)) return null;
    if (!/^\/trade(?:\/|$)/.test(pathname)) return null;
    const seg = pathname.match(/^\/trade\/([A-Za-z0-9:_-]{1,32})\/?$/);
    const market = hlTitleMarket(title) || (seg ? seg[1] : null);
    if (!market) return null;
    // Candidate only: the feed layer must confirm the market against the
    // live perp universe before any position can reference it.
    return { venue: 'hyperliquid', market, confirmed: false };
  }

  function detectJupiter(host, pathname) {
    if (!/(^|\.)jup\.ag$/.test(host)) return null;
    const m = pathname.match(/^\/perps\/(long|short)\/([A-Za-z]{2,10})-([A-Za-z]{2,10})\/?$/);
    if (!m) return null;
    const market = m[3].toUpperCase();
    if (!JUP_MARKETS.has(market)) return null;
    return { venue: 'jupiter', market, uiSide: m[1], collateral: m[2].toUpperCase(), confirmed: true };
  }

  /* Axiom's perps route needs logged-in recon before an adapter may exist —
   * a guessed route is exactly the wrong-presence defect class. */
  function detectAxiomPerps() { return null; }

  function detect(host, pathname, title) {
    return detectHyperliquid(host, pathname, title)
      || detectJupiter(host, pathname)
      || detectAxiomPerps(host, pathname);
  }

  /* -------------------------- title price feed --------------------------
   * Both venues carry the live price in document.title. Titles are page-
   * authored text: parse strictly, return null on anything unexpected, and
   * let the quote layer's magnitude gate do the rest. */

  function parseHlTitle(title, market) {
    if (typeof title !== 'string' || !market) return null;
    const m = title.match(/^([0-9][0-9,]*\.?[0-9]*)\s*\|\s*([A-Za-z0-9:_-]+)\s*\|\s*Hyperliquid$/);
    if (!m || m[2] !== market) return null;
    const px = Number(m[1].replace(/,/g, ''));
    return Number.isFinite(px) && px > 0 ? { px, market } : null;
  }

  function parseJupTitle(title, market) {
    if (typeof title !== 'string' || !market) return null;
    const m = title.match(/^([0-9][0-9,]*\.?[0-9]*)\s*-\s*([A-Za-z]+)$/);
    if (!m || m[2].toUpperCase() !== market) return null;
    const px = Number(m[1].replace(/,/g, ''));
    return Number.isFinite(px) && px > 0 ? { px, market } : null;
  }

  /* ----------------------- Jupiter borrow rate -----------------------
   * [JUP-BRW] "Borrow Rate" followed by "<pct>% / hr" in the page text.
   * Returns the HOURLY rate as a fraction. The magnitude gate rejects
   * anything above 0.5%/hour — venue rates run orders of magnitude below
   * that, so a breach means we parsed the wrong number, and a wrong borrow
   * rate silently corrupts every accrual after it. */

  const BORROW_RATE_MAX_FRAC = 0.005;

  function parseJupBorrowRate(pageText) {
    if (typeof pageText !== 'string') return null;
    const m = pageText.match(/Borrow\s*Rate[\s|:]*([0-9]+(?:\.[0-9]+)?)\s*%\s*\/\s*hr/i);
    if (!m) return null;
    const frac = Number(m[1]) / 100;
    if (!Number.isFinite(frac) || frac < 0 || frac > BORROW_RATE_MAX_FRAC) return null;
    return frac;
  }

  const api = {
    detect,
    hlTitleMarket,
    detectHyperliquid,
    detectJupiter,
    parseHlTitle,
    parseJupTitle,
    parseJupBorrowRate,
    BORROW_RATE_MAX_FRAC,
    JUP_MARKETS,
  };

  if (typeof window !== 'undefined') window.PaperPerpsSites = api;
  if (typeof self !== 'undefined') self.PaperPerpsSites = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
