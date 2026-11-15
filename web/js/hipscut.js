/* Вырезка из любой вSepебесной мозаики HiPS прямо в браузере: тайлы HEALPix → общая сетка
 * «север вверх, восток влево». Так снимки разных лет (DSS, 2MASS, WISE, Pan-STARRS, SPHEREx)
 * совмещаются pxель в pxель и их можно мигать, сравнивать шторкой и вычитать.
 */
(function () {
  const SW = (window.SW = window.SW || {});

  // архивы неба с годами наблюдений — «эпохи» для машины времени
  // Every archive is read from the IRSA HiPS node first (same host as the SPHEREx map, browser-friendly),
  // with the CDS original as a fallback. `match` pairs surveys taken at the same wavelength.
  const SX = 'https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube';
  const ARCHIVES = [
    { id: 'dss2', name: 'DSS2 red', years: '1985–2000', year: 1993, base: 'https://irsa.ipac.caltech.edu/data/hips/CDS/DSS2/red', alt: 'https://alasky.cds.unistra.fr/DSS/DSS2Merged', fmt: 'jpg', maxOrder: 9, hipsId: 'CDS/P/DSS2/red', lambda: '0.65 µm', mono: true },
    { id: '2mass-k', name: '2MASS K', years: '1997–2001', year: 1999, base: 'https://irsa.ipac.caltech.edu/data/hips/CDS/2MASS/K', alt: 'https://alasky.cds.unistra.fr/2MASS/K', fmt: 'jpg', maxOrder: 9, hipsId: 'CDS/P/2MASS/K', lambda: '2.16 µm', mono: true, match: 'K' },
    { id: 'wise-w1', name: 'AllWISE W1', years: '2010–2011', year: 2010.4, base: 'https://irsa.ipac.caltech.edu/data/hips/CDS/AllWISE/W1', alt: 'https://alasky.cds.unistra.fr/AllWISE/W1', fmt: 'jpg', maxOrder: 8, hipsId: 'CDS/P/allWISE/W1', lambda: '3.4 µm', mono: true, match: 'W1' },
    { id: 'wise-w2', name: 'AllWISE W2', years: '2010–2011', year: 2010.5, base: 'https://irsa.ipac.caltech.edu/data/hips/CDS/AllWISE/W2', alt: 'https://alasky.cds.unistra.fr/AllWISE/W2', fmt: 'jpg', maxOrder: 8, hipsId: 'CDS/P/allWISE/W2', lambda: '4.6 µm', mono: true, match: 'W2' },
    { id: 'ps1', name: 'Pan-STARRS DR1', years: '2010–2014', year: 2012, base: 'https://alasky.cds.unistra.fr/Pan-STARRS/DR1/color-z-zg-g', fmt: 'jpg', maxOrder: 11, hipsId: 'CDS/P/PanSTARRS/DR1/color-z-zg-g', lambda: '0.48–0.87 µm', decMin: -30 },
    { id: 'sx-k', name: 'SPHEREx DR1 · 2.16 µm', years: '2025–2026', year: 2025.9, base: SX, fmt: 'png', maxOrder: 5, cube: true, mono: true, lambdaUm: 2.16, lambda: '2.16 µm', match: 'K' },
    { id: 'sx-w1', name: 'SPHEREx DR1 · 3.4 µm', years: '2025–2026', year: 2025.91, base: SX, fmt: 'png', maxOrder: 5, cube: true, mono: true, lambdaUm: 3.37, lambda: '3.4 µm', match: 'W1' },
    { id: 'sx-w2', name: 'SPHEREx DR1 · 4.6 µm', years: '2025–2026', year: 2025.92, base: SX, fmt: 'png', maxOrder: 5, cube: true, mono: true, lambdaUm: 4.6, lambda: '4.6 µm', match: 'W2' },
  ];
  const nearestChannel = (um) => { const L = SW.astro.SPHEREX_LAMBDA; let k = 0; L.forEach((v, i) => { if (Math.abs(v - um) < Math.abs(L[k] - um)) k = i; }); return k; };


  const tileCache = new Map();
  function tile(url) {
    if (tileCache.has(url)) return tileCache.get(url);
    const p = new Promise((res, rej) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      const t = setTimeout(() => rej(new Error('timeout')), 25000);
      img.onload = () => {
        clearTimeout(t);
        try {
          const c = document.createElement('canvas');
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          const g = c.getContext('2d', { willReadFrequently: true });
          g.drawImage(img, 0, 0);
          res({ w: c.width, h: c.height, px: g.getImageData(0, 0, c.width, c.height).data });
        } catch (e) { rej(e); }
      };
      img.onerror = () => { clearTimeout(t); rej(new Error('load')); };
      img.src = url;
    });
    tileCache.set(url, p);
    if (tileCache.size > 400) tileCache.delete(tileCache.keys().next().value);
    p.catch(() => tileCache.delete(url));
    return p;
  }

  /** CDS hips2fits: готовая вырезка «север вверх, восток влево» за один запрос */
  function viaHips2fits(survey, ra, dec, n, scaleArcsec) {
    const fov = (n * scaleArcsec) / 3600;
    const url = `https://alasky.cds.unistra.fr/hips-image-services/hips2fits?hips=${encodeURIComponent(survey.hipsId)}&width=${n}&height=${n}&fov=${fov.toFixed(5)}&projection=TAN&coordsys=icrs&rotation_angle=0.0&ra=${ra.toFixed(6)}&dec=${dec.toFixed(6)}&format=jpg`;
    return tile(url).then((t) => {
      const img = new ImageData(n, n), d = img.data, lum = new Float32Array(n * n);
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        const sx = Math.min(t.w - 1, Math.floor(((x + 0.5) * t.w) / n)), sy = Math.min(t.h - 1, Math.floor(((y + 0.5) * t.h) / n));
        const k = (sy * t.w + sx) * 4, i = y * n + x;
        d[i * 4] = t.px[k]; d[i * 4 + 1] = t.px[k + 1]; d[i * 4 + 2] = t.px[k + 2]; d[i * 4 + 3] = 255;
        lum[i] = 0.299 * t.px[k] + 0.587 * t.px[k + 1] + 0.114 * t.px[k + 2];
      }
      return { image: img, lum };
    });
  }
  function toSigma(lum) {
    const vals = [];
    for (let i = 0; i < lum.length; i += 3) if (Number.isFinite(lum[i])) vals.push(lum[i]);
    const { med, std } = SW.detect.robustStats(vals);
    return lum.map((v) => (v - med) / Math.max(std, 0.5));
  }

  /** cutout n×n (step scaleArcsec) from a survey; frame — SPHEREx cube channel */
  async function cut(survey, ra, dec, n, scaleArcsec, frame = 0) {
    if (survey.lambdaUm) frame = nearestChannel(survey.lambdaUm);
    let last;
    for (const base of [survey.base, survey.alt].filter(Boolean)) {
      try { return await cutTiles({ ...survey, base }, ra, dec, n, scaleArcsec, frame); } catch (e) { last = e; }
    }
    if (survey.hipsId) {
      try { const r = await viaHips2fits(survey, ra, dec, n, scaleArcsec); if (survey.mono) colorize(r.image, r.lum); return { image: r.image, data: toSigma(r.lum), order: -1, via: 'hips2fits' }; }
      catch (e) { last = e; }
    }
    throw last || new Error(`${survey.name}: no image`);
  }
  async function cutTiles(survey, ra, dec, n, scaleArcsec, frame) {
    const H = SW.healpix;
    let order = 3;
    while (order < survey.maxOrder && 58.63 / (2 ** order * 512) > (scaleArcsec / 3600) * 0.9) order++;
    const ns = 2 ** order;
    const grid = SW.fits.gridToSky(ra, dec, n, scaleArcsec);
    const D = Math.PI / 180;
    const need = new Map();
    const where = new Array(n * n);
    for (let i = 0; i < n * n; i++) {
      const f = H.ang2fxy(Math.sin(grid[i * 2 + 1] * D), grid[i * 2] * D);
      const ix = Math.min(ns - 1, Math.floor(f.x * ns)), iy = Math.min(ns - 1, Math.floor(f.y * ns));
      const ipix = f.face * ns * ns + H.spread(ix) + 2 * H.spread(iy);
      where[i] = [ipix, f.x * ns - ix, f.y * ns - iy];
      need.set(ipix, true);
    }
    const suffix = survey.cube && frame > 0 ? `_${frame}` : '';
    const urls = new Map([...need.keys()].map((p) => [p, `${survey.base}/Norder${order}/Dir${Math.floor(p / 10000) * 10000}/Npix${p}${suffix}.${survey.fmt}`]));
    const tiles = new Map();
    await Promise.all([...urls].map(async ([p, u]) => { try { tiles.set(p, await tile(u)); } catch (_) { /* тайла нет (край обзора) */ } }));
    if (!tiles.size) throw new Error(`${survey.name}: the archive returned no image`);
    const img = new ImageData(n, n), d = img.data, lum = new Float32Array(n * n);
    let got = 0;
    for (let i = 0; i < n * n; i++) {
      const [p, fx, fy] = where[i];
      const t = tiles.get(p);
      if (!t) { lum[i] = NaN; d[i * 4 + 3] = 255; continue; }
      // в тайле HiPS: столбец ← ось y грани, строка ← ось x грани
      const col = Math.min(t.w - 1, Math.floor(fy * t.w)), row = Math.min(t.h - 1, Math.floor(fx * t.h));
      const k = (row * t.w + col) * 4;
      const r = t.px[k], g = t.px[k + 1], b = t.px[k + 2];
      d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = 255;
      lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
      got++;
    }
    if (got < n * n * 0.5) throw new Error(`${survey.name}: field outside the survey`);
    if (survey.mono) colorize(img, lum);
    // шкала σ для разности и поиска changes
    const vals = [];
    for (let i = 0; i < lum.length; i += 3) if (Number.isFinite(lum[i])) vals.push(lum[i]);
    const { med, std } = SW.detect.robustStats(vals);
    const sig = lum.map((v) => (v - med) / Math.max(std, 0.5));
    return { image: img, data: sig, order };
  }

  // серый канал SPHEREx → инфракрасная палитра (как на небе)
  function colorize(img, lum) {
    // display stretch: 5th percentile → black, 99.8th → white, asinh in between (faint stars stay visible)
    const s = []; for (let i = 0; i < lum.length; i += 7) if (Number.isFinite(lum[i])) s.push(lum[i]);
    s.sort((a, b) => a - b);
    const lo = s.length ? s[Math.floor(s.length * 0.05)] : 0, hi = s.length ? Math.max(lo + 8, s[Math.floor(s.length * 0.998)]) : 255, k = 6, as = Math.asinh(k);
    const stops = [[0, 1, 1, 5], [0.2, 33, 10, 77], [0.4, 128, 28, 107], [0.62, 224, 82, 56], [0.84, 252, 184, 77], [1, 255, 250, 230]];
    const d = img.data;
    for (let i = 0; i < lum.length; i++) {
      const t = Number.isFinite(lum[i]) ? Math.asinh(Math.min(1, Math.max(0, (lum[i] - lo) / (hi - lo))) * k) / as : 0;
      let j = 0; while (j < stops.length - 2 && t > stops[j + 1][0]) j++;
      const [t0, r0, g0, b0] = stops[j], [t1, r1, g1, b1] = stops[j + 1], f = (t - t0) / (t1 - t0);
      d[i * 4] = r0 + (r1 - r0) * f; d[i * 4 + 1] = g0 + (g1 - g0) * f; d[i * 4 + 2] = b0 + (b1 - b0) * f;
    }
  }

  /** ссылки на оригиналы */
  function links(a, ra, dec, sizeDeg) {
    const out = [];
    if (a.hipsId) {
      const q = `hips=${encodeURIComponent(a.hipsId)}&ra=${ra.toFixed(6)}&dec=${dec.toFixed(6)}&fov=${sizeDeg}&width=1024&height=1024&projection=TAN&coordsys=icrs`;
      out.push({ label: 'FITS (original values)', url: `https://alasky.cds.unistra.fr/hips-image-services/hips2fits?${q}&format=fits` });
      out.push({ label: 'Aladin', url: `https://aladin.cds.unistra.fr/AladinLite/?target=${ra.toFixed(5)}%20${dec.toFixed(5)}&fov=${sizeDeg}&survey=${encodeURIComponent(a.hipsId)}` });
    } else {
      out.push({ label: 'SPHEREx archive · IRSA', url: 'https://irsa.ipac.caltech.edu/Missions/spherex.html' });
      out.push({ label: 'HiPS mosaic', url: a.base });
    }
    return out;
  }

  // colour views for gallery thumbnails
  const EXTRA = [
    { id: '2mass', name: '2MASS', years: '1997–2001', year: 1999, base: 'https://irsa.ipac.caltech.edu/data/hips/CDS/2MASS/Color', alt: 'https://alasky.cds.unistra.fr/2MASS/Color', fmt: 'jpg', maxOrder: 9, hipsId: 'CDS/P/2MASS/color', lambda: '1.2–2.2 µm' },
    { id: 'spherex', name: 'SPHEREx DR1', years: '2025–2026', year: 2025.9, base: SX, fmt: 'png', maxOrder: 5, cube: true, mono: true, lambdaUm: 1.1, lambda: '1.1 µm' },
  ];
  SW.hipscut = { ARCHIVES, ALL: ARCHIVES.concat(EXTRA), cut, links, nearestChannel };
})();
