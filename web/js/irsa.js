/* Прямой доступ браузера к архиву NASA/IPAC IRSA: поиск всех images SPHEREx точки неба (TAP/ADQL),
 * загрузка маленьких вырезок FITS, совмещение на общей сетке и сверка с NASA JPL.
 * Никакого сервера: если архив разрешает зAprосы с сайта (CORS), «машина времени» работает для любой точки.
 */
(function () {
  const SW = (window.SW = window.SW || {});
  const IRSA = 'https://irsa.ipac.caltech.edu';
  const PX = 6.15;                 // угловой размер pxеля SPHEREx, ″
  const MISSION_START_MJD = 60796; // 1 May 2025
  const SURVEY_DAYS = 182.625;
  const VISIT_GAP = 20;            // d: разрыв между визитами

  /** Vercel's same-origin proxy, or an optional custom HTTPS proxy. */
  const proxied = (url) => { const p = (SW.store.get('skycam_proxy') || window.SKYCAM_PROXY || '').replace(/\/$/, ''); return p ? `${p}?url=${encodeURIComponent(url)}` : url; };
  let routeOk = SW.store.get('skycam_route'); // 'direct' | 'proxy'
  async function get(url, opts = {}) {
    const routes = [];
    if (proxied(url) !== url) routes.push(['proxy', proxied(url)]);
    routes.push(['direct', url]);
    if (routeOk) routes.sort((a, b) => (b[0] === routeOk) - (a[0] === routeOk));
    let last;
    for (const [name, u] of routes) {
      try {
        const r = await fetch(u, opts);
        if (r.ok || (name === 'direct' && r.status >= 400 && r.status < 500)) { if (r.ok && routeOk !== name) { routeOk = name; SW.store.set('skycam_route', name); } return r; }
        last = new Error(`${name} ${r.status}`);
      } catch (e) { if (opts.signal && opts.signal.aborted) throw e; last = e; }
    }
    throw last || new Error('fetch');
  }
  SW.irsaRoute = () => routeOk || '—';
  SW.irsaProxy = proxied;

  function parseCSV(text) {
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
      else if (c === '"') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    const head = rows.shift() || [];
    return rows.filter((r) => r.length === head.length).map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i]])));
  }

  async function observations(ra, dec, band, signal) {
    const adql = `SELECT a.uri, p.time_bounds_lower FROM spherex.artifact a JOIN spherex.plane p ON a.planeid = p.planeid ` +
      `WHERE 1 = CONTAINS(POINT('ICRS', ${ra.toFixed(6)}, ${dec.toFixed(6)}), p.poly) AND p.energy_bandpassname = 'SPHEREx-${band}' ORDER BY p.time_bounds_lower`;
    const body = new URLSearchParams({ REQUEST: 'doQuery', LANG: 'ADQL', FORMAT: 'csv', QUERY: adql });
    const r = await get(`${IRSA}/TAP/sync?${body}`, { signal });
    if (!r.ok) throw new Error(`IRSA TAP answered ${r.status}`);
    const rows = parseCSV(await r.text());
    const byTime = new Map();
    for (const row of rows) {
      let uri = (row.uri || '').trim().replace(/^\/+/, '');
      const mjd = parseFloat(row.time_bounds_lower);
      if (!uri.toLowerCase().endsWith('.fits') || !Number.isFinite(mjd)) continue;
      if (uri.startsWith(IRSA)) uri = uri.slice(IRSA.length + 1);
      const key = Math.round(mjd * 86400);
      const prev = byTime.get(key);
      if (!prev || (/dr1/i.test(uri) && !/dr1/i.test(prev.uri))) byTime.set(key, { uri, mjd });
    }
    const obs = [...byTime.values()].sort((a, b) => a.mjd - b.mjd);
    let visit = -1, last = null;
    for (const o of obs) {
      if (last == null || o.mjd - last > VISIT_GAP) visit++;
      o.visit = visit;
      o.survey = Math.max(1, Math.floor((o.mjd - MISSION_START_MJD) / SURVEY_DAYS) + 1);
      last = o.mjd;
    }
    return obs;
  }

  function choose(obs, maxFrames = 24, perVisit = 4) {
    const visits = new Map();
    obs.forEach((o) => { if (!visits.has(o.visit)) visits.set(o.visit, []); visits.get(o.visit).push(o); });
    let keys = [...visits.keys()];
    const per = Math.max(1, Math.min(perVisit, Math.floor(maxFrames / Math.max(1, keys.length))));
    if (keys.length * per > maxFrames) {
      const m = Math.max(2, Math.floor(maxFrames / per));
      keys = [...new Set(Array.from({ length: m }, (_, i) => keys[Math.round((i * (keys.length - 1)) / (m - 1))]))];
    }
    const out = [];
    keys.forEach((k) => {
      const v = visits.get(k);
      if (v.length <= per) out.push(...v);
      else for (let i = 0; i < per; i++) out.push(v[Math.round((i * (v.length - 1)) / Math.max(1, per - 1))]);
    });
    return [...new Set(out)].sort((a, b) => a.mjd - b.mjd).slice(0, maxFrames);
  }

  async function frame(o, ra, dec, size, n, grid, signal) {
    const url = `${IRSA}/${o.uri}?center=${ra.toFixed(6)},${dec.toFixed(6)}d&size=${(size * 1.5).toFixed(4)}`;
    const r = await get(url, { signal });
    if (!r.ok) throw new Error(`cutout ${r.status}`);
    const hdus = SW.fits.parseFITS(await r.arrayBuffer());
    const img = hdus.find((h) => h.header.EXTNAME === 'IMAGE' && h.data) || hdus.find((h) => h.data);
    if (!img) throw new Error('no image in the file');
    const zodi = hdus.find((h) => h.header.EXTNAME === 'ZODI' && h.data && h.data.length === img.data.length);
    const data = zodi ? img.data.map((v, i) => v - zodi.data[i]) : img.data;
    const rp = SW.fits.reproject(data, img.width, img.height, SW.fits.makeWCS(img.header), grid, n);
    if (rp.validFraction < 0.6) return null;
    const vals = [];
    for (let i = 0; i < rp.data.length; i += 2) if (Number.isFinite(rp.data[i])) vals.push(rp.data[i]);
    const { med, std } = SW.detect.robustStats(vals);
    const sig = rp.data.map((v) => (v - med) / std);
    const prim = hdus[0].header;
    const mjd = img.header['MJD-AVG'] ?? prim['MJD-AVG'] ?? img.header['MJD-OBS'] ?? prim['MJD-OBS'] ?? o.mjd;
    return { mjd: +mjd, visit: o.visit, survey: o.survey, uri: o.uri, wavelength_um: null, valid_fraction: rp.validFraction, data: sig, known: [] };
  }

  function sexa(v, hours) {
    const sign = v < 0 ? 'M' : '';
    let t = Math.round((Math.abs(v) / (hours ? 15 : 1)) * 360000) / 100;
    if (hours) t %= 86400;
    const d = Math.floor(t / 3600), m = Math.floor((t - d * 3600) / 60), s = t - d * 3600 - m * 60;
    return `${sign}${String(d).padStart(2, '0')}-${String(m).padStart(2, '0')}-${s.toFixed(2).padStart(5, '0')}`;
  }
  async function known(ra, dec, half, mjd, signal) {
    const p = new URLSearchParams({
      xobs: '0,0,0', 'obs-time': (mjd + 2400000.5).toFixed(6), 'fov-ra-center': sexa(ra, true), 'fov-dec-center': sexa(dec, false),
      'fov-ra-hwidth': (half / Math.max(0.05, Math.cos((dec * Math.PI) / 180))).toFixed(4), 'fov-dec-hwidth': half.toFixed(4),
      'two-pass': 'true', 'suppress-first-pass': 'true', 'mag-required': 'false', 'vmag-lim': '22',
    });
    const r = await get(`https://ssd-api.jpl.nasa.gov/sb_ident.api?${p}`, { signal });
    if (!r.ok) return [];
    const js = await r.json();
    const f = js.fields_second || js.fields_first || [], rows = js.data_second_pass || js.data_first_pass || [];
    const col = (pre) => f.findIndex((x) => x.startsWith(pre));
    const iN = col('Object name'), iR = col('Astrometric RA'), iD = col('Astrometric Dec'), iV = col('Visual magnitude');
    return rows.map((row) => {
      const [h, m, s] = row[iR].split(':').map(Number);
      const dm = row[iD].match(/([+-]?)\s*(\d+)\s+(\d+)'\s*([\d.]+)/);
      if (!dm) return null;
      const de = (dm[1] === '-' ? -1 : 1) * (+dm[2] + dm[3] / 60 + dm[4] / 3600);
      return { name: row[iN].trim(), ra: (h + m / 60 + s / 3600) * 15, dec: de, vmag: iV >= 0 ? +row[iV] : null };
    }).filter(Boolean);
  }

  /** собрать поле для точки неба; onProgress(text, fraction) */
  async function buildField({ ra, dec, band = 'D1', size = 0.2, maxFrames = 24 }, onProgress = () => {}, signal) {
    onProgress('Looking for every image of this point in the IRSA archive…', 0.05);
    const obs = await observations(ra, dec, band, signal);
    if (!obs.length) throw new Error('The archive has no images of this point in the selected detector yet.');
    const pick = choose(obs, maxFrames);
    const n = Math.max(16, Math.min(400, Math.ceil((size * 3600) / PX)));
    const grid = SW.fits.gridToSky(ra, dec, n, PX);
    const frames = [];
    let done = 0;
    const queue = pick.slice();
    const worker = async () => {
      while (queue.length) {
        const o = queue.shift();
        try { const f = await frame(o, ra, dec, size, n, grid, signal); if (f) frames.push(f); } catch (e) { if (signal && signal.aborted) throw e; }
        done++;
        onProgress(`Downloading and aligning images: ${done}  of ${pick.length} (total in archive ${obs.length})`, 0.1 + 0.8 * (done / pick.length));
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    if (frames.length < 2) throw new Error('Could not get at least two usable images.');
    frames.sort((a, b) => a.mjd - b.mjd);
    const remap = new Map([...new Set(frames.map((f) => f.visit))].map((v, i) => [v, i]));
    frames.forEach((f, i) => { f.visit = remap.get(f.visit); f.i = i; });
    onProgress('Checking the NASA JPL small-body catalogue…', 0.94);
    // известные тела — для первого и последнего снимка каждого визита
    const toCheck = [...new Set([...remap.values()].flatMap((v) => { const fv = frames.filter((f) => f.visit === v); return [fv[0], fv[fv.length - 1]]; }))];
    await Promise.all(toCheck.map(async (f) => {
      try {
        const list = await known(ra, dec, size / 2, f.mjd, signal);
        f.known = list.map((k) => ({ ...k, ...skyToGrid(k.ra, k.dec, ra, dec, n) })).filter((k) => k.x >= 0 && k.y >= 0 && k.x < n && k.y < n);
      } catch (_) { /* JPL недоступен */ }
    }));
    return {
      id: `live-${ra.toFixed(3)}-${dec.toFixed(3)}-${band}`, name: `Point ${SW.astro.fmtRA(ra)} ${SW.astro.fmtDec(dec)}`,
      ra, dec, band, size, n, pixel_scale_arcsec: PX, frames, visits: remap.size, total_available: obs.length, source: 'IRSA (directly from the browser)',
    };
  }

  function skyToGrid(ra, dec, ra0d, de0d, n) {
    const D = Math.PI / 180, a = ra * D, d = dec * D, a0 = ra0d * D, d0 = de0d * D, s = (PX / 3600) * D, c = (n - 1) / 2;
    const cosc = Math.sin(d) * Math.sin(d0) + Math.cos(d) * Math.cos(d0) * Math.cos(a - a0);
    const xi = (Math.cos(d) * Math.sin(a - a0)) / cosc, eta = (Math.sin(d) * Math.cos(d0) - Math.cos(d) * Math.sin(d0) * Math.cos(a - a0)) / cosc;
    return { x: c - xi / s, y: c - eta / s };
  }

  /** по одному свежему снимку в каждом детекторе D1…D6 (режим «All 6 детекторов») */
  async function perDetector({ ra, dec, size = 0.2 }, onProgress = () => {}, signal) {
    const n = Math.max(16, Math.min(400, Math.ceil((size * 3600) / PX)));
    const grid = SW.fits.gridToSky(ra, dec, n, PX);
    const out = [];
    let done = 0;
    await Promise.all(['D1', 'D2', 'D3', 'D4', 'D5', 'D6'].map(async (band) => {
      try {
        const obs = await observations(ra, dec, band, signal);
        for (const o of obs.slice().reverse().slice(0, 3)) {
          const f = await frame(o, ra, dec, size, n, grid, signal);
          if (f) { out.push({ ...f, band }); break; }
        }
      } catch (e) { if (signal && signal.aborted) throw e; }
      onProgress(`Detectors: ${++done}  of 6`, done / 6);
    }));
    out.sort((a, b) => a.band.localeCompare(b.band));
    return { ra, dec, size, n, pixel_scale_arcsec: PX, frames: out };
  }

  SW.irsa = { observations, buildField, perDetector, choose, skyToGrid, parseCSV };
})();
