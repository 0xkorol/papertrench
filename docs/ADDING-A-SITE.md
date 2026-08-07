# Adding a site

The executable spec used to be "read the fomo arc" (`06eba49` and its six
follow-ups) — this file is that arc distilled, updated by the lute landing
(`83d1005` + `222a1ea`). One principle governs everything below: **the recon
comes first.** Every hostname, route, and payload shape is captured from the
live, logged-in site on a dated day. Where the capture is silent, the code
refuses — by name — instead of guessing.

## Step 0: run the recon (`tools/recon`, see docs/RECON.md)

Before touching any file below, capture the live site and distill a **dossier** —
a greppable, evidence-cited spec whose sections map 1:1 onto the touch list. It
turns "sample the live page and hope" into "read the dossier and cite it".

```
node tools/recon/ptrecon.js capture  --site <id> --url https://<site> --headed
#   …browse the script it prints (token page + sit ~30s, holders tab, a refuse
#     route, a second chain), then close the window…
node tools/recon/ptrecon.js distill  --site <id>   # → dossier/DOSSIER.md
node tools/recon/ptrecon.js scaffold --site <id>   # → draft gating test + fake
#   …write the ~10 touch-list edits below against the dossier…
node tools/recon/ptrecon.js check    --site <id>   # your detect() vs the real corpus
```

Read `DOSSIER.md` whole, starting at **§0 Coverage**: if it is 🔴 THIN (no
token page, no live price, one chain) the capture cannot land a site — browse
more and re-capture first. If §0 shows **CAPTURE VOID** (a bot challenge, not
the app), the dossier is worthless; re-run headed.

**§11 OPEN QUESTIONS** is generated, not curated: each item is a place the
capture was thin or ambiguous (no WS seen, a one-example route, a price node
with no market origin, a presence-only capability, a coverage gap). **Answer
every one before shipping** — by capture, by an explicit refusal in code, or by
an open QA-MATRIX note — never by assumption.

After you write the adapter, **`check`** runs your real `detect()` over every
page the site actually served and flags a token page you refuse or a wallet
page you mount — the O-10/O-13 class — before the live pass. It reports; the
`sitegating` locks still decide. The dossier and scaffold feed the locks; they
do not replace the mutation-proof discipline below, and the live pass still
governs.

## The touch list (there is no central registry)

| Where | What |
|---|---|
| `extension/sites.js` | The adapter: `id`, `name`, anchored `match()`, `detect()` → `{kind, address, chain}` or exactly `null`, 3-arg `tokenUrl()`. Comment every route that must never mount (O-10). Chain-aware sites route through `tokenForSlug()` with an explicit slug map that fails closed. |
| `extension/manifest.json` | The new origin in all three lists: MAIN-world `content_scripts`, ISOLATED-world `content_scripts`, `web_accessible_resources`. Perps-only hosts join the separate perps entry instead. |
| `extension/background.js` | `WARM_PLATFORM_URLS` + a `WARM_DEST_FAMILIES` entry (`idleUrl: null` — terminals are never pre-warmed). |
| `extension/warmdest.js` | Host RegExp, a `classify()` branch (https only, path + query byte-for-byte, unknown shapes return `null`), a `familyOfHost()` line. |
| `extension/xray-core.js` | The host joins `CA_HOST_RE` so X links to it count as CA carriers. |
| `extension/title-feed.js` | A `TITLE_PATTERNS` entry ONLY if the captured tab title does not fit the default `$`-keyed pattern. |
| `extension/price-bridge.js` | Extend the **generic** guards (`POSITION_SUBTREE_KEY`, `looksLikePositionRecord`, …) with the site's captured key spellings. Never a site-named branch — `threesites.test.js` locks the source against those. |
| `docs/PERMISSIONS.md` | The host with its justification (`permissionsdoc.test.js` fails the build otherwise). |
| `README.md`, `site/index.html` | Supported-sites prose, meta description, marquee chip, `data-check="sites"` counter. `scripts/preflight.sh` recomputes the counters and fails the release on over-claim — never hand-type a number it can compute. |
| `docs/QA-MATRIX.md` | A new column. It stays empty until the live pass — that is the point. |

## The locks (every one proven able to fail)

- `sitescontract.test.js` — a `PAGES` row with a real captured token URL.
- `sitegating.test.js` — `MATRIX` rows for pages that must mount AND pages
  that must refuse, straight from the captured URL corpus.
- `warmdest.test.js` — classify family + byte-for-byte query passthrough +
  www canonicalization + refusals, and the `familyOfHost` line.
- A per-site test file (`<site>.test.js`) holding the strict fake and the
  pollution locks in the **pair-form**: the polluted shape never becomes a
  price candidate, AND a genuine market snapshot still ticks (the guard must
  not over-reach). Lock each guard clause in isolation, so removing one reds
  its own test instead of hiding behind a sibling.
- A **bounds lock** on any length-gated route regex: one char under and one
  char over must refuse, the minimum must mount. A gate without a bounds
  lock survives being widened — that mutation was claimed red once and
  wasn't (see `222a1ea`).

Presence greps (`source.includes('key')`) are not locks. A grep proves
spelling; only a payload driven through the shipped walker proves the guard.

**Prove it can fail, in the current tree:** mutate the exact line each new
lock guards, watch it go red, restore, watch it go green. Paste the
transcript in the landing report. A claimed mutation proof that was never
run reads exactly like a real one — until someone re-runs it.

## The doctrine

- **Capabilities are discovered, not declared** (F-39). The bridge probes
  the chart; the fake implements only what was captured — a fake method the
  site lacks is how a suite stays green while the site draws nothing.
- **Every price-shaped field is someone's HISTORY until the capture proves
  it market data.** Social feeds, holder rows, top-trader tables, entry
  prices, balances, PnL — none of it may tick the live price.
- **A chain you cannot name is never priced on Solana.** Shape-check per
  chain, before the tradability gate, so a refusal is a chain-named decline
  and not a lucky parse failure (O-11).
- **The live pass is part of the landing.** Tests prove the contract; only
  the real site proves the recon (ROADMAP: "verified against the live sites
  in-browser, not just in tests"). Login-gated sites need a logged-in
  session — say so in the report rather than skipping silently, and leave
  the QA-MATRIX column open until it is run.
