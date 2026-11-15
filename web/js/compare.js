/* SpaceCam · Compare: всё о том, как меняется один участок неба.
 * Sourceи: снимки SPHEREx по визитам (IRSA, детектор Auto/D1…D6 или «все 6»), готовые поля конвейера
 * и архивы за 40 лет (DSS2, 2MASS, AllWISE, Pan-STARRS, SPHEREx DR1).
 * Режимы: мигание, шторка, разность, стек (обычный и по движению), след, анимация, все снимки.
 * Инструменты: масштаб и сдвиг, сетка RA/Dec и pxелей, слежение за объектом, кривая блеска, спектр,
 * speed и нAprавление, поиск changes с подписями, оригиналы FITS, сохранённые места, ссылка. */
(function () {
  const SW = (window.SW = window.SW || {});
  const $ = (s, r) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const SIZES = [[0.05, '3′'], [0.1, '6′'], [0.2, '12′'], [0.5, '30′'], [1, '1°']];
  const BANDS = [['auto', 'Auto'], ['D1', 'D1'], ['D2', 'D2'], ['D3', 'D3'], ['D4', 'D4'], ['D5', 'D5'], ['D6', 'D6'], ['all6', 'All 6']];
  const MODES = [['side', 'Side by side'], ['blink', 'Blink'], ['swipe', 'Swipe'], ['diff', 'Difference'], ['stack', 'Stack'], ['trail', 'Trail'], ['flip', 'Animation'], ['grid', 'All']];
  const mjdToYear = (m) => 2000 + (m - 51544.5) / 365.25;
  const V = () => SW.cmpView;

  SW.createCompare = function (root, { scene, toast, getFrame }) {
    const A = SW.astro, DT = SW.detect, TR = SW.track;
    const st = {
      t: null, size: 0.2, band: 'auto', frames: [], a: 0, b: 1, mode: 'side', showB: false, split: 0.5, flip: 0, timer: null, speed: 650,
      thr: 6, minArea: 2, cands: [], dr: null, sel: -1, job: 0, abort: null, fieldsIndex: [], userPicked: false, scale: null,
      use: { spherex: true, archive: true }, view: { z: 1, cx: 0.5, cy: 0.5 },
      disp: { stretch: 'asinh', palette: 'ir', white: 99.7, smooth: 0 }, ov: { grid: false, pix: false, cand: true, known: true },
      arm: false, track: null, trackScope: null, mot: null, stackMove: false, tab: 'changes',
    };

    root.innerHTML = `
      <div class="cmp-top">
        <div class="cmp-id"><span class="k">Compare</span><b class="cmp-name">—</b><span class="cmp-co mono"></span></div>
        <div class="seg-s cmp-band" title="SPHEREx detector">${BANDS.map(([v, l]) => `<button data-b="${v}">${l}</button>`).join('')}</div>
        <div class="seg-s cmp-size" title="Field size">${SIZES.map(([v, l]) => `<button data-s="${v}">${l}</button>`).join('')}</div>
        <div class="cmp-nav" title="Move the field"><button data-d="n">↑</button><button data-d="e">←</button><button data-d="s">↓</button><button data-d="w">→</button></div>
        <button class="tb cmp-save" title="Remember place and settings">☆ Save</button>
        <button class="tb cmp-share">Share</button>
        <button class="cmp-close" aria-label="Close">✕</button>
      </div>
      <div class="cmp-body">
        <div class="cmp-main">
          <div class="cmp-row">
            <div class="seg-s cmp-scale"><button data-sc="pass">Within a pass</button><button data-sc="passes">Between passes</button><button data-sc="decades">40 years of archives</button></div>
            <div class="seg-s cmp-modes">${MODES.map(([m, l]) => `<button data-m="${m}">${l}</button>`).join('')}</div>
          </div>
          <div class="cmp-stage">
            <canvas width="900" height="900"></canvas>
            <div class="cmp-stamp mono"></div><div class="cmp-wait"></div>
            <div class="cmp-tools">
              <button data-t="zin" title="Zoom in (+)">＋</button><button data-t="zout" title="Zoom out (−)">－</button><button data-t="zreset" title="Reset (0)">⟲</button>
              <button data-t="grid" title="RA/Dec grid (G)">⌗</button><button data-t="pix" title="Pixel grid">▦</button>
              <button data-t="arm" title="Mark an object and track it (M)">◎</button>
            </div>
          </div>
          <div class="cmp-transport">
            <button data-p="prev" title="Previous (←)">◀</button><button data-p="play" title="Play/pause (space)">⏯</button><button data-p="next" title="Next (→)">▶</button>
            <label class="mono">Speed <input type="range" class="cmp-speed" min="334" max="1600" step="10" value="650" /></label>
            <span class="cmp-src"><label><input type="checkbox" data-u="spherex" checked /> SPHEREx</label><label><input type="checkbox" data-u="archive" checked /> Archives</label><label title="Average all frames of one visit into one deeper image"><input type="checkbox" class="cmp-vs" /> Stack per visit</label></span>
          </div>
          <div class="cmp-strip"></div>
          <div class="cmp-status mono"></div>
        </div>
        <aside class="cmp-side">
          <div class="seg-s cmp-tabs"><button data-tab="changes">Changes</button><button data-tab="object">Object</button><button data-tab="frame">Image</button><button data-tab="settings">View</button><button data-tab="places">Places</button></div>
          <div class="cmp-pane"></div>
        </aside>
      </div>`;
    const canvas = $('canvas', root), ctx = canvas.getContext('2d');
    const pane = $('.cmp-pane', root);

    // ---------- элементы управления ----------
    $('.cmp-close', root).onclick = close;
    root.querySelectorAll('.cmp-size button').forEach((b) => (b.onclick = () => { st.size = +b.dataset.s; if (st.t) open(st.t, { keep: true }); }));
    root.querySelectorAll('.cmp-band button').forEach((b) => (b.onclick = () => { st.band = b.dataset.b; mark(); loadSpherex(st.job); }));
    root.querySelectorAll('.cmp-modes button').forEach((b) => (b.onclick = () => setMode(b.dataset.m)));
    root.querySelectorAll('.cmp-scale button').forEach((b) => (b.onclick = () => pickScale(b.dataset.sc)));
    root.querySelectorAll('.cmp-nav button').forEach((b) => (b.onclick = () => nudge(b.dataset.d)));
    root.querySelectorAll('.cmp-tabs button').forEach((b) => (b.onclick = () => { st.tab = b.dataset.tab; renderSide(); }));
    root.querySelectorAll('.cmp-src input').forEach((c) => (c.onchange = () => { st.use[c.dataset.u] = c.checked; st.userPicked = false; refreshFrames(); }));
    root.querySelectorAll('.cmp-tools button').forEach((b) => (b.onclick = () => tool(b.dataset.t)));
    root.querySelectorAll('.cmp-transport button').forEach((b) => (b.onclick = () => transport(b.dataset.p)));
    $('.cmp-speed', root).oninput = (e) => { st.speed = Math.max(334, +e.target.value); if (st.timer) setMode(st.mode); };
    $('.cmp-share', root).onclick = share;
    $('.cmp-vs', root).onchange = (e) => { st.visitStack = e.target.checked; st.userPicked = false; refreshFrames(); };
    $('.cmp-save', root).onclick = savePoint;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) st.mode = 'swipe';
    let warned = !!SW.store.get('skycam_blink_ok');

    document.addEventListener('keydown', (e) => {
      if (!root.classList.contains('open') || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      const k = e.key;
      if (k === 'Escape') { if (st.arm) { st.arm = false; mark(); } else close(); }
      else if (k === ' ') { e.preventDefault(); transport('play'); }
      else if (k === 'ArrowRight') { e.preventDefault(); transport('next'); }
      else if (k === 'ArrowLeft') { e.preventDefault(); transport('prev'); }
      else if (k === 'd' || k === 'D' || k === 'в' || k === 'В') setMode(st.mode === 'diff' ? 'blink' : 'diff');
      else if (k === 'm' || k === 'M' || k === 'ь' || k === 'Ь') tool('arm');
      else if (k === 'g' || k === 'G' || k === 'п' || k === 'П') tool('grid');
      else if (k === '+' || k === '=') tool('zin');
      else if (k === '-') tool('zout');
      else if (k === '0') tool('zreset');
    });

    // масштаб и сдвиг мышью / пальцем, клик — отметить объект
    let drag = null;
    canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY }; if (st.mode === 'swipe' && !st.arm) swipe(e); });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag || !(e.buttons & 1)) return;
      if (st.mode === 'swipe' && !st.arm && st.view.z === 1) { swipe(e); return; }
      const r = canvas.getBoundingClientRect(), k = 1 / st.view.z / (st.mode === 'side' ? r.width / 2 : r.width);
      st.view.cx = clampC(st.view.cx - (e.clientX - drag.x) * k); st.view.cy = clampC(st.view.cy - (e.clientY - drag.y) * k);
      drag.x = e.clientX; drag.y = e.clientY; draw();
    });
    canvas.addEventListener('pointerup', (e) => {
      if (!drag) return;
      const moved = Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0); drag = null;
      if (moved > 4) return;
      const r = canvas.getBoundingClientRect(), X = ((e.clientX - r.left) / r.width) * canvas.width, Y = ((e.clientY - r.top) / r.height) * canvas.height;
      const cur = currentFrame();
      if (!cur) return;
      const half = st.mode === 'side', Wd = half ? canvas.width / 2 : canvas.width;
      const [px, py] = V().toPix(st.view, Wd, half ? X % Wd : X, Y, cur.n);
      if (st.arm) startTrack(px, py);
      else {
        // клик по кандидату — выбрать его
        if (st.dr) { const k = st.dr.n / cur.n; const i = st.cands.findIndex((c) => Math.hypot(c.x - px * k, c.y - py * k) < 6 * k); if (i >= 0) { st.sel = i; st.tab = 'changes'; renderSide(); draw(); } }
      }
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect(), fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
      const o = V().win(st.view), px = o.x0 + fx * o.w, py = o.y0 + fy * o.w;
      st.view.z = Math.min(16, Math.max(1, st.view.z * Math.exp(-e.deltaY * 0.0015)));
      const w = 1 / st.view.z; st.view.cx = clampC(px - fx * w + w / 2); st.view.cy = clampC(py - fy * w + w / 2);
      draw();
    }, { passive: false });
    const clampC = (c) => { const h = 0.5 / st.view.z; return Math.min(1 - h, Math.max(h, c)); };
    function swipe(e) { const r = canvas.getBoundingClientRect(); st.split = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); draw(); }
    function tool(t) {
      if (t === 'zin') st.view.z = Math.min(16, st.view.z * 1.6);
      if (t === 'zout') st.view.z = Math.max(1, st.view.z / 1.6);
      if (t === 'zreset') st.view = { z: 1, cx: 0.5, cy: 0.5 };
      st.view.cx = clampC(st.view.cx); st.view.cy = clampC(st.view.cy);
      if (t === 'grid') st.ov.grid = !st.ov.grid;
      if (t === 'pix') st.ov.pix = !st.ov.pix;
      if (t === 'arm') { st.arm = !st.arm; if (st.arm) toast('Click an object in the image: it will be tracked through every frame'); }
      mark(); draw();
    }
    function transport(p) {
      const fr = st.frames;
      if (!fr.length) return;
      if (p === 'play') { if (st.timer) stop(); else setMode(st.mode === 'blink' || st.mode === 'flip' ? st.mode : 'flip'); return; }
      stop();
      if (st.mode !== 'flip') { st.mode = 'flip'; mark(); }
      st.flip = (st.flip + (p === 'next' ? 1 : -1) + fr.length) % fr.length;
      draw(); renderStrip(); if (st.tab === 'frame') renderSide();
    }
    function mark() {
      root.querySelectorAll('.cmp-band button').forEach((b) => b.classList.toggle('on', b.dataset.b === st.band));
      root.querySelectorAll('.cmp-size button').forEach((b) => b.classList.toggle('on', +b.dataset.s === st.size));
      root.querySelectorAll('.cmp-modes button').forEach((b) => b.classList.toggle('on', b.dataset.m === st.mode));
      root.querySelectorAll('.cmp-scale button').forEach((b) => b.classList.toggle('on', b.dataset.sc === st.scale));
      root.querySelectorAll('.cmp-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === st.tab));
      root.querySelectorAll('.cmp-tools button').forEach((b) => b.classList.toggle('on', (b.dataset.t === 'grid' && st.ov.grid) || (b.dataset.t === 'pix' && st.ov.pix) || (b.dataset.t === 'arm' && st.arm)));
      root.querySelector('.cmp-transport [data-p="play"]').classList.toggle('on', !!st.timer);
      canvas.style.cursor = st.arm ? 'crosshair' : st.view.z > 1 ? 'grab' : st.mode === 'swipe' ? 'ew-resize' : 'default';
    }

    fetch('data/fields.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).then((j) => { st.fieldsIndex = (j && j.fields) || []; }).catch(() => {});

    // ---------- данные ----------
    let all = []; // все загруженные кадры; st.frames — отфильтрованные по источникам
    function refreshFrames() {
      const keepA = st.frames[st.a] && st.frames[st.a].key, keepB = st.frames[st.b] && st.frames[st.b].key;
      let list = all.filter((f) => st.use[f.source]);
      if (st.visitStack) {
        const groups = new Map(), rest = [];
        list.forEach((f) => { if (f.source === 'spherex' && f.visit != null) { const k = `${f.band}|${f.visit}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(f); } else rest.push(f); });
        groups.forEach((g) => {
          if (g.length < 2) { rest.push(g[0]); return; }
          const f0 = g[0], mjd = g.reduce((a, f) => a + f.mjd, 0) / g.length;
          rest.push({ ...f0, key: `sxv-${f0.band}-${f0.visit}`, label: `SPHEREx ${f0.band} · visit ${f0.visit + 1}`, sub: `${f0.sub.split(',')[0]} · stack ×${g.length}`, mjd, year: mjdToYear(mjd), data: TR.stack(g), known: [], stackOf: g.length, _c: null, _ck: null });
        });
        list = rest;
      }
      $('.cmp-vs', root).checked = !!st.visitStack;
      st.frames = list.sort((p, q) => p.year - q.year);
      if (st.userPicked) { st.a = Math.max(0, st.frames.findIndex((f) => f.key === keepA)); st.b = Math.max(0, st.frames.findIndex((f) => f.key === keepB)); }
      if (!st.userPicked || st.a === st.b) { st.a = 0; st.b = Math.max(0, st.frames.length - 1); }
      st.flip = Math.min(st.flip, Math.max(0, st.frames.length - 1));
      setTimeout(notify, 0);
      st.stackCache = null;
      renderStrip(); analyse();
      if (!st.timer) setMode(st.mode);
    }
    function srcStatus(id, label, state, note = '') {
      st.src = st.src || {};
      st.src[id] = { label, state, note };
      const box = $('.cmp-status', root);
      const optional = (x) => /Pan-STARRS|SPHEREx visits/.test(x.label);
      box.innerHTML = Object.values(st.src).map((x) => { const cls = x.state === 'fail' && optional(x) ? 'off' : x.state; return `<span class="${cls}" title="${esc(x.note)}">${x.state === 'ok' ? '✓' : x.state === 'fail' ? (optional(x) ? '–' : '✕') : '…'} ${esc(x.label)}</span>`; }).join('') +
        (notify(), '') + (Object.values(st.src).some((x) => x.state === 'fail' && /SPHEREx visits/.test(x.label)) ? '<em>Per-visit SPHEREx frames need a proxy (About). Everything else works without it.</em>' : '');
    }
    function addFrames(list) { list.forEach((f) => { if (!all.some((x) => x.key === f.key)) all.push(f); }); refreshFrames(); }
    function removeSource(src) { all = all.filter((f) => f.source !== src); refreshFrames(); }

    async function open(t, { keep = false, silent = false } = {}) {
      st.silent = silent;
      if (!keep) { if (t.size) st.size = t.size; if (t.band) st.band = t.band; }
      st.t = { ...t };
      const job = ++st.job;
      if (st.abort) st.abort.abort();
      st.abort = new AbortController();
      if (!silent) { root.classList.add('open'); document.body.classList.add('cmp-on'); }
      stop(); all = []; st.src = {}; $('.cmp-status', root).innerHTML = ''; st.frames = []; st.cands = []; st.dr = null; st.userPicked = false; st.scale = null; st.track = null; st.mot = null; st.view = { z: 1, cx: 0.5, cy: 0.5 };
      $('.cmp-name', root).textContent = t.name || 'Patch of sky';
      $('.cmp-co', root).textContent = `${A.fmtRA(t.ra)}  ${A.fmtDec(t.dec)}  · sector ${SW.sectors.at(t.ra, t.dec).id}`;
      scene.setField && scene.setField({ ra: t.ra, dec: t.dec, size: st.size, label: t.name ? t.name.toUpperCase() : '' });
      mark(); renderStrip(); renderSide(); wait('Loading images: per-visit SPHEREx and 40 years of archives…'); draw();
      loadArchives(job);
      loadSpherex(job);
    }

    function loadArchives(job) {
      const t = st.t, n = 256, scale = (st.size * 3600) / n;
      SW.hipscut.ARCHIVES.filter((a) => a.decMin == null || t.dec >= a.decMin).forEach((a) => {
        srcStatus(a.id, a.name, 'wait');
        SW.hipscut.cut(a, t.ra, t.dec, n, scale, a.cube && !a.lambdaUm ? getFrame() : 0).then((r) => {
          if (job !== st.job) return;
          srcStatus(a.id, a.name, 'ok');
          addFrames([{
            key: a.id, label: a.name, sub: a.years, year: a.year, mjd: 51544.5 + (a.year - 2000) * 365.25, source: 'archive', match: a.match, lambda: a.cube && !a.lambdaUm ? `${A.SPHEREX_LAMBDA[getFrame()].toFixed(2)} µm` : a.lambda,
            rgb: toCanvas(r.image), data: r.data, n, scale, links: SW.hipscut.links(a, t.ra, t.dec, st.size), known: [],
          }]);
          if (st.frames.length && !st.scale && !all.some((f) => f.source === 'spherex')) wait('');
          if (!st.userPicked && !all.some((f) => f.source === 'spherex') && ['K', 'W2', 'W1'].some((m) => all.some((f) => f.match === m && f.year < 2020) && all.some((f) => f.match === m && f.year > 2020))) pickScale('decades', true);
        }).catch((e) => { if (job === st.job) srcStatus(a.id, a.name, 'fail', e.message); });
      });
    }

    async function loadSpherex(job) {
      removeSource('spherex');
      const t = st.t, band = st.band === 'auto' ? (t.band || 'D1') : st.band;
      const lbl = `SPHEREx visits · ${st.band === 'all6' ? 'D1–D6' : band}`;
      srcStatus('sx', lbl, 'wait');
      try {
        if (st.band === 'all6') {
          const man = await SW.irsa.perDetector({ ra: t.ra, dec: t.dec, size: Math.min(st.size, 0.5) }, (txt) => wait(txt), st.abort.signal);
          if (job !== st.job) return;
          if (!man.frames.length) throw new Error('No images of this point');
          srcStatus('sx', lbl, 'ok', `${man.frames.length} frames`);
          addFrames(man.frames.map((f) => spherexFrame(man, f, 'IRSA', `${f.band} · ${A.BANDS.find((b) => b.id === f.band).min}–${A.BANDS.find((b) => b.id === f.band).max} µm`)));
          st.use.archive = false; root.querySelector('.cmp-src [data-u="archive"]').checked = false; refreshFrames();
          setMode('flip'); wait('');
          return;
        }
        const man = await SW.irsa.buildField({ ra: t.ra, dec: t.dec, band, size: Math.min(st.size, 0.5), maxFrames: 30 }, (txt) => wait(txt), st.abort.signal);
        if (job !== st.job) return;
        srcStatus('sx', lbl, 'ok', `${man.frames.length} frames`);
        addFrames(man.frames.map((f) => spherexFrame(man, f, 'IRSA')));
        pickScale(new Set(man.frames.map((f) => f.visit)).size > 1 ? 'passes' : 'pass', true);
        wait('');
      } catch (e) {
        if (e.name === 'AbortError' || job !== st.job) return;
        if (await pipelineFrames(job)) { srcStatus('sx', `${lbl} (pipeline)`, 'ok'); wait(''); return; }
        srcStatus('sx', lbl, 'fail', e.message);
        wait('');
        if (!st.frames.length) wait('Images did not load: no network, or the archive refused the request from this page. Check: About → Check connection to the archives.');
        else toast(/fetch|network|load failed/i.test(e.message) ? 'Per-visit SPHEREx images are not reachable from this page (IRSA refused the request). Showing 40 years of archives.' : e.message);
      }
    }
    async function pipelineFrames(job) {
      const t = st.t;
      const f = st.fieldsIndex.find((x) => Math.hypot((x.ra - t.ra) * Math.cos((t.dec * Math.PI) / 180), x.dec - t.dec) < 0.03);
      if (!f) return false;
      try {
        const man = await (await fetch(`data/fields/${f.id}/manifest.json`)).json();
        const frames = await Promise.all(man.frames.map(async (fr) => ({ ...fr, band: man.band, data: new Float32Array(await (await fetch(`data/fields/${man.id}/${fr.file}`)).arrayBuffer()) })));
        if (job !== st.job) return true;
        addFrames(frames.map((fr) => spherexFrame(man, fr, 'SpaceCam pipeline')));
        pickScale(new Set(frames.map((x) => x.visit)).size > 1 ? 'passes' : 'pass', true);
        return true;
      } catch (_) { return false; }
    }
    function spherexFrame(man, f, via, lambdaText) {
      const d = new Date((f.mjd - 40587) * 86400000), band = f.band || man.band;
      return {
        key: `sx-${band}-${f.mjd}`, label: `SPHEREx ${band}`, sub: A.fmtDate(d, true), year: mjdToYear(f.mjd), mjd: f.mjd, visit: f.visit, survey: f.survey, band,
        source: 'spherex', lambda: lambdaText || (f.wavelength_um ? `${f.wavelength_um.toFixed(3)} µm` : (() => { const b = A.BANDS.find((x) => x.id === band); return b ? `${b.min}–${b.max} µm` : ''; })()), wavelength_um: f.wavelength_um,
        data: f.data, n: man.n, scale: man.pixel_scale_arcsec, known: f.known || [], valid: f.valid_fraction, via,
        links: f.uri ? [{ label: 'Original FITS · IRSA', url: `https://irsa.ipac.caltech.edu/${f.uri}` }, { label: 'FITS cutout', url: `https://irsa.ipac.caltech.edu/${f.uri}?center=${man.ra.toFixed(6)},${man.dec.toFixed(6)}d&size=${man.size}` }] : [],
      };
    }

    // ---------- отображение кадров ----------
    function hiFor(src) {
      const key = `${src}|${st.disp.white}|${st.disp.smooth}`;
      st.hiCache = st.hiCache || {};
      if (st.hiCache[key] == null) {
        const s = []; st.frames.filter((f) => f.source === src).forEach((f) => { for (let i = 0; i < f.data.length; i += 5) s.push(f.data[i]); });
        st.hiCache[key] = DT.percentile(s, st.disp.white);
      }
      return st.hiCache[key];
    }
    function canvasOf(f) {
      if (f.source === 'archive' && f.rgb && st.disp.palette === 'ir' && st.disp.stretch === 'asinh' && !st.disp.smooth) return f.rgb;
      const key = `${st.disp.stretch}|${st.disp.palette}|${st.disp.white}|${st.disp.smooth}`;
      if (f._ck !== key) { f._c = toCanvas(DT.renderImage(DT.smooth(f.data, f.n, st.disp.smooth), f.n, { hi: f.source === 'archive' ? DT.percentile(f.data, st.disp.white) : hiFor(f.source), stretch: st.disp.stretch, palette: st.disp.palette })); f._ck = key; }
      return f._c;
    }
    const currentFrame = () => {
      const fr = st.frames;
      if (!fr.length) return null;
      if (st.mode === 'flip') return fr[st.flip];
      if (st.mode === 'blink') return st.showB ? fr[st.b] : fr[st.a];
      return fr[st.a];
    };

    // ---------- масштаб времени, пара A/B ----------
    function pickScale(sc, quiet) {
      const fr = st.frames, sx = fr.map((f, i) => [f, i]).filter(([f]) => f.source === 'spherex'), ar = fr.map((f, i) => [f, i]).filter(([f]) => f.source === 'archive');
      let a = null, b = null;
      const wantStack = sc === 'passes';
      if (!!st.visitStack !== wantStack && all.some((f) => f.source === 'spherex' && f.visit != null)) { st.visitStack = wantStack; st.userPicked = false; refreshFrames(); return pickScale(sc, quiet); }
      if (sc === 'pass' && sx.length >= 2) {
        const byV = new Map(); sx.forEach(([f, i]) => { const v = f.visit ?? 0; if (!byV.has(v)) byV.set(v, []); byV.get(v).push(i); });
        const best = [...byV.values()].sort((p, q) => q.length - p.length)[0];
        if (best.length >= 2) { a = best[0]; b = best[1]; }
      } else if (sc === 'passes' && sx.length >= 2) {
        const first = sx[0], last = sx.find(([f]) => f.visit !== first[0].visit && f.visit === sx[sx.length - 1][0].visit) || sx[sx.length - 1];
        a = first[1]; b = last[1];
      } else if (sc === 'decades' && ar.length >= 2) {
        for (const m of ['K', 'W2', 'W1']) {
          const old = ar.find(([f]) => f.match === m && f.year < 2020), nw = ar.find(([f]) => f.match === m && f.year > 2020);
          if (old && nw) { a = old[1]; b = nw[1]; break; }
        }
        if (a == null) { a = ar[0][1]; b = ar[ar.length - 1][1]; }
      }
      if (a == null || b == null || a === b) { if (!quiet) toast(sc === 'decades' ? 'Need at least two archive images' : 'No per-visit SPHEREx images for this point'); return; }
      st.scale = sc; st.a = a; st.b = b; st.userPicked = true;
      mark(); renderStrip(); analyse(); if (st.mode === 'grid' || st.mode === 'flip') setMode('blink');
    }

    function renderStrip() {
      const box = $('.cmp-strip', root);
      box.innerHTML = '';
      st.frames.forEach((f, i) => {
        const c = document.createElement('div');
        c.className = `cmp-th${i === st.a ? ' a' : ''}${i === st.b ? ' b' : ''}${st.mode === 'flip' && i === st.flip ? ' now' : ''}`;
        const th = document.createElement('canvas'); th.width = th.height = 96;
        th.getContext('2d').drawImage(canvasOf(f), 0, 0, 96, 96);
        c.appendChild(th);
        c.insertAdjacentHTML('beforeend', `<span class="y mono">${f.source === 'spherex' ? esc(f.sub.split(',')[0]) : Math.round(f.year)}</span><span class="l">${esc(f.label)}</span><span class="badge">${i === st.a ? 'A' : i === st.b ? 'B' : ''}</span>`);
        c.title = `${f.label} · ${f.sub} · ${f.lambda || ''}`;
        c.onclick = (e) => {
          st.userPicked = true; st.scale = null;
          if (e.shiftKey || e.altKey) { if (i !== st.b) st.a = i; } else if (i !== st.a) st.b = i;
          if (st.mode === 'flip') { st.flip = i; stop(); }
          if (st.mode === 'grid') setMode('blink');
          mark(); renderStrip(); analyse();
        };
        box.appendChild(c);
      });
    }

    // ---------- анализ ----------
    function resample(src, from, to) {
      if (from === to) return src;
      const out = new Float32Array(to * to), k = from / to;
      for (let y = 0; y < to; y++) for (let x = 0; x < to; x++) out[y * to + x] = src[Math.min(from - 1, Math.floor((y + 0.5) * k)) * from + Math.min(from - 1, Math.floor((x + 0.5) * k))];
      return out;
    }
    function analyse() {
      st.cands = []; st.dr = null; st.sel = -1; st.trail = null; st.stackCache = null;
      if (st.frames.length >= 2) {
        const fa = st.frames[st.a], fb = st.frames[st.b], n = Math.max(fa.n, fb.n);
        const a = resample(fa.data, fa.n, n), b = resample(fb.data, fb.n, n);
        try {
          st.dr = DT.difference(a, b, n); st.dr.n = n;
          st.diffCanvas = toCanvas(DT.renderDiff(st.dr, n));
          const scale = (st.size * 3600) / n;
          st.cands = DT.detect(st.dr, a, b, n, { threshold: st.thr, minArea: st.minArea, dtHours: Math.abs(fb.year - fa.year) * 8766, pxArcsec: scale, pairMaxPx: Math.max(6, Math.round(240 / scale)) });
          explain(fa, fb, n);
        } catch (_) { st.dr = null; }
      }
      renderSide(); draw();
    }
    function explain(fa, fb, n) {
      const sameInstr = fa.source === 'spherex' && fb.source === 'spherex';
      st.cands.forEach((c) => {
        let why = null;
        for (const f of [fa, fb]) for (const k of f.known || []) {
          const kx = ((k.x + 0.5) * n) / f.n - 0.5, ky = ((k.y + 0.5) * n) / f.n - 0.5;
          if (Math.hypot(kx - c.x, ky - c.y) <= Math.max(2.5, (2 * n) / f.n)) why = { tag: 'known', text: `Known body: ${k.name}` };
        }
        if (!why) {
          const p = pixToSky(c.x, c.y, n);
          const star = A.OBJECTS.find((o) => /″\/yr/.test(o.type_ru) && Math.hypot((o.ra - p.ra) * Math.cos((o.dec * Math.PI) / 180), o.dec - p.dec) * 3600 < 600);
          if (star) why = { tag: 'pm', text: `Star with large proper motion: ${star.name}` };
        }
        if (!why && c.area <= 1) why = { tag: 'defect', text: 'Likely image defect (single pixel)' };
        if (!why && !sameInstr && c.kind !== 'moving') why = { tag: 'instr', text: 'Probably an instrument or wavelength difference' };
        c.why = why || { tag: 'none', text: 'No explanation — candidate' };
      });
    }
    function pixToSky(x, y, n) {
      const t = st.t, D = Math.PI / 180, s = ((st.size * 3600) / n / 3600) * D, c = (n - 1) / 2;
      const xi = -(x - c) * s, eta = -(y - c) * s, ra0 = t.ra * D, de0 = t.dec * D, den = Math.cos(de0) - eta * Math.sin(de0);
      return { ra: (((ra0 + Math.atan2(xi, den)) / D) % 360 + 360) % 360, dec: Math.atan2(Math.sin(de0) + eta * Math.cos(de0), Math.hypot(xi, den)) / D };
    }

    // ---------- слежение за объектом ----------
    function scopeFrames(ref) {
      // кадры, совместимые с отмеченным: одна сетка; для SPHEREx — тот же детектор
      return st.frames.filter((f) => f.n === ref.n && f.source === ref.source && (f.source !== 'spherex' || f.band === ref.band));
    }
    function startTrack(px, py) {
      const ref = currentFrame();
      const scope = scopeFrames(ref);
      if (scope.length < 2) { toast('Tracking needs at least two frames from the same instrument'); return; }
      const start = scope.indexOf(ref);
      st.track = TR.follow(scope, Math.max(0, start), px, py);
      st.trackScope = scope;
      st.mot = TR.motion(st.track, ref.scale || (st.size * 3600) / ref.n);
      st.arm = false; st.tab = 'object'; st.stackCache = null;
      mark(); renderSide(); draw();
    }

    // ---------- боковая панель ----------
    function renderSide() {
      mark();
      if (st.tab === 'changes') return paneChanges();
      if (st.tab === 'object') return paneObject();
      if (st.tab === 'frame') return paneFrame();
      if (st.tab === 'settings') return paneSettings();
      return panePlaces();
    }
    function paneChanges() {
      if (st.frames.length < 2) { pane.innerHTML = '<p class="muted small">Need at least two images.</p>'; return; }
      const fa = st.frames[st.a], fb = st.frames[st.b], dy = Math.abs(fb.year - fa.year);
      const dt = dy >= 1 ? `${dy.toFixed(1)} yr` : dy * 365.25 >= 2 ? `${(dy * 365.25).toFixed(1)} d` : `${(dy * 8766).toFixed(1)} h`;
      const same = fa.source === 'spherex' && fb.source === 'spherex';
      let h = `<div class="cmp-ab"><div><i class="a"></i><b>A</b> ${esc(fa.label)} <span>${esc(fa.sub)} · ${esc(fa.lambda || '')}</span></div><div><i class="b"></i><b>B</b> ${esc(fb.label)} <span>${esc(fb.sub)} · ${esc(fb.lambda || '')}</span></div></div>`;
      h += `<div class="cmp-stats"><div><b>${dt}</b><span>between A and B</span></div><div><b>${st.cands.length}</b><span>changes</span></div><div><b>${st.dr ? st.dr.k.toFixed(2) : '—'}</b><span>flux scale</span></div></div>`;
      h += `<div class="cmp-filt mono"><label>Threshold <input type="range" data-f="thr" min="3" max="14" step="0.5" value="${st.thr}"><b>${st.thr}σ</b></label><label>Min. size <input type="range" data-f="area" min="1" max="8" step="1" value="${st.minArea}"><b>${st.minArea} px</b></label></div>`;
      h += '<p class="note warn">Detections are candidates, not discoveries: check them by eye with blink and swipe.</p>';
      if (!same) h += '<p class="note">Images from different instruments differ in colour and sharpness. Look for “vanished → appeared” pairs: that is what something that moved looks like.</p>';
      h += '<ol class="cmp-c">';
      st.cands.forEach((c, i) => {
        const p = pixToSky(c.x, c.y, st.dr.n);
        const rate = c.rate ? (!same ? ` · ${(c.rate * 8766).toFixed(1)}″/yr` : ` · ${c.rate.toFixed(1)}″/h`) : '';
        h += `<li data-i="${i}" class="${c.kind}${i === st.sel ? ' on' : ''}"><span class="n">${i + 1}</span><span class="w">${esc(c.label)}${rate}</span><span class="s mono">${c.snr.toFixed(0)}σ</span><span class="p mono">${A.fmtRA(p.ra)} ${A.fmtDec(p.dec)}</span><span class="why ${c.why.tag}">${esc(c.why.text)}</span></li>`;
      });
      h += '</ol>';
      if (same) {
        const known = [...(fa.known || []).map((k) => ({ ...k, e: 'A' })), ...(fb.known || []).map((k) => ({ ...k, e: 'B' }))];
        h += `<h4>Known small bodies · NASA JPL</h4>${known.length ? `<ul class="cmp-k">${known.map((k) => `<li><span>${esc(k.name)}</span><span class="mono">${k.e}${k.vmag != null ? ` · V ${k.vmag}` : ''}</span></li>`).join('')}</ul>` : '<p class="muted small">No known asteroids or comets in the field.</p>'}`;
      }
      pane.innerHTML = h;
      pane.querySelectorAll('.cmp-c li').forEach((li) => (li.onclick = () => {
        st.sel = +li.dataset.i;
        const c = st.cands[st.sel];
        st.view = { z: Math.max(st.view.z, 3), cx: (c.x + 0.5) / st.dr.n, cy: (c.y + 0.5) / st.dr.n }; st.view.cx = clampC(st.view.cx); st.view.cy = clampC(st.view.cy);
        renderSide(); draw();
      }));
      pane.querySelector('[data-f="thr"]').oninput = (e) => { st.thr = +e.target.value; clearTimeout(st.fT); st.fT = setTimeout(analyse, 150); e.target.nextElementSibling.textContent = `${st.thr}σ`; };
      pane.querySelector('[data-f="area"]').oninput = (e) => { st.minArea = +e.target.value; clearTimeout(st.fT); st.fT = setTimeout(analyse, 150); e.target.nextElementSibling.textContent = `${st.minArea} px`; };
    }
    function paneObject() {
      if (!st.track) { pane.innerHTML = '<p class="small">Press <kbd>M</kbd> or ◎ and click an object in the image. SpaceCam finds it in every frame of that instrument, builds a light curve, a spectrum (when wavelengths are known) and measures speed and direction.</p><p class="muted small">Tip: for an asteroid choose “Within a pass”, for a fast star choose “40 years of archives”.</p>'; return; }
      const tr = st.track, m = st.mot, sc = st.trackScope;
      const ok = tr.filter((p) => !p.guess).length;
      let h = `<div class="cmp-stats"><div><b>${ok}/${tr.length}</b><span>frames found</span></div><div><b>${m ? (m.perHour >= 0.5 ? m.perHour.toFixed(1) : m.perYear.toFixed(1)) : '—'}</b><span>${m ? (m.perHour >= 0.5 ? '″/hour' : '″/yr') : 'speed'}</span></div><div><b>${m ? `${m.pa.toFixed(0)}°` : '—'}</b><span>direction (N through E)</span></div></div>`;
      h += '<h4>Light curve</h4>' + V().chart(tr.map((p, i) => ({ x: p.mjd, y: p.flux, label: `${sc[i].sub}: ${p.flux.toFixed(0)}`, on: sc[i] === currentFrame() })), { xLabel: 'date', yLabel: 'flux, σ·px', xFmt: (x) => A.fmtDate(A.mjdToDate(x)).replace(/ \d{4}$/, '') });
      const spec = tr.filter((p) => Number.isFinite(p.wavelength));
      h += '<h4>Spectrum</h4>' + (spec.length >= 2 ? V().chart(spec.map((p) => ({ x: p.wavelength, y: p.flux })), { xLabel: 'wavelength, µm', yLabel: 'flux', xFmt: (x) => x.toFixed(2) }) : '<p class="muted small">Wavelengths are known for pipeline frames (WCS-WAVE layer). For frames loaded in the browser the spectrum is not available yet.</p>');
      h += `<h4>Stack</h4><div class="cmp-btns"><button data-s="mean">Plain stack (stars sharp)</button><button data-s="move" ${m ? '' : 'disabled'}>Stack along the object's motion</button><button data-s="clear">Clear mark</button></div>`;
      pane.innerHTML = h;
      pane.querySelector('[data-s="mean"]').onclick = () => { st.stackMove = false; st.stackCache = null; setMode('stack'); };
      pane.querySelector('[data-s="move"]').onclick = () => { st.stackMove = true; st.stackCache = null; setMode('stack'); };
      pane.querySelector('[data-s="clear"]').onclick = () => { st.track = null; st.mot = null; st.stackMove = false; st.stackCache = null; renderSide(); draw(); };
    }
    function paneFrame() {
      const f = currentFrame();
      if (!f) { pane.innerHTML = '<p class="muted small">No images.</p>'; return; }
      const rows = [['Source', f.label], ['Date', f.sub], ['Wavelength', f.lambda || '—'], ['Survey', f.survey ? `S${f.survey}` : '—'], ['Visit', f.visit != null ? f.visit + 1 : '—'], ['Pixel', `${(f.scale || (st.size * 3600) / f.n).toFixed(2)}″`], ['Coverage', f.valid ? `${Math.round(f.valid * 100)}%` : '—'], ['Obtained', f.via || 'HiPS archive']];
      pane.innerHTML = `<table class="kv">${rows.map(([k, v]) => `<tr><td>${k}</td><td class="mono">${esc(v)}</td></tr>`).join('')}</table><h4>Originals</h4><ul class="cmp-o">${(f.links || []).map((l) => `<li><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)} ↗</a></li>`).join('') || '<li class="muted">—</li>'}</ul><p class="muted tiny">All images are shown north up, east left, with one brightness stretch per instrument.</p>`;
    }
    function paneSettings() {
      const d = st.disp;
      pane.innerHTML = `<div class="set">
        <label>Stretch <select data-k="stretch"><option value="asinh">asinh</option><option value="linear">linear</option><option value="sqrt">square root</option><option value="log">logarithmic</option></select></label>
        <label>Colours <select data-k="palette"><option value="ir">infrared</option><option value="gray">grey</option><option value="cool">cool</option></select></label>
        <label>White point <input type="range" data-k="white" min="97" max="99.95" step="0.05" value="${d.white}"><b>${d.white}%</b></label>
        <label>Smoothing <input type="range" data-k="smooth" min="0" max="3" step="1" value="${d.smooth}"><b>${d.smooth}</b></label>
        <label><input type="checkbox" data-o="grid" ${st.ov.grid ? 'checked' : ''}> RA/Dec grid</label>
        <label><input type="checkbox" data-o="pix" ${st.ov.pix ? 'checked' : ''}> Pixel grid (when zoomed in)</label>
        <label><input type="checkbox" data-o="cand" ${st.ov.cand ? 'checked' : ''}> Candidates on the image</label>
        <label><input type="checkbox" data-o="known" ${st.ov.known ? 'checked' : ''}> Known bodies</label>
      </div><p class="muted tiny">Grey pixels have no data. The stretch is shared by all images of one instrument, so brightness is fairly comparable.</p>`;
      pane.querySelectorAll('select').forEach((s) => { s.value = d[s.dataset.k]; s.onchange = () => { d[s.dataset.k] = s.value; st.hiCache = null; renderStrip(); draw(); }; });
      pane.querySelectorAll('input[type="range"]').forEach((r) => (r.oninput = () => { d[r.dataset.k] = +r.value; r.nextElementSibling.textContent = r.dataset.k === 'white' ? `${r.value}%` : r.value; clearTimeout(st.sT); st.sT = setTimeout(() => { st.hiCache = null; renderStrip(); draw(); }, 120); }));
      pane.querySelectorAll('input[data-o]').forEach((c) => (c.onchange = () => { st.ov[c.dataset.o] = c.checked; mark(); draw(); }));
    }
    const PLACES = ['Barnard', 'Eps Ind B', 'WISE 0855', 'RW Aur', 'R Dra', 'Kapteyn', '61 Cyg', 'Proxima', 'NEP', 'M42'];
    function panePlaces() {
      const saved = JSON.parse(SW.store.get('skycam_points') || '[]');
      const pl = PLACES.map((id) => A.OBJECTS.find((o) => o.id === id)).filter(Boolean);
      pane.innerHTML = `<h4>Examples: what changes</h4><ul class="objlist">${pl.map((o, i) => `<li data-p="${i}"><b>${esc(o.name)}</b><span>${esc(o.type_ru)}</span></li>`).join('')}</ul>
        <h4>Saved places</h4><ul class="objlist">${saved.length ? saved.map((p, i) => `<li data-s="${i}"><b>${esc(p.name || `${A.fmtRA(p.ra)} ${A.fmtDec(p.dec)}`)}</b><span class="mono">${p.size}° · ${p.band} · ${p.mode}</span><span class="acts"><button data-del="${i}">✕</button></span></li>`).join('') : '<li class="muted">Empty for now. “☆ Save” remembers the place, detector and mode.</li>'}</ul>`;
      pane.querySelectorAll('[data-p]').forEach((li) => (li.onclick = () => { const o = pl[+li.dataset.p]; open({ ra: o.ra, dec: o.dec, name: o.name, size: 0.2, band: o.band }); }));
      pane.querySelectorAll('[data-s]').forEach((li) => (li.onclick = (e) => {
        if (e.target.dataset.del != null) { saved.splice(+e.target.dataset.del, 1); SW.store.set('skycam_points', JSON.stringify(saved)); panePlaces(); return; }
        const p = saved[+li.dataset.s]; st.mode = p.mode || st.mode; open({ ra: p.ra, dec: p.dec, name: p.name, size: p.size, band: p.band }); st.band = p.band || 'auto';
      }));
    }
    function savePoint() {
      if (!st.t) return;
      const saved = JSON.parse(SW.store.get('skycam_points') || '[]');
      saved.unshift({ ra: st.t.ra, dec: st.t.dec, name: st.t.name, size: st.size, band: st.band, mode: st.mode });
      SW.store.set('skycam_points', JSON.stringify(saved.slice(0, 40)));
      toast('Place saved: see the Places tab'); if (st.tab === 'places') panePlaces();
    }

    // ---------- режимы и отрисовка ----------
    const subs = [];
    const notify = () => subs.forEach((f) => { try { f(); } catch (_) { /* subscriber error */ } });
    function stop() { if (st.timer) clearInterval(st.timer); st.timer = null; mark(); }
    function setMode(m) {
      stop(); st.mode = m;
      const side = m === 'side'; root.classList.toggle('side', side); if (canvas.width !== (side ? 1800 : 900)) canvas.width = side ? 1800 : 900;
      if (st.frames.length >= 2 && !st.silent) {
        if (m === 'blink') {
          if (!warned) { warned = true; SW.store.set('skycam_blink_ok', '1'); toast('Blinking is limited to three changes per second. If it is unpleasant, switch to Swipe.'); }
          st.timer = setInterval(() => { st.showB = !st.showB; draw(); }, Math.max(334, st.speed));
        }
        if (m === 'flip') st.timer = setInterval(() => { st.flip = (st.flip + 1) % st.frames.length; draw(); root.querySelectorAll('.cmp-th').forEach((el, i) => el.classList.toggle('now', i === st.flip)); }, Math.max(334, st.speed));
      }
      mark(); draw();
    }
    function wait(txt) { const w = $('.cmp-wait', root); w.textContent = txt || ''; w.hidden = !txt; st.waitText = txt || ''; notify(); }

    function stackCanvas() {
      if (st.stackCache) return st.stackCache;
      const ref = st.trackScope ? st.trackScope[0] : st.frames[st.a];
      if (!ref) return null;
      const set = st.trackScope || scopeFrames(ref);
      if (set.length < 2) return null;
      const data = TR.stack(set, st.stackMove ? st.mot : null);
      st.stackCache = { canvas: toCanvas(DT.renderImage(DT.smooth(data, ref.n, st.disp.smooth), ref.n, { stretch: st.disp.stretch, palette: st.disp.palette })), count: set.length, n: ref.n };
      return st.stackCache;
    }
    function trailCanvas() {
      if (st.trail) return st.trail;
      const ref = st.frames[st.a];
      if (!ref) return null;
      const set = st.scale === 'pass' ? scopeFrames(ref).filter((f) => f.visit === ref.visit) : scopeFrames(ref);
      if (set.length < 2) return null;
      const n = ref.n, mx = new Float32Array(n * n).fill(-Infinity);
      set.forEach((f) => { for (let i = 0; i < f.data.length; i++) if (f.data[i] > mx[i]) mx[i] = f.data[i]; });
      for (let i = 0; i < mx.length; i++) if (!Number.isFinite(mx[i])) mx[i] = NaN;
      st.trail = { canvas: toCanvas(DT.renderImage(mx, n, { stretch: st.disp.stretch, palette: st.disp.palette })), count: set.length, n };
      return st.trail;
    }

    function overlays(W, H, cur, nRef, fa, fb) {
      const v = st.view, Vw = V();
      if (st.ov.pix) Vw.pixelGrid(ctx, v, W, nRef);
      if (st.ov.grid && st.t) Vw.grid(ctx, v, W, st.t, st.size);
      // кандидаты
      if (st.ov.cand && st.dr && st.mode !== 'flip' && st.mode !== 'stack') st.cands.forEach((c, i) => {
        const on = i === st.sel, [X, Y] = Vw.toScreen(v, W, c.x, c.y, st.dr.n);
        ctx.strokeStyle = c.sign > 0 ? '#ff7a45' : '#7fb4ff'; ctx.lineWidth = on ? 3 : 1.6;
        ctx.beginPath(); ctx.arc(X, Y, (on ? 20 : 14) * Math.min(2, Math.sqrt(v.z)), 0, Math.PI * 2); ctx.stroke();
        if (c.pair != null && c.sign > 0) { const p = st.cands[c.pair], [px2, py2] = Vw.toScreen(v, W, p.x, p.y, st.dr.n); Vw.arrow(ctx, px2, py2, X, Y, 'rgba(255,170,130,.9)'); }
        ctx.fillStyle = ctx.strokeStyle; ctx.font = '600 15px "IBM Plex Mono", ui-monospace, monospace'; ctx.fillText(String(i + 1), X + 18, Y - 14);
      });
      // известные тела
      if (st.ov.known) [fa, fb].filter(Boolean).forEach((f) => (f.known || []).forEach((o) => {
        if (st.mode === 'blink' && f !== cur) return;
        const [X, Y] = Vw.toScreen(v, W, o.x, o.y, f.n);
        Vw.cross(ctx, X, Y, 12, '#ffd36b');
        ctx.fillStyle = '#ffd36b'; ctx.font = '500 14px "IBM Plex Mono", ui-monospace, monospace'; ctx.fillText(o.name, X + 14, Y + 16);
      }));
      // след отмеченного объекта и стрелка движения
      if (st.track && st.trackScope && st.trackScope[0].n) {
        const n = st.trackScope[0].n, idx = st.trackScope.indexOf(cur);
        ctx.strokeStyle = 'rgba(124,247,212,.55)'; ctx.lineWidth = 1.5; ctx.beginPath();
        st.track.forEach((p, i) => { const [X, Y] = Vw.toScreen(v, W, p.x, p.y, n); if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y); }); ctx.stroke();
        st.track.forEach((p, i) => { const [X, Y] = Vw.toScreen(v, W, p.x, p.y, n); ctx.fillStyle = p.guess ? 'rgba(124,247,212,.35)' : '#7cf7d4'; ctx.beginPath(); ctx.arc(X, Y, i === idx ? 5 : 2.5, 0, Math.PI * 2); ctx.fill(); });
        if (idx >= 0) { const p = st.track[idx], [X, Y] = Vw.toScreen(v, W, p.x, p.y, n); Vw.cross(ctx, X, Y, 16, '#7cf7d4', 2); }
        if (st.mot && st.mode !== 'stack') {
          const m = st.mot, span = Math.max(1, st.trackScope[st.trackScope.length - 1].mjd - st.trackScope[0].mjd);
          const [x1, y1] = Vw.toScreen(v, W, m.x0, m.y0, n), [x2, y2] = Vw.toScreen(v, W, m.x0 + (m.vx * span) / 2, m.y0 + (m.vy * span) / 2, n);
          if (Math.hypot(x2 - x1, y2 - y1) > 12) Vw.arrow(ctx, x1, y1, x2, y2, '#7cf7d4');
        }
      }
      // масштаб и стороны света
      const fovAm = (st.size * 60) / v.z, arc = fovAm >= 10 ? 5 : fovAm >= 2 ? 1 : 0.25, len = (arc / fovAm) * W;
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(W - 24 - len, H - 24); ctx.lineTo(W - 24, H - 24); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = '500 14px ui-monospace, monospace'; ctx.fillText(arc >= 1 ? `${arc}′` : `${arc * 60}″`, W - 24 - len, H - 34);
      ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.fillText('N ↑   E ←', W - 110, 28);
    }
    function draw() {
      const W = canvas.width, H = canvas.height, stamp = $('.cmp-stamp', root), v = st.view, Vw = V();
      ctx.fillStyle = '#010204'; ctx.fillRect(0, 0, W, H);
      ctx.imageSmoothingEnabled = false;
      const fr = st.frames;
      if (!fr.length) { stamp.innerHTML = ''; return; }
      const fa = fr[st.a], fb = fr[Math.min(st.b, fr.length - 1)];
      let cur = currentFrame(), tag = 'A', nRef = cur.n;
      if (st.mode === 'grid') {
        const k = Math.ceil(Math.sqrt(fr.length)), cw = W / k;
        fr.forEach((f, i) => {
          const x = (i % k) * cw, y = Math.floor(i / k) * cw;
          ctx.drawImage(canvasOf(f), x + 2, y + 2, cw - 4, cw - 4);
          ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(x + 2, y + cw - 30, cw - 4, 28);
          ctx.fillStyle = '#fff'; ctx.font = '600 15px "IBM Plex Mono", ui-monospace, monospace';
          ctx.fillText(`${f.source === 'spherex' ? f.sub.split(',')[0] : Math.round(f.year)} · ${f.label}`, x + 10, y + cw - 11);
        });
        stamp.innerHTML = `<b>ALL</b> ${fr.length} images`;
        return;
      }
      if (st.mode === 'side' && fr.length < 2 && canvas.width !== 900) { canvas.width = 900; root.classList.remove('side'); return draw(); }
      if (st.mode === 'side' && fr.length >= 2) {
        if (canvas.width !== 1800) { canvas.width = 1800; root.classList.add('side'); }
        const h = W / 2;
        [[fa, 0, 'A'], [fb, h, 'B']].forEach(([f, x0, L]) => {
          ctx.save(); ctx.translate(x0, 0); ctx.beginPath(); ctx.rect(0, 0, h, H); ctx.clip();
          Vw.blit(ctx, v, canvasOf(f), h, H);
          overlays(h, H, f, f.n, f === fa ? fa : null, f === fb ? fb : null);
          ctx.fillStyle = 'rgba(0,0,0,.66)'; ctx.fillRect(10, 10, h - 20, 40);
          ctx.fillStyle = L === 'A' ? '#7fb4ff' : '#ff7a45'; ctx.font = '700 22px "IBM Plex Mono", ui-monospace, monospace'; ctx.fillText(L, 22, 38);
          ctx.fillStyle = '#fff'; ctx.font = '500 17px "IBM Plex Mono", ui-monospace, monospace'; ctx.fillText(`${f.label} · ${f.sub}`.slice(0, 52), 52, 37);
          ctx.restore();
        });
        ctx.fillStyle = '#000'; ctx.fillRect(h - 2, 0, 4, H);
        stamp.innerHTML = `<b>A │ B</b> ${esc(fa.sub)} → ${esc(fb.sub)} · zoom and pan move both`;
        return;
      }
      if (fr.length === 1) { Vw.blit(ctx, v, canvasOf(cur), W, H); tag = '·'; }
      else if (st.mode === 'blink') { Vw.blit(ctx, v, canvasOf(cur), W, H); tag = st.showB ? 'B' : 'A'; }
      else if (st.mode === 'flip') { Vw.blit(ctx, v, canvasOf(cur), W, H); tag = `${st.flip + 1}/${fr.length}`; }
      else if (st.mode === 'swipe') {
        Vw.blit(ctx, v, canvasOf(fa), W, H);
        const sx = st.split * W;
        ctx.save(); ctx.beginPath(); ctx.rect(sx, 0, W - sx, H); ctx.clip(); Vw.blit(ctx, v, canvasOf(fb), W, H); ctx.restore();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, H); ctx.stroke();
        ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(sx, H / 2, 10, 0, Math.PI * 2); ctx.fill();
        tag = 'A │ B';
      } else if (st.mode === 'diff' && st.diffCanvas) { Vw.blit(ctx, v, st.diffCanvas, W, H); tag = 'B − A'; nRef = st.dr.n; }
      else if (st.mode === 'stack') { const s = stackCanvas(); if (s) { Vw.blit(ctx, v, s.canvas, W, H); tag = `${st.stackMove ? 'STACK ALONG MOTION' : 'STACK'} · ${s.count}`; nRef = s.n; } else { Vw.blit(ctx, v, canvasOf(fa), W, H); tag = 'stack: needs ≥2 frames from one instrument'; } }
      else if (st.mode === 'trail') { const s = trailCanvas(); if (s) { Vw.blit(ctx, v, s.canvas, W, H); tag = `TRAIL · ${s.count}`; nRef = s.n; } else { Vw.blit(ctx, v, canvasOf(fa), W, H); tag = 'trail: needs ≥2 frames from one instrument'; } }
      else Vw.blit(ctx, v, canvasOf(fa), W, H);
      stamp.innerHTML = `<b>${tag}</b> ${esc(cur.label)} · ${esc(cur.sub)}${cur.lambda ? ` · ${esc(cur.lambda)}` : ''}${v.z > 1 ? ` · ×${v.z.toFixed(1)}` : ''}`;

      overlays(W, H, cur, nRef, fa, fb);
      if (st.mode === 'flip') { ctx.fillStyle = 'rgba(255,255,255,.15)'; ctx.fillRect(0, H - 4, W, 4); ctx.fillStyle = '#ff7a45'; ctx.fillRect(0, H - 4, (W * (st.flip + 1)) / fr.length, 4); }
    }
    function toCanvas(img) { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; c.getContext('2d').putImageData(img, 0, 0); return c; }

    // ---------- навигация, ссылка ----------
    function close() { stop(); if (st.abort) st.abort.abort(); root.classList.remove('open'); document.body.classList.remove('cmp-on'); }
    function nudge(dir) {
      if (!st.t) return;
      const d = st.size * 0.9, cd = Math.max(0.05, Math.cos((st.t.dec * Math.PI) / 180)), t = { ...st.t, name: '' };
      if (dir === 'n') t.dec = Math.min(89.9, t.dec + d); if (dir === 's') t.dec = Math.max(-89.9, t.dec - d);
      if (dir === 'e') t.ra = (t.ra + d / cd + 360) % 360; if (dir === 'w') t.ra = (t.ra - d / cd + 360) % 360;
      scene.goto && scene.goto(t.ra, t.dec);
      open(t, { keep: true });
    }
    function share() {
      if (!st.t) return;
      const fa = st.frames[st.a], fb = st.frames[st.b];
      const base = /^https?:/.test(location.href) ? location.href.split('#')[0] : 'https://shamsiddinchess-web.github.io/spherex-skywatch/';
      const url = `${base}#cmp=${st.t.ra.toFixed(5)},${st.t.dec.toFixed(5)},${st.size}${st.t.name ? `&name=${encodeURIComponent(st.t.name)}` : ''}&det=${st.band}&m=${st.mode}${fa ? `&a=${encodeURIComponent(fa.key)}` : ''}${fb ? `&b=${encodeURIComponent(fb.key)}` : ''}`;
      SW.setURL(url.slice(url.indexOf('#')));
      SW.copy(url).then(() => toast('Link to this comparison copied'), () => toast(url));
    }
    function applyState(p) {
      if (p.m) setMode(p.m);
      const ia = st.frames.findIndex((f) => f.key === p.a), ib = st.frames.findIndex((f) => f.key === p.b);
      if (ia >= 0) st.a = ia; if (ib >= 0) st.b = ib;
      if (ia >= 0 || ib >= 0) st.userPicked = true;
      renderStrip(); analyse();
    }

    setMode(st.mode);
    function show() { st.silent = false; root.classList.add('open'); document.body.classList.add('cmp-on'); mark(); renderStrip(); renderSide(); setMode(st.mode); }
    return {
      open, close, applyState, show,
      get isOpen() { return root.classList.contains('open'); },
      subscribe(f) { subs.push(f); },
      frames: () => st.frames, canvasOf, pair: () => ({ a: st.a, b: st.b }), diff: () => st.diffCanvas || null,
      status: () => ({ src: Object.values(st.src || {}), wait: st.waitText || '' }), target: () => st.t, band: () => st.band,
      setBand(b) { st.band = b; mark(); if (st.t) loadSpherex(st.job); },
      setMode(m) { setMode(m); },
    };
  };
})();
