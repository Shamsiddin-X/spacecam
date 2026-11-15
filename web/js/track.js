/* SpaceCam · анализ серии кадров: слежение за объектом, фотометрия (кривая блеска),
 * подгонка движения (speed и нAprавление), обычный стек и стек со сдвигом по движению.
 * Кадры — Float32Array в шкале σ на общей сетке n×n (строка 0 = север, столбец 0 = восток).
 */
(function () {
  const SW = (window.SW = window.SW || {});

  const at = (d, n, x, y) => (x >= 0 && y >= 0 && x < n && y < n ? d[y * n + x] : NaN);

  /** уточнить положение: максимум в радиусе r, затем центроид 3×3 */
  function refine(d, n, x0, y0, r = 4) {
    let best = -Infinity, bx = Math.round(x0), by = Math.round(y0);
    for (let y = Math.round(y0) - r; y <= Math.round(y0) + r; y++) for (let x = Math.round(x0) - r; x <= Math.round(x0) + r; x++) {
      if ((x - x0) ** 2 + (y - y0) ** 2 > r * r) continue;
      const v = at(d, n, x, y);
      if (v > best) { best = v; bx = x; by = y; }
    }
    if (!(best > 3)) return null; // слабее 3σ — объект потерян
    let sw = 0, sx = 0, sy = 0;
    for (let y = by - 1; y <= by + 1; y++) for (let x = bx - 1; x <= bx + 1; x++) { const v = Math.max(0, at(d, n, x, y) || 0); sw += v; sx += v * x; sy += v * y; }
    return sw > 0 ? { x: sx / sw, y: sy / sw, peak: best } : { x: bx, y: by, peak: best };
  }

  /** поиск движущегося: максимум разности «этот кадр − опорный» в радиусе R (звёзды поля вычитаются) */
  function refineMover(d, ref, n, x0, y0, R = 12) {
    let best = -Infinity, bx = 0, by = 0;
    for (let y = Math.round(y0) - R; y <= Math.round(y0) + R; y++) for (let x = Math.round(x0) - R; x <= Math.round(x0) + R; x++) {
      if ((x - x0) ** 2 + (y - y0) ** 2 > R * R) continue;
      const v = at(d, n, x, y), r0 = at(ref, n, x, y);
      if (!(v > 3) || !Number.isFinite(r0)) continue;
      if (v - r0 > best) { best = v - r0; bx = x; by = y; }
    }
    return best > 5 ? refine(d, n, bx, by, 1) : null;
  }

  /** апертурная фотометрия: сумма в круге r минус медиана кольца [r+2, r+5] */
  function photometry(d, n, x0, y0, r = 2) {
    const ring = [];
    let sum = 0, cnt = 0;
    const R = r + 5;
    for (let y = Math.floor(y0 - R); y <= Math.ceil(y0 + R); y++) for (let x = Math.floor(x0 - R); x <= Math.ceil(x0 + R); x++) {
      const v = at(d, n, x, y);
      if (!Number.isFinite(v)) continue;
      const q = Math.hypot(x - x0, y - y0);
      if (q <= r) { sum += v; cnt++; } else if (q >= r + 2 && q <= R) ring.push(v);
    }
    ring.sort((a, b) => a - b);
    const bg = ring.length ? ring[Math.floor(ring.length / 2)] : 0;
    return cnt ? sum - bg * cnt : NaN;
  }

  /** проследить объект по всем кадрам (по времени), начиная с кадра start в точке (x, y) */
  function follow(frames, start, x, y) {
    const n = frames[0].n;
    const pos = new Array(frames.length).fill(null);
    const first = refine(frames[start].data, n, x, y, 5);
    pos[start] = first || { x, y, peak: NaN, guess: true };
    const walk = (from, to, step) => {
      for (let i = from + step; step > 0 ? i <= to : i >= to; i += step) {
        const prev = pos[i - step], prev2 = pos[i - 2 * step];
        let gx = prev.x, gy = prev.y;
        if (prev2 && !prev.guess && !prev2.guess) {
          // линейный прогноз по двум последним точкам с учётом времени
          const dt1 = frames[i].mjd - frames[i - step].mjd, dt0 = frames[i - step].mjd - frames[i - 2 * step].mjd;
          if (Math.abs(dt0) > 1e-6 && Math.abs(dt1) < 30) { gx += ((prev.x - prev2.x) * dt1) / dt0; gy += ((prev.y - prev2.y) * dt1) / dt0; }
        }
        const predicted = gx !== prev.x || gy !== prev.y;
        // с прогнозом — узкий поиск; без прогноза — ищем по разности с исходным кадром, затем на месте (переменная звезда)
        let r = predicted ? refine(frames[i].data, n, gx, gy, 4) : null;
        if (!r) r = refineMover(frames[i].data, frames[start].data, n, gx, gy, 12);
        if (!r) r = refine(frames[i].data, n, gx, gy, 3);
        pos[i] = r || { x: gx, y: gy, peak: NaN, guess: true };
      }
    };
    walk(start, frames.length - 1, 1);
    walk(start, 0, -1);
    return pos.map((p, i) => ({ ...p, flux: photometry(frames[i].data, n, p.x, p.y), mjd: frames[i].mjd, band: frames[i].band, wavelength: frames[i].wavelength_um }));
  }

  /** speed (px/dки) и нAprавление по точкам слежения (метод наименьших квадратов) */
  function motion(track, pxArcsec) {
    const p = track.filter((t) => !t.guess && Number.isFinite(t.mjd));
    if (p.length < 2) return null;
    const t0 = p[0].mjd, mt = p.reduce((s, q) => s + (q.mjd - t0), 0) / p.length;
    const mx = p.reduce((s, q) => s + q.x, 0) / p.length, my = p.reduce((s, q) => s + q.y, 0) / p.length;
    let stt = 0, stx = 0, sty = 0;
    p.forEach((q) => { const dt = q.mjd - t0 - mt; stt += dt * dt; stx += dt * (q.x - mx); sty += dt * (q.y - my); });
    if (stt < 1e-9) return null;
    const vx = stx / stt, vy = sty / stt; // px/dки
    const speed = Math.hypot(vx, vy) * pxArcsec; // ″/dки
    // позиционный угол: от севера к востоку; x растёт на запад, y — на юг
    const pa = ((Math.atan2(-vx, -vy) * 180) / Math.PI + 360) % 360;
    return { vx, vy, t0: t0 + mt, x0: mx, y0: my, perHour: speed / 24, perDay: speed, perYear: speed * 365.25, pa };
  }

  function shiftSample(d, n, x, y) {
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const a = at(d, n, x0, y0), b = at(d, n, x0 + 1, y0), c = at(d, n, x0, y0 + 1), e = at(d, n, x0 + 1, y0 + 1);
    if (![a, b, c, e].every(Number.isFinite)) return NaN;
    return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + e * fx * fy;
  }
  /** стек: среднее кадров; при заданной скорости — со сдвигом, чтобы движущийся объект сложился в точку */
  function stack(frames, mot = null) {
    const n = frames[0].n, out = new Float32Array(n * n), cnt = new Uint16Array(n * n);
    frames.forEach((f) => {
      const dx = mot ? mot.vx * (f.mjd - mot.t0) : 0, dy = mot ? mot.vy * (f.mjd - mot.t0) : 0;
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        const v = mot ? shiftSample(f.data, n, x + dx, y + dy) : f.data[y * n + x];
        if (Number.isFinite(v)) { out[y * n + x] += v; cnt[y * n + x]++; }
      }
    });
    for (let i = 0; i < n * n; i++) out[i] = cnt[i] ? (out[i] / cnt[i]) * Math.sqrt(cnt[i]) : NaN; // σ-шкала растёт как √N
    return out;
  }

  SW.track = { refine, photometry, follow, motion, stack };
})();
