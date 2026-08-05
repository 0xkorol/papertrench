# PaperTrench — patch notes

Stream-style log of what shipped, newest first. User-facing wording; the gory
details live in the commit messages.

## v2.9.0 — 2026-08-05

Lev round two — the quick fixes now live where he meant them.

- **A pencil on the trading panel.** The ✎ in the panel header opens a
  compact inline editor right on the trading tab — buy presets, sell
  percents, and fee/gas/tip/slippage — with the same validation rulebook
  the dashboard and popup use. Your costs ride as Fee/Gas/Tip/Slip chips
  under the buy row, click-to-edit, in both modes.
- **Focus mode is genuinely Axiom-compact now.** No balance card (cash
  rides inline on the Buy label, refreshed per fill), and while one-tap
  presets are on the big BUY button gets out of the way — the preset chips
  ARE the buttons, and Enter in the amount box buys. Instant-buy off keeps
  the button.

## v2.8.1 — 2026-08-05

Update from v2.8.0 — it matters this time.

- **v2.8.0 shipped with attestation-chain recording broken.** The release
  accidentally carried half of an in-flight migration: fills asked for the
  new segmented chain store, which was not aboard, so every paper fill made
  on v2.8.0 failed to append to your local attestation chain (the honest
  "could not be added to the verification chain" toast fired each time —
  the failure was visible, the chain simply could not record).
  Your wallet, balances and P&L were never affected — the chain is the
  tamper-evidence layer used by leaderboard verification. On v2.8.1 the
  chain records again; fills made during the v2.8.0 window are simply
  absent from the chain, and the verify panel will honestly show that gap
  rather than pretend it is not there.
- **The attestation chain grew up (F-14).** It moved out of the wallet
  state into a single-writer segmented store: a fill now rewrites one small
  tail segment instead of the whole history, multi-tab chain races are
  gone, and no hash is ever truncated. Backups are downgrade-safe — a new
  backup restores intact on a pre-segmentation build. Resets clear the
  chain atomically with the wallet, and the leaderboard verifier format is
  unchanged.
- **For the record: v2.8.0 also contained the Turbo receipts card** (the
  Settings card counting warm vs cold opens, median routing latency, and
  per-site main-thread stalls — measured locally, never sent anywhere).
  Its release notes did not mention it; the feature description now lives
  in both entries, where it belongs.

## v2.8.0 — 2026-08-05

Two from the maintainer's own trench session, same screenshot.

- **Fresh launches are snipeable — "ARMED … ON FIRST QUOTE" actually fires
  now (F-34).** A 39-second-old pump.fun coin used to strand the armed buy
  forever: no aggregator had indexed it, and with the chart in MCap mode
  every close was refused as "no implied supply". Two fixes, layered:
  - **The bonding curve is read directly.** The moment a pending coin looks
    like pump.fun — the pair address on an Axiom page, or a mint ending in
    "pump" anywhere — PaperTrench finds its bonding curve on chain (derived
    from the mint via the program-address rules, verified against five live
    mainnet curves), identifies the real mint from the curve's reserve
    account, and streams the curve as a live CHAIN ⚡ feed with an immediate
    first quote. The armed buy fires seconds after launch, and the fill is
    chain state, not a guess.
  - **MCap-mode charts can price pump coins.** Pump supply is a protocol
    constant (1e9), so an mcap-scale close IS a price. All four readings of
    an unlabelled chart value (price vs cap, USD vs SOL) are judged against
    sane bands and the tick is used only when exactly one fits — ambiguity
    still refuses, per the F-25 discipline.
- **Rug guard (on by default).** Requested with a LOL, built with a straight
  face: when chain state says the float is in a handful of wallets, a paper
  BUY is refused with a toast that names the number — "🚩 RUG WARNING — top
  10 wallets hold 47% of supply". The check reads the 20 largest token
  accounts plus the mint supply, excludes the pool/curve reserve (and SAYS
  when it had to assume which account that was), flags the panel footer the
  moment the verdict lands, and never blocks a SELL — exiting a rug is the
  right move. A failed chain read blocks nothing: a guard that cannot see
  is not allowed to invent. Threshold and off-switch live in Settings →
  Guardrails; this is the one guardrail that ships ON, because the
  maintainer asked for exactly that.

## v2.7.1 — 2026-08-05

Housekeeping with a straight face: v2.7.0 was tagged and published
mid-batch, before the last five commits landed. If you downloaded 2.7.0,
update — it is missing the Instant terminal links, the dashboard
refresh fix ("stopped re-reading everything every 4 seconds"), and an
X-Ray dock fix, all described in the v2.7.0 notes below. v2.7.1 is the
complete batch; nothing else changed.

