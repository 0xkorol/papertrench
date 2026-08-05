# PaperTrench — Complete Handoff for Next Agent

**Use this as workspace:** `/home/terp/papertrench-release`  
**Windows runtime mirror (WSL path):** `/mnt/c/PaperTrench`  
**Native Windows path:** `C:\PaperTrench`  
**Test command:** `cd /home/terp/papertrench-release/extension && node --test`  
**Node version:** `/home/terp/.local/bin/node` v24.15.0  
**GitHub repo:** `https://github.com/OnlyTerp/papertrench`  
**Current shipped release:** `v1.2.16`  
**Current working tree status:** Two additional in-progress hardening changes were made that are **NOT fully verified** — see “⚠️ Unfinished State” below.

---

## 1. What PaperTrench Is

PaperTrench is a Chrome MV3 extension that overlays a **paper-trading terminal** on top of Solana memecoin sites (Axiom, Padre, Photon, GMGN, BullX, Pump.fun, DexScreener). It gives users:

- Live SOL/USD prices scraped from the site’s own WebSocket / DOM / onchain feeds.
- Paper buy/sell with preset amounts and a custom amount.
- Position card with unrealized P&L and quick-sell % buttons.
- Dashboard with wallet state, settings, replay, AI coach, and recording management.
- Positions bar (top rail) for open trades.
- Session replay + screen recording.
- Chart markers/order lines on Padre/Axiom TradingView.
- Focus mode (Axiom-style minimal UI).
- Backup/restore.

The architecture splits the logic across three layers:

1. **`engine.js`** — pure functions over a serializable `state` object. No DOM, no Chrome APIs. Used by content script, dashboard, popup, and tests.
2. **`content.js`** — the overlay: shadow DOM, drag/resize, buy/sell UI, settings listener, positions bar, and all real-time rendering.
3. **`background.js`** — service worker: frame capture, replay persistence, AI proxy, offscreen recording, cross-tab messaging.
4. Site-specific adapters + bridge: `price-bridge.js`, `sites.js`, `title-feed.js`, `onchain.js`, `onchain-feed.js`.

---

## 2. File Map — `extension/`

Core logic:
- `engine.js` — wallet state, buy/sell math, settings migration, thesis normalization, P&L.
- `content.js` — overlay UI, shadow DOM, position card, buy controls, positions bar, drag/resize, settings sync.
- `dashboard.js` — options page / dashboard: settings, wallet, journal, replay, AI coach.
- `popup.js` — extension toolbar popup: wallet summary, backup/restore, overlay toggle.
- `background.js` — service worker: frame capture, replays, AI proxy, recording orchestration.
- `quote.js` — price quoting, freshness, position mark P&L.
- `price-bridge.js` — WebSocket / XHR / message interception per site; feeds live prices to content script.
- `sites.js` — site detection and token address extraction per platform.
- `resolver.js` — token metadata resolution.
- `onchain.js` / `onchain-feed.js` — Solana RPC pool and live on-chain price feeds.
- `chart-markers.js` — Padre/Axiom TradingView markers and average-price lines.
- `recordings.js` — IndexedDB screen recordings.
- `replay.js` — replay/session bookkeeping.
- `rpc-pool.js` — public/private Solana RPC rotation and health.
- `title-feed.js` — price signal from page title changes.
- `offscreen.js` — offscreen document for `getDisplayMedia` recordings.
- `content.css` — shadow DOM styles.
- `manifest.json` — MV3 manifest.
- `package.json` — version + scripts.
- HTML pages: `dashboard.html`, `popup.html`, `offscreen.html`.
- Icons: `icons/icon16.png`, `icon48.png`, `icon128.png`.

Tests: `extension/test/*.js` (30 test files; key ones below).
- `engine.test.js` — buy/sell/rounding/P&L.
- `statepersist.test.js` — wallet state durability, panel position, focus mode, sell button cache.
- `quickbuy.test.js` — quick-buy settings + row chips.
- `nativecharts.test.js` — price-bridge / WebSocket handling, including GMGN high-volume.
- `background.test.js` — service worker / AI proxy / frame capture.
- `onchain.test.js` — RPC pool + onchain feed.
- `livepnl.test.js`, `formatting.test.js`, `integration.test.js`, etc.

