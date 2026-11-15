/* Чтение FITS и астрометрия прямо в браузере: многослойные файлы SPHEREx (IMAGE, FLAGS, VARIANCE, ZODI…),
 * WCS TAN-SIP (дисторсия SIP, в том числе без обратных коэффициентов) и пересчёт кадра на общую сетку
 * «север вверх, восток влево». Нужен, чтобы сравнивать снимки разных эпох pxель в pxель.
 */
(function () {
  const SW = (window.SW = window.SW || {});
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;

  function parseHeader(bytes, offset) {
    const cards = {};
    let pos = offset;
    for (;;) {
      if (pos + 2880 > bytes.length) throw new Error('FITS: truncated header');
      let end = false;
      for (let i = 0; i < 36; i++) {
        let s = '';
        for (let j = 0; j < 80; j++) s += String.fromCharCode(bytes[pos + i * 80 + j]);
        const key = s.slice(0, 8).trim();
        if (key === 'END') { end = true; break; }
        if (s[8] !== '=') continue;
        let v = s.slice(10);
        if (v.trim().startsWith("'")) {
          const m = v.match(/'((?:[^']|'')*)'/);
          cards[key] = m ? m[1].replace(/''/g, "'").trim() : '';
        } else {
          v = v.split('/')[0].trim();
          if (v === 'T' || v === 'F') cards[key] = v === 'T';
          else { const n = Number(v.replace(/D/g, 'E')); cards[key] = Number.isFinite(n) ? n : v; }
        }
      }
      pos += 2880;
      if (end) return { cards, dataStart: pos };
    }
  }

  /** все HDU файла: [{header, data (Float32Array) | null, width, height}] */
  function parseFITS(buffer) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const hdus = [];
    let off = 0;
    while (off + 2880 <= bytes.length) {
      const { cards, dataStart } = parseHeader(bytes, off);
      const bitpix = cards.BITPIX, naxis = cards.NAXIS || 0;
      let n = naxis ? 1 : 0;
      for (let i = 1; i <= naxis; i++) n *= cards[`NAXIS${i}`] || 0;
      const nbytes = (Math.abs(bitpix) / 8) * (n + 0) * (cards.GCOUNT || 1) + (Math.abs(bitpix) / 8) * (cards.PCOUNT || 0);
      let data = null;
      if (naxis === 2 && !cards.XTENSION?.toString().includes('TABLE') && n > 0) {
        const w = cards.NAXIS1, h = cards.NAXIS2, out = new Float32Array(w * h);
        const bz = cards.BZERO || 0, bs = cards.BSCALE || 1;
        for (let i = 0; i < w * h; i++) {
          let v;
          const p = dataStart + i * (Math.abs(bitpix) / 8);
          if (bitpix === -32) v = view.getFloat32(p, false);
          else if (bitpix === -64) v = view.getFloat64(p, false);
          else if (bitpix === 16) v = view.getInt16(p, false);
          else if (bitpix === 32) v = view.getInt32(p, false);
          else if (bitpix === 8) v = view.getUint8(p);
          else v = NaN;
          out[i] = v * bs + bz;
        }
        data = out;
      }
      hdus.push({ header: cards, data, width: cards.NAXIS1, height: cards.NAXIS2 });
      off = dataStart + Math.ceil(nbytes / 2880) * 2880;
      if (nbytes === 0 && off === dataStart && hdus.length > 64) break;
    }
    return hdus;
  }

  /** WCS TAN(-SIP): мир → pxель (0-based) */
  function makeWCS(h) {
    let cd;
    if (h.CD1_1 != null) cd = [h.CD1_1, h.CD1_2 || 0, h.CD2_1 || 0, h.CD2_2];
    else {
      const c1 = h.CDELT1 || 1, c2 = h.CDELT2 || 1;
      cd = [(h.PC1_1 ?? 1) * c1, (h.PC1_2 || 0) * c1, (h.PC2_1 || 0) * c2, (h.PC2_2 ?? 1) * c2];
    }
    const det = cd[0] * cd[3] - cd[1] * cd[2];
    const inv = [cd[3] / det, -cd[1] / det, -cd[2] / det, cd[0] / det];
    const coeffs = (p) => {
      const order = h[`${p}_ORDER`];
      if (!order) return null;
      const list = [];
      for (let i = 0; i <= order; i++) for (let j = 0; j <= order - i; j++) { const c = h[`${p}_${i}_${j}`]; if (c) list.push([i, j, c]); }
      return list;
    };
    const A = coeffs('A'), B = coeffs('B'), AP = coeffs('AP'), BP = coeffs('BP');
    const poly = (cs, u, v) => { let s = 0; for (const [i, j, c] of cs) s += c * u ** i * v ** j; return s; };
    const ra0 = h.CRVAL1 * D2R, de0 = h.CRVAL2 * D2R, cr1 = h.CRPIX1, cr2 = h.CRPIX2;
    return function world2pix(raDeg, decDeg) {
      const ra = raDeg * D2R, de = decDeg * D2R, dra = ra - ra0;
      const cosc = Math.sin(de) * Math.sin(de0) + Math.cos(de) * Math.cos(de0) * Math.cos(dra);
      if (cosc <= 0) return [NaN, NaN];
      const xi = (Math.cos(de) * Math.sin(dra)) / cosc * R2D;
      const eta = (Math.sin(de) * Math.cos(de0) - Math.cos(de) * Math.sin(de0) * Math.cos(dra)) / cosc * R2D;
      const U = inv[0] * xi + inv[1] * eta, V = inv[2] * xi + inv[3] * eta;
      let u = U, v = V;
      if (AP && BP) { u = U + poly(AP, U, V); v = V + poly(BP, U, V); }
      else if (A && B) { for (let k = 0; k < 12; k++) { u = U - poly(A, u, v); v = V - poly(B, u, v); } }
      return [u + cr1 - 1, v + cr2 - 1];
    };
  }

  /** касательная сетка n×n с центром (ra, dec): строка 0 = север, столбец 0 = восток */
  function gridToSky(ra0d, de0d, n, scaleArcsec) {
    const ra0 = ra0d * D2R, de0 = de0d * D2R, s = (scaleArcsec / 3600) * D2R, c = (n - 1) / 2;
    const out = new Float64Array(n * n * 2);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const xi = -(x - c) * s, eta = -(y - c) * s;
      const den = Math.cos(de0) - eta * Math.sin(de0);
      const ra = ra0 + Math.atan2(xi, den), de = Math.atan2(Math.sin(de0) + eta * Math.cos(de0), Math.hypot(xi, den));
      out[(y * n + x) * 2] = ((ra * R2D) % 360 + 360) % 360;
      out[(y * n + x) * 2 + 1] = de * R2D;
    }
    return out;
  }

  /** биlinear репроекция кадра на сетку; NaN вне кадра */
  function reproject(img, w, h, world2pix, grid, n) {
    const out = new Float32Array(n * n);
    let valid = 0;
    for (let i = 0; i < n * n; i++) {
      const [px, py] = world2pix(grid[i * 2], grid[i * 2 + 1]);
      if (!(px >= 0 && py >= 0 && px < w - 1 && py < h - 1)) { out[i] = NaN; continue; }
      const x0 = Math.floor(px), y0 = Math.floor(py), fx = px - x0, fy = py - y0, k = y0 * w + x0;
      const v = img[k] * (1 - fx) * (1 - fy) + img[k + 1] * fx * (1 - fy) + img[k + w] * (1 - fx) * fy + img[k + w + 1] * fx * fy;
      out[i] = v;
      if (Number.isFinite(v)) valid++;
    }
    return { data: out, validFraction: valid / (n * n) };
  }

  SW.fits = { parseFITS, makeWCS, gridToSky, reproject };
})();
