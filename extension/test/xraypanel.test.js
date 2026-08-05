/* X-Ray — the card itself (v2.6.0).
 *
 * The render path IS the product surface of this feature: a throw inside it
 * means no card at all, which reads to a user as "PaperTrench does nothing on
 * X". The suite has no browser and the project has no dependencies, so the
 * panel is driven here against a hand-built DOM and asserted on the text a
 * user would actually read — including the honesty labels that must survive
 * every future refactor:
 *
 *   - a change counter NEVER appears without the window it was observed over
 *   - CA history and Smart Following always state where they came from
 *   - X's own system pages get no card at all
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function loadCore() {
  const sandbox = {
    self: {}, URL, URLSearchParams, Set, Map, String, RegExp, JSON, Math, Date,
    Number, Array, Object, Boolean, isNaN, parseInt,
  };
  sandbox.self.self = sandbox.self;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'xray-core.js'), 'utf8'), sandbox, { filename: 'xray-core.js' });
  return sandbox.self.PTXRay;
}

const XR = loadCore();
const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

const CA = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const CA2 = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';
const T0 = Date.UTC(2026, 6, 1, 12, 0, 0);
const DAY = 86_400_000;

function userNodeCore() {
  return {
    __typename: 'User',
    rest_id: '1450000000000000001',
    is_blue_verified: true,
    core: { created_at: 'Wed Oct 10 20:19:24 +0000 2018', name: 'Degen Labs', screen_name: 'degenlabs' },
    avatar: { image_url: 'https://pbs.twimg.com/profile_images/1/a.jpg' },
    legacy: {
      description: 'building in the trenches ' + CA,
      entities: { description: { urls: [{ expanded_url: 'https://pump.fun/coin/' + CA2 }] } },
      followers_count: 128_400,
      friends_count: 312,
    },
  };
}

function tweetNode(id, text, createdAt) {
  return {
    rest_id: id,
    legacy: {
      full_text: text,
      user_id_str: '1450000000000000001',
      created_at: createdAt,
      entities: { urls: [] },
    },
  };
}

function follower(id, handle, followers) {
  return {
    restId: id, handle, name: handle, followers, following: 100,
    verified: true, avatar: null, bio: null, urls: [], createdAt: null,
  };
}

/* ---------------- a DOM, by hand ---------------- */

function makeNode(tagName) {
  const node = {
    tagName: String(tagName).toUpperCase(),
    className: '', id: '', textContent: '', title: '', href: '', src: '', alt: '',
    referrerPolicy: '', isConnected: false, parentNode: null, shadow: null,
    style: { cssText: '' },
    children: [],
    attrs: {},
  };
  node.classList = {
    add(c) { node.className += ' ' + c; },
    remove() {},
    toggle(c, on) { if (on) node.classList.add(c); },
    contains: (c) => node.className.includes(c),
  };
  node.appendChild = (child) => {
    node.children.push(child);
    child.parentNode = node;
    child.isConnected = node.isConnected;
    return child;
  };
  node.append = (...kids) => { for (const k of kids) node.appendChild(k); };
  node.removeChild = (child) => {
    const i = node.children.indexOf(child);
    if (i !== -1) node.children.splice(i, 1);
    child.parentNode = null;
    child.isConnected = false;
    return child;
  };
  node.replaceChildren = (...kids) => { node.children = []; for (const k of kids) node.appendChild(k); };
  node.setAttribute = (k, v) => { node.attrs[k] = String(v); };
  node.getAttribute = (k) => (Object.hasOwn(node.attrs, k) ? node.attrs[k] : null);
  node.addEventListener = () => {};
  node.attachShadow = () => { node.shadow = makeNode('#shadow'); node.shadow.isConnected = true; return node.shadow; };
  Object.defineProperty(node, 'firstChild', { get: () => node.children[0] || null });
  return node;
}

/** Every string the user would read, in document order. */
function visibleText(node) {
  if (!node) return '';
  const own = node.textContent || '';
  const inner = node.shadow ? visibleText(node.shadow) : '';
  const kids = (node.children || []).map(visibleText).join(' ');
  return [own, inner, kids].filter(Boolean).join(' ');
}

/** A profile header as the panel's dock sees it: a handful of anchor nodes
 * that answer querySelector and report hand-picked geometry. */
