# PaperTrench — patch notes

Stream-style log of what shipped, newest first. User-facing wording; the gory
details live in the commit messages.

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
