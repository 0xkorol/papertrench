/* Gamification UI wiring (docs/GAMIFY.md "UI pass" as code).
 *
 * The doctrine under test: the Trench Rank surfaces are DERIVED display —
 * wired into the dashboard, overlay, and PnL card without ever entering a
 * per-tick render path (the F-18 starvation class), without a new persisted
 * byte, and degrading to nothing when gamify.js is absent (the D-16 rule:
 * a render-path throw blanks the dashboard).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const html = read('dashboard.html');
const dashJs = read('dashboard.js');
const contentJs = read('content.js');
const manifest = JSON.parse(read('manifest.json'));

/** dashboard.js top-level functions close at column 0 (dashboardfixes idiom). */
function fnBlock(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start !== -1, `${marker} must exist`);
  const end = source.indexOf('\n}', start);
  assert.ok(end !== -1, `${marker} must terminate`);
  return source.slice(start, end + 2);
}

/** content.js functions live in the IIFE and close at 2-space indent. */
function contentBlock(marker) {
  const start = contentJs.indexOf(marker);
  assert.ok(start !== -1, `${marker} must exist in content.js`);
  const end = contentJs.indexOf('\n  }', start);
  assert.ok(end !== -1, `${marker} must terminate`);
  return contentJs.slice(start, end + 4);
}

/* ================= wiring ================= */

test('gamify.js loads on both surfaces: dashboard page and ISOLATED content scripts', () => {
  const gamifyAt = html.indexOf('<script src="gamify.js">');
  const masteryAt = html.indexOf('<script src="mastery.js">');
  const dashAt = html.indexOf('<script src="dashboard.js">');
  assert.ok(gamifyAt !== -1, 'dashboard.html must load gamify.js');
  assert.ok(masteryAt < gamifyAt && gamifyAt < dashAt,
    'load order must be mastery.js → gamify.js → dashboard.js');

  const entry = manifest.content_scripts.find((cs) => (cs.js || []).includes('content.js'));
  const list = entry.js;
  for (const dep of ['mastery.js', 'gamify.js']) {
    assert.equal(list.filter((f) => f === dep).length, 1, `${dep} exactly once in the ISOLATED list`);
    assert.ok(list.indexOf(dep) < list.indexOf('content.js'), `${dep} must load before content.js`);
  }
  // rank() silently returns null without PTMastery — a passing node test
  // cannot prove browser wiring, so the manifest itself is the contract.
  assert.ok(list.indexOf('mastery.js') < list.indexOf('gamify.js'),
    'mastery.js precedes gamify.js, matching the dashboard order');
});

test('the Trench Rank card renders on the overview and soft-degrades like the graduation panel', () => {
  assert.match(dashJs, /function renderTrenchRank\(\)/, 'the card builder must exist');
  const overview = fnBlock(dashJs, 'function renderOverview(el)');
  assert.match(overview, /\$\{renderTrenchRank\(\)\}/, 'the overview must interpolate the card');
  const card = fnBlock(dashJs, 'function renderTrenchRank()');
  assert.match(card, /const G = window\.PTGamify;\s*\n\s*if \(!G\) return '';/,
    'a missing module renders nothing — a throw here blanks the dashboard (D-16)');
  assert.match(card, /G\.rank\(state\)/, 'the card consumes PTGamify.rank');
});

test('the rounds table Grade column keeps its three synchronized edits in sync', () => {
  const rounds = fnBlock(dashJs, 'function renderRounds(el)');
  assert.match(rounds, /renderGradeCell\(gradeById\.get\(r\.id\), r\)/,
    'rows read the per-pass grade map — never a per-cell roundGrade call (O(n²) of O(n))');
  assert.match(rounds, /const gradeById = new Map\(\)/, 'grades are computed once per render pass');
  const headerRow = rounds.match(/<thead><tr>(.*?)<\/tr><\/thead>/);
  assert.ok(headerRow, 'the header row must exist');
  const thCount = (headerRow[1].match(/<th[ >]/g) || []).length;
  const colspan = rounds.match(/colspan="(\d+)"/);
  assert.ok(colspan, 'the empty state must span the table');
  assert.equal(String(thCount), colspan[1],
    'the <th> count and the empty-state colspan are the same number — they drift apart silently otherwise');
  assert.match(headerRow[1], /<th>Grade<\/th>/, 'the Grade column must exist');
});

