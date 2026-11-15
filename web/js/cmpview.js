/* SpaceCam · отрисовка экрана сравнения: кадр с масштабом и сдвигом, наложения
 * (сетка RA/Dec, сетка pxелей, кандидаты, известные тела, след объекта, стрелка движения),
 * а также графики: кривая блеска и спектр. */
(function () {
  const SW = (window.SW = window.SW || {});
  const D = Math.PI / 180;
  const NICE_AM = [0.25, 0.5, 1, 2, 3, 5, 10, 15, 30, 60, 120];

  /** небо → pxель сетки (касательная проекция, север вверх, восток влево) */
  function skyToPix(ra, dec, ra0, de0, n, scale) {
    const a = ra * D, d = dec * D, a0 = ra0 * D, d0 = de0 * D, s = (scale / 3600) * D, c = (n - 1) / 2;
    const cosc = Math.sin(d) * Math.sin(d0) + Math.cos(d) * Math.cos(d0) * Math.cos(a - a0);
    if (cosc <= 0) return null;
    const xi = (Math.cos(d) * Math.sin(a - a0)) / cosc, eta = (Math.sin(d) * Math.cos(d0) - Math.cos(d) * Math.sin(d0) * Math.cos(a - a0)) / cosc;
    return [c - xi / s, c - eta / s];
  }

  /** видимое окно в долях кадра */
  function win(v) { const w = 1 / v.z; return { x0: v.cx - w / 2, y0: v.cy - w / 2, w }; }
  function toScreen(v, W, px, py, n) { const o = win(v); return [(((px + 0.5) / n - o.x0) / o.w) * W, (((py + 0.5) / n - o.y0) / o.w) * W]; }
  function toPix(v, W, X, Y, n) { const o = win(v); return [(o.x0 + (X / W) * o.w) * n - 0.5, (o.y0 + (Y / W) * o.w) * n - 0.5]; }
  function blit(ctx, v, src, W, H) {
    const o = win(v), sw = src.width, sh = src.height;
    ctx.drawImage(src, o.x0 * sw, o.y0 * sh, o.w * sw, o.w * sh, 0, 0, W, H);
  }

  function grid(ctx, v, W, t, size) {
    const n = 512, scale = (size * 3600) / n; // вспомогательная сетка для пересчёта
    const fovAm = (size * 60) / v.z;
    const step = NICE_AM.find((s) => fovAm / s <= 6) || 120;
    const cd = Math.max(0.05, Math.cos(t.dec * D));
    ctx.strokeStyle = 'rgba(160,200,255,.32)'; ctx.lineWidth = 1; ctx.fillStyle = 'rgba(190,215,255,.8)';
    ctx.font = '500 12px "IBM Plex Mono", ui-monospace, monospace';
    const span = size * 0.8;
    const lineSky = (pts) => { ctx.beginPath(); let started = false; pts.forEach(([ra, de]) => { const p = skyToPix(ra, de, t.ra, t.dec, n, scale); if (!p) return; const s = toScreen(v, W, p[0], p[1], n); if (!started) { ctx.moveTo(s[0], s[1]); started = true; } else ctx.lineTo(s[0], s[1]); }); ctx.stroke(); };
    const st = step / 60;
    for (let de = Math.ceil((t.dec - span) / st) * st; de <= t.dec + span; de += st) {
      lineSky(Array.from({ length: 21 }, (_, i) => [t.ra - span / cd + (i * 2 * span) / cd / 20, de]));
      const p = skyToPix(t.ra + (span / cd) * 0.98, de, t.ra, t.dec, n, scale); if (p) { const s = toScreen(v, W, p[0], p[1], n); if (s[1] > 14 && s[1] < W - 14) ctx.fillText(SW.astro.fmtDec(de).replace(/″$/, '″'), 6, s[1] - 4); }
    }
    const sr = st / cd;
    const raStep = NICE_AM.find((s) => s / 60 >= sr * 0.9) / 60 || sr;
    for (let ra = Math.ceil((t.ra - span / cd) / raStep) * raStep; ra <= t.ra + span / cd; ra += raStep) {
      lineSky(Array.from({ length: 21 }, (_, i) => [ra, t.dec - span + (i * 2 * span) / 20]));
      const p = skyToPix(ra, t.dec - span * 0.98, t.ra, t.dec, n, scale); if (p) { const s = toScreen(v, W, p[0], p[1], n); if (s[0] > 20 && s[0] < W - 90) ctx.fillText(SW.astro.fmtRA(((ra % 360) + 360) % 360).replace(/\.\dˢ$/, 'ˢ'), s[0] + 3, W - 8); }
    }
  }

  function pixelGrid(ctx, v, W, n) {
    const scr = (W / n) * v.z;
    if (scr < 9) return;
    const o = win(v);
    ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.lineWidth = 1; ctx.beginPath();
    for (let i = Math.floor(o.x0 * n); i <= Math.ceil((o.x0 + o.w) * n); i++) { const x = ((i / n - o.x0) / o.w) * W; ctx.moveTo(x, 0); ctx.lineTo(x, W); }
    for (let j = Math.floor(o.y0 * n); j <= Math.ceil((o.y0 + o.w) * n); j++) { const y = ((j / n - o.y0) / o.w) * W; ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
  }

  function cross(ctx, X, Y, r, color, lw = 1.5) {
    ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.beginPath();
    ctx.moveTo(X - r, Y); ctx.lineTo(X - r * 0.35, Y); ctx.moveTo(X + r * 0.35, Y); ctx.lineTo(X + r, Y);
    ctx.moveTo(X, Y - r); ctx.lineTo(X, Y - r * 0.35); ctx.moveTo(X, Y + r * 0.35); ctx.lineTo(X, Y + r); ctx.stroke();
  }

  function arrow(ctx, x1, y1, x2, y2, color) {
    const a = Math.atan2(y2 - y1, x2 - x1);
    ctx.strokeStyle = ctx.fillStyle = color; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x2, y2); ctx.lineTo(x2 - 12 * Math.cos(a - 0.4), y2 - 12 * Math.sin(a - 0.4)); ctx.lineTo(x2 - 12 * Math.cos(a + 0.4), y2 - 12 * Math.sin(a + 0.4)); ctx.closePath(); ctx.fill();
  }

  /** график y(x) в SVG; points: [{x, y, label, on}] */
  function chart(points, { xLabel = '', yLabel = '', xFmt = (x) => x.toFixed(2), w = 320, h = 150, color = '#ff7a45' } = {}) {
    const p = points.filter((q) => Number.isFinite(q.x) && Number.isFinite(q.y));
    if (p.length < 2) return '<p class="muted small">Not enough points for a chart.</p>';
    const xs = p.map((q) => q.x), ys = p.map((q) => q.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const L = 40, R = 8, T = 10, B = 26;
    const X = (x) => L + ((x - x0) / (x1 - x0 || 1)) * (w - L - R), Y = (y) => h - B - ((y - y0) / (y1 - y0 || 1)) * (h - T - B);
    let s = `<svg viewBox="0 0 ${w} ${h}" class="chart"><rect x="${L}" y="${T}" width="${w - L - R}" height="${h - T - B}" class="bg"/>`;
    s += `<polyline points="${p.map((q) => `${X(q.x).toFixed(1)},${Y(q.y).toFixed(1)}`).join(' ')}" fill="none" stroke="${color}" stroke-opacity=".35"/>`;
    p.forEach((q) => { s += `<circle cx="${X(q.x).toFixed(1)}" cy="${Y(q.y).toFixed(1)}" r="${q.on ? 4.5 : 3}" fill="${q.on ? '#fff' : color}"><title>${q.label || ''}</title></circle>`; });
    s += `<text x="${L}" y="${h - 8}" class="ax">${xFmt(x0)}</text><text x="${w - R}" y="${h - 8}" class="ax" text-anchor="end">${xFmt(x1)}</text>`;
    s += `<text x="${L - 4}" y="${T + 9}" class="ax" text-anchor="end">${y1.toFixed(0)}</text><text x="${L - 4}" y="${h - B}" class="ax" text-anchor="end">${y0.toFixed(0)}</text>`;
    s += `<text x="${(L + w - R) / 2}" y="${h - 8}" class="ax" text-anchor="middle">${xLabel}</text><text x="10" y="${(T + h - B) / 2}" class="ax" transform="rotate(-90 10 ${(T + h - B) / 2})" text-anchor="middle">${yLabel}</text></svg>`;
    return s;
  }

  SW.cmpView = { skyToPix, toScreen, toPix, blit, grid, pixelGrid, cross, arrow, chart, win };
})();
