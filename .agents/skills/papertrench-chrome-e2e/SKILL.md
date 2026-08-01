---
name: PaperTrench Chrome E2E Testing
description: How to load and end-to-end test the PaperTrench Manifest V3 Chrome extension on Windows
---

# PaperTrench Chrome E2E Testing

## Chrome binary
- Path: `C:\devin\chrome\chrome-win64\chrome.exe`

## Launch flags
```powershell
$chrome = 'C:\devin\chrome\chrome-win64\chrome.exe'
$ext = 'C:\Users\Administrator\repos\papertrench\extension'
$profile = 'C:\Users\Administrator\AppData\Local\Temp\ptchrome-profiles\test'
$args = @(
  '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu',
  '--hide-crash-restore-bubble','--no-first-run','--disable-sync',
  '--remote-allow-origins=*','--remote-debugging-port=9222',
  '--load-extension='+"$ext",
  '--user-data-dir='+$profile,
  '--window-size=1400,1050','--start-maximized'
)
Start-Process -FilePath $chrome -ArgumentList $args -WindowStyle Normal
```

## Avoid the "Restore pages?" bubble
Before launching, patch the profile so Chrome thinks it exited cleanly:
```powershell
$profileDir = 'C:\Users\Administrator\AppData\Local\Temp\ptchrome-profiles\test'
$localState = Join-Path $profileDir 'Local State'
$prefs = Join-Path $profileDir 'Default\Preferences'
if (Test-Path $localState) {
  $s = Get-Content $localState -Raw
  $s = $s -replace '"exited_cleanly"\s*:\s*false', '"exited_cleanly":true'
  Set-Content $localState $s -NoNewline
}
if (Test-Path $prefs) {
  $s = Get-Content $prefs -Raw
  $s = $s -replace '"exited_cleanly"\s*:\s*false', '"exited_cleanly":true'
  $s = $s -replace '"exit_type"\s*:\s*"[^"]*"', '"exit_type":"Normal"'
  Set-Content $prefs $s -NoNewline
}
```

## CDP helper
- List targets: `curl.exe -s http://127.0.0.1:9222/json`
- Open a new tab by URL: `curl.exe -s -X PUT 'http://127.0.0.1:9222/json/new?https://dexscreener.com/solana/<mint>'`
- The extension appears as a `service_worker` target with `chrome-extension://<id>/background.js`.

## Navigation workaround
Typing `chrome://` or `file://` URLs in the omnibox can be routed to Google search. Use a local redirect file or CDP `/json/new` instead.

## Token page to test
- Dexscreener: `https://dexscreener.com/solana/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263`
- Birdeye: `https://birdeye.so/token/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263?chain=solana`
- GMGN: `https://gmgn.ai/sol/token/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263`
- Jupiter path URLs (`jup.ag/swap/SOL-<mint>`) may redirect to a `buy=...&sell=...` query form; the adapter now filters WSOL/USDC/USDT so it picks the requested output token instead of a stablecoin.

## Overlay selectors (Shadow DOM host: `#papertrench-host`)
- `#pt-token-name` — token name
- `#pt-price` — native price
- `#pt-balance` — paper balance
- `#pt-buy-presets .pt-preset` — quick-buy amounts
- `#pt-buy` — primary buy button
- `#pt-position` — position card (includes `.pt-sell-row` sell buttons)
- `#pt-bar` — positions bar rail
- `#pt-dash` — open dashboard

## Driving the overlay from CDP
Create a `node` script using `ws` (`npm install ws` in a temp dir) and connect to the page target's `webSocketDebuggerUrl` to run `Runtime.evaluate` expressions such as:
```js
document.getElementById('papertrench-host').shadowRoot.getElementById('pt-buy').click()
```

## Common gotchas
- Dexscreener/Birdeye/GMGN may show Cloudflare or login walls; the service worker still resolves the token via Dexscreener API because the overlay uses background price resolution, not the page DOM.
- The overlay is taller than the default 1024x768 capture area; drag the `#pt-drag` header up or maximize the browser to reveal buy/sell buttons.
- Dashboard `Rounds` and `Leaderboard` are the most fragile sections; check for `replay.checkpoints` and attestation-chain fee mismatches.
