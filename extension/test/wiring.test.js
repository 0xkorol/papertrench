/*
 * Cross-script wiring contract.
 *
 * These are the seams that a unit test cannot see, because each file is
 * individually correct while the pair is broken. The shipped build was once
 * dead on arrival because `price-bridge.js` emitted a `tick` message while
 * `content.js` listened for `price`: two healthy files, no failing test, no
 * prices on screen. The same class of break happens when a script installs a
 * browser global under one name and its consumer reads another, or when a
 * script stops being listed in the manifest and therefore never loads.
 *
 * So these tests read the SHIPPED sources and assert the two ends agree.
 * Nothing here hardcodes an expected identifier: every name is extracted from
 * one file and looked for in the other, so renaming a message type or a global
 * on only one side fails, while renaming it consistently on both sides passes.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const bridge = read('price-bridge.js');
const content = read('content.js');
const manifest = JSON.parse(read('manifest.json'));

/**
 * A brand name appears in comments and UI strings as often as in code, and a
 * message type appears inside its own emit() helper. Strip comments and
 * string/template literals so only genuine identifier references are counted;
 * otherwise a prose mention would satisfy a "consumer reads this" assertion.
 */
function codeOnly(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') i++;
        i++;
      }
      i++;
      out += ' ';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const contentCode = codeOnly(content);

/** Globals a script hands to the rest of the extension via window/globalThis. */
function installedGlobals(src) {
  const found = [...src.matchAll(/(?:window|globalThis)\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)].map((m) => m[1]);
  return [...new Set(found)].filter((g) => /^(PT|Paper)/.test(g));
}

const isolatedScripts = manifest.content_scripts
  .filter((cs) => (cs.world || 'ISOLATED') === 'ISOLATED')
  .flatMap((cs) => cs.js);
const allDeclaredScripts = manifest.content_scripts.flatMap((cs) => cs.js);

test('the bridge and the content script agree on the message envelope tag', () => {
  const emittedTag = (bridge.match(/OUT_TAG\s*=\s*'([^']+)'/) || [])[1];
  const acceptedTag = (content.match(/event\.data\.source\s*!==\s*'([^']+)'/) || [])[1];
  assert.ok(emittedTag, 'price-bridge.js must define an OUT_TAG for its postMessage envelope');
  assert.ok(acceptedTag, 'content.js must filter incoming messages by an expected source tag');
  assert.strictEqual(
    emittedTag,
    acceptedTag,
    `bridge posts source '${emittedTag}' but content.js only accepts '${acceptedTag}' — every message would be dropped`
  );
});

test('every message type the bridge emits is handled by the content script', () => {
  const emitted = [...new Set([...bridge.matchAll(/\bemit\(\s*'([^']+)'/g)].map((m) => m[1]))];
  const handled = [...new Set([...content.matchAll(/ev\.type\s*===\s*'([^']+)'/g)].map((m) => m[1]))];

  assert.ok(emitted.length >= 2, `expected the bridge to emit several message types, saw ${JSON.stringify(emitted)}`);
  assert.ok(handled.length >= 2, `expected content.js to handle several message types, saw ${JSON.stringify(handled)}`);

  // 'ready' is a one-way lifecycle beacon the content script deliberately ignores.
  const requiresHandler = emitted.filter((t) => t !== 'ready');
  for (const type of requiresHandler) {
    assert.ok(
      handled.includes(type),
      `price-bridge.js emits '${type}' but content.js never handles it; emitted=${JSON.stringify(emitted)} handled=${JSON.stringify(handled)}`
    );
  }
});

test('the price path is wired end to end (the original tick-vs-price defect)', () => {
  const emitsTick = /\bemit\(\s*'tick'/.test(bridge);
  const handlesTick = /ev\.type\s*===\s*'tick'/.test(content);
  assert.ok(emitsTick, 'price-bridge.js must emit page-feed prices as a tick message');
  assert.ok(handlesTick, 'content.js must handle the tick message, or live prices never reach the overlay');
});

test('the content script does not listen for a message type nobody sends', () => {
  const emitted = new Set([...bridge.matchAll(/\bemit\(\s*'([^']+)'/g)].map((m) => m[1]));
  const handled = [...new Set([...content.matchAll(/ev\.type\s*===\s*'([^']+)'/g)].map((m) => m[1]))];
  for (const type of handled) {
    assert.ok(
      emitted.has(type),
      `content.js handles '${type}' but price-bridge.js never emits it — a dead branch or a renamed message`
    );
  }
});

test('every cross-script global the content script reads is installed by a loaded script', () => {
  const installedByLoadedScripts = new Set(isolatedScripts.flatMap((f) => installedGlobals(read(f))));
  const selfInstalled = installedGlobals(content);
  const consumed = [...new Set([...contentCode.matchAll(/\b((?:PT|Paper)[A-Z][A-Za-z]*)\b/g)].map((m) => m[1]))]
    .filter((g) => !selfInstalled.includes(g));

  assert.ok(
    consumed.length >= 4,
    `content.js should consume several cross-script globals; extraction found ${JSON.stringify(consumed)}`
  );
  for (const g of consumed) {
    assert.ok(
      installedByLoadedScripts.has(g),
      `content.js reads ${g} but no ISOLATED-world script in the manifest installs it; installed=${JSON.stringify([...installedByLoadedScripts])}`
    );
  }
});

test('the resolver and quote modules install the globals the content script reads', () => {
  const resolverGlobals = installedGlobals(read('resolver.js'));
  const quoteGlobals = installedGlobals(read('quote.js'));

  assert.ok(resolverGlobals.length > 0, 'resolver.js must install a browser global for content.js to call');
  assert.ok(quoteGlobals.length > 0, 'quote.js must install a browser global for content.js to call');

  for (const g of resolverGlobals) {
    assert.ok(new RegExp(`\\b${g}\\b`).test(contentCode), `resolver.js installs ${g} but content.js never calls it`);
  }
  for (const g of quoteGlobals) {
    assert.ok(new RegExp(`\\b${g}\\b`).test(contentCode), `quote.js installs ${g} but content.js never calls it`);
  }
});

test('every script the manifest declares exists on disk', () => {
  assert.ok(allDeclaredScripts.length > 0, 'the manifest must declare content scripts');
  for (const f of allDeclaredScripts) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `manifest declares ${f} but it is missing from the extension directory`);
  }
});

test('the bridge runs in the MAIN world at document_start so no page tick is missed', () => {
  const bridgeEntry = manifest.content_scripts.find((cs) => cs.js.includes('price-bridge.js'));
  assert.ok(bridgeEntry, 'price-bridge.js must be declared in the manifest');
  assert.strictEqual(bridgeEntry.world, 'MAIN', 'the bridge must run in the page world to observe the site feed');
  assert.strictEqual(
    bridgeEntry.run_at,
    'document_start',
    'the bridge must install before the page opens its socket, or early ticks are lost'
  );
});
