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
  // Gaming Mode makes the Grade column conditional: the static columns plus
  // one conditional <th> must agree with the conditional colspan in BOTH
  // branches — they drift apart silently otherwise.
  const staticTh = (headerRow[1].replace(/\$\{G \? '<th>Grade<\/th>' : ''\}/, '').match(/<th[ >]/g) || []).length;
  const colspan = rounds.match(/colspan="\$\{G \? (\d+) : (\d+)\}"/);
  assert.ok(colspan, 'the empty state colspan must be mode-conditional');
  assert.equal(String(staticTh + 1), colspan[1], 'gaming on: static columns + Grade');
  assert.equal(String(staticTh), colspan[2], 'gaming off: static columns only');
  assert.match(headerRow[1], /\$\{G \? '<th>Grade<\/th>' : ''\}/, 'the Grade column exists only in Gaming Mode');
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
  assert.match(contentBlock('function refreshTrenchCache()'), /trenchStreaks = gamingOn\(\) \? G\.streaks\(state\) : null;/,
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

/* ================= Gaming Mode: the persona wall ================= */

test('Gaming Mode gates the CHARTS, never the dashboard (corrected semantics)', () => {
  // Dashboard: ALWAYS full-featured — no renderer may consult the toggle.
  for (const fn of ['function renderTrenchRank()', 'function renderRounds(el)',
    'function renderCalendar(el)', 'function trenchCardOpts(round)', 'function renderGame(el)']) {
    assert.doesNotMatch(fnBlock(dashJs, fn), /gamingOn\(\)/,
      `${fn} is dashboard furniture — the wall is at the dashboard door, not inside it`);
  }
  assert.doesNotMatch(dashJs, /function applyModeNav\(\)/,
    'the Game nav entry is permanent — nothing hides it');
  // Overlay: the AMBIENT surfaces are gated…
  assert.match(contentBlock('function gamingOn()'), /settings\.gamingModeEnabled === true/,
    'default-off: only an explicit true turns ambient gamification on');
  const cache = contentBlock('function refreshTrenchCache()');
  assert.match(cache, /trenchStreaks = gamingOn\(\) \? G\.streaks\(state\) : null/, 'streak chip gated');
  const sell = contentBlock('async function doSellInner(fraction)');
  assert.match(sell, /gamingOn\(\) && window\.PTGamify/, 'grade toast gated');
  const closedCard = contentBlock('function renderClosedPnl()');
  assert.match(closedCard, /gamingOn\(\) && window\.PTGamify/, 'closed-card chip gated');
  const flex = contentBlock('function openFlexComposer(mint)');
  assert.match(flex, /gamingOn\(\) && window\.PTGamify/, 'flex card trench gated');
  // …but a STARTED session's HUD is a request, not furniture: the session
  // is computed unconditionally, so the HUD rides while a game runs.
  assert.match(cache, /updateGameHud\(typeof G\.gameSession === 'function' \? G\.gameSession\(state\) : null\)/,
    'the HUD of an explicitly started game ignores the ambient toggle');
  assert.match(cache, /\$\{gamingOn\(\) \? 1 : 0\}/,
    'the cache key carries the toggle so a settings flip clears chips on the next event');
  // Settings: the toggle exists, persists, and defaults OFF.
  assert.match(dashJs, /id="set-gaming-mode"/, 'the Modes card offers the toggle');
  assert.match(dashJs, /gamingModeEnabled: document\.getElementById\('set-gaming-mode'\)\.checked/,
    'the toggle persists');
  const engine = read('engine.js');
  assert.match(engine, /gamingModeEnabled: false/, 'ambient gamification is opt-in');
});

test('game sessions: engine pointer, tab controls, Date-free session scoring for the HUD', () => {
  const engine = read('engine.js');
  assert.match(engine, /function startGame\(state, id, ts\)/, 'engine owns the session pointer');
  assert.match(engine, /function endGame\(state\)/, 'and its removal');
  const bind = fnBlock(dashJs, 'function bindGame(el)');
  assert.match(bind, /mutateState/, 'start/end go through the seq-protocol write path');
  assert.match(bind, /E\.startGame\(fresh, id, Date\.now\(\)\)/);
  assert.match(bind, /E\.endGame\(fresh\)/);
  const gamify = read('gamify.js');
  const sessionFn = gamify.slice(gamify.indexOf('function gameSession(state, now)'), gamify.indexOf('/** Longer-horizon'));
  assert.doesNotMatch(sessionFn, /new Date|dayKey|dayBuckets/,
    'gameSession stays Date-free so the overlay HUD can call it in the stubbed-Date harness');
  const hud = contentBlock('function updateGameHud(session)');
  assert.match(hud, /session\.status !== 'live'/, 'terminal states are announced');
  assert.match(hud, /gameHudStatus && gameHudStatus !== statusKey/, 'announced exactly once, not per repaint');
});

/* ================= the Game tab ================= */

test('the Game tab is wired: nav button, section container, dispatch branch, soft-guarded renderer', () => {
  assert.match(html, /<button data-section="game">Game<\/button>/, 'the sidebar must offer the tab');
  assert.match(html, /<section id="game" class="section hidden"><\/section>/, 'the section container must exist');
  // D-55: visibility is driven by the hardcoded SECTIONS array (bindNav
  // toggles .hidden over it). A tab missing from it renders into an
  // INVISIBLE section — button present, dispatch present, screen empty.
  // Pin the generic contract: every nav data-section id is in SECTIONS.
  const sectionsLine = dashJs.match(/const SECTIONS = \[([^\]]+)\]/);
  assert.ok(sectionsLine, 'SECTIONS must exist');
  const sections = sectionsLine[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
  const navIds = [...html.matchAll(/data-section="([a-z-]+)"/g)].map((m) => m[1]);
  for (const id of navIds) {
    assert.ok(sections.includes(id),
      `nav tab "${id}" must be in SECTIONS or it toggles every section hidden and shows nothing`);
  }
  const dispatch = fnBlock(dashJs, 'function renderSection(id)');
  assert.match(dispatch, /else if \(id === 'game'\) renderGame\(staged\);/, 'the dispatch must route to renderGame');
  const game = fnBlock(dashJs, 'function renderGame(el)');
  assert.match(game, /const G = window\.PTGamify;/, 'the tab consumes PTGamify');
  assert.doesNotMatch(game, /\bthrow\b/, 'a render-path throw blanks the dashboard (D-16) — degrade, never throw');
  assert.match(game, /G\.games\(state, now\)/, 'the tab renders the trading games');
  assert.match(game, /G\.challenges\(state\)/, 'the tab renders the challenge tracks');
});

test('games and challenges are pure derived rulesets — no storage writes anywhere in gamify.js', () => {
  const gamify = read('gamify.js');
  assert.doesNotMatch(gamify, /chrome\.storage/, 'gamify.js must never touch storage (derived, not stored)');
  assert.match(gamify, /function games\(state, now\)/, 'games() exists');
  assert.match(gamify, /function challenges\(state\)/, 'challenges() exists');
  assert.doesNotMatch(gamify, /Math\.random/, 'no synthetic randomness — games measure real rounds only');
});

test('the overlay gauntlet chip rides the event-driven cache via the Date-free seam', () => {
  const cache = contentBlock('function refreshTrenchCache()');
  assert.match(cache, /G\.gauntletRun\(state\)/, 'the gauntlet is computed inside the gated cache');
  assert.doesNotMatch(cache, /G\.games\(/,
    'the overlay must use gauntletRun — games() day-buckets via new Date(), which the overlay harnesses stub away');
  const bar = contentBlock('function renderPositionsBar()');
  assert.doesNotMatch(bar, /G\.games|games\(state|gauntletRun/, 'the per-tick bar render must never compute games');
  const gamify = read('gamify.js');
  const gauntletFn = gamify.slice(gamify.indexOf('function gauntletRun(state)'), gamify.indexOf('function games(state, now)'));
  assert.doesNotMatch(gauntletFn, /new Date|dayKey|dayBuckets/,
    'gauntletRun stays Date-free by contract');
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
