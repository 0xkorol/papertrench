/* PaperTrench — Forge (banner generator inside the dex's own upload box).
 *
 * Community ask (AmpBets, relayed 2026-08-06): "I don't think any of the tools
 * have a generator for dex banner — if you could generate it on the page
 * without having to pull up Grok or whatever."
 *
 * WHAT THIS HOOKS ONTO, AND WHY IT IS NOT A SELECTOR LIST
 * ------------------------------------------------------
 * The paid "fund / boost / enhance token info" checkout boxes sit behind a
 * login on every venue that has one (verified on DEX Screener's own order
 * page: /product/token-info/order answers "Account required!" to a logged-out
 * probe). We therefore cannot see the markup we would be matching, and this
 * codebase has already paid for guessed selectors three times over.
 *
 * So Forge anchors on the one thing that MUST be true of any box that takes
 * an image: it contains an `<input type=file>` that accepts images. That is
 * invariant across every venue, survives their redesigns, and works on forms
 * we have never laid eyes on. The dimensions come off the box's own copy at
 * runtime (readSpecFromText) rather than from a table of numbers we would be
 * inventing — the box always tells the user what size it wants.
 *
 * WE NEVER MUTATE THE HOST PAGE
 * -----------------------------
 * The chip and the panel live in one fixed-position shadow host of ours and
 * are POSITIONED OVER the upload slot. Injecting a button into a React modal
 * gets it reconciled away mid-render and can break the site's own layout; a
 * floating anchor cannot. Everything reflows on scroll/resize via rAF.
 *
 * Keys never touch this file. The content script sends facts to the service
 * worker and gets pixels back.
 */
