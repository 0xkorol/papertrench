# PaperTrench Perps + The TA Guide — scoping spec

> **Status: DRAFT for maintainer alignment (2026-08-05).** Nothing here is
> committed work. This document scopes the two coupled expansions requested by
> the maintainer: a leveraged perps/futures paper book, and a minimal
> technical-analysis guide layer with AI narration. Open questions for the
> maintainer are collected in §10 — the build passes in §9 start only after
> those are answered.

---

## 1. Mission fit

Perps are the fastest tuition-burner in crypto. Spot memecoins mint losers;
leverage mints them *faster*, because every mistake is multiplied and a new
failure mode — liquidation — ends rounds before the thesis can even be wrong.
Newcomers meet 20x–50x leverage with zero reps, on venues designed to make
opening a position feel free. A flight simulator for leverage is therefore
directly mission-core: practice the exact mechanics (margin, funding drag,
liquidation distance, fee round-trips at size) with zero money at risk, and
*know* what those mechanics cost before a venue charges real tuition.

The TA guide obeys the same doctrine as X-Ray and the coach: **the core
computes and labels; the narration layer only formats.** Every number shown is
true or absent. The AI never invents a number — it narrates numbers the
deterministic core already computed, through the user's own configured
endpoint, locally, with no telemetry.

Honesty risks specific to this feature set — and this spec's answer to each:

| Risk | Answer |
|---|---|
| Funding rates we didn't observe | Read the venue's real rate; if unknown, refuse to open the position (§4) |
| Liquidation while the browser is closed | Reconstruct from venue candles with labeled provenance, or void the round — never guess (§4) |
| Indicators computed on bars we never saw | Observed-since doctrine: an indicator renders only when its full window is real data (§5) |
| TA that reads as a signal service | Every suggestion is a *read* with a stated invalidation; contract-tested framing rules (§6) |
| Synthetic perps on tokens with no real perp market | Out of scope for v1 — invented funding and liquidation depth are numbers that aren't true (§8) |

## 2. Product shape (what the user sees)

**Perps mode** lives where the current product lives: as an overlay on real
venues, trading paper against the venue's own live feed.

