/* PaperTrench — Forge core.
 *
 * Pure functions behind "Generate" in a dex's own upload box. No DOM, no
 * chrome APIs, no network: this file only BUILDS requests and READS replies,
 * so the whole provider matrix is testable without a browser or a key.
 *
 * Two lanes, because the user asked for two AIs and they do different jobs:
 *
 *   BRAIN (optional) — a chat model that reads the narrative and writes the
 *     art direction. Grok is the interesting one here: with Live Search over
 *     X it can see what the coin is actually about right now, which is the
 *     difference between "a frog" and the specific frog the timeline is
 *     posting. Any OpenAI-compatible chat endpoint works, as does Anthropic.
 *
 *   HANDS (required) — the model that renders pixels. OpenAI-compatible
 *     /images/generations covers OpenAI and xAI; Gemini and Stability get
 *     their own shapes; and `custom` is a request TEMPLATE so a provider we
 *     have never heard of (Higgsfield, a private endpoint, next month's
 *     model) works without shipping an adapter we cannot test.
 *
 * Honesty rules this file follows, because they are load-bearing elsewhere in
 * this codebase:
 *
 *   - We do not invent a site's upload requirements. ASSET_KINDS carries OUR
 *     render presets; the authority is the checkout box, so readSpecFromText()
 *     lifts real dimensions off the dialog when the site states them (they
 *     nearly always do) and the preset is only the fallback.
 *   - We do not hardcode model IDs we cannot verify. Model fields are free
 *     text with a live /models probe behind them.
 *   - Every provider response is parsed as a UNION of known shapes rather
 *     than one guessed path, and an unparseable reply says so instead of
 *     silently producing nothing.
 */