function installProfileHeader(doc, spec) {
  const rect = (r) => ({ width: r.right - r.left, height: r.bottom - r.top, ...r });
  const geoNode = (r, text) => {
    const n = makeNode('div');
    n.getBoundingClientRect = () => rect(r);
    if (text) n.textContent = text;
    return n;
  };
  const col = geoNode(spec.col);
  const name = geoNode(spec.name, spec.nameText);
  const tabs = geoNode(spec.tabs);
  const actions = spec.actions ? geoNode(spec.actions) : null;
  // Stack rows carry the marker the panel's selector would match them by
  // (a data-testid or an href tail); rows without one act as the bio. The
  // fake only hands back rows the given selector actually names, so a test
  // can put a row in the header that the dock is expected to ignore.
  const stack = (spec.stack || []).map((r) => ({ marker: r.marker || 'UserDescription', node: geoNode(r) }));
  col.querySelector = (sel) => {
    if (sel.includes('UserName')) return name;
    if (sel.includes('tablist')) return tabs;
    if (sel.includes('placementTracking') || sel.includes('editProfileButton') || sel.includes('userActions')) return actions;
    return null;
  };
  col.querySelectorAll = (sel) => stack.filter((s) => sel.includes(s.marker)).map((s) => s.node);
  doc.querySelector = (sel) => (sel.includes('primaryColumn') ? col : null);
}

/** Geometry shaped like a real profile: a 600px column, the Follow row at the
 * top right, a narrow name/bio stack on the left, tabs at y=520. The dead
 * zone this leaves is the space the card should claim. */
function roomyHeader(overrides = {}) {
  return {
    nameText: 'Degen Labs @degenlabs',
    col: { left: 0, top: 0, right: 600, bottom: 900 },
    actions: { left: 400, top: 90, right: 584, bottom: 126 },
    name: { left: 16, top: 140, right: 200, bottom: 190 },
    tabs: { left: 0, top: 520, right: 600, bottom: 573 },
    stack: [{ left: 16, top: 196, right: 220, bottom: 216 }],
    ...overrides,
  };
}

function mountPanel(opts = {}) {
  const doc = {};
  doc.createElement = (tag) => makeNode(tag);
  doc.body = makeNode('body');
  doc.body.isConnected = true;
  if (opts.header) installProfileHeader(doc, opts.header);

  const listeners = { message: [] };
  const posted = [];
  const sent = [];
  const timers = [];
  const pathname = opts.path || '/degenlabs';

  const win = {
    location: { pathname, search: '', href: 'https://x.com' + pathname, origin: 'https://x.com' },
    scrollX: 0,
    scrollY: opts.scrollY || 0,
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener: () => {},
    postMessage: (data) => posted.push(data),
  };
  win.window = win;
  win.self = win;

  const sandbox = {
    window: win, self: win, document: doc, location: win.location,
    navigator: { clipboard: { writeText: () => {} } },
    console: { debug: () => {}, warn: () => {}, error: () => {} },
    setTimeout: (fn) => { timers.push({ kind: 'timeout', fn }); return timers.length; },
    clearTimeout: () => {},
    setInterval: (fn) => { timers.push({ kind: 'interval', fn }); return timers.length; },
    clearInterval: () => {},
    Promise, JSON, Math, Date, Number, String, Array, Object, Boolean, RegExp, Error, Set, Map, URL,
    chrome: {
      runtime: {
        id: 'papertrench-test',
        sendMessage: (msg) => {
          sent.push(msg);
          if (msg.type === 'pt_xray_get') return Promise.resolve({ ok: true, intel: opts.intel || null });
          if (msg.type === 'pt_xray_observe') return Promise.resolve({ ok: true, intel: opts.observedIntel || null });
          if (msg.type === 'pt_xray_plan') return Promise.resolve({ ok: true, scan: opts.scan || null });
          return Promise.resolve({});
        },
      },
      storage: {
        local: {
          get: (keys, cb) => cb({ pt_settings: opts.settings || { appEnabled: true, xrayEnabled: true } }),
          set: () => {},
        },
        onChanged: { addListener: () => {} },
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'xray-panel.js'), 'utf8'), sandbox, { filename: 'xray-panel.js' });

  return {
    doc, sent, posted, timers,
    text() { return visibleText(doc.body); },
    settle() { return new Promise((resolve) => setImmediate(resolve)); },
    fireMessage(data) { for (const fn of listeners.message) fn({ source: win, data }); },
    card() { return doc.body.children.find((c) => c.id === 'papertrench-xray') || null; },
    wrap() { const c = this.card(); return c && c.shadow ? c.shadow.children[1] : null; },
  };
}

/** A realistic intel object, produced by the REAL view model and passed
 * through JSON exactly as a chrome.runtime message would be. */
function intelFixture() {
  const record = XR.observeUser(null, XR.userFromNode(userNodeCore()), T0).record;
  XR.observeTweets(record, [
    XR.tweetFromNode(tweetNode('1800000000000000001', 'launch ' + CA, 'Fri May 02 18:30:00 +0000 2025')),
  ], T0);
  XR.mergeSmart(record, [
    follower('900', 'whale', 3_000_000),
    follower('901', 'smallish', 4_000),
  ], 'you_follow', T0);
  return plain(XR.assembleIntel(record, T0 + DAY));
}

