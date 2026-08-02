/* PaperTrench showcase site — animations and canvas demos */
(() => {
  'use strict';

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- scroll reveal ---------- */
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }
  }, { threshold: 0.12 });
  document.querySelectorAll('.reveal').forEach(el => io.observe(el));

  /* ---------- marquee: duplicate chips for seamless loop ---------- */
  const track = document.getElementById('marqueeTrack');
  if (track) track.innerHTML += track.innerHTML;

  /* ---------- shared canvas helpers ---------- */
  // Canvas size/context is cached; re-measured only after a resize.
  const canvasState = new WeakMap();
  const allCanvases = [];
  function fitCanvas(canvas) {
    let st = canvasState.get(canvas);
    if (!st || st.dirty) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const r = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      st = { ctx, w: r.width, h: r.height, dirty: false };
      canvasState.set(canvas, st);
    }
    return st;
  }
  window.addEventListener('resize', () => {
    for (const c of allCanvases) {
      const st = canvasState.get(c);
      if (st) st.dirty = true;
      const rl = loops.get(c);
      if (rl && rl.drawOnce) rl.drawOnce();
    }
  });

  // Animation loops run only while the canvas is on screen; with reduced
  // motion a single static frame is drawn instead of looping.
  const loops = new Map();
  function runLoop(canvas, frame) {
    allCanvases.push(canvas);
    const drawOnce = () => frame(performance.now());
    loops.set(canvas, { drawOnce });
    if (reduced) {
      const vio = new IntersectionObserver((es) => {
        if (es[es.length - 1].isIntersecting) { drawOnce(); vio.disconnect(); }
      }, { threshold: 0.05 });
      vio.observe(canvas);
      return;
    }
    let visible = false, rafId = 0;
    const tick = (ts) => {
      frame(ts);
      rafId = visible ? requestAnimationFrame(tick) : 0;
    };
    new IntersectionObserver((es) => {
      visible = es[es.length - 1].isIntersecting;
      if (visible && !rafId) rafId = requestAnimationFrame(tick);
    }, { threshold: 0.05 }).observe(canvas);
  }

  function drawGrid(ctx, w, h) {
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    for (let y = h / 5; y < h; y += h / 5) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
    for (let x = w / 8; x < w; x += w / 8) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
  }

  function bubble(ctx, x, y, side, r = 9) {
    ctx.save();
    ctx.shadowColor = side === 'b' ? 'rgba(34,181,115,0.8)' : 'rgba(224,67,58,0.8)';
    ctx.shadowBlur = 12;
    ctx.fillStyle = side === 'b' ? '#22B573' : '#E0433A';
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = '#0B0E14'; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = side === 'b' ? '#032B1B' : '#FFFFFF';
    ctx.font = `800 ${Math.round(r)}px "JetBrains Mono", monospace`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(side === 'b' ? 'B' : 'S', x, y + 0.5);
    ctx.restore();
  }

  /* =========================================================
     CANDLE CHARTS — live ticking candles with paper-fill bubbles
     (used by the hero and the terminal scene)
     ========================================================= */
  function candleChart(canvas, opts) {
    const N = 90;
    let candles = [];
    let price = 100;
    // seed a plausible pumpy series
    for (let i = 0; i < N; i++) {
      const drift = Math.sin(i / 11) * 1.6 + (i > 48 ? 1.1 : 0.15);
      const o = price;
      price = Math.max(30, price + drift + (Math.random() - 0.48) * 4);
      candles.push({ o, c: price, h: Math.max(o, price) + Math.random() * 2.2, l: Math.min(o, price) - Math.random() * 2.2 });
    }
    // fixed fills at candle indices
    const fills = [ { i: 22, side: 'b' }, { i: 38, side: 'b' }, { i: 58, side: 's' }, { i: 76, side: 's' } ];

    let tick = 0;

    function step() {
      tick++;
      const last = candles[candles.length - 1];
      const drift = Math.sin(tick / 14) * 1.4 + 0.2;
      last.c = Math.max(30, last.c + drift * 0.3 + (Math.random() - 0.48) * 1.8);
      last.h = Math.max(last.h, last.c);
      last.l = Math.min(last.l, last.c);
      if (tick % 24 === 0) {
        candles.push({ o: last.c, c: last.c, h: last.c, l: last.c });
        candles.shift();
        for (const f of fills) f.i--;
        if (fills[0].i < 2) { fills.shift(); fills.push({ i: N - 4, side: Math.random() > 0.5 ? 'b' : 's' }); }
      }
      if (opts && opts.onTick && tick % 6 === 0) opts.onTick(last.c);
    }

    function draw() {
      const { ctx, w, h } = fitCanvas(canvas);
      ctx.clearRect(0, 0, w, h);
      drawGrid(ctx, w, h);
      let mn = Infinity, mx = -Infinity;
      for (const c of candles) { mn = Math.min(mn, c.l); mx = Math.max(mx, c.h); }
      const pad = (mx - mn) * 0.12;
      mn -= pad; mx += pad;
      const y = v => h - ((v - mn) / (mx - mn)) * h;
      const cw = w / N;

      // area under close line
      ctx.beginPath();
      ctx.moveTo(0, y(candles[0].c));
      candles.forEach((c, i) => ctx.lineTo(i * cw + cw / 2, y(c.c)));
      ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, 'rgba(52,211,153,0.14)');
      grad.addColorStop(1, 'rgba(52,211,153,0)');
      ctx.fillStyle = grad; ctx.fill();

      // candles
      candles.forEach((c, i) => {
        const x = i * cw + cw / 2;
        const up = c.c >= c.o;
        ctx.strokeStyle = up ? 'rgba(52,211,153,0.85)' : 'rgba(224,67,58,0.85)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, y(c.h)); ctx.lineTo(x, y(c.l)); ctx.stroke();
        ctx.fillStyle = up ? '#2AAE7E' : '#C4423B';
        const bh = Math.max(1.5, Math.abs(y(c.o) - y(c.c)));
        ctx.fillRect(x - cw * 0.32, Math.min(y(c.o), y(c.c)), cw * 0.64, bh);
      });

      // fill bubbles at candle close
      for (const f of fills) {
        if (f.i < 0 || f.i >= N) continue;
        bubble(ctx, f.i * cw + cw / 2, y(candles[f.i].c), f.side, 9);
      }

      // live price line + dot
      const lc = candles[candles.length - 1];
      ctx.setLineDash([4, 5]);
      ctx.strokeStyle = 'rgba(255,157,69,0.55)';
      ctx.beginPath(); ctx.moveTo(0, y(lc.c)); ctx.lineTo(w, y(lc.c)); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#FF9D45';
      ctx.beginPath(); ctx.arc(w - cw / 2, y(lc.c), 4, 0, Math.PI * 2); ctx.fill();
    }

    runLoop(canvas, () => {
      if (!reduced) step();
      draw();
    });
  }

  const heroCanvas = document.getElementById('heroChart');
  if (heroCanvas) {
    const tickerEl = document.getElementById('tickerPrice');
    const priceEl = document.getElementById('ptPrice');
    const balEl = document.getElementById('ppBal');
    const pnlEl = document.getElementById('ppPnl');
    candleChart(heroCanvas, {
      onTick(c) {
        const px = (c * 3.4e-7).toFixed(8);
        if (tickerEl) tickerEl.textContent = px;
        if (priceEl) priceEl.textContent = px;
        const pnl = (c - 100) / 100;
        if (balEl) balEl.textContent = (10 + pnl * 10).toFixed(2);
        if (pnlEl) {
          const up = pnl >= 0;
          pnlEl.style.color = up ? 'var(--green)' : '#ff8a80';
          pnlEl.textContent = `${up ? '+' : ''}${(pnl * 10).toFixed(2)} SOL today (${up ? '+' : ''}${(pnl * 100).toFixed(1)}%)`;
        }
      }
    });
  }

  const sceneCanvas = document.getElementById('sceneChart');
  if (sceneCanvas) candleChart(sceneCanvas);

  /* =========================================================
     BUBBLES SECTION — line chart with animated pop-in bubbles
     ========================================================= */
  const bubCanvas = document.getElementById('bubbleChart');
  if (bubCanvas) {
    const pts = [];
    const M = 70;
    let v = 60;
    for (let i = 0; i < M; i++) {
      v = Math.max(20, v + Math.sin(i / 8) * 3 + (i > 30 && i < 52 ? 2.4 : 0) + (Math.random() - 0.5) * 5);
      pts.push(v);
    }
    const marks = [ { i: 12, side: 'b' }, { i: 26, side: 'b' }, { i: 44, side: 's' }, { i: 61, side: 's' } ];
    let t0 = null;

    function drawBub(ts) {
      if (!t0) t0 = ts;
      const el = (ts - t0) / 1000;
      const { ctx, w, h } = fitCanvas(bubCanvas);
      ctx.clearRect(0, 0, w, h);
      drawGrid(ctx, w, h);
      const mn = Math.min(...pts) - 8, mx = Math.max(...pts) + 8;
      const y = val => h - ((val - mn) / (mx - mn)) * h;
      const x = i => (i / (M - 1)) * w;

      // reveal the line progressively
      const reveal = reduced ? 1 : Math.min(1, el / 2.2);
      const upto = Math.max(2, Math.floor(M * reveal));

      ctx.beginPath();
      ctx.moveTo(x(0), y(pts[0]));
      for (let i = 1; i < upto; i++) ctx.lineTo(x(i), y(pts[i]));
      ctx.strokeStyle = '#34D399'; ctx.lineWidth = 2.5;
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.shadowColor = 'rgba(52,211,153,0.5)'; ctx.shadowBlur = 10;
      ctx.stroke();
      ctx.shadowBlur = 0;

      // avg fill line between the two buys
      if (reveal > marks[1].i / M) {
        const avg = (pts[marks[0].i] + pts[marks[1].i]) / 2;
        ctx.setLineDash([5, 6]);
        ctx.strokeStyle = 'rgba(255,157,69,0.7)'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(x(marks[0].i), y(avg)); ctx.lineTo(w, y(avg)); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(255,157,69,0.9)';
        ctx.font = '700 10px "JetBrains Mono", monospace';
        ctx.fillText('avg fill', x(marks[0].i) + 6, y(avg) - 6);
      }

      // pop-in bubbles with tooltip on the last one
      marks.forEach((m, k) => {
        const appear = (m.i / M) * 2.2 + 0.15;
        if (!reduced && el < appear) return;
        const pop = reduced ? 1 : Math.min(1, (el - appear) / 0.35);
        const ease = 1 - Math.pow(1 - pop, 3);
        const r = 10 * (0.4 + 0.6 * ease);
        bubble(ctx, x(m.i), y(pts[m.i]), m.side, r);
        // pulse ring
        if (!reduced) {
          const ring = ((el - appear) % 2.4) / 2.4;
          ctx.strokeStyle = m.side === 'b' ? `rgba(34,181,115,${0.5 * (1 - ring)})` : `rgba(224,67,58,${0.5 * (1 - ring)})`;
          ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.arc(x(m.i), y(pts[m.i]), 10 + ring * 16, 0, Math.PI * 2); ctx.stroke();
        }
        // tooltip on 3rd marker
        if (k === 2 && (reduced || el > appear + 0.5)) {
          const tx = x(m.i), ty = y(pts[m.i]) - 46;
          ctx.fillStyle = 'rgba(11,14,20,0.95)';
          ctx.strokeStyle = 'rgba(224,67,58,0.5)';
          const bw = 128, bh = 32;
          ctx.beginPath();
          ctx.roundRect(tx - bw / 2, ty - bh / 2, bw, bh, 8);
          ctx.fill(); ctx.stroke();
          ctx.fillStyle = '#EAEFF7';
          ctx.font = '700 10.5px "JetBrains Mono", monospace';
          ctx.textAlign = 'center';
          ctx.fillText('SELL 1.0 ◎ @ 0.0000402', tx, ty + 3.5);
          ctx.textAlign = 'left';
        }
      });
    }

    runLoop(bubCanvas, drawBub);
  }

  /* =========================================================
     RECORDER MOCK — mini replay chart + scrubbing timeline
     ========================================================= */
  const recCanvas = document.getElementById('recChart');
  if (recCanvas) {
    const R = 60;
    const rp = [];
    let rv = 50;
    for (let i = 0; i < R; i++) {
      rv = Math.max(15, rv + Math.sin(i / 6) * 2.5 + (i > 18 && i < 38 ? 2.2 : -0.4) + (Math.random() - 0.5) * 4);
      rp.push(rv);
    }
    const recFills = [ { i: 8, side: 'b' }, { i: 19, side: 'b' }, { i: 32, side: 's' }, { i: 47, side: 's' } ];
    const fillEl = document.getElementById('recFill');
    const scrubEl = document.getElementById('recScrub');
    const timeEl = document.getElementById('recTime');
    let rt = 0;

    function drawRec() {
      rt += reduced ? 0 : 0.0022;
      const prog = reduced ? 0.62 : (0.5 + 0.5 * Math.sin(rt * Math.PI * 2 - Math.PI / 2)) * 0.9 + 0.05;
      const { ctx, w, h } = fitCanvas(recCanvas);
      ctx.clearRect(0, 0, w, h);
      drawGrid(ctx, w, h);
      const mn = Math.min(...rp) - 6, mx = Math.max(...rp) + 6;
      const y = val => h - ((val - mn) / (mx - mn)) * h;
      const x = i => (i / (R - 1)) * w;
      const upto = Math.max(2, Math.floor(R * prog));

      // played portion bright, rest dim
      ctx.beginPath(); ctx.moveTo(x(0), y(rp[0]));
      for (let i = 1; i < R; i++) ctx.lineTo(x(i), y(rp[i]));
      ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 2; ctx.stroke();

      ctx.beginPath(); ctx.moveTo(x(0), y(rp[0]));
      for (let i = 1; i < upto; i++) ctx.lineTo(x(i), y(rp[i]));
      ctx.strokeStyle = '#FF9D45'; ctx.lineWidth = 2.5;
      ctx.shadowColor = 'rgba(255,157,69,0.5)'; ctx.shadowBlur = 8;
      ctx.stroke(); ctx.shadowBlur = 0;

      // playhead
      const px = x(upto - 1);
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.setLineDash([3, 4]);
      ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke();
      ctx.setLineDash([]);

      for (const f of recFills) {
        if (f.i <= upto) bubble(ctx, x(f.i), y(rp[f.i]), f.side, 7);
      }

      if (fillEl) fillEl.style.width = (prog * 100).toFixed(1) + '%';
      if (scrubEl) scrubEl.style.left = (prog * 100).toFixed(1) + '%';
      if (timeEl) {
        const total = 252; // 4:12
        const s = Math.floor(total * prog);
        timeEl.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')} / 04:12`;
      }
    }
    runLoop(recCanvas, drawRec);
  }

  /* =========================================================
     LEADERBOARD — rolling hash chain ticker
     ========================================================= */
  const chainEl = document.getElementById('chainTicker');
  if (chainEl && !reduced) {
    const hex = () => Array.from({ length: 4 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
    const link = () => `${hex()}…${hex()}`;
    let chain = [link(), link(), link()];
    setInterval(() => {
      chain.push(link());
      if (chain.length > 4) chain.shift();
      chainEl.innerHTML = 'hash: ' + chain.map(h => `<span class="h">${h}</span>`).join(' <span class="arrow">→</span> ') + ' <span class="arrow">→</span> <span class="h">verifying…</span>';
    }, 1600);
  }
})();
