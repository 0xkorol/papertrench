# PaperTrench — Defect Register

Single source of truth for known defects (ROADMAP.md Phase 1). Every fix references an
ID here; every release closes entries here. Severity is mission-weighted:

- **S1 — lies:** a number displayed or filled is wrong.
- **S2 — silent death:** feed/fill/render stops without telling the user.
- **S3 — wrong presence:** something present where it shouldn't be, or absent where it should.
- **S4 — friction:** can't move/resize/find things; confusing states.
- **S5 — polish:** looks bad, inconsistent, unfinished, latent hazard.

Status: `open` → `fixing` → `fixed vX.Y.Z` (with the regression test that locks it) or
`not-repro` (with what we need from the reporter).

ID prefixes: **F** feed/fill path · **O** overlay lifecycle · **D** dashboard/state ·
**C** chart markers/lines · **V** visual polish.

---

## F — Live feed & fill path (audit: 2026-08-05, verified against source)

Community reports covered: "trades not going in during high volume", feeds dying.

### S1 — wrong numbers

**F-01 · S1 · Fills execute on quotes up to 10 s old — and that's the DEFAULT path**
`content.js:928,1017,1023-1024` vs `quote.js:483` · all sites · confirmed · **fixed v1.3.0** (quoteForTrade ladder rewritten; stale fills bounded at 3 s for EVERY source; refusals visible)
`ACTION_FALLBACK_MAX_AGE_MS = 10000` vs `STALE_AFTER_MS = 3000`. Gate is
`displayPriceOnly = token.pending || token.priceSource !== 'resolver'`, but
`content.js:355` sets `priceSource = 'page-feed'` on every accepted page tick — so on
any token priced by the site feed (the normal healthy case), fills accept the stale
snapshot at up to 10 s. Header renders `stale: true` while the fill commits at that
price. On a memecoin, 9 s is routinely a 30–50 % gap.
Repro: resolve token, one page tick, kill WS, wait 9 s, block Dexscreener, BUY → fills
at the 9 s price.

**F-02 · S1 · Generic collector merges price candidates from DIFFERENT tokens into one tick**
`price-bridge.js:121-157,250-252` · Photon, BullX, Axiom, DexScreener, Birdeye,
Jupiter, Pump.fun · confirmed · **fixed v1.3.0** (per-mint record collection in collect(); watched-first bounded emission)
`found.mint = found.mint || value` takes the first base58 seen anywhere in the frame;
`found.candidates` accumulates up to 32 prices from anywhere in the tree; one emit. A
batched frame (screener list, multi-pair snapshot) yields a tick tagged with token A's
mint carrying tokens B…N's prices. `quote.js:383-396` accepts the first candidate
within band, not the one belonging to the mint. No per-mint grouping anywhere in the
generic path — GMGN's `forwardTokenActivity` (`latestByMint` map) is the only correct
implementation.

**F-03 · S1 · Generic collector reads the OLDEST trades in a batch — price lag grows with volume**
`price-bridge.js:129,139` · all non-GMGN sites · confirmed · **fixed v1.3.0** (full-array traversal with newest-last candidate ring + global node budget)
`node.slice(0, 80)` + 32-candidate cap stop at the FRONT of newest-last trade arrays
(newest-last confirmed by `nativecharts.test.js:798`). Longer batches at high volume →
older reported price, monotonically. `forwardTokenActivity:172-176` (full iteration,
keep last per mint) is the correct pattern, applied to exactly one site.

**F-04 · S1 · Row quick-buy fills from a 60 s resolver cache with no age check**
`content.js:2969-2982`, `resolver.js:19-27,92-93` · Axiom Pulse, Padre Trenches, GMGN
Trenches · confirmed · **fixed v1.2.18** (resolve() accepts maxAgeMs; row buys demand
≤3 s; behavioral test in resolver.test.js)
`doRowBuy` prices from `R.resolve()` which serves cache up to `TTL_MS = 60000` with no
staleness check before `E.buy`. The `recentRowPrices` override only fires on mint-tagged
row ticks — exactly what F-02/F-03 fail to produce. A chip tap on a token seen 55 s ago
fills at the 55 s price.

**F-05 · S1 · ACCEPT_RATIO = 20 is too wide to reject wrong-token prices**
`quote.js:343,462-466` · all sites · confirmed · **fixed v1.3.0** (structurally closed by F-02 attribution; band now only arbitrates identifier-less frames)
Candidates accepted at up to 20× either direction (400× total window). Combined with
F-02, any foreign token within 20× passes; `validateTick:437-449` then derives the other
currency side and mcap from the same bad ratio — corruption is self-consistent, so it
looks plausible on screen.

### S2 — silent death / stall

**F-06 · S2 · 500 KB frame guard bypassed ONLY for GMGN token_activity — every other site still loses oversized frames**
`price-bridge.js:217-224` · all sites except GMGN trade feed; including GMGN's own
mcap-candle path (guard at :222 precedes handler at :234) · confirmed · **fixed v1.3.0** (guard raised to 2 MB (walk separately budget-bounded); mcap-candles routed around it)
The v1.2.14 fix's exact bug is still live for Padre/Photon/BullX/Axiom/DexScreener/
Pump.fun/Birdeye frames and GMGN chart candles: >500 KB dropped whole, silently, no
counter, no log. NOTE: `nativecharts.test.js:802` locks current behavior in — the test
must change with the fix.

**F-07 · S2 · token_activity throttle is global, not per-mint — other mints' batches starve the watched coin**
`price-bridge.js:170,178` · GMGN · confirmed · **fixed v1.3.0** (throttle is per mint with bounded clock map; stress-locked)
`now - lastActivityTickAt < 100 → return` runs before batch inspection; the stamp is set
when ANY mint is priced. v1.2.14 fixed intra-batch crowding but not inter-batch: at high
volume, inter-batch gaps < 100 ms discard whole batches including the watched mint. Same
class as the fixed bug, one layer up. No test.
Repro: filler-mint frame, then watched-mint frame 30 ms later → zero ticks.

**F-08 · S2 · Row quick-buy chips refused by their own gesture gate; chip sticks in `busy` forever**
`price-bridge.js:1459-1477,1301-1303`, `content.js:249-251,265-268` · Axiom Pulse,
Padre Trenches, GMGN Trenches · confirmed (mechanism), high-confidence (event
semantics) · **fixed v1.3.0** (pointerdown propagates to the gesture stamp; refusal path always clears chip busy)
Bridge's MAIN-world capture listener calls `stopImmediatePropagation()` on chip taps, so
content.js's ISOLATED-world `noteGesture` never fires; after 5 s idle, tap is refused
("Paper buy needs a real tap…"). The refusal branch returns WITHOUT `row-buy-done`, and
`busy` is only cleared by that message → chip stuck until row recycled. This is a
literal "trades not going in" report.

**F-09 · S2 · findVaults fans out unbounded sequential RPC scans — exhausts the keyless pool in ~10 token switches**
`onchain-feed.js:162-193`, `rpc-pool.js:13,43,110-115,127-152` · all sites · confirmed
· **fixed v1.3.0** (8-byte-aligned scan first + per-pool vault cache + benched-pool circuit breaker with half-open probe)
Byte-offset scan yields ~700–1500 candidate pubkeys → 8–15 sequential `getAccounts`
round trips per watched token, against a 100 req/10 s budget. Cascade: failures bench
all 3 public endpoints (60 s cooldown) → `ranked()` keeps returning least-bad → keeps
failing → `watch()` false → `onchainLive` false → chain-quote authority path dead →
every fill degrades to F-01. Only UI signal: the `· CHAIN ⚡` suffix disappears.

