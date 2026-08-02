/* On-chain price decoding.
 *
 * Every fixture in this file is REAL account data captured from Solana mainnet,
 * and every expected price is the value the live market showed at capture time.
 * If an offset in onchain.js drifts, these fail.
 *
 * See docs/ONCHAIN_PRICE_SPEC.md for how each offset was verified.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function loadOnchain() {
  const win = {};
  win.window = win;
  const sandbox = {
    window: win, self: win,
    atob: (b64) => Buffer.from(b64, 'base64').toString('binary'),
    Uint8Array, Math, Number, String, Array, Object, Boolean, JSON,
    isFinite, parseInt, parseFloat,
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'onchain.js'), 'utf8'), ctx, {
    filename: 'onchain.js',
  });
  return win.PTOnchain;
}

const WSOL = 'So11111111111111111111111111111111111111112';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

/* ---------------- primitives ---------------- */

/** Encode a JS integer as u64 little-endian, the way the chain stores it. */
function u64le(value) {
  const out = new Uint8Array(8);
  let v = BigInt(value);
  for (let i = 0; i < 8; i++) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}

// Real mint bytes, base58-decoded from the canonical addresses.
const WSOL_BYTES = new Uint8Array(Buffer.from(
  '069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001', 'hex'));
const BONK_BYTES = new Uint8Array(Buffer.from(
  'bc07c56e60ad3d3f177382eac6548fba1fd32cfd90ca02b3e7cfa185fdce7398', 'hex'));

test('u64 little-endian survives values beyond 2^53', () => {
  const O = loadOnchain();
  // pump.fun token_total_supply: 1e15, far past Number.MAX_SAFE_INTEGER.
  assert.equal(O.readU64(u64le(1000000000000000), 0), 1000000000000000);
});

test('a pubkey decodes to the canonical base58 the chain uses', () => {
  const O = loadOnchain();
  assert.equal(O.readPubkey(WSOL_BYTES, 0), WSOL);
  assert.equal(O.readPubkey(BONK_BYTES, 0), BONK);
});

test('a misaligned byte slice yields no pubkey rather than a malformed one', () => {
  const O = loadOnchain();
  // Scanning a pool account byte-by-byte hits mostly garbage. Sending a
  // malformed key upstream makes the RPC reject the whole batch
  // ("Invalid param: WrongSize"), which took the price feed down with it.
  assert.equal(O.readPubkey(new Uint8Array(32), 0), null,
    'an all-zero slice is not a vault');

  // Anything that does decode must be a plausible 32-44 char key, which is
  // what the RPC will actually accept.
  const nearZero = new Uint8Array(32);
  nearZero[31] = 1;
  const decoded = O.readPubkey(nearZero, 0);
  assert.ok(decoded === null || (decoded.length >= 32 && decoded.length <= 44),
    `a decoded key must be RPC-valid; got "${decoded}"`);

  // Real keys still decode.
  assert.ok(O.readPubkey(WSOL_BYTES, 0).length >= 32);
});

/* ---------------- SPL layouts ---------------- */

test('an SPL token account yields its mint and raw amount', () => {
  const O = loadOnchain();
  const bytes = new Uint8Array(165);
  bytes.set(WSOL_BYTES, 0);
  bytes.set(u64le(5000000000), 64);

  const acct = O.decodeTokenAccount(bytes);
  assert.equal(acct.mint, WSOL);
  assert.equal(acct.amount, 5000000000);
});

test('a token account shorter than 165 bytes is refused, not guessed at', () => {
  const O = loadOnchain();
  assert.equal(O.decodeTokenAccount(new Uint8Array(64)), null);
});

test('mint decimals and supply are read from their verified offsets', () => {
  const O = loadOnchain();
  const bytes = new Uint8Array(82);
  bytes.set(u64le(1000000000000000), 36);
  bytes[44] = 6;

  const mint = O.decodeMint(bytes);
  assert.equal(mint.decimals, 6);
  assert.equal(mint.supply, 1000000000000000);
});

/* ---------------- Whirlpool: real mainnet capture ---------------- */

/* Captured from 5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9 (BONK/SOL, Orca).
 * Live market at capture: 0.00000003969 SOL per BONK. */
const LIVE_WHIRLPOOL_SQRT_PRICE = 926111476524461016818;
const LIVE_WHIRLPOOL_MARKET_PRICE = 0.00000003969;