## v2.7.0 — 2026-08-05

Community feedback batch #2 (thanks again lev) — all four items, with the
video evidence doing the heavy lifting.

- **Fills land on the chart you are looking at — the "instant +14%" is dead.**
  On migrated (AMM) tokens, the on-chain price feed could silently lose one
  side of every trade it watched: both pool vaults change in the same slot,
  and the stale-frame guard threw the second one away as "old". One vault
  tracked the market, the other froze, and paper fills executed up to ~13%
  away from the live chart — booking instant fake profit that taught exactly
  the wrong lesson (F-33). The guard is now per-vault, with a regression test
  driving a real same-slot vault pair. And belt-and-braces: at fill time the
  chain price is reconciled against the price on your screen from the moment
  you clicked — if they ever disagree by more than any real sub-second move,
  the fill takes the on-screen price and logs the divergence. A paper fill
  can no longer be double digits away from the chart you clicked, no matter
  what breaks upstream.
- **Close the hot X tab, it comes back.** Accidentally closing the Instant X
  links viewer no longer degrades the feature until you rediscover the
  toggle: while the toggle is on and a trading tab is open, a fresh hidden
  viewer takes its place immediately. Turning the feature off remains the
  one way to not have a viewer (and a closing browser window never respawns
  anything).
- **Your own X tab IS the warm tab now.** With no registered viewer, a
  clicked X link — post, profile, or a token's community — used to open a
  separate tab right next to the x.com tab you already kept. Now PaperTrench
  adopts your existing X tab as the viewer and routes into it, community
  links included. It will never claim a tab you are looking at, a pinned
  tab, or one playing audio — and adopted tabs are yours: toggling the
  feature off never closes them.
- **Quick settings in the popup.** The knobs you actually re-tune
  mid-session — starting balance, quick-buy presets (SOL), quick-sell
  presets (%), and a fees profile (Axiom/Padre bot · aggressive sniper · no
  costs) — are now editable straight from the extension popup. Validation is
  the dashboard's, verbatim: a bad value keeps your saved value and says so;
  fee profile numbers are pinned by a test to match the dashboard's card.
  The full Fees & costs form stays on the dashboard.
- **Flex without leaving the terminal.** The Flex button on the closed P&L
  card now opens the share composer as a floating window centered over the
  page — no more bouncing to a dashboard tab. It is the SAME composer:
  identical card, backgrounds, customize toggles, Copy and Download, and the
  same shared background gallery (uploads made in the overlay appear in the
  dashboard composer and vice versa). Esc or a backdrop click closes it. The
  card math now lives in one shared derivation (pnlcard.js) used by both
  composers, so a card can never show different numbers depending on where
  you opened it. The PAPER watermark rides along, as always.
- **Instant pump.fun & Solscan links (opt-in).** The Instant X viewer idea,
  generalized: with the new toggle on, pump.fun and Solscan links from your
  terminal open into up to two muted background viewer tabs — already warm
  when you get there, with hover prefetch. Ctrl/click bypasses the viewer
  and opens a normal tab. Off by default; the toggle says what it costs.
- **PaperTrench off costs the page nothing.** The feed-demand gate: when no
  consumer exists for price frames (overlay disabled, wrong page, chips
  off), the bridge drops them before the body copy and the JSON parse —
  zero parsing donated to the host site.
- **Chips stopped fighting the page for layout.** Chip positioning now runs
  in read/write phases with diffed style writes, so screener chips no
  longer thrash layout at volume peaks.
- **Instant terminal links (opt-in).** Axiom, Padre and GMGN token links
  clicked on another terminal open in that terminal's kept-warm viewer, and
  a positions-bar hop to another terminal no longer replaces the tab you
  are on. Terminal viewers appear on first use (pump.fun and Solscan still
  pre-warm) — the cost stays up to two muted background tabs.
- **Turbo receipts.** The popup counts your warm vs cold opens and shows
  the median routing time — measured on your machine, stored locally,
  never sent anywhere.
- **The positions bar respects late headers.** It now measures the site
  header until it settles, so slow-painting headers no longer end up
  underneath it.
- **The dashboard stopped re-reading everything every 4 seconds.** It now
  refreshes the instant your data changes, naps while hidden, and leaves
  the recordings database alone unless a new replay landed.

## v2.6.0 — 2026-08-05

Requested by the maintainer: the X page you land on should already tell you
who you are looking at.

