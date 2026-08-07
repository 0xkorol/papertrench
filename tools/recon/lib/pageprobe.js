'use strict';
// The in-page observer. Injected into every document (main world) via
// Page.addScriptToEvaluateOnNewDocument; talks back over the __ptrecon CDP
// binding. It records the timelines CDP cannot see from outside: price-shaped
// text nodes with their DOM paths (the provenance substrate), SPA route
// changes, tab-title ticks, mutation pressure, chart-global presence, and
// click paths. It never records typed key identities (Enter aside).

function probe() {
  if (window.__ptreconProbe) return;
  window.__ptreconProbe = 1;

  var send = function (o) {
    try {
      if (window.__ptrecon) window.__ptrecon(JSON.stringify(o));
    } catch (e) { /* binding not ready yet */ }
  };

  var esc = function (s) {
    try { return CSS.escape(s); } catch (e) { return s.replace(/[^a-zA-Z0-9_-]/g, '\\$&'); }
  };

  var stableClass = function (c) {
    // Hashed/module classes (css-1x2y3z, sc-bdVaJa, _1a2b) make useless anchors.
    return /^[A-Za-z][A-Za-z0-9_-]{2,23}$/.test(c) && !/\d{2,}/.test(c) && !/^(css|sc|jsx|_)/.test(c);
  };

  var cssPath = function (el) {
    var parts = [];
    var node = el;
    for (var depth = 0; node && node.nodeType === 1 && depth < 8; depth++) {
      var tag = node.tagName.toLowerCase();
      if (node.id) { parts.unshift('#' + esc(node.id)); break; }
      var picked = null;
      for (var i = 0; i < node.attributes.length; i++) {
        var a = node.attributes[i];
        if (a.name.indexOf('data-') === 0 && a.value && a.value.length <= 24 && a.name.length <= 32) {
          picked = tag + '[' + a.name + '="' + a.value.replace(/"/g, '') + '"]';
          break;
        }
      }
      if (!picked) {
        var cls = null;
        var list = node.classList;
        for (var j = 0; j < list.length; j++) {
          if (stableClass(list[j])) { cls = list[j]; break; }
        }
        if (cls) {
          picked = tag + '.' + esc(cls);
        } else {
          // Bound the sibling walk: on a huge list (thousands of rows) an
          // unbounded scan makes each cssPath O(siblings), and the 1s price
          // scan runs it for up to 300 nodes — enough to freeze a hostile page.
          var idx = 1;
          var sib = node;
          var seen = 0;
          while ((sib = sib.previousElementSibling) && seen < 500) {
            seen++;
            if (sib.tagName === node.tagName) idx++;
          }
          picked = tag + ':nth-of-type(' + (sib ? 'n' : idx) + ')';
        }
      }
      parts.unshift(picked);
      node = node.parentElement;
    }
    var path = parts.join('>');
    return path.length > 120 ? '…' + path.slice(-120) : path;
  };

  // --- SPA routes ------------------------------------------------------------
  var emitNav = function () {
    send({ k: 'nav', t: Date.now(), href: location.href, title: document.title });
  };
  ['pushState', 'replaceState'].forEach(function (fn) {
    var orig = history[fn];
    if (typeof orig !== 'function') return;
    history[fn] = function () {
      var r = orig.apply(this, arguments);
      try { emitNav(); } catch (e) { /* recorder only */ }
      return r;
    };
  });
  addEventListener('popstate', emitNav);
  addEventListener('hashchange', emitNav);

  // --- Tab title timeline (terminals tick the price into the title) ----------
  var lastTitle = null;
  setInterval(function () {
    if (document.title !== lastTitle) {
      lastTitle = document.title;
      send({ k: 'title', t: Date.now(), title: lastTitle, href: location.href });
    }
  }, 400);

  // --- Price-shaped text nodes: the provenance substrate ---------------------
  var PRICE_RE = /^[-+]?[$€]?\s?\d[\d,]*(\.\d+)?\s?([KMB%xk]|USD|USDC|SOL|ETH|BNB)?$/;
  var looksPrice = function (s) {
    return s.length > 0 && s.length <= 24 && /\d/.test(s) && PRICE_RE.test(s);
  };
  var lastHash = 0;
  var sameStreak = 0;
  var hash = function (s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return h;
  };
  setInterval(function () {
    if (!document.body) return;
    var out = [];
    var visited = 0;
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    var tn;
    while ((tn = walker.nextNode())) {
      if (++visited > 30000 || out.length >= 300) break;
      var raw = tn.textContent || '';
      // Length-gate BEFORE trim: a giant text node (a hostile page can inline
      // megabytes) would otherwise be copied and scanned every tick even though
      // looksPrice rejects anything over 24 chars.
      if (raw.length > 64) continue;
      var txt = raw.trim();
      if (!looksPrice(txt)) continue;
      var parent = tn.parentElement;
      if (!parent) continue;
      out.push([cssPath(parent), txt]);
    }
    var joined = '';
    for (var i2 = 0; i2 < out.length; i2++) joined += out[i2][0] + '\x1f' + out[i2][1] + '\x1e';
    var h2 = hash(joined);
    if (h2 === lastHash) {
      sameStreak++;
      if (sameStreak % 5 === 0) send({ k: 'sig', t: Date.now(), same: 1, n: out.length });
      return;
    }
    lastHash = h2;
    sameStreak = 0;
    send({ k: 'sig', t: Date.now(), href: location.href, prices: out });
  }, 1000);

  // --- Mutation pressure -----------------------------------------------------
  var mut = { a: 0, r: 0, txt: 0, attr: 0 };
  var mutPaths = [];
  try {
    new MutationObserver(function (list) {
      for (var i = 0; i < list.length; i++) {
        var m = list[i];
        if (m.type === 'childList') {
          mut.a += m.addedNodes.length;
          mut.r += m.removedNodes.length;
          if (mutPaths.length < 5 && m.target && m.target.nodeType === 1) mutPaths.push(cssPath(m.target));
        } else if (m.type === 'characterData') {
          mut.txt++;
        } else {
          mut.attr++;
        }
      }
    }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
  } catch (e) { /* document not observable yet */ }
  setInterval(function () {
    if (mut.a || mut.r || mut.txt || mut.attr) {
      send({ k: 'mut', t: Date.now(), a: mut.a, r: mut.r, txt: mut.txt, attr: mut.attr, paths: mutPaths });
      mut = { a: 0, r: 0, txt: 0, attr: 0 };
      mutPaths = [];
    }
  }, 1000);

  // --- Chart-global presence (presence-only: F-39 says this is NOT capability)
  var lastCaps = '';
  setInterval(function () {
    var found = [];
    try {
      if (window.TradingView) found.push('window.TradingView');
      if (window.tvWidget) found.push('window.tvWidget');
      var frames = document.querySelectorAll('iframe');
      for (var i = 0; i < frames.length && found.length < 8; i++) {
        var src = frames[i].getAttribute('src') || '';
        if (/tradingview|chart|kline/i.test(src)) found.push('iframe:' + src.slice(0, 80));
      }
    } catch (e) { /* cross-origin walls are fine */ }
    var s = found.join('|');
    if (s !== lastCaps) {
      lastCaps = s;
      send({ k: 'cap', t: Date.now(), found: found });
    }
  }, 5000);

  // --- Interactions (paths only; never key identities beyond Enter) ----------
  addEventListener('click', function (ev) {
    try {
      var el = ev.target && ev.target.nodeType === 1 ? ev.target : null;
      send({
        k: 'act', t: Date.now(), type: 'click',
        path: el ? cssPath(el) : '',
        // Slice BEFORE trim so clicking a large container does not materialize
        // and trim its whole subtree text; cap output at 40 chars.
        text: el ? (el.textContent || '').slice(0, 120).trim().slice(0, 40) : '',
      });
    } catch (e) { /* recorder only */ }
  }, { capture: true, passive: true });
  addEventListener('keydown', function (ev) {
    try {
      send({ k: 'act', t: Date.now(), type: 'key', enter: ev.key === 'Enter' ? 1 : 0 });
    } catch (e) { /* recorder only */ }
  }, { capture: true, passive: true });

  emitNav();
}

const PROBE_SOURCE = '(' + probe.toString() + ')();';

module.exports = { PROBE_SOURCE };