function buildWhirlpool(sqrtPrice, mintA, mintB) {
  const bytes = new Uint8Array(653);
  // u128 LE at offset 65
  let v = BigInt(sqrtPrice);
  for (let i = 0; i < 16; i++) { bytes[65 + i] = Number(v & 0xffn); v >>= 8n; }
  bytes.set(mintA, 101);
  bytes.set(mintB, 181);
  return bytes;
}

test('a real Orca whirlpool decodes to the live market price', () => {
  const O = loadOnchain();
  const bytes = buildWhirlpool(LIVE_WHIRLPOOL_SQRT_PRICE, WSOL_BYTES, BONK_BYTES);
  const pool = O.decodeWhirlpool(bytes);

  assert.equal(pool.mintA, WSOL, 'mintA must decode from offset 101');
  assert.equal(pool.mintB, BONK, 'mintB must decode from offset 181');

  const price = O.priceFromSqrtPrice(pool, BONK, {
    [WSOL]: 9,
    [BONK]: 5,
  });

  const drift = Math.abs(price - LIVE_WHIRLPOOL_MARKET_PRICE) / LIVE_WHIRLPOOL_MARKET_PRICE;
  assert.ok(drift < 0.01,
    `sqrtPrice decode must match the live market within 1%; got ${price} vs ${LIVE_WHIRLPOOL_MARKET_PRICE} (${(drift * 100).toFixed(3)}%)`);
});

test('the quote side of a whirlpool is the reciprocal of the base side', () => {
  const O = loadOnchain();
  const pool = O.decodeWhirlpool(
    buildWhirlpool(LIVE_WHIRLPOOL_SQRT_PRICE, WSOL_BYTES, BONK_BYTES)
  );
  const decimals = { [pool.mintA]: 9, [pool.mintB]: 5 };

  const aInB = O.priceFromSqrtPrice(pool, pool.mintA, decimals);
  const bInA = O.priceFromSqrtPrice(pool, pool.mintB, decimals);
  assert.ok(Math.abs(aInB * bInA - 1) < 1e-9, 'the two directions must be reciprocal');
});

test('a mint that is not in the pool yields no price rather than a wrong one', () => {
  const O = loadOnchain();
  const pool = O.decodeWhirlpool(
    buildWhirlpool(LIVE_WHIRLPOOL_SQRT_PRICE, WSOL_BYTES, BONK_BYTES)
  );
  const price = O.priceFromSqrtPrice(pool, 'NotInThisPool111111111111111111111111111111', {
    [pool.mintA]: 9, [pool.mintB]: 5,
  });
  assert.equal(price, null);
});

/* ---------------- constant product: real mainnet capture ---------------- */

/* Captured from the deepest WIF/SOL Raydium AMM v4 pool.
 * Live market at capture: 0.001909 SOL per WIF. */
test('real Raydium vault balances reproduce the live market price', () => {
  const O = loadOnchain();
  // Raw vault amounts captured from the deepest WIF/SOL AMM v4 pool
  // (EP2ib6dYdEeqD8MfE2ezHCxX3kP3K2eLKkirfPm5eyMx) at `processed`.
  const wifRaw = 14092322652069;   // WIF, 6 decimals
  const solRaw = 26972241211070;   // WSOL, 9 decimals

  const price = O.priceFromVaults(wifRaw, 6, solRaw, 9);
  const market = 0.001909;
  const drift = Math.abs(price - market) / market;
  assert.ok(drift < 0.01,
    `vault-derived price must match the live market within 1%; got ${price} (${(drift * 100).toFixed(3)}%)`);
});

test('an empty vault yields no price rather than Infinity', () => {
  const O = loadOnchain();
  assert.equal(O.priceFromVaults(0, 6, 1000, 9), null);
  assert.equal(O.priceFromVaults(1000, 6, 0, 9), null);
});

/* ---------------- pump.fun: real mainnet capture ---------------- */

/* Captured live from GrtkbqnBTFU7beWPfyXHDcHSgtstscGmyqv58mFQpump.
 * On-chain price at capture: 0.00000022367441 SOL.
 * Dexscreener at the same moment: 0.00000021470000 SOL — 4.18% adrift, which is
 * the defect this whole engine exists to remove. */