- **X-Ray (opt-in).** Open any X profile — or any post, where the card reads
  the author — and the intel is already on screen. No button, no "analyze",
  no waiting: PaperTrench remembers what it has seen about an account, so the
  card paints from local storage in the same frame the page routes, then
  fills in live as X's own data lands.
  - **Bio changes.** How many times the bio changed, when it last changed,
    and what it said before.
  - **Name and @handle changes.** Counted separately, because a display-name
    swap and a rename are different tells. Case-only differences are not
    renames — a fake counter is worse than no counter.
  - **Contract addresses posted.** Every CA the account has posted, dated by
    the post itself, newest first, click to copy. A CA sitting in the bio
    right now gets its own flag. Long posts are read past the 280-character
    fold, which is exactly where the address usually is.
  - **Smart Following.** The biggest accounts following this one, ranked by
    follower count, with the ones you personally follow marked as such.
- **Where the data comes from, exactly.** X-Ray reads the X app's own
  responses for a fixed allowlist of operations (profile, that account's
  posts, follower lists) as your browser receives them. Home timeline, DMs
  and notifications are never parsed. What leaves the page is a digest —
  dates, ids, addresses, follower counts — never the text of anyone's posts.
  The ledger is `chrome.storage.local` on your machine. No server, no shared
  database, no upload, no account of yours used to follow or interact with
  anything. Zero new extension permissions.
- **What it refuses to pretend.** Nobody can tell you a bio changed on a day
  they never saw the bio. Products that imply otherwise are reading someone
  else's surveillance database; PaperTrench does not have one and will not
  fake one. So every change counter on the card carries the window it was
  observed over — "no change seen · watching since Aug 5" — and CA history
  and Smart Following say which posts and lists they were built from. A floor,
  labeled as a floor, is worth more than a confident number that is wrong.
  The watch window starts the first time you view an account, so the card
  gets sharper the longer you use it.
- **Deep scan (on with X-Ray, separately switchable).** Lets the page re-issue
  a request it already made — the same one X fires when you scroll — to read a
  few more pages of posts or the follower list. Throttled by minimum spacing,
  a per-minute cap and a per-account cooldown; runs only while you are on that
  account; uses your existing X session against x.com itself. The service
  worker never contacts X. If X rotates its API, the deep scan quietly stops
  and the passive layer keeps working — the card degrades, it does not break.
- Suite: 749/749, including a hand-built DOM that drives the card end to end
  (an intel card that throws is an intel card that is not there) and tests
  pinning that a first sighting can never be reported as a change, that a
  sparse user object embedded in a tweet cannot register as "bio cleared",
  and that a forged page-world digest cannot write a fake contract address
  into the ledger.

## v2.5.2 — 2026-08-05

Three fixes straight from the maintainer taking a live trade.

- **The resize grip can never stick again.** A cancelled gesture (misclick,
  drag out of the window, context menu) used to leave the drag latched — the
  panel kept resizing with every mouse move. Pointer capture now guarantees
  a terminal event, and pointercancel ends the drag like pointerup.
- **Resize from any corner.** All four corners are grips. The panel is
  right/top-anchored, so left corners grow it leftward from the planted
  right edge, and top corners grow it upward while the bottom edge stays
  planted.
- **Flex it — wins AND losses.** The Closed P&L card in the overlay now has
  a Flex button that opens the share composer for that exact result (the
  newest round, or the open position after a partial exit). Losses are
  flexable by design; the PAPER watermark rides along either way.
- **The Closed P&L card stopped blinking.** It was being rebuilt on every
  heartbeat, re-running its entry animation each time. It now renders once
  per close; only the how-long-ago text updates in place.

## v2.5.1 — 2026-08-05

Spotted in the maintainer stream footage: the real terminals card an OPEN
position — the "still holding" flex — and ours only carded closed rounds.

- **Share an open position.** Live open positions on the Overview now carry
  a Share button. The card states OPEN, the middle column reads POSITION
  (live value at the last recorded mark), the journey line claims no EXIT
  that has not happened, and USD figures appear only where fills and marks
  genuinely recorded them. Same gallery, same Customize/Download/Copy —
  and the same un-removable PaperTrench branding.

## v2.5.0 — 2026-08-05

Requested by the maintainer: let people flex their PaperTrench P&L — with
the one thing that can never come off the card.

- **The share card grew up.** Terminal-grade composer: token symbol and
  multiple chip, a huge ◎ SOL P&L, Invested / Returned / P&L% columns with
  honest USD sub-lines (em-dash when a fill never had a USD price — never a
  fabricated conversion), the entry→exit→held journey line, and an
  observed-only After line ("−62% after exit — dodged") no other terminal
  can print, because no other terminal measures it.
