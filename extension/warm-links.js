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
  // master switch — "PaperTrench off" includes link interception.
  function warmSettingsOn(settings) {
    return !!(settings && settings.appEnabled !== false && settings.warmXLinksEnabled);
  }

  chrome.storage.local.get(['pt_settings'], (value) => {
    if (chrome.runtime && chrome.runtime.lastError) return;
    setEnabled(warmSettingsOn(value.pt_settings));
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.pt_settings) return;
    setEnabled(warmSettingsOn(changes.pt_settings.newValue));
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

  document.addEventListener('click', (event) => {
    if (!enabled || event.defaultPrevented) return;
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const anchor = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (!anchor) return;
    const X = window.PTXLinks;
    const target = X ? X.classify(anchor.href, window.location.href) : null;
    if (!target) return;
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

  document.addEventListener('mouseover', (event) => {
    if (!enabled) return;
    const anchor = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (!anchor) return;
    const X = window.PTXLinks;
    const target = X ? X.classify(anchor.href, window.location.href) : null;
    if (!target || target.url === hintUrl) return; // dwell already running/sent
    clearTimeout(hintTimer);
    hintUrl = target.url;
    hintTimer = setTimeout(() => {
      const now = Date.now();
      if (lastHint.url === target.url && now - lastHint.t < HINT_REPEAT_MS) return;
      lastHint = { url: target.url, t: now };
      if (contextAlive()) {
        try { chrome.runtime.sendMessage({ type: 'pt_warm_hint', url: target.url }).catch(() => {}); } catch (_) {}
      }
    }, HINT_DWELL_MS);
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