test('day-keyed gamify surfaces are covered by the fingerprint (no midnight stale-freeze)', () => {
  const fp = fnBlock(dashJs, 'function dataFingerprint()');
  assert.match(fp, /new Date\(\)\.toDateString\(\)/,
    'drills and today-reps change at local midnight with no state change — the C-10 rule: the fingerprint covers everything rendered');
});

test('calendar grade dots bucket by LOCAL day, like the calendar itself (D-49 class)', () => {
  const cal = fnBlock(dashJs, 'function renderCalendar(el)');
  assert.match(cal, /new Date\(r\.closedAt\)/, 'round→day mapping uses a local Date');
  assert.doesNotMatch(cal, /toISOString/, 'a UTC ISO bucket pins dots on the wrong cell across midnight');
  assert.match(cal, /GRADE_ORDER\.indexOf\(l\) > GRADE_ORDER\.indexOf\(pick\)/,
    'grade ties round DOWN to the worse letter — a split day is not rounded up to the better story');
});

/* ================= overlay: out of the tick path ================= */

test('trench values are event-driven: cached at close/adopt/renderAll, never per tick', () => {
  assert.match(contentBlock('function refreshTrenchCache()'), /trenchStreaks = G\.streaks\(state\);/,
    'the cache is the only streaks call site');
  assert.match(contentBlock('function adoptState(next)'), /refreshTrenchCache\(\);/,
    'external closes from other tabs move streaks too');
  assert.match(contentBlock('function renderAll()'), /refreshTrenchCache\(\);/,
    'boot and fills refresh the cache');
  const bar = contentBlock('function renderPositionsBar()');
  assert.doesNotMatch(bar, /PTGamify|streaks\(|roundGrade\(/,
    'the per-tick bar render must never compute gamify values (F-18 starvation class)');
  const pos = contentBlock('function renderPosition()');
  assert.doesNotMatch(pos, /PTGamify|streaks\(|roundGrade\(/,
    'the per-heartbeat position render must never compute gamify values');
});

test('the closed-card grade chip lives inside the once-per-close keyed build', () => {
  const closed = contentBlock('function renderClosedPnl()');
  const keyGuard = closed.indexOf('closedRenderKey = key');
  const gradeCall = closed.indexOf('roundGrade(state, gradedRound)');
  assert.ok(keyGuard !== -1 && gradeCall !== -1 && gradeCall > keyGuard,
    'the grade scan runs only after the key changes — once per close, never per heartbeat');
  assert.match(closed, /closed\.kind === 'round'/,
    'partial exits are not rounds and are never graded');
  // Review S1: insertBefore(chip, status) threw NotFoundError in real DOM —
  // status was not yet a child of `right` — wiping the closed card and
  // aborting renderAll/adoptState mid-sequence on EVERY full close. The
  // fake-DOM harness appends leniently exactly where Chrome throws, so this
  // is pinned at the source: the chip joins `right` by appendChild only.
  assert.match(closed, /right\.appendChild\(chip\)/, 'the chip is appended, order chip → status → flex');
  assert.doesNotMatch(closed, /right\.insertBefore\(chip/,
    'never insertBefore against a reference node that is not yet in the parent');
});

test('the trench cache is gated on a rounds-shape key — persist echoes must not re-scan', () => {
  // Review S2: adoptState fires on every ~800 ms mark-persist echo from other
  // tabs, not only on closes. Without the key gate, the O(rounds²) streak
  // scan rode the storage heartbeat — the F-18 class through the back door.
  const cache = contentBlock('function refreshTrenchCache()');
  assert.match(cache, /trenchRoundsKey/, 'a shape key must exist');
  assert.match(cache, /if \(key === trenchRoundsKey\) return;/,
    'an unchanged rounds shape skips the scan entirely');
  assert.match(cache, /rounds\.length/, 'the key covers the closed-rounds count');
});

test('the close toast grades PROCESS decoupled from P&L, and names luck out loud', () => {
  const sell = contentBlock('async function doSellInner(fraction)');
  assert.match(sell, /Red round', 'Green round'|red \? 'Red round' : 'Green round'/,
    'the toast wording leads with the P&L color and grades the process beside it');
  assert.match(sell, /that habit pays until it doesn/,
    'a lucky win is named as luck (GAMIFY.md doctrine)');
});

/* ================= PnL card ================= */

test('both composers pass the same trench shape into cardModel — one derivation, zero drift', () => {
  assert.match(fnBlock(dashJs, 'function paintShareCard()'), /trench: cardTrenchCurrent/,
    'the dashboard composer passes trench opts');
  assert.match(contentBlock('function paintFlexCard()'), /trench: flexTrench/,
    'the in-page composer passes trench opts');
  for (const src of [fnBlock(dashJs, 'function trenchCardOpts(round)'), contentBlock('function openFlexComposer(mint)')]) {
    assert.match(src, /gradeLetter/, 'both build gradeLetter');
    assert.match(src, /rankName/, 'both build rankName');
    assert.match(src, /slice\(0, 4\)/, 'both cap badges at four');
  }
});

test('cardModel derives trench display strings and the flag hides them (absent = shown)', () => {
  const PC = require('../pnlcard.js');
  const source = {
    symbol: 'TEST', mint: 'M', site: 'padre',
    investedSol: 1, returnedSol: 1.4, pnlSol: 0.4, pnlPct: 40,
    openedAt: 1_800_000_000_000, closedAt: 1_800_000_600_000, heldMs: 600_000,
  };
  const model = PC.cardModel(source, {
    trench: { gradeLetter: 'A', luckyWin: false, rankName: 'Operator', badges: ['Sniper exit', 'On the record'] },
  });
  assert.equal(model.gradeText, 'A PROCESS');
  assert.equal(model.rankText, 'OPERATOR');
  assert.match(model.badgesText, /SNIPER EXIT · ON THE RECORD/);
  assert.equal(model.show.trench, true, 'absent flag means SHOWN');

  const hidden = PC.cardModel(source, {
    prefs: { showTrench: false },
    trench: { gradeLetter: 'F', luckyWin: true, rankName: 'Fresh Meat', badges: [] },
  });
  assert.equal(hidden.show.trench, false, 'the pref can hide the trench line');
  assert.equal(hidden.gradeText, 'F PROCESS · LUCKY', 'a lucky win is labelled on the card too');

  const bare = PC.cardModel(source, {});
  assert.equal(bare.gradeText, '', 'no trench opts → no invented grade');
  assert.equal(bare.rankText, '');
});

/* ================= vm-slice: the grade cell renders honestly ================= */

test('renderGradeCell praises a clean red and tags the lucky win', () => {
  const start = dashJs.indexOf('function renderGradeCell(grade, round)');
  const end = dashJs.indexOf('\n}', start) + 2;
  const sandbox = { esc: (v) => String(v ?? ''), Object, Math, Number, String, Array, Boolean };
  vm.createContext(sandbox);
  vm.runInContext(`${dashJs.slice(start, end)}\nthis.run = renderGradeCell;`, sandbox);

  const cleanRed = sandbox.run({ letter: 'S', parts: [], luckyWin: false }, { pnlSol: -0.2 });
  assert.match(cleanRed, />S</, 'the letter renders');
  assert.match(cleanRed, /Red round, clean process/, 'a disciplined red is praised in the receipt');

  const lucky = sandbox.run({ letter: 'F', parts: [{ note: 'Re-entered bigger.' }], luckyWin: true }, { pnlSol: 0.5 });
  assert.match(lucky, />F</);
  assert.match(lucky, /lucky/, 'a lucky win wears the tag');

  assert.equal(sandbox.run(null, { pnlSol: 1 }), '<span class="dim">—</span>',
    'no grade renders an em-dash, never a fabricated letter');
});
