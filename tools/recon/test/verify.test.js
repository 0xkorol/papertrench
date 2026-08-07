'use strict';
// Tests for the phase-2 one-shot layer: corpus classification + coverage, the
// adapter verifier (the crown jewel — proven here to catch missed-token-page
// and over-mount against a fake adapter), and the scaffold generator.
//   node --test tools/recon/test/verify.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { classifyUrl, buildCorpus } = require('../lib/corpus');
const { runVerify, assembleExamples, detectAt, chainsAgree } = require('../lib/verify');
const { scaffold } = require('../lib/scaffold');

const ADDR = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const WALLET = 'MfDuWeqSHEqTFVYZ7LoexgAK9dxk7cy4DFJWjWMGVWa';

// A faithful mini-adapter: mounts on /token/<addr>, refuses everything else.
const GOOD_ADAPTER = `(() => {
  'use strict';
  const api = { currentSite: () => ({ id: 'fake', detect: () => {
    const m = location.pathname.match(/^\\/token\\/([1-9A-HJ-NP-Za-km-z]{32,44})/);
    return m ? { kind: 'mint', address: m[1], chain: 'solana' } : null;
  } }) };
  window.PaperTrenchSites = api; self.PaperTrenchSites = api;
})();`;

// A BUGGY adapter that refuses token pages (the miss we keep fixing by hand).
const BLIND_ADAPTER = `(() => {
  'use strict';
  const api = { currentSite: () => ({ id: 'fake', detect: () => null }) };
  window.PaperTrenchSites = api; self.PaperTrenchSites = api;
})();`;

// An OVER-MOUNTING adapter that mounts on anything with an address in the path,
// including wallets (the O-10 bug).
const GREEDY_ADAPTER = `(() => {
  'use strict';
  const api = { currentSite: () => ({ id: 'fake', detect: () => {
    const m = location.pathname.match(/([1-9A-HJ-NP-Za-km-z]{32,44})/);
    return m ? { kind: 'mint', address: m[1], chain: 'solana' } : null;
  } }) };
  window.PaperTrenchSites = api; self.PaperTrenchSites = api;
})();`;

// ---------------------------------------------------------------------------
// corpus
// ---------------------------------------------------------------------------

test('corpus: classifyUrl separates token / history / list pages', () => {
  const token = classifyUrl(`https://x.io/solana/${ADDR}`, { nodeCount: 1, hadLivePrice: true });
  assert.equal(token.looksTokenPage, true);
  assert.equal(token.looksHistoryPage, false);

  const wallet = classifyUrl(`https://x.io/wallet/${WALLET}`, null);
  assert.equal(wallet.looksHistoryPage, true);
  assert.equal(wallet.looksTokenPage, false);

  const screener = classifyUrl('https://x.io/trending', null);
  assert.equal(screener.looksListPage, true);

  // Many price nodes → list even without list vocabulary in the path.
  const dense = classifyUrl('https://x.io/board', { nodeCount: 20, hadLivePrice: true });
  assert.equal(dense.looksListPage, true);
});

test('corpus: coverage counts chains PRE-dedup and verdicts honestly', () => {
  const nav = [
    { ev: 'nav', href: `https://x.io/solana/${ADDR}` },
    { ev: 'nav', href: `https://x.io/base/${ADDR}` }, // same pattern, different chain
    { ev: 'nav', href: `https://x.io/wallet/${WALLET}` },
  ];
  const domsig = [
    { k: 'sig', href: `https://x.io/solana/${ADDR}`, prices: [['div.p', '$1.00']] },
    { k: 'sig', href: `https://x.io/solana/${ADDR}`, prices: [['div.p', '$1.02']] }, // ticked → live
  ];
  const { urls, coverage } = buildCorpus(nav, domsig, [], null);
  assert.equal(coverage.counts.chains, 2, 'both chains counted despite /{chain} dedup');
  assert.ok(coverage.counts.tokenPages >= 1);
  assert.ok(coverage.counts.historyPages >= 1);
  // token page ticked a price → tokenPagesWithLivePrice
  assert.ok(coverage.counts.tokenPagesWithLivePrice >= 1);
  assert.ok(urls.some((u) => u.looksTokenPage && u.hadLivePrice));
});

test('corpus: a token-only capture is PARTIAL/THIN, never silently complete', () => {
  const nav = [{ ev: 'nav', href: `https://x.io/solana/${ADDR}` }];
  const { coverage } = buildCorpus(nav, [], [], null);
  assert.notEqual(coverage.verdict, 'LANDABLE');
  assert.ok(coverage.gaps.length > 0);
});

// ---------------------------------------------------------------------------
// verify — the crown jewel
// ---------------------------------------------------------------------------

test('verify: a good adapter AGREES — token mounts, wallet refuses, no flags', () => {
  const examples = [
    { rawUrl: `https://x.io/token/${ADDR}`, display: `https://x.io/token/${ADDR}`, ann: { looksTokenPage: true, hadLivePrice: true } },
    { rawUrl: `https://x.io/wallet/${WALLET}`, display: `https://x.io/wallet/${WALLET}`, ann: { looksHistoryPage: true } },
  ];
  const { rows, summary } = runVerify(GOOD_ADAPTER, examples);
  assert.equal(rows[0].mounted, true);
  assert.equal(rows[0].kind, 'mint');
  assert.equal(rows[1].mounted, false);
  assert.equal(summary.high, 0);
  assert.equal(summary.verdict, 'AGREES with the capture');
});

