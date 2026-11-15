/* Наука в браузере: сравнение двух совмещённых кадров SPHEREx и поиск changes.
 * Кадры приходят в «шкале σ» (0 = фон, 1 = шум), Float32Array n×n, строка 0 = север.
 * Алгоритм повторяет python/skywatch/imaging.py, поэтому результаты совпадают с конвейером.
 */
(function () {
  const SW = (window.SW = window.SW || {});

  function median(arr) {
    const a = Float32Array.from(arr).sort();
    const n = a.length;
    return n ? (n % 2 ? a[(n - 1) / 2] : 0.5 * (a[n / 2 - 1] + a[n / 2])) : 0;
  }
  function robustStats(values, sigma = 3, iters = 5) {
    let v = values.filter(Number.isFinite);
    if (v.length < 10) return { med: 0, std: 1 };
    let med = median(v);
    let std = 1.4826 * median(v.map((x) => Math.abs(x - med))) || 1;
    for (let i = 0; i < iters; i++) {
      const keep = v.filter((x) => Math.abs(x - med) < sigma * std);
      if (keep.length < 10) break;
      const m2 = median(keep), s2 = 1.4826 * median(keep.map((x) => Math.abs(x - m2))) || std;
      if (Math.abs(m2 - med) < 1e-6 && Math.abs(s2 - std) < 1e-6 * std) break;
      med = m2; std = s2; v = keep;
    }
    return { med, std: Math.max(std, 1e-12) };
  }

  function erode(mask, n, it) {
    let m = mask;
    for (let k = 0; k < it; k++) {
      const o = new Uint8Array(n * n);
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        const i = y * n + x;
        o[i] = m[i] && x > 0 && x < n - 1 && y > 0 && y < n - 1 && m[i - 1] && m[i + 1] && m[i - n] && m[i + n] ? 1 : 0;
      }
      m = o;
    }
    return m;
  }
  function dilate(mask, n, it) {
    let m = mask;
    for (let k = 0; k < it; k++) {
      const o = new Uint8Array(n * n);
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        const i = y * n + x;
        o[i] = m[i] || (x > 0 && m[i - 1]) || (x < n - 1 && m[i + 1]) || (y > 0 && m[i - n]) || (y < n - 1 && m[i + n]) ? 1 : 0;
      }
      m = o;
    }
    return m;
  }

  /** B − k·A, нормированная на свой шум; k подгоняет яркость (длины волн эпох слегка различаются) */
  function difference(a, b, n, { edge = 3, brightSigma = 60 } = {}) {
    let valid = new Uint8Array(n * n);
    for (let i = 0; i < n * n; i++) valid[i] = Number.isFinite(a[i]) && Number.isFinite(b[i]) ? 1 : 0;
    valid = erode(valid, n, edge);
    const ratios = [];
    let nValid = 0;
    for (let i = 0; i < n * n; i++) {
      if (!valid[i]) continue;
      nValid++;
      if (a[i] > 8 && b[i] > 8 && a[i] < 2000 && b[i] < 2000) ratios.push(b[i] / a[i]);
    }
    if (nValid < 50) throw new Error('Frames barely overlap');
    const k = ratios.length >= 8 ? Math.min(4, Math.max(0.25, median(ratios))) : 1;
    const d = new Float32Array(n * n).fill(NaN);
    const vals = [];
    for (let i = 0; i < n * n; i++) if (valid[i]) { d[i] = b[i] - k * a[i]; vals.push(d[i]); }
    const { std: noise } = robustStats(vals);
    let bright = new Uint8Array(n * n);
    for (let i = 0; i < n * n; i++) { if (valid[i]) d[i] /= noise; bright[i] = valid[i] && (a[i] > brightSigma || b[i] > brightSigma) ? 1 : 0; }
    bright = dilate(bright, n, 2);
    return { diff: d, valid, k, noise, bright };
  }

  function localMax(arr, n, x, y) {
    let m = -Infinity;
    for (let yy = Math.max(0, y - 1); yy <= Math.min(n - 1, y + 1); yy++)
      for (let xx = Math.max(0, x - 1); xx <= Math.min(n - 1, x + 1); xx++) {
        const v = arr[yy * n + xx]; if (Number.isFinite(v) && v > m) m = v;
      }
    return m;
  }

  /** компактные области |разность| > порога → появился / исчез / сдвинулся / изменил яркость */
  function detect(dr, a, b, n, { threshold = 5, minArea = 2, max = 40, dtHours = null, pxArcsec = 6.15, pairMaxPx = 40 } = {}) {
    const found = [];
    for (const sign of [1, -1]) {
      const lab = new Int32Array(n * n);
      let next = 0;
      for (let i = 0; i < n * n; i++) {
        if (lab[i] || !dr.valid[i] || !(sign * dr.diff[i] > threshold)) continue;
        next++;
        const stack = [i]; lab[i] = next;
        let area = 0, sw = 0, sx = 0, sy = 0, peak = 0;
        while (stack.length) {
          const j = stack.pop(), x = j % n, y = (j / n) | 0, v = sign * dr.diff[j];
          area++; sw += v; sx += v * x; sy += v * y; if (v > peak) peak = v;
          for (let yy = y - 1; yy <= y + 1; yy++) for (let xx = x - 1; xx <= x + 1; xx++) {
            if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
            const q = yy * n + xx;
            if (!lab[q] && dr.valid[q] && sign * dr.diff[q] > threshold) { lab[q] = next; stack.push(q); }
          }
        }
        if (area < minArea) continue;
        const cx = sx / sw, cy = sy / sw, ix = Math.round(cx), iy = Math.round(cy);
        if (dr.bright[iy * n + ix]) continue;
        const hereA = localMax(a, n, ix, iy), hereB = localMax(b, n, ix, iy);
        let kind, label;
        if (sign > 0) { kind = hereA < 3 ? 'appeared' : 'brightened'; label = kind === 'appeared' ? 'Appeared in B' : 'Brighter in B'; }
        else { kind = hereB < 3 ? 'vanished' : 'faded'; label = kind === 'vanished' ? 'Vanished by B' : 'Fainter in B'; }
        found.push({ x: cx, y: cy, sign, snr: peak, area, kind, label, pair: null, rate: null });
      }
    }
    found.sort((p, q) => q.snr - p.snr);
    const top = found.slice(0, max);
    const used = new Set();
    top.forEach((c, i) => {
      if (c.kind !== 'appeared') return;
      let best = -1, bestD = pairMaxPx;
      top.forEach((o, j) => {
        if (o.kind !== 'vanished' || used.has(j)) return;
        const dd = Math.hypot(c.x - o.x, c.y - o.y);
        if (dd > 1.5 && dd < bestD) { best = j; bestD = dd; }
      });
      if (best < 0) return;
      used.add(best);
      const rate = dtHours > 0 ? (bestD * pxArcsec) / dtHours : null;
      c.pair = best; top[best].pair = i;
      c.kind = top[best].kind = 'moving';
      c.rate = top[best].rate = rate;
      c.label = 'Moved · new position (B)';
      top[best].label = 'Moved · old position (A)';
    });
    return top;
  }

  // палитры
  const IR = [[0, 2, 3, 10], [0.22, 36, 18, 84], [0.45, 150, 40, 110], [0.68, 240, 120, 60], [0.86, 255, 205, 120], [1, 255, 252, 240]];
  function lut(stops) {
    const out = new Uint8Array(256 * 3);
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      let k = 0; while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
      const [t0, r0, g0, b0] = stops[k], [t1, r1, g1, b1] = stops[k + 1], f = (t - t0) / (t1 - t0 || 1);
      out[i * 3] = r0 + (r1 - r0) * f; out[i * 3 + 1] = g0 + (g1 - g0) * f; out[i * 3 + 2] = b0 + (b1 - b0) * f;
    }
    return out;
  }
  const IR_LUT = lut(IR);

  function percentile(arr, p) {
    const v = Float32Array.from(arr.filter(Number.isFinite)).sort();
    return v.length ? v[Math.min(v.length - 1, Math.floor((p / 100) * v.length))] : 10;
  }
  const LUTS = {
    ir: IR_LUT,
    gray: lut([[0, 0, 0, 0], [1, 255, 255, 255]]),
    cool: lut([[0, 1, 3, 12], [0.35, 20, 60, 130], [0.7, 120, 190, 235], [1, 245, 252, 255]]),
  };
  /** кадр (σ) → ImageData; stretch: asinh | linear | sqrt | log; palette: ir | gray | cool */
  function renderImage(sig, n, { lo = -2, hi = null, soft = 8, stretch = 'asinh', palette = 'ir' } = {}) {
    if (hi == null) hi = percentile(sig, 99.7);
    hi = Math.max(hi, lo + 6);
    const L = LUTS[palette] || IR_LUT;
    const img = new ImageData(n, n), d = img.data, as = Math.asinh(soft), lg = Math.log(1 + 1000);
    for (let i = 0; i < n * n; i++) {
      const v = sig[i];
      let s = 0;
      if (Number.isFinite(v)) {
        const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
        s = stretch === 'linear' ? t : stretch === 'sqrt' ? Math.sqrt(t) : stretch === 'log' ? Math.log(1 + 1000 * t) / lg : Math.asinh(t * soft) / as;
      }
      const c = Math.round(s * 255) * 3;
      d[i * 4] = L[c]; d[i * 4 + 1] = L[c + 1]; d[i * 4 + 2] = L[c + 2]; d[i * 4 + 3] = Number.isFinite(v) ? 255 : 255;
      if (!Number.isFinite(v)) { d[i * 4] = 46; d[i * 4 + 1] = 52; d[i * 4 + 2] = 66; } // «нет данных» — грифельный
    }
    return img;
  }
  /** сглаживание: два прохода бокс-фильтра радиуса r (≈ гаусс) */
  function smooth(src, n, r) {
    if (!r) return src;
    let a = Float32Array.from(src), b = new Float32Array(n * n);
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { let s = 0, c = 0; for (let k = -r; k <= r; k++) { const xx = x + k; if (xx < 0 || xx >= n) continue; const v = a[y * n + xx]; if (Number.isFinite(v)) { s += v; c++; } } b[y * n + x] = c ? s / c : NaN; }
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { let s = 0, c = 0; for (let k = -r; k <= r; k++) { const yy = y + k; if (yy < 0 || yy >= n) continue; const v = b[yy * n + x]; if (Number.isFinite(v)) { s += v; c++; } } a[y * n + x] = c ? s / c : NaN; }
    }
    return a;
  }
  /** разность → ImageData: тёплое ярче в B, холодное ярче в A */
  function renderDiff(dr, n, scale = 8) {
    const img = new ImageData(n, n), d = img.data, as = Math.asinh(4);
    for (let i = 0; i < n * n; i++) {
      let r = 0, g = 0, bl = 0;
      if (dr.valid[i]) {
        const s = Math.asinh(Math.max(-1, Math.min(1, dr.diff[i] / scale)) * 4) / as;
        const p = Math.max(0, s), q = Math.max(0, -s), z = 1 - p - q;
        r = 6 * z + 255 * p + 70 * q; g = 8 * z + 112 * p + 160 * q; bl = 20 * z + 60 * p + 255 * q;
      }
      d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = bl; d[i * 4 + 3] = 255;
    }
    return img;
  }

  SW.detect = { robustStats, difference, detect, renderImage, renderDiff, percentile, median, smooth };
})();