- **Backgrounds, yours.** Five built-in looks plus your own uploads — max
  2 MB each, ten stored, saved between sessions, deletable. The drop zone
  still works and now remembers what you dropped.
- **Customize / Download / Copy.** Toggle which stats show, pick a trim
  accent, download a PNG, or copy straight to the clipboard for
  paste-and-go posting.
- **The non-negotiable, by construction:** the PAPER watermark and the
  PaperTrench brand bar are drawn last by a code path that reads no
  settings — verified by a test that drives every combination of options
  and asserts the branding survives all of them. Flex the result;
  never fake it.
- **Instant X links now speak GMGN and Axiom.** The first field report —
  "works on Padre, not the others" — came down to link forms: GMGN trench
  rows link a token's X *community* (`x.com/i/communities/…`) and Axiom's X
  affordance is a *search* for the CA, and both used to fall through to a
  cold tab. Both warm-route now. Interception also moved to the earliest
  point in the event chain and finds anchors through shadow DOM, and any X
  link form still unrecognized logs its exact URL to the service-worker
  console (locally) so the next gap names itself.
- **Hover preview cards (opt-in).** The terminals' own tweet previews are
  small and demand you hit a 14px icon. PaperTrench's card is big, readable,
  and IS the click target — hover an X link and the post renders right on
  the page (~200ms via X's public oEmbed endpoint, no login, do-not-track,
  cached); click anywhere on the card to open it instantly in the warm
  viewer. A deleted post says "unavailable" on the card — the rug signal
  before you spend a click. Communities and profiles get a slim click-through
  card. A second opt-in goes further: rest the cursor anywhere on a token
  ROW for a third of a second and its preview appears — no aiming at all.
  Both settings live in the dashboard, both off by default.
- **Deleted tweets are fast now.** A dead link used to trigger a pointless
  "repair": X rendered "this post doesn't exist", the extension mistook
  that for a failed hop, and full-reloaded the same dead URL — seconds to
  say the same thing. The error page now counts as arrival (a deleted
  launch tweet is signal — see it instantly); only an error that was
  already on screen before the hop still falls through to the repair.
  Also pinned by test: classification never rewrites a link — path and
  query pass through byte-for-byte, so PaperTrench can never be the reason
  a tweet looks dead.

## v2.4.0 — 2026-08-05

- **A real off switch.** The popup now has a ⏻ button (and the dashboard an
  "Enable PaperTrench" checkbox) that turns the whole extension dormant:
  no overlay, no positions bar, no chart drawings, no title feed, no instant
  X links — on every open tab, immediately, until you turn it back on.
  "Disable overlay" only ever hid the panel; this is the switch for
  "I don't want PaperTrench showing up anywhere right now." Your wallet,
  journal, and every sub-setting are kept, so switching back on restores
  exactly the setup you had.
- **Instant X links (opt-in).** Traders vet a coin by clicking its X link —
  and then wait ~3.5 seconds for a cold tab to load. With the new toggle in
  the popup, X posts and profiles clicked on any supported trading site open
  in a kept-warm viewer tab via an in-page navigation: about half a second,
  and every follow-up click lands in the same already-hydrated tab. If the
  fast route ever fails, it silently falls back to a normal load of the same
  URL — worst case is exactly what you have today.
- **Hover prefetch.** Rest the cursor on an X link for a tenth of a second
  and the hidden viewer starts navigating there before you click — so the
  click itself often just reveals an already-loaded post. Hovers never
  create tabs, never move a tab you are reading, and a hover that never
  becomes a click costs nothing.
- Honest costs, stated up front: while enabled, PaperTrench keeps ONE muted
  background x.com tab as the viewer (closed again if you turn the toggle
  off before using it). Two passive bridge scripts now load on x.com —
  they act only on PaperTrench's own messages and are pinned by a manifest
  test to never include the trading engine or overlay. Zero new extension
  permissions, no telemetry, no remote switches. Ctrl/Cmd/middle-click
  always bypasses the feature and opens a real background tab.

## v2.3.0 — 2026-08-05

Community feedback batch (thanks lev) — all four items, same day.

- **The average line can never ride the candle again — by construction.**
  After one user still saw the drift post-fix, the recompute-per-second
  design was replaced outright: the line level is computed once per spec
  and FROZEN (an average is a constant level in axis units). If any data
  link ever goes stale again, the line holds at its last correct level
  instead of chasing the price.
- **Focus mode is now genuinely compact**: the position-detail rows
  (size / avg entry / value) hide — unrealized P&L and quick sell stay —
  and the whole panel tightens toward the size of the site terminal.
