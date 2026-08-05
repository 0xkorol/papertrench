# Gamification — making discipline the addictive loop

Approved direction (maintainer, 2026-08-05): full pass. This document is the
spec `extension/gamify.js` implements; the UI pass wires it into the
dashboard, overlay, close toast, and PnL card.

## Doctrine

1. **Discipline is the loop. Never volume, never luck.** Every reward maps to
   a behavior that predicts real-world survival (the mastery criteria). A red
   round can grade A. A lucky win can grade F. There are deliberately NO
   rewards for profit size, win streaks, or trade count — those train the
   exact habits this product exists to break.
2. **Honest numbers are untouchable.** Gamification renders on top of the
   same journal every other surface reads. No mechanic may alter, delay,
   select, or reinterpret a number. The PAPER watermark doctrine applies to
   every shareable artifact.
3. **The game ends on purpose.** The rank ladder's summit is the graduation
   bar (docs/GRADUATION.md). The win state is being told, with evidence, that
   a small careful real start is rational — i.e., leaving. An engagement loop
   with a designed exit is the whole ethical difference.
4. **Derived, not stored.** v1 computes everything as pure functions over the
   existing journal/rounds — zero new persisted state, zero migrations,
   nothing for a cheater to edit that the attestation chain doesn't already
   cover. (Rounds are capped at 500 in storage; every mechanic is windowed or
   monotonic within that horizon by design.)

## Components (implemented in gamify.js)

### Round grades — the instant-feedback loop
`roundGrade(state, round)` → `{ score, letter, parts, luckyWin }`. Start at
100, subtract for process failures, letter by band (S≥92, A≥80, B≥68, C≥55,
D≥40, else F):

| Signal | Delta | Source |
|---|---|---|
| No written thesis | −30 **and grade caps at C** | round.thesis |
| Plan broken (target reached but exited under it; stop held through) | −25 | engine.gradeThesis |
| Exit round-tripped (green → closed red) | −30 | engine.exitQuality |
| Exit early (green but <50% of peak captured) | −12 | engine.exitQuality |
| Exit good (50–80% captured) | −5 | engine.exitQuality |
| Revenge entry (same mint ≤10 min after a red close, ≥1.5× size) | −35 | journal |
| Outsized (>2× trailing mean invested, ≥5 priors) | −12 | rounds |

A `luckyWin` flag rides any green round that broke its plan — the grade says
so out loud ("Green round, F process — that habit pays until it doesn't").

### Discipline streaks — the daily hook
`streaks(state)` → current/best for: **journal** (consecutive closed rounds
with a thesis), **clean exit** (no round-trips), **no-revenge**. Streaks
break honestly and the break message teaches the why.

### Trench Rank — the progression spine
`rank(state)` → tier + named rank + progress to the next gate. Gates are the
graduation criteria, staged so there is always a visible next step:

| Tier | Name | Gate |
|---|---|---|
| 0 | Fresh Meat | — |
| 1 | Journaler | 10+ closed rounds, thesis coverage ≥60% |
| 2 | Survivor | 25+ closed, avg loss < avg win |
| 3 | Operator | 35+ closed, no revenge in window, hold symmetry ≤3× |
| 4 | Veteran | 50+ closed, survived a real cold streak without sizing up |
| 5 | Graduated | the full graduation bar (docs/GRADUATION.md) |

### Reps — grind that cannot be gamed
`reps(state)` → level + today's counted reps. One closed, graded round = one
rep, weighted by grade (S 1.5 → F 0.25). Daily diminishing returns: full
credit for 10, half to 20, zero past 20 — "tired reps don't count" is itself
a lesson in session discipline. Level = floor(√(points/3)).

### Badges — the collection
`badges(state)` → earned/unearned with dates where derivable. First thesis,
10-round journal streak, cold-blooded (disciplined losing streak), 50 club,
sniper exit (≥80% captured; ×10 for the set), 25 rounds clean of revenge,
plan-master (10 consecutive plan-respecting rounds). **Exclusions are
doctrine:** no profit badges, no win-streak badges, no volume badges.

### Daily drills — practice with intent
`drills(state, now)` → today's drill + progress. Deterministic rotation by
local date: capture day (3 rounds ≥50% captured), journal day (every round
carries a thesis, min 3), flat-size day (max ≤1.25× today's mean, min 3),
stop-respect day (no stop breached, min 2). All measurable from the journal
as it exists.

## UI pass (next)

- **Dashboard:** a Trench Rank card (tier, progress bars, streaks, level) on
  the overview; grades stamped in the rounds table and calendar; badge case.
- **Overlay:** grade stamp on the round-close toast; streak flame chips on
  the positions bar (small, honest, no confetti over red numbers).
- **PnL card:** badge strip + rank name, inside the existing PAPER watermark
  frame; attestation chain carries the same derived values so a shared card
  is verifiable like everything else.
- **Coach:** grades and broken-streak reasons feed the per-round critique.