Site/marketing:
- `site/index.html` — landing page with download links.
- `CHANGELOG.md` — public patch notes.
- `.hermes/workflows/papertrench-harden.yaml` — incomplete workflow I started building for proactive hardening.
- `.hermes/workflow-runs/audit-v1/` — contains `audit-results.json` and `ranked-findings.json` from the partial audit.

---

## 3. Recent Shipped Patches (newest first)

### v1.2.16 — sell buttons no longer disappear
- **Report:** saannta: “still having issues with that sell button disappearing on 1.2.13”
- **Root cause:** `disableOverlay()` and `shutdown()` destroyed the shadow DOM but left the `posEls` cache (position-card node references) pointing at detached nodes. On re-enable, `renderPosition()` saw a truthy `posEls` and skipped `buildPositionCard`, so the new card was created without sell buttons.
- **Fix:** Null `posEls` and `lastRenderedPrice` in `disableOverlay()` and `shutdown()`; defense-in-depth null at top of `buildPositionCard`.
- **Tests:** `statepersist.test.js` source-contract regression test; verified to fail pre-fix, pass post-fix.
- **Files:** `content.js`, `statepersist.test.js`, `manifest.json`, `package.json`, `CHANGELOG.md`, `site/index.html`.

### v1.2.15 — Axiom-style Focus mode
- **Report:** levv6x: “make the trading tab like axiom and other platforms for more optimised and less distracted trades”
- **Feature:** opt-in `panelFocusMode` toggle in Dashboard → Settings → Overlay. Strips banner, watermark, sparkline, thesis card, last-close card, and footer; leaves token, price, balance, buy/sell controls.
- **Files:** `engine.js`, `content.js`, `dashboard.js`, `statepersist.test.js`.

### v1.2.14 — GMGN high volume no longer kills live feed
- **Report:** high-volume failure on GMGN (`composer_2026-08-05_06-11-36-200_23b374.png`)
- **Root causes:**
  1. `forwardJson()` dropped any frame over 500KB. GMGN `token_activity` batches exceed that during volume spikes, silently killing the live feed.
  2. Batches carry many mints; the watched mint could be crowded out of the 4-tick budget.
- **Fix:** Route `token_activity` frames around the size guard before generic parse; emit the watched mint first.
- **Tests:** `nativecharts.test.js` has 3 regression tests (oversized activity frame still feeds, non-activity oversized still dropped, watched mint emitted first).
- **Files:** `price-bridge.js`, `nativecharts.test.js`.

### v1.2.13 — panel position persists across refreshes and tabs
- **Report:** levv6x wanted overlay panel to remember dragged position.
- **Fix:** Save `panelRight`/`panelTop` on drop, restore on `createUI()`, clamp to viewport.
- **Tests:** `statepersist.test.js`.

### v1.2.12 — honest avg fills + Quick-buy settings card
- **Reports:** levv6x: “avg fills on new update is not accurate” and “can't find toggle for QB”
- **Fixes:**
  1. `averageFillPrices()` weighted USD average excluded fills with `priceUsd: null`. Fallback now uses current SOL rate to include all fills.
  2. Reorganized Quick-buy (QB) controls into a dedicated settings card.
- **Tests:** `engine.test.js`, `quickbuy.test.js`.

### v1.2.11 — cp-vaults crash killed live-price stream (issue #17)
- **Root cause:** CP-vaults route crash stopped the live price feed, making sell options disappear.
- **Fix:** Isolated the crash path so live-price stream survives.

### v1.2.10 — community bug report fixes
- Fixed reset resurrection race, swallowed fill errors, un-sequenced dashboard writes.

---

## 4. ⚠️ Unfinished State

Two in-progress hardening changes were made but **not fully tested or shipped**:

### `engine.js` — Settings migration revision 7
- Bumped `SETTINGS_REVISION` from `6` → `7`.
- Added migration to clear orphaned `aiApiKey` / `aiModel` when the stored `aiEndpoint` is empty or the old insecure default (`http://127.0.0.1:8765/v1`) **and** `aiAllowLocalEndpoint` is `false`.
- This prevents stale private keys from being sent to whatever endpoint a user pastes in later.

### `background.js` — `chrome.runtime.lastError` handling
- Wrapped `getSettings`, `getState`, `setState`, `getReplays`, `setReplays` with `chrome.runtime.lastError` checks.
- Failed reads now resolve to safe defaults and warn; failed writes warn instead of silently doing nothing.

