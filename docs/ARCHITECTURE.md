# Architecture

PaperTrench is a Chrome MV3 extension. The guiding constraint is that a wrong
number is worse than no number, so the design pushes all decision logic into
pure functions that can be tested without a browser, and keeps I/O at the edges.

## Where the price comes from

Accuracy matters more than anything else here: a wrong price silently corrupts
every fill, every P&L, and every statistic downstream. Two sources are combined.

**1. Anchor (source of truth).** When the token changes, `resolver.js` queries
Dexscreener *and* Jupiter in parallel and takes whichever resolves. Dexscreener
gives the venue price for established tokens; Jupiter covers brand-new launches,
which Dexscreener does not index until it has observed a pool. Where several
pools exist the deepest-liquidity one wins, since shallow pools quote badly.

**2. Live refinement.** `price-bridge.js` runs in the page's MAIN world at
`document_start` — before the site opens its own sockets — and forwards price
candidates from the site's own feed. On Padre it wraps the decoded TradingView
`subscribeBars()` callback, so each chart bar updates P&L in the same event
task with no polling timer on the hot path.

`quote.js` accepts a candidate only if it agrees with the anchor in magnitude.
A candidate off by more than ~20x is rejected and the trusted price is kept.
This is what stops a stray number elsewhere on the page from becoming a fill
price.

USD-only and market-cap chart updates are converted proportionally into the SOL
token price, so P&L moves even when the chart is not displaying native SOL.

## Modules

| File | Role | Pure? |
|---|---|---|
| `sites.js` | Per-site adapters: URL → token identity, and token → URL | yes |
| `quote.js` | Pair selection, tick validation, P&L math, position rows | yes |
| `engine.js` | Portfolio: positions, fees, rounds, thesis, exit grading | yes |
| `attest.js` | Tamper-evident fill chain and independent replay | yes |
| `replay.js` | Session replay record model | yes |
| `resolver.js` | Network wrapper around the price APIs | no |
| `recordings.js` | IndexedDB store for screen recordings | no |
| `price-bridge.js` | MAIN-world hook into the site's price feed | no |
| `content.js` | Shadow-DOM overlay and trading actions | no |
| `background.js` | Service worker: AI proxy, recorder, frames, replays | no |
| `dashboard.js` | Journal, rounds, replay, leaderboard, coach, settings | no |
| `xray-core.js` | X-Ray: payload extractors, CA detection, ledger reducers | yes |
| `xray-main.js` | MAIN-world hook into X's own GraphQL responses | no |
| `xray-panel.js` | The X-Ray card on x.com profile and post pages | no |

## X-Ray: what it may claim

X-Ray reads the X app's own responses and keeps a local ledger about the
accounts you look at. The design constraint is that two of its four headline
facts *cannot* be known retroactively without someone else's surveillance
database, and the product refuses to imply otherwise:

- **Computable from real data:** contract addresses the account has posted
  (from its public posts, with the posts' own dates) and its notable
  followers (from follower lists, ranked by follower count).
- **Observation-only:** bio, display-name and @handle history. The ledger
  records the first value it ever sees and every change after that, so the
  view model carries `firstSeenAt` and the card prints "watching since
  <date>" beside every counter. "No change seen" over two days and over two
  months are different statements, and the card always says which one it is
  making.

The split runs through the module boundary: `xray-core.js` decides
(`assembleIntel` returns the labels), `xray-panel.js` only formats. The
observation window can therefore never be dropped by a UI refactor without a
test failing.

## Rendering discipline

Two rules keep the UI from fighting the user:

**Never blank before rebuilding.** Dashboard sections are built into a detached
element and swapped in one `replaceChildren` call. If the new markup is
identical to what is on screen, nothing is touched. Blanking first lets the
browser paint an empty frame, which reads as a flash.

**Never re-render on a timer.** Updates are driven by `chrome.storage.onChanged`
plus a fingerprint comparison, and are suspended entirely while the user is
typing, watching a recording, or in Settings.

The overlay follows the same idea: the position card is built once and only its
numbers are updated in place, because rebuilding it twice a second would rip
the sell buttons out from under the cursor.

## Extension lifetime

Reloading the extension kills the content script's context while the injected
copy keeps running. Every `chrome.*` call from that orphan then throws. The
content script detects this via `chrome.runtime.id`, stops all timers, detaches
listeners, and removes its own UI — one quiet console line instead of an error
on every heartbeat.

## Storage

| Key | Contents |
|---|---|
| `pt_state` | Wallet, positions, journal, rounds, attestation chain |
| `pt_settings` | User preferences |
| `pt_frames` | Captured chart frames (capped) |
| `pt_replays` | Session replay records |
| IndexedDB `papertrench` | Screen recordings (blobs, capped at 12) |

Recordings live in IndexedDB because a five-minute capture is ~50 MB — far past
what `chrome.storage` can hold, and base64 would inflate it by a third.