- **The ticket.** Long/short toggle, leverage slider (venue's real tiers),
  margin input. Before entry, a preview panel shows the four numbers that
  decide whether this trade is sane: **liquidation price**, **liquidation
  distance in ATRs** (§5), **funding cost per hour at current rate**, and
  **round-trip fees at this size**. The preview is the product: on most perps
  venues these numbers are scattered or hidden until after the click.
- **The position card.** Mark-price P&L, a liquidation proximity bar, funding
  accrued live (a running meter, not a surprise), margin controls (add margin,
  partial close). Rides the existing positions bar.
- **Liquidation is a lesson, not a game-over screen.** A liquidated round gets
  the same post-mortem treatment as "The After": what the price did next, what
  a lower leverage would have survived, stamped into the journal.

**The TA guide** is one card plus native chart drawings, on perps *and* on the
spot sites the product already supports.

- **Collapsed by default to a one-line regime strip** (trend state + one
  headline read). Expanding reveals the minimal indicator set, current levels,
  and any detected setups. Focus-mode compatible; draggable through the single
  drag system; gated by the same per-site page rules as the overlay. No
  blinking, no badges, no unsolicited pop-ups. Silence is a valid output — no
  setup means the card says nothing.
- **Levels drawn natively** (EMA, VWAP, detected S/R) through the same
  native-chart machinery as the average-price lines, where the site hook
  exists; card-only elsewhere.
- **Setups.** Deterministic detectors (§5) surface named setups — each with
  entry zone, invalidation, target, and *your own record with this setup*
  from your journal ("as you've traded it: 12 rounds, 42% win, −0.31
  expectancy"). A scanner view in the dashboard lists detected setups across
  recently-watched tokens — the honest version of "positions you didn't know
  you were looking for": detected by stated rules, not whispered by a model.
- **AI narration** (§6) turns the computed context into two short sentences:
  the read, and what kills it.

## 3. Perps engine (pure core)

New pure module `perps.js`, sibling to `engine.js`: pure functions over a
serializable state slice, no DOM, no chrome APIs, testable with `node --test`.

**Position model:** side (long/short), margin (isolated, v1), leverage,
notional, entry price, accumulated funding, fee ledger (taker/maker bps +
`gasSolPerTx`/`tipSolPerTx`, reusing the existing cost-model settings),
mark-price P&L, liquidation price derived from the venue's published
maintenance-margin schedule. Cross margin is explicitly v2 — isolated teaches
liquidation cleanly and keeps blast radius per-position.

**Math that must be property-tested** (reference vectors from venue docs,
verified during Pass B, never assumed from memory):

- Liquidation price as a function of entry, leverage, side, and maintenance
  margin — including the fee/funding drag that moves it over time.
- Funding accrual on the venue's real cadence, sign-correct both directions.
- Partial close, add-margin, and their effect on liq price.
- P&L conservation: margin out + P&L − fees − funding == margin returned,
  to EPS, across every operation sequence (property test, random walks).
- Liquidation semantics at the boundary (maintenance breach vs bankruptcy),
  matching the venue's model.

**Separate book — the F-30/Phase-7 rule applied from day one.** Perps get
their own state slice (`pt_state.perps`), own starting balance, own rounds,
own attestation chain segment, own rank track. Perps results never blend into
the spot wallet, streaks, grades, or graduation stats — a 50x lucky long must
not pollute the signal of whether the user can trade spot, and vice versa.
Two books must be indistinguishable *never*.

**Grading extends, mission-weighted.** The process grade gains perps-specific
inputs: risk-per-trade vs ATR at entry, leverage escalation after a red round
(revenge-leverage flag), liq-distance discipline, funding-aware hold length.
A liquidation with a written thesis and sane sizing grades better than a
lucky 50x win — same doctrine as today, sharper teeth.

## 4. Price & venue layer

**Venue adapters.** Perps venues are chart SPAs like the current seven sites;
the adapter registry pattern in `sites.js` extends naturally (URL → market
identity, market → URL). Recommended order (§10 Q1): **Hyperliquid first** —
it is where this audience's leverage actually lives, its public info API is
keyless (mark, oracle, funding, candles, leverage tiers), and Axiom's perps
tab is Hyperliquid under the hood, so venue #2 lands on an adapter and a fee
model we already ship.

**Feeds, two-source like spot.** A `price-bridge`-style MAIN-world hook on the
venue chart (TradingView `subscribeBars` where present) for live refinement;
the venue's public API as anchor. Same magnitude gate as `quote.js` — a stray
number on the page never becomes a fill. Mark price and last price are kept
distinct: P&L and liquidation run on **mark**, the chart shows last, and the
card labels which is which — conflating them is how real traders get surprised.

**Funding is real or the trade doesn't open.** The funding rate shown and
accrued is the venue's own, read live. If the rate is unavailable, the ticket
refuses to open a position and says why — a perp without funding is not a
conservative simplification, it is a fake instrument that teaches free
leverage. (Display degrades honestly: an open position whose rate feed dies
shows "funding stale since <t>" and stops accruing rather than guessing.)

**Liquidation must not need the tab open.** Leverage's most important lesson
happens at 3 AM. On wake (background worker alarm, and on any page load), the
reconciler fetches venue candles covering the gap since the last observed
tick. If the liquidation price was crossed, the position is liquidated at the
crossing bar, stamped `reconstructed-from-venue-candles` — provenance visible
on the round, X-Ray-style. If candle history for the gap cannot be fetched,
the round is marked **unverifiable and voided from stats** — voiding is the
only honest fallback; resurrecting a should-have-been-liquidated position
teaches that leverage forgives absence. Background polling budget rides the
existing rpc-pool discipline (hard cap on watched markets).

## 5. TA core (pure) + bar store

**Bar store** (`bar-store.js`, storage-backed ring buffer per market ×
resolution). Fed by the hooks we already have — `subscribeBars` bars on
Padre/fomo, GMGN mcap-candles, venue API candles for perps — plus explicit
backfill from public candle APIs where they exist. Every bar carries
provenance: `live-observed` or `backfilled:<source>`. Capped (ring), quota-
safe, IndexedDB if volume demands it (recordings precedent).

**Observed-since, applied to math.** An indicator with a 21-bar window renders
only when 21 real bars exist for that market and resolution. Until then the
card shows "warming up: 14/21 bars observed" — never a padded or partial
value. Backfilled bars satisfy the window and say so.

**Indicator set — deliberately small, each earning its place:**

| Indicator | Why it's in the minimal set |
|---|---|
| EMA 9/21 | Trend regime + the pullback setup's anchor |
| VWAP (session) | The fair-price line every perps desk actually watches |
| RSI-14 | Divergence input only — never shown as an oracle number |
| **ATR-14** | The load-bearer: converts leverage into survivability (below) |
| Swing structure (HH/HL/LH/LL) | Regime classification + S/R level clustering |
| Volume regime | Confirms/denies breakout-class setups |

Everything is a pure function in `ta-core.js`, tested against published
reference vectors (a NaN-in-window or off-by-one-bar bug is an S1 lie).
No indicator soup: adding an indicator requires a setup that consumes it.

**The ATR × leverage bridge is the flagship honest number.** The ticket and
the TA card both express liquidation distance in ATRs: *"Your liquidation is
1.3 ATR(14) away on the 5m — this market moves that much in a typical hour."*
This one sentence is the entire argument against blind 50x, computed, not
preached.

**Setup detectors — deterministic, named, falsifiable.** v1 set: trend
pullback to EMA, range break + retest, VWAP reversion, RSI divergence at a
level. Each detector is a pure function returning `{setup, direction,
entryZone, invalidation, targets, inputs}` — stated rules, reproducible from
the bar store, locked with fixture tests. No composite "confidence score" we
cannot ground; the grounding shown is the user's own per-setup record from
their journal, computed by the mastery layer.

## 6. AI suggestion layer

Rides the existing coach plumbing: the user's own OpenAI-compatible endpoint,
proxied by the background worker, off by default, zero telemetry. No hosted
AI, ever.

**The context pack is the contract.** The prompt is assembled from computed
state only: indicator values, detected setups, open position + liq/funding
numbers, per-setup journal stats, current costs. The model's job is
*narration and prioritization of detector output* — which read matters most
right now, in two sentences, and what invalidates it. The model may not
introduce a number, a level, or a setup the core didn't emit; the card renders
the deterministic basis (setup name + rules link) alongside the prose, so a
hallucinated claim has nowhere to hide.

**Framing rules, contract-tested like X-Ray's labels:**

- Every suggestion carries its invalidation in the same breath. A read
  without a "wrong if" is not rendered.
- No prediction language without the user's own measured record for that
  setup attached.
- Paper-only framing baked into the card chrome ("practice read — not
  financial advice"), not left to the model's discretion.
- Silence is the default: no setup detected → no AI call, no card content.
  The guide never manufactures a reason to trade — the entire failure mode
  of this genre is filler signals, and filler is banned at the test level.

## 7. UI & theme

One visual language: `content.css` design tokens, the single drag + persist +
viewport-clamp system, per-site page gating with URL-fixture tests, focus-mode
compatible, "never blank before rebuilding" render discipline. The TA card
collapsed state is a one-line strip; the perps ticket reuses the overlay trade
tab's structure with the long/short/leverage row added. Nothing new floats
that doesn't remember its place.

## 8. Scope fences (what this is NOT)

- **No synthetic perps in v1.** Leveraging trench coins that have no real
  perp market means inventing funding and liquidation depth — numbers that
  aren't true. If a clearly-labeled "synthetic leverage drill" mode is ever
  worth it, it is its own alignment conversation (§10 Q5).
- **No signal service.** No notifications that say "long now," no push
  alerts on setup detection by default, no autotrading, no strategy
  backtesting presented as prediction.
- **No new network posture.** Keyless public APIs + the user's own endpoints,
  same as today. Nothing phones home.
- **No blending of books.** Perps stats never touch spot graduation, rank,
  streaks, or the attestation chain's spot segments.

## 9. Delivery plan — big autonomous passes

Recommended order: **C → A → B → D → E** — TA lands first because it delivers
value to every existing spot user immediately and de-risks the bar
store/backfill layer that perps liquidation reconciliation depends on. (§10
Q2 if perps-first is preferred.)

- **Pass C — TA core.** `bar-store.js` + provenance, `ta-core.js` indicators
  against reference vectors, setup detectors with fixtures, TA card +
  native levels on current spot sites. Exit: card live on all supported
  sites, suite green, zero fabricated values under fixture starvation tests.
- **Pass A — Perps engine.** `perps.js` pure core, property tests, separate
  book storage + attestation segment, settings. Exit: engine math locked
  against venue reference vectors; no UI yet.
- **Pass B — Venue #1.** Hyperliquid adapter + feed hook + API anchor,
  overlay ticket with the four-number preview, position card, offline
  liquidation reconciler. Exit: full paper perp round-trip on the live
  venue, reconciliation fixtures green, QA-matrix rows added.
- **Pass D — AI narration + scanner.** Context-pack assembly, framing
  contract tests, dashboard scanner, per-setup journal stats. Exit: with AI
  unconfigured everything still works (deterministic reads only).
- **Pass E — Mastery integration.** Perps grading inputs, liq post-mortems,
  "Leverage License" rank track, graduation doctrine extension
  (GRADUATION.md gains a perps bar), docs + QA matrix + release.

Every pass: audit slice → implementation → regression tests that failed
before the fix/feature → full green suite → changelog. No drip-feeding.

## 10. Open questions for the maintainer

1. **Venue order.** Recommend Hyperliquid → Axiom Perps (same backend,
   existing adapter) → then evaluate Jupiter Perps/Drift. Agree?
2. **Landing order.** Recommend TA-first (C→A→B→D→E, rationale in §9).
   Perps-first is viable if the TA card should debut *with* perps instead.
3. **Separate perps book + separate rank track** ("Leverage License") —
   confirm the doctrine call.
4. **Leverage ceiling.** Recommend mirroring the venue's real tiers exactly
   (honesty: practice the instrument that exists), with guardrails (existing
   opt-in system) nudging sane risk-per-trade — not a hard training cap.
5. **Synthetic leverage drills** on non-perp trench coins: defer indefinitely,
   or keep on the long list?
6. **Starting balance / margin currency** for the perps book: venue-native
   (USDC on Hyperliquid) vs SOL like the spot book. Recommend venue-native —
   the fee and funding math then matches what the venue's own UI shows.

## Verify-during-build (never from memory)

Venue liquidation/maintenance-margin formulas, funding cadence and sign
conventions, API rate limits and candle history depth, per-asset leverage
tiers, fee schedules (taker/maker, builder fees on Axiom-routed flow). Each
gets a dated citation in the code comment at the point of use and a locked
reference-vector test.
