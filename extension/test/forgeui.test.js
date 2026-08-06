/* Forge — the DOM half, driven against a hand-built page.
 *
 * The two things that can silently ruin this feature live here, and neither
 * is visible in the pure core:
 *
 *  1. WHAT IT LATCHES ONTO. The paid checkout boxes are behind a login on
 *     every venue that has one, so Forge deliberately matches on DOM SHAPE —
 *     an image-accepting file input — rather than on class names nobody has
 *     verified. That gate has to be tight: a Generate chip on a CSV importer
 *     is a bug report, and a missing chip on a hidden-input dropzone (which
 *     is how nearly every styled uploader is built) is the feature not
 *     existing.
 *
 *  2. WHETHER THE FILE ACTUALLY LANDED. Setting `input.files` is the happy
 *     path; some sites take a drop instead, and some refuse both. The rule
 *     this suite pins is that Forge never SAYS it dropped the file unless the
 *     input is really holding it — an optimistic success message would send
 *     someone to a payment screen with an empty uploader.
 *
 * The fakes throw what a real locked-down input throws (DEFECT F-39: a fake
 * that merely lacks a capability proves nothing; it has to fail the way the
 * live site fails).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const FG = require(path.join(ROOT, 'forge-core.js'));

/* ---------------- a DOM, by hand ---------------- */

function makeEl(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    className: '', id: '', type: '', accept: '', innerHTML: '',
    textContent: '', title: '', href: '', src: '', alt: '', value: '', download: '',
    isConnected: true, parentElement: null, children: [], attrs: {},
    style: { cssText: '', setProperty() {} },
    events: {},
    __rect: null,
    files: null,
  };
  node.classList = {
    add(c) { node.className += (node.className ? ' ' : '') + c; },
    remove(c) { node.className = node.className.split(' ').filter((x) => x !== c).join(' '); },
    contains: (c) => node.className.split(' ').indexOf(c) !== -1,
  };
  node.appendChild = (child) => {
    node.children.push(child);
    child.parentElement = node;
    child.parentNode = node;
    return child;
  };
  node.insertBefore = (child, ref) => {
    const i = ref ? node.children.indexOf(ref) : -1;
    if (i === -1) node.children.push(child); else node.children.splice(i, 0, child);
    child.parentElement = node;
    child.parentNode = node;
    return child;
  };
  node.remove = () => {
    const p = node.parentElement;
    if (p) p.children = p.children.filter((c) => c !== node);
    node.parentElement = null;
    node.isConnected = false;
  };
  node.setAttribute = (k, v) => { node.attrs[k] = String(v); };
  node.getAttribute = (k) => (k in node.attrs ? node.attrs[k] : null);
  node.addEventListener = (t, fn) => { (node.events[t] = node.events[t] || []).push(fn); };
  node.removeEventListener = () => {};
  node.dispatchEvent = (ev) => {
    node.dispatched = node.dispatched || [];
    node.dispatched.push(ev && ev.type);
    (node.events[ev && ev.type] || []).forEach((fn) => fn(ev));
    return true;
  };
  node.getBoundingClientRect = () => node.__rect || { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
  node.attachShadow = () => {
    const root = makeEl('shadow-root');
    node.shadowRoot = root;
    return root;
  };
  node.closest = (sel) => {
    let cur = node;
    while (cur) {
      const tags = sel.split(',').map((s) => s.trim().toUpperCase());
      if (tags.indexOf(cur.tagName) !== -1) return cur;
      cur = cur.parentElement;
    }
    return null;
  };
  Object.defineProperty(node, 'innerText', {
    get() { return node.__text != null ? node.__text : node.textContent; },
    set(v) { node.__text = v; },
    configurable: true,
  });
  return node;
}

function rect(el, r) { el.__rect = Object.assign({ top: 0, left: 0, width: 0, height: 0 }, r); el.__rect.right = el.__rect.left + el.__rect.width; el.__rect.bottom = el.__rect.top + el.__rect.height; return el; }

/** A styled uploader: a visible dropzone wrapping a display:none file input. */
function uploader(copy, accept) {
  const zone = makeEl('div');
  zone.innerText = copy;
  rect(zone, { top: 200, left: 300, width: 420, height: 160 });
  const input = makeEl('input');
  input.type = 'file';
  input.accept = accept == null ? 'image/png,image/jpeg' : accept;
  rect(input, { top: 0, left: 0, width: 0, height: 0 });   // display:none
  zone.appendChild(input);
  return { zone, input };
}