(() => {
  'use strict';

  const F = (typeof window !== 'undefined' && window.PTForge) || null;
  const S = (typeof window !== 'undefined' && window.PaperTrenchSites) || null;
  if (!F) return;

  const HOST_ID = 'papertrench-forge';
  const SCAN_DEBOUNCE_MS = 160;

  // Buttons that open a paid checkout. Used ONLY to start the narrative
  // research early (the Turbo trick: by the time the box paints, the brief is
  // already home). Nothing about correctness depends on this list.
  const TRIGGER_RE = /\b(fund|boost|promote|advertis|enhanc\w*\s+token|update\s+token\s+info|token\s+info|marketing|dex\s*pay|trending)\b/i;
  const IMAGE_WORD_RE = /\b(logo|icon|image|banner|header|avatar|picture|photo|artwork|cover|thumbnail)\b/i;

  let settings = null;
  let enabled = false;
  let observer = null;
  let scanTimer = null;
  let rafPending = false;
  let contextDead = false;

  let host = null;
  let shadow = null;
  let chipLayer = null;
  let panelEl = null;

  /** slots: [{input, anchor, kind, spec, slotText, chip}] */
  let slots = [];
  let openSlot = null;
  let prewarmed = new Set();

  /* -------------------- plumbing -------------------- */

  function contextAlive() {
    if (contextDead) return false;
    try {
      return Boolean(chrome && chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  function send(payload) {
    if (!contextAlive()) return Promise.resolve(null);
    try {
      const r = chrome.runtime.sendMessage(payload);
      return r && typeof r.catch === 'function' ? r.catch(() => null) : Promise.resolve(r || null);
    } catch (_) {
      contextDead = true;
      teardown();
      return Promise.resolve(null);
    }
  }

  /* -------------------- reading the page -------------------- */

  /** Text of the upload slot and its immediate surroundings, capped. */
  function slotTextFor(el) {
    let node = el;
    let text = '';
    for (let i = 0; i < 4 && node; i++) {
      node = node.parentElement;
      if (!node) break;
      let t = '';
      try { t = node.innerText || node.textContent || ''; } catch (_) { t = ''; }
      if (t && t.length > text.length) text = t;
      if (text.length > 600) break;
    }
    // The input's own attributes often carry the answer when the copy does not.
    const attrs = [el.getAttribute('name'), el.getAttribute('id'),
      el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('accept')]
      .filter(Boolean).join(' ');
    return (attrs + ' ' + text).slice(0, 900);
  }

  function looksLikeImageInput(input, text) {
    const accept = String(input.accept || '').toLowerCase();
    if (accept) return /image|\.png|\.jpe?g|\.webp|\.gif|\.avif/.test(accept);
    // No accept attribute: only claim it when the surrounding copy is clearly
    // about a picture, so a CSV importer never grows a Generate button.
    return IMAGE_WORD_RE.test(text);
  }

  /**
   * The box to hang the chip on. File inputs are usually `display:none`
   * behind a styled dropzone, so fall back to the nearest ancestor that
   * actually occupies space — and refuse anything the size of the page,
   * which would put our chip in the middle of nowhere.
   */
  function anchorFor(input) {
    const ok = (r) => r && r.width >= 24 && r.height >= 18
      && r.width <= window.innerWidth * 0.9 && r.height <= window.innerHeight * 0.9;
    let r = null;
    try { r = input.getBoundingClientRect(); } catch (_) { r = null; }
    if (ok(r)) return input;
    let node = input.parentElement;
    for (let i = 0; i < 5 && node; i++) {
      let nr = null;
      try { nr = node.getBoundingClientRect(); } catch (_) { nr = null; }
      if (ok(nr)) return node;
      node = node.parentElement;
    }
    return null;
  }

  function visibleRect(el) {
    let r = null;
    try { r = el.getBoundingClientRect(); } catch (_) { return null; }
    if (!r || r.width <= 0 || r.height <= 0) return null;
    if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) return null;
    return r;
  }

  /** What token is this page about? Cheap, and the user can override it. */
  function readFacts() {
    const facts = { symbol: '', name: '', mint: '', chain: '', description: '', socials: '' };
    try {
      if (S && typeof S.currentSite === 'function') {
        const adapter = S.currentSite();
        const det = adapter && typeof adapter.detect === 'function' ? adapter.detect() : null;
        if (det && det.address) {
          facts.mint = det.address;
          // Adapters name the chain themselves since the multichain pass
          // (d51210a). Trust what the adapter says over assuming Solana — a
          // banner brief that calls a Base token "solana" is a wrong fact
          // handed to the model.
          facts.chain = det.chain || (det.kind === 'pair' ? '' : 'solana');
        }
      }
    } catch (_) { /* adapters never block the panel */ }

    // Any address the checkout box itself is carrying beats the URL's.
    if (!facts.mint && S && S.firstBase58) {
      try {
        const fields = Array.from(document.querySelectorAll('input[type=text], input:not([type])'))
          .map((i) => i.value || '').join(' ');
        const found = S.firstBase58(fields);
        if (found) facts.mint = found;
      } catch (_) { /* ignore */ }
    }

    const meta = (sel, attr) => {
      try {
        const el = document.querySelector(sel);
        return (el && (el.getAttribute(attr) || '')) || '';
      } catch (_) { return ''; }
    };
    const title = meta('meta[property="og:title"]', 'content') || document.title || '';
    facts.description = meta('meta[name="description"]', 'content').slice(0, 600);

    // Dex titles are reliably "<PRICE> | <SYMBOL>/<QUOTE> | <NAME> | ..."
    const sym = title.match(/\$?([A-Z0-9]{2,12})\s*\//) || title.match(/\$([A-Za-z0-9]{2,12})\b/);
    if (sym) facts.symbol = sym[1].toUpperCase();
    const nameBit = title.split('|').map((s) => s.trim()).filter(Boolean);
    if (nameBit.length > 2) facts.name = nameBit[2].slice(0, 60);
    if (!facts.name && nameBit.length) facts.name = nameBit[nameBit.length - 1].slice(0, 60);
    return facts;
  }

  /* -------------------- shadow host -------------------- */

  const CSS = `
    :host { all: initial; }
    .layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483000;
      font: 500 12px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
    .chip { position: fixed; pointer-events: auto; display: inline-flex; align-items: center; gap: 5px;
      padding: 5px 9px; border-radius: 8px; border: 1px solid #3ddc97;
      background: linear-gradient(180deg, #10241c, #0b1a14); color: #3ddc97;
      cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,.45); white-space: nowrap;
      font-weight: 700; letter-spacing: .2px; }
    .chip:hover { background: #14332a; }
    .chip .spark { font-size: 13px; line-height: 1; }
    .panel { position: fixed; pointer-events: auto; width: 340px; max-height: 78vh; overflow: auto;
      background: #0d1117; color: #e6edf3; border: 1px solid #30363d; border-radius: 12px;
      box-shadow: 0 18px 50px rgba(0,0,0,.6); padding: 12px; }
    .panel h4 { margin: 0 0 2px; font-size: 13px; font-weight: 800; color: #3ddc97; }
    .sub { color: #8b949e; font-size: 11px; margin: 0 0 10px; }
    .row { margin: 0 0 9px; }
    .row label { display: block; font-size: 11px; color: #8b949e; margin: 0 0 3px; }
    input[type=text], select, textarea { width: 100%; box-sizing: border-box; background: #010409;
      border: 1px solid #30363d; color: #e6edf3; border-radius: 7px; padding: 6px 8px;
      font: inherit; }
    textarea { resize: vertical; min-height: 46px; }
    .check { display: flex; align-items: center; gap: 6px; color: #c9d1d9; font-size: 11.5px; }
    .check input { accent-color: #3ddc97; }
    .btn { width: 100%; padding: 8px; border-radius: 8px; border: 0; cursor: pointer;
      background: #3ddc97; color: #07130e; font-weight: 800; font-size: 12.5px; }
    .btn:disabled { opacity: .55; cursor: default; }
    .btn.ghost { background: transparent; border: 1px solid #30363d; color: #8b949e; font-weight: 600; }
    .status { font-size: 11px; color: #8b949e; margin: 8px 0 0; min-height: 14px; }
    .status.err { color: #ff7b72; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin-top: 9px; }
    .shot { border: 1px solid #30363d; border-radius: 8px; overflow: hidden; background: #010409; cursor: pointer; }
    .shot img { display: block; width: 100%; height: auto; }
    .shot.sel { border-color: #3ddc97; box-shadow: 0 0 0 1px #3ddc97; }
    .shot .cap { font-size: 10px; color: #8b949e; padding: 3px 5px; text-align: center; }
    .close { position: absolute; top: 8px; right: 9px; background: none; border: 0; color: #8b949e;
      cursor: pointer; font-size: 15px; line-height: 1; }
    .src { font-size: 10.5px; color: #6e7681; margin-top: 7px; word-break: break-all; }
    .src a { color: #58a6ff; }
    .warn { font-size: 10.5px; color: #d29922; margin-top: 7px; }
  `;

  function ensureHost() {
    if (host && host.isConnected) return;
    const stale = document.getElementById(HOST_ID);
    if (stale && stale.remove) { try { stale.remove(); } catch (_) {} }
    host = document.createElement('div');
    host.id = HOST_ID;
    shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    chipLayer = document.createElement('div');
    chipLayer.className = 'layer';
    shadow.appendChild(style);
    shadow.appendChild(chipLayer);
    (document.body || document.documentElement).appendChild(host);
  }

  function teardown() {
    if (observer) { try { observer.disconnect(); } catch (_) {} observer = null; }
    if (host && host.remove) { try { host.remove(); } catch (_) {} }
    host = null; shadow = null; chipLayer = null; panelEl = null;
    slots = []; openSlot = null;
  }

  /* -------------------- slot discovery -------------------- */

  function scan() {
    if (!enabled || !contextAlive()) return;
    ensureHost();
    const seen = [];
    let inputs = [];
    try { inputs = Array.from(document.querySelectorAll('input[type="file"]')); } catch (_) { inputs = []; }

    for (const input of inputs) {
      const text = slotTextFor(input);
      if (!looksLikeImageInput(input, text)) continue;
      const anchor = anchorFor(input);
      if (!anchor) continue;
      const kindId = F.readKindFromText(text) || F.DEFAULT_KIND;
      const spec = F.resolveSpec(kindId, text);
      const prev = slots.find((s) => s.input === input);
      if (prev) {
        prev.anchor = anchor;
        prev.slotText = text;
        prev.spec = spec;
        prev.kind = kindId;
        seen.push(prev);
      } else {
        seen.push({ input, anchor, kind: kindId, spec, slotText: text, chip: null });
      }
    }

    // Drop chips for slots that vanished (modal closed, step advanced).
    for (const old of slots) {
      if (seen.indexOf(old) === -1 && old.chip) {
        try { old.chip.remove(); } catch (_) {}
        if (openSlot === old) closePanel();
      }
    }
    slots = seen;
    if (slots.length) prewarm();
    position();
  }

  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = null; scan(); }, SCAN_DEBOUNCE_MS);
  }

  function position() {
    if (!chipLayer) return;
    for (const slot of slots) {
      const r = visibleRect(slot.anchor);
      if (!r) {
        if (slot.chip) slot.chip.style.display = 'none';
        continue;
      }
      if (!slot.chip) {
        const chip = document.createElement('button');
        chip.className = 'chip';
        chip.type = 'button';
        chip.setAttribute('data-pt-forge', 'chip');
        chip.innerHTML = '<span class="spark">✦</span><span>Generate</span>';
        chip.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          openPanel(slot);
        });
        chipLayer.appendChild(chip);
        slot.chip = chip;
      }
      slot.chip.style.display = '';
      // Top-right of the slot, nudged inside so it never covers a corner X.
      const top = Math.max(4, r.top + 6);
      const left = Math.min(window.innerWidth - 108, r.right - 104);
      slot.chip.style.top = top + 'px';
      slot.chip.style.left = Math.max(4, left) + 'px';
      slot.chip.title = `PaperTrench — generate a ${slot.spec.label.toLowerCase()} (${slot.spec.w}×${slot.spec.h})`;
    }
    if (panelEl && openSlot) positionPanel();
  }

  function schedulePosition() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; position(); });
  }

  /* -------------------- prefetch (the feel-fast half) -------------------- */

  function prewarm() {
    const facts = readFacts();
    const key = F.briefKey(facts);
    if (prewarmed.has(key)) return;
    prewarmed.add(key);
    send({ type: 'pt_forge_prewarm', facts });
  }

  function onTriggerHint(ev) {
    if (!enabled) return;
    const el = ev.target;
    if (!el || !el.closest) return;
    const btn = el.closest('button, a, [role=button]');
    if (!btn) return;
    let label = '';
    try { label = (btn.innerText || btn.textContent || btn.getAttribute('aria-label') || '').slice(0, 80); } catch (_) { return; }
    if (!TRIGGER_RE.test(label)) return;
    prewarm();
  }

  /* -------------------- panel -------------------- */

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function closePanel() {
    if (panelEl) { try { panelEl.remove(); } catch (_) {} }
    panelEl = null;
    openSlot = null;
  }

  function positionPanel() {
    if (!panelEl || !openSlot) return;
    const r = visibleRect(openSlot.anchor);
    const w = 340;
    let left = r ? Math.min(window.innerWidth - w - 10, r.right - w) : window.innerWidth - w - 16;
    let top = r ? r.bottom + 8 : 70;
    if (top + 320 > window.innerHeight) top = Math.max(8, (r ? r.top : 80) - 8 - Math.min(panelEl.offsetHeight || 320, window.innerHeight - 24));
    panelEl.style.left = Math.max(8, left) + 'px';
    panelEl.style.top = Math.max(8, top) + 'px';
  }

  function openPanel(slot) {
    ensureHost();
    closePanel();
    openSlot = slot;

    const facts = readFacts();
    const spec = slot.spec;
    const p = el('div', 'panel');
    p.setAttribute('data-pt-forge', 'panel');

    const close = el('button', 'close', '✕');
    close.type = 'button';
    close.addEventListener('click', closePanel);
    p.appendChild(close);

    p.appendChild(el('h4', null, `Forge — ${spec.label}`));
    // Say where the size came from. A number we read off their page and a
    // number we defaulted to are not the same claim.
    p.appendChild(el('p', 'sub',
      `${spec.w}×${spec.h} · ${spec.source === 'page' ? 'size read from this page' : 'our preset — this box did not state one'}`));

    const subjRow = el('div', 'row');
    subjRow.appendChild(el('label', null, 'What should be in it?'));
    const subj = document.createElement('textarea');
    subj.placeholder = facts.symbol
      ? `Reading X for what $${facts.symbol} is about…`
      : 'Describe the art, or leave it to the narrative AI';
    subjRow.appendChild(subj);
    p.appendChild(subjRow);

    const styleRow = el('div', 'row');
    styleRow.appendChild(el('label', null, 'Style'));
    const styleSel = document.createElement('select');
    for (const s of F.STYLES) {
      const o = document.createElement('option');
      o.value = s.id; o.textContent = s.label;
      styleSel.appendChild(o);
    }
    styleSel.value = (settings && settings.forgeStyle) || F.DEFAULT_STYLE;
    styleRow.appendChild(styleSel);
    p.appendChild(styleRow);

    const tickRow = el('div', 'row');
    const tickLabel = el('label', 'check');
    const tick = document.createElement('input');
    tick.type = 'checkbox';
    // Lettering reads well on a wide banner and turns to mush on a 32px icon.
    tick.checked = slot.kind !== 'icon' && Boolean(facts.symbol);
    tickLabel.appendChild(tick);
    tickLabel.appendChild(document.createTextNode(
      facts.symbol ? `Put $${facts.symbol} in the art` : 'Put the ticker in the art (none detected)'));
    tickRow.appendChild(tickLabel);
    p.appendChild(tickRow);

    const go = el('button', 'btn', 'Generate');
    go.type = 'button';
    p.appendChild(go);

    const status = el('p', 'status', '');
    p.appendChild(status);
    const grid = el('div', 'grid');
    p.appendChild(grid);
    const srcLine = el('div', 'src', '');
    p.appendChild(srcLine);

    chipLayer.appendChild(p);
    panelEl = p;
    positionPanel();

    // The brief is usually already in flight from the prefetch; this just
    // collects it and fills the subject box so the user can edit it.
    send({ type: 'pt_forge_brief', facts }).then((res) => {
      if (!panelEl || panelEl !== p) return;
      if (!res) return;
      if (res.error) {
        status.className = 'status';
        status.textContent = 'Narrative AI: ' + res.error;
        subj.placeholder = 'Describe the art yourself';
        return;
      }
      const brief = res.brief;
      if (brief && brief.subject && !subj.value) subj.value = brief.subject;
      subj.placeholder = 'Describe the art, or leave it to the narrative AI';
      // Citations are MODEL output, and the model was fed page text an
      // attacker wrote (a token's own name and description). The scheme is
      // re-checked at the sink as well as at the parse boundary: this is the
      // one place in Forge where untrusted text becomes something clickable.
      const cites = (brief && Array.isArray(brief.sources) ? brief.sources : [])
        .map((u) => F.safeHttpUrl(u))
        .filter(Boolean)
        .slice(0, 4);
      if (cites.length) {
        srcLine.textContent = 'Read: ';
        cites.forEach((u, i) => {
          const a = document.createElement('a');
          a.href = u; a.target = '_blank'; a.rel = 'noopener noreferrer';
          a.textContent = `[${i + 1}]`;
          srcLine.appendChild(a);
          srcLine.appendChild(document.createTextNode(' '));
        });
      }
    });

    go.addEventListener('click', () => {
      go.disabled = true;
      status.className = 'status';
      status.textContent = 'Generating…';
      grid.textContent = '';
      const t0 = Date.now();
      send({
        type: 'pt_forge_image',
        facts,
        spec: { id: spec.id, w: spec.w, h: spec.h, label: spec.label, composition: spec.composition },
        styleId: styleSel.value,
        subject: subj.value.trim(),
        withTicker: tick.checked,
        n: Math.max(1, Math.min(4, Number(settings && settings.forgeVariants) || 2)),
      }).then((res) => {
        if (!panelEl || panelEl !== p) return;
        go.disabled = false;
        if (!res || res.error) {
          status.className = 'status err';
          status.textContent = (res && res.error) || 'No answer from the extension worker.';
          return;
        }
        const images = res.images || [];
        if (!images.length) {
          status.className = 'status err';
          status.textContent = 'The image AI returned nothing usable.';
          return;
        }
        status.className = 'status';
        status.textContent = `${images.length} in ${((Date.now() - t0) / 1000).toFixed(1)}s · click one to drop it in`;
        images.forEach((img) => {
          const cell = el('div', 'shot');
          const im = document.createElement('img');
          im.src = img.dataUrl;
          im.alt = 'generated option';
          cell.appendChild(im);
          cell.appendChild(el('div', 'cap', `${img.w}×${img.h}`));
          cell.addEventListener('click', () => {
            Array.from(grid.children).forEach((c) => c.classList.remove('sel'));
            cell.classList.add('sel');
            useImage(slot, img, facts, status);
          });
          grid.appendChild(cell);
        });
      });
    });
  }

  /* -------------------- delivery -------------------- */

  function dataUrlToFile(dataUrl, name) {
    // Validate the envelope rather than leaning on atob() to throw. It does
    // throw on stray characters, but a payload that happens to be base64-legal
    // would sail through and deliver a file of garbage to a checkout the user
    // is about to pay for.
    const s = String(dataUrl || '');
    const comma = s.indexOf(',');
    const meta = comma === -1 ? '' : s.slice(0, comma);
    if (!/^data:image\/[a-z0-9.+-]+;base64$/i.test(meta)) {
      throw new Error('not a base64 image data URL');
    }
    const mime = meta.slice(5, meta.indexOf(';'));
    const bin = atob(s.slice(comma + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name, { type: mime });
  }

  /**
   * Hand the file to the site the two ways a human can: set it on the input,
   * and if the site is listening for a drop instead, drop it on the zone.
   */
  function useImage(slot, img, facts, status) {
    let file;
    try {
      file = dataUrlToFile(img.dataUrl, F.fileName(facts, slot.spec));
    } catch (e) {
      status.className = 'status err';
      status.textContent = 'Could not build the file: ' + e.message;
      return;
    }

    let placed = false;
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      slot.input.files = dt.files;
      slot.input.dispatchEvent(new Event('input', { bubbles: true }));
      slot.input.dispatchEvent(new Event('change', { bubbles: true }));
      placed = slot.input.files && slot.input.files.length === 1;
    } catch (_) { placed = false; }

    if (!placed && slot.anchor) {
      try {
        const dt2 = new DataTransfer();
        dt2.items.add(file);
        for (const type of ['dragenter', 'dragover', 'drop']) {
          slot.anchor.dispatchEvent(new DragEvent(type, {
            bubbles: true, cancelable: true, composed: true, dataTransfer: dt2,
          }));
        }
        placed = true;
      } catch (_) { placed = false; }
    }

    if (placed) {
      status.className = 'status';
      status.textContent = 'Dropped into the upload box. Check their preview before you pay.';
    } else {
      // Never pretend. A download still gets the user their artwork.
      status.className = 'status err';
      status.textContent = 'This box would not accept a scripted file — use the download and pick it manually.';
    }

    // One link, not one per thumbnail clicked.
    if (slot.dlLink && slot.dlLink.remove) { try { slot.dlLink.remove(); } catch (_) {} }
    const dl = document.createElement('a');
    slot.dlLink = dl;
    dl.href = img.dataUrl;
    dl.download = F.fileName(facts, slot.spec);
    dl.textContent = 'Download this image';
    dl.style.cssText = 'display:block;margin-top:6px;color:#58a6ff;font-size:11px';
    status.parentNode.insertBefore(dl, status.nextSibling);
  }

  /* -------------------- lifecycle -------------------- */

  function start() {
    if (observer) return;
    ensureHost();
    observer = new MutationObserver(scheduleScan);
    try {
      observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch (_) { /* nothing to watch yet */ }
    window.addEventListener('scroll', schedulePosition, true);
    window.addEventListener('resize', schedulePosition);
    document.addEventListener('pointerover', onTriggerHint, true);
    document.addEventListener('pointerdown', onTriggerHint, true);
    scan();
  }

  function stop() {
    if (observer) { try { observer.disconnect(); } catch (_) {} observer = null; }
    window.removeEventListener('scroll', schedulePosition, true);
    window.removeEventListener('resize', schedulePosition);
    document.removeEventListener('pointerover', onTriggerHint, true);
    document.removeEventListener('pointerdown', onTriggerHint, true);
    teardown();
  }

  function applySettings(next) {
    settings = next || {};
    const want = settings.forgeEnabled === true;
    if (want === enabled) return;
    enabled = want;
    if (enabled) start(); else stop();
  }

  function boot() {
    if (!contextAlive()) return;
    try {
      chrome.storage.local.get(['pt_settings'], (v) => {
        try { applySettings((v && v.pt_settings) || {}); } catch (_) {}
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes.pt_settings) return;
        applySettings(changes.pt_settings.newValue || {});
      });
    } catch (_) { /* storage gone: stay dormant */ }
  }

  // Exposed for the test suite, which drives this against a hand-built DOM.
  // A plain reference on the isolated-world global; the page cannot see it.
  try {
    window.__ptForge = {
      scan, position, readFacts, slotTextFor, looksLikeImageInput, anchorFor,
      applySettings, useImage, dataUrlToFile,
      slotsNow: () => slots,
    };
  } catch (_) { /* ignore */ }

  boot();
})();