- **Quick reset in focus mode, no popup**: a ⟲ button in the panel header
  (focus mode only). Tap once to arm — it turns into "Sure?" for three
  seconds — tap again to reset. Streams keep their focus; fat fingers
  keep their journal. Resets clear recordings and chart drawings like
  every other reset path.

## v2.2.0 — 2026-08-05

Requested by the maintainer: make paper fills cost what real fills cost.

- **Fees & costs emulation.** A new settings card models the FULL cost of a
  real fill: the platform percentage (as before), plus a flat priority fee
  (gas) and a bribe/tip per transaction — the costs that dominate small
  entries and that zero-cost practice quietly ignores. Quick fill-in
  presets give rough starting points; your own site settings are the truth.
- The accounting is honest end to end: flat costs join the cost basis on
  buys and reduce net proceeds on sells, so per-sell P&L, rounds, the
  calendar, the equity curve (still exact to the SOL), and the verification
  chain all include them. A dust exit can genuinely net negative — you paid
  gas to leave a worthless bag, which is precisely the lesson.
- Defaults are zero, so existing wallets change nothing until you opt in.

## v2.1.0 — 2026-08-05

The value release: the practice loop gets its most important missing organ,
plus training wheels, data ownership, and a same-day community fix.

- **The After.** Every closed round now watches its coin for the following
  hour and records what ACTUALLY happened after your exit — observed
  extremes, sample counts, no interpolation. The rounds table gains an
  "After (1h)" column (a −30%+ dump after you sold reads green: you dodged
  it; a big run without you reads red), and the discipline panel aggregates
  your median further-upside and dumps-dodged across the record. The most
  expensive guesswork in this market — and the #1 revenge-FOMO trigger —
  replaced with measured truth.
- **Guardrails (training wheels).** Opt-in, enforced at buy time: a tilt
  breaker (N straight losses → cooldown), a max position size (% of your
  live book), and a daily loss limit. The three rules every surviving
  trader eventually adopts, practicable while the money is fake.
- **Fill bubbles land on the candles (community screenshot, fixed same
  day).** On mcap charts the fill markers floated above the candles (raw
  resolver-implied cap vs the chart own cap scale) and could park past the
  final bar (clock skew on 1 s charts). Shapes now share the avg line
  close-corrected level math — supply cancels, the chart scale wins — and
  clamp to the newest bar. The mcap-headline sub-line also says "Price …"
  now instead of the ambiguous "MC · …".
- **CSV export** for the journal and rounds — your data, one click,
  RFC-4180-safe, After columns included.
- **Onboarding checklist** on Overview for newcomers: first buy → thesis →
  first close → first After → review → the 50-round road to the graduation
  bar. Dismissible; disappears on its own once you have done it all.
- **Sharper prices on fresh launches**: ambiguous unknown-unit ticks are now
  refused with a distinct reason instead of risking a double-converted
  price; GMGN markers snap to the bar grid; host-chart callbacks are
  hardened so a PaperTrench bug can never break the site own chart; backups
  say honestly that screen recordings stay on this machine; replay
  scrubbing is memoized; coach timestamps match the calendar day you see.

## v2.0.1 — 2026-08-05

First post-2.0 community report, fixed same-day.

- **Holding a real position no longer confuses the paper numbers.** When you
  hold a REAL position on the same token, the site streams your real entry
  average alongside the live price — and PaperTrench was accepting it as a
  market tick, so the paper P&L and the average line could blend your real
  buy with your paper buy. Your own position data is now never treated as a
  market price: the avgPrice key is excluded and anything inside a
  positions/holdings/portfolio subtree is identity-only.
- **The paper line can never impersonate the real one.** Our average lines
  are now labeled "PAPER Avg. Fill" / "PAPER Avg. Exit" — deliberately
  different from the site own real-position label, same doctrine as the P&L
  card watermark.

## v2.0.0 — 2026-08-05 · out of alpha

The production release. A full four-track code audit produced a public,
ranked defect register (`DEFECTS.md`, 139 findings); v2.0.0 closes 116 of
them — every wrong number, every silent death, every wrong presence — each
with a regression test that fails on the old code. The rest carry explicit
engineering dispositions or sit on an enumerated v2.1 backlog (friction and
polish only). Suite: 553 tests, green.

**Numbers you can trust (the S1 class):**
- Fills can no longer execute at stale prices: chain state first, then the
  click-time snapshot, then a fresh page tick, then one resolver refresh —
  and a 3-second last resort for every source, aligned with the header's own
  staleness mark. Beyond that, the trade is refused with a visible reason.
  The old default path filled at prices up to 10 seconds old.
