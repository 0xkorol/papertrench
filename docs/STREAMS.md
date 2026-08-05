# Streams page & the PaperTrench Challenge — operator runbook

The live page is `site/streams.html` + `site/streams.js`. Everything an operator
touches lives in the CONFIG block at the top of `streams.js`:

| Constant | What it does |
| --- | --- |
| `STREAMERS` | Hand-maintained roster. Always shown; wins over a sheet row with the same login. |
| `SIGNUP_URL` | Where "Sign up as a streamer" points. Currently a prefilled GitHub issue; swap for the Google Form link. |
| `ROSTER_CSV_URL` | Published-CSV URL of the approval sheet. Empty = disabled. |

## Signup + approval pipeline (Google Form → Sheet → site)

One-time setup, ~5 minutes:

1. **Create a Google Form** (forms.google.com) with these questions:
   - *Twitch channel* — short answer, required. (Any format works: URL, @name, or bare handle — the site normalizes it.)
   - *Display name* — short answer, required.
   - *About you (shown on the site, one line)* — short answer.
   - *When do you stream?* — short answer (for your planning; not shown on the site).
   - Anything else you want to ask (contact handle, etc.) — extra columns are ignored by the site.
2. In the form's **Responses** tab → **Link to Sheets**. This creates the response spreadsheet.
3. In that sheet, **add a column headed `Approved`** to the right of the response columns.
4. **File → Share → Publish to web** → pick the response tab (not "Entire document") → format **CSV** → Publish. Copy the URL.
5. Paste into `streams.js`:
   - the form's share link → `SIGNUP_URL`
   - the published CSV URL → `ROSTER_CSV_URL`
   Deploy the site once. Done — from here on, no deploys are needed to manage the roster.

### Day-to-day approval

Open the response sheet. Each signup is a row. Type `yes` in its **Approved**
cell and the streamer appears on papertrench.com within ~5 minutes (Google's
republish interval). Clear the cell to unlist them. Accepted approval values:
`yes`, `y`, `true`, `1`, `x`, `approved`, `✓` (any case). Blank or anything
else = not shown.

Rules the site applies to sheet rows:

- Twitch handles are normalized (`https://twitch.tv/Name?x=1` → `name`); rows
  whose handle can't be normalized to a valid Twitch login are skipped.
- Duplicate logins are deduped; `STREAMERS` entries win over sheet rows.
- If the sheet is unreachable or malformed, the page silently falls back to
  `STREAMERS` (a `console.warn` is the only trace). The sheet can never break
  the page.

> After first publishing the sheet, load the streams page once with DevTools
> open: if you see `PaperTrench: roster sheet unavailable`, the publish step
> isn't right (usually "Entire document" was selected instead of the tab, or
> the format isn't CSV).

## How the page decides who's "LIVE"

No Twitch API key: the page checks Twitch's public preview CDN. A live
channel's `live_user_<login>` thumbnail resolves; an offline one redirects to
the `404_preview` image. Checked every 60 s. If Twitch ever changes this, the
page degrades to showing no badges — never wrong ones. The featured player
auto-promotes the first live streamer unless the viewer clicked a specific one
(or arrived via `streams.html?channel=<login>`).

## Stream overlay (what streamers use)

Ships in the extension (`extension/overlay.html`): extension popup or
dashboard → **🎥 Stream overlay** → chromeless window on a chroma-key
background with live equity, session P&L, win rate, positions, and a
realized-P&L sparkline. OBS: *Sources → Window Capture → pick the window →
Filters → Chroma Key*. Card and lower-third bar layouts; green, magenta, or
dark backgrounds. The PAPER badge, watermark, and footer are intentionally
not removable — same honesty rule as the P&L cards.

## Challenge / leaderboard status

What the streams page promises today is deliberately limited to what exists:
verified *records* (the extension's SHA-256 attest chain, see
`docs/LEADERBOARD.md`) and manually-run giveaways. Public automated standings
still need, in order:

1. A submission path for chain exports (the extension's backup already
   contains the full attest chain).
2. A verifier that replays chains and re-checks fills against market history
   (protocol in `docs/LEADERBOARD.md`).
3. A small standings service or a committed JSON the site renders.

Until then, a season can run manually: approved streamers submit their chain
export at season close, chains are verified offline, winners announced on
stream. Keep prize copy on the page vague-but-true (it currently says prizes
are "announced on the streams").
