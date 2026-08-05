/* PaperTrench — warm X links, trading-site side (ISOLATED world).
 *
 * Three jobs:
 *  1. Keep the MAIN-world hook told whether the user's opt-in is on (the hook
 *     itself cannot read extension storage).
 *  2. Intercept plain-anchor clicks on X post/profile links at the capture
 *     phase and route them to the background's warm viewer tab. Capture phase
 *     matters twice over: it runs before the site's own delegated handlers
 *     (several of these sites preventDefault + window.open themselves, so
 *     stopping propagation here is what prevents a double open), and it is the
 *     only place a target="_blank" anchor can be caught at all — those never
 *     call window.open.
 *  3. Relay the MAIN-world hook's programmatic opens to the background.
 *
 * Modified clicks (ctrl / cmd / shift / alt / non-primary button) are passed
 * through untouched — "open in a real background tab and keep reading" is a
 * workflow, not a bug. Middle clicks fire auxclick, which is not listened to,
 * so they are native by construction.
 */
(() => {
  'use strict';
  if (window.__ptWarmLinks) return;
  window.__ptWarmLinks = true;

  const HOOK_TAG = 'papertrench-warmhook';
  const STATE_TAG = 'papertrench-warmstate';

  let enabled = false;
  let cardsEnabled = false;    // tweet preview card on X-link hover (opt-in)
  let rowHoverEnabled = false; // trigger the preview from anywhere on a row (opt-in)

  function contextAlive() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (_) { return false; }
  }

  function pushStateToPage() {
    window.postMessage({ source: STATE_TAG, enabled }, window.location.origin);
  }

  function setEnabled(next) {
    const on = next === true;
    const turnedOn = on && !enabled;
    enabled = on;
    pushStateToPage();
    // Pre-warm as soon as a trading tab knows the feature is on, so the FIRST
    // X click of the session is already warm — the reference design only
    // warmed after a click, making every first open a cold one.
    if (turnedOn && contextAlive()) {
      chrome.runtime.sendMessage({ type: 'pt_warm_prewarm' }).catch(() => {});
    }
  }

  // Both switches must be up: the feature's own toggle AND the app-wide
  // master switch — "PaperTrench off" includes link interception. The two
  // hover-preview settings are opt-in refinements under the same umbrella.
  function applySettings(settings) {
    const on = !!(settings && settings.appEnabled !== false && settings.warmXLinksEnabled);
    cardsEnabled = !!(settings && settings.warmHoverCardsEnabled);
    rowHoverEnabled = !!(settings && settings.warmHoverRowEnabled);
    setEnabled(on);
  }

  chrome.storage.local.get(['pt_settings'], (value) => {
    if (chrome.runtime && chrome.runtime.lastError) return;
    applySettings(value.pt_settings);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.pt_settings) return;
    applySettings(changes.pt_settings.newValue);
  });

  function requestWarmOpen(url) {
    if (!contextAlive()) return false;
    try {
      chrome.runtime.sendMessage({ type: 'pt_warm_open', url }).catch(() => {});
      return true;
    } catch (_) {
      return false;
    }
  }

  /** The anchor a pointer event is really aimed at. composedPath() beats
   * target.closest() twice over: shadow DOM retargets `target` to the shadow
   * HOST for listeners out here (hiding the anchor from closest), and the
   * path is computed at dispatch, so it survives sites that re-render the
   * row mid-click. Falls back to closest() where composedPath is missing. */
  function anchorFromEvent(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : null;
    if (path) {
      for (const node of path) {
        if (node && String(node.tagName).toUpperCase() === 'A'
            && node.getAttribute && node.getAttribute('href')) return node;
      }
      return null;
    }
    const target = event.target;
    return target && target.closest ? target.closest('a[href]') : null;
  }

  // WINDOW capture, not document: the window is the first node of the
  // capture path, so no site handler registered deeper (several of these
  // terminals stop propagation aggressively) can eat the click before this
  // sees it.
  window.addEventListener('click', (event) => {
    if (!enabled || event.defaultPrevented) return;
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const anchor = anchorFromEvent(event);
    if (!anchor) return;
    const X = window.PTXLinks;
    const href = anchor.getAttribute('href');
    const target = X ? X.classify(href, window.location.href) : null;
    if (!target) {
      // An X-host link in a form the classifier refused: log it locally, so
      // "warm links don't work on <site>" comes with the exact URL shape.
      try {
        const u = new URL(href, window.location.href);
        if (X && X.isXHost(u.hostname)) {
          console.debug('PaperTrench warm links: unhandled X link form, opening natively: ' + u.href);
        }
      } catch (_) {}
      return;
    }
    // Only claim the click once the message is actually away — with a dead
    // extension context the native navigation must win, not a swallowed click.
    if (!requestWarmOpen(target.url)) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);

  /* Hover prefetch. A trader hovers a link a beat before clicking it — that
   * dwell is free latency budget. After 120ms on an X link, hint the
   * background: it silently SPA-navigates the HIDDEN viewer to the target, so
   * the eventual click is nothing but "reveal the tab" (~0ms perceived). A
   * hover that never becomes a click costs nothing — the hidden tab is simply
   * parked on a different X page, which is an equally warm place to wait.
   * The hint also wakes the MV3 service worker off the click's critical path.
   * The background enforces the safety rules (never redirect a viewer the
   * user is actually looking at; a hover never creates tabs). */
  const HINT_DWELL_MS = 120;
  const HINT_REPEAT_MS = 5000;
  let hintTimer = 0;
  let hintUrl = '';
  let lastHint = { url: '', t: 0 };

  /* ---- preview card (opt-in) --------------------------------------------
   * The terminals' own tweet previews are small and demand pixel-precise
   * hovering on a 14px icon. This card is big, styled for reading, and is
   * itself the click target — clicking anywhere on it warm-opens the target,
   * so nobody has to aim at the icon twice. Post cards render the tweet via
   * the background's oEmbed fetch (cached; a deleted post shows "unavailable"
   * BEFORE anyone spends a click on it). Communities and profiles have no
   * public content endpoint, so they get a slim type card that is still a
   * big click-through. Remote text goes in via textContent only — page-world
   * data never touches innerHTML. */
  let cardHost = null;
  let cardBody = null;
  let cardPendingUrl = '';
  let hideTimer = 0;

  function hideCard() {
    cardPendingUrl = '';
    if (cardHost) cardHost.style.display = 'none';
  }
  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hideCard, 200);
  }

  function ensureCard() {
    if (cardHost && cardHost.isConnected) return true;
    if (!document.body || !document.createElement) return false;
    cardHost = document.createElement('div');
    cardHost.style.cssText = 'position:fixed;top:0;left:0;z-index:2147483646;display:none;';
    const shadow = cardHost.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = [
      '.card{width:440px;max-width:calc(100vw - 24px);box-sizing:border-box;',
      'background:#0E1219;border:1px solid rgba(255,255,255,.13);border-radius:12px;',
      'padding:13px 15px;color:#EAEFF7;cursor:pointer;',
      'font:13.5px/1.5 ui-sans-serif,-apple-system,"Segoe UI",Inter,sans-serif;',
      'box-shadow:0 14px 44px -10px rgba(0,0,0,.75)}',
      '.card:hover{border-color:rgba(255,157,69,.45)}',
      '.author{font-weight:750;font-size:13.5px}',
      '.author.gone{color:#FFB3AE}',
      '.text{margin-top:5px;white-space:pre-wrap;overflow-wrap:break-word;max-height:190px;overflow:hidden}',
      '.date{margin-top:6px;font-size:11.5px;color:#8D97A9}',
      '.foot{margin-top:9px;padding-top:8px;border-top:1px solid rgba(255,255,255,.07);',
      'font-size:11px;color:#FF9D45;font-weight:700}',
    ].join('');
    cardBody = document.createElement('div');
    cardBody.className = 'card';
    shadow.append(style, cardBody);
    cardHost.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    cardHost.addEventListener('mouseleave', scheduleHide);
    cardHost.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const url = cardHost.getAttribute('data-url');
      hideCard();
      if (url) requestWarmOpen(url);
    }, true);
    document.body.appendChild(cardHost);
    return true;
  }

  function showCard(rect, target, data) {
    if (!ensureCard()) return;
    while (cardBody.firstChild) cardBody.removeChild(cardBody.firstChild);
    const row = (cls, text) => {
      const el = document.createElement('div');
      el.className = cls;
      el.textContent = text;
      cardBody.appendChild(el);
      return el;
    };
    if (target.kind === 'post') {
      if (!data) return;
      if (data.gone) {
        row('author gone', '𝕏 Post unavailable');
        row('text', 'Deleted or restricted. For a launch tweet, that is a signal by itself.');
      } else {
        row('author', data.authorName || 'Post');
        row('text', data.text || '');
        if (data.date) row('date', data.date);
      }
    } else if (target.kind === 'community') {
      row('author', '𝕏 Community');
      row('text', 'The token’s X community — prefetched in the warm viewer.');
    } else if (target.kind === 'profile') {
      row('author', '@' + (target.handle || ''));
      row('text', 'X profile — prefetched in the warm viewer.');
    } else {
      return;
    }
    row('foot', 'Click to open instantly →');
    cardHost.setAttribute('data-url', target.url);
    cardHost.style.display = 'block';
    const width = 452;
    const height = cardHost.getBoundingClientRect().height || 160;
    let left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    let top = rect.bottom + 8;
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 8);
    cardHost.style.left = left + 'px';
    cardHost.style.top = top + 'px';
  }

  function requestCard(anchor, target) {
    if (!anchor || !anchor.getBoundingClientRect) return;
    const rect = anchor.getBoundingClientRect();
    cardPendingUrl = target.url;
    if (target.kind === 'post') {
      if (!contextAlive()) return;
      try {
        chrome.runtime.sendMessage({ type: 'pt_warm_oembed', url: target.url }).then((data) => {
          // Cursor may have moved on while the fetch ran; a stale card is
          // worse than no card.
          if (cardPendingUrl !== target.url) return;
          if (data && data.ok) showCard(rect, target, data);
        }).catch(() => {});
      } catch (_) {}
    } else {
      showCard(rect, target, null);
    }
  }

  /** Row mode (opt-in): resolve the hovered element's token row — the nearest
   * ancestor containing 1-3 X links — and preview its best link (post over
   * community over profile) without the cursor ever touching the icon.
   * Runs only after the dwell, walks at most 8 ancestors, and refuses
   * containers with more than 3 X links (that is the list, not a row). */
  function resolveRow(el) {
    const X = window.PTXLinks;
    if (!X) return null;
    let node = el;
    for (let depth = 0; node && node !== document.body && depth < 8; depth++, node = node.parentElement) {
      if (!node.querySelectorAll) continue;
      const found = [];
      for (const a of node.querySelectorAll('a[href]')) {
        const t = X.classify(a.getAttribute('href'), window.location.href);
        if (t) {
          found.push({ a, t });
          if (found.length > 3) return null;
        }
      }
      if (found.length) {
        const pick = found.find((f) => f.t.kind === 'post')
          || found.find((f) => f.t.kind === 'community')
          || found[0];
        return { row: node, anchor: pick.a, target: pick.t };
      }
    }
    return null;
  }

  function fireHover(anchor, target, viaRow) {
    const now = Date.now();
    if (!(lastHint.url === target.url && now - lastHint.t < HINT_REPEAT_MS)) {
      lastHint = { url: target.url, t: now };
      if (contextAlive()) {
        try { chrome.runtime.sendMessage({ type: 'pt_warm_hint', url: target.url }).catch(() => {}); } catch (_) {}
      }
    }
    if (cardsEnabled || viaRow) requestCard(anchor, target);
  }

  const ROW_DWELL_MS = 350;
  let rowTimer = 0;
  let currentRow = null;

  window.addEventListener('mouseover', (event) => {
    if (!enabled) return;
    // Inside the card: it stays.
    if (cardHost && typeof event.composedPath === 'function' && event.composedPath().includes(cardHost)) {
      clearTimeout(hideTimer);
      return;
    }
    const anchor = anchorFromEvent(event);
    const X = window.PTXLinks;
    const target = anchor && X ? X.classify(anchor.getAttribute('href'), window.location.href) : null;

    if (target) {
      clearTimeout(hideTimer);
      if (target.url === hintUrl) return; // dwell already running/sent for this
      clearTimeout(hintTimer);
      hintUrl = target.url;
      hintTimer = setTimeout(() => fireHover(anchor, target, false), HINT_DWELL_MS);
      return;
    }

    scheduleHide();
    if (!rowHoverEnabled) return;
    if (currentRow && currentRow.contains && currentRow.contains(event.target)) return; // same row: keep waiting/showing
    currentRow = null;
    clearTimeout(rowTimer);
    const from = event.target;
    rowTimer = setTimeout(() => {
      const hit = resolveRow(from);
      if (!hit) return;
      currentRow = hit.row;
      fireHover(hit.anchor, hit.target, true);
    }, ROW_DWELL_MS);
  }, true);

  // A scrolling list slides the row out from under the card; a stale card
  // floating over the wrong row misleads, so any scroll dismisses it.
  window.addEventListener('scroll', () => { if (cardHost) hideCard(); }, true);
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && cardHost) hideCard();
  }, true);

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== HOOK_TAG || data.type !== 'warm-open') return;
    if (!enabled || typeof data.url !== 'string') return;
    // MAIN-world data is page-controlled: re-classify rather than trust it.
    const X = window.PTXLinks;
    const target = X ? X.classify(data.url, window.location.href) : null;
    if (target) requestWarmOpen(target.url);
  });
})();
