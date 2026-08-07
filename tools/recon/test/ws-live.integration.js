'use strict';
// HERMETIC live integration check for the WebSocket path — the one headline
// capability that real sites left unexercised (DexScreener's socket 403s under
// automation, so no real frames ever flowed). This stands up a zero-dep
// HTTP+WS server, serves a page that ticks a price from WS frames into the DOM,
// captures it with the real rig, and asserts the whole chain: frames captured →
// channel built with a schema → the DOM price correlated to the WS origin.
//
// It launches Chrome, so it is NOT part of `node --test` (which must stay
// hermetic/fast). Run it directly when the capture rig or WS path changes:
//   node tools/recon/test/ws-live.integration.js
// Exits non-zero on failure.

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { runCapture } = require('../lib/capture');

const CHROME = process.env.PT_RECON_CHROME
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

// --- minimal RFC6455 server-to-client text frame (unmasked, <64KiB) ---------
function encodeTextFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else {
    header = Buffer.from([0x81, 126, (len >> 8) & 0xff, len & 0xff]);
  }
  return Buffer.concat([header, payload]);
}

const PAGE = (port) => `<!doctype html><html><body>
<div id="price">–</div>
<script>
  var el = document.getElementById('price');
  var ws = new WebSocket('ws://127.0.0.1:${port}/feed');
  ws.onmessage = function (ev) {
    try { var m = JSON.parse(ev.data); if (m.price) el.textContent = '$' + m.price; } catch (e) {}
  };
</script>
</body></html>`;

async function main() {
  // A distinctive, changing price so the probe sees it tick AND the correlator
  // can tie it to the WS origin (distinctive = fractional, survives the filter).
  let tick = 0;
  const prices = ['0.0123456', '0.0123478', '0.0123512', '0.0123549', '0.0123588', '0.0123601'];

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE(server.address().port));
  });

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const accept = crypto.createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const timer = setInterval(() => {
      if (socket.destroyed) { clearInterval(timer); return; }
      const price = prices[Math.min(tick, prices.length - 1)];
      tick++;
      try {
        socket.write(encodeTextFrame(JSON.stringify({ type: 'tick', price, seq: tick })));
      } catch (e) { clearInterval(timer); }
    }, 700);
    socket.on('close', () => clearInterval(timer));
    socket.on('error', () => clearInterval(timer));
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/`;
  process.stderr.write(`[ws-live] server on ${url}\n`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ptrecon-wslive-'));
  const capDir = path.join(tmp, 'cap');
  fs.mkdirSync(capDir, { recursive: true });

  process.stderr.write('[ws-live] capturing (headless, ~30s)…\n');
  const manifest = await runCapture({
    site: 'wslocal', capDir, chrome: CHROME,
    profileDir: path.join(tmp, 'profile'), headless: true,
    startUrl: 'about:blank', autoUrls: [url], minutes: 0, lingerSec: 12,
  });
  server.close();

  process.stderr.write(`[ws-live] captured: ${JSON.stringify(manifest.counts)}\n`);

  // ---- assertions on the raw capture --------------------------------------
  const wsLines = fs.readFileSync(path.join(capDir, 'raw', 'ws.jsonl'), 'utf8')
    .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const frames = wsLines.filter((w) => w.dir === 'in' && w.payload !== undefined);
  assert.ok(frames.length >= 3, `expected >=3 inbound WS frames, got ${frames.length}`);
  const sample = JSON.parse(frames[0].payload);
  assert.equal(sample.type, 'tick', 'frame payload should parse to our tick shape');
  assert.ok(sample.price, 'frame carries a price');

  // ---- distill and assert the WS channel + provenance ---------------------
  const { distill } = require('../lib/distill');
  const outDir = path.join(tmp, 'dossier');
  const res = distill(capDir, outDir, {});
  assert.ok(res.counts.wsChannels >= 1, `expected a WS channel, got ${res.counts.wsChannels}`);

  const ws = JSON.parse(fs.readFileSync(path.join(outDir, 'ws.json'), 'utf8'));
  const ch = ws.find((c) => (c.discriminators && Object.keys(c.discriminators).some((k) => k.startsWith('type='))));
  assert.ok(ch, 'the WS channel should have a type= discriminator (frame taxonomy)');
  assert.ok((ch.schema || []).some((line) => /price/.test(line)), 'WS schema should carry the price key');

  const prov = JSON.parse(fs.readFileSync(path.join(outDir, 'provenance.json'), 'utf8'));
  const priceNode = prov.find((p) => p.changes >= 2 && p.topOrigins.some((o) => o.kind === 'ws'));
  assert.ok(priceNode, 'the ticking DOM price must correlate to the WS origin');
  // A live role — either the generic ws-stream or, if the URL names it (our
  // /feed path does), the more specific market-shaped. Both mean "live", not history.
  const wsRole = priceNode.topOrigins.find((o) => o.kind === 'ws').role;
  assert.ok(['ws-stream', 'market-shaped'].includes(wsRole), `WS origin should be a live role, got ${wsRole}`);

  process.stderr.write('\n[ws-live] PASS — frames captured, channel schema built, DOM price tied to the WS origin.\n');
  // Best-effort cleanup: Chrome may still hold the profile dir during shutdown
  // (EPERM on Windows). The assertions above are what matter.
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Chrome still releasing the profile */ }
}

main().catch((e) => { process.stderr.write(`\n[ws-live] FAIL: ${e.message}\n`); process.exitCode = 1; });
