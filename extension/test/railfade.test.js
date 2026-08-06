/* The overlay shows NO scrollbars, and the positions rail's fade is honest.
 *
 * Maintainer report (2026-08-06, screenshot): a full-size light OS scrollbar
 * across the dark positions bar — "fuck these scroll bars and ugly nonsense".
 *
 * Cause was not a missing rule but a SUPPRESSED one. `.pt-bar-rail` declared
 * both `scrollbar-width: thin` and a styled `::-webkit-scrollbar` — and since
 * Chrome 121 the standard property WINS and the webkit pseudo-elements are
 * dropped entirely. So the 4px dark thumb never rendered and Chrome drew its
 * own light-themed bar instead. Declaring both is not belt and braces.
 *
 * Two things are pinned here:
 *   1. Every scrollable surface in the overlay hides its scrollbar, via ONE
 *      rule, and none of them re-declares a conflicting `scrollbar-width`.
 *   2. The fade that replaces the scrollbar tells the truth — no fade when the
 *      rail fits, no right-hand fade once you have reached the end. A
 *      permanent fade would dim the last chip on a bar with nothing hidden,
 *      which claims there is more when there is not.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

/* Every element in the overlay that can scroll. */
const SCROLLABLE = ['.pt-body', '.pt-bar-rail', '.pt-flex-gallery', '.pt-flex-inner'];

test('every scrollable surface is covered by the hide-scrollbar rule', () => {
  for (const sel of SCROLLABLE) {
    assert.ok(
      new RegExp(`${sel.replace('.', '\\.')},?\\s`).test(SRC),
      `${sel} must be listed in the shared scrollbar rule`);
    assert.ok(
      SRC.includes(`${sel}::-webkit-scrollbar`),
      `${sel} needs its ::-webkit-scrollbar suppressed too`);
  }
});

test('no surface re-declares a scrollbar-width that would suppress the webkit rules', () => {
  // This is the actual regression: `scrollbar-width: thin` anywhere means
  // Chrome ignores the ::-webkit-scrollbar styling on that element.
  const widths = [...SRC.matchAll(/scrollbar-width:\s*([a-z-]+)/g)].map((m) => m[1]);
  assert.ok(widths.length > 0, 'the rule should exist at all');
  for (const w of widths) {
    assert.equal(w, 'none',
      `scrollbar-width must only ever be "none" in the overlay, found "${w}"`);
  }
});

test('no styled scrollbar thumb or track survives in the overlay', () => {
  assert.ok(!/::-webkit-scrollbar-(thumb|track)/.test(SRC),
    'a styled thumb/track is dead code once scrollbar-width:none is set — remove it rather than leaving it to mislead');
});

/* ---- the fade's honesty, driven through the real function ---- */

function railWith({ scrollWidth, clientWidth, scrollLeft }) {
  const classes = new Set();
  return {
    scrollLeft, scrollWidth, clientWidth,
    classList: {
      toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
      has: (n) => classes.has(n),
    },
    _classes: classes,
  };
}

/* Extract syncRailFade and run it against fake rails, so the assertions are
 * about the shipped logic rather than a restatement of it. */
function loadSyncRailFade() {
  const start = SRC.indexOf('function syncRailFade()');
  assert.ok(start > 0, 'syncRailFade must exist');
  let depth = 0; let i = SRC.indexOf('{', start); const from = i;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) break; }
  }
  const body = SRC.slice(from + 1, i);
  // eslint-disable-next-line no-new-func
  return new Function('els', body);
}

const run = (rail) => { loadSyncRailFade()({ barRail: rail }); return rail._classes; };

test('a rail that fits gets NO fade — it must not claim hidden chips', () => {
  const c = run(railWith({ scrollWidth: 400, clientWidth: 400, scrollLeft: 0 }));
  assert.equal(c.size, 0, `expected no fade classes, got ${[...c]}`);
});

test('an overflowing rail at the start fades only its right edge', () => {
  const c = run(railWith({ scrollWidth: 900, clientWidth: 400, scrollLeft: 0 }));
  assert.ok(c.has('pt-rail-more'), 'right-edge fade on');
  assert.ok(!c.has('pt-rail-start'), 'nothing hidden to the left yet');
  assert.ok(!c.has('pt-rail-end'), 'not at the end');
});

test('scrolled to the middle fades both edges', () => {
  const c = run(railWith({ scrollWidth: 900, clientWidth: 400, scrollLeft: 250 }));
  assert.ok(c.has('pt-rail-more') && c.has('pt-rail-start'));
  assert.ok(!c.has('pt-rail-end'));
});

test('scrolled to the END stops promising more to the right', () => {
  const c = run(railWith({ scrollWidth: 900, clientWidth: 400, scrollLeft: 500 }));
  assert.ok(c.has('pt-rail-end'), 'left-edge fade only');
  assert.ok(!c.has('pt-rail-more'), 'must NOT still fade the right edge at the end');
});

test('a hidden rail measures zero and is left alone rather than cleared', () => {
  const rail = railWith({ scrollWidth: 900, clientWidth: 400, scrollLeft: 0 });
  run(rail);
  assert.ok(rail._classes.has('pt-rail-more'));
  // Now the bar is hidden: every measurement reads 0.
  rail.clientWidth = 0; rail.scrollWidth = 0; rail.scrollLeft = 0;
  loadSyncRailFade()({ barRail: rail });
  assert.ok(rail._classes.has('pt-rail-more'),
    'a state we cannot currently measure must not be silently cleared');
});

test('the scroll listener is passive — the rail is a touch-scrolled surface', () => {
  assert.match(SRC, /barRail\.addEventListener\('scroll', syncRailFade, \{ passive: true \}\)/);
});
