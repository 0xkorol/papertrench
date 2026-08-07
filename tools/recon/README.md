# pt-recon

Capture a real browsing session in full, distill it into a read-first,
evidence-cited **site dossier**. Step 0 of adding a site — turns "sample the
live page and guess" into "read the dossier and cite it".

Full spec, honesty rules, and the trust boundary: **[../../docs/RECON.md](../../docs/RECON.md)**.

```
# 1. Capture (headed — most terminals challenge headless). Browse the script.
node tools/recon/ptrecon.js capture  --site gmgn --url https://gmgn.ai --headed
#    …or let the rig drive a public site:
node tools/recon/ptrecon.js capture  --site dexscreener --headed \
  --auto "https://dexscreener.com/solana,https://dexscreener.com/base"

node tools/recon/ptrecon.js distill  --site gmgn   # → dossier/DOSSIER.md (§0 = coverage)
node tools/recon/ptrecon.js scaffold --site gmgn   # → draft gating test + fake stub
node tools/recon/ptrecon.js check    --site gmgn   # your real detect() vs the captured pages
node tools/recon/ptrecon.js list
```

`distill` writes `DOSSIER.md` (read whole) + machine sidecars. `scaffold` and
`check` close the loop: scaffold drafts the locks from captured facts; check
runs the shipped `sites.js` over every URL the site served and flags a token
page you refuse or a wallet page you mount — before the live pass.

- **Zero dependencies.** Node ≥ 22 (global `WebSocket`), any Chrome/Chromium.
- **Raw captures never leave the machine** — `recon-data/` is gitignored; the
  distiller scrubs secrets at the trust boundary before anything reaches a
  dossier or fixture. Put your wallet addresses / usernames in
  `recon-data/DENYLIST.local` (one per line) so they are redacted too.
- **Silence is loud.** The dossier's §11 OPEN QUESTIONS names every place the
  capture was thin; answer each before shipping.

Tests: `node --test tools/recon/test/recon.test.js`
