/* PaperTrench — on-chain price engine.
 *
 * Prices come from Solana account state, not from an aggregator. Aggregators
 * publish from `confirmed` commitment (~2-3s) plus their own poll interval; on
 * fast-moving low caps that was measured 4-13% away from live chain state. That
 * gap is what made a "buy the dip" click register a pre-dip price.
 *
 * Every decoder offset in this file was verified against mainnet. See
 * docs/ONCHAIN_PRICE_SPEC.md. Do not adjust an offset without re-verifying.
 *
 * Two hard rules:
 *   1. Dispatch by the pool account's OWNER program. Never guess a layout, and
 *      never read vault balances for a concentrated-liquidity pool (measured
 *      54% error, because only in-range liquidity backs the price).
 *   2. Every quote carries its slot. A quote from an older slot than the one
 *      already held is discarded — out-of-order frames are exactly how a stale
 *      price slips into a fill.
 */
(() => {
  'use strict';

  const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
  const WSOL_MINT = 'So11111111111111111111111111111111111111112';

  /** Pool owner program -> decoder kind. Anything absent has no on-chain path. */
  const POOL_KINDS = {
    whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: 'whirlpool',
    CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: 'clmm',
    '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'cp-vaults',
    CPMMoo8L3F4NbTegBCKVNunggL7H1Zpdmwpwh8KMoZ0F: 'cp-vaults',
    pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: 'cp-vaults',
    '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'pump-curve',
  };

  // Verified offsets — see spec.
  const WHIRLPOOL_SQRT_PRICE = 65;   // u128 LE
  const WHIRLPOOL_MINT_A = 101;
  const WHIRLPOOL_MINT_B = 181;
  const SPL_AMOUNT = 64;             // u64 LE, 165-byte token account
  const SPL_MINT = 0;
  const MINT_SUPPLY = 36;            // u64 LE
  const MINT_DECIMALS = 44;          // u8
  const CURVE_VIRTUAL_TOKEN = 8;     // u64 LE, after Anchor discriminator
  const CURVE_VIRTUAL_SOL = 16;
  const CURVE_COMPLETE = 48;
  const PUMP_TOKEN_DECIMALS = 6;

  const TWO_POW_64 = Math.pow(2, 64);

  /* ---------------- binary readers ---------------- */

  function bytesFromBase64(b64) {
    if (typeof b64 !== 'string') return null;
    try {
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch (_) {
      return null;
    }
  }

  /**
   * u64 little-endian as a JS number.
   *
   * Raw token amounts can exceed 2^53, so this is assembled from two 32-bit
   * halves rather than via BigInt (kept dependency-free and fast). Precision
   * beyond 2^53 is irrelevant here: the value is immediately divided by
   * 10^decimals to produce a UI amount, and a price only needs ~15 significant
   * digits.
   */
  function readU64(bytes, offset) {
    if (!bytes || offset + 8 > bytes.length) return null;
    let lo = 0;
    let hi = 0;
    for (let i = 3; i >= 0; i--) lo = lo * 256 + bytes[offset + i];
    for (let i = 7; i >= 4; i--) hi = hi * 256 + bytes[offset + i];
    return hi * 4294967296 + lo;
  }

  /** u128 little-endian as a JS number (used only for sqrtPrice). */
  function readU128(bytes, offset) {
    if (!bytes || offset + 16 > bytes.length) return null;
    let value = 0;
    for (let i = 15; i >= 0; i--) value = value * 256 + bytes[offset + i];
    return value;
  }

  const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

  /**
   * Base58-encode a 32-byte pubkey slice.
   *
   * Scanning a pool account byte-by-byte produces mostly garbage slices. An
   * all-zero slice is the system program and never a vault, and RPC rejects a
   * malformed key outright ("Invalid param: WrongSize"), so those are filtered
   * here rather than being sent upstream.
   */
  function readPubkey(bytes, offset) {
    if (!bytes || offset + 32 > bytes.length) return null;
    let allZero = true;
    for (let i = 0; i < 32; i++) {
      if (bytes[offset + i] !== 0) { allZero = false; break; }
    }
    if (allZero) return null;
    const digits = [0];
    for (let i = 0; i < 32; i++) {
      let carry = bytes[offset + i];
      for (let j = 0; j < digits.length; j++) {
        carry += digits[j] << 8;
        digits[j] = carry % 58;
        carry = (carry / 58) | 0;
      }
      while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
    }
    let out = '';
    for (let i = 0; i < 32 && bytes[offset + i] === 0; i++) out += '1';
    for (let i = digits.length - 1; i >= 0; i--) out += B58_ALPHABET[digits[i]];
    // A real 32-byte key is 32-44 base58 characters. Anything else is a
    // misaligned slice, not an account.
    return out.length >= 32 && out.length <= 44 ? out : null;
  }

  /* ---------------- account decoders ---------------- */

  /** Mint account -> { decimals, supply }. */
  function decodeMint(bytes) {
    if (!bytes || bytes.length < 45) return null;
    return {
      decimals: bytes[MINT_DECIMALS],
      supply: readU64(bytes, MINT_SUPPLY),
    };
  }

  /** SPL token account -> { mint, amount }. Both token programs share this base. */
  function decodeTokenAccount(bytes) {
    if (!bytes || bytes.length < 165) return null;
    return {
      mint: readPubkey(bytes, SPL_MINT),
      amount: readU64(bytes, SPL_AMOUNT),
    };
  }

  /**
   * Orca Whirlpool / Raydium CLMM.
   *
   * price(B per A) = (sqrtPrice / 2^64)^2, then scaled by the decimal delta.
   * Verified live: 0.00000003967463 vs market 0.00000003969 (0.06%).
   */
  function decodeWhirlpool(bytes) {
    if (!bytes || bytes.length < WHIRLPOOL_MINT_B + 32) return null;
    const sqrtPrice = readU128(bytes, WHIRLPOOL_SQRT_PRICE);
    if (!(sqrtPrice > 0)) return null;
    return {
      sqrtPrice,
      mintA: readPubkey(bytes, WHIRLPOOL_MINT_A),
      mintB: readPubkey(bytes, WHIRLPOOL_MINT_B),
    };
  }

  function priceFromSqrtPrice(pool, targetMint, decimalsByMint) {
    if (!pool) return null;
    const decA = decimalsByMint[pool.mintA];
    const decB = decimalsByMint[pool.mintB];
    if (decA == null || decB == null) return null;

    const ratio = Math.pow(pool.sqrtPrice / TWO_POW_64, 2); // B per A, raw units
    if (!(ratio > 0) || !isFinite(ratio)) return null;

    if (targetMint === pool.mintA) return ratio * Math.pow(10, decA - decB);
    if (targetMint === pool.mintB) return (1 / ratio) * Math.pow(10, decB - decA);
    return null;
  }

  /**
   * pump.fun bonding curve.
   *
   * The curve is Uniswap-V2-shaped over SYNTHETIC reserves, so the price comes
   * from virtual_sol / virtual_token. Using the real reserves is a common and
   * incorrect shortcut. Verified against three live curves.
   */
  function decodePumpCurve(bytes) {
    if (!bytes || bytes.length < 49) return null;
    const virtualToken = readU64(bytes, CURVE_VIRTUAL_TOKEN);
    const virtualSol = readU64(bytes, CURVE_VIRTUAL_SOL);
    if (!(virtualToken > 0) || !(virtualSol > 0)) return null;
    return {
      virtualToken,
      virtualSol,
      complete: bytes[CURVE_COMPLETE] === 1,
    };
  }

  function priceFromPumpCurve(curve, tokenDecimals) {
    if (!curve) return null;
    const decimals = tokenDecimals == null ? PUMP_TOKEN_DECIMALS : tokenDecimals;
    const sol = curve.virtualSol / 1e9;
    const tokens = curve.virtualToken / Math.pow(10, decimals);
    if (!(tokens > 0)) return null;
    return sol / tokens;
  }

  /** Constant-product pools: price straight from the two vault balances. */
  function priceFromVaults(baseAmount, baseDecimals, quoteAmount, quoteDecimals) {
    if (!(baseAmount > 0) || !(quoteAmount > 0)) return null;
    if (baseDecimals == null || quoteDecimals == null) return null;
    const base = baseAmount / Math.pow(10, baseDecimals);
    const quote = quoteAmount / Math.pow(10, quoteDecimals);
    if (!(base > 0)) return null;
    return quote / base;
  }

  /** Market cap from the same observation that produced the price. */
  function marketCapFrom(priceUsd, supply, decimals) {
    if (!(priceUsd > 0) || !(supply > 0) || decimals == null) return null;
    return priceUsd * (supply / Math.pow(10, decimals));
  }

  function poolKindForOwner(owner) {
    return POOL_KINDS[owner] || null;
  }

  /**
   * Slot guard. RPC frames can arrive out of order; adopting an older slot is
   * exactly how a stale price reaches a fill.
   */
  function isNewerObservation(nextSlot, heldSlot) {
    if (!(nextSlot > 0)) return false;
    if (!(heldSlot > 0)) return true;
    return nextSlot > heldSlot;
  }

  const api = {
    TOKEN_PROGRAM, TOKEN_2022_PROGRAM, WSOL_MINT, POOL_KINDS,
    bytesFromBase64, readU64, readU128, readPubkey,
    decodeMint, decodeTokenAccount, decodeWhirlpool, decodePumpCurve,
    priceFromSqrtPrice, priceFromPumpCurve, priceFromVaults,
    marketCapFrom, poolKindForOwner, isNewerObservation,
  };

  // The decoder runs in BOTH worlds: the content script (window) and the
  // service worker (self). Assigning only to window left PTOnchain undefined
  // in the worker, which silently disabled the entire on-chain feed.
  if (typeof window !== 'undefined') window.PTOnchain = api;
  if (typeof self !== 'undefined') self.PTOnchain = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
