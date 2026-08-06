/* Forge core — the request builders and readers behind the Generate chip.
 *
 * This suite exists because the feature's whole failure surface is "we
 * guessed": guessed at a site's required image size, guessed at a provider's
 * request shape, guessed at where the image lives in the reply. Each of those
 * guesses is pinned here against the behaviour we actually promise:
 *
 *   - a size we READ off the page is labelled differently from one we
 *     defaulted to, because the dashboard tells the user which it was;
 *   - the crop is a cover-crop, never a squash;
 *   - the two fields we cannot verify from inside this repo (xAI's live
 *     search parameters, OpenAI's `size`) are sent with a retry escape;
 *   - Anthropic requests never carry `temperature`, which Opus-tier models
 *     reject outright with a 400;
 *   - every key-shaped string is redacted out of anything a user can see.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const FG = require(path.join(__dirname, '..', 'forge-core.js'));

/* ---------------- reading the box in front of the user ---------------- */

test('the required size is read off the checkout box, not invented', () => {
  assert.deepEqual(FG.readSpecFromText('Header image — 1500 x 500 px, PNG or JPG'), { w: 1500, h: 500 });
  assert.deepEqual(FG.readSpecFromText('Recommended 1200 by 630'), { w: 1200, h: 630 });
  assert.deepEqual(FG.readSpecFromText('Logo 500×500'), { w: 500, h: 500 });
});

test('things that are not pixel dimensions are ignored', () => {
  assert.equal(FG.readSpecFromText('Support is available 24 x 7'), null);
  assert.equal(FG.readSpecFromText('version 2 x 1'), null);
  assert.equal(FG.readSpecFromText('no numbers here at all'), null);
  assert.equal(FG.readSpecFromText(''), null);
});

test('when a box states two sizes the larger one wins', () => {
  // Boxes that take an icon and a header in one step state both.
  assert.deepEqual(
    FG.readSpecFromText('Icon 256x256. Header 1500x500.'),
    { w: 1500, h: 500 },
  );
});

test('the asset kind is read from the words around the slot', () => {
  assert.equal(FG.readKindFromText('Upload header image'), 'header');
  assert.equal(FG.readKindFromText('Project banner'), 'header');
  assert.equal(FG.readKindFromText('Token logo'), 'icon');
  assert.equal(FG.readKindFromText('Profile picture'), 'icon');
  assert.equal(FG.readKindFromText('Open Graph image'), 'og');
  assert.equal(FG.readKindFromText('drop a file'), null);
});

test('resolveSpec says WHERE the size came from', () => {
  const stated = FG.resolveSpec('header', 'Header must be 1200x400');
  assert.equal(stated.w, 1200);
  assert.equal(stated.h, 400);
  assert.equal(stated.source, 'page', 'a size read off the page must be labelled as such');

  const guessed = FG.resolveSpec('header', 'Upload a header');
  assert.equal(guessed.source, 'preset');
  assert.equal(guessed.w, FG.ASSET_KINDS.header.w);
  // The label the panel prints is the honesty contract with the user.
  assert.notEqual(stated.source, guessed.source);
});

/* ---------------- fitting ---------------- */

test('a square render becomes a 3:1 header by cropping, never by squashing', () => {
  const plan = FG.planFit(1024, 1024, { w: 1500, h: 500 });
  // Cover scale is 1500/1024; the source strip taken is full width...
  assert.equal(plan.sw, 1024);
  // ...and one third of the height, centred.
  assert.equal(plan.sh, 341);
  assert.equal(plan.sx, 0);
  assert.equal(plan.sy, Math.round((1024 - 341.33) / 2));
  assert.equal(plan.dw, 1500);
  assert.equal(plan.dh, 500);
  const srcAR = plan.sw / plan.sh;
  const dstAR = plan.dw / plan.dh;
  assert.ok(Math.abs(srcAR - dstAR) < 0.02, 'crop must preserve the output aspect ratio');
});

test('an already-correct image skips the canvas round trip', () => {
  const plan = FG.planFit(1500, 500, { w: 1500, h: 500 });
  assert.equal(plan.exact, true);
  assert.equal(FG.planFit(1024, 1024, { w: 1500, h: 500 }).exact, false);
});

