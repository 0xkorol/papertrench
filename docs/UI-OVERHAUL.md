# UI Overhaul — the v2.12 "it got clean" campaign

Mandate (maintainer, 2026-08-05): "Everything needs to be redesigned and
reimagined to be cleaner, less bloated, less random stuff everywhere, less
weirdness with the way that you move it around." Built from two full
line-verified audits (overlay + dashboard/popup) taken at b635fc3. Line refs
drift; anchors are quoted so they re-find.

## North star

Three personas, three products, one binary:
- **Speed** — Turbo links, warm viewers, X-Ray. Never sees a paper panel.
- **Paper** — the trainer. Never sees gaming, never sees speed furniture.
- **Paper + Gaming** — the trainer with the loop turned on.

Modes are the product's spine: nav, popup, settings, and on-page surfaces
all derive from them. A mode that is off does not exist (the Gaming Mode
rule, generalized).

## The four waves

### Wave 1 — the clean-up (quick wins, both audits)

Landed: overlay 1–9 (one honesty cue; focus CSS bugs; touch-action + grab
cursors + 5px threshold; honest cost chips; one feed-health element;
restore/resize re-clamp with measure-or-don't-move; composite close toast;
no pre-selected preset; mint copies; trench flag gaming-only; footer reset
gone — two-tap ⟲ everywhere) · dashboard 13–14, 16–21 (bug pair; dead
replay CSS; warm terminal links in Settings; Total-return tile dropped;
receipts heading demoted; ranking prose behind details; X-Ray paragraph;
one slider spec). Landed too: dashboard 15 — the de-jargon renames ("Buying", "Guardrails",
"Loss-streak cooldown", "One-tap buy buttons on token lists", "AI server
address", plain fee/tip/slippage labels) with their pinned tests updated in
the same commit. Note: fee/slippage inputs stay in bps this wave — the
%-unit input conversion touches validation + the popup quick-fill and rides
Wave 3's settings regroup. Open: overlay 12 (radii/color tokenize) and
dashboard 22 (stack rule) — both fold into Wave 2's token pass.

Overlay (content.js):
1. PAPER stated once per surface: keep the banner; delete the watermark div
   and the buy button "(PAPER)" suffix; bar brand only when the panel is
   absent. (Honesty is a safety property — one clear cue beats seven faded
   ones. The PnL card watermark is untouched, that doctrine is separate.)
2. Fix dead/buggy focus CSS: `.pt-buy-btn`→`.pt-buy` (live bug — the
   non-instant focus BUY never slimmed), dead `.pt-body` duplicate, dead
   `.pt-focus .pt-costs` margin, `.pt-custom input`, merge the two
   reduced-motion blocks.
3. `touch-action: none` on every drag handle (the real O-25 completion);
   `cursor: grab` + `user-select:none` on pill and bar-tab; moved threshold
   5px.
4. Costs strip: render only non-zero costs; the full set lives in the ✎.
5. One feed-health element: dot beside the price, detail in its tooltip;
   delete the footer MARKS/LINES diagnostics line.
6. Re-clamp position on panel restore and resize-end (off-screen panel
   bugs F-D3/F-D4).
7. Toast diet: one composite close toast (sold + round + grade in one line
   when gaming); cap visible toasts.
8. No pre-selected preset in instant mode (selected ≠ tap-to-order).
9. Mint pill: click-to-copy or gone.
10. FLEX_FLAGS filtered by gamingOn() (dead checkbox for non-gamers).
11. Footer "Reset wallet" link removed (two-tap ⟲ is the reset everywhere).
12. Tokenize stray radii/colors onto existing --pt-* vars.

Dashboard/popup (dashboard.js/html, popup):
13. ~~"DEFECT D-35" leak in user copy~~ (landed), ~~broken --line2 token~~
    (landed).
14. Delete 10 dead replay-CSS selector families (~50 lines).
15. Renames table (docs: audit §2) — "Quick-buy (QB)"→"Buying", bps→%,
    de-jargon every label. Contract tests that pin headings update with it.
16. warmEverywhereEnabled joins the Settings form (popup-only today).
17. Overview: drop the "Total return" tile (sidebar hero owns it); Trench
    Rank card shrinks to a one-line strip linking to Game.
18. Turbo receipts: one h3 per card, relocated under the Speed group.
19. Leaderboard "How ranking is kept honest" prose behind <details>.
20. X-Ray "Honest limits" pseudo-field becomes a paragraph.
21. One slider spec (two conflicting input[type=range] blocks today).
22. .stack spacing rule replaces 14 inline margin-top:16px.

### Wave 2 — the panel re-ranked + one movement system

Landed (2A): the hierarchy inversion — position card directly under the
token row, live P&L at 21px wearing the crown, balance card + sparkline
deleted in every mode, cash on the Buy label always, live dot beside the
price, labels de-narrated. Open (2B): the movement system (unified
controller, per-site position memory + migration, reset gesture, whole-bar
grab surface, HUD docked to the bar), the full type/spacing token pass, and
receipt-style thesis/closed collapse.

Panel hierarchy (the audit's F-H findings): the eye should hit money, not
brand. In-position: P&L hero (balance-hero size) + sell row pinned directly
under the token strip; buy secondary; thesis and closed-P&L collapse to
one-line receipts that expand. Stateless: a single token+price strip. The
current focus-mode density becomes the DEFAULT; "decorated" becomes the
opt-in. Type collapses to a 4-step scale + 3 weights; spacing to a 4/8/12
grid; one surface recipe.

Movement (dragSpec, audit verbatim): one controller for panel/pill/bar/
tab/HUD; resize folds into it; whole-chrome grab surfaces with uniform
cursors; unified four-edge clamp applied on drag, resize, AND restore;
position memory PER SITE with auto-measure provenance and a one-gesture
reset (double-click the grip); the game HUD docks to the bar instead of a
fifth hardcoded anchor; one documented z-ladder, toasts never under the
flex modal.

### Wave 3 — dashboard IA 9 → 5, settings regrouped

- **Home** (sidebar + curve + open positions + recent rounds + compact rank
  strip when gaming) · **History** (Rounds/Fills/Calendar as views; rounds
  table → 8 columns + row-expand drawer holding thesis/note/review/share/
  replay/recording; Replay embeds in the drawer) · **Insights** (coach +
  discipline/graduation/thesis/The-After panels; AI is one card, not the
  section's name) · **Game** (gaming only; absorbs Leaderboard until a
  server exists; verified-record panel → Settings→Data) · **Settings**.
- Settings persona-grouped: Modes card first (Paper / Gaming / Speed
  master switches), then Paper (Buying / Fees / Guardrails / On-page /
  Feedback sub-groups), Speed (links, X-Ray, receipts), Shared (AI & data,
  backup/restore + verified record). Nav derives from modes via
  applyModeNav generalized.

### Wave 4 — popup as the mode switchboard + first run

Popup rebuilt per persona: equity line + three Mode switches + Dashboard
button + status; paper adds the two live numbers; speed shows the three
speed toggles + receipts line; gaming adds a rank/drill line. Its parallel
DEFAULTS/validation copies die in favor of the dashboard deep-link. First
run: a one-time persona choice (Speed / Paper / Paper+Games) that sets the
mode bundle — persona stops being toggle archaeology.

## Rules of engagement

- Every wave ships preflight-green with contract locks updated in the same
  commit; renames update their pinned tests deliberately, never silently.
- Numbers and honesty surfaces are untouchable: banner stays, card
  watermark stays, no mechanic reinterprets a number (GAMIFY.md doctrine).
- The two audits are the source of truth for findings; this doc is the
  source of truth for sequencing. Landed items get struck through.
