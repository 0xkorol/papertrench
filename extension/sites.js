/* PaperTrench — site adapters.
 *
 * Each adapter knows how to figure out WHICH token the user is currently
 * looking at on a given trading site. Almost all of these are SPAs that put
 * either a token mint or an LP/pair address in the URL, so adapters parse the
 * URL first and fall back to scanning for a Solana base58 address as a last
 * resort. The price layer resolves both mints and pair addresses through the
 * free Dexscreener API.
 */
(() => {
  'use strict';

  const BASE58_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
  const WSOL_MINT = 'So11111111111111111111111111111111111111112';
  const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
  const QUOTE_MINTS = new Set([WSOL_MINT, USDC_MINT, USDT_MINT]);

  function firstBase58(text) {
    if (!text) return null;
    BASE58_RE.lastIndex = 0;
    const m = BASE58_RE.exec(text);
    return m ? m[0] : null;
  }

  function queryParam(name) {
    try {
      return new URLSearchParams(location.search).get(name);
    } catch (e) {
      return null;
    }
  }

  // pathTail: returns last non-empty path segment that matches base58
  function pathTail() {
    const parts = location.pathname.split('/').filter(Boolean);
    for (let i = parts.length - 1; i >= 0; i--) {
      const cand = firstBase58(parts[i]);
      if (cand) return cand;
    }
    return null;
  }

  const ADAPTERS = [
    {
      id: 'axiom',
      name: 'Axiom',
      // Axiom routes by pair address; fall back to its token search by mint.
      tokenUrl: (mint, pairAddress) => (pairAddress
        ? 'https://axiom.trade/meme/' + pairAddress
        : 'https://axiom.trade/t/' + mint),
      match: (h) => /(^|\.)axiom\.trade$/.test(h),
      // axiom.trade/meme/<pairAddress>
      detect: () => {
        const m = location.pathname.match(/\/meme\/($|[A-Za-z0-9]+)/);
        const addr = m && m[1] && firstBase58(m[1]);
        if (addr) return { kind: 'pair', address: addr };
        const tail = pathTail();
        return tail ? { kind: 'pair', address: tail } : null;
      },
    },
    {
      id: 'padre',
      name: 'Padre / Terminal',
      tokenUrl: (mint) => 'https://trade.padre.gg/trade/solana/' + mint,
      match: (h) => /(^|\.)padre\.gg$/.test(h),
      // trade.padre.gg/trade/<mint> (and legacy terminal routes)
      detect: () => {
        const tail = pathTail();
        return tail ? { kind: 'mint', address: tail } : null;
      },
    },
    {
      id: 'photon',
      name: 'Photon',
      tokenUrl: (mint, pairAddress) => (pairAddress
        ? 'https://photon-sol.tinyastro.io/en/lp/' + pairAddress
        : 'https://photon-sol.tinyastro.io/en/r/' + mint),
      match: (h) => /(^|\.)tinyastro\.io$/.test(h),
      // photon-sol.tinyastro.io/en/lp/<pairAddress>
      detect: () => {
        const m = location.pathname.match(/\/lp\/($|[A-Za-z0-9]+)/);
        const addr = m && m[1] && firstBase58(m[1]);
        if (addr) return { kind: 'pair', address: addr };
        return null;
      },
    },
    {
      id: 'gmgn',
      name: 'GMGN',
      tokenUrl: (mint) => 'https://gmgn.ai/sol/token/' + mint,
      match: (h) => /(^|\.)gmgn\.ai$/.test(h),
      // gmgn.ai/sol/token/<mint>
      detect: () => {
        const m = location.pathname.match(/\/token\/($|[A-Za-z0-9]+)/);
        const addr = m && m[1] && firstBase58(m[1]);
        if (addr) return { kind: 'mint', address: addr };
        const tail = pathTail();
        return tail ? { kind: 'mint', address: tail } : null;
      },
    },
    {
      id: 'bullx',
      name: 'BullX NEO',
      tokenUrl: (mint, pairAddress) => 'https://neo.bullx.io/terminal?chainId=1399811149&address=' + (pairAddress || mint),
      match: (h) => /(^|\.)bullx\.io$/.test(h),
      // bullx.io/terminal?chainId=...&address=<pair>
      detect: () => {
        const addrQ = firstBase58(queryParam('address') || '');
        if (addrQ) return { kind: 'pair', address: addrQ };
        const tail = pathTail();
        return tail ? { kind: 'pair', address: tail } : null;
      },
    },
    {
      id: 'dexscreener',
      name: 'Dexscreener',
      tokenUrl: (mint, pairAddress) => 'https://dexscreener.com/solana/' + (pairAddress || mint),
      match: (h) => /(^|\.)dexscreener\.com$/.test(h),
      // dexscreener.com/solana/<pair>
      detect: () => {
        const tail = pathTail();
        return tail ? { kind: 'pair', address: tail } : null;
      },
    },
    {
      id: 'birdeye',
      name: 'Birdeye',
      tokenUrl: (mint) => 'https://birdeye.so/token/' + mint + '?chain=solana',
      match: (h) => /(^|\.)birdeye\.so$/.test(h),
      // birdeye.so/token/<mint>?chain=solana
      detect: () => {
        const m = location.pathname.match(/\/token\/($|[A-Za-z0-9]+)/);
        const addr = m && m[1] && firstBase58(m[1]);
        if (addr) return { kind: 'mint', address: addr };
        const tail = pathTail();
        return tail ? { kind: 'mint', address: tail } : null;
      },
    },
    {
      id: 'jupiter',
      name: 'Jupiter',
      tokenUrl: (mint) => 'https://jup.ag/swap?inputMint=' + WSOL_MINT + '&outputMint=' + mint,
      match: (h) => /(^|\.)jup\.ag$/.test(h),
      // jup.ag/swap/SOL-<mint>, jup.ag/tokens/<mint>, or the newer
      // ?inputMint=...&outputMint=... form. After redirects the page may rewrite
      // itself to ?buy=...&sell=... (usually SOL/USDC), so prefer the original
      // output/input token and ignore stable/quote addresses.
      detect: () => {
        const candidates = [
          firstBase58(queryParam('outputMint') || ''),
          firstBase58(queryParam('inputMint') || ''),
          firstBase58(queryParam('buy') || ''),
          firstBase58(queryParam('sell') || ''),
          firstBase58(location.pathname),
        ].filter(Boolean);
        const tok = candidates.find((addr) => !QUOTE_MINTS.has(addr)) || null;
        return tok ? { kind: 'mint', address: tok } : null;
      },
    },
  ];

  function currentSite() {
    const h = location.hostname.replace(/^www\./, '');
    for (const a of ADAPTERS) {
      try {
        if (a.match(h)) return a;
      } catch (e) { /* ignore */ }
    }
    // Generic fallback: any page; treat last base58 in URL as a candidate mint.
    return {
      id: 'generic',
      name: h || 'Unknown site',
      match: () => true,
      detect: () => {
        const tail = firstBase58(location.href);
        // Avoid matching random hashes in fragments that aren't tokens; caller
        // verifies candidates against Dexscreener before accepting.
        return tail ? { kind: 'mint', address: tail } : null;
      },
      // Unknown host: Dexscreener always resolves a Solana mint.
      tokenUrl: (mint, pairAddress) => 'https://dexscreener.com/solana/' + (pairAddress || mint),
    };
  }

  /**
   * Where a positions-bar chip should navigate for a given token.
   *
   * Preference order: the site the position was opened on, then the site the
   * user is currently on, then Dexscreener. Keeping the position's own site
   * first means a chip opened on Photon returns to Photon, which is where its
   * chart and the user's muscle memory already are.
   */
  function tokenUrlFor(mint, opts) {
    if (!mint) return null;
    const options = opts || {};
    const wanted = options.siteId;
    const pairAddress = options.pairAddress || null;

    let adapter = null;
    if (wanted) adapter = ADAPTERS.find((a) => a.id === wanted) || null;
    if (!adapter && options.fallbackSite && typeof options.fallbackSite.tokenUrl === 'function') {
      adapter = options.fallbackSite;
    }

    if (adapter && typeof adapter.tokenUrl === 'function') {
      try {
        const url = adapter.tokenUrl(mint, pairAddress);
        if (url) return url;
      } catch (e) { /* fall through to the universal link */ }
    }
    return 'https://dexscreener.com/solana/' + (pairAddress || mint);
  }

  window.PaperTrenchSites = { ADAPTERS, currentSite, firstBase58, BASE58_RE, tokenUrlFor };
})();