test('we ask the provider for the nearest shape it actually serves', () => {
  // A 3:1 header from OpenAI's three sizes: the landscape one, not the square.
  const wide = FG.requestSize({ w: 1500, h: 500 }, [[1024, 1024], [1536, 1024], [1024, 1536]]);
  assert.deepEqual(wide, { w: 1536, h: 1024 });
  const square = FG.requestSize({ w: 1000, h: 1000 }, [[1024, 1024], [1536, 1024], [1024, 1536]]);
  assert.deepEqual(square, { w: 1024, h: 1024 });
  const tall = FG.requestSize({ w: 600, h: 1200 }, [[1024, 1024], [1536, 1024], [1024, 1536]]);
  assert.deepEqual(tall, { w: 1024, h: 1536 });
});

/* ---------------- prompts ---------------- */

test('the ticker is set exactly once, and only when asked for', () => {
  const facts = { symbol: 'bonk', name: 'Bonk' };
  const spec = FG.ASSET_KINDS.header;
  const withT = FG.buildImagePrompt({ facts, spec, styleId: 'trench', withTicker: true });
  assert.match(withT, /"BONK"/);
  assert.match(withT, /spelled exactly/);

  const without = FG.buildImagePrompt({ facts, spec, styleId: 'trench', withTicker: false });
  assert.doesNotMatch(without, /"BONK"/);
  assert.match(without, /No text, no letters/);
});

test('a prompt is still usable with no narrative brief at all', () => {
  const p = FG.buildImagePrompt({
    facts: { symbol: 'WIF', name: 'dogwifhat' },
    spec: FG.ASSET_KINDS.header,
    styleId: 'clean',
  });
  assert.match(p, /dogwifhat/);
  assert.match(p, /flat shapes/);              // the style hint made it in
  assert.match(p, /negative space on the left/); // the composition hint did too
});

test("the brief's subject and palette reach the prompt", () => {
  const p = FG.buildImagePrompt({
    facts: { symbol: 'PEPE' },
    brief: { subject: 'a smug cartoon frog in a tracksuit', mood: 'brash, funny', palette: 'swamp green, hot pink' },
    spec: FG.ASSET_KINDS.header,
    styleId: 'trench',
  });
  assert.match(p, /smug cartoon frog in a tracksuit/);
  assert.match(p, /Mood: brash, funny/);
  assert.match(p, /Palette: swamp green, hot pink/);
});

test('every prompt refuses real people and existing trademarks', () => {
  const p = FG.buildImagePrompt({ facts: { symbol: 'X' }, spec: FG.ASSET_KINDS.icon, styleId: 'photo' });
  assert.match(p, /Do not depict real people, real logos, or existing trademarked characters/);
});

/* ---------------- brain requests ---------------- */

test('Grok reads X through /v1/responses and the server-side x_search tool', () => {
  const req = FG.buildResearchRequest('xai', { apiKey: 'xai-secret-key-value', model: 'grok-4.5' }, { symbol: 'BONK' });
  // The search lane lives ONLY on /v1/responses. /chat/completions accepts
  // function tools only, so a search request sent there cannot work.
  assert.equal(req.url, 'https://api.x.ai/v1/responses');
  assert.equal(req.headers.Authorization, 'Bearer xai-secret-key-value');
  assert.deepEqual(req.body.tools, [{ type: 'x_search' }, { type: 'web_search' }]);
  assert.ok(Array.isArray(req.body.input), '/responses takes `input`, not `messages`');
  assert.equal(req.body.input[0].role, 'user');
  assert.match(req.body.input[0].content, /SUBJECT:/, 'the extraction format must survive the collapse into one item');
  assert.match(req.body.input[0].content, /BONK/);
  assert.equal(req.body.messages, undefined);
  // A key with no search entitlement still gets an (unsearched) brief.
  assert.equal(req.retryWithout, 'tools');
});

test('the retired Live Search field is never sent again', () => {
  // xAI answers 410 Gone to `search_parameters` on /chat/completions. Sending
  // it would fail the whole call, and the silent-degrade path would hide it.
  const searched = FG.buildResearchRequest('xai', { apiKey: 'k'.repeat(20), model: 'grok-4.5' }, {});
  const plain = FG.buildResearchRequest('xai', { apiKey: 'k'.repeat(20), model: 'grok-4.5', useSearch: false }, {});
  for (const req of [searched, plain]) {
    assert.equal(req.body.search_parameters, undefined);
    assert.doesNotMatch(JSON.stringify(req.body), /search_parameters/);
  }
});

