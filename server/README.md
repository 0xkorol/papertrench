# PaperTrench leaderboard server

The server half of [docs/LEADERBOARD.md](../docs/LEADERBOARD.md): it receives
the hash chains the extension commits locally, and turns them into public
standings **without ever trusting a self-reported number**.

## Trust pipeline

Every submission runs the same gauntlet:

1. **Shape gate** — malformed or absurd payloads bounce before any crypto.
2. **`verifyChain`** — every link re-hashed with the exact bytes the
   extension commits (the server imports `extension/attest.js` itself, so
   the contract cannot fork).
3. **Extend-only anchor** — a new submission must contain the previously
   committed head at the same position. Replacing a bad history with a
   fresh lucky one is rejected as `chain-replaced`.
4. **Replay** — standings come from `replayChain` over the raw fills. The
   claimed stats are only compared against the replay; a mismatch is
   recorded as a signal.
5. **Re-pricing** — every fill is checked against the token's real traded
   range (USD candles × the SOL/USD range for that same minute) via
   GeckoTerminal, drained by cron under a lookup budget. Any impossible
   price rejects the record; missing candle data is reported as coverage,
   never faked as a pass.

Ranking is process-weighted (`ROI × ln(1+rounds) × discipline`) with a
five-round floor — one lottery ticket does not top the board. The weekly
Trench Sprint is a window slice of the same chain: rounds opened and closed
inside a UTC Monday-to-Monday week, scored by ROI on window-start equity.

## Layout

```
core/     pure logic — no fetch, no storage, runs under `node --test`
  chain.js       re-exports extension/attest.js (single source of truth)
  pricing.js     candle plausibility policy (three-state: ok/implausible/no-data)
  ranking.js     rounds-from-chain, discipline metrics, season score
  sprint.js      ISO-week windows and sprint entries
  submission.js  the pipeline above, as pure orchestration
worker/   Cloudflare adapters — routing, D1, X OAuth (PKCE), sessions,
          edge caching, rate limits, candle cache, pricing cron
test/     behavior locks, one cheat per test
schema.sql, wrangler.toml
```

## Running

```
node --test          # the whole core, no network, no Cloudflare
wrangler dev         # local worker against a local D1
```

Deployment (one-time setup, DNS, X OAuth app, secrets): see
[DEPLOY.md](DEPLOY.md).