- Price collection is per-token: a batched frame can never attribute one
  coin's price to another, and trade arrays are read newest-first.
- The average-entry line finally HOLDS YOUR ENTRY. It used to ride the
  candle on market-cap charts. Unit toggles re-draw it immediately; before
  any chart evidence exists there is no line rather than a wrong-unit line.
- GMGN markers and lines are corrected against the chart's own candle scale;
  a fill without a genuine USD price waits for one instead of drawing ~150×
  low. Fill markers survive chart remounts and resolution changes.
- Sites without a native chart hook get an honest marker rail — real fills,
  real levels, no fabricated Y positions pretending to be chart-accurate.
- Dashboard accounting is unified: the equity curve converges exactly to
  equity, realized P&L includes partial exits everywhere, the verification
  chain agrees with an honest wallet by construction, and open/closed %
  share one basis.

**Feeds that survive volume (the S2 class):**
- The high-volume fixes that used to exist only for GMGN's trade feed are
  now the contract for every site: bigger parse guard with a bounded
  collector walk, per-mint throttling, and a 10× stress harness in CI.
- A fast runner no longer freezes the feed: sustained out-of-band ticks
  force an immediate re-anchor. Armed buys wait while the market is visibly
  trading instead of expiring on a bare clock.
- The RPC pool stops eating itself: vault discovery costs one round trip
  (and is cached), and a fully benched pool cools down instead of hammering
  dead endpoints.
- Screener quick-buy chips fill on the first tap, price from fresh quotes
  only, never stick busy, and step aside when the panel covers them.

**An overlay that behaves (the S3/S4 classes):**
- PaperTrench now runs ONLY on the nine supported trading sites — never
  anywhere else. Wallet, portfolio, and EVM routes never mount the panel.
  Pump.fun is a first-class site with its own adapter.
- Navigation is instant (SPA route hooks instead of an 800 ms poll) and can
  never trade the previous token on a new page.
- One drag system: panel, positions bar, minimized pill, and the collapsed
  tab all drag with touch support, both-bounds clamps, and positions that
  can never be lost off-screen. Disabling the overlay removes everything,
  including chart drawings; reloading the extension leaves nothing behind.
- The dashboard stops fighting you: tables keep their scroll position, async
  results survive refreshes, settings saves can't clobber your layout, and
  every failure says so out loud.

**New: the graduation bar.** The coach view now evaluates the seven-criterion
bar from `docs/GRADUATION.md` against your own journal — expectancy that
survives removing your best round, loss sizing, hold symmetry, revenge
re-entries, thesis coverage, cold-streak discipline — and missing evidence
never counts as a pass. Paper failure is definitive; clearing the bar earns
a small, careful start.

**Also:** structured bug-report form, a 9-site release QA matrix, a preflight
script that gates every tag, a full permissions audit (`docs/PERMISSIONS.md`),
and the public roadmap + defect register linked from the README.

## v1.2.18 — 2026-08-05

First fix batch from the public defect register (`DEFECTS.md`) — six correctness
fixes on the money paths, every one locked with a regression test.

- **Fast navigation can no longer trade the wrong token.** Switching coins while
  the previous one was still resolving could leave the panel showing — and
  **buying** — the previous token on the new page. Navigations that land
  mid-resolve are now retried instead of silently swallowed, and a resolve that
  finishes after you've left the page is discarded instead of resurrecting the
  old token.
- **Double-tap sells fill once.** Sells carry the same in-flight guard buys
  always had. A second tap on "SELL 50%" while the first is filling is refused
  — previously it silently sold 50% of the *remainder* (75% total) with two
  success toasts.
- **AI reviews and recording links stop vanishing from the dashboard.** The
  background service worker now advances the wallet's write counter, so open
  trading tabs adopt its writes instead of overwriting them within a second.
- **Backup restore sticks.** A restored wallet lands strictly ahead of every
  open tab's write counter, so a live tab can no longer resurrect the wallet
  you just replaced.
- **Screener quick-buy chips price honestly.** A chip tap now demands a quote
  no older than 3 seconds; previously it could fill at a price from the
  resolver's 60-second display cache.

## v1.2.17 — 2026-08-05

Reliability hardening release — no feature changes.

- **Storage failures are no longer silently ignored.** The background service
  worker now checks every `chrome.storage` read and write for errors. A failed
  read falls back to safe defaults (never a fabricated wallet, never an invented
  AI endpoint) and a failed write reports itself instead of pretending it
  worked. Locked with new regression tests that simulate storage failure the
  way Chrome actually reports it.