/* ---------------- tests ---------------- */

test('a profile with nothing known yet gets a card that says what it is doing', async () => {
  const panel = mountPanel({ intel: null });
  await panel.settle();
  const text = panel.text();
  assert.match(text, /X-Ray/);
  assert.match(text, /@degenlabs/, 'the header names the account the card is about');
  assert.match(text, /Give it a second/, 'an empty state — never a blank box');
  assert.ok(panel.sent.some((m) => m.type === 'pt_xray_get' && m.handle === 'degenlabs'),
    'stored intel is asked for immediately — that is what makes the card instant');
});

test('the full intel view renders, honesty labels included', async () => {
  const panel = mountPanel({ intel: intelFixture() });
  await panel.settle();
  const text = panel.text();

  assert.match(text, /@degenlabs/);
  assert.match(text, /Created/, 'account age is stated');
  assert.match(text, /128\.4K followers/);
  assert.match(text, /No change seen/, 'an unchanged bio says so plainly');
  assert.match(text, /watching since/,
    'a change counter must NEVER appear without the window it was observed over');
  assert.match(text, /1 CA found/);
  assert.match(text, /DezX…B263/, 'the address is shown in a copyable chip');
  assert.match(text, /Smart Following/);
  assert.match(text, /★/, 'the genuinely big follower is marked');
  assert.match(text, /whale/);
  assert.match(text, /from followers you know/, 'provenance for the follower list');
  assert.match(text, /from posts read back to/, 'and for the CA history');
});

test('a bio edit and a live bio CA surface as the loud items they are', async () => {
  let record = XR.observeUser(null, XR.userFromNode(userNodeCore()), T0).record;
  const edited = userNodeCore();
  edited.legacy.description = 'new thing incoming';
  edited.core.name = 'Trench Capital';
  record = XR.observeUser(record, XR.userFromNode(edited), T0 + DAY).record;

  const panel = mountPanel({ intel: plain(XR.assembleIntel(record, T0 + DAY)) });
  await panel.settle();
  const text = panel.text();
  assert.match(text, /1 change seen/);
  assert.match(text, /was: building in the trenches/, 'the previous bio is shown, not just a count');
  assert.match(text, /CA in bio right now/, 'the bio link still carries a contract address');
});

test('X system pages get no card at all', async () => {
  for (const route of ['/home', '/messages', '/i/communities/123', '/settings/account', '/explore', '/']) {
    const panel = mountPanel({ path: route, intel: intelFixture() });
    await panel.settle();
    assert.equal(panel.text().trim(), '', route + ' must render no card');
    assert.equal(panel.sent.length, 0, route + ' must not even ask for intel');
  }
});

test('a post page shows the author of the post being read', async () => {
  const panel = mountPanel({ path: '/degenlabs/status/1800000000000000001', intel: intelFixture() });
  await panel.settle();
  assert.match(panel.text(), /@degenlabs/,
    'vetting a launch tweet is exactly when the poster\'s history matters most');
});

test('with the feature off — or PaperTrench off — the panel does nothing at all', async () => {
  const off = mountPanel({ settings: { appEnabled: true, xrayEnabled: false }, intel: intelFixture() });
  await off.settle();
  assert.equal(off.text().trim(), '');
  assert.equal(off.sent.length, 0);

  const master = mountPanel({ settings: { appEnabled: false, xrayEnabled: true }, intel: intelFixture() });
  await master.settle();
  assert.equal(master.text().trim(), '', 'the master switch outranks the feature toggle');
});

test('digests from the page world are forwarded and repaint the card in place', async () => {
  const panel = mountPanel({ intel: null, observedIntel: intelFixture() });
  await panel.settle();
  assert.doesNotMatch(panel.text(), /whale/);

  panel.fireMessage({ source: 'papertrench-xray-digest', digest: { op: 'UserByScreenName', users: [], tweets: [] } });
  await panel.settle();

  const forwarded = panel.sent.find((m) => m.type === 'pt_xray_observe');
  assert.ok(forwarded, 'the digest must reach the background');
  assert.equal(forwarded.handle, 'degenlabs', 'tagged with the route it was seen on');
  assert.match(panel.text(), /whale/, 'and the returned intel repaints the card');

  const before = panel.sent.length;
  panel.fireMessage({ source: 'something-else', digest: { op: 'UserTweets' } });
  await panel.settle();
  assert.equal(panel.sent.length, before, 'messages that are not X-Ray digests are ignored');
});