(() => {
  'use strict';

  const VERSION = 1;

  /* -------------------- asset kinds -------------------- */

  // OUR render presets — not a claim about any site's requirements. Each is
  // the shape that kind of asset conventionally takes; readSpecFromText()
  // overrides w/h whenever the box in front of the user states its own.
  const ASSET_KINDS = {
    header: {
      id: 'header',
      label: 'Header / banner',
      w: 1500,
      h: 500,
      // Wide art needs the subject off-centre-safe: many sites overlay the
      // token icon and name on the left third of a header.
      composition: 'wide banner, subject weighted to the right, calm negative space on the left third where the site overlays the token icon and name',
      maxBytes: 5 * 1024 * 1024,
    },
    icon: {
      id: 'icon',
      label: 'Token icon',
      w: 1000,
      h: 1000,
      composition: 'centred square emblem, bold silhouette that stays readable shrunk to 32px, no thin lines, no fine detail at the edges',
      maxBytes: 5 * 1024 * 1024,
    },
    og: {
      id: 'og',
      label: 'Social / OG card',
      w: 1200,
      h: 630,
      composition: 'social share card, single clear focal subject, centred',
      maxBytes: 5 * 1024 * 1024,
    },
    square: {
      id: 'square',
      label: 'Square image',
      w: 1024,
      h: 1024,
      composition: 'centred square composition, single clear subject',
      maxBytes: 5 * 1024 * 1024,
    },
  };

  const DEFAULT_KIND = 'header';

  /* -------------------- styles -------------------- */

  const STYLES = [
    {
      id: 'trench',
      label: 'Trench',
      hint: 'high-contrast crypto-native poster art, saturated, heavy rim light, slight grain, feels like it belongs on a dex header at 3am',
    },
    {
      id: 'clean',
      label: 'Clean',
      hint: 'clean vector illustration, flat shapes, confident limited palette, generous negative space, no gradients-for-the-sake-of-gradients',
    },
    {
      id: 'render3d',
      label: '3D render',
      hint: 'glossy 3D render, soft studio lighting, subsurface scattering, shallow depth of field, product-shot polish',
    },
    {
      id: 'pixel',
      label: 'Pixel',
      hint: 'crisp pixel art, limited palette, hard edges, no anti-aliasing, readable at small size',
    },
    {
      id: 'photo',
      label: 'Photographic',
      hint: 'photographic, natural light, real materials and textures, shallow depth of field',
    },
    {
      id: 'handdrawn',
      label: 'Hand-drawn',
      hint: 'hand-drawn ink and marker, visible linework, slightly wonky on purpose, meme-native energy',
    },
  ];

  const DEFAULT_STYLE = 'trench';

  function styleById(id) {
    return STYLES.find((s) => s.id === id) || STYLES[0];
  }

  /* -------------------- provider registry -------------------- */

  // `models` is only ever a PLACEHOLDER shown in the UI. It is never sent as
  // a default, because a wrong model id is a 404 the user cannot debug. The
  // dashboard's "Load models" button fills the real list from the endpoint.
  const BRAINS = {
    xai: {
      id: 'xai',
      label: 'Grok (xAI)',
      kind: 'openai-chat',
      endpoint: 'https://api.x.ai/v1',
      modelHint: 'grok-4.5',
      // The reason to pick this one: it can read X before writing the brief.
      //
      // This runs through /v1/responses with the server-side `x_search` tool.
      // It is NOT the old `search_parameters` field — xAI deprecated Live
      // Search (it now answers 410 Gone), and /v1/chat/completions accepts
      // only function tools, so the search lane does not exist there at all.
      search: 'x',
      searchTools: ['x_search', 'web_search'],
      blurb: 'Reads X itself (server-side x_search) before writing the brief.',
    },
    openai: {
      id: 'openai',
      label: 'OpenAI-compatible chat',
      kind: 'openai-chat',
      endpoint: 'https://api.openai.com/v1',
      modelHint: 'gpt-5',
      blurb: 'Any /v1/chat/completions endpoint — OpenAI, OpenRouter, Together, your own.',
    },
    anthropic: {
      id: 'anthropic',
      label: 'Claude (Anthropic)',
      kind: 'anthropic',
      endpoint: 'https://api.anthropic.com/v1',
      modelHint: 'claude-opus-5',
      blurb: 'Writes the sharpest brief. No image model — pair it with hands below.',
    },
  };

  const HANDS = {
    openai: {
      id: 'openai',
      label: 'OpenAI-compatible images',
      kind: 'openai-image',
      endpoint: 'https://api.openai.com/v1',
      modelHint: 'gpt-image-1',
      blurb: 'Any /v1/images/generations endpoint.',
    },
    xai: {
      id: 'xai',
      label: 'Grok image (xAI)',
      kind: 'openai-image',
      endpoint: 'https://api.x.ai/v1',
      modelHint: 'grok-imagine-image-quality',
      // xAI documents model/prompt/n/response_format and no `size`, so we do
      // not send one; it returns data[].url.
      noSize: true,
      blurb: "xAI's image endpoint, same /images/generations shape.",
    },
    gemini: {
      id: 'gemini',
      label: 'Google Gemini / Imagen',
      kind: 'gemini-image',
      endpoint: 'https://generativelanguage.googleapis.com/v1beta',
      modelHint: 'gemini-2.5-flash-image',
      blurb: 'Uses :generateContent and reads inline image data back.',
    },
    stability: {
      id: 'stability',
      label: 'Stability AI',
      kind: 'stability-image',
      endpoint: 'https://api.stability.ai/v2beta',
      modelHint: 'core',
      blurb: 'Stable Image core / ultra / sd3.',
    },
    custom: {
      id: 'custom',
      label: 'Custom (any provider)',
      kind: 'custom-image',
      endpoint: '',
      modelHint: '',
      blurb: 'Paste the endpoint, headers, a body template and where the image lives in the reply. For anything we do not ship an adapter for.',
    },
  };

  function brainById(id) { return BRAINS[id] || null; }
  function handsById(id) { return HANDS[id] || null; }

  /* -------------------- secret hygiene -------------------- */

  /**
   * Strip anything key-shaped out of text that is about to be shown or
   * logged. Called on EVERY error string that leaves the worker: provider
   * errors love to echo the Authorization header back at you, and this
   * feature holds more keys than the rest of the extension put together.
   */
  function redact(text, secrets) {
    let out = String(text == null ? '' : text);
    const list = Array.isArray(secrets) ? secrets : [secrets];
    for (const raw of list) {
      const secret = String(raw || '');
      if (secret.length < 8) continue;   // too short to match safely
      while (out.indexOf(secret) !== -1) out = out.replace(secret, '[key]');
    }
    // Belt and braces: common key shapes we were never handed but might be
    // quoted back inside a provider's own error envelope.
    out = out.replace(/\b(sk|xai|gsk|key)-[A-Za-z0-9_-]{12,}/g, '[key]');
    out = out.replace(/\bAIza[A-Za-z0-9_-]{20,}/g, '[key]');
    out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{16,}/gi, '$1[key]');
    return out;
  }

  /* -------------------- reading the box in front of the user -------------------- */

  /**
   * Lift the required image size out of the checkout box's own copy.
   *
   * Every uploader tells the user what it wants ("1500 x 500", "500×500px",
   * "recommended 1200 by 630"). That sentence is the ONLY trustworthy source
   * for a given site's requirements — far better than a table of per-site
   * numbers we would have to guess at and then maintain forever. Returns null
   * when the box says nothing, and the caller falls back to the preset.
   */
  function readSpecFromText(text) {
    if (!text) return null;
    const s = String(text);
    const out = [];
    const re = /(\d{2,4})\s*(?:[x×*]|\bby\b)\s*(\d{2,4})/gi;
    let m;
    while ((m = re.exec(s)) !== null) {
      const w = Number(m[1]);
      const h = Number(m[2]);
      // Reject things that are obviously not pixel dimensions (version
      // numbers, dates, "24 x 7").
      if (!(w >= 48 && w <= 8192 && h >= 48 && h <= 8192)) continue;
      out.push({ w, h, at: m.index });
    }
    if (!out.length) return null;
    // Prefer the largest area: a box that mentions both an icon and a header
    // states the header second more often than not, but area is the stabler
    // discriminator than order.
    out.sort((a, b) => (b.w * b.h) - (a.w * a.h));
    return { w: out[0].w, h: out[0].h };
  }

  /**
   * Guess which KIND of asset a given upload slot wants, from the words
   * around it. Falls back to `header` — the thing the user asked for.
   */
  function readKindFromText(text) {
    const s = String(text || '').toLowerCase();
    if (/\b(header|banner|cover|hero)\b/.test(s)) return 'header';
    if (/\b(icon|logo|avatar|pfp|profile\s*p)/.test(s)) return 'icon';
    if (/\b(open\s*graph|og[\s-]?image|social\s*(card|preview|image))\b/.test(s)) return 'og';
    return null;
  }

  /**
   * Resolve the spec actually used for one slot: our preset for the kind,
   * overridden by whatever the page states.
   */
  function resolveSpec(kindId, text) {
    const base = ASSET_KINDS[kindId] || ASSET_KINDS[DEFAULT_KIND];
    const stated = readSpecFromText(text);
    if (!stated) return Object.assign({}, base, { source: 'preset' });
    return Object.assign({}, base, { w: stated.w, h: stated.h, source: 'page' });
  }

  /**
   * Cover-fit plan: how to crop a generated WxH into the slot's exact size
   * without squashing it. Pure maths so the canvas call in the worker stays
   * a three-liner and this stays testable.
   */
  function planFit(srcW, srcH, spec) {
    const sw0 = Math.max(1, Number(srcW) || 1);
    const sh0 = Math.max(1, Number(srcH) || 1);
    const dw = Math.max(1, Number(spec && spec.w) || 1);
    const dh = Math.max(1, Number(spec && spec.h) || 1);
    const scale = Math.max(dw / sw0, dh / sh0);   // cover, never letterbox
    const sw = Math.min(sw0, dw / scale);
    const sh = Math.min(sh0, dh / scale);
    return {
      sx: Math.round((sw0 - sw) / 2),
      sy: Math.round((sh0 - sh) / 2),
      sw: Math.round(sw),
      sh: Math.round(sh),
      dw,
      dh,
      // A no-op crop lets the worker skip the canvas round trip entirely.
      exact: Math.round(sw) === sw0 && Math.round(sh) === sh0 && sw0 === dw && sh0 === dh,
    };
  }

  /**
   * The size to ASK the provider for. Image APIs only accept a short list of
   * sizes, so we request the nearest supported shape that still covers the
   * target, then crop. Asking for 1500x500 outright is a 400 on most of them.
   */
  function requestSize(spec, allowed) {
    const list = Array.isArray(allowed) && allowed.length
      ? allowed
      : [[1024, 1024], [1536, 1024], [1024, 1536]];
    const targetAR = (spec.w || 1) / (spec.h || 1);
    let best = list[0];
    let bestScore = Infinity;
    for (const cand of list) {
      const ar = cand[0] / cand[1];
      // Aspect distance dominates; area breaks ties toward the bigger canvas
      // so the crop never upscales.
      const score = Math.abs(Math.log(ar / targetAR)) - (cand[0] * cand[1]) / 1e9;
      if (score < bestScore) { bestScore = score; best = cand; }
    }
    return { w: best[0], h: best[1] };
  }

  /* -------------------- prompt synthesis -------------------- */

  function cleanFact(v, max) {
    if (v == null) return '';
    return String(v).replace(/\s+/g, ' ').trim().slice(0, max || 200);
  }

  /**
   * The research question we hand the brain. Deliberately asks for FACTS and
   * VISUAL NOUNS rather than an image prompt: models write much better art
   * direction when the retrieval step and the writing step are separated.
   */
  function buildResearchMessages(facts) {
    const f = facts || {};
    const name = cleanFact(f.name) || cleanFact(f.symbol) || 'this token';
    const sym = cleanFact(f.symbol);
    const lines = [
      `Token: ${name}${sym ? ` ($${sym})` : ''}`,
      f.mint ? `Contract: ${cleanFact(f.mint, 64)}` : '',
      f.chain ? `Chain: ${cleanFact(f.chain, 24)}` : '',
      f.description ? `Project's own words: ${cleanFact(f.description, 600)}` : '',
      f.socials ? `Socials: ${cleanFact(f.socials, 300)}` : '',
    ].filter(Boolean);

    return [
      {
        role: 'system',
        content: [
          'You are a visual researcher for crypto brand art.',
          'You will be given a memecoin. Work out what its narrative actually is RIGHT NOW — the joke, the mascot, the aesthetic its community already uses — and report it as concrete visual material.',
          'Answer in at most 120 words, as three labelled lines and nothing else:',
          'SUBJECT: the single literal thing that should be in the picture (a character, an object, a scene). Be specific — "a smug cartoon frog in a tracksuit", not "a mascot".',
          'MOOD: 3-6 adjectives.',
          'PALETTE: 2-4 named colours.',
          'If you genuinely cannot find anything about this token, say SUBJECT: unknown and base MOOD and PALETTE on the ticker alone. Never invent a partnership, a price, a person, or a claim about the project.',
        ].join(' '),
      },
      {
        role: 'user',
        content: lines.join('\n'),
      },
    ];
  }

  /** Parse the brain's three lines back into structure. Tolerant by design. */
  function parseBrief(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    const grab = (label) => {
      const re = new RegExp(label + '\\s*:\\s*([^\\n]*)', 'i');
      const m = raw.match(re);
      return m ? m[1].trim() : '';
    };
    const subject = grab('SUBJECT');
    const brief = {
      subject: /^unknown\b/i.test(subject) ? '' : subject,
      mood: grab('MOOD'),
      palette: grab('PALETTE'),
      raw,
    };
    if (!brief.subject && !brief.mood && !brief.palette) {
      // Model ignored the format. Its prose is still better than nothing.
      brief.subject = raw.slice(0, 300);
    }
    return brief;
  }

  /**
   * Turn facts + (optional) brief + style + spec into the final image prompt.
   *
   * Works with NO brief at all — the brain is optional, so this must produce
   * something decent from the ticker alone.
   */
  function buildImagePrompt(opts) {
    const o = opts || {};
    const facts = o.facts || {};
    const brief = o.brief || null;
    const spec = o.spec || ASSET_KINDS[DEFAULT_KIND];
    const style = styleById(o.styleId);
    const sym = cleanFact(facts.symbol, 24);
    const name = cleanFact(facts.name, 60);

    const subject = (brief && brief.subject)
      ? brief.subject
      : `a bold original mascot or emblem for a memecoin called ${name || sym || 'this token'}`;

    const parts = [];
    parts.push(subject);
    if (brief && brief.mood) parts.push(`Mood: ${brief.mood}.`);
    if (brief && brief.palette) parts.push(`Palette: ${brief.palette}.`);
    parts.push(`Style: ${style.hint}.`);
    parts.push(`Composition: ${spec.composition}.`);

    if (o.withTicker && sym) {
      // Image models can set short type now, but only if you are explicit and
      // give them ONE string. Anything longer than a ticker turns to mush.
      parts.push(`Include the text "${sym.toUpperCase()}" once, spelled exactly, as clean bold lettering integrated into the artwork. No other text, no letters, no watermark, no signature.`);
    } else {
      parts.push('No text, no letters, no numbers, no watermark, no signature, no UI chrome.');
    }

    if (o.extra) parts.push(cleanFact(o.extra, 400));

    parts.push('Do not depict real people, real logos, or existing trademarked characters.');

    return parts.join(' ');
  }

  /* -------------------- request builders: brain -------------------- */

  function trimEndpoint(url) {
    return String(url || '').replace(/\/+$/, '');
  }

  /**
   * @param cfg {endpoint, apiKey, model, useSearch}
   * @returns {url, headers, body, retryWithout?} — retryWithout names a body
   *          key the caller may drop and retry once on a 4xx. Live Search
   *          parameters are the one thing here whose exact schema we cannot
   *          verify from inside this repo, so the request is built to survive
   *          being wrong rather than to assume it is right.
   */
  function buildResearchRequest(provider, cfg, facts) {
    const p = typeof provider === 'string' ? brainById(provider) : provider;
    if (!p) return { error: 'Unknown brain provider' };
    const c = cfg || {};
    const endpoint = trimEndpoint(c.endpoint || p.endpoint);
    if (!endpoint) return { error: 'No endpoint configured for the narrative model' };
    const model = cleanFact(c.model, 120);
    if (!model) return { error: 'Pick a model for the narrative AI first' };
    const messages = buildResearchMessages(facts);

    if (p.kind === 'anthropic') {
      return {
        url: endpoint + '/messages',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': c.apiKey || '',
          'anthropic-version': '2023-06-01',
          // Required for any request whose origin is a browser context; an
          // MV3 worker counts as one.
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: {
          model,
          max_tokens: 400,
          system: messages[0].content,
          messages: [{ role: 'user', content: messages[1].content }],
        },
      };
    }

    const auth = Object.assign(
      { 'Content-Type': 'application/json' },
      c.apiKey ? { Authorization: 'Bearer ' + c.apiKey } : {},
    );

    // Search lane: /v1/responses with a server-side search tool.
    //
    // The old `search_parameters` field on /chat/completions is GONE — xAI
    // retired Live Search and the endpoint now answers 410 Gone — and
    // /chat/completions accepts function tools only, so searching from there
    // is not possible at any shape. Anything that still sends the old field
    // silently gets a no-search answer at best.
    if (p.searchTools && p.searchTools.length && c.useSearch !== false) {
      const messages = buildResearchMessages(facts);
      return {
        url: endpoint + '/responses',
        headers: auth,
        // One combined user item rather than system+user roles: this is a
        // single-turn extraction, and collapsing it removes all schema risk
        // around which role names this endpoint accepts.
        body: {
          model,
          input: [{ role: 'user', content: messages[0].content + '\n\n' + messages[1].content }],
          tools: p.searchTools.map((t) => ({ type: t })),
        },
        // A key without search entitlement still gets a brief, just an
        // unsearched one, rather than nothing at all.
        retryWithout: 'tools',
        via: 'responses',
      };
    }

    // Opus-tier Anthropic models reject `temperature` outright and several
    // newer OpenAI-compatible models ignore it; we simply never send it.
    return {
      url: endpoint + '/chat/completions',
      headers: auth,
      body: { model, messages: buildResearchMessages(facts), max_tokens: 400 },
      via: 'chat',
    };
  }

  /**
   * Read the brief out of whichever envelope came back.
   *
   * Three shapes, detected structurally rather than by provider id, because
   * one provider can answer in two of them: the same xAI key hits /responses
   * for a searched brief and /chat/completions for an unsearched one.
   */
  function parseResearch(provider, json) {
    const p = typeof provider === 'string' ? brainById(provider) : provider;
    const j = json || {};
    let text = '';
    const sources = [];

    if (p && p.kind === 'anthropic') {
      const blocks = Array.isArray(j.content) ? j.content : [];
      text = blocks.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
    } else if (typeof j.output_text === 'string' && j.output_text) {
      // Responses API convenience field.
      text = j.output_text;
    } else if (Array.isArray(j.output)) {
      // Responses API: output[] -> content[] -> {type:'output_text', text,
      // annotations:[{type:'url_citation', url, title}]}.
      for (const item of j.output) {
        const parts = (item && item.content) || [];
        if (!Array.isArray(parts)) continue;
        for (const part of parts) {
          if (!part) continue;
          if (typeof part.text === 'string') text += part.text;
          const notes = Array.isArray(part.annotations) ? part.annotations : [];
          for (const note of notes) {
            if (note && note.url) sources.push(note.url);
          }
        }
      }
    } else {
      const choice = (Array.isArray(j.choices) && j.choices[0]) || null;
      const msg = choice && choice.message;
      if (msg) {
        text = typeof msg.content === 'string'
          ? msg.content
          : (Array.isArray(msg.content)
            ? msg.content.map((c) => (c && (c.text || c.content)) || '').join('')
            : '');
      }
    }

    if (!text) return null;
    const brief = parseBrief(text);
    if (!brief) return null;
    // Surfacing what it read is the difference between "trust me" and a
    // citation the user can click.
    if (Array.isArray(j.citations)) {
      for (const c of j.citations) {
        const url = typeof c === 'string' ? c : (c && c.url) || '';
        if (url) sources.push(url);
      }
    }
    brief.sources = sources.filter((u, i) => sources.indexOf(u) === i).slice(0, 8);
    return brief;
  }

  /* -------------------- request builders: hands -------------------- */

  const OPENAI_SIZES = [[1024, 1024], [1536, 1024], [1024, 1536]];
  const GEMINI_SIZES = [[1024, 1024], [1344, 768], [768, 1344]];
  const STABILITY_RATIOS = [
    { ar: '1:1', w: 1024, h: 1024 },
    { ar: '3:2', w: 1216, h: 832 },
    { ar: '16:9', w: 1344, h: 768 },
    { ar: '21:9', w: 1536, h: 640 },
    { ar: '2:3', w: 832, h: 1216 },
    { ar: '9:16', w: 768, h: 1344 },
  ];

  /**
   * Substitute {{prompt}} / {{width}} / {{height}} / {{n}} / {{model}} into a
   * user-authored template. String-level so the template can be any JSON the
   * provider wants; JSON.parse validates it before it ever reaches fetch().
   */
  function renderTemplate(tpl, vars) {
    const v = vars || {};
    return String(tpl || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, key) => {
      if (!(key in v)) return whole;
      const val = v[key];
      if (typeof val === 'number') return String(val);
      // JSON.stringify then strip the quotes: escapes quotes/newlines in the
      // prompt so a template author's "{{prompt}}" stays valid JSON.
      const s = JSON.stringify(String(val));
      return s.slice(1, -1);
    });
  }

  /** Walk a dotted/bracketed path — `data.0.b64_json`, `images[0].url`. */
  function pluck(obj, path) {
    if (!path) return undefined;
    const keys = String(path).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
    let cur = obj;
    for (const k of keys) {
      if (cur == null) return undefined;
      cur = cur[k];
    }
    return cur;
  }

  function buildImageRequest(provider, cfg, opts) {
    const p = typeof provider === 'string' ? handsById(provider) : provider;
    if (!p) return { error: 'Unknown image provider' };
    const c = cfg || {};
    const o = opts || {};
    const prompt = String(o.prompt || '').trim();
    if (!prompt) return { error: 'Empty prompt' };
    const spec = o.spec || ASSET_KINDS[DEFAULT_KIND];
    const endpoint = trimEndpoint(c.endpoint || p.endpoint);
    if (!endpoint) return { error: 'No endpoint configured for the image AI' };
    const model = cleanFact(c.model, 120);

    if (p.kind === 'openai-image') {
      if (!model) return { error: 'Pick an image model first' };
      const size = requestSize(spec, OPENAI_SIZES);
      const body = { model, prompt, n: 1 };
      // xAI documents model/prompt/n/response_format and no `size`, so we do
      // not send one there at all. Elsewhere it is a hint worth having, and
      // droppable: some OpenAI-compatible servers reject it, and losing the
      // aspect hint beats losing the image.
      if (!p.noSize) body.size = `${size.w}x${size.h}`;
      return {
        url: endpoint + '/images/generations',
        headers: Object.assign(
          { 'Content-Type': 'application/json' },
          c.apiKey ? { Authorization: 'Bearer ' + c.apiKey } : {},
        ),
        body,
        retryWithout: p.noSize ? undefined : 'size',
        want: size,
      };
    }

    if (p.kind === 'gemini-image') {
      if (!model) return { error: 'Pick an image model first' };
      const size = requestSize(spec, GEMINI_SIZES);
      return {
        url: `${endpoint}/models/${encodeURIComponent(model)}:generateContent`,
        headers: Object.assign(
          { 'Content-Type': 'application/json' },
          c.apiKey ? { 'x-goog-api-key': c.apiKey } : {},
        ),
        body: {
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { responseModalities: ['IMAGE'] },
        },
        want: size,
      };
    }

    if (p.kind === 'stability-image') {
      const targetAR = (spec.w || 1) / (spec.h || 1);
      let pick = STABILITY_RATIOS[0];
      let bestScore = Infinity;
      for (const cand of STABILITY_RATIOS) {
        const score = Math.abs(Math.log((cand.w / cand.h) / targetAR));
        if (score < bestScore) { bestScore = score; pick = cand; }
      }
      return {
        url: `${endpoint}/stable-image/generate/${encodeURIComponent(model || 'core')}`,
        headers: Object.assign(
          { Accept: 'application/json' },
          c.apiKey ? { Authorization: 'Bearer ' + c.apiKey } : {},
        ),
        // Stability wants multipart, not JSON — the worker builds the
        // FormData from these fields.
        form: { prompt, aspect_ratio: pick.ar, output_format: 'png' },
        want: { w: pick.w, h: pick.h },
      };
    }

    if (p.kind === 'custom-image') {
      const url = trimEndpoint(c.endpoint);
      if (!url) return { error: 'Custom provider needs a full endpoint URL' };
      const size = requestSize(spec, OPENAI_SIZES);
      let headers = { 'Content-Type': 'application/json' };
      if (c.headersJson) {
        try {
          const extra = JSON.parse(c.headersJson);
          if (!extra || typeof extra !== 'object' || Array.isArray(extra)) {
            return { error: 'Custom headers must be a JSON object' };
          }
          headers = Object.assign(headers, extra);
        } catch (e) {
          return { error: 'Custom headers are not valid JSON' };
        }
      }
      if (c.apiKey && !Object.keys(headers).some((k) => k.toLowerCase() === 'authorization')) {
        headers.Authorization = 'Bearer ' + c.apiKey;
      }
      const rendered = renderTemplate(
        c.bodyTemplate || '{"prompt":"{{prompt}}","width":{{width}},"height":{{height}}}',
        { prompt, width: size.w, height: size.h, n: 1, model: model || '' },
      );
      let body;
      try {
        body = JSON.parse(rendered);
      } catch (e) {
        return { error: 'Custom body template did not produce valid JSON. Check the braces around {{prompt}}.' };
      }
      return { url, headers, body, want: size, responsePath: c.responsePath || '' };
    }

    return { error: 'Unsupported image provider' };
  }

  /**
   * Pull image payloads out of whatever came back.
   *
   * Deliberately a union rather than one path per provider: these APIs move,
   * and a tolerant reader that finds the bytes is worth more than a strict
   * one that is right about the schema and returns nothing. `responsePath`
   * (custom providers) is tried FIRST so an explicit answer always wins.
   *
   * @returns {images: [{b64?, url?, mime}], error?}
   */
  function parseImages(json, responsePath) {
    const j = json || {};
    const out = [];
    const push = (val, mime) => {
      if (!val || typeof val !== 'string') return;
      if (/^https?:\/\//i.test(val)) out.push({ url: val, mime: mime || 'image/png' });
      else if (/^data:image\//i.test(val)) {
        const comma = val.indexOf(',');
        out.push({ b64: val.slice(comma + 1), mime: val.slice(5, val.indexOf(';')) || 'image/png' });
      } else if (val.length > 64) out.push({ b64: val, mime: mime || 'image/png' });
    };

    if (responsePath) {
      const hit = pluck(j, responsePath);
      if (Array.isArray(hit)) hit.forEach((v) => push(v));
      else push(hit);
      if (out.length) return { images: out };
    }

    // OpenAI / xAI: {data:[{b64_json|url}]}
    if (Array.isArray(j.data)) {
      for (const d of j.data) {
        if (!d) continue;
        push(d.b64_json);
        push(d.url);
        push(d.image);
      }
    }
    // Stability v2: {image: "<b64>"} or {artifacts:[{base64}]}
    push(j.image);
    if (Array.isArray(j.artifacts)) j.artifacts.forEach((a) => a && push(a.base64 || a.b64_json));
    // Generic {images: [...]}
    if (Array.isArray(j.images)) {
      j.images.forEach((im) => {
        if (typeof im === 'string') push(im);
        else if (im) push(im.b64_json || im.base64 || im.b64 || im.image || im.url);
      });
    }
    // Gemini: candidates[].content.parts[].inline_data.data
    if (Array.isArray(j.candidates)) {
      for (const cand of j.candidates) {
        const parts = (cand && cand.content && cand.content.parts) || [];
        for (const part of parts) {
          const inline = part && (part.inline_data || part.inlineData);
          if (inline && inline.data) push(inline.data, inline.mime_type || inline.mimeType);
        }
      }
    }

    if (out.length) return { images: out };
    // An explicit provider error beats "no images found".
    const err = (j.error && (j.error.message || j.error.type)) || j.message || '';
    return { images: [], error: err ? String(err).slice(0, 300) : 'The provider replied, but with no image in it.' };
  }

  /* -------------------- cache keys -------------------- */

  function briefKey(facts) {
    const f = facts || {};
    return 'b:' + (cleanFact(f.mint, 64) || cleanFact(f.symbol, 24) || 'unknown').toLowerCase();
  }

  function imageKey(facts, spec, styleId, promptText) {
    const f = facts || {};
    let hash = 5381;
    const s = String(promptText || '');
    for (let i = 0; i < s.length; i++) hash = ((hash * 33) ^ s.charCodeAt(i)) >>> 0;
    return [
      'i',
      (cleanFact(f.mint, 64) || cleanFact(f.symbol, 24) || 'unknown').toLowerCase(),
      (spec && spec.w) || 0,
      (spec && spec.h) || 0,
      styleId || DEFAULT_STYLE,
      hash.toString(36),
    ].join(':');
  }

  /** A filename the site (and the user's downloads folder) can live with. */
  function fileName(facts, spec) {
    const f = facts || {};
    const base = (cleanFact(f.symbol, 20) || cleanFact(f.name, 20) || 'token')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'token';
    return `${base}-${(spec && spec.id) || 'image'}-${(spec && spec.w) || 0}x${(spec && spec.h) || 0}.png`;
  }

  const api = {
    VERSION,
    ASSET_KINDS, DEFAULT_KIND, STYLES, DEFAULT_STYLE, styleById,
    BRAINS, HANDS, brainById, handsById,
    redact,
    readSpecFromText, readKindFromText, resolveSpec, planFit, requestSize,
    buildResearchMessages, parseBrief, buildImagePrompt,
    buildResearchRequest, parseResearch,
    buildImageRequest, parseImages, renderTemplate, pluck,
    briefKey, imageKey, fileName,
  };

  if (typeof window !== 'undefined') window.PTForge = api;
  if (typeof self !== 'undefined') self.PTForge = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