- **Stale AI credentials are cleaned up.** Settings migration revision 7: if a
  saved AI API key/model was tied to the removed insecure local endpoint (or to
  no endpoint at all), it's cleared — so an old key can never be silently sent
  to whatever endpoint gets configured next. Deliberately configured endpoints
  and explicit local opt-ins are untouched.

## v1.2.16 — 2026-08-05

- **Sell buttons no longer disappear after overlay toggles or SPA navigations.**
  Reported on v1.2.13: "still having issues with that sell button
  disappearing". Root cause: `disableOverlay()` and `shutdown()` destroyed
  the shadow DOM but left the position-card cache (`posEls`) pointing at
  detached nodes. On re-enable, `renderPosition()` saw a truthy cache and
  skipped rebuilding the card — so the new card was created without sell
  buttons. Both teardown paths now null the cache so the card always
  rebuilds cleanly. Locked by a source-contract regression test.

## v1.2.15 — 2026-08-05

- **Focus mode for the trade tab.** Requested from the community: "make the
  trading tab like Axiom and other platforms for more optimised and less
  distracted trades". A new **Focus mode (Axiom-style)** toggle in Settings
  → Overlay strips every decoration from the panel — banner, watermark,
  sparkline, thesis card, last-close card and footer — and leaves only
  token, price, balance and buy/sell controls. Opt-in; the full panel stays
  the default, and flipping the switch applies live on every open tab.

## v1.2.14 — 2026-08-05

- **GMGN high volume no longer kills the live feed.** Reported from GMGN:
  "doesn't work when volume is high". Two real causes, both fixed:
  - GMGN's realtime trade batches grow past the bridge's 500KB frame guard
    exactly when volume peaks. The guard dropped those frames *before* the
    trade feed could read them, so the live price went silent at the worst
    possible moment. Trade batches now bypass the guard (which still
    protects the generic collector); every other oversized frame stays
    dropped.
  - Hot batches carry trades for many tokens at once, and the token you're
    watching could get crowded out of the 4-tick budget by random batch
    order. The token on screen is now always emitted first.

## v1.2.13 — 2026-08-04

- **The panel now remembers its place.** Drag the PaperTrench panel anywhere
  you like — the position is saved and restored on every refresh, new tab,
  and every supported site. Previously each page load snapped it back to the
  top-right corner. If a saved position would land off-screen on a smaller
  window, it's clamped back so the panel always stays grabbable.

## v1.2.12 — 2026-08-04

Community report round three, both points addressed.

- **Average fill price is now honest on fresh launches.** The "Avg. Fill
  Price" line used to be computed only from the fills that happened to record
  a USD price. On a fresh launch the first ticks often pre-date the USD feed,
  so those fills carried no USD — and the displayed average quietly covered a
  subset of your fills (say 1 of 3 buys). Now: when the USD set is
  incomplete, the overlay derives the USD average from the *complete*
  SOL-denominated average at the live SOL/USD rate, so the line always covers
  every fill. When every fill recorded USD, the recorded average is used
  directly, as before.
- **Quick-buy (QB) settings found at last.** The five QB toggles existed but
  were buried mid-list inside "Wallet & Trading" — a user looking for "the QB
  toggle" couldn't find them. They now live in their own settings card titled
  **Quick-buy (QB)**: presets, one-click buy, screener chips, chip size, and
  the trade-tab buy section.

## v1.2.11 — 2026-08-04

Fixes GitHub issue #17 — a user's sell options disappeared mid-session.

- **Sell options no longer vanish on vault-style pools.** Constant-product
  vault tokens were priced from a description that never carried the token's
  decimals, so the first live vault update crashed the price handler. That
  crash killed the whole live-price stream, and without prices the sell
  buttons had nothing to quote against. Vault tokens now carry full decimals
  (token + wrapped SOL) before they're ever watched.
- **The live-price stream can no longer die from a single bad frame.** The
  socket handler is now crash-isolated: a malformed or hostile update is
  dropped and the feed keeps streaming. One weird token can't take down
  everyone's prices anymore.

## v1.2.10 — 2026-08-03

Second community bug report, second full audit — this one found three real
bugs, all now fixed and locked in with regression tests.

- **Reset no longer brings the old wallet back.** Resetting from the popup or
  dashboard wrote the fresh wallet at write-counter zero, so a still-open
  trading tab (holding the pre-reset wallet at a higher counter) overwrote it
  with its next heartbeat and resurrected your old positions. Resets now
  inherit the current counter and land strictly ahead of every open tab.
