/* PaperTrench — shareable P&L card.
 *
 * Renders a closed (or open) position as a single image the trader can post.
 * The layout is deliberately close to the flex cards traders already know from
 * Padre and friends: big multiple, big percent, entry/exit rail, and room for a
 * custom background picture or GIF behind it all.
 *
 * Two responsibilities are kept apart so the interesting part is testable
 * without a canvas:
 *   - cardModel()  — pure: turns a round/position into the exact strings and
 *                    colors the card shows. No DOM, no canvas.
 *   - drawCard()   — paints that model onto a canvas (browser only).
 *
 * The card always carries the PAPER watermark and a small PaperTrench mark, so
 * a screenshot of a paper trade can never be passed off as a real one.
 */
(() => {
  'use strict';

  const WIDTH = 1200;
  const HEIGHT = 675;           // 16:9 — posts cleanly on X without cropping
  const WATERMARK_TEXT = 'PAPER';
  const BRAND_TEXT = 'PaperTrench';

  const COLORS = {
    bg: '#0A0D13',
    panel: 'rgba(11, 14, 20, 0.72)',
    text: '#EAEFF7',
    dim: '#8D97A9',
    faint: '#5A6273',
    amber: '#FF9D45',
    green: '#34D399',
    red: '#FF5F56',
    line: 'rgba(255, 255, 255, 0.10)',
  };

  function num(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  /** Compact price formatting that stays readable across 1e-9 … 1e3. */
  function formatPrice(value) {
    const price = num(value);
    if (!(price > 0)) return '—';
    if (price < 0.0001) return price.toExponential(3);
    return String(Number(price.toPrecision(6)));
  }

  function formatSol(value, dp = 3) {
    const parsed = num(value);
    if (parsed === null) return '—';
    return parsed.toLocaleString(undefined, {
      minimumFractionDigits: dp,
      maximumFractionDigits: dp,
    });
  }

  function formatHeld(ms) {
    const total = Math.max(0, Math.floor((num(ms) || 0) / 1000));
    if (total < 60) return `${total}s`;
    if (total < 3600) return `${Math.floor(total / 60)}m ${total % 60}s`;
    return `${Math.floor(total / 3600)}h ${Math.floor((total % 3600) / 60)}m`;
  }

  function shortMint(mint) {
    const text = typeof mint === 'string' ? mint : '';
    return text.length > 10 ? `${text.slice(0, 4)}…${text.slice(-4)}` : text;
  }

  /**
   * Turn a round trip (or an open position) into everything the card renders.
   *
   * Pure and canvas-free, so the numbers on a shared card can be asserted
   * directly. Returns null when there is nothing meaningful to show, rather
   * than rendering a card full of dashes.
   */
  function cardModel(source, opts) {
    if (!source || typeof source !== 'object') return null;
    const options = opts || {};

    const invested = num(source.investedSol);
    const returned = num(source.returnedSol);
    const open = !(num(source.closedAt) > 0);

    // An open position has no `returnedSol`; its live value stands in.
    const pnlSol = num(source.pnlSol);
    const basis = invested !== null && invested > 0 ? invested : null;
    if (pnlSol === null || basis === null) return null;

    const pnlPct = num(source.pnlPct) !== null ? num(source.pnlPct) : (pnlSol / basis) * 100;
    const win = pnlSol >= 0;
    // Traders read multiples, not percentages, on a flex card.
    const multiple = (basis + pnlSol) / basis;

    return {
      symbol: String(source.symbol || shortMint(source.mint) || '—'),
      mint: String(source.mint || ''),
      mintShort: shortMint(source.mint),
      site: String(source.site || ''),
      open,
      win,
      // Display strings — exactly what gets painted.
      multipleText: `${multiple.toFixed(multiple >= 10 ? 1 : 2)}x`,
      pnlPctText: `${win ? '+' : ''}${pnlPct.toFixed(1)}%`,
      pnlSolText: `${win ? '+' : ''}${formatSol(pnlSol)} SOL`,
      investedText: `${formatSol(invested)} SOL`,
      returnedText: returned === null ? '—' : `${formatSol(returned)} SOL`,
      entryText: formatPrice(source.entryPrice ?? source.avgEntry),
      exitText: formatPrice(source.exitPrice ?? source.lastPriceNative),
      heldText: formatHeld(source.heldMs),
      accent: win ? COLORS.green : COLORS.red,
      statusText: open ? 'OPEN POSITION' : 'CLOSED',
      // Never optional: a shared paper trade must be labelled as one.
      watermark: WATERMARK_TEXT,
      brand: BRAND_TEXT,
      handle: options.handle ? `@${String(options.handle).replace(/^@+/, '')}` : '',
      background: options.background || null,
    };
  }

  /** Cover-fit a source image into the card, preserving aspect ratio. */
  function coverRect(sourceWidth, sourceHeight, boxWidth, boxHeight) {
    const sw = num(sourceWidth) || 1;
    const sh = num(sourceHeight) || 1;
    const scale = Math.max(boxWidth / sw, boxHeight / sh);
    const width = sw * scale;
    const height = sh * scale;
    return {
      x: (boxWidth - width) / 2,
      y: (boxHeight - height) / 2,
      width,
      height,
    };
  }

  /**
   * Paint the card.
   *
   * `media` is an optional already-loaded HTMLImageElement / HTMLVideoElement /
   * ImageBitmap used as the background. A GIF passed as an <img> paints its
   * currently-displayed frame, which is what makes "use a GIF" work for a
   * still export; the animated export path re-draws per frame.
   */
  function drawCard(ctx, model, media) {
    if (!ctx || !model) return false;

    ctx.save();
    ctx.clearRect(0, 0, WIDTH, HEIGHT);

    // 1. Ground.
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    // 2. Custom background, cover-fit and darkened so text stays legible.
    if (media) {
      const sw = media.naturalWidth || media.videoWidth || media.width;
      const sh = media.naturalHeight || media.videoHeight || media.height;
      const box = coverRect(sw, sh, WIDTH, HEIGHT);
      try {
        ctx.drawImage(media, box.x, box.y, box.width, box.height);
      } catch (_) { /* tainted or not ready: fall through to the plain ground */ }

      // Scrim: without it a bright picture makes every number unreadable.
      const scrim = ctx.createLinearGradient(0, 0, 0, HEIGHT);
      scrim.addColorStop(0, 'rgba(10, 13, 19, 0.72)');
      scrim.addColorStop(0.55, 'rgba(10, 13, 19, 0.82)');
      scrim.addColorStop(1, 'rgba(10, 13, 19, 0.94)');
      ctx.fillStyle = scrim;
      ctx.fillRect(0, 0, WIDTH, HEIGHT);
    }

    // 3. PAPER watermark — huge, rotated, low-alpha, behind the numbers.
    ctx.save();
    ctx.translate(WIDTH / 2, HEIGHT / 2);
    ctx.rotate(-20 * Math.PI / 180);
    ctx.font = '900 210px Inter, ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255, 157, 69, 0.16)';
    ctx.fillStyle = 'rgba(255, 157, 69, 0.06)';
    ctx.fillText(model.watermark, 0, 0);
    ctx.strokeText(model.watermark, 0, 0);
    ctx.restore();

    // 4. Accent rail down the left edge.
    ctx.fillStyle = model.accent;
    ctx.fillRect(0, 0, 8, HEIGHT);

    // 5. Header: token + status.
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = COLORS.text;
    ctx.font = '800 46px Inter, ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(model.symbol, 64, 96);

    ctx.fillStyle = COLORS.faint;
    ctx.font = '500 20px ui-monospace, "JetBrains Mono", Menlo, monospace';
    ctx.fillText(model.mintShort, 64, 128);

    ctx.fillStyle = model.accent;
    ctx.font = '800 16px ui-monospace, "JetBrains Mono", Menlo, monospace';
    ctx.textAlign = 'right';
    ctx.fillText(model.statusText, WIDTH - 64, 96);

    // 6. The hero: multiple, then percent and SOL on their own rail beneath.
    // Measuring and flowing rather than fixed offsets keeps a wide multiple
    // (e.g. "128.4x") from colliding with the figures next to it.
    ctx.textAlign = 'left';
    ctx.fillStyle = model.accent;
    ctx.font = '900 168px Inter, ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(model.multipleText, 60, 310);

    ctx.font = '800 58px Inter, ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(model.pnlPctText, 64, 384);

    const pctWidth = ctx.measureText(model.pnlPctText).width;
    ctx.fillStyle = COLORS.text;
    ctx.font = '700 32px ui-monospace, "JetBrains Mono", Menlo, monospace';
    ctx.fillText(model.pnlSolText, 64 + pctWidth + 26, 384);

    // 7. Stat rail.
    const rail = [
      ['IN', model.investedText],
      ['OUT', model.returnedText],
      ['ENTRY', model.entryText],
      ['EXIT', model.exitText],
      ['HELD', model.heldText],
    ];
    const railY = 512;
    const railLeft = 64;
    const railRight = WIDTH - 64;
    const columnWidth = (railRight - railLeft) / rail.length;

    ctx.strokeStyle = COLORS.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(64, railY - 44);
    ctx.lineTo(WIDTH - 64, railY - 44);
    ctx.stroke();

    rail.forEach(([label, value], index) => {
      const x = railLeft + columnWidth * index;
      ctx.fillStyle = COLORS.faint;
      ctx.font = '700 15px ui-monospace, "JetBrains Mono", Menlo, monospace';
      ctx.fillText(label, x, railY - 10);
      ctx.fillStyle = COLORS.text;
      ctx.font = '700 24px ui-monospace, "JetBrains Mono", Menlo, monospace';
      ctx.fillText(value, x, railY + 24);
    });

    // 8. Footer: the small, clean PaperTrench mark.
    const markY = HEIGHT - 44;
    ctx.fillStyle = COLORS.amber;
    roundRect(ctx, 64, markY - 22, 26, 26, 7);
    ctx.fill();
    ctx.fillStyle = '#2A1400';
    ctx.font = '900 16px Inter, ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('P', 77, markY - 3);

    ctx.textAlign = 'left';
    ctx.fillStyle = COLORS.dim;
    ctx.font = '700 17px Inter, ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(model.brand, 100, markY - 3);

    ctx.fillStyle = COLORS.faint;
    ctx.font = '500 14px ui-monospace, "JetBrains Mono", Menlo, monospace';
    ctx.fillText('paper trading · not financial advice', 100, markY + 16);

    if (model.handle) {
      ctx.textAlign = 'right';
      ctx.fillStyle = COLORS.dim;
      ctx.font = '700 17px Inter, ui-sans-serif, system-ui, sans-serif';
      ctx.fillText(model.handle, WIDTH - 64, markY - 3);
    }

    ctx.restore();
    return true;
  }

  function roundRect(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
  }

  const api = {
    WIDTH, HEIGHT, COLORS, WATERMARK_TEXT, BRAND_TEXT,
    cardModel, drawCard, coverRect,
    formatPrice, formatSol, formatHeld, shortMint,
  };

  if (typeof window !== 'undefined') window.PTPnlCard = api;
  if (typeof self !== 'undefined') self.PTPnlCard = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
