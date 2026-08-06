/* site-bridge.js — the papertrench.com page relay.
 *
 * The relay is a trust boundary: page messages are untrusted input even on
 * our own site (any script the page runs can postMessage), so what these
 * tests pin is mostly refusals — wrong origin, wrong window, malformed
 * handle, and above all the CLOSED op set: the relay carries exactly the two
 * bridge requests the externally_connectable path serves, and no other
 * background message type can be smuggled through it from page context.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const ORIGIN = 'https://papertrench.com';

function loadRelay() {
  const messageListeners = [];
  const sent = [];      // chrome.runtime.sendMessage payloads
  const posted = [];    // window.postMessage frames
  const windowObj = {
    addEventListener: (type, fn) => { if (type === 'message') messageListeners.push(fn); },
    postMessage: (data, targetOrigin) => { posted.push({ data, targetOrigin }); },
  };
  const sandbox = {
    console, JSON, Object, String, Array, Promise, RegExp,
    location: { origin: ORIGIN },
    window: windowObj,
    chrome: {
      runtime: {
        sendMessage: (message) => {
          sent.push(message);
          return Promise.resolve({ ok: true, answered: message.type });
        },
      },
    },
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'site-bridge.js'), 'utf8'), context,
    { filename: 'site-bridge.js' });
  return {
    sent,
    posted,
    windowObj,
    // Deliver a message event the way the page would produce it. Source
    // defaults to the relay's own window (the only source it may trust).
    deliver(data, over) {
      const event = Object.assign({ source: windowObj, origin: ORIGIN, data }, over || {});
      for (const fn of messageListeners) fn(event);
    },
    // The bridge reply path resolves through a promise chain; one macrotask
    // is enough for it to land.
    tick: () => new Promise((resolve) => setImmediate(resolve)),
  };
}

test('the relay announces itself so the page can tell "absent" from "slow"', () => {
  const relay = loadRelay();
  assert.deepEqual(JSON.parse(JSON.stringify(relay.posted[0])), {
    data: { type: 'pt_site_bridge_ready' },
    targetOrigin: ORIGIN,
  });
});

test('a signed-in identity is forwarded to the background', () => {
  const relay = loadRelay();
  relay.deliver({ type: 'pt_site_identity', handle: 'amogus0471' });
  assert.deepEqual(JSON.parse(JSON.stringify(relay.sent)), [{ type: 'pt_site_identity', handle: 'amogus0471' }]);
});

test('wrong origin, foreign window, and malformed handles are all dropped silently', () => {
  const relay = loadRelay();
  relay.deliver({ type: 'pt_site_identity', handle: 'legit' }, { origin: 'https://evil.example' });
  relay.deliver({ type: 'pt_site_identity', handle: 'legit' }, { source: {} });
  relay.deliver({ type: 'pt_site_identity', handle: 'has spaces' });
  relay.deliver({ type: 'pt_site_identity', handle: 'x'.repeat(16) });
  relay.deliver({ type: 'pt_site_identity', handle: 42 });
  relay.deliver({ type: 'pt_site_identity' });
  assert.deepEqual(JSON.parse(JSON.stringify(relay.sent)), [], 'nothing observed may reach the background');
});

test('bridge requests round-trip with the caller\'s nonce', async () => {
  const relay = loadRelay();
  relay.deliver({ type: 'pt_site_bridge', nonce: 'n-123', request: { type: 'pt_bridge_ping' } });
  await relay.tick();
  assert.deepEqual(JSON.parse(JSON.stringify(relay.sent)), [{ type: 'pt_bridge_ping', viaSiteRelay: true }]);
  const reply = relay.posted.find((p) => p.data && p.data.type === 'pt_site_bridge_reply');
  assert.ok(reply, 'a reply frame must be posted back to the page');
  assert.equal(reply.data.nonce, 'n-123', 'the reply must carry the request nonce');
  assert.equal(reply.data.reply.answered, 'pt_bridge_ping');
  assert.equal(reply.targetOrigin, ORIGIN, 'replies are origin-locked, never *');
});

test('the op set is CLOSED — no other background message type can be smuggled through', async () => {
  const relay = loadRelay();
  for (const op of ['pt_attest_append', 'pt_site_identity', 'pt_resolve', 'pt_state', '']) {
    relay.deliver({ type: 'pt_site_bridge', nonce: 'n-evil', request: { type: op } });
  }
  relay.deliver({ type: 'pt_site_bridge', request: { type: 'pt_bridge_ping' } }); // no nonce
  await relay.tick();
  assert.deepEqual(JSON.parse(JSON.stringify(relay.sent)), [], 'only pt_bridge_ping and pt_bridge_get_record may relay');
});