**F-10 · S2 · A genuine >20× move freezes the feed silently for up to 30 s**
`quote.js:429-430,487,503-505`, `content.js:344` · all sites · confirmed · **fixed v1.3.0** (5 consecutive out-of-band rejections force an immediate re-anchor, throttled 3 s)
Out-of-band ticks rejected with no log/counter/UI; anchor refreshes only every 30 s. A
launch doing >20× inside 30 s has EVERY tick rejected: price freezes at the pre-move
anchor exactly when it matters most, fills route to resolver or the 10 s snapshot
(F-01).

**F-11 · S2 · Nothing detects a dead bridge feed or fails over**
`price-bridge.js` (no watchdog), `quote.js:496-509`, `content.js:3290-3292` · all
sites · confirmed · **partial fix v1.3.0** (recovery via F-10 re-anchor; live-dot honesty verified pre-existing; full failover orchestration deferred to backlog)
No liveness monitor on the price path; live-dot keys off `priceNative` existing, not
feed liveness. De-facto fallback is Dexscreener polling at 400 ms/tab (~150 req/min vs
~300 budget) — which throttles during high volume, so feed-death and fallback-death are
correlated.

**F-12 · S2 · Padre binary frames and dedicated-Worker sockets are invisible**
`price-bridge.js:295-308,314-334` · Padre primarily · confirmed · open
Only string WS frames are parsed; Padre's multiplex is binary protobuf (per the file's
own header comment). Padre has exactly one live path (`subscribeBars`) and no WS
fallback; a missed TradingView patch window → Dexscreener polling only. Dedicated
`Worker` globals are entirely uninstrumented (only `SharedWorker` is wrapped).

