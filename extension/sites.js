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
      // axiom.trade/meme/<pairAddress> and axiom.trade/t/<mint>. No bare
      // path-tail fallback: Axiom's wallet-tracker and profile routes also
      // end in base58 addresses, and treating those as tokens pinned the
      // panel open on non-trading pages forever (DEFECTS O-10/O-11). The /t/
      // route carries a MINT and used to be mislabeled as a pair (O-13).
      detect: () => {
        const meme = location.pathname.match(/^\/meme\/($|[A-Za-z0-9]+)/);
        const memeAddr = meme && meme[1] && firstBase58(meme[1]);
        if (memeAddr) return { kind: 'pair', address: memeAddr };
        const t = location.pathname.match(/^\/t\/($|[A-Za-z0-9]+)/);
        const mintAddr = t && t[1] && firstBase58(t[1]);
        if (mintAddr) return { kind: 'mint', address: mintAddr };
        return null;
      },
      // Pulse / Discover rows carry anchors to /meme/<pair> plus small
      // pump.fun icon links; the row's own instant-buy button is the anchor
      // point for the chip (inserted just left of it).
      rowBuy: {
        listPaths: /^\/(pulse|discover)?\/?$/,
        linkSelectors: ['a[href^="/meme/"]', 'a[href*="pump.fun/coin/"]', 'a[href*="solscan.io/token/"]'],
        placement: 'before-buy-button',
        // The instant-buy pill reads "0 SOL" / "0.5 ETH" (older UI: "Buy x SOL").
        buyButtonPattern: '^(Buy\\s|[\\d.,]+[KMB]?\\s*(SOL|ETH|BNB|USD)$)',
        containerMode: 'group',
        kind: 'pair',
      },
    },
    {
      id: 'padre',
      name: 'Padre / Terminal',
      tokenUrl: (mint) => 'https://trade.padre.gg/trade/solana/' + mint,
      match: (h) => /(^|\.)padre\.gg$/.test(h),
      // trade.padre.gg/trade/solana/<mint> (and legacy terminal routes).
      // Only /trade/ and /terminal/ routes are token pages — Padre's wallet,
      // portfolio and leaderboard routes also end in base58 addresses and
      // must never mount the panel (DEFECTS O-10/O-11).
      detect: () => {
        const m = location.pathname.match(/^\/(?:trade|terminal)\/(?:[a-z0-9-]+\/)*([1-9A-HJ-NP-Za-km-z]{32,44})(?:$|[/?#])/);
        return m ? { kind: 'mint', address: m[1] } : null;
      },
      // Trenches cards link (absolute) to the token's trade page and also
      // carry pump.fun icon links.
      rowBuy: {
        listPaths: /^\/(trenches|terminal|feed)?\/?$/,
        linkSelectors: ['a[href*="/trade/solana/"]', 'a[href*="pump.fun/coin/"]', 'a[href*="solscan.io/token/"]'],
        // Every Trenches card has Padre's own SOL quick-buy pill at the
        // bottom — the chip sits immediately left of it, covering nothing.
        placement: 'before-buy-button',
        buyButtonPattern: '\\bSOL\\b',
        containerMode: 'heuristic',
        kind: 'mint',
      },
    },
    {
      id: 'photon',
      name: 'Photon',
      tokenUrl: (mint, pairAddress) => (pairAddress
        ? 'https://photon-sol.tinyastro.io/en/lp/' + pairAddress
        : 'https://photon-sol.tinyastro.io/en/r/' + mint),
      match: (h) => /(^|\.)tinyastro\.io$/.test(h),
      // photon-sol.tinyastro.io/en/lp/<pairAddress> and /en/r/<mint> — the
      // second is Photon's own mint-route shape, which tokenUrl() emits when
      // no pair is known; not detecting it meant the extension could navigate
      // a user to a page it then refused to recognize (DEFECT O-12).
      detect: () => {
        const lp = location.pathname.match(/\/lp\/($|[A-Za-z0-9]+)/);
        const lpAddr = lp && lp[1] && firstBase58(lp[1]);
        if (lpAddr) return { kind: 'pair', address: lpAddr };
        const r = location.pathname.match(/\/r\/($|[A-Za-z0-9]+)/);
        const rAddr = r && r[1] && firstBase58(r[1]);
        if (rAddr) return { kind: 'mint', address: rAddr };
        return null;
      },
    },
    {
      id: 'gmgn',
      name: 'GMGN',
      tokenUrl: (mint) => 'https://gmgn.ai/sol/token/' + mint,
      match: (h) => /(^|\.)gmgn\.ai$/.test(h),
      // gmgn.ai/sol/token/<mint>. Solana chain only — GMGN's EVM routes
      // (/eth/token/0x…) can contain hex runs that pass base58 and were
      // handed to the Solana resolver (DEFECT O-11); and wallet-analysis
      // routes (/sol/address/<wallet>) must never mount the panel (O-10).
      detect: () => {
        const chain = location.pathname.match(/^\/([a-z]+)\//);
        if (chain && chain[1] !== 'sol') return null;
        const m = location.pathname.match(/\/token\/($|[A-Za-z0-9]+)/);
        const addr = m && m[1] && firstBase58(m[1]);
        return addr ? { kind: 'mint', address: addr } : null;
      },
      // Trenches is GMGN's home feed; cards navigate by JS but carry
      // pump.fun/coin/<mint> icon links (and some /sol/token/ anchors).
      rowBuy: {
        listPaths: /^\/(trenches)?\/?$/,
        linkSelectors: ['a[href*="/sol/token/"]', 'a[href*="pump.fun/coin/"]', 'a[href*="solscan.io/token/"]'],
        placement: 'badge',
        containerMode: 'heuristic',
        kind: 'mint',
      },
    },
    {
      id: 'bullx',
      name: 'BullX NEO',
      tokenUrl: (mint, pairAddress) => 'https://neo.bullx.io/terminal?chainId=1399811149&address=' + (pairAddress || mint),
      match: (h) => /(^|\.)bullx\.io$/.test(h),
      // bullx.io/terminal?chainId=...&address=<pair>. The address param must
      // be a WHOLE base58 value: an EVM 0x address can contain a 32+ char
      // base58 run inside it (~13% of addresses) and used to be sent to the
      // Solana resolver as a pair (DEFECT O-11). Solana's chainId is
      // 1399811149; any other explicit chainId is not ours.
      detect: () => {
        const chainId = queryParam('chainId');
        if (chainId && chainId !== '1399811149') return null;
        const param = queryParam('address') || '';
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(param)) return null;
        return { kind: 'pair', address: param };
      },
    },
    {
      id: 'dexscreener',
      name: 'Dexscreener',
      tokenUrl: (mint, pairAddress) => 'https://dexscreener.com/solana/' + (pairAddress || mint),
      match: (h) => /(^|\.)dexscreener\.com$/.test(h),
      // dexscreener.com/solana/<pair> — the /solana/ prefix is the gate.
      // EVM chain routes (/ethereum/0x…) can contain hex runs that pass
      // base58 and used to reach the Solana resolver (DEFECT O-11);
      // watchlist/gainers/portfolio routes must never mount (O-10).
      detect: () => {
        const m = location.pathname.match(/^\/solana\/($|[A-Za-z0-9]+)/);
        const addr = m && m[1] && firstBase58(m[1]);
        return addr ? { kind: 'pair', address: addr } : null;
      },
    },
    {
      id: 'birdeye',
      name: 'Birdeye',
      tokenUrl: (mint) => 'https://birdeye.so/token/' + mint + '?chain=solana',
      match: (h) => /(^|\.)birdeye\.so$/.test(h),
      // birdeye.so/token/<mint>?chain=solana. Token routes only — profile
      // routes end in wallet addresses (DEFECT O-10) — and an explicit
      // non-Solana ?chain= is not ours.
      detect: () => {
        const chain = queryParam('chain');
        if (chain && chain.toLowerCase() !== 'solana') return null;
        const m = location.pathname.match(/\/token\/($|[A-Za-z0-9]+)/);
        const addr = m && m[1] && firstBase58(m[1]);
        return addr ? { kind: 'mint', address: addr } : null;
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
        const pathBase58 = /^\/(?:swap|tokens|limit|dca)\//.test(location.pathname)
          ? firstBase58(location.pathname)
          : null; // portfolio/<wallet> and other routes are not token pages (O-10)
        const candidates = [
          firstBase58(queryParam('outputMint') || ''),
          firstBase58(queryParam('inputMint') || ''),
          firstBase58(queryParam('buy') || ''),
          firstBase58(queryParam('sell') || ''),
          pathBase58,
        ].filter(Boolean);
        const tok = candidates.find((addr) => !QUOTE_MINTS.has(addr)) || null;
        return tok ? { kind: 'mint', address: tok } : null;
      },
    },
    {
      id: 'fomo',
      name: 'Fomo',
      tokenUrl: (mint) => 'https://fomo.family/tokens/solana/' + mint,
      match: (h) => /(^|\.)fomo\.family$/.test(h),
      // fomo.family/tokens/<chainSlug>/<tokenAddress>. The route shape and
      // the live URL corpus are in docs/MULTICHAIN.md (harvested from the
      // real site 2026-08-05: solana=base58, robinhood/bnb/ethereum=0x40hex).
      // MULTICHAIN (maintainer order): every corpus slug mounts the panel,
      // with per-chain address validation — the O-11 rule survives as
      // shape-strictness per slug: a solana slug never accepts an EVM run,
      // an EVM slug never accepts base58. Profile and user routes
      // (/u/<handle>, /profile/<handle>) and ticker-slug /prices/ pages
      // carry handles and tickers, not mints, and never mount (O-10).
      detect: () => {
        const m = location.pathname.match(/^\/tokens\/([a-z-]+)\/([A-Za-z0-9]+)(?:$|[/?#])/);
        if (!m) return null;
        const chain = m[1];
        const addr = m[2];
        if (chain === 'solana') {
          if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)) return null;
          return { kind: 'mint', address: addr, chain: 'solana' };
        }
        const EVM_SLUGS = ['base', 'monad', 'bnb', 'ethereum', 'hyperliquid', 'robinhood'];
        if (EVM_SLUGS.indexOf(chain) < 0) return null;
        if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return null;
        return { kind: 'mint', address: addr, chain };
      },
    },
    {
      id: 'pumpfun',
      name: 'Pump.fun',
      tokenUrl: (mint) => 'https://pump.fun/coin/' + mint,
      match: (h) => /(^|\.)pump\.fun$/.test(h),
      // pump.fun/coin/<mint>, plus the legacy bare /<mint> route. Pump.fun
      // was in the product description from day one but had NO adapter — it
      // fell to the generic fallback (DEFECT F-24).
      detect: () => {
        const m = location.pathname.match(/^\/coin\/($|[A-Za-z0-9]+)/);
        const addr = m && m[1] && firstBase58(m[1]);
        if (addr) return { kind: 'mint', address: addr };
        const parts = location.pathname.split('/').filter(Boolean);
        if (parts.length === 1 && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(parts[0])) {
          return { kind: 'mint', address: parts[0] };
        }
        return null;
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

  const api = { ADAPTERS, currentSite, firstBase58, BASE58_RE, tokenUrlFor };
  if (typeof window !== 'undefined') window.PaperTrenchSites = api;
  if (typeof self !== 'undefined') self.PaperTrenchSites = api;
})();
