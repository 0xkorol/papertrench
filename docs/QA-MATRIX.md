# Release QA matrix

Run before every release that touches `content.js`, `price-bridge.js`, `sites.js`,
or `chart-markers.js`. One row per site; every cell must pass or the failure gets a
DEFECTS.md entry before shipping. Copy this table into the release PR/notes and
check it off.

**Setup:** load the built zip unpacked (`chrome://extensions` → Load unpacked),
fresh profile preferred. Have one coin with an open paper position before starting.

| Check | Axiom | Padre | Photon | GMGN | BullX | DexScr | Birdeye | Jupiter | Pump.fun | Lute |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Panel mounts on a token page | | | | | | | | | |
| Panel does NOT mount on home/screener | | | | | | | | | |
| Panel does NOT mount on wallet/portfolio routes | | | | | | | | | |
| Live price ticks and tracks the site's own number | | | | | | | | | |
| Live dot honest (green when ticking, warn when stale) | | | | | | | | | |
| Buy fills with toast; sell % fills once per tap | | | | | | | | | |
| Refusal toast (not silence) when no fresh price | | | | | | | | | |
| Fill markers land on the chart at the right level | | | | | | | | | |
| Average line holds the ENTRY level as price moves | | | | | | | | | |
| Positions bar shows the open position; chip navigates | | | | | | | | | |
| Panel/bar drag + persist + stay reachable | | | | | | | | | |
| SPA navigation between two tokens swaps the panel correctly | | | | | | | | | |
| Disable overlay removes panel AND chart drawings | | | | | | | | | |
| Re-enable restores everything incl. sell buttons | | | | | | | | | |

**Cross-site checks (once per release):**
- [ ] GMGN Trenches / Axiom Pulse: row quick-buy chip fills on first tap after >5 s idle; chip never sticks busy.
- [ ] High-volume coin (top trending): price keeps ticking through volume spikes; no silent freeze.
- [ ] Fast token flipping (10 coins in a minute): prices stay correct per coin, no cross-token bleed, RPC status recovers.
- [ ] Dashboard: numbers agree with panel (equity, realized P&L incl. partial exits); tables hold scroll position; AI review/note buttons behave.
- [ ] Popup: backup → reset → restore round-trips the wallet, and an open trading tab does NOT resurrect the old wallet.
- [ ] Extension reload with a position open: old overlay disappears cleanly, no duplicate markers, fresh one works.
- [ ] chrome://extensions shows no errors after the full pass.
