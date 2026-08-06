/* Tests for the perps venue site adapters (perps-sites.js).
 *
 * Every URL and every title/text pattern below is a string recorded from
 * the LIVE venue on 2026-08-05 (the probes cited in perps-sites.js) — the
 * adapters are tested against what the venues actually serve, not against
 * what we imagine they serve.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

global.window = global.window || {};
require('../perps-sites.js');
const S = global.window.PaperPerpsSites;

const CLOSE = 1e-9;

test('perps site adapters install their public API on the browser global', () => {
  for (const fn of ['detect', 'parseHlTitle', 'parseJupTitle', 'parseJupBorrowRate']) {
    assert.equal(typeof S[fn], 'function', `${fn} must be exported`);
  }
});

/* --------------------------- Hyperliquid URLs --------------------------- */

test('[HL-URL] the REAL app route is a bare /trade — market comes from the title', () => {
  // Observed live 2026-08-06 on a logged-in session: the address bar reads
  // https://app.hyperliquid.xyz/trade with NO market segment, and the title
  // reads "55.063 | HYPE | Hyperliquid". An earlier version required
  // /trade/<COIN>, so detect() returned null on the actual site and the
  // ticket could never mount at all.
  const d = S.detect('app.hyperliquid.xyz', '/trade', '55.063 | HYPE | Hyperliquid');
  assert.ok(d, 'a bare /trade route must be detected');
  assert.equal(d.venue, 'hyperliquid');
  assert.equal(d.market, 'HYPE');
  assert.equal(d.confirmed, false, 'the live perp universe confirms markets, not the page');
});

test('[HL-URL] the title WINS over the path — the app switches market without navigating', () => {
  // Switching instrument in the UI does not change the URL, so a stale path
  // segment must never outrank what the page is actually showing.
  const d = S.detect('app.hyperliquid.xyz', '/trade/SOL', '55.06 | HYPE | Hyperliquid');
  assert.equal(d.market, 'HYPE', 'the title is authoritative');
  assert.equal(S.hlTitleMarket('55.063 | HYPE | Hyperliquid'), 'HYPE');
  assert.equal(S.hlTitleMarket('Hyperliquid'), null);
});

test('[HL-URL] the deep-link form still works when no title is available yet', () => {
  const d = S.detect('app.hyperliquid.xyz', '/trade/SOL', '');
  assert.equal(d.market, 'SOL', 'the path is the fallback, not the primary');
  assert.equal(S.detect('app.hyperliquid.xyz', '/trade/BTC/', '').market, 'BTC', 'trailing slash tolerated');
});

test('[HL-URL] a bare /trade with an unreadable title detects nothing', () => {
  // Better no ticket than a ticket priced against a market we cannot name.
  assert.equal(S.detect('app.hyperliquid.xyz', '/trade', 'Hyperliquid'), null);
  assert.equal(S.detect('app.hyperliquid.xyz', '/trade', ''), null);
});

test('[HL-URL] non-trade Hyperliquid pages and foreign hosts detect nothing', () => {
  const T = '55.06 | HYPE | Hyperliquid';
  assert.equal(S.detect('app.hyperliquid.xyz', '/portfolio', T), null,
    'the portfolio page must never mount a ticket, title or not');
  assert.equal(S.detect('app.hyperliquid.xyz', '/vaults', T), null);
  assert.equal(S.detect('hyperliquid.xyz', '/trade', T), null, 'only the app subdomain trades');
  assert.equal(S.detect('evil-app.hyperliquid.xyz.attacker.io', '/trade', T), null);
});

/* ----------------------------- Jupiter URLs ----------------------------- */