test('verify: catches a MISSED token page (address+live but refused) as HIGH', () => {
  const examples = [
    { rawUrl: `https://x.io/token/${ADDR}`, display: 'd', ann: { looksTokenPage: true, hadLivePrice: true } },
  ];
  const { rows, summary } = runVerify(BLIND_ADAPTER, examples);
  assert.equal(rows[0].mounted, false);
  assert.ok(rows[0].flags.some((f) => f.code === 'MISSED_TOKEN_PAGE' && f.level === 'high'));
  assert.equal(summary.high, 1);
  assert.match(summary.verdict, /DISAGREEMENTS/);
});

test('verify: catches an OVER_MOUNT on a wallet/history page as HIGH (O-10)', () => {
  const examples = [
    { rawUrl: `https://x.io/wallet/${WALLET}`, display: 'd', ann: { looksHistoryPage: true } },
  ];
  const { rows, summary } = runVerify(GREEDY_ADAPTER, examples);
  assert.equal(rows[0].mounted, true);
  assert.ok(rows[0].flags.some((f) => f.code === 'OVER_MOUNT' && f.level === 'high'));
  assert.equal(summary.high, 1);
});

test('verify: flags a list/screener page that mounts as MEDIUM', () => {
  const examples = [
    { rawUrl: `https://x.io/trending/${ADDR}`, display: 'd', ann: { looksListPage: true } },
  ];
  const { rows } = runVerify(GREEDY_ADAPTER, examples);
  assert.ok(rows[0].flags.some((f) => f.code === 'LIST_MOUNT'));
});

test('verify: a broken adapter surfaces as an error, not a false pass', () => {
  const { rows, summary } = runVerify('throw new Error("boom");', [
    { rawUrl: `https://x.io/token/${ADDR}`, display: 'd', ann: { looksTokenPage: true } },
  ]);
  assert.ok(rows[0].error);
  assert.equal(summary.verdict, 'ADAPTER ERROR');
});

test('verify: detectAt loads the vm sandbox and reads location', () => {
  const r = detectAt(GOOD_ADAPTER, `https://x.io/token/${ADDR}`);
  assert.equal(r.siteId, 'fake');
  assert.equal(r.token.address, ADDR);
});

test('verify: assembleExamples dedups by pattern and carries annotations', () => {
  const raw = [
    { url: `https://x.io/token/${ADDR}` },
    { url: `https://x.io/token/${WALLET}` }, // same pattern → deduped
    { url: `https://x.io/wallet/${WALLET}` },
  ];
  const corpusUrls = [
    { host: 'x.io', pattern: '/token/{address}', looksTokenPage: true, hadLivePrice: true },
    { host: 'x.io', pattern: '/wallet/{address}', looksHistoryPage: true },
  ];
  const ex = assembleExamples(raw, corpusUrls, null);
  assert.equal(ex.length, 2, 'two distinct patterns');
  const tok = ex.find((e) => e.rawUrl.includes('/token/'));
  assert.equal(tok.ann.looksTokenPage, true);
  assert.equal(tok.ann.hadLivePrice, true);
});

test('verify: chainsAgree canonicalizes slugs', () => {
  assert.equal(chainsAgree('sol', 'solana'), true);
  assert.equal(chainsAgree('eth', 'ethereum'), true);
  assert.equal(chainsAgree('solana', 'base'), false);
});

// ---------------------------------------------------------------------------
// scaffold
// ---------------------------------------------------------------------------

test('scaffold: emits valid-JS gating test + fake stub grounded in the dossier', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ptrecon-scaf-'));
  const dossier = path.join(tmp, 'dossier');
  fs.mkdirSync(dossier, { recursive: true });
  fs.writeFileSync(path.join(dossier, 'corpus.json'), JSON.stringify({
    urls: [
      { example: `https://x.io/solana/${ADDR}`, host: 'x.io', pattern: '/{chain}/{address}', chain: 'solana', looksTokenPage: true, hadLivePrice: true, priceNodeCount: 1 },
      { example: `https://x.io/wallet/${WALLET}`, host: 'x.io', pattern: '/wallet/{address}', looksHistoryPage: true },
    ],
  }));
  fs.writeFileSync(path.join(dossier, 'endpoints.json'), JSON.stringify([
    { method: 'GET', host: 'api.x.io', pattern: '/price/{address}', statuses: { 200: 3 }, schema: ['$: object', '  price: number'], fixtureRef: 'fixtures/f.json' },
  ]));
  fs.writeFileSync(path.join(dossier, 'ws.json'), JSON.stringify([]));

  const out = path.join(tmp, 'scaffold');
  const res = scaffold(dossier, out, 'demosite');
  assert.equal(res.tokenPages, 1);
  assert.equal(res.refuseRoutes, 1);

  const gating = fs.readFileSync(path.join(out, 'demosite.gating.test.js'), 'utf8');
  // Generated file must be valid JS (the memory: node --check every inline script).
  assert.doesNotThrow(() => new (require('node:vm').Script)(gating, { filename: 'gen' }));
  assert.match(gating, new RegExp(ADDR));       // the real captured token URL is embedded
  assert.match(gating, /MOUNTS|REFUSALS/);
  assert.match(gating, /TODO/);                 // human-judgment markers present

  const stub = fs.readFileSync(path.join(out, 'demosite.fake.stub.js'), 'utf8');
  assert.doesNotThrow(() => new (require('node:vm').Script)(stub, { filename: 'gen' }));
  assert.match(stub, /price: number/);          // observed schema carried in
  assert.match(stub, /F-39/);                   // the honesty note survives
  fs.rmSync(tmp, { recursive: true, force: true });
});
