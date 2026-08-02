# PaperTrench on-chain price engine — verified specification

Every number in this document was verified against Solana mainnet, not assumed.
Re-run `extension/test/onchain.test.js` and the live probes before changing any offset.

## Why this exists

PaperTrench originally priced fills from aggregator APIs (Dexscreener/Jupiter) and
from scraped site values. Both sit *downstream* of chain state:

| Source | Observed latency | Notes |
|--------|------------------|-------|
| `finalized` commitment | ~15–30 s | never appropriate for trading UI |
| `confirmed` commitment | **~2–3 s** | what most aggregators publish from |
| Aggregator HTTP APIs | `confirmed` + poll interval + CDN | the reported "2–3 seconds behind" |
| **`processed` commitment** | **~400 ms** | what fast terminals use |

Measured divergence between live bonding-curve state and the aggregator price on
active pump.fun low-caps was **4.2 %, 12.8 % and 13.2 %** in a single sample.
That is not a rendering bug; it is a data-source bug, and it is why a "buy the dip"
click could register a pre-dip price.

**Rule:** the price used for a fill, the market cap shown, the chart marker and the
average line must all originate from one on-chain observation with a slot number.

## Transport

`accountSubscribe` over the RPC WebSocket, `commitment: "processed"`,
`encoding: "base64"`. Verified live: subscription id returned, then
`accountNotification` frames carrying `context.slot` and the account payload.

```jsonc
{"jsonrpc":"2.0","id":1,"method":"accountSubscribe",
 "params":["<POOL_ACCOUNT>",{"encoding":"base64","commitment":"processed"}]}
```

Every observation carries `context.slot`. A quote with a **lower slot than the one
already held must be discarded** — RPC frames can arrive out of order, and accepting
an older slot is precisely how a stale price sneaks into a fill.

Public `api.mainnet-beta.solana.com` throttles subscriptions and will drop the
connection; it is acceptable for development only. Production requires a dedicated
endpoint (Helius/Triton/QuickNode). LaserStream advertises ~200 ms better than
standard Agave WebSockets.

## Pool dispatch — by owner program

The correct decoder is chosen by the pool account's **owner**, never guessed.
Reading vault balances is correct for constant-product pools and **catastrophically
wrong for concentrated liquidity** — measured 54 % error on an Orca whirlpool,
because only in-range liquidity backs the current price.

| Owner program | Kind | Decoder |
|---------------|------|---------|
| `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc` | Orca Whirlpool (CL) | `sqrtPrice` |
| `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK` | Raydium CLMM | `sqrtPrice` |
| `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8` | Raydium AMM v4 | vault reserves |
| `CPMMoo8L3F4NbTegBCKVNunggL7H1Zpdmwpwh8KMoZ0F` | Raydium CPMM | vault reserves |
| `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` | PumpSwap | vault reserves |
| `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` | pump.fun bonding curve | virtual reserves |

Unknown owner → **no on-chain quote**. Fall back to the aggregator and label the
quote as such. Never guess a layout.

### Orca Whirlpool — verified offsets

Account length 653, owner `whirLbMiic…`. Offsets confirmed empirically by matching
the derived price to the live market on `5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9`:

| Offset | Field |
|--------|-------|
| 65 | `sqrtPrice` — u128 LE |
| 101 | `tokenMintA` — pubkey |
| 181 | `tokenMintB` — pubkey |

```
ratioBperA = (sqrtPrice / 2^64)^2
price(A in B) = ratioBperA * 10^(decA - decB)
price(B in A) = (1 / ratioBperA) * 10^(decB - decA)
```

Verified: derived `0.00000003967463` vs live market `0.00000003969` → **0.06 %**.

### Constant-product pools — vault reserves

Read both pool vaults as SPL token accounts and divide UI amounts.

SPL token account, 165 bytes, owner `Tokenkeg…` or `Tokenz…`:

| Offset | Length | Field |
|--------|--------|-------|
| 0 | 32 | `mint` |
| 32 | 32 | `owner` |
| **64** | **8** | **`amount` — u64 LE** |

Mint account: `decimals` is a `u8` at **offset 44**.

```
price = (quoteAmount / 10^quoteDecimals) / (baseAmount / 10^baseDecimals)
```

Verified on Raydium AMM v4 (WIF/SOL): `0.00191396704979` vs `0.001909` → **0.26 %**.

### pump.fun bonding curve — verified

PDA: `["bonding-curve", mint]` under `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`.
Account length 151. All fields u64 LE after the 8-byte Anchor discriminator:

| Offset | Field |
|--------|-------|
| 8 | `virtual_token_reserves` |
| 16 | `virtual_sol_reserves` |
| 24 | `real_token_reserves` |
| 32 | `real_sol_reserves` |
| 40 | `token_total_supply` |
| 48 | `complete` (u8) |

```
price = (virtual_sol_reserves / 1e9) / (virtual_token_reserves / 10^tokenDecimals)
```

**Use virtual reserves, not real reserves.** The curve is Uniswap-V2-shaped over
synthetic reserves; pricing from real reserves is wrong. pump.fun tokens use
6 decimals. When `complete == 1` the curve has migrated to PumpSwap and the
PumpSwap pool must be priced instead.

## Market cap

Market cap is derived from the same observation as the price, so the panel, the
fill, the marker and the line can never disagree:

```
marketCap = priceUsd * (mintSupply / 10^mintDecimals)
```

`supply` is a u64 LE at offset 36 of the mint account; `decimals` is at offset 44.
Supply is cached and refreshed infrequently — it changes rarely, price changes
constantly.

## Quote object

One canonical shape. Every consumer reads this and nothing else:

```js
{
  mint, priceNative, priceUsd, marketCap,
  slot,                    // monotonic guard
  source: 'onchain' | 'page-feed' | 'aggregator',
  poolKind, poolAddress,
  observedAt               // local receipt time
}
```

## Number formatting

No raw scientific notation reaches the user. Sub-cent prices use subscript-zero
notation, the convention every Solana terminal already uses:

| Value | Rendered |
|-------|----------|
| `0.00000003969` | `$0.0₇3969` |
| `1234567` (mcap) | `$1.23M` |
| `0.00234` | `$0.00234` |