test('[JUP-URL] /perps/<side>/<COLLATERAL>-<MARKET> — all three live-probed forms', () => {
  const a = S.detect('jup.ag', '/perps/long/SOL-SOL');
  assert.deepEqual(
    { venue: a.venue, market: a.market, uiSide: a.uiSide, collateral: a.collateral },
    { venue: 'jupiter', market: 'SOL', uiSide: 'long', collateral: 'SOL' }
  );
  assert.equal(S.detect('jup.ag', '/perps/short/USDC-ETH').market, 'ETH');
  assert.equal(S.detect('jup.ag', '/perps/long/SOL-WBTC').market, 'WBTC');
  assert.equal(S.detect('jup.ag', '/perps/long/SOL-WBTC').confirmed, true,
    'Jupiter markets are a closed set — the URL is confirmation enough');
});

test('[JUP-URL] unknown markets, bare /perps, and non-perps Jupiter pages detect nothing', () => {
  assert.equal(S.detect('jup.ag', '/perps/long/SOL-DOGE'), null, 'only SOL/ETH/WBTC exist');
  assert.equal(S.detect('jup.ag', '/perps'), null, 'bare /perps client-redirects; nothing to trade yet');
  assert.equal(S.detect('jup.ag', '/swap/SOL-USDC'), null);
  assert.equal(S.detect('jup.ag', '/perps-leaderboard'), null);
});

/* --------------------------- title price feeds --------------------------- */

test('[HL-TTL] recorded Hyperliquid title parses to the live price for the right market', () => {
  const t = S.parseHlTitle('73.483 | SOL | Hyperliquid', 'SOL');
  assert.ok(Math.abs(t.px - 73.483) < CLOSE);
  assert.equal(S.parseHlTitle('73.483 | SOL | Hyperliquid', 'BTC'), null, 'market mismatch is a null, not a guess');
  assert.ok(Math.abs(S.parseHlTitle('64,535.0 | BTC | Hyperliquid', 'BTC').px - 64535) < CLOSE, 'thousands separators');
  assert.equal(S.parseHlTitle('Hyperliquid', 'SOL'), null);
  assert.equal(S.parseHlTitle('', 'SOL'), null);
});

test('[JUP-TTL] recorded Jupiter titles parse for all three markets', () => {
  assert.ok(Math.abs(S.parseJupTitle('73.33 - SOL', 'SOL').px - 73.33) < CLOSE);
  assert.ok(Math.abs(S.parseJupTitle('1896.48 - ETH', 'ETH').px - 1896.48) < CLOSE);
  assert.ok(Math.abs(S.parseJupTitle('64446.36 - WBTC', 'WBTC').px - 64446.36) < CLOSE);
  assert.equal(S.parseJupTitle('73.33 - SOL', 'ETH'), null);
  assert.equal(S.parseJupTitle('Trade SOL, BTC, & ETH Perpetual Futures | Jupiter Perps', 'SOL'), null,
    'the marketing title carries no price and must parse to nothing');
});

/* -------------------------- Jupiter borrow rate -------------------------- */

test('[JUP-BRW] the recorded page text yields the displayed hourly borrow rate as a fraction', () => {
  // Exact innerText neighborhood recorded live: "Borrow Rate | 0.0014% / hr"
  assert.ok(Math.abs(S.parseJupBorrowRate('Available Liq. | $10.00M | Borrow Rate | 0.0014% / hr | Show Positions') - 0.000014) < CLOSE);
  assert.ok(Math.abs(S.parseJupBorrowRate('Borrow Rate\n0.0014% / hr') - 0.000014) < CLOSE, 'newline-joined DOM text');
});

test('[JUP-BRW] the magnitude gate rejects numbers that cannot be an hourly borrow rate', () => {
  assert.equal(S.parseJupBorrowRate('Borrow Rate | 14% / hr'), null, 'two orders of magnitude past any real rate');
  assert.equal(S.parseJupBorrowRate('Borrow Rate | 0.6% / hr'), null, 'above the 0.5%/hr sanity ceiling');
  assert.equal(S.parseJupBorrowRate('no rates here'), null);
  assert.equal(S.parseJupBorrowRate(''), null);
  assert.equal(S.parseJupBorrowRate(null), null);
});