**F-13 · S2 · Every fill blocks on a service-worker round trip that consumes the freshness budget it protects**
`content.js:990,994-995`, `background.js:632-635` · all sites · confirmed · **fixed v1.3.0** (click-time snapshot captured before the first async hop; age judged at click)
`await R.onchainQuote()` is the FIRST await in `quoteForTrade`; MV3 cold SW = 100–500 ms
(worst at high volume when it's servicing every tab). The 350 ms snapshot age test runs
on a clock that already advanced during the round trip: fresh local data is discarded
because checking the remote source took too long.

**F-14 · S2 · All fills serialize behind one promise chain writing a never-truncated hash chain**
`content.js:1051-1061,1106-1111,2878-2885` · all sites · confirmed · open
Every fill: reload full state → SubtleCrypto over the whole attest chain → persist full
state (incl. `attestChain`, never truncated). Fill latency grows linearly with lifetime
fill count; the only feedback is "Buy already in progress…", which reads as broken.

**F-15 · S2 · doSell has no in-flight guard — double-tap sells the wrong quantity silently**
`content.js:1389` (vs `buyInFlight` at :1313,:1321) · all sites · confirmed ·
**fixed v1.2.18** (sellInFlight guard, cleared in finally; locked in
statepersist.test.js)
Two fast taps on "SELL 50 %" both quote and both commit; the second sells 50 % of the
remainder → 75 % total, two success toasts, zero errors. (`doRowBuy` also uses a
separate flag from `doBuy` — chip tap and panel BUY can interleave.)

**F-16 · S2 · Fresh launches on market-cap charts can never bootstrap — armed buys always expire**
`quote.js:313,331`, `price-bridge.js:239-246`, `content.js:615-618` · GMGN, Axiom ·
confirmed · **fixed v1.3.0** (armed buys expire on market QUIET (15 s past TTL) with a 5 min hard cap, never bare clock)
`bootstrapTick` rejects mcap-only ticks without supply; GMGN's chart emits exactly that
shape (`gmgn-mcap-candle`: empty candidates, mcap only) and Axiom defaults to mcap
view. For a coin with no Dexscreener/Jupiter anchor — the arm-and-fire target case —
the armed buy sits 60 s and dies "no quote arrived in time". The snipe path is
structurally dead on the two mcap-charting sites.

**F-17 · S2 · Background tabs lose every price path simultaneously**
`price-bridge.js:1792`, `quote.js:499`, `content.js:589` · all sites · confirmed · open
Chart poll, requote, and heartbeat all gate on `document.hidden` (plus Chrome interval
throttling). Return to a backgrounded tab → price of arbitrary age, stale-flagged at
3 s but fillable to 10 s (F-01). Only exception: profit-alert watcher at 2 s.

**F-18 · S2 · Screener chip layout thrash starves the main thread the feed parses on**
`price-bridge.js:1479-1554,1573-1586,1654-1764`, `content.js:2947-2959` · Axiom Pulse,
Padre Trenches, GMGN Trenches · confirmed · open
Body-wide MutationObserver with `characterData: true` → every price-digit change on the
list schedules repositioning; each rAF does O(N chips) forced synchronous layouts
(`getBoundingClientRect` + `elementFromPoint` + pill search), plus 80-fiber walks per
unchipped row. content.js installs a SECOND body-wide subtree observer. `forwardJson`
parses on this same thread: main-thread starvation IS the feed dying. Highest
volume-sensitivity item; invisible to unit tests.

**F-19 · S2 · Chart-export poll emits only on price CHANGE — flat market reads as dead feed**
`price-bridge.js:1829` · Axiom primarily · confirmed · **fixed v1.3.0** (export dedupe reset on token switch; unchanged close re-asserted every 2.5 s)
Unchanged close emits nothing; on Axiom the export poll is frequently the only price
path. Flat/illiquid token → zero ticks → stale header → resolver fallback on every
click despite a healthy chart. `lastExportedClose` is never reset on token switch
(leaks across tokens; `lastBarClose` is reset at :89, this one isn't).

### S3 — wrong presence

**F-20 · S3 · Staleness gates are inverted relative to source accuracy**
`onchain-feed.js:41,397` vs `content.js:928` · confirmed · **fixed v1.3.0** (policy aligned: chain authority first, page snapshot bounded at 3 s — no inversion)
The chain quote ("the authority", content.js:988) is refused past 2.5 s; the page
snapshot is accepted to 10 s. Failing strict on the accurate source silently routes
fills to the loose gate on the inaccurate one.

**F-21 · S3 · subscribe() leaks an orphan pending entry on every cold-socket subscribe**
`onchain-feed.js:261-278,376-377` · confirmed · **fixed v1.3.0** (pending registered only when the frame went out; onopen resubscribes)
`pending.set` before `send()` which returns false on CONNECTING; first subscribe after
every connect is dropped (rescued only by onopen resubscribe). Orphaned entries never
cleaned — unbounded Map growth over long sessions.

**F-22 · S3 · title-feed gives up permanently if the SPA hasn't set a title yet**
`title-feed.js:105`, called once from `content.js:454` · all sites · confirmed · **fixed v1.3.0** (a head observer waits for a late <title>; stop() cleans it up)
`!document.title → return false` before installing the observer; no retry. Title signal
dead for the whole page load on late-titling SPAs.

**F-23 · S3 · Generic title patterns match the first $ figure in the title**
`title-feed.js:38,40-43` · Padre, Axiom, BullX, DexScreener, Birdeye · confirmed · **fixed v1.3.0** (acceptFromTitle: exactly one anchor-consistent figure or refusal — ambiguous titles never guessed)
Bare `$number` regex; the 3× validate band catches price↔mcap confusion but not a
different dollar figure within 3× (P&L, position value in tab title).

**F-24 · S3 · pump.fun has no adapter; the bridge instruments every site on the internet**
`sites.js:44-194,204-216`, `manifest.json:22-31` · confirmed · **fixed v1.3.0** (pump.fun adapter added; manifest narrowed to supported trading sites only)
Pump.fun (in the product description) falls to the generic fallback. Separately:
`matches: ["<all_urls>"]` at document_start/MAIN wraps fetch/XHR/WebSocket/SharedWorker/
EventSource and runs the 700 ms + 1000 ms intervals and a body-wide MutationObserver on
EVERY page the user visits. `all_frames: false` also misses feeds living in child
frames. (Overlaps overlay-gating cluster — cross-reference with O findings.)

### S4/S5 — friction & latent hazards

**F-25 · S4 · bootstrapTick unit heuristics hardcode today's SOL/USD scale**
`quote.js:220-222,296` · confirmed · open
Any unknown-unit close in [1e-7, 1000) assumed USD → a 5e-7 SOL close gets divided by
the rate twice (~200× wrong). `native` branch accepts anything < 1 SOL, no floor.

**F-26 · S4 · patchPadreWidget polls every 1 s forever on every site, incl. those with no TradingView**
`price-bridge.js:403,420,1853` · Photon, BullX, DexScreener… · confirmed · **fixed v1.3.0** (60 empty scans drop to slow cadence; revives on widget discovery or paper-axis)
Re-runs `getRankedCharts()` every second and an 8000-fiber walk every 3 s; never stands
down after N failures.

**F-27 · S5 · rpc-pool leaks a 4 s abort timer when fetch rejects**
`rpc-pool.js:130-139` · confirmed · **fixed v1.3.0** (abort timer cleared in finally) — timer cleared only on the resolve path; no
`finally`.

**F-28 · S3/S5 · commitFill swallows SubtleCrypto failures — fills journal without attestation, user never told**
`content.js:2888-2890` · confirmed · open — later `verifyChain` reports a mismatch the
user cannot explain.

**F-29 · S5 · Latent: bridge code runs inside host-site chart callbacks with no try/catch**
`price-bridge.js:530-537,696-700` · confirmed (latent pattern, no live bug) · open
A future throw in `noteResolution`/`barSymbolMatches`/`emitPadreBar` would break the
HOST site's chart, not just PaperTrench.

### Per-site adapter matrix (as audited)

| Site | Price path(s) | Oversize guard | Watched-mint priority | Notes |
|---|---|---|---|---|
| GMGN token_activity | WS/SharedWorker fast path | bypassed | YES | global 100 ms throttle (F-07) |
| GMGN mcap-candles | XHR | **ACTIVE — bug** (F-06) | implicit | |
| Padre | TradingView subscribeBars only | 500 KB (binary dropped, F-12) | YES (bars) | no WS fallback |
| Axiom | subscribeBars + export poll + generic | 500 KB | YES (chart) / NO (generic) | export poll F-19 |
| Photon | generic collect only | 500 KB | NO | F-02/03 fully apply |
| BullX | generic collect only | 500 KB | NO | F-02/03 fully apply |
| DexScreener | generic collect only | 500 KB | NO | F-02/03 fully apply |
| Pump.fun | NO adapter → generic fallback | 500 KB | NO | F-24 |
| Birdeye/Jupiter | generic collect only | 500 KB | NO | |

**The GMGN v1.2.14 fix pattern (guard bypass + full-batch newest-per-mint + watched-first)
exists on exactly one path of one site.** Phase 2's core job is making it the contract
for every adapter, enforced by the stress harness.

---

## O — Overlay lifecycle & movability (audit: 2026-08-05, verified against source)

Community reports covered: "overlay on pages it doesn't need to be on", "can't move
certain buttons".

### S1 — wrong numbers / wrong token

**O-01 · S1 · detectLoop adopts a stale resolve after navigating away — wrong token resurrected**
`content.js:396-446` (:434 await, :446 setToken) · all sites · confirmed ·
**fixed v1.2.18** (resolve results dropped when href changed mid-flight; locked in
statepersist.test.js)
`detectLoop` awaits `R.resolve()` then calls `setToken(data)` with no re-check that
`location.href`/candidate is still current (contrast `requote()` :634 which guards).
Navigate away mid-resolve → teardown → late resolve lands → token A resurrected: price
loop, title signal, onchain watch, markers, panel un-hidden — on the wrong page.
Repro: slow network, open token, click back to Pulse within ~1 s.

**O-02 · S1 · Navigation during an in-flight resolve is permanently swallowed — panel trades token A on token B's page**
`content.js:401-408` · all sites · confirmed · **fixed v1.2.18** (lastHref commits
only when the tick acts; locked in statepersist.test.js)
`lastHref = location.href` commits at :402 BEFORE the `if (resolving) return` at :407.
A nav landing in that window is recorded but never acted on; every later tick
early-returns (`href === lastHref && settled`). Panel keeps token A's card and sell
buttons on token B's page; `doBuy` fills token A's mint. Self-heals only on the next
navigation. `fastDetectTimer` can't rescue (returns unless `token.pending`).

### S2 — silent death / resource leaks

**O-03 · S2 · disableOverlay leaves chart markers, title observer, and onchain subscription alive**
`content.js:3574-3586`, `stopOverlays` :3527-3533 · all sites · confirmed · **fixed v1.3.0** (disableOverlay tears down markers, title signal, onchain watch; clears native drawings; standdown)
`stopOverlays` clears 5 timers but never calls `CM.destroyChartMarkers()`,
`stopTitleSignal()`, or `R.onchainUnwatch()`. Overlay off in popup → SVG overlay + its
observers + re-attach loop stay in the host chart; fallback strip stays on screen; the
host container's mutated `position: relative` is never reverted; background keeps
streaming pool state for the mint forever; `token` not nulled. (= C-18.)

**O-04 · S2 · shutdown() (extension reload) leaves the same chart artifacts permanently**
`content.js:158-170` · all sites · confirmed · **fixed v1.3.0** (chart markers registered for shutdown; bridge standdown + 5-min liveness watchdog)
`CM` has no `onTeardown` registration anywhere — `destroyChartMarkers()` is only
reachable from `setToken`. After extension reload/update the SVG overlay, fallback
strip, observers, and the 500 ms scanTimer keep running ownerless until page reload.
(See also C-17 for the MAIN-world half.)

**O-05 · S2 · createUI early-return leaves `host` null → every settings write stacks another interval set**
`content.js:2201-2202`, `3535-3572`, `watchStorage` :1130 · mechanism confirmed /
trigger hypothesis · **fixed v1.3.0** (createUI adopts-or-replaces; enableOverlay idempotent)
`createUI` returns without setting `host` if `#papertrench-host` already exists;
`enableOverlay` then creates detect/fast/bar timers + resize listener anyway, and
`watchStorage` calls `enableOverlay()` on EVERY settings write (incl. the extension's
own drag/resize persists). `els` stays `{}` → invisible overlay burning CPU + resolve
traffic.

**O-06 · S2 · onOverlayResizeEnd can latch `resizingOverlay = true` forever**
`content.js:2530-2539`, guard :2487 · confirmed · **fixed v1.3.0** (resizingOverlay clears before every early return)
Early return on `!els.box` skips `resizingOverlay = false`; `applyOverlaySize()` is
dead for the rest of the page — saved size never re-applied.

**O-07 · S2/S5 · Raw timers bypassing managedInterval**
`content.js:576` (priceTimer — has hand-written parity, but pattern risk), :2952
(row-buy debounce fires one scan after teardown = O-29), :3545-3546, :3486, :794,
:947 · confirmed · **fixed v1.3.0** (row-buy debounce tracked and cancelled; early timeouts mount-cleaned; remaining raw timers documented as self-limiting)

**O-08 · S2 · MAIN-world bridge has no shutdown path at all — on every site on the web**
`price-bridge.js:1475-1477,1573-1574,1586,1843,1849,1853`, `manifest.json:20-31` ·
every website · confirmed · **fixed v1.3.0 (partial by nature)** (manifest narrowed to trading sites; standdown + liveness watchdog silence the bridge; MAIN-world wrappers themselves are irremovable)
Five capture-phase pointer/mouse listeners, capture scroll+resize, three permanent
intervals, and a 10 ms boot probe — installed on `<all_urls>` at document_start,
ungated on site, unremovable (MAIN world has no extension-context concept). (= F-24
manifest half, C-23.)

### S3 — wrong presence

**O-09 · S3 · `<all_urls>` + generic adapter: any 32-44-char base58 run anywhere in ANY URL mounts the panel**
`manifest.json:22,32-52`, `sites.js:203-216` · every website · confirmed · **fixed v1.3.0** (manifest matches narrowed to 9 supported hosts; generic fallback now bounded to them)
`generic.detect()` scans the whole href (path+query+hash). A match mounts the full
panel AND `CM.initChartMarkers()` — whose scan uses selectors like `[class*="chart"]`,
`canvas` — then writes `position: relative` onto whatever page element wins. Repro:
solscan account page, raydium `?inputMint=`, magiceden, some Google Docs URLs.

**O-10 · S3 · overlayHideWhenNoToken checks `!token` — but a pending token is truthy, so auto-hide never fires on false positives**
`content.js:2565,416-419,435-442` · all sites · confirmed · **fixed v1.3.0** (per-site route allowlists + pending give-up (40 failed resolves + market quiet) with snipe window preserved)
Unresolvable address (wallet, EVM addr, random base58) → placeholder token kept
forever (`pendingAttempts` never tears down) → `hide` permanently false → panel pinned
open, `pt_resolve` re-issued every 250 ms for 90 s then 800 ms forever. THE
"appears on pages it doesn't need to be on" complaint; the default-on setting fails
open.

**O-11 · S3 · padre and dexscreener adapters have no route gating; EVM hex passes base58 ~13 % of the time**
`sites.js:80-83,154-157,35-42` · confirmed · **fixed v1.3.0** (route allowlists; EVM chains rejected; bullx address must be WHOLE base58)
Both are bare `pathTail()` — wallet/profile/leaderboard routes produce false tokens.
DexScreener EVM routes (`/ethereum/0x…`): hex minus `0` is a base58 subset, so ≥32-char
runs without `0` (~13 % of addresses) get sent to the Solana resolver as pairs. Same
class on bullx query param, birdeye/jupiter wallet paths (see gating map).

**O-12 · S3 · Photon's own tokenUrl shape `/en/r/<mint>` is not detectable — overlay absent where it should be**
`sites.js:100-102` vs `:105-110`, `content.js:3210-3222` · Photon · confirmed · **fixed v1.3.0** (/en/r/<mint> route detected)
Positions-bar chip navigates to `/en/r/<mint>` when no pairAddress; detect() only
matches `/lp/<pair>` → panel hides on the page the extension itself sent the user to.

**O-13 · S3 · Axiom fallback detection mislabels mints as `kind:'pair'`**
`sites.js:54-60`, `content.js:423-426` · Axiom · confirmed · **fixed v1.3.0** (/t/<mint> reported as kind mint)
`/t/<mint>` (Axiom's own tokenUrl) reported as pair → `paper-axis` gets
`pairAddress=<mint>, mint=null` → wrong identifier class for chart-symbol matching.

**O-14 · S3 · SPA navigation detection is 800 ms polling only — zero pushState/replaceState/popstate hooks in the extension**
`content.js:3538`, `DETECT_MS=800` :33 · all sites (all are SPAs) · confirmed · **fixed v1.3.0** (bridge pushState/replaceState hook + popstate/hashchange listeners re-detect in ~30 ms)
Up to 800 ms of previous token's live panel + native chart lines on the wrong page.

**O-15 · S3/S4 · applyBarOffset is a documented no-op; positions bar overlays host UI with 2-sample collision avoidance**
`content.js:3283,3061,3232,3545-3546` · confirmed · open
`measureBarLeft` samples `elementFromPoint` at 400 ms and 1500 ms only; late-painting
headers get the hardcoded 210 px fallback over their nav.

### S4 — movability & friction

**O-16 · S4 · Positions bar can be dragged somewhere it can never be dragged back from — and it persists**
`content.js:2401-2417` (clamp :2409), grip :2210,:2430 · confirmed · **fixed v1.3.0** (both-bounds clamp keeps the grip on-screen; the escape hatch is deleted)
Negative clamp `4 - rect.width` leaves only the bar's RIGHT edge visible but the drag
grip is the LEFTMOST child — at the bound the grip is fully off-screen. No reset
control; position persists across reloads. Bar permanently unreachable.

**O-17 · S4 · Panel drag has no right/bottom clamp; off-screen position persists; mount clamp is wrong**
`content.js:2364-2369,2379-2380,2270-2276` · confirmed · **fixed v1.3.0** (clampPanelPos during drag and at mount; whole panel stays on-screen)
Only lower bounds during drag. Mount-time rescue clamp `min(panelRight, innerWidth-40)`
puts the panel's right edge 40 px from the viewport's LEFT edge — still ~296 px
off-screen with a 40 px sliver grabbable.

**O-18 · S4 · Neither panel nor bar re-clamps on window resize — and positionBar re-asserts the off-screen coordinate**
`content.js:2270-2276` (mount only), `:3258-3268,3547` · confirmed · **fixed v1.3.0** (per-mount resize handler re-clamps; positionBar clamps saved coords)

**O-19 · S4 · `parseInt(x) || fallback` treats position 0 as "use default" — elements jump when re-dragged from an edge**
`content.js:2362,2379-2380,2397-2398` · confirmed · **fixed v1.3.0** (finitePx everywhere — 0 is a position, not a fallback trigger)
`right: 0px` parses to falsy → snaps 18 px inward; bar at `left: 0` persists as 210.
Needs Number.isFinite semantics.

**O-20 · S4 · Minimized pill ignores the panel's saved position and is not draggable**
`content.js:1924-1925,2548-2550` · confirmed · **fixed v1.3.0** (pill takes the live panel position, shown as flex, and is itself a drag handle)
Panel dragged bottom-left + minimize → pill teleports to hardcoded top-right.

**O-21 · S4 · The POSITIONS restore tab cannot be moved while collapsed**
`content.js:2221,2174-2176,2430,2066,3053-3058` · confirmed · **fixed v1.3.0** (collapsed tab drags through the shared bar spec)
Tab mirrors `--pt-bar-*` vars, only writable via the grip — which is `display:none`
while collapsed. Combined with O-16: stuck tab in a bad spot, unrecoverable.

**O-22 · S4 · Screener row chips sit BELOW the panel in z-order — occluded and unclickable where they overlap**
`content.css:16-21` (layer 2147482000) vs `content.js:1545` (panel 2147483647) · Axiom
Pulse, Padre Trenches, GMGN Trenches · confirmed · **fixed v1.3.0** (chip placement self-culls under the overlay via an elementFromPoint probe; returns when panel moves)
Chips anchor to row right edges — the same column band as the default panel position.

**O-23 · S4 · Chart-marker fallback strip hardcoded to `top:140px; right:360px`, not draggable, not persisted, pointer-events:none**
`chart-markers.js:245-259` · confirmed · open
Assumes default panel width/position; panel is resizable to 560 px and draggable
anywhere. (= C-25.)

**O-24 · S4 · content.css host-isolation rule is a dead selector — the page's CSS can break the whole overlay**
`content.css:6-8` (`papertrench-host { all:initial }` — type selector) vs
`content.js:2203-2204` (host is a `div` with that ID) · selector confirmed; downstream
site-dependent · **fixed v1.3.0** (#papertrench-host id selector; custom-property caveat documented)
Needs `#papertrench-host`. Outer-document rules beat shadow `:host` per CSS Scoping; a
host-page `body > div { transform: … }` re-parents our fixed-position children.

**O-25 · S4 · No touch/pointer support on either drag handle**
`content.js:2358,2364,2375,2393,2430-2432` · confirmed · **fixed v1.3.0** (pointer events + setPointerCapture everywhere; zero mouse listeners remain)
Both drags are mousedown-only (resize handle correctly uses pointer events — three
bespoke implementations, no shared helper).

**O-26 · S4 · Both drags leak a window mousemove+mouseup pair per mount**
`content.js:2364,2375,2431,2432` · confirmed · **fixed v1.3.0** (onMountCleanup registry; drag listeners die with the mount)
Not teardown-registered; accumulate per overlay off→on cycle, survive shutdown().

### S5 — polish

**O-27 · S5 · Minimized pill shown with `display:block` but styled as flex** —
`content.js:2550` vs :1926; dot/label lose centering. confirmed · **fixed v1.3.0** (pill shown as flex)
**O-28 · S5 · Toasts overlap the panel header and recycle after 4** —
`content.js:3477-3487`, CSS :1941-1942; toast top:74 vs panel top:84 same z; 5th toast
within ~4 s stacks on the 1st; toasts don't follow a dragged panel. confirmed · **fixed v1.3.0** (8 owned slots + bounded queue; stack follows the panel and clears the header)
**O-29 · S5 · Row-buy debounce fires one scan after teardown** — `content.js:2950-2958`.
confirmed · **fixed v1.3.0** (debounce cancelled in stopRowBuyObserver from both teardown paths)

### Movable-elements inventory (summary)

| Element | Draggable | Persisted | Clamped | Problem refs |
|---|---|---|---|---|
| Main panel | yes (mouse only) | yes | partial/wrong | O-17,O-18,O-19,O-25 |
| Resize grip | n/a | yes | yes | — (the one good one) |
| Minimized pill | NO | no | n/a | O-20 |
| Positions bar | yes (grip, mouse only) | yes | escapable | O-16,O-18,O-19,O-25 |
| POSITIONS tab | NO while collapsed | inherits bar | inherits | O-21 |
| Toasts | no | no | no | O-28 |
| Screener row chips | no | no | culled | O-22 (z-order) |
| Chart SVG overlay | n/a | no | tracks container | mutates host CSS (O-09/C-20) |
| Fallback strip | NO (pointer-events:none) | no | no | O-23 |
| Shadow host | n/a | n/a | n/a | O-24 (dead isolation rule) |

Shared drag code: NONE — three bespoke implementations, three clamp policies, two
event models. Phase 3's "one drag system" (ROADMAP) fixes O-16 through O-21, O-25,
O-26 as a unit.

### Per-site page-gating map — failing shapes (full audit in agent transcript)

| URL shape | Result | Ref |
|---|---|---|
| axiom.trade wallet/tracker routes with base58 tail | panel pinned open, pending forever | O-10 |
| trade.padre.gg wallet/portfolio/leaderboard | same | O-10,O-11 |
| gmgn.ai/sol/address/&lt;wallet&gt; | same | O-10 |
| gmgn.ai/eth/token/0x… & dexscreener EVM routes | ~13 % → bogus Solana resolve | O-11 |
| birdeye.so/profile/&lt;wallet&gt;, jup.ag/portfolio/&lt;wallet&gt; | pending forever | O-10 |
| photon /en/r/&lt;mint&gt; (own tokenUrl) | overlay absent where it should be | O-12 |
| ANY site with a base58 run in URL | panel mounts + chart scan mutates page CSS | O-09 |
| Any URL with ≥1 open position | positions bar shows (by design — revisit) | O-15 |

## C — Chart markers & lines (audit: 2026-08-05, verified against source)

Community report covered: "in certain situations the lines aren't where they need to be".

### S1 — line/marker at a wrong level

**C-01 · S1 · Average lines on mcap axes RIDE THE CANDLE instead of holding the entry level**
`price-bridge.js:946-949,957-993,1268,1853`, `content.js:1209-1215` · Axiom, Padre
(mcap mode) · confirmed · open
`mcapLevelFromClose(avg, current) = lastBarClose × (avg/current)`. `lastBarClose`
refreshes every bar/700 ms poll; `currentPrice*` lives in `paperLineSpec`, posted ONLY
on resolve/fill/settings/adopt — never on price change. The 1 s sweep re-asserts
`ratio × current close`: since the spec posts at fill time, ratio ≈ 1 and the avg-buy
line sits permanently on top of spot no matter how far the coin runs. Root cause:
`syncAveragePriceLines()` has no price- or axis-driven re-post (see also C-06).
Existing test pins the formula but sends the spec right after the bar — frozen-current
case untested.

**C-02 · S1 · SVG overlay Y positions come from PaperTrench's own invented price range, not the host chart's scale**
`chart-markers.js:270-297,402-420` · Photon, BullX, DexScreener, Birdeye, Jupiter,
generic · confirmed · open
Y axis fabricated from ≤300 observed ticks ±15 %, no plot-area inset, no host
autoscale. `frac` clamped [0.02, 0.98] → out-of-range levels silently GLUE to the
chart edge, still drawn with a precise label. The whole SVG route's placement is
coincidental.

**C-03 · S1 · Single marker / cold range → everything at exact vertical centre**
`chart-markers.js:274-279,293` · SVG sites · confirmed · open
First fill on a page → bubble at mid-height regardless of price; pre-tick range {0,0}
→ `priceToY` returns h/2 for everything.

**C-04 · S1 · Marker X positions are rank-in-array, not chart time**
`chart-markers.js:299-308` · SVG sites · confirmed · open
Two fills 4 s apart render at 5 % and 95 % of chart width; no pan/zoom hooks at all;
single marker hardcoded to `w - 30`.

**C-05 · S1 · First paint before any bar close picks the wrong UNIT entirely**
`price-bridge.js:914-936,:89` · Padre primarily (usd-first ordering), Axiom in price
mode · confirmed · open
`lastBarClose` is 0 at boot and reset on token change; until the first close,
`pickAxisEntry` returns the first usable candidate unchecked → avg line drawn at token
USD price (~0.002) on an axis in millions, exactly during chart boot when `paper-lines`
is posted.

**C-06 · S1 · Chart unit toggle (Price⇄MCap, USD⇄SOL) is never propagated — line stays in the old unit indefinitely**
`content.js:347-349,1213`, `price-bridge.js:1345-1359` · Axiom, Padre · confirmed ·
open
`chartAxisBasis` updates on validated bars but nothing re-posts `paper-lines`; the
stale basis is re-asserted every second until the next fill.

**C-07 · S1 · basis 'usd'/'native' hard-returns null — no average line on exactly the fresh-launch tokens**
`price-bridge.js:963-964`, `engine.js:846-849`, `content.js:1191-1196` · Padre, Axiom
· confirmed · open
`avgBuyUsd` null (any fill missing priceUsd + no rate) → return null, never falls
through to the known-good `avgBuyNative` sitting in the same spec.

**C-08 · S1 · GMGN lines/markers use resolver-implied supply, never bar-close corrected — the exact hazard mcapLevelFromClose exists to fix**
`content.js:1243-1258,301-316,858`, `price-bridge.js:1202-1214` vs :940-949 · GMGN ·
confirmed · open
Level = `avgUsd × (token.mcap / token.priceUsd)` (Dexscreener-implied supply). When
GMGN's cap definition differs from the anchor's (circulating vs total, migrated coins),
every GMGN line AND fill marker is off by that constant factor.

**C-09 · S1 · A fill with null priceUsd gets its mcap computed from the SOL price — ~150× low**
`content.js:302,307` · GMGN (marker Y level), SVG sites (labels), Padre/Axiom (mark
mcap field) · confirmed · open
SOL price silently substituted for USD then multiplied by USD-implied supply; on GMGN
the arrow lands ~150× below the candle. Trigger: fills before the SOL/USD rate warms —
the fresh-launch snipe path.

**C-10 · S1 · SVG render-skip guard compares COUNT of lines, not values — a changed average keeps the old level**
`chart-markers.js:323-332` · SVG sites · confirmed · open
Cross-tab fills change the average without changing local marker count → tab A's line
silently keeps the pre-fill level in a flat market.

### S2 — markers silently stop appearing

**C-11 · S2 · SVG overlay orphaned forever when the host replaces its chart node**
`chart-markers.js:312-318` (guard only checks falsy) vs :167-182 (unreachable reset) ·
SVG sites · confirmed · open
After TradingView reload/SPA re-render/resolution remount, both refs stay
truthy-but-detached; every render writes into a detached SVG; observer bound to the
removed node; markers gone until token change. Old observers leak.

**C-12 · S2 · GMGN fill shapes never redrawn after GMGN remounts its chart**
`price-bridge.js:1141-1200,1857-1862` · GMGN · confirmed · open
Lines have chart-change detection (:1209); shapes have none and the queue is empty
after first drain — timeframe change permanently erases all paper arrows.

**C-13 · S2 · drainGmgnMarkers splices the whole queue before drawing — failed draws lost permanently**
`price-bridge.js:1161-1172` · GMGN · confirmed · open
Mid-boot chart eats the entire batch (`splice(0)` + `continue` on falsy handle).

**C-14 · S2 · Marks snapped once to the creation-time grid, never re-snapped on resolution change; 'D' resolution parse bug**
`price-bridge.js:556-576,637,650,531` · Padre, Axiom · confirmed (TV drop behavior
standard) · open
1s-grid marks vanish on the 1m chart. `resolutionToMs('D')` → null → stale
`lastResolutionMs` used. Axiom's hidden preload widget's resolution can overwrite the
visible chart's. Daily snap UTC-floored vs exchange session.

**C-15 · S2 · Line sync fall-through tears a good line off the visible chart onto the hidden preload widget**
`price-bridge.js:1016-1025,810` · Axiom (two widgets), Padre boot · confirmed · open
Loop requires buyOk && sellOk from the SAME chart; sell-fail on chart A advances to
seriesless preload B, destroying A's working buy line. Runs every second → flicker or
invisible line.

**C-16 · S2 · GMGN drops a fill marker when mcap isn't known yet — no retry, no fallback**
`content.js:855-863`, `price-bridge.js:1186-1194` · GMGN · confirmed · open
`mcap: null` → refused → failure status discarded → payload never queued/replayed →
fill unmarked for the session.

### S3 — wrong presence

**C-17 · S3 · Nothing clears markers/lines on extension-context death — welded to the host chart, then duplicated**
`content.js:158-170` (no CM teardown), `price-bridge.js:21-22` (one-shot guard),
four unclearable intervals · all sites · confirmed · **fixed v1.3.0** (shutdown destroys markers; bridge standdown wipes marks/levels/specs and silences the sweep)
Extension reload: bridge keeps `paperMarks`/line specs and re-asserts a frozen level
every second forever; fresh content script injects a SECOND SVG overlay → duplicated
bubbles, one set frozen. (Companion of O-04/O-08.)

**C-18 · S3 · Disabling the overlay leaves every marker and line painted on the chart** — see O-03. confirmed · **fixed v1.3.0** (disableOverlay clears SVG and native drawings — see O-03)

**C-19 · S3 · Photon/BullX/DexScreener forced down the broken SVG path even though the bridge's TradingView discovery is site-agnostic and already running there**
`content.js:108-109` (`NATIVE_TV_SITES = {padre, axiom}`) vs `price-bridge.js:364-489`
· confirmed (routing); hypothesis (each widget passes looksLikeWidget) · open
These sites ship real TV widgets; the hardcoded two-element set routes them to
C-02/03/04/11 instead. Potentially the single highest-leverage marker fix.

**C-20 · S3 · GMGN mounts the SVG overlay it never uses — mutating the site's chart container + a continuous MutationObserver for nothing**
`content.js:543-549`, `chart-markers.js:124,202-204,214-223` · GMGN · confirmed · **fixed v1.3.0** (usesSvgMarkers predicate; GMGN never mounts the SVG overlay or mutates the host container)

**C-21 · S3 · initChartMarkers can leak the previous scan interval (bounded race)** —
`chart-markers.js:666-671` · confirmed · **fixed v1.3.0** (previous scan interval always retired first)
**C-22 · S3 · destroyChartMarkers doesn't reset the render-skip memo — first render after re-init can be skipped** — `chart-markers.js:697-708` · confirmed · **fixed v1.3.0** (destroy resets the render-skip memo; locked behaviorally)

### S4/S5

**C-23 · S4 · pollChartClose every 700 ms + 1 s widget sweep + 1 s chip sweep on EVERY tab on the internet** — see O-08/F-24. confirmed · open
**C-24 · S4 · Render/mutation feedback loop: observer watches the subtree renderMarkers writes into** — `chart-markers.js:214-223`; only the value-blind guard (C-10) breaks the cycle. confirmed · open
**C-25 · S4 · Fallback strip hardcoded position** — see O-23. confirmed · open
**C-26 · S4 · GMGN marker times not snapped to bar grid** (`price-bridge.js:1164` vs snapMarkTime) · confirmed · open
**C-27 · S5 · Label pill width = charcount × 6.2 — overflows onto the site's price scale** — `chart-markers.js:456-458` · confirmed · open
**C-28 · S5 · Tooltip width same charcount estimate on a proportional font + emoji** — `chart-markers.js:498,490` · confirmed · open

**Cross-cutting:** `syncAveragePriceLines()` is called only from resolve/adopt/
settings/buy/sell/reset (`content.js:471,1094,1133,1367,1412,2345`) — no price-driven
or axis-driven re-post; root cause of C-01/C-06. Test gap: `threesites.test.js` is all
source-regex; `chartmarkers.test.js` never instantiates a container — the SVG route's
placement math has ZERO positional coverage.

### Per-site marker matrix (as audited)

| Site | Fill markers | Avg lines | Unit plotted | Corrected by bar close? |
|---|---|---|---|---|
| Axiom | native TV getMarks (+shape fallback) | createOrderLine slots | axisBasis else mcap-first | yes but frozen-ratio (C-01) |
| Padre | native TV getMarks | createOrderLine slots | axisBasis else usd-first | yes but frozen-ratio (C-01, C-05) |
| GMGN | createExecutionShape at payload.mcap | createOrderLine at spec mcap | USD mcap always | NO — resolver supply (C-08) |
| Photon/BullX/DexScreener/Birdeye/Jupiter/generic | SVG bubbles | SVG dashed line | USD price pos, mcap label | fabricated range (C-02/03/04) |

---

## D — Dashboard, popup & cross-context state (audit: 2026-08-05, verified against source)

Community report covered: "things not properly displaying on the dashboards".

### S1 — displayed number is wrong

**D-01 · S1 · Equity curve sits above true equity by cumulative buy fees — two disagreeing numbers on one screen**
`dashboard.js:386-396` vs :268, `engine.js:215-216,243,299` · confirmed · **fixed v1.3.0** (E.equityCurvePoints debits buy fees; final point equals equitySol exactly, proven by test)
Curve accumulates journal `pnlSol` (cost basis net of buy fees) → curve = equity +
Σ buyFees, diverging monotonically from the `equitySol` KPI. 50 round trips of 1 SOL at
default fees ≈ 0.5 SOL gap.

**D-02 · S1 · "Realized P&L" omits partial exits; the calendar counts them — same trade, three different numbers**
`engine.js:408` (rounds-only) vs :713-721 (per-sell) · confirmed · **fixed v1.3.0** (realized P&L from the per-sell accumulator everywhere; calendar/sidebar/popup/leaderboard agree)
Sidebar/leaderboard/standings/popup use rounds-only; calendar/journal use per-sell.
Buy 1, sell 50 % at +2: sidebar +0, calendar +2.00, journal +2.

**D-03 · S1 · Leaderboard accuses the user of tampering after any partial exit**
`dashboard.js:1731-1746`, `attest.js:199-215` · confirmed · **fixed v1.3.0** (replayChain books net buy cost matching the engine recurrence; coherent mismatch wording)
`replayChain` credits realized on every sell link incl. partials; compared against
rounds-only stats (D-02) → red "Chain does not match local state" + the absurd line
"0 problems found · derived P&L differs by X SOL".

**D-04 · S1 · "AI review" click disables and relabels the ADD NOTE button instead**
`dashboard.js:781,734,670,672` · confirmed · **fixed v1.3.0** (review button has its own data-review-id; failure restores state)
Three buttons share `data-id`; `querySelector` grabs the first (Notes). Note button
becomes permanently disabled "Analyzing…"; the review button never changes state.

**D-05 · S1 · Replay button always reads "▶ 0 moments"**
`dashboard.js:671`, `replay.js:73` · confirmed · **fixed v1.3.0** (label is plain Replay — the moment count was fabricated)
`checkpoints` initialised `[]` and written NOWHERE in the codebase. Also zeroes that
term of `dataFingerprint`.

**D-06 · S1 · Editing "Starting paper balance" retroactively fabricates P&L**
`dashboard.js:2042,262,340-341`, `engine.js:419` · confirmed · open
Baseline changes without touching cashSol → fresh wallet + set 1 → "Total return
+9 SOL (+900 %)". Negative values accepted (`Number(v) || 10` ignores min attr).

**D-07 · S1 · Best/Worst tiles hardcode green/red and drop the sign**
`dashboard.js:342-343` · confirmed · **fixed v1.3.0** (tiles colored by sign; explicit +) — "Best round −0.20" in green; "Worst round
0.5" in red missing its +.

**D-08 · S1 · Open-position % and closed-round % use different denominators — the % jumps ~2×feeBps at close with no price move**
`dashboard.js:503` (net-of-fee cost) vs `engine.js:358` (gross invested) · confirmed ·
**fixed v1.3.0** (gross-invested basis for open AND closed %, netInvestedSol tracked through partials)

**D-09 · S1 · Share card entry/exit mcap understated when any fill lacks mcap**
`dashboard.js:1512-1519` · confirmed · open — null-mcap fills contribute qty to the
denominator, 0 to the numerator; the exact bug `weightedUsd` guards against elsewhere.

**D-10 · S1 · Quick-sell presets accept >100 % → a "500%" button that sells 100 %**
`dashboard.js:2039`, `content.js:3464-3471`, `engine.js:284` · confirmed · **fixed v1.3.0** (sell presets validated 1..100, deduped, capped 8)

**D-11 · S1 · Negative fee/slippage accepted — buys mint free SOL**
`dashboard.js:2043-2044`, `engine.js:214-215` · confirmed · **fixed v1.3.0** (feeBps 0..1000, slippageBps 0..2000, integers; coercions reported)
`feeBps: -100` → net > gross, feesPaidSol goes negative; `slippageBps: -100` sells
above the tick.

**D-12 · S1 · Replay hero and session list frozen at mount — closed rounds keep showing OPEN**
`dashboard.js:1149-1219,1112-1115` · confirmed · open

### S2 — silent death / lost writes

**D-13 · S2 · background.js writes pt_state WITHOUT bumping seq — both its writers lose data**
`background.js:96-103`, callers :180 (recording refs), :450 (aiReview);
`content.js:1297` adopts only on strictly-greater seq · confirmed · **fixed v1.2.18**
(setState advances seq; behavioral test in background.test.js)
Background write lands at equal seq → no tab adopts it → next 800 ms heartbeat
overwrites it. Why AI reviews vanish and the Recording column shows "—".
THE seq-protocol hole: all other writers bump (dashboard :166, popup reset :127 —
double-bumped with :2013 = D-51), background doesn't.

**D-14 · S2 · Backup restore writes the backup's seq verbatim — an open tab immediately resurrects the old wallet**
`popup.js:192-194` (vs resetWallet :125-127 which does it right) · confirmed ·
**fixed v1.2.18** (restored seq = max(live, backup)+1; locked in statepersist.test.js).
Shape validation (the `{pt_state:{}}` half) still open — tracked by D-16/D-24.
Also zero shape validation beyond `typeof === 'object'` → `{pt_state:{}}` accepted,
then detonates the dashboard (D-16).

**D-15 · S2 · A failed/empty storage read makes the dashboard fabricate a fresh wallet — and can PERSIST it over the real one**
`dashboard.js:36-39,137-141,161-169` · confirmed · **fixed v1.3.0** (store.get null on lastError; failed read banner; saves refused until a good read)
No lastError check (content.js and background.js both guard this; dashboard doesn't).
Missing pt_state → renders empty wallet → any note-save/AI-review write commits the
empty wallet at seq+1, destroying the real state.

**D-16 · S2 · init() unawaited and uncaught — any throw = permanently blank dashboard, no message**
`dashboard.js:44-65,2135`; reachable throws on legacy/restored state via sessionStats,
rounds.filter, drawEquityCurve, renderCoach · confirmed · **fixed v1.3.0** (init failures render a visible error card)

**D-17 · S2 · Session AI review answer is never persisted and is wiped seconds later by the refresh**
`dashboard.js:1923-1936,195-218,1772` · confirmed · **fixed v1.3.0** (session review persisted in module state and re-injected on render)
Answer written to live DOM only; staged-vs-live equality check then always fails →
replaceChildren discards it. With an open position the fingerprint churns ~1 s.

**D-18 · S2 · Leaderboard verification flickers back to "Checking…" ~1×/s, re-running SHA-256 over the whole chain each time**
`dashboard.js:1699-1752,212` · confirmed · **fixed v1.3.0** (chain verification memoized by chain fingerprint; cached verdict paints synchronously) — same mechanism as D-17; in-flight
verify can also land in a detached node → placeholder sticks forever.

**D-19 · S2 · Dashboard settings save clobbers every content-script settings write made while the tab was open**
`dashboard.js:2071-2078,110-118,139` · confirmed · **fixed v1.3.0** (save re-reads fresh settings and lays only form-controlled keys)
`isUserBusy()` is unconditionally true on the Settings tab → `settings` frozen at
dashboard-load time → Save writes `{...stale, ...form}`. Silently reverted: panel
position, bar position/hidden, overlay size, auto-hide — the user's dragged layout
snaps back. `pt_settings` has no seq/revision guard at all; every writer is a blind
whole-object overwrite.

**D-20 · S2 · Open round-note editor destroyed by refresh the moment focus leaves — typed text lost**
`dashboard.js:741-778,110-118,82` · confirmed · **fixed v1.3.0** (an open note editor marks the rounds section busy by DOM presence)

**D-21 · S2 · sendMessage rejections hang the AI UI forever**
`dashboard.js:792,1933` · confirmed · **fixed v1.3.0** (sendMessage rejections surface and restore button state) — unhandled rejection, no error UI; note
button stuck disabled "Analyzing…" (with D-04, the wrong button at that).

**D-22 · S2 · saveState() is read-modify-write, no CAS/retry — dashboard and tab at seq N both write N+1, loser vanishes**
`dashboard.js:161-169,767-777,796-804` (contrast content.js:1294-1307) · confirmed ·
**fixed v1.3.0** (mutateState: fresh read, mutation callback, seq re-check, bounded retry)

**D-23 · S2 · slippageBps ≥ 10000 makes every sell throw "No live price available"**
`engine.js:196,291`, no upper bound in UI · confirmed · **fixed v1.3.0** (slippage clamp makes the misleading error unreachable) — feed error shown for a
config problem.

**D-24 · S2 · Settings tab renders completely blank on non-array presetsBuy/sellPcts — and Save is never bound so the user can't repair it**
`dashboard.js:1948,1952`, `engine.js:133` (mergeSettings does no type validation) ·
confirmed · **fixed v1.3.0** (renderSettings guards non-array lists)

**D-25 · S2 · A settings-save failure is completely invisible**
`dashboard.js:2071-2078` · confirmed · **fixed v1.3.0** (save failures render in the save status element)

**D-26 · S2 · replayTimer leaks when replays go empty → TypeError loop every 1.1 s forever**
`dashboard.js:1084-1086,933-938` · confirmed · **fixed v1.3.0** (empty-replays branch stops playback and releases the shell; timer guards a vanished replay) — repro: start frame playback,
reset wallet from popup.

### S3 — stale rendering / wrong presence

**D-27 · S3 · dataFingerprint cannot see in-place round mutations (aiReview, note, recording, thesis)**
`dashboard.js:75-90` · confirmed · **fixed v1.3.0** (fingerprint carries per-round mutation markers) — with D-13, THE "reviews don't display" pair.

**D-28 · S3 · Table scroll position and hover reset ~once per second**
`dashboard.js:82,215`, `timeAgo` churn :638,:2101, storage listener :126-135 ·
confirmed · **fixed v1.3.0** (live marks out of the fingerprint; in-place text-node updater for P&L and timestamps) — fingerprint includes lastPriceNative; every 800 ms heartbeat
rebuilds the section, new scroll container at scrollTop 0. The "constantly refreshing"
complaint, unfixed (header comment blames the old timer).

**D-29 · S3 · "Test AI endpoint" silently commits the ENTIRE unsaved form — without the pt_settings_changed broadcast Save sends**
`dashboard.js:2020-2034` · confirmed · **fixed v1.3.0** (test button sends form values as overrides through the SSRF gate; zero storage writes)

**D-30 · S3 · Popup toggle label goes stale on the fallback path** — `popup.js:108-116` · confirmed · **fixed v1.3.0** (fallback path re-runs load())

**D-31 · S3 · Post-reset equity canvas drawn at fallback 760×260 while hidden, then never redrawn**
`dashboard.js:2018,379-380,212` · confirmed · open

**D-32 · S3 · Journal "Market cap" column mixes units — `$240.0K MC` and `0.0₅123 SOL` under one header; `— SOL` on non-positive**
`dashboard.js:2094-2099` · confirmed · **fixed v1.3.0** (mcap column renders mcap or an em-dash, never a mislabeled SOL price)

**D-33 · S3 · Calendar best/worst-day month label breaks in many locales ("202…")**
`dashboard.js:562-563` · confirmed · **fixed v1.3.0** (locale-safe month: short form)

**D-34 · S3 · ANY focused input freezes the entire dashboard refresh — including the replay scrubber which keeps focus after a drag**
`dashboard.js:110-118,1171` · confirmed · **fixed v1.3.0** (isUserBusy is per-section)

### S4 — friction

**D-35 · S4 · rpcUrl has no UI anywhere** — defined, consumed, documented; no input.
**fixed v1.3.0** — rpcUrl input in the AI/network settings card, saved with the form.
`engine.js:94`, `background.js:619` · confirmed · open
**D-36 · S4 · Reset claims to clear recordings but doesn't — RC.clear() exists and is called by nobody; orphaned videos accumulate forever**
**fixed v1.3.0** — dashboard reset calls RC.clear(); popup reset routes through a new pt_clear_recordings background message.
`dashboard.js:2005,2015`, `popup.js:128-132`, `recordings.js:151` · confirmed · open
**D-37 · S4 · Which settings apply live is undocumented and inconsistent** — live:
overlay/presets/lines/visibility/size/bar; needs-reload (silently): panelFocusMode,
sellPcts, listQuickBuy*. Only feedback is "Saved." `content.js:1126-1137` · confirmed
· open
**D-38 · S4 · Reset uses the saved starting balance, ignoring the value typed in the form**
`dashboard.js:2009` · confirmed · **fixed v1.3.0** (reset adopts a valid form balance and persists it in the same write)
**D-39 · S4 · loadRecordings reopens IndexedDB + holds all video blobs in memory on every 4 s poll; races revoke URLs bound to a mounted video**
`dashboard.js:150-154,882,885`, `recordings.js:119,132` · confirmed · open
**D-40 · S4 · Replay scrub rebuilds the entire replay model at 60 fps — twice per frame**
`dashboard.js:1004-1009,1020,1036` · confirmed · open
**D-41 · S4 · Backup omits IndexedDB recordings — restored wallets show unplayable recording refs**
`popup.js:150` · confirmed · open
**D-42 · S4 · Silent input coercions: balanceStartSol 0→10, empty preset lists→defaults, no count cap (500 presets = 500 overlay buttons)**
`dashboard.js:2042,2045,2051` · confirmed · **fixed v1.3.0** (validated with visible coercion notes; caps at 8 entries)
**D-43 · S4 · 4 s refresh interval never cleared; deserializes up to 80 base64 frames every tick for the tab's lifetime**
`dashboard.js:64` · confirmed · open (was HANDOFF should-fix #1)

### S5 — polish

**D-44 · S5** Share-card object URL never revoked on success; replacing cardMedia orphans the previous — `dashboard.js:1553-1561`.
**fixed v1.3.0** — previous object URL revoked when the card media is replaced.
**D-45 · S5** Drop target advertises GIF but renders only the first frame — `dashboard.html:650`.
**D-46 · S5** Dead code: renderMomentMedia, renderReplayTape, formatUnix, unused summary, empty else-if — `dashboard.js:1395,1450,2120,1759,1374`.
**D-47 · S5** "Saved." written into the AI-test output span and never cleared — `dashboard.js:2077`.
**D-48 · S5** Journal fee column shows entire gross as fee for legacy fills missing solNet; recorded feeSol unused — `dashboard.js:634`.
**fixed v1.3.0** — fee column prefers the recorded feeSol; em-dash when underivable.
**D-49 · S5** Coach prompts stamp UTC ISO; calendar buckets local days — day boundaries disagree — `dashboard.js:810`, `background.js:456`, `engine.js:704-708`.
**D-50 · S5** Frame data URLs interpolated unescaped into src — `dashboard.js:1361,1423,1798`.
**D-51 · S5** seq double-bumped on dashboard reset — `engine.js:932` + `dashboard.js:2013`.
**D-52 · S5** sessionStats counts break-even rounds as losses — `engine.js:407`.
**D-53 · S5** dashboard.js loaded before #card-modal — currently safe only by accident of async init — `dashboard.html:643-644`.
**fixed v1.3.0** — the modal now precedes the dashboard.js script tag for real.

### Seq-protocol answer (cross-context write safety)

Writers: content.js:1107 ✔ · dashboard.js:166 ✔ (but RMW, D-22) · dashboard reset ✔
(double, D-51) · popup reset ✔ · **background.js:96 ✘ (D-13)** · **popup restore ✘
(D-14)**. Adoption is strictly-greater (content.js:1297). No CAS anywhere.
`pt_settings` has NO versioning at all — every settings writer is a blind overwrite
(D-19, O-05 interaction).

---

## V — Visual polish

*(Phase 4 screenshot sweep pending. Already queued from code audits: O-27, O-28, C-27,
C-28, D-32, D-44–D-50.)*

---

## Register status

All four Phase 1 code audits complete (2026-08-05): **139 findings**
(F 29 · O 29 · C 28 · D 53), of which 26 are S1 (wrong numbers), 41 are S2 (silent
death / lost data). Phase 1 exit criterion additionally requires the live-site visual
sweep (Phase 4 prep) — code-side register is DONE.

Fixed so far: **47** — v1.2.18 closed O-01, O-02, F-04, F-15, D-13, D-14; the
v1.3.0 wave closed the fill-staleness ladder (F-01/13/20), per-mint price
integrity (F-02/03/05), feed survival (F-06/07/08/10/16/19, F-11 partial),
site gating + manifest narrowing + pump.fun (O-09..O-14, F-24), and dashboard
wave 1 (D-04/05/07/10/11/15/16/21/23/24/25/29/30/32/33/38/42/47/51/52).