test('search off falls back to the plain chat endpoint', () => {
  const req = FG.buildResearchRequest('xai', { apiKey: 'k'.repeat(20), model: 'grok-4.5', useSearch: false }, {});
  assert.equal(req.url, 'https://api.x.ai/v1/chat/completions');
  assert.ok(Array.isArray(req.body.messages));
  assert.equal(req.body.tools, undefined);
  assert.equal(req.retryWithout, undefined);
});

test('a Responses-shaped answer is read, citations included', () => {
  const json = {
    output: [{
      type: 'message',
      content: [{
        type: 'output_text',
        text: 'SUBJECT: a chrome hamster on a skateboard\nMOOD: fast, silly\nPALETTE: chrome, acid yellow',
        annotations: [
          { type: 'url_citation', url: 'https://x.com/someone/status/1', title: 'post' },
          { type: 'url_citation', url: 'https://x.com/someone/status/2', title: 'post' },
        ],
      }],
    }],
  };
  const brief = FG.parseResearch('xai', json);
  assert.equal(brief.subject, 'a chrome hamster on a skateboard');
  assert.equal(brief.palette, 'chrome, acid yellow');
  assert.deepEqual(brief.sources, ['https://x.com/someone/status/1', 'https://x.com/someone/status/2']);
});

test('the Responses convenience field is used when present', () => {
  const brief = FG.parseResearch('xai', { output_text: 'SUBJECT: a neon shark\nMOOD: cold' });
  assert.equal(brief.subject, 'a neon shark');
});

test('the same provider is parsed correctly in both of its envelopes', () => {
  // Search on -> /responses; search off -> /chat/completions. One key, two
  // shapes, so the reader must not branch on provider id alone.
  const body = 'SUBJECT: a frog\nMOOD: smug\nPALETTE: green';
  assert.equal(FG.parseResearch('xai', { output: [{ content: [{ type: 'output_text', text: body }] }] }).subject, 'a frog');
  assert.equal(FG.parseResearch('xai', { choices: [{ message: { content: body } }] }).subject, 'a frog');
});

test('duplicate citations are not listed twice', () => {
  const url = 'https://x.com/a/1';
  const brief = FG.parseResearch('xai', {
    output: [{ content: [{ type: 'output_text', text: 'SUBJECT: a frog', annotations: [{ url }, { url }] }] }],
    citations: [url],
  });
  assert.deepEqual(brief.sources, [url]);
});

