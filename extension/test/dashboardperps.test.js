/* The dashboard's perps view.
 *
 * Closes a real user report on 2.11.1 — "on the perp trade it doesn't
 * transfer" — where perps fills were recorded correctly in their own book
 * and simply had nowhere to appear.
 *
 * The load-bearing rule under test is NOT that the tab renders. It is that
 * the two books stay decomposable: F-30 says a paper artifact must never be
 * mistakable for a real one, and the same logic applies here — a leveraged
 * run must never flatter the spot track record that graduation is measured
 * on. So no spot figure may be computed from the perps book, anywhere.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const js = fs.readFileSync(path.join(ROOT, 'dashboard.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8');

test('the perps tab is wired at every one of the four places a tab needs', () => {
  // v2.11.0 shipped a tab whose button, content and renderer were all wired
  // and which still rendered into an invisible container, because the one
  // hardcoded visibility list was missed. All four, or it does not ship.
  assert.match(html, /<button data-section="perps">Perps<\/button>/, 'nav button');
  assert.match(html, /<section id="perps" class="section hidden"><\/section>/, 'section container');
  assert.match(js, /const SECTIONS = \[[^\]]*'perps'[^\]]*\]/, 'the visibility list');
  assert.match(js, /else if \(id === 'perps'\) renderPerps\(staged\);/, 'the render dispatch');
});

test('the perps engine is loaded before the dashboard reads the book', () => {
  const perpsAt = html.indexOf('src="perps.js"');
  const venuesAt = html.indexOf('src="perps-venues.js"');
  const dashAt = html.indexOf('src="dashboard.js"');
  assert.ok(venuesAt >= 0 && perpsAt >= 0, 'both perps modules must be loaded');
  assert.ok(venuesAt < perpsAt, 'perps.js depends on perps-venues.js');
  assert.ok(perpsAt < dashAt, 'and both must precede dashboard.js, which calls perpMark');
});

test('the perps book is read from its OWN key, never from the spot state', () => {
  assert.match(js, /const keys = \[[^\]]*'pt_perps'[^\]]*\]/,
    'pt_perps must be in the read set');
  assert.match(js, /let perpsState = null;/,
    'and held in its own variable, not merged into `state`');
  // A malformed record must degrade, not throw mid-render.
  assert.match(js, /perpsRec && typeof perpsRec === 'object' && perpsRec\.positions/,
    'a record that is not a book degrades to null');
});

test('NO spot figure is computed from the perps book', () => {
  // The rule that matters. If a future edit adds perps equity into the
  // overview totals, the two books stop being decomposable and a leveraged
  // run silently flatters the spot record graduation is measured on.
  const renderers = ['renderOverview', 'renderGame', 'renderCalendar', 'renderJournal', 'renderRounds'];
  for (const name of renderers) {
    const start = js.indexOf('function ' + name + '(');
    assert.ok(start > 0, name + ' must exist');
    const body = js.slice(start, js.indexOf('\nfunction ', start + 10));
    assert.ok(!/perpsState/.test(body),
      name + ' must not read the perps book — the two books stay separate');
  }
  // And the perps renderer must not read the spot book either.
  const pStart = js.indexOf('function renderPerps(');
  const pBody = js.slice(pStart, js.indexOf('\nfunction ', pStart + 10));
  assert.ok(!/\bstate\.(positions|rounds|journal|cashSol)/.test(pBody),
    'renderPerps must not read the spot wallet');
});

test('the perps view says what it is, and what its marks are worth', () => {
  const start = js.indexOf('function renderPerps(');
  const body = js.slice(start, js.indexOf('\nfunction ', start + 10));
  assert.match(body, /a separate book/, 'the tab states the separation on screen');
  assert.match(body, /never mix with your spot wallet/i, 'in words a user can act on');
  // The dashboard has no venue feed; equity is marked at the last OBSERVED
  // price. Claiming a live mark would be a wrong number.
  assert.match(body, /last OBSERVED/, 'the mark is labelled as observed, not live');
  assert.match(body, /no live venue feed/, 'and the absence of a feed is stated');
});

test('a liquidation is never shown as an ordinary close', () => {
  const start = js.indexOf('function renderPerps(');
  const body = js.slice(start, js.indexOf('\nfunction ', start + 10));
  assert.match(body, /r\.cause === 'liquidated'/, 'the cause is read');
  assert.match(body, /LIQUIDATED/, 'and called what it is');
  assert.match(body, /provenance/,
    'a round reconstructed from venue candles must carry that provenance');
  assert.match(body, /unverifiedGapSec/,
    'and an unobserved gap must be surfaced, since real carry would be higher');
});

test('a perps fill repaints the tab, without churning on every tick', () => {
  const start = js.indexOf('function dataFingerprint()');
  const body = js.slice(start, js.indexOf('\nfunction ', start + 10));
  assert.match(body, /perpsState \? \(perpsState\.journal \|\| \[\]\)\.length : -1/,
    'a new fill must change the fingerprint');
  assert.match(body, /perpsState \? \(perpsState\.rounds \|\| \[\]\)\.length : -1/,
    'and so must a close or a liquidation');
  assert.ok(!/perpsPositions\.map\(\(p\) => `\$\{p\.id\}:\$\{p\.lastPx\}/.test(body),
    'the live mark must NOT be in the fingerprint — it would repaint every tick');
});

test('every value this view renders is escaped or numeric BY CONSTRUCTION', () => {
  // The perps view builds innerHTML from a stored record. Stored records are
  // data, and data is the thing that turns out to be attacker-shaped later —
  // the same reasoning as treating log output as untrusted. "Safe because
  // this value happens to be a number today" is not a defence; every
  // interpolation must be esc()'d, a numeric formatter, or a local that was
  // explicitly coerced to a number.
  const start = js.indexOf('function renderPerps(');
  const body = js.slice(start, js.indexOf('\nfunction ', start + 10));
  const spots = body.match(/\$\{[^{}]*\}/g) || [];
  assert.ok(spots.length > 20, 'the view really does interpolate a lot');

  const SAFE = /^\$\{\s*(esc\(|perpsUsd\(|perpsPx\(|Math\.round\(|posRows|roundRows|trimmed|gap|prov|archivedRounds|positions\.length|rounds\.length)/;
  const TERNARY = /\?\s*['"]/; // choosing between literal strings
  const offenders = spots.filter((s) => !SAFE.test(s) && !TERNARY.test(s));
  assert.deepEqual(offenders, [],
    'these interpolations are neither escaped nor provably numeric: ' + offenders.join(' | '));

  // archivedRounds is on the allowlist ONLY because it is coerced first.
  assert.match(body, /const archivedRounds = Number\(archived\.roundsCount\) > 0 \? Math\.floor\(Number\(archived\.roundsCount\)\) : 0;/,
    'the count must be coerced to a number before it reaches a template');
});

test('the archived-rounds note keeps the table honest about its own sample', () => {
  const start = js.indexOf('function renderPerps(');
  const body = js.slice(start, js.indexOf('\nfunction ', start + 10));
  assert.match(body, /archived\.roundsCount/,
    'a trimmed book must say how many rounds are not in the table');
  assert.match(body, /Totals below still include them/,
    'and make clear the totals are not truncated with it');
});
