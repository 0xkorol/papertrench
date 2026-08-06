# Multichain paper trading — the verified contract (v1 target: fomo)

Maintainer order (2026-08-05): make it multichain. Everything below was
pulled from LIVE surfaces on 2026-08-05 — no assumption ships unverified.

## Verified on the live site (in-app browser session)

1. **URL corpus** (harvested from fomo's trending lists, 70 links):
   - `/tokens/solana/<base58 32-44>` — 30 samples
   - `/tokens/robinhood/<0x + 40 hex>` — 22 samples
   - `/tokens/bnb/<0x + 40 hex>` — 17 samples
   - `/tokens/ethereum/<0x + 40 hex>` — 1 sample
   - (adapter route manifest also lists base / monad / hyperliquid slugs)
2. **Title pattern is chain-agnostic**: "108.6M MC | CASHCAT | fomo" on a
   robinhood token — same MC-first no-$ shape title-feed already parses.
3. **Chart pipeline is chain-agnostic**: the same blob-iframe TradingView +
   options-bag datafeed (F-38) serves every chain — bars, marks, lines all
   ride the site's own feed regardless of chain.
4. **Dexscreener anchors exist for EVERY chain probed**, with live prices,
   against fomo's own trending tokens:
   - robinhood token 0xe934…bf50 → 30 pairs, chainId `robinhood`, px live
   - bnb token 0xfe18…7777 → 11 pairs, chainId `bsc`, px live
   - ethereum token 0x3270…4ca → 7 pairs, chainId `ethereum`, px live
   Chain-slug → Dexscreener chainId map: solana→solana, bnb→bsc,
   ethereum→ethereum, robinhood→robinhood, base→base, monad→monad,
   hyperliquid→hyperliquid (last three unprobed — verify on first sighting).

## Status: LANDED (2026-08-05, one commit, 979 tests green)

All six steps below are implemented and locked. The trust boundary became
chain-aware, never looser (per-chain shape validation at every message
handler). Cross-terminal warm links still build /tokens/solana/ URLs —
correct today because the other terminals are Solana-only, revisit if that
changes.

## The build (one focused pass, in order)

1. **sites.js**: fomo detect() accepts all corpus slugs; returns
   { kind: 'mint', address, chain } with per-chain address validation
   (base58 for solana, strict 0x40-hex for EVM slugs). O-11 stays: no
   cross-shape acceptance.
2. **resolver.js**: chain-aware — Dexscreener token lookup filtered to the
   mapped chainId; Jupiter and the on-chain feed are SOLANA-ONLY paths and
   must be skipped (not failed) for other chains.
3. **engine**: fills on non-SOL chains record priceUsd from the feed and
   derive priceNative = priceUsd / solUsd AT FILL TIME (rate recorded on
   the fill) so the SOL-denominated book, fees, and P&L stay coherent.
   Fills carry `chain`; the attestation link stores it as an
   uncommitted-but-replayed field (the solNet pattern — preimage untouched).
4. **quote.js**: validation bands anchor on Dexscreener for the token's
   chain; the pump-family supply bootstrap stays Solana-only.
5. **content.js**: Solana-only features degrade EXPLICITLY per chain — rug
   guard, on-chain CHAIN⚡ feed, prewatch, Jupiter arming: hidden, with the
   panel honest about its price source. Everything else (panel, fills,
   bubbles, lines, grades, games) runs chain-agnostic.
6. **Tests**: corpus-driven detect() locks (every harvested shape), a
   resolver chain-routing lock (bsc token never queries Jupiter), an engine
   derived-rate fill lock, and a fomo liveShape EVM end-to-end.

## Honesty constraints

- A non-Solana fill's SOL figures are conversions at a RECORDED rate —
  the fill stores both, and the UI never pretends a SOL-native price
  existed. No on-chain verification off Solana in v1: the panel's feed
  label must say which sources price that chain.
