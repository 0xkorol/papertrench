/* PaperTrench — news hub: the release archive.
 *
 * Every shipped version, newest first. This array is the ONLY thing that has
 * to change when a release goes out: add an entry at the top and the timeline,
 * the filters and the counts all follow.
 *
 * Rules for entries, so the archive stays worth trusting:
 *   - `v` and `date` must match the CHANGELOG.md heading exactly.
 *   - `points` are user-facing outcomes, not commit summaries.
 *   - No number appears here that isn't in the changelog. A patch-notes page
 *     that inflates its own numbers is the same failure as a terminal that
 *     inflates a fill price.
 *
 * tags: 'feature' | 'fix' | 'security' | 'speed'  (a release can carry several)
 */
(() => {
  'use strict';

  const RELEASES = [
    {
      v: '2.9.0', date: 'Aug 5, 2026', iso: '2026-08-05',
      tags: ['feature'],
      title: 'The quick fixes live on the trading tab',
      blurb: 'Lev round two — the quick fixes now live where he meant them.',
      article: 'news-quickedit.html',
      points: [
        '<b>A pencil on the trading panel.</b> The ✎ in the panel header opens a compact inline editor right on the trading tab — buy presets, sell percents, and fee/gas/tip/slippage — with the same validation rulebook the dashboard and popup use. Your costs ride as Fee/Gas/Tip/Slip chips under the buy row, click-to-edit, in both modes.',
        '<b>Focus mode is genuinely Axiom-compact now.</b> No balance card (cash rides inline on the Buy label, refreshed per fill), and while one-tap presets are on the big BUY button gets out of the way — the preset chips ARE the buttons, and Enter in the amount box buys. Instant-buy off keeps the button.',
      ],
    },
    {
      v: '2.8.1', date: 'Aug 5, 2026', iso: '2026-08-05',
      tags: ['fix', 'security'],
      title: 'The attestation chain lands whole',
      blurb: 'Update from v2.8.0 — it matters this time.',
      article: 'news-chain.html',
      points: [
        '<b>v2.8.0 shipped with attestation-chain recording broken.</b> That release accidentally carried half of an in-flight migration: fills asked for the new segmented chain store, which was not aboard, so every paper fill made on v2.8.0 failed to append to your local attestation chain. The honest "could not be added to the verification chain" toast fired each time — the failure was visible, the chain simply could not record.',
        '<b>Your wallet, balances and P&amp;L were never affected.</b> The chain is the tamper-evidence layer used by leaderboard verification. On v2.8.1 the chain records again; fills made during the v2.8.0 window are simply absent from it, and the verify panel shows that gap honestly rather than pretending it is not there.',
        '<b>The attestation chain grew up (F-14).</b> It moved out of the wallet state into a single-writer segmented store: a fill rewrites one small tail segment instead of the whole history, multi-tab chain races are gone, and no hash is ever truncated. Backups are downgrade-safe, resets clear the chain atomically with the wallet, and the leaderboard verifier format is unchanged.',
        '<b>For the record: v2.8.0 also contained the Turbo receipts card</b> — the Settings card counting warm vs cold opens, median routing latency and per-site main-thread stalls, measured locally and never sent anywhere. Its release notes did not mention it.',
      ],
    },
    {
      v: '2.8.0', date: 'Aug 5, 2026', iso: '2026-08-05',
      superseded: 'Superseded by v2.8.1 — do not trade on this build',
      tags: ['feature', 'fix'],
      title: 'Fresh launches are snipeable, and the rug guard',
      blurb: 'Two from the maintainer\'s own trench session, same screenshot. Note: this build shipped with attestation-chain recording broken — use v2.8.1 or later.',
      article: 'news-rugguard.html',
      points: [
        '<b>"ARMED … ON FIRST QUOTE" actually fires now (F-34).</b> A 39-second-old pump.fun coin used to strand the armed buy forever: no aggregator had indexed it, and with the chart in MCap mode every close was refused as "no implied supply".',
        '<b>The bonding curve is read directly.</b> The moment a pending coin looks like pump.fun, PaperTrench finds its bonding curve on chain (derived from the mint, verified against five live mainnet curves), identifies the real mint from the curve\'s reserve account, and streams the curve as a live CHAIN ⚡ feed with an immediate first quote. The fill is chain state, not a guess.',
        '<b>MCap-mode charts can price pump coins.</b> Pump supply is a protocol constant, so an mcap-scale close IS a price. All four readings of an unlabelled chart value are judged against sane bands and the tick is used only when exactly one fits — ambiguity still refuses.',
        '<b>Rug guard (on by default).</b> When chain state says the float is in a handful of wallets, a paper BUY is refused with a toast that names the number — "🚩 RUG WARNING — top 10 wallets hold 47% of supply". It never blocks a SELL, and a failed chain read blocks nothing: a guard that cannot see is not allowed to invent.',
      ],
    },
    {
      v: '2.7.1', date: 'Aug 5, 2026', iso: '2026-08-05',
      tags: ['fix'],
      title: 'The complete v2.7.0 batch',
      blurb: 'Housekeeping with a straight face: v2.7.0 was tagged and published mid-batch, before the last five commits landed.',
      points: [
        '<b>If you downloaded 2.7.0, update.</b> That build is missing the Instant terminal links, the dashboard refresh fix ("stopped re-reading everything every 4 seconds"), and an X-Ray dock fix — all described in the v2.7.0 notes below.',
        'v2.7.1 is the complete batch; nothing else changed.',
      ],
    },
    {
      v: '2.7.0', date: 'Aug 5, 2026', iso: '2026-08-05',
      tags: ['fix', 'feature', 'speed'],
      title: 'Community batch #2, Terminal Turbo, X-Ray dock, the floating Flex composer',
      blurb: 'The biggest batch so far: the fill-accuracy bug that could book you instant fake profit, then a whole pass on making every terminal feel fast.',
      articles: [
        { href: 'news-fills.html', label: 'The fill-accuracy story' },
        { href: 'news-turbo.html', label: 'Terminal Turbo, in full' },
      ],
      points: [
        '<b>Fills land on the chart you are looking at — the "instant +14%" is dead.</b> On migrated (AMM) tokens the on-chain feed could lose one side of every trade it watched, filling paper trades up to ~13% away from the live chart. The stale-frame guard is now per-vault, and every fill is reconciled against the price on your screen (F-33).',
        '<b>Instant terminal links (opt-in).</b> Axiom, Padre and GMGN token links clicked on another terminal open in that terminal\'s kept-warm viewer, and a positions-bar hop to another terminal no longer replaces the tab you are on.',
        '<b>Instant pump.fun &amp; Solscan links (opt-in).</b> The Instant X viewer idea, generalized — up to two muted background viewer tabs, already warm when you get there, with hover prefetch. Ctrl/click bypasses.',
        '<b>Turbo receipts.</b> The popup counts your warm vs cold opens and shows the median routing time — measured on your machine, stored locally, never sent anywhere.',
        '<b>PaperTrench off costs the page nothing.</b> When no consumer exists for price frames, the bridge drops them before the body copy and the JSON parse — zero parsing donated to the host site.',
        '<b>Chips stopped fighting the page for layout.</b> Chip positioning runs in read/write phases with diffed style writes, so screener chips no longer thrash layout at volume peaks.',
        '<b>The dashboard stopped re-reading everything every 4 seconds.</b> It refreshes the instant your data changes, naps while hidden, and leaves the recordings database alone unless a new replay landed.',
        '<b>Flex without leaving the terminal.</b> The Flex button opens the share composer as a floating window over the page — the SAME composer, with card math now in one shared derivation so a card can never show different numbers depending on where you opened it.',
        '<b>Close the hot X tab, it comes back</b>, and <b>your own X tab IS the warm tab now</b> — PaperTrench adopts the x.com tab you already keep open instead of opening a second one.',
        '<b>Quick settings in the popup.</b> Starting balance, quick-buy presets, quick-sell presets and a fees profile, editable without opening the dashboard.',
        '<b>The positions bar respects late headers,</b> measuring the site header until it settles so slow-painting headers no longer end up underneath it.',
      ],
    },
    {
      v: '2.6.0', date: 'Aug 5, 2026', iso: '2026-08-05',
      tags: ['feature'],
      title: 'X-Ray — instant account intel on X',
      blurb: 'Open any X profile or post and the intel is already on screen: bio and handle changes, every contract address the account has posted, and who big follows them.',
      article: 'news-xray.html',
      points: [
        '<b>Contract addresses posted.</b> Every CA the account has put out, dated by the post itself, newest first, click to copy — with a flag if one is sitting in the bio right now.',
        '<b>Bio, name and @handle changes,</b> counted separately, because a display-name swap and a rename are different tells.',
        '<b>Smart Following.</b> The biggest accounts following this one, ranked by follower count, with the ones you follow marked.',
        '<b>Every counter carries its watch window</b> — "no change seen · watching since Aug 5" — because nobody can tell you a bio changed on a day they never saw the bio.',
        'Suite: 749/749, including tests pinning that a first sighting can never be reported as a change and that a forged page-world digest cannot write a fake CA into the ledger.',
      ],
    },
    {
      v: '2.5.2', date: 'Aug 5, 2026', iso: '2026-08-05',
      tags: ['fix', 'feature'],
      title: 'Resize un-stick, four corners, Flex on the closed card',
      blurb: 'Three fixes straight from the maintainer taking a live trade.',
      article: 'news-flex.html',
      points: [
        '<b>The resize grip can never stick again.</b> A cancelled gesture used to leave the drag latched, so the panel kept resizing with every mouse move. Pointer capture now guarantees a terminal event.',
        '<b>Resize from any corner.</b> All four corners are grips, anchored so the panel grows in the direction you drag.',
        '<b>Flex it — wins AND losses.</b> The Closed P&L card in the overlay gained a Flex button for that exact result.',
        '<b>The Closed P&L card stopped blinking.</b> It was being rebuilt on every heartbeat and re-running its entry animation each time.',
      ],
    },
    {
      v: '2.5.1', date: 'Aug 5, 2026', iso: '2026-08-05',
      tags: ['feature'],
      title: 'Share an open position — the still-holding flex',
      blurb: 'The real terminals card an OPEN position and ours only carded closed rounds.',
      article: 'news-flex.html',
      points: [
        '<b>Live open positions on the Overview carry a Share button.</b> The card states OPEN, the middle column reads POSITION at the last recorded mark, and the journey line claims no EXIT that has not happened.',
        'USD figures appear only where fills and marks genuinely recorded them — same gallery, same Customize / Download / Copy, same un-removable branding.',
      ],
    },
    {
      v: '2.5.0', date: 'Aug 5, 2026', iso: '2026-08-05',
      tags: ['feature', 'speed'],
      title: 'The Flex Pack share card',
      blurb: 'Flex your PaperTrench P&L — with the one thing that can never come off the card.',
      article: 'news-flex.html',
      points: [
        '<b>Terminal-grade share composer:</b> a huge ◎ SOL P&L, Invested / Returned / P&L% columns with honest USD sub-lines, the entry→exit→held journey line, and an observed-only After line no other terminal can print.',
        '<b>Backgrounds, yours.</b> Five built-in looks plus your own uploads — max 2 MB each, ten stored, saved between sessions.',
        '<b>The PAPER watermark and brand bar are drawn last by a code path that reads no settings</b> — verified by a test that drives every combination of options.',
        '<b>Instant X links now speak GMGN and Axiom.</b> GMGN community links and Axiom CA searches used to fall through to a cold tab; both warm-route now.',
        '<b>Hover preview cards (opt-in).</b> Hover an X link and the post renders on the page in ~200ms. A deleted post says "unavailable" — the rug signal before you spend a click.',
      ],
    },
    {
      v: '2.4.0', date: 'Aug 5, 2026', iso: '2026-08-05',
      tags: ['feature', 'speed'],
      title: 'Instant X links + a real off switch',
      blurb: 'Traders vet a coin by clicking its X link — and then wait ~3.5 seconds for a cold tab to load.',
      article: 'news-instant-x.html',
      points: [
        '<b>Instant X links (opt-in).</b> X posts and profiles clicked on any supported trading site open in a kept-warm viewer tab via an in-page navigation: about half a second, and every follow-up click lands in the same already-hydrated tab.',
        '<b>Hover prefetch.</b> Rest the cursor on an X link for a tenth of a second and the hidden viewer starts navigating there before you click.',
        '<b>A real off switch.</b> A ⏻ button in the popup turns the whole extension dormant on every open tab, immediately — keeping your wallet, journal and every sub-setting for when you switch back on.',
        '<b>Honest costs, stated up front:</b> one muted background x.com tab while enabled, two passive bridge scripts on x.com, zero new permissions, no telemetry. Ctrl/Cmd/middle-click always bypasses the feature.',
      ],
    },
    {
      v: '2.3.0', date: 'Aug 5, 2026', iso: '2026-08-05',
      tags: ['fix', 'feature'],
      title: 'Community feedback batch (thanks lev)',
      blurb: 'All four items, same day.',
      points: [
        '<b>The average line can never ride the candle again — by construction.</b> The recompute-per-second design was replaced outright: the line level is computed once and frozen, because an average IS a constant level in axis units.',
        '<b>Focus mode is genuinely compact now:</b> position-detail rows hide, unrealized P&L and quick sell stay.',
        '<b>Quick reset in focus mode, no popup.</b> Tap once to arm, tap again to reset. Streams keep their focus; fat fingers keep their journal.',
      ],
    },
    {
      v: '2.2.0', date: 'Aug 5, 2026', iso: '2026-08-05',
      tags: ['feature'],
      title: 'Fees & costs emulation',
      blurb: 'Make paper fills cost what real fills cost.',
      article: 'news-fees.html',
      points: [
        '<b>A new settings card models the FULL cost of a real fill:</b> the platform percentage, plus a flat priority fee (gas) and a bribe/tip per transaction — the costs that dominate small entries.',
        '<b>The accounting is honest end to end.</b> Flat costs join the cost basis on buys and reduce net proceeds on sells, so per-sell P&L, rounds, the calendar, the equity curve and the verification chain all include them.',
        '<b>A dust exit can genuinely net negative</b> — you paid gas to leave a worthless bag, which is precisely the lesson.',
        'Defaults are zero, so existing wallets change nothing until you opt in.',
      ],
    },
    {
      v: '2.1.0', date: 'Aug 5, 2026', iso: '2026-08-05',
      tags: ['feature', 'fix'],
      title: 'The After, Guardrails, CSV export, onboarding',
      blurb: 'The practice loop gets its most important missing organ, plus training wheels and data ownership.',
      article: 'news-the-after.html',
      points: [
        '<b>The After.</b> Every closed round watches its coin for the following hour and records what ACTUALLY happened after your exit — observed extremes, sample counts, no interpolation.',
        '<b>Guardrails (training wheels).</b> Opt-in and enforced at buy time: a tilt breaker, a max position size, and a daily loss limit.',
        '<b>Fill bubbles land on the candles</b> (community screenshot, fixed same day) — shapes now share the avg line level math and clamp to the newest bar.',
        '<b>CSV export</b> for the journal and rounds, RFC-4180-safe, After columns included.',
        '<b>Onboarding checklist</b> on Overview: first buy → thesis → first close → first After → review → the 50-round road to the graduation bar.',
      ],
    },
    {
      v: '2.0.1', date: 'Aug 5, 2026', iso: '2026-08-05',
      tags: ['fix'],
      title: 'A real position can no longer pollute the paper feed',
      blurb: 'First post-2.0 community report, fixed same-day.',
      points: [
        '<b>Holding a real position no longer confuses the paper numbers.</b> Sites stream your real entry average alongside the live price, and PaperTrench was accepting it as a market tick. Your own position data is now never treated as a market price.',
        '<b>The paper line can never impersonate the real one.</b> Average lines are labelled "PAPER Avg. Fill" / "PAPER Avg. Exit" — same doctrine as the P&L card watermark.',
      ],
    },
    {
      v: '2.0.0', date: 'Aug 5, 2026', iso: '2026-08-05', major: true,
      tags: ['fix', 'feature', 'security', 'speed'],
      title: 'Out of alpha',
      blurb: 'A four-track code audit produced a public, ranked defect register of 139 findings. v2.0.0 closes 116 of them — every one with a regression test that fails on the old code.',
      article: 'news-v2.html',
      points: [
        '<b>Fills can no longer execute at stale prices.</b> Chain state, then the click-time snapshot, then a fresh page tick, then one resolver refresh — beyond that the trade is refused with a visible reason. The old default path filled at prices up to 10 seconds old.',
        '<b>The average-entry line finally holds your entry</b> instead of riding the candle on market-cap charts.',
        '<b>Feeds that survive volume.</b> The GMGN high-volume fixes became the contract for every site, with a 10× stress harness in CI.',
        '<b>PaperTrench now runs ONLY on the nine supported trading sites</b> — never anywhere else, never on wallet, portfolio or EVM routes.',
        '<b>The graduation bar.</b> Seven criteria evaluated against your own journal, where missing evidence never counts as a pass.',
      ],
    },
    {
      v: '1.2.18', date: 'Aug 5, 2026', iso: '2026-08-05',
      tags: ['fix'],
      title: 'First fix batch from the public defect register',
      blurb: 'Six correctness fixes on the money paths, every one locked with a regression test.',
      points: [
        '<b>Fast navigation can no longer trade the wrong token.</b> Navigations that land mid-resolve are retried instead of silently swallowed.',
        '<b>Double-tap sells fill once.</b> Previously a second tap silently sold 50% of the remainder — 75% total — with two success toasts.',
        '<b>AI reviews and recording links stop vanishing from the dashboard.</b>',
        '<b>Backup restore sticks:</b> a restored wallet lands strictly ahead of every open tab’s write counter.',
        '<b>Screener quick-buy chips price honestly</b> — a chip tap demands a quote no older than 3 seconds.',
      ],
    },
    {
      v: '1.2.17', date: 'Aug 5, 2026', iso: '2026-08-05',
      tags: ['fix', 'security'],
      title: 'Reliability hardening',
      blurb: 'No feature changes.',
      points: [
        '<b>Storage failures are no longer silently ignored.</b> A failed read falls back to safe defaults — never a fabricated wallet — and a failed write reports itself instead of pretending it worked.',
        '<b>Stale AI credentials are cleaned up</b> so an old key can never be silently sent to whatever endpoint gets configured next.',
      ],
    },
    {
      v: '1.2.16', date: 'Aug 5, 2026', iso: '2026-08-05',
      tags: ['fix'],
      title: 'Sell buttons no longer disappear',
      blurb: 'Reported on v1.2.13: "still having issues with that sell button disappearing".',
      points: [
        'Overlay teardown destroyed the shadow DOM but left the position-card cache pointing at detached nodes, so the rebuilt card came back without sell buttons. Both teardown paths now null the cache. Locked by a source-contract regression test.',
      ],
    },
    {
      v: '1.2.15', date: 'Aug 5, 2026', iso: '2026-08-05',
      tags: ['feature'],
      title: 'Focus mode for the trade tab',
      blurb: 'Requested from the community: "make the trading tab like Axiom and other platforms for more optimised and less distracted trades".',
      points: [
        'A Focus mode toggle strips every decoration from the panel — banner, watermark, sparkline, thesis card, last-close card and footer — leaving token, price, balance and buy/sell controls.',
        'Opt-in; the full panel stays the default, and flipping the switch applies live on every open tab.',
      ],
    },
    {
      v: '1.2.14', date: 'Aug 5, 2026', iso: '2026-08-05',
      tags: ['fix', 'speed'],
      title: 'GMGN high volume no longer kills the live feed',
      blurb: 'Reported from GMGN: "doesn’t work when volume is high". Two real causes, both fixed.',
      points: [
        'Realtime trade batches grow past the bridge’s 500KB frame guard exactly when volume peaks, and the guard dropped them before the trade feed could read them. Trade batches now bypass the guard; every other oversized frame stays dropped.',
        'Hot batches carry many tokens at once and the one on screen could get crowded out of the tick budget by batch order. The token you are watching is now always emitted first.',
      ],
    },
    {
      v: '1.2.13', date: 'Aug 4, 2026', iso: '2026-08-04',
      tags: ['feature'],
      title: 'The panel remembers its place',
      blurb: 'Drag it anywhere — the position is saved and restored on every refresh, new tab, and supported site.',
      points: [
        'Previously each page load snapped the panel back to the top-right corner.',
        'A saved position that would land off-screen on a smaller window is clamped back, so the panel always stays grabbable.',
      ],
    },
    {
      v: '1.2.12', date: 'Aug 4, 2026', iso: '2026-08-04',
      tags: ['fix', 'feature'],
      title: 'Honest average fills + a Quick-buy settings card',
      blurb: 'Community report round three, both points addressed.',
      points: [
        '<b>Average fill price is now honest on fresh launches.</b> The line used to be computed only from fills that happened to record a USD price, so on a fresh launch it quietly covered a subset of your fills. It now always covers every fill.',
        '<b>Quick-buy (QB) settings found at last.</b> The five toggles were buried mid-list inside "Wallet & Trading"; they now have their own settings card.',
      ],
    },
    {
      v: '1.2.11', date: 'Aug 4, 2026', iso: '2026-08-04',
      tags: ['fix'],
      title: 'Sell options no longer vanish on vault-style pools',
      blurb: 'Fixes GitHub issue #17 — a user’s sell options disappeared mid-session.',
      points: [
        'Constant-product vault tokens were priced from a description that never carried the token’s decimals, so the first live vault update crashed the price handler — and that crash killed the whole live-price stream.',
        '<b>The live-price stream can no longer die from a single bad frame.</b> The socket handler is crash-isolated: one weird token can’t take down everyone’s prices.',
      ],
    },
    {
      v: '1.2.10', date: 'Aug 3, 2026', iso: '2026-08-03',
      tags: ['fix'],
      title: 'Three real bugs from the second community audit',
      blurb: 'All fixed and locked in with regression tests.',
      points: [
        '<b>Reset no longer brings the old wallet back.</b> Resets now inherit the current write counter and land strictly ahead of every open tab.',
        '<b>Buy and sell failures finally say so.</b> A mutation helper swallowed its own errors, leaving the button doing nothing with no message.',
        '<b>Dashboard writes can no longer be clobbered by a lagging tab.</b>',
      ],
    },
    {
      v: '1.2.9', date: 'Aug 3, 2026', iso: '2026-08-03',
      tags: ['feature'],
      title: 'Backup & Restore — updating shouldn’t erase you',
      blurb: 'Unpacked extensions tie their data to the install folder, so a fresh unzip into a new folder looked like a brand new wallet.',
      points: [
        '<b>One click downloads your whole wallet</b> — positions, rounds, history, settings, frames, replays — as a single JSON file. Restore validates the file and confirms before overwriting anything.',
        '<b>The site now teaches same-folder updates:</b> unzip the new release over the folder you already loaded, hit Reload, and your data survives.',
      ],
    },
    {
      v: '1.2.8', date: 'Aug 3, 2026', iso: '2026-08-03',
      tags: ['security', 'fix'],
      title: 'The security patch',
      blurb: 'A sharp-eyed user reported three privacy/safety bugs; all three were confirmed real and all three are fixed here.',
      points: [
        '<b>Snapshots now photograph the tab that traded.</b> Frame captures used to grab whatever window happened to be focused — your email, another chart, anything.',
        '<b>Websites can no longer trigger paper trades.</b> Trade-bearing messages now require a genuine user gesture within the last 5 seconds and must come from the page’s own origin.',
        '<b>Verification no longer breaks for heavy traders.</b> The attest chain was silently capped at 5000 links, corrupting verification for anyone past that count even with nothing tampered.',
      ],
    },
    {
      v: '1.2.7', date: 'Aug 3, 2026', iso: '2026-08-03',
      tags: ['feature', 'fix'],
      title: 'The X-feedback batch',
      blurb: 'Four things you asked for, plus one layout fix.',
      points: [
        '<b>The positions bar finally stays hidden.</b> Your choice is a saved setting now, so hide-it-once means hidden everywhere.',
        '<b>Post-close notes on rounds.</b> The thesis is written before you know how it ends; the lesson usually arrives after. The AI coach reads the note too.',
        '<b>Leaderboard shows ROI on your bankroll,</b> so absolute SOL stops flattering whoever started with the biggest paper balance.',
        '<b>The AI coach explains itself</b> — "AI not working" usually meant "not configured yet", and the Test button now says exactly that.',
        '<b>Homepage goes full-bleed on wide monitors</b> (1440px container) after ultrawide users reported pillar-boxing.',
      ],
    },
    {
      v: '1.2.6', date: 'Aug 2026', iso: '2026-08-01',
      tags: ['feature', 'security'],
      title: 'Quick-buy toggles + SSRF hardening',
      blurb: '',
      points: [
        'Hide the whole Buy section in the trade tab, or just the one-tap preset row, from Settings. Live-applied, no reload.',
        '<b>SSRF hardening:</b> the AI endpoint ships empty, and localhost/LAN endpoints require an explicit opt-in toggle.',
      ],
    },
  ];

  const FILTERS = [
    { key: 'all', label: 'Everything' },
    { key: 'feature', label: 'New features' },
    { key: 'fix', label: 'Fixes' },
    { key: 'speed', label: 'Speed' },
    { key: 'security', label: 'Security & privacy' },
  ];

  const TAG_LABEL = { feature: 'Feature', fix: 'Fix', security: 'Security', speed: 'Speed' };

  const timeline = document.getElementById('timeline');
  const filterRow = document.getElementById('filterRow');
  const countEl = document.getElementById('filterCount');
  if (!timeline || !filterRow) return;

  /* ---------- render ---------- */
  function releaseCard(r) {
    const el = document.createElement('div');
    el.className = 'rel' + (r.major ? ' is-major' : '');
    el.dataset.tags = r.tags.join(' ');
    el.id = 'v' + r.v.replace(/\./g, '-');

    const tags = r.tags.map(t => `<span class="tag ${t}">${TAG_LABEL[t]}</span>`).join('');
    const points = r.points.map(p => `<div class="rel-point"><span class="bullet"></span><span>${p}</span></div>`).join('');

    // A release can earn more than one deep-dive once it carries more than one
    // story — `articles` for those, `article` for the single-story common case.
    const links = r.articles || (r.article ? [{ href: r.article, label: 'Read the full story' }] : []);
    const more = links
      .map(l => `<a class="rel-more" href="${l.href}">${l.label} <span aria-hidden="true">→</span></a>`)
      .join('');
    const blurb = r.blurb ? `<p class="rel-blurb">${r.blurb}</p>` : '';

    // A build we tell people not to use has to LOOK like one. Burying that in
    // prose is how someone ends up trading on it.
    const warn = r.superseded
      ? `<div class="rel-warn"><span class="ic" aria-hidden="true">⚠</span>${r.superseded}</div>`
      : '';

    el.innerHTML = `
      <div class="rel-card${r.superseded ? ' is-superseded' : ''}">
        <div class="rel-head">
          <span class="ver-chip${r.major ? ' major' : ''}">v${r.v}</span>
          ${tags}
          <time class="rel-date" datetime="${r.iso}">${r.date}</time>
        </div>
        ${warn}
        <h3 class="rel-title">${r.title}</h3>
        ${blurb}
        <div class="rel-points">${points}</div>
        ${more}
      </div>`;
    return el;
  }

  for (const r of RELEASES) timeline.appendChild(releaseCard(r));

  // The hero's "releases logged" figure comes from the array, never from a
  // number typed into the HTML — those two disagree the first time anyone
  // adds a release and forgets, and this page has no business printing a
  // count of its own contents that is wrong.
  const relCount = document.getElementById('relCount');
  if (relCount) relCount.textContent = String(RELEASES.length);

  /* ---------- filters ---------- */
  let active = 'all';

  for (const f of FILTERS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'filter-chip';
    b.textContent = f.label;
    b.dataset.key = f.key;
    b.setAttribute('aria-pressed', String(f.key === active));
    b.addEventListener('click', () => apply(f.key, true));
    filterRow.appendChild(b);
  }

  function apply(key, fromUser) {
    active = key;
    let shown = 0;
    for (const el of timeline.children) {
      const hit = key === 'all' || el.dataset.tags.split(' ').includes(key);
      el.hidden = !hit;
      if (hit) shown++;
    }
    for (const b of filterRow.children) b.setAttribute('aria-pressed', String(b.dataset.key === key));
    if (countEl) {
      countEl.textContent = key === 'all'
        ? `${RELEASES.length} releases · newest first`
        : `${shown} of ${RELEASES.length} releases`;
    }
    // A deep link to a release that the new filter hides would leave the URL
    // pointing at nothing, so a user-driven filter drops the stale anchor.
    if (fromUser && location.hash) history.replaceState(null, '', location.pathname + location.search);
  }

  /* Read the hash BEFORE the first apply() — a #v2-6-0 link has to survive
     rendering, since the cards are built after the browser gave up on it. */
  const wanted = location.hash ? location.hash.slice(1) : '';
  apply('all', false);
  if (wanted) {
    const target = document.getElementById(wanted);
    if (target) target.scrollIntoView({ block: 'center' });
  }
})();