### Test status when stopped
- Before hardening changes: **432/432 tests passed**.
- After hardening changes: **431/432 passed, 1 failed** (the failing test was not identified before the tool budget ran out).
- **Next agent must:** run `node --test`, identify the failing test, and fix the regression before shipping anything.

---

## 5. Known Issues / Next-Agent Shortlist

From the partial audit at `.hermes/workflow-runs/audit-v1/ranked-findings.json`:

**Must fix:**
1. `background.js` storage reads/writes ignoring `lastError` — **already patched but not fully tested.**
2. Engine migration for orphaned AI credentials — **already patched but not fully tested.**
3. Frame capture writes frames to `chrome.storage` every 1s with no quota handling. Consider downsizing, compressing, or moving frames to IndexedDB like recordings.

**Should fix:**
1. `dashboard.js:64` — `setInterval(refreshIfChanged, 4000)` is never cleared; leaks on dashboard close.
2. `price-bridge.js` — multiple `setInterval` timers not always cleared on context restart (row chip sweep, chart close poll).
3. `content.js:576` — `priceTimer` uses raw `setInterval` instead of `managedInterval`.

**Polish:**
1. Thesis textarea has no character counter (max 600 chars).
2. Dashboard quick-sell presets input is a single text field with weak validation.
3. `popup.js` object URLs for backup downloads not revoked on error paths.

---

## 6. How to Build / Ship

1. **Test:** `cd /home/terp/papertrench-release/extension && node --test`
2. **Bump version:** `extension/manifest.json` and `extension/package.json`
3. **Update `CHANGELOG.md`** with a new top entry.
4. **Update `site/index.html`** download links to the new version zip.
5. **Build zip** (run from `extension/`):
   ```bash
   zip -q -X /tmp/papertrench-X.Y.Z.zip attest.js background.js chart-markers.js content.css content.js dashboard.html dashboard.js engine.js manifest.json offscreen.html offscreen.js onchain-feed.js onchain.js pnlcard.js popup.html popup.js price-bridge.js quote.js recordings.js replay.js resolver.js rpc-pool.js sites.js title-feed.js icons/icon16.png icons/icon48.png icons/icon128.png
   ```
6. **Git:** commit with two commits (fix, then release bump), tag, push:
   ```bash
   git add -A && git commit -m "fix: ..."
   git add -A && git commit -m "release: vX.Y.Z — ..."
   git tag vX.Y.Z
   git push origin main --tags
   ```
7. **Release:** `gh release create vX.Y.Z /tmp/papertrench-X.Y.Z.zip --title "vX.Y.Z — ..." --notes "..."`
8. **Verify download hash** matches local `sha256sum`.
9. **Sync Windows mirror:** `cp /home/terp/papertrench-release/extension/{content.js,engine.js,dashboard.js,price-bridge.js,manifest.json,package.json} /mnt/c/PaperTrench/`

---

## 7. Claude Code Workspace

Point Claude Code at:

```text
/home/terp/papertrench-release
```

That is the repo root. It contains the full extension source, tests, site, and release metadata. WSL path `/mnt/c/PaperTrench` is the Windows live mirror used for unpacked extension testing — it should be kept synchronized with the files above when a release ships.

---

## 8. Key Files to Read First

For any new agent taking over:

1. `extension/manifest.json` — permissions, content scripts, version.
2. `extension/engine.js` — core state/transaction logic and settings migrations.
3. `extension/content.js` — overlay lifecycle; search for `buildPositionCard`, `renderPosition`, `applyFocusMode`, `disableOverlay`, `shutdown`.
4. `extension/price-bridge.js` — `forwardJson`, `forwardTokenActivity`, `token_activity` fast path.
5. `extension/test/statepersist.test.js` — how the test harness boots the overlay.
6. `CHANGELOG.md` — public-facing release history.
7. `.hermes/workflow-runs/audit-v1/ranked-findings.json` — partial hardening backlog.

---

## 9. Last Thing

The two unshipped hardening patches (`engine.js` migration rev 7, `background.js` lastError handling) were made in good faith but broke 1 of 432 tests. **The next agent must re-run the suite, find the failing test, and resolve it before doing anything else.** Do not ship on a red test.
