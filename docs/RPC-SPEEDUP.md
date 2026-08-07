# Make new coins resolve instantly — the 2-minute price-connection fix

PaperTrench ships with a **keyless public pool** of Solana RPC endpoints:
no signup, no key, and it works out of the box for most people. But public
endpoints throttle **by region** — from some places (first confirmed report:
the Balkans) every public endpoint answers slowly, and brand-new coins feel
like they take forever to get their first quote.

The fix is a free personal endpoint. Two minutes, no card, and PaperTrench
prefers it automatically the moment it's pasted in.

> Credit where due: this recipe is exactly what community member
> **cojica456** figured out on their own. Nobody should have to — so
> PaperTrench now measures its own connection and points you here when the
> public pool is slow from your machine.

## The recipe (Helius, free tier)

1. Go to [helius.dev](https://www.helius.dev/) and create a free account
   (the free tier is far more than paper trading ever uses).
2. In the Helius dashboard, copy your **RPC URL** — it looks like
   `https://mainnet.helius-rpc.com/?api-key=xxxxxxxx-...`.
3. In PaperTrench: **Dashboard → Settings → Price connection**, paste the
   URL, save.

Done. New launches now read straight from your own endpoint, which also
carries your own private rate limit instead of sharing a public one.

Any other Solana RPC provider's free tier works the same way (QuickNode,
Triton, Shyft, …) — paste whatever HTTPS URL they give you.

## What this does and doesn't change

- **Used for:** reading prices, pool state, and holder concentration — the
  same public chain data the built-in pool reads.
- **Never used for:** anything else. There are no transactions to sign and
  no funds anywhere in PaperTrench — it's paper. The URL is stored on your
  machine only and is never synced or sent to us (there is no "us" to send
  it to — the extension has no server).
- **Leave it blank** if speed feels fine: the public pool hedges across
  endpoints and is plenty fast in most regions.
