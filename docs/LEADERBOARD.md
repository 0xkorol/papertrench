# Leaderboard protocol

Paper-trading results are trivially forgeable: every number lives on the user's
own machine. A leaderboard that trusts a self-reported P&L is worthless. This
document describes what PaperTrench produces instead, and what a server must do
with it.

## What the client produces

Every fill is committed to a hash chain **at the moment it happens**, before its
outcome is known. Each link commits to the hash of the previous one.

```js
preimage = [
  "v1", previousHash, id, sessionId, mint, side,
  qty.toFixed(12), priceNative.toExponential(12),
  solGross.toFixed(12), String(timestamp)
].join("|")

hash = sha256(preimage)
```

The preimage format is part of the contract: a verifier must be able to
reproduce it byte-for-byte from the public record alone.

## What that proves

| Property | Why it holds |
|---|---|
| **Ordering** | Each fill commits to its predecessor's hash, so inserting, deleting, or reordering a trade breaks every link that follows. |
| **Pre-commitment** | A fill is hashed when made. Backdating a winning entry invalidates the chain, and timestamps must move forward. |
| **Price claims** | Each fill records mint, side, quantity, price, and timestamp — enough for a verifier to re-fetch historical price data and reject fills at prices that never existed. |

## What it does NOT prove

**A determined user can run modified code and forge a locally consistent chain.**
There is no client-side fix for this, and pretending otherwise would be
dishonest. The chain proves *ordering and internal consistency*; it does not
prove the client was unmodified.

Therefore:

1. **Standings must be recomputed server-side** from the submitted chain, using
   `replayChain()`. Never rank on the `claim` field.
2. **Every fill's price must be re-verified** against independent historical
   data for that mint at that timestamp. This is the step that actually stops
   fabrication.
3. **Identity must cost something.** Binding a record to a verified X account
   makes sybil attacks expensive in a way that a local install is not.

## Submission payload

```json
{
  "version": 1,
  "submittedAt": 1754000000000,
  "identity": { "handle": "someone", "verified": true },
  "claim": {
    "equitySol": 12.4, "realizedPnlSol": 2.4,
    "rounds": 9, "wins": 6, "losses": 3,
    "startingBalanceSol": 10
  },
  "chain": [ /* every link */ ],
  "head": "<sha256 of the last link>",
  "trustModel": "client-generated evidence; server must re-verify every fill price"
}
```

`claim` is included only so a server can compare it against its own
recomputation. A mismatch is itself a signal.

## Suggested server checks

1. `verifyChain(chain)` — reject on any broken link, hash mismatch, or
   out-of-order timestamp.
2. `replayChain(chain, startingBalanceSol)` — compute the real result.
3. Re-price every fill against independent historical data; reject fills whose
   price is impossible for that mint at that second.
4. Enforce one ranked record per verified identity.
5. Rate-limit submissions and store the head hash, so a later submission must
   extend the chain it already committed to rather than replacing it.

## Current status

The client half is implemented and shipping. **No leaderboard server exists
yet**, so the extension shows only your own verified record and no global
standings are invented. Chains are committed locally in the meantime, so records
are already verifiable the moment ranking goes live — nothing has to be
reconstructed retroactively.
