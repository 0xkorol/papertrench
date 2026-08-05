# Permissions audit

Everything PaperTrench requests, why, and what it deliberately does not do.
Kept current for Chrome Web Store review and for anyone auditing the source.

## Permissions

| Permission | Why |
|---|---|
| `storage` + `unlimitedStorage` | The paper wallet, settings, journal, replays, and (optional) capture frames live in `chrome.storage.local`, on your machine, only. Frames and screen recordings can exceed the default quota, hence `unlimitedStorage`. |
| `offscreen` | Optional screen recording uses an offscreen document for `getDisplayMedia` — MV3 service workers cannot record directly. Only created when you start a recording. |
| `tabs` | Two uses: capturing a snapshot frame of the trading tab (only the tab that traded, only when frames are enabled), and broadcasting settings/recording status to open trading tabs. |
| `activeTab` | Popup interactions with the current tab (overlay toggle). |

## Host permissions vs. content scripts

- **Content scripts are narrow.** They are injected ONLY into the supported
  trading sites (axiom.trade, padre.gg, tinyastro.io, gmgn.ai, bullx.io,
  dexscreener.com, birdeye.so, jup.ag, pump.fun). PaperTrench does not run on
  any other page. (Earlier alphas injected everywhere; fixed as DEFECTS.md
  O-09 and enforced by `scripts/preflight.sh` and a manifest test.)
- **`host_permissions` stays broad** because the background service worker
  must `fetch()` endpoints the *user* configures: an OpenAI-compatible AI
  endpoint (any host they choose) and an optional private Solana RPC. Those
  requests carry only what the feature needs (chat prompts / RPC calls),
  go only to the endpoint the user typed in, and are SSRF-guarded
  (localhost/private ranges require an explicit opt-in; cloud metadata IPs
  are always blocked).

## What PaperTrench never does

- **No telemetry, no analytics, no phoning home.** There is no server. The
  only network calls are: public price APIs (Dexscreener, Jupiter), public
  Solana RPC, and endpoints you configured yourself.
- **No real trading.** It cannot sign, send, or ask for a transaction. It has
  no wallet integration at all — that is the point.
- **No credentials.** Your AI API key, if you add one, is stored locally and
  sent only to the endpoint you configured (a settings migration clears keys
  left orphaned by an empty endpoint — see CHANGELOG v1.2.17).
- **No form filling, no page mutation beyond its own overlay containers.**