/* ---------------- placement ----------------
 *
 * The card belongs in the profile header's dead zone — right of the name
 * stack, under the Follow row, above the tabs — so the intel reads as part
 * of the profile. Floating is the fallback, never the default on a profile
 * that has room. */

test('on a profile with room, the card docks into the header dead zone', async () => {
  const panel = mountPanel({ intel: intelFixture(), header: roomyHeader() });
  await panel.settle();
  const style = panel.card().style.cssText;
  assert.match(style, /position:absolute/, 'docked into the page, not fixed over it');
  assert.match(style, /top:138px/, 'below the Follow row (126) plus the gap');
  assert.match(style, /left:274px/, 'right-aligned in the 600px column: 600 - 16 - 310');
  assert.equal(panel.wrap().style.maxHeight, '370px',
    'capped above the tabs at 520 — the card must never cover Posts/Replies');
  assert.match(panel.text(), /@degenlabs/, 'and it is still the same card');
});

test('a dock accounts for page scroll — document coordinates, not viewport', async () => {
  const panel = mountPanel({ intel: intelFixture(), header: roomyHeader(), scrollY: 50 });
  await panel.settle();
  assert.match(panel.card().style.cssText, /top:188px/, '138 viewport + 50 scrolled');
});

test('joined-date and followed-by tails may sit under the card', async () => {
  // Real profiles almost always have these rows reaching into the right-side
  // space (the shape of @AutorunAlert on 2026-08-05, where a no-overlap rule
  // floated the card). The card replaces both facts with richer versions, so
  // they must not block the dock.
  const busy = roomyHeader({
    stack: [
      { left: 16, top: 196, right: 220, bottom: 216 },                                  // bio
      { marker: 'UserJoinDate', left: 16, top: 230, right: 420, bottom: 250 },          // joined tail
      { marker: 'followers_you_follow', left: 16, top: 290, right: 400, bottom: 310 },  // Followed by …
    ],
  });
  const panel = mountPanel({ intel: intelFixture(), header: busy });
  await panel.settle();
  assert.match(panel.card().style.cssText, /position:absolute/,
    'rows the card supersedes are coverable, not blockers');
});

test('the website link is irreplaceable, so a long URL blocks the dock', async () => {
  const longUrl = roomyHeader({
    stack: [{ marker: 'UserUrl', left: 16, top: 230, right: 420, bottom: 250 }],
  });
  const panel = mountPanel({ intel: intelFixture(), header: longUrl });
  await panel.settle();
  assert.match(panel.card().style.cssText, /position:fixed/,
    'the profile link is scam-vetting info the card does not carry');
});

test('a wide bio leaves no dead zone, so the card floats like before', async () => {
  const wide = roomyHeader({ stack: [{ left: 16, top: 196, right: 560, bottom: 216 }] });
  const panel = mountPanel({ intel: intelFixture(), header: wide });
  await panel.settle();
  assert.match(panel.card().style.cssText, /position:fixed/,
    'overlapping the bio would hide the very text the trader is vetting');
});

test('a squeezed header floats rather than docking a card too short to read', async () => {
  const short = roomyHeader({ tabs: { left: 0, top: 260, right: 600, bottom: 313 } });
  const panel = mountPanel({ intel: intelFixture(), header: short });
  await panel.settle();
  assert.match(panel.card().style.cssText, /position:fixed/);
});

test('a lingering header from the previous profile is never docked against', async () => {
  const stale = roomyHeader({ nameText: 'Someone Else @someoneelse' });
  const panel = mountPanel({ intel: intelFixture(), header: stale });
  await panel.settle();
  assert.match(panel.card().style.cssText, /position:fixed/,
    'during SPA navigation the old header lingers; wrong geometry is worse than floating');
});

test('post pages and headerless moments keep the floating card', async () => {
  const post = mountPanel({
    path: '/degenlabs/status/1800000000000000001',
    intel: intelFixture(),
    header: roomyHeader(),
  });
  await post.settle();
  assert.match(post.card().style.cssText, /position:fixed/,
    'a post page has no profile header to dock into, even if one is still in the DOM');

  const bare = mountPanel({ intel: intelFixture() });
  await bare.settle();
  assert.match(bare.card().style.cssText, /position:fixed/,
    'before the header renders the card still paints — instantly, floating');
});

test('the observer is told the toggle state so it can stop reading responses', async () => {
  const panel = mountPanel({ intel: null });
  await panel.settle();
  const state = panel.posted.find((m) => m && m.source === 'papertrench-xray-state');
  assert.ok(state, 'the panel must report the toggle to the MAIN world');
  assert.equal(state.enabled, true);
});