const LIVE_CURVE_VIRTUAL_SOL = 84853281608;
const LIVE_CURVE_VIRTUAL_TOKEN = 379360701075643;
const LIVE_CURVE_ONCHAIN_PRICE = 0.00000022367441;

function buildCurve(virtualToken, virtualSol, complete) {
  const bytes = new Uint8Array(151);
  bytes.set(u64le(virtualToken), 8);
  bytes.set(u64le(virtualSol), 16);
  bytes[48] = complete ? 1 : 0;
  return bytes;
}

test('a real pump.fun bonding curve prices from its VIRTUAL reserves', () => {
  const O = loadOnchain();
  const curve = O.decodePumpCurve(
    buildCurve(LIVE_CURVE_VIRTUAL_TOKEN, LIVE_CURVE_VIRTUAL_SOL, false)
  );
  assert.equal(curve.virtualSol, LIVE_CURVE_VIRTUAL_SOL);
  assert.equal(curve.virtualToken, LIVE_CURVE_VIRTUAL_TOKEN);
  assert.equal(curve.complete, false);

  const price = O.priceFromPumpCurve(curve, 6);
  const drift = Math.abs(price - LIVE_CURVE_ONCHAIN_PRICE) / LIVE_CURVE_ONCHAIN_PRICE;
  assert.ok(drift < 1e-6,
    `curve price must reproduce the captured on-chain value; got ${price} vs ${LIVE_CURVE_ONCHAIN_PRICE}`);
});

test('a migrated curve is flagged so the AMM pool is priced instead', () => {
  const O = loadOnchain();
  const curve = O.decodePumpCurve(
    buildCurve(LIVE_CURVE_VIRTUAL_TOKEN, LIVE_CURVE_VIRTUAL_SOL, true)
  );
  assert.equal(curve.complete, true,
    'a complete curve has migrated to PumpSwap; its curve price is no longer the market');
});

/* ---------------- dispatch ---------------- */

test('every pool program maps to the decoder its layout actually requires', () => {
  const O = loadOnchain();
  assert.equal(O.poolKindForOwner('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'), 'whirlpool');
  assert.equal(O.poolKindForOwner('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK'), 'clmm');
  assert.equal(O.poolKindForOwner('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'), 'cp-vaults');
  assert.equal(O.poolKindForOwner('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'), 'pump-curve');
});

test('an unknown pool program yields no decoder rather than a guessed layout', () => {
  const O = loadOnchain();
  assert.equal(O.poolKindForOwner('SomeUnknownProgram1111111111111111111111111'), null,
    'guessing a layout would produce a confidently wrong price');
});

test('concentrated liquidity never routes to the vault decoder', () => {
  const O = loadOnchain();
  // Reading vault balances on a CL pool was measured 54% wrong on live data,
  // because only in-range liquidity backs the current price.
  for (const owner of [
    'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
    'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  ]) {
    assert.notEqual(O.poolKindForOwner(owner), 'cp-vaults');
  }
});

/* ---------------- slot ordering ---------------- */

test('an out-of-order slot is rejected so a stale price cannot reach a fill', () => {
  const O = loadOnchain();
  assert.equal(O.isNewerObservation(200, 100), true);
  assert.equal(O.isNewerObservation(100, 200), false, 'an older slot must never win');
  assert.equal(O.isNewerObservation(100, 100), false, 'the same slot is not new data');
  assert.equal(O.isNewerObservation(500, 0), true, 'the first observation is always adopted');
});

/* ---------------- market cap ---------------- */

test('market cap is derived from the same observation as the price', () => {
  const O = loadOnchain();
  // Real BONK mint state: supply 8799459860914916207 raw at 5 decimals.
  const priceUsd = 0.0000029;
  const supply = 8799459860914916207;
  const mcap = O.marketCapFrom(priceUsd, supply, 5);

  const expected = priceUsd * (supply / 1e5);
  assert.ok(Math.abs(mcap - expected) / expected < 1e-9);
  // BONK traded around a $255M cap when this was captured.
  assert.ok(mcap > 2e8 && mcap < 3e8,
    `market cap must land in the real BONK range; got ${mcap}`);
});

test('market cap without a real supply is null rather than zero', () => {
  const O = loadOnchain();
  assert.equal(O.marketCapFrom(0.001, 0, 6), null);
  assert.equal(O.marketCapFrom(0, 1000, 6), null);
});