function loadForge(opts) {
  const o = opts || {};
  const body = makeEl('body');
  const docEl = makeEl('html');
  const inputs = o.inputs || [];
  const sent = [];

  const document = {
    body, documentElement: docEl,
    title: o.title || '$0.0042 | BONK/SOL | Bonk | Raydium',
    createElement: (tag) => makeEl(tag),
    getElementById: (id) => (body.children.find((c) => c.id === id) || null),
    querySelector: (sel) => {
      if (/^meta/.test(sel)) return null;
      return null;
    },
    querySelectorAll: (sel) => {
      if (sel.indexOf('input[type="file"]') !== -1) return inputs.slice();
      return [];
    },
    addEventListener() {}, removeEventListener() {},
  };

  const sandbox = {
    console,
    setTimeout: (fn) => { fn(); return 1; },
    clearTimeout() {},
    requestAnimationFrame: (fn) => { fn(); return 1; },
    // Browser atob() throws InvalidCharacterError on anything that is not
    // base64; Buffer.from is lenient and silently returns junk. A fake that
    // is more forgiving than the real thing hides exactly the bug this suite
    // is here to catch (DEFECT F-39).
    atob: (s) => {
      const str = String(s);
      if (/[^A-Za-z0-9+/=\s]/.test(str)) throw new Error('InvalidCharacterError');
      return Buffer.from(str, 'base64').toString('binary');
    },
    Uint8Array, Array, Object, String, Number, Boolean, Math, JSON, Date, Set, Map, RegExp, Error,
    MutationObserver: function MutationObserver(cb) { this.cb = cb; this.observe = () => {}; this.disconnect = () => {}; },
    File: function File(parts, name, opts2) { this.name = name; this.type = (opts2 || {}).type; this.parts = parts; },
    Event: function Event(type) { this.type = type; },
    DragEvent: function DragEvent(type, init) { this.type = type; this.dataTransfer = (init || {}).dataTransfer; },
    DataTransfer: o.DataTransfer || function DataTransfer() {
      this.__items = [];
      this.items = { add: (f) => { this.__items.push(f); } };
      Object.defineProperty(this, 'files', { get: () => this.__items.slice() });
    },
    document,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.window.innerWidth = 1280;
  sandbox.window.innerHeight = 800;
  sandbox.window.addEventListener = () => {};
  sandbox.window.removeEventListener = () => {};
  sandbox.window.PTForge = FG;
  sandbox.window.PaperTrenchSites = {
    currentSite: () => ({ detect: () => ({ kind: 'mint', address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' }) }),
    firstBase58: () => null,
  };
  sandbox.chrome = {
    runtime: {
      id: 'test-extension-id',
      sendMessage: (payload) => { sent.push(payload); return Promise.resolve(o.reply || null); },
    },
    storage: {
      local: { get: (_keys, cb) => cb({ pt_settings: o.settings || { forgeEnabled: true } }) },
      onChanged: { addListener: () => {} },
    },
  };

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'forge.js'), 'utf8'), sandbox, { filename: 'forge.js' });
  return { api: sandbox.window.__ptForge, sandbox, sent, body };
}

/* ---------------- what it latches onto ---------------- */

test('a hidden file input behind a styled dropzone still gets a chip', () => {
  // This is how nearly every uploader on the web is built. Anchoring on the
  // input's own (zero-sized) box would put the chip nowhere.
  const { zone, input } = uploader('Header image\nRecommended 1500 x 500 px', 'image/*');
  const { api } = loadForge({ inputs: [input] });
  const slots = api.slotsNow();
  assert.equal(slots.length, 1);
  assert.equal(slots[0].anchor, zone, 'the chip must anchor to the visible dropzone, not the invisible input');
  assert.equal(slots[0].chip.className, 'chip');
});

test('the size and kind come off the box, not off a table we made up', () => {
  const { input } = uploader('Header image — recommended 1500 x 500 px, PNG', 'image/*');
  const { api } = loadForge({ inputs: [input] });
  const slot = api.slotsNow()[0];
  assert.equal(slot.kind, 'header');
  assert.equal(slot.spec.w, 1500);
  assert.equal(slot.spec.h, 500);
  assert.equal(slot.spec.source, 'page');
});

test('a box that states no size falls back to a preset and says so', () => {
  const { input } = uploader('Drop your token logo here', 'image/*');
  const { api } = loadForge({ inputs: [input] });
  const slot = api.slotsNow()[0];
  assert.equal(slot.kind, 'icon');
  assert.equal(slot.spec.source, 'preset');
  assert.equal(slot.spec.w, FG.ASSET_KINDS.icon.w);
});

test('a CSV importer never grows a Generate chip', () => {
  const { input } = uploader('Import your holder list', '.csv,text/csv');
  const { api } = loadForge({ inputs: [input] });
  assert.equal(api.slotsNow().length, 0);
});

test('an input with no accept attribute is judged by the copy around it', () => {
  const withCopy = uploader('Upload your project banner', '');
  assert.equal(loadForge({ inputs: [withCopy.input] }).api.slotsNow().length, 1);

  const withoutCopy = uploader('Attach supporting documents', '');
  assert.equal(loadForge({ inputs: [withoutCopy.input] }).api.slotsNow().length, 0,
    'an unlabelled uploader must not be assumed to want a picture');
});

test('nothing at all happens while the setting is off', () => {
  const { input } = uploader('Header image 1500x500', 'image/*');
  const { api, sent } = loadForge({ inputs: [input], settings: { forgeEnabled: false } });
  assert.equal(api.slotsNow().length, 0);
  assert.equal(sent.length, 0, 'a disabled feature must not even prewarm — that would spend a key');
});

/* ---------------- the prefetch ---------------- */

test('spotting an upload box starts the narrative research immediately', () => {
  const { input } = uploader('Header image 1500x500', 'image/*');
  const { sent } = loadForge({ inputs: [input] });
  const warm = sent.filter((m) => m.type === 'pt_forge_prewarm');
  assert.equal(warm.length, 1, 'the brief should be in flight before the user clicks anything');
  assert.equal(warm[0].facts.mint, 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
  assert.equal(warm[0].facts.symbol, 'BONK', 'the ticker is read off the page title');
});

test('the research is only kicked off once per token', () => {
  const { input } = uploader('Header image 1500x500', 'image/*');
  const { api, sent } = loadForge({ inputs: [input] });
  api.scan();
  api.scan();
  assert.equal(sent.filter((m) => m.type === 'pt_forge_prewarm').length, 1);
});

/* ---------------- delivery ---------------- */

function deliverFixture(loadOpts) {
  const { zone, input } = uploader('Header image 1500x500', 'image/*');
  const { api, sandbox } = loadForge(Object.assign({ inputs: [input] }, loadOpts || {}));
  const slot = api.slotsNow()[0];
  const status = makeEl('p');
  const holder = makeEl('div');
  holder.appendChild(status);
  const img = { dataUrl: 'data:image/png;base64,' + Buffer.from('fake-png-bytes').toString('base64'), w: 1500, h: 500 };
  api.useImage(slot, img, { symbol: 'BONK' }, status);
  return { slot, input, zone, status, holder, sandbox };
}

test('the file is set on the input and the site is told, the way a human upload does it', () => {
  const { input, status } = deliverFixture();
  assert.equal(input.files.length, 1);
  assert.equal(input.files[0].name, 'bonk-header-1500x500.png');
  assert.equal(input.files[0].type, 'image/png');
  // React and friends listen for change; input keeps plain listeners happy.
  assert.deepEqual(input.dispatched, ['input', 'change']);
  assert.match(status.textContent, /Dropped into the upload box/);
  assert.match(status.textContent, /before you pay/, 'never imply we completed their purchase');
});

test('a box that refuses a scripted file assignment gets a real drop instead', () => {
  // Some uploaders freeze `files`; assigning throws rather than no-oping.
  const { zone, input } = uploader('Header image 1500x500', 'image/*');
  Object.defineProperty(input, 'files', {
    get: () => null,
    set() { throw new TypeError('Cannot set property files of #<HTMLInputElement>'); },
    configurable: true,
  });
  const { api } = loadForge({ inputs: [input] });
  const slot = api.slotsNow()[0];
  const status = makeEl('p');
  makeEl('div').appendChild(status);
  api.useImage(slot, { dataUrl: 'data:image/png;base64,' + Buffer.from('x').toString('base64'), w: 1500, h: 500 }, { symbol: 'BONK' }, status);

  assert.deepEqual(zone.dispatched, ['dragenter', 'dragover', 'drop'],
    'the dropzone must receive a real drag sequence, not just a drop');
  assert.match(status.textContent, /Dropped into the upload box/);
});

test('when the file genuinely did not land, Forge says so instead of lying', () => {
  const { input } = uploader('Header image 1500x500', 'image/*');
  // Assignment silently does nothing (the sneakier real-world case) AND the
  // zone rejects synthetic drags.
  Object.defineProperty(input, 'files', { get: () => ({ length: 0 }), set() {}, configurable: true });
  input.parentElement.dispatchEvent = () => { throw new Error('synthetic drag rejected'); };
  const { api } = loadForge({ inputs: [input] });
  const slot = api.slotsNow()[0];
  const status = makeEl('p');
  makeEl('div').appendChild(status);
  api.useImage(slot, { dataUrl: 'data:image/png;base64,' + Buffer.from('x').toString('base64'), w: 1500, h: 500 }, { symbol: 'BONK' }, status);

  assert.match(status.textContent, /would not accept a scripted file/);
  assert.equal(status.className, 'status err');
  assert.doesNotMatch(status.textContent, /Dropped into/);
});

test('the artwork is always downloadable, even when the drop failed', () => {
  const { status, holder } = deliverFixture();
  const link = holder.children.find((c) => c.tagName === 'A');
  assert.ok(link, 'a download link is the fallback that always works');
  assert.equal(link.download, 'bonk-header-1500x500.png');
  assert.match(link.href, /^data:image\/png;base64,/);
  assert.ok(holder.children.indexOf(link) > holder.children.indexOf(status));
});

test('a corrupt data URL fails loudly rather than delivering an empty file', () => {
  const { zone, input } = uploader('Header image 1500x500', 'image/*');
  const { api } = loadForge({ inputs: [input] });
  const slot = api.slotsNow()[0];
  const status = makeEl('p');
  makeEl('div').appendChild(status);
  api.useImage(slot, { dataUrl: 'not-a-data-url', w: 1, h: 1 }, { symbol: 'BONK' }, status);
  assert.equal(status.className, 'status err');
  assert.equal(input.files, null, 'nothing must reach the input when the payload is broken');
  assert.equal(zone.dispatched, undefined);
});
