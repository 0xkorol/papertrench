# PaperTrench — patch notes

Stream-style log of what shipped, newest first. User-facing wording; the gory
details live in the commit messages.

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