- **Buy and sell failures finally say so.** A mutation helper swallowed its
  own errors, so a rejected fill — insufficient balance, token changed mid-fill,
  a storage hiccup — left the button doing nothing with no message. Errors now
  reach the toast that reports them.
- **Dashboard writes can no longer be clobbered by a lagging tab.** Notes and
  AI reviews written from the dashboard now advance the write counter, so a
  slow price-mark from an open tab can't silently erase them.

Prices were checked too: the on-chain feed's stale-slot guard and 2.5s
freshness window are intact and were already covered by tests.

## v1.2.9 — 2026-08-03

The "updating shouldn't erase you" release. Unpacked extensions tie their data
to the install folder, so a fresh unzip into a new folder looked like a brand
new wallet. Two fixes for that, plus the groundwork for a proper fix.

- **Backup & Restore in the popup.** One click downloads your whole wallet —
  positions, rounds, history, settings, frames, replays — as a single JSON
  file. Restore validates the file and confirms before overwriting anything.
  Moved folders, reinstalled, or switched machines? Two clicks and you're back.
- **The site now teaches same-folder updates.** Unzip the new release *over the
  folder you already loaded*, hit Reload, and your data survives. A new folder
  starts a blank wallet — now spelled out on the install page.

Coming next: Chrome Web Store listing, which makes updates automatic and this
whole class of problem disappear.

## v1.2.8 — 2026-08-03

The security patch. A sharp-eyed user reported three privacy/safety bugs; all
three were confirmed real and all three are fixed here.

- **Snapshots now photograph the tab that traded.** Frame captures (every
  30 s while recording, plus each fill snapshot) used to grab whatever window
  happened to be focused — your email, another chart, anything. Captures now
  resolve the trading tab's own window, and if that tab is hidden or closed
  the frame is skipped rather than guessing at some other screen.
- **Websites can no longer trigger paper trades.** Any script on the page
  could forge a bridge message and run a quick-buy fill with zero input from
  you. Trade-bearing messages now require a genuine user gesture within the
  last 5 seconds (`isTrusted` only — synthetic events don't count) and must
  come from the page's own origin; cross-origin posts are dropped outright.
  Real chip taps work exactly as before.
- **Verification no longer breaks for heavy traders.** The attest chain was
  silently capped at 5000 links, which corrupted chain verification and
  replay-derived P&L for anyone past that count — even with nothing tampered.
  The cap is gone; the full chain is retained (the extension already has
  unlimited storage permission).

## v1.2.7 — 2026-08-03

The X-feedback batch — four things you asked for, plus one layout fix.

- **The positions bar finally stays hidden.** Hiding it used to be a per-page
  mood: collapse it, open the next chart, and it was back. Your choice is now
  a saved setting, so hide-it-once means hidden everywhere — every page, every
  tab, every session. One click on the POSITIONS tab brings it back, and that
  choice is saved too.
- **Post-close notes on rounds.** The thesis is written before you know how it
  ends; the lesson usually arrives after. Every closed round now has a Notes
  column — add or edit a retrospective note any time. The AI coach reads it
  too: confirm it, correct it, or sharpen it.
- **Leaderboard shows ROI on your bankroll.** Absolute SOL flatters whoever
  started with the biggest paper balance, so every result now shows the return
  on your *declared starting balance* next to the raw number — and the bankroll
  itself is displayed so the percentage is checkable. Rankings compare like
  with like.
- **The AI coach explains itself.** Since the endpoint ships blank (the SSRF
  hardening), "AI not working" usually meant "not configured yet". The Test
  button now says exactly that and tells you what to paste — and the settings
  form spells out that blank means the coach is off, plus the local toggle for
  localhost/LAN endpoints.
- **Homepage goes full-bleed on wide monitors.** The site was pillar-boxed to
  1180px, which looked stranded on ultrawides. Content and nav now share one
  wider container (1440px) so nothing drifts out from under the navbar.

## v1.2.6

- Quick-buy toggles: hide the whole Buy section in the trade tab, or just the
  one-tap preset row, from Settings. Live-applied, no reload.
- SSRF hardening: the AI endpoint ships empty; localhost/LAN endpoints require
  an explicit opt-in toggle.

## Earlier

- Armed snipes survive pair→mint resolution on Axiom/Photon/BullX; heartbeat
  flushes and expires them; storage failures can no longer wipe your wallet.
- Overlay auto-hide when no token is detected, master overlay toggle,
  resizable trade tab, draggable positions bar, average fill/exit price lines,
  GMGN support, and the paper fill attest chain.
