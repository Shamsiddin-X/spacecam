/* SpaceCam · интерфейс: шапка со всеми инструментами, выбор и переходы между секторами,
 * участки на небе, поиск с подсказками, слои, снимки и длины волн, миссия, ссылки на вид. */
(function () {
  const SW = window.SW, A = SW.astro, SEC = SW.sectors;
  const $ = (id) => document.getElementById(id);
  const body = document.body;
  const startup = SW.createStartup($('startup'), $('app'));
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let toastT = null;
  const toast = (m) => { const t = $('toast'); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 4200); };
  const progress = (f) => { $('load').firstElementChild.style.width = `${Math.round(f * 100)}%`; $('load').classList.toggle('done', f >= 1); };

  // ---------- сцена ----------
  let scene;
  try {
    scene = SW.createScene($('gl'), $('ov'), {
      onView: (v) => { $('r-center').textContent = `${A.fmtRA(v.ra)} ${A.fmtDec(v.dec)} · ${SEC.at(v.ra, v.dec).id}`; $('r-fov').textContent = v.fov >= 1 ? `${v.fov.toFixed(1)}°` : `${(v.fov * 60).toFixed(1)}′`; schedHash(); },
      onHover: (p) => { $('r-hover').textContent = p ? `${A.fmtRA(p.ra)} ${A.fmtDec(p.dec)}` : '—'; },
      onSector: (s) => selectSector(s),
      onDive: (p) => enterSky(p.ra, p.dec, 30),
      onPick: (p) => (p.mode === 'sky' ? pickInSky(p) : enterSky(p.ra, p.dec, 30)),
      onPin: () => {},
    });
  } catch (e) {
    body.classList.add('no-gl');
    startup.fail();
    console.error('Scene initialization failed', e);
    return;
  }
  scene.setActive(false);
  let frame = 0;
  const cmp = SW.createCompare($('cmp'), { scene, toast, getFrame: () => frame });
  const inset = SW.createInset($('inset'), { scene, cmp });
  const gal = SW.createGallery($('gal'), { getFrame: () => frame, onSky: (o) => goObject(o), onCompare: (o) => compareObject(o) });

  // небо: SPHEREx DR1, при недоступности IRSA — AllWISE
  progress(0.25);
  let first = true, bootSky = null;
  scene.hips.onChange((ev) => {
    if (ev.type === 'loading') { progress(0.4); $('load').classList.remove('done'); }
    if (ev.type === 'ready') {
      progress(1); $('img-name').textContent = ev.survey.name; markSurvey(ev.survey.id); first = false;
      if (bootSky) { bootSky.resolve(); bootSky = null; }
    }
    if (ev.type === 'error') {
      if (ev.survey.id === 'spherex' && scene.hips.frame > 0) { toast('This cube channel is not available yet, showing 0.753 µm'); setFrame(0); return; }
      if (ev.survey.id === 'spherex' && first) { scene.hips.set('allwise'); return; }
      progress(1);
      if (bootSky) { first = false; $('img-name').textContent = 'offline'; bootSky.reject(ev.error); bootSky = null; }
      else if (first) { first = false; $('img-name').textContent = 'offline'; toast('Sky archives are unreachable: no network. Earth and the grid work; images load once you are online.'); }
      else toast(`${ev.survey.name}: the archive did not answer`);
    }
  });
  startup.start({
    day: () => scene.loadEarthTexture('day'),
    night: () => scene.loadEarthTexture('night'),
    sky: () => new Promise((resolve, reject) => { first = true; bootSky = { resolve, reject }; scene.hips.set('spherex', frame); }),
  });
  startup.ready.then(() => { scene.setActive(true); scene.intro(); setHint('earth'); });

  // ---------- режимы Earth / Sky ----------
  let busy = false, lastSky = { ra: 83.8221, dec: -5.3911, fov: 30 };
  function setView(v) {
    $('views').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
    body.classList.toggle('sky', v === 'sky');
    setHint(v);
  }
  function enterSky(ra, dec, fov = 30, then) {
    if (scene.mode === 'sky') { scene.goto(ra, dec, fov); then && then(); return; }
    if (busy) return;
    busy = true; stopPlay(); closeSector(false);
    body.classList.add('diving');
    scene.enterSky(ra, dec, fov, () => { busy = false; body.classList.remove('diving'); setView('sky'); schedHash(); then && then(); });
  }
  function exitSky() {
    if (scene.mode !== 'sky' || busy) return;
    busy = true; lastSky = scene.view(); clearField();
    body.classList.add('diving');
    inset.close();
    scene.exitSky(() => { busy = false; body.classList.remove('diving'); setView('earth'); SW.setURL(location.pathname + location.search); });
  }
  $('views').addEventListener('click', (e) => {
    const v = e.target.closest('button')?.dataset.v;
    if (v === 'sky') { const s = currentSector; s ? enterSky(s.ra, s.dec, 40) : enterSky(lastSky.ra, lastSky.dec, lastSky.fov); }
    if (v === 'earth') exitSky();
  });
  $('logo').addEventListener('click', (e) => { e.preventDefault(); cmp.close(); gal.close(); exitSky(); });

  // ---------- сектора ----------
  let currentSector = null;
  function selectSector(s, { focus = false } = {}) {
    if (!s) return;
    currentSector = s;
    scene.selectSector(s);
    $('sec-id').textContent = s.id;
    const sd = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)}°`;
    $('sec-range').textContent = `α ${s.raMin / 15}ʰ–${s.raMax / 15}ʰ · δ ${sd(s.decMin)} … ${sd(s.decMax)}`;
    $('compass').querySelectorAll('button').forEach((b) => {
      const n = SEC.neighbor(s, b.dataset.d);
      b.textContent = n ? n.id : '—';
      b.disabled = !n;
      b.title = { n: 'North', s: 'South', e: 'East', w: 'West' }[b.dataset.d];
      b.onclick = () => n && selectSector(n, { focus: true });
    });
    const objs = SEC.objectsIn(s);
    $('sec-count').textContent = objs.length ? `Objects · ${objs.length}` : 'Objects';
    $('sec-list').innerHTML = objs.length ? objs.map((o, i) => `<li data-i="${i}"><b>${esc(o.label || o.name)}</b><span>${esc(o.type_ru)}</span><span class="acts"><button data-a="sky">Sky</button><button data-a="cmp">Compare</button></span></li>`).join('') : '<li class="muted">No catalogue objects in this sector. Open the sector and pick any field.</li>';
    $('sec-list').querySelectorAll('li[data-i]').forEach((li) => {
      const o = objs[+li.dataset.i];
      li.querySelector('[data-a="sky"]').onclick = (e) => { e.stopPropagation(); goObject(o); };
      li.querySelector('[data-a="cmp"]').onclick = (e) => { e.stopPropagation(); compareObject(o); };
      li.onclick = () => goObject(o);
    });
    $('sector').hidden = false;
    if (focus) scene.home();
    SW.setURL(`#sector=${s.id}`);
  }
  function closeSector(clear = true) { $('sector').hidden = true; if (clear) { currentSector = null; scene.selectSector(null); } }
  $('sector-x').onclick = () => closeSector();
  $('sec-open').onclick = () => currentSector && enterSky(currentSector.ra, currentSector.dec, 40);

  // ---------- участок на небе ----------
  let field = null;
  function pickInSky(p) {
    // если рядом подпись объекта — выбираем объект
    let best = null, bd = 16;
    const hov = scene.project(p.ra, p.dec);
    if (hov) for (const o of A.OBJECTS) { const s = scene.project(o.ra, o.dec); if (s) { const d = Math.hypot(s[0] - hov[0], s[1] - hov[1]); if (d < bd) { bd = d; best = o; } } }
    if (best) setField({ ra: best.ra, dec: best.dec, name: best.label || best.name, kind: best.type_ru, size: fieldSizeFor(best), band: best.band });
    else setField({ ra: p.ra, dec: p.dec, name: '', kind: `Field · sector ${SEC.at(p.ra, p.dec).id}`, size: Math.min(0.5, Math.max(0.05, scene.view().fov / 12)) });
  }
  const fieldSizeFor = (o) => { const s = A.sizeDeg(o.size) * 1.6; return [0.05, 0.1, 0.2, 0.5, 1].find((v) => v >= s) || 1; };
  function setField(f) {
    field = f;
    scene.setField({ ra: f.ra, dec: f.dec, size: f.size, label: f.name ? f.name.toUpperCase() : '' });
    $('fc-kind').textContent = f.kind || 'Field';
    $('fc-name').textContent = f.name || `${A.fmtRA(f.ra)}`;
    $('fc-co').textContent = `${A.fmtRA(f.ra)} ${A.fmtDec(f.dec)} · ${f.size >= 1 ? `${f.size}°` : `${Math.round(f.size * 60)}′`}`;
    $('field').hidden = false;
    if (scene.mode === 'sky') inset.open({ ...f, band: f.band });
  }
  function clearField() { field = null; scene.setField(null); $('field').hidden = true; inset.close(); }
  $('fc-x').onclick = clearField;
  $('fc-center').onclick = () => field && scene.goto(field.ra, field.dec, Math.max(field.size * 5, 0.5));
  $('fc-compare').onclick = () => { if (!field) return; if (inset.isOpen) cmp.show(); else cmp.open({ ra: field.ra, dec: field.dec, name: field.name, size: field.size }); };

  function goObject(o) {
    const size = fieldSizeFor(o);
    enterSky(o.ra, o.dec, Math.max(0.6, size * 6), () => setField({ ra: o.ra, dec: o.dec, name: o.label || o.name, kind: o.type_ru, size, band: o.band }));
    if (scene.mode === 'sky') setField({ ra: o.ra, dec: o.dec, name: o.label || o.name, kind: o.type_ru, size, band: o.band });
  }
  function compareObject(o) { cmp.open({ ra: o.ra, dec: o.dec, name: o.label || o.name, size: fieldSizeFor(o), band: o.band }); }

  $('open-compare').onclick = () => {
    if (field) return cmp.open({ ra: field.ra, dec: field.dec, name: field.name, size: field.size });
    const o = A.findObject('Barnard');
    toast("Example: Barnard's Star — it moved almost 7′ in 40 years. Pick your own field in the sky.");
    compareObject(o);
  };
  $('open-gallery').onclick = () => gal.open();

  // ---------- first run: examples and the tour ----------
  const OBJ = (id) => A.OBJECTS.find((o) => o.id === id);
  const TRY = ['Barnard', 'WISE 0855', 'RW Aur', 'Eps Ind B', 'M42', 'NEP'];
  $('try').querySelector('.try-list').innerHTML = TRY.map(OBJ).filter(Boolean).map((o) => `<button data-id="${esc(o.id)}" title="${esc(o.type_ru)}"><b>${esc(o.name.replace(' · the fastest star in the sky', ''))}</b><span>${esc(o.type_ru.replace(/ · .*/, ''))}</span></button>`).join('');
  $('try').querySelectorAll('.try-list button').forEach((b) => (b.onclick = () => goObject(OBJ(b.dataset.id))));
  const tour = SW.createTour($('tour'), [
    { title: 'The whole infrared sky', text: 'Earth sits inside the real <b>SPHEREx</b> all-sky map: 102 infrared colours, imaged every six months since 2025. Drag to turn, scroll to zoom.', run: () => { cmp.close(); gal.close(); if (scene.mode === 'sky') exitSky(); } },
    { title: '72 sectors', text: 'The grid splits the sky into sectors A01–F12. Click one to see what is inside, double-click to fly in.', run: () => selectSector(SEC.at(269.45, 4.69)), hl: '#sector' },
    { title: "Fly to Barnard's Star", text: 'The fastest-moving star in our sky: 10.4″ per year. Search works for any name, sector or coordinates.', run: () => { closeSector(); goObject(OBJ('Barnard')); }, hl: '.search', ms: 9000 },
    { title: 'Images of this point', text: 'SPHEREx images of the spot play right above it. Click the image to pause.', hl: '#inset .in-box' },
    { title: 'One bar = one image', text: 'The timeline shows every image of this point in time order. Frames from one visit are averaged into one deeper image (<i>stack</i>).', hl: '#inset .in-bar' },
    { title: 'Six detectors', text: 'SPHEREx sees 0.75–5 µm with six detectors. <b>Auto</b> picks the best one; <b>All 6</b> shows the same spot in every colour.', hl: '#inset .in-det' },
    { title: '40 years, side by side', text: 'The full compare screen puts two epochs next to each other. Zoom and pan move both images.', run: () => { cmp.show(); cmp.setMode('side'); }, hl: '#cmp .cmp-stage' },
    { title: 'Blink', text: 'The classic way to find moving things: two epochs swap in place (never faster than 3 times a second).', run: () => cmp.setMode('blink'), hl: '#cmp .cmp-modes' },
    { title: 'Difference', text: 'Everything that did not change disappears. <span style="color:#ff7a45">Orange</span> = new position, <span style="color:#7fb4ff">blue</span> = old. Each find is explained on the right.', run: () => cmp.setMode('diff'), hl: '#cmp .cmp-side' },
    { title: 'Track an object', text: 'Press <b>M</b> and click any object: SpaceCam follows it through every frame, measures speed and direction and draws its light curve.', run: () => cmp.setMode('flip'), hl: '#cmp .cmp-tools' },
    { title: 'Gallery', text: '136 places with real images: Messier objects, deep fields, brown dwarfs, the fastest stars.', run: () => { cmp.close(); gal.open(); }, hl: '#gal .gal-grid' },
    { title: 'Your turn', text: 'Click anywhere in the sky. Share any view with the <b>Share</b> button. Detections are candidates, not discoveries.', run: () => gal.close() },
  ]);
  $('tour-btn').onclick = () => tour.start();
  SW.tour = tour;
  $('keys-x').onclick = () => ($('keys').hidden = true);

  // ---------- поиск с подсказками ----------
  const q = $('q'), sugg = $('sugg');
  let items = [], hi = -1;
  function suggestions(text) {
    const out = [];
    const t = text.trim();
    if (!t) return out;
    const sec = SEC.byId(t);
    if (sec) out.push({ kind: 'Sector', label: sec.id, sub: `α ${sec.raMin / 15}–${sec.raMax / 15}ʰ`, go: () => goSector(sec) });
    const c = A.parseCoords(t.replace(/−/g, '-'));
    if (c) out.push({ kind: 'Coordinates', label: `${A.fmtRA(c.ra)} ${A.fmtDec(c.dec)}`, sub: `sector ${SEC.at(c.ra, c.dec).id}`, go: () => goPoint(c) });
    A.searchObjects(t, 8).forEach((o) => out.push({ kind: o.type_ru, label: o.label || o.name, sub: `${o.ngc ? `${o.ngc} · ` : ''}${SEC.at(o.ra, o.dec).id}`, go: () => goObject(o) }));
    return out;
  }
  function renderSugg() {
    if (!items.length) { sugg.hidden = true; return; }
    sugg.innerHTML = items.map((it, i) => `<button type="button" data-i="${i}" class="${i === hi ? 'on' : ''}"><b>${esc(it.label)}</b><span>${esc(it.kind)}</span><em class="mono">${esc(it.sub)}</em></button>`).join('');
    sugg.hidden = false;
    sugg.querySelectorAll('button').forEach((b) => (b.onmousedown = (e) => { e.preventDefault(); choose(+b.dataset.i); }));
  }
  function choose(i) { const it = items[i]; if (!it) return; sugg.hidden = true; q.value = it.label; q.blur(); it.go(); }
  q.addEventListener('input', () => { items = suggestions(q.value); hi = items.length ? 0 : -1; renderSugg(); });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); hi = Math.min(items.length - 1, hi + 1); renderSugg(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); hi = Math.max(0, hi - 1); renderSugg(); }
    if (e.key === 'Escape') { sugg.hidden = true; q.blur(); }
  });
  q.addEventListener('blur', () => setTimeout(() => (sugg.hidden = true), 120));
  q.addEventListener('focus', () => { if (items.length) renderSugg(); });
  $('search').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (items.length) return choose(Math.max(0, hi));
    // имя, которого нет в каталоге: служба Sesame (CDS)
    try {
      const r = await fetch(`https://cds.unistra.fr/cgi-bin/nph-sesame/-ox/~?${encodeURIComponent(q.value.trim())}`);
      const x = await r.text();
      const ra = parseFloat((x.match(/<jradeg>([^<]+)/) || [])[1]), dec = parseFloat((x.match(/<jdedeg>([^<]+)/) || [])[1]);
      if (Number.isFinite(ra) && Number.isFinite(dec)) return goObject({ ra, dec, name: q.value.trim(), type_ru: 'Found in Sesame (CDS)', size: '' });
    } catch (_) { /* offline */ }
    toast(`«${q.value.trim()}” not found. Examples: M42, Vega, C07, 83.82 −5.39`);
  });
  function goSector(s) { if (scene.mode === 'sky') scene.goto(s.ra, s.dec, 40); else selectSector(s, { focus: true }); }
  function goPoint(c) { const size = 0.2; enterSky(c.ra, c.dec, 3, () => setField({ ...c, name: '', kind: `Field · sector ${SEC.at(c.ra, c.dec).id}`, size })); if (scene.mode === 'sky') setField({ ...c, name: '', kind: 'Field', size }); }

  // ---------- выпадающие меню шапки ----------
  document.querySelectorAll('.dd').forEach((dd) => {
    dd.querySelector('.dd-b').addEventListener('click', (e) => {
      e.stopPropagation();
      const open = !dd.classList.contains('open');
      document.querySelectorAll('.dd.open').forEach((x) => x.classList.remove('open'));
      dd.classList.toggle('open', open);
    });
    dd.querySelector('.dd-p').addEventListener('click', (e) => e.stopPropagation());
  });
  document.addEventListener('click', () => document.querySelectorAll('.dd.open').forEach((x) => x.classList.remove('open')));

  // слои
  const layers = { 't-sky': (v) => scene.setSkyMap(v), 't-sectors': (v) => { scene.setSectors(v); if (!v) closeSector(); }, 't-grid': (v) => scene.setGrid(v), 't-orbit': (v) => scene.setOrbit(v), 't-cover': (v) => scene.setCoverage(v), 't-labels': (v) => scene.setLabels(v) };
  Object.entries(layers).forEach(([id, fn]) => $(id).addEventListener('change', (e) => { fn(e.target.checked); SW.store.set(`skycam_${id}`, e.target.checked ? '1' : '0'); }));
  Object.entries(layers).forEach(([id, fn]) => { const v = SW.store.get(`skycam_${id}`); if (v != null) { $(id).checked = v === '1'; fn(v === '1'); } });

  // снимки
  const list = $('surveys');
  SW.HIPS_SURVEYS.forEach((s) => {
    const b = document.createElement('button');
    b.dataset.id = s.id;
    b.innerHTML = `<b>${s.name}</b><span>${s.sub}</span>`;
    b.onclick = () => { scene.hips.set(s.id, s.cube ? frame : 0); markSurvey(s.id); };
    list.appendChild(b);
  });
  function markSurvey(id) { list.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.id === id)); $('spectrum').classList.toggle('off', id !== 'spherex'); }
  const LAM = A.SPHEREX_LAMBDA, LMIN = 0.75, LMAX = 5.0;
  const NOTES = [[1.875, 'Paschen-α · hydrogen'], [2.166, 'Brackett-γ'], [3.05, 'water ice'], [3.3, 'PAH · organics'], [4.05, 'Brackett-α'], [4.27, 'CO₂ ice'], [4.67, 'CO ice']];
  (function buildSpectrum() {
    const bar = $('sp-bar');
    LAM.forEach((l, i) => { const t = document.createElement('b'); t.style.left = `${((l - LMIN) / (LMAX - LMIN)) * 100}%`; if (A.BLANK_FRAMES.includes(i)) t.className = 'blank'; bar.appendChild(t); });
    NOTES.forEach(([l, n]) => { const m = document.createElement('u'); m.style.left = `${((l - LMIN) / (LMAX - LMIN)) * 100}%`; m.title = n; bar.appendChild(m); });
    const pick = (x) => {
      const r = bar.getBoundingClientRect(), l = LMIN + Math.min(1, Math.max(0, (x - r.left) / r.width)) * (LMAX - LMIN);
      let best = 0;
      LAM.forEach((v, i) => { if (!A.BLANK_FRAMES.includes(i) && Math.abs(v - l) < Math.abs(LAM[best] - l)) best = i; });
      setFrame(best);
    };
    bar.addEventListener('pointerdown', (e) => { bar.setPointerCapture(e.pointerId); pick(e.clientX); });
    bar.addEventListener('pointermove', (e) => { if (e.buttons & 1) pick(e.clientX); });
  })();
  let spT = null;
  function setFrame(i) {
    frame = i;
    const l = LAM[i];
    $('sp-knob').style.left = `${((l - LMIN) / (LMAX - LMIN)) * 100}%`;
    $('sp-val').textContent = `${l.toFixed(3)} µm · channel ${i + 1}/102`;
    const near = NOTES.find(([x]) => Math.abs(x - l) < 0.04);
    $('sp-note').textContent = near ? near[1] : '';
    clearTimeout(spT);
    spT = setTimeout(() => { if (scene.hips.survey.cube) scene.hips.set('spherex', frame); }, 250);
  }
  setFrame(0);
  const tone = () => scene.setTone(+$('gain').value, +$('gamma').value);
  $('gain').addEventListener('input', tone); $('gamma').addEventListener('input', tone);

  // миссия
  const slider = $('slider');
  const totalDays = Math.max(1, Math.floor((Date.now() - A.MISSION_START) / 86400000));
  slider.max = String(totalDays); slider.value = String(totalDays);
  (function ruler() {
    for (let k = 0; k * A.SURVEY_DAYS < totalDays; k++) {
      const a = (k * A.SURVEY_DAYS) / totalDays, b = Math.min(1, ((k + 1) * A.SURVEY_DAYS) / totalDays), s = document.createElement('span');
      s.style.left = `${a * 100}%`; s.style.width = `${(b - a) * 100}%`; s.textContent = `S${k + 1}`;
      $('ruler-surveys').appendChild(s);
    }
    for (let y = 2026; ; y++) {
      const f = (Date.UTC(y, 0, 1) - A.MISSION_START) / 86400000 / totalDays;
      if (f > 1) break;
      const t = document.createElement('span'); t.style.left = `${f * 100}%`; t.textContent = String(y); $('ruler-ticks').appendChild(t);
    }
  })();
  const missionDate = () => (+slider.value >= totalDays ? new Date() : new Date(A.MISSION_START.getTime() + +slider.value * 86400000));
  function updateMission() {
    const d = missionDate(), days = +slider.value;
    scene.setDate(d);
    $('h-date').textContent = A.fmtDate(d);
    $('h-survey').textContent = `survey S${A.surveyIndex(d)}`;
    $('m-short').textContent = +slider.value >= totalDays ? `S${A.surveyIndex(d)}` : A.fmtDate(d).replace(/ \d{4}$/, '');
    $('h-cover').textContent = days >= A.SURVEY_DAYS ? `By this date the whole sky was imaged ${(days / A.SURVEY_DAYS).toFixed(1)}  times` : `By this date ${Math.round((days / A.SURVEY_DAYS) * 100)}% of the sky was imaged`;
    slider.style.setProperty('--p', `${(days / totalDays) * 100}%`);
  }
  let raf = null;
  function stopPlay() { if (raf) cancelAnimationFrame(raf); raf = null; $('play').classList.remove('on'); }
  slider.addEventListener('input', () => { stopPlay(); updateMission(); });
  $('play').addEventListener('click', () => {
    if (raf) return stopPlay();
    if (+slider.value >= totalDays) slider.value = '0';
    $('play').classList.add('on');
    let last = performance.now();
    const tick = (t) => { slider.value = String(Math.min(totalDays, +slider.value + ((t - last) / 1000) * 45)); last = t; updateMission(); if (+slider.value >= totalDays) return stopPlay(); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
  });
  updateMission();

  // о проекте
  $('open-about').onclick = () => ($('about').hidden = false);
  $('proxy-url').value = SW.store.get('skycam_proxy') || window.SKYCAM_PROXY || '';
  $('proxy-save').onclick = () => { const v = $('proxy-url').value.trim(); if (v && !/^https:\/\//.test(v) && !/^\/(?!\/)/.test(v)) { toast('Use an HTTPS address or a path on this site.'); return; } SW.store.set('skycam_proxy', v); toast(v ? 'Proxy saved. Per-visit SPHEREx images will go through it.' : 'Default archive connection restored'); };
  $('diag-run').onclick = async () => {
    const box = $('diag-out');
    box.innerHTML = '<p class="muted small">Checking…</p>';
    const r = await SW.diagnose();
    const err = SW.errors.length ? `<h4>Errors on the page</h4><pre>${esc(SW.errors.join('\n'))}</pre>` : '<p class="muted small">No errors on the page.</p>';
    box.innerHTML = `<table class="diag">${r.map((x) => `<tr class="${x.ok ? 'ok' : 'bad'}"><td>${x.ok ? '✓' : '✕'}</td><td>${esc(x.name)}</td><td class="mono">${esc(x.info)}</td></tr>`).join('')}</table>${err}<p class="muted tiny">Take a screenshot of this table and send it to the developer.</p>`;
  };
  $('about-x').onclick = () => ($('about').hidden = true);
  $('about').addEventListener('click', (e) => { if (e.target.id === 'about') $('about').hidden = true; });

  // ---------- клавиатура ----------
  document.addEventListener('keydown', (e) => {
    if (body.classList.contains('loading')) return;
    if (e.target.tagName === 'INPUT' || cmp.isOpen) return;
    if (e.key === '/') { e.preventDefault(); q.focus(); return; }
    if (e.key === '?') { $('keys').hidden = !$('keys').hidden; return; }
    if (e.key === 'Escape') {
      if (!$('about').hidden) { $('about').hidden = true; return; }
      if (scene.mode === 'sky') { if (field) clearField(); else exitSky(); } else closeSector();
      return;
    }
    const dir = { ArrowUp: 'n', ArrowDown: 's', ArrowLeft: 'e', ArrowRight: 'w' }[e.key];
    if (dir && scene.mode !== 'sky' && currentSector) { e.preventDefault(); const n = SEC.neighbor(currentSector, dir); if (n) selectSector(n); }
    if (e.key === 'Enter' && scene.mode !== 'sky' && currentSector) enterSky(currentSector.ra, currentSector.dec, 40);
    if (dir && scene.mode === 'sky' && field) {
      e.preventDefault();
      const d = field.size * 0.9, cd = Math.max(0.05, Math.cos((field.dec * Math.PI) / 180));
      const f = { ...field, name: '', kind: 'Field' };
      if (dir === 'n') f.dec = Math.min(89.9, f.dec + d); if (dir === 's') f.dec = Math.max(-89.9, f.dec - d);
      if (dir === 'e') f.ra = (f.ra + d / cd) % 360; if (dir === 'w') f.ra = (f.ra - d / cd + 360) % 360;
      setField(f);
    }
  });

  // ---------- подсказка ----------
  function setHint(v) {
    const h = $('hint');
    h.textContent = v === 'sky' ? 'Click — pick a field or object · wheel — zoom · ←→↑↓ — move the field · Esc — back to Earth' : 'Click — select a sector · double-click — fly into the sky · ←→↑↓ — neighbouring sectors · / — search';
    h.classList.add('on');
    clearTimeout(setHint.t);
    setHint.t = setTimeout(() => h.classList.remove('on'), 9000);
  }

  // ---------- ссылки на вид ----------
  function schedHash() {
    clearTimeout(schedHash.t);
    schedHash.t = setTimeout(() => { if (scene.mode !== 'sky') return; const v = scene.view(); SW.setURL(`#ra=${v.ra.toFixed(4)}&dec=${v.dec.toFixed(4)}&fov=${v.fov.toFixed(3)}${frame ? `&ch=${frame}` : ''}`); }, 400);
  }
  (function readHash() {
    const h = new URLSearchParams(location.hash.slice(1));
    const ch = parseInt(h.get('ch'), 10);
    if (ch >= 0 && ch < 102) setFrame(ch);
    const sec = h.get('sector') && SEC.byId(h.get('sector'));
    const obj = h.get('obj') && A.findObject(h.get('obj'));
    const ra = parseFloat(h.get('ra')), dec = parseFloat(h.get('dec')), fov = parseFloat(h.get('fov'));
    const cm = h.get('cmp') && h.get('cmp').split(',').map(Number);
    if (cm && cm.length >= 2 && cm.every(Number.isFinite)) {
      startup.ready.then(() => { cmp.open({ ra: cm[0], dec: cm[1], size: cm[2] || 0.2, name: h.get('name') || '', band: h.get('det') || undefined }); setTimeout(() => cmp.applyState({ m: h.get('m'), a: h.get('a'), b: h.get('b') }), 6000); });
      return;
    }
    startup.ready.then(() => setTimeout(() => {
      if (obj) goObject(obj);
      else if (sec) selectSector(sec);
      else if (Number.isFinite(ra) && Number.isFinite(dec)) enterSky(ra, dec, Number.isFinite(fov) ? fov : 10);
    }, 2200));
  })();
})();