test('Anthropic requests carry the browser-access header and no temperature', () => {
  const req = FG.buildResearchRequest('anthropic', { apiKey: 'sk-ant-abcdefghijkl', model: 'claude-opus-5' }, { symbol: 'BONK' });
  assert.equal(req.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(req.headers['x-api-key'], 'sk-ant-abcdefghijkl');
  assert.equal(req.headers['anthropic-version'], '2023-06-01');
  // An extension worker is a browser context; without this the call is
  // blocked by CORS before it ever reaches the model.
  assert.equal(req.headers['anthropic-dangerous-direct-browser-access'], 'true');
  // Opus-tier models reject `temperature` with a 400 — we never send one.
  assert.equal('temperature' in req.body, false);
  assert.equal(req.headers.Authorization, undefined, 'Anthropic uses x-api-key, not Bearer');
});

test('a missing model is refused before any request is built', () => {
  const req = FG.buildResearchRequest('openai', { apiKey: 'k'.repeat(20) }, {});
  assert.match(req.error, /model/i);
  assert.equal(req.url, undefined);
});

test('the research answer is parsed out of either chat envelope', () => {
  const body = 'SUBJECT: a chrome hamster on a skateboard\nMOOD: fast, silly\nPALETTE: chrome, acid yellow';
  const openai = FG.parseResearch('xai', { choices: [{ message: { content: body } }], citations: ['https://x.com/a/1'] });
  assert.equal(openai.subject, 'a chrome hamster on a skateboard');
  assert.equal(openai.mood, 'fast, silly');
  assert.deepEqual(openai.sources, ['https://x.com/a/1']);

  const anthropic = FG.parseResearch('anthropic', { content: [{ type: 'text', text: body }] });
  assert.equal(anthropic.subject, 'a chrome hamster on a skateboard');
});

test('an honest "I could not find it" does not become a fake subject', () => {
  const brief = FG.parseResearch('xai', { choices: [{ message: { content: 'SUBJECT: unknown\nMOOD: neutral\nPALETTE: grey' } }] });
  assert.equal(brief.subject, '', 'unknown must clear the subject, not repeat the word "unknown" into the art prompt');
  assert.equal(brief.mood, 'neutral');
});

test('a model that ignores the format still gives us something', () => {
  const brief = FG.parseResearch('openai', { choices: [{ message: { content: 'It is a dog coin about a shiba.' } }] });
  assert.match(brief.subject, /shiba/);
});

/* ---------------- image requests ---------------- */

test('OpenAI-compatible image calls use /images/generations and a served size', () => {
  const req = FG.buildImageRequest('openai', { apiKey: 'sk-abcdefghijklmn', model: 'gpt-image-1' }, {
    prompt: 'a frog', spec: { w: 1500, h: 500 },
  });
  assert.equal(req.url, 'https://api.openai.com/v1/images/generations');
  assert.equal(req.body.size, '1536x1024');
  assert.equal(req.retryWithout, 'size', 'servers that reject `size` must still return an image');
});

test('xAI images are sent without a size, because it documents none', () => {
  const req = FG.buildImageRequest('xai', { apiKey: 'xai-abcdefghijklmn', model: 'grok-imagine-image-quality' }, {
    prompt: 'a frog', spec: { w: 1500, h: 500 },
  });
  assert.equal(req.url, 'https://api.x.ai/v1/images/generations');
  assert.equal(req.body.size, undefined);
  assert.equal(req.body.n, 1);
  assert.equal(req.retryWithout, undefined, 'nothing to retry without — we never sent the doubtful field');
});

test('Gemini goes to :generateContent with an image modality', () => {
  const req = FG.buildImageRequest('gemini', { apiKey: 'AIza' + 'x'.repeat(30), model: 'gemini-2.5-flash-image' }, {
    prompt: 'a frog', spec: { w: 1000, h: 1000 },
  });
  assert.match(req.url, /\/models\/gemini-2\.5-flash-image:generateContent$/);
  assert.equal(req.headers['x-goog-api-key'], 'AIza' + 'x'.repeat(30));
  assert.deepEqual(req.body.generationConfig.responseModalities, ['IMAGE']);
});

test('Stability is sent as a form with the nearest aspect ratio', () => {
  const req = FG.buildImageRequest('stability', { apiKey: 'sk-stability-key-1234', model: 'core' }, {
    prompt: 'a frog', spec: { w: 1500, h: 500 },
  });
  assert.match(req.url, /stable-image\/generate\/core$/);
  assert.equal(req.form.aspect_ratio, '21:9', '3:1 is nearest 21:9 of the ratios Stability serves');
  assert.equal(req.body, undefined, 'Stability takes multipart, not JSON');
});

test('a custom provider is driven entirely by the user template', () => {
  const req = FG.buildImageRequest('custom', {
    endpoint: 'https://api.example.ai/v1/generate',
    apiKey: 'key-abcdefghijklmno',
    headersJson: '{"X-Tenant":"terp"}',
    bodyTemplate: '{"input":{"text":"{{prompt}}","w":{{width}},"h":{{height}}}}',
    responsePath: 'output.0.image',
  }, { prompt: 'a frog', spec: { w: 1024, h: 1024 } });
  assert.equal(req.url, 'https://api.example.ai/v1/generate');
  assert.equal(req.headers['X-Tenant'], 'terp');
  assert.equal(req.headers.Authorization, 'Bearer key-abcdefghijklmno');
  assert.equal(req.body.input.text, 'a frog');
  assert.equal(req.body.input.w, 1024);
  assert.equal(req.responsePath, 'output.0.image');
});

test('a broken custom template fails with a message a human can act on', () => {
  const bad = FG.buildImageRequest('custom', {
    endpoint: 'https://api.example.ai/v1/generate',
    bodyTemplate: '{"prompt": {{prompt}}}',   // missing quotes around the substitution
  }, { prompt: 'a frog', spec: { w: 1024, h: 1024 } });
  assert.match(bad.error, /valid JSON/i);

  const badHeaders = FG.buildImageRequest('custom', {
    endpoint: 'https://api.example.ai/v1/generate',
    headersJson: '["not", "an", "object"]',
  }, { prompt: 'a frog', spec: { w: 1024, h: 1024 } });
  assert.match(badHeaders.error, /JSON object/i);

  const noEndpoint = FG.buildImageRequest('custom', {}, { prompt: 'a frog', spec: { w: 1, h: 1 } });
  assert.match(noEndpoint.error, /endpoint/i);
});

test('a prompt with quotes and newlines still produces valid JSON', () => {
  const rendered = FG.renderTemplate('{"p":"{{prompt}}"}', { prompt: 'a "smug" frog\nwearing a hat' });
  const parsed = JSON.parse(rendered);
  assert.equal(parsed.p, 'a "smug" frog\nwearing a hat');
});

/* ---------------- reading images back ---------------- */

test('every response shape we know how to read is read', () => {
  const b64 = 'A'.repeat(120);
  assert.equal(FG.parseImages({ data: [{ b64_json: b64 }] }).images[0].b64, b64);
  assert.equal(FG.parseImages({ data: [{ url: 'https://cdn.example/a.png' }] }).images[0].url, 'https://cdn.example/a.png');
  assert.equal(FG.parseImages({ image: b64 }).images[0].b64, b64);
  assert.equal(FG.parseImages({ artifacts: [{ base64: b64 }] }).images[0].b64, b64);
  assert.equal(FG.parseImages({ images: [b64] }).images[0].b64, b64);
  const gemini = { candidates: [{ content: { parts: [{ inline_data: { data: b64, mime_type: 'image/png' } }] } }] };
  assert.equal(FG.parseImages(gemini).images[0].b64, b64);
});

test('an explicit response path beats the guesses', () => {
  const b64 = 'B'.repeat(120);
  const json = { data: [{ b64_json: 'A'.repeat(120) }], output: [{ image: b64 }] };
  assert.equal(FG.parseImages(json, 'output.0.image').images[0].b64, b64);
});

test('a data: URL is unwrapped rather than treated as base64', () => {
  const out = FG.parseImages({ images: ['data:image/webp;base64,' + 'C'.repeat(100)] });
  assert.equal(out.images[0].mime, 'image/webp');
  assert.equal(out.images[0].b64, 'C'.repeat(100));
});

test("a provider's own error is surfaced instead of a generic shrug", () => {
  const out = FG.parseImages({ error: { message: 'billing_hard_limit_reached' } });
  assert.equal(out.images.length, 0);
  assert.match(out.error, /billing_hard_limit_reached/);
});

/* ---------------- secret hygiene ---------------- */

test('keys never survive into anything a user or a log can see', () => {
  const key = 'sk-proj-abcdefghijklmnopqrstuv';
  const err = `401 Unauthorized: Incorrect API key provided: ${key}. Check your account.`;
  const clean = FG.redact(err, [key]);
  assert.doesNotMatch(clean, /abcdefghijklmnop/);
  assert.match(clean, /\[key\]/);
  assert.match(clean, /Incorrect API key provided/, 'the useful half of the message survives');
});

test('key-shaped strings we were never handed are redacted too', () => {
  assert.doesNotMatch(FG.redact('leaked AIzaSyA' + 'b'.repeat(30), []), /AIzaSyAb/);
  assert.doesNotMatch(FG.redact('header was Bearer ' + 'z'.repeat(40), []), /zzzzzzzz/);
  assert.doesNotMatch(FG.redact('xai-' + 'q'.repeat(30), []), /qqqqqqqq/);
});

test('redaction never eats an ordinary short word', () => {
  // A too-short "secret" must not turn every occurrence of a common substring
  // into [key] — that would corrupt real error text.
  assert.equal(FG.redact('the model returned an error', ['error']), 'the model returned an error');
});

/* ---------------- keys and names ---------------- */

test('the image cache key changes when anything that shapes the image changes', () => {
  const facts = { mint: 'So11111111111111111111111111111111111111112' };
  const a = FG.imageKey(facts, { w: 1500, h: 500 }, 'trench', 'prompt one');
  assert.notEqual(a, FG.imageKey(facts, { w: 1000, h: 1000 }, 'trench', 'prompt one'));
  assert.notEqual(a, FG.imageKey(facts, { w: 1500, h: 500 }, 'pixel', 'prompt one'));
  assert.notEqual(a, FG.imageKey(facts, { w: 1500, h: 500 }, 'trench', 'prompt two'));
  assert.equal(a, FG.imageKey(facts, { w: 1500, h: 500 }, 'trench', 'prompt one'));
});

test('the download filename is safe and descriptive', () => {
  const name = FG.fileName({ symbol: 'BONK /w spaces!' }, FG.ASSET_KINDS.header);
  assert.match(name, /^[a-z0-9-]+-header-1500x500\.png$/);
  assert.equal(FG.fileName({}, FG.ASSET_KINDS.icon), 'token-icon-1000x1000.png');
});
