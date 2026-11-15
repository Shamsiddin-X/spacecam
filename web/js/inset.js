/* SpaceCam · Sky inset: click a point in the sky and its images play right above it,
 * linked to the point by a light cone. Detector bar, timeline of frames, loop / blink / difference,
 * one click to the full Compare screen. Data comes from the Compare engine (silent mode). */
(function () {
  const SW = (window.SW = window.SW || {});
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const BANDS = [['auto', 'Auto'], ['D1', 'D1'], ['D2', 'D2'], ['D3', 'D3'], ['D4', 'D4'], ['D5', 'D5'], ['D6', 'D6'], ['all6', 'All 6 detectors']];

  SW.createInset = function (el, { scene, cmp }) {
    el.innerHTML = `
      <div class="in-det seg-s"><span class="k">Detector</span>${BANDS.map(([v, l]) => `<button data-b="${v}">${l}</button>`).join('')}</div>
      <div class="in-box">
        <canvas width="560" height="560"></canvas>
        <div class="in-stamp mono"></div><div class="in-badge"></div><div class="in-load mono"></div>
        <div class="in-nesw mono">N ↑ E ←</div>
      </div>
      <div class="in-bar"><div class="in-segs"></div><div class="in-row mono"><span class="in-d0"></span><span class="in-pos"></span><span class="in-d1"></span></div></div>
      <div class="in-act">
        <button data-a="loop" class="on">↻ Loop</button><button data-a="blink">Blink A/B</button><button data-a="diff">Difference</button>
        <button data-a="full" class="hot">Full compare ⤢</button><button data-a="close" aria-label="Close">✕</button>
      </div>`;
    const cv = el.querySelector('canvas'), g = cv.getContext('2d');
    const st = { on: false, field: null, mode: 'loop', i: 0, timer: null, paused: false, showB: false };

    el.querySelectorAll('.in-det button').forEach((b) => (b.onclick = () => { cmp.setBand(b.dataset.b); st.i = 0; mark(); }));
    el.querySelectorAll('.in-act button').forEach((b) => (b.onclick = () => act(b.dataset.a)));
    cv.onclick = () => { st.paused = !st.paused; draw(); };

    function act(a) {
      if (a === 'close') return close();
      if (a === 'full') { cmp.show(); return; }
      st.mode = a; st.paused = false; restart(); mark(); draw();
    }
    function mark() {
      const band = cmp.band();
      el.querySelectorAll('.in-det button').forEach((b) => b.classList.toggle('on', b.dataset.b === band));
      el.querySelectorAll('.in-act button[data-a="loop"], .in-act button[data-a="blink"], .in-act button[data-a="diff"]').forEach((b) => b.classList.toggle('on', b.dataset.a === st.mode));
    }
    /** frames shown in the inset: SPHEREx visits if any, otherwise every epoch */
    function frames() {
      const all = cmp.frames();
      const sx = all.filter((f) => f.source === 'spherex');
      return sx.length >= 2 ? sx : all;
    }
    function restart() {
      clearInterval(st.timer);
      st.timer = setInterval(() => {
        if (!st.on || st.paused) return;
        const fr = frames();
        if (st.mode === 'loop' && fr.length) st.i = (st.i + 1) % fr.length;
        if (st.mode === 'blink') st.showB = !st.showB;
        draw();
      }, 600); // 1.7 changes per second: under the 3 Hz flash limit
    }

    function draw() {
      if (!st.on) return;
      const W = cv.width, H = cv.height, fr = frames(), s = cmp.status();
      g.fillStyle = '#05070c'; g.fillRect(0, 0, W, H); g.imageSmoothingEnabled = false;
      const load = el.querySelector('.in-load');
      const failed = s.src.filter((x) => x.state === 'fail').map((x) => x.label), waiting = s.src.filter((x) => x.state === 'wait').length;
      load.innerHTML = waiting ? `<i style="width:${Math.round((100 * (s.src.length - waiting)) / Math.max(1, s.src.length))}%"></i>⏳ ${esc(s.wait || 'Loading images…')}` : failed.length && fr.length < 2 ? `✕ ${esc(failed.join(', '))} unavailable` : '';
      load.hidden = !load.innerHTML;
      if (!fr.length) { stamp(''); badge(''); segs([]); return; }
      st.i = Math.min(st.i, fr.length - 1);
      let f = fr[st.i], img;
      const all = cmp.frames(), p = cmp.pair();
      if (st.mode === 'blink' && all.length >= 2) { f = st.showB ? all[p.b] : all[p.a]; img = cmp.canvasOf(f); }
      else if (st.mode === 'diff' && cmp.diff()) img = cmp.diff();
      else img = cmp.canvasOf(f);
      g.drawImage(img, 0, 0, W, H);
      // crosshair at the target
      g.strokeStyle = 'rgba(255,160,90,.9)'; g.lineWidth = 2;
      const c = W / 2; g.beginPath(); g.moveTo(c - 18, c); g.lineTo(c - 7, c); g.moveTo(c + 7, c); g.lineTo(c + 18, c); g.moveTo(c, c - 18); g.lineTo(c, c - 7); g.moveTo(c, c + 7); g.lineTo(c, c + 18); g.stroke();
      // scale bar 1′
      const t = cmp.target(), size = (t && t.sizeDeg) || 0.2, px = W / (size * 60);
      if (px > 20 && px < W / 2) { g.strokeStyle = '#fff'; g.beginPath(); g.moveTo(16, H - 18); g.lineTo(16 + px, H - 18); g.stroke(); g.fillStyle = '#fff'; g.font = '600 14px ui-monospace, monospace'; g.fillText('1′', 16, H - 26); }
      if (st.paused) { g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(W / 2 - 34, H / 2 - 34, 68, 68); g.fillStyle = '#fff'; g.fillRect(W / 2 - 14, H / 2 - 18, 9, 36); g.fillRect(W / 2 + 5, H / 2 - 18, 9, 36); }
      const lam = f.lambda || '';
      stamp(st.mode === 'diff' ? `Difference · B − A · ${esc(all[p.a].sub)} → ${esc(all[p.b].sub)}` : `${esc(f.sub)} · ${esc(f.label)} · ${esc(lam)} · ${(st.mode === 'blink' ? (st.showB ? 'B' : 'A') : `${st.i + 1}/${fr.length}`)}`);
      badge(st.mode === 'diff' ? 'B − A' : f.source === 'spherex' ? `${esc(f.band)} · ${esc(lam.replace(' µm', ''))}<small> µm</small>${f.stackOf ? `<em>stack ×${f.stackOf} · mean</em>` : ''}` : esc(f.label));
      segs(fr);
    }
    const stamp = (h) => (el.querySelector('.in-stamp').innerHTML = h);
    const badge = (h) => { const b = el.querySelector('.in-badge'); b.innerHTML = h; b.hidden = !h; };
    function segs(fr) {
      const box = el.querySelector('.in-segs');
      if (box.childElementCount !== fr.length) {
        box.innerHTML = fr.map((_, k) => `<button data-k="${k}"></button>`).join('');
        box.querySelectorAll('button').forEach((b) => (b.onclick = () => { st.i = +b.dataset.k; st.mode = 'loop'; st.paused = true; mark(); draw(); }));
      }
      box.querySelectorAll('button').forEach((b, k) => b.classList.toggle('on', k === st.i && st.mode === 'loop'));
      const d = (f) => (f.source === 'spherex' ? f.sub.split(/[,·]/)[0].trim() : String(Math.round(f.year)));
      el.querySelector('.in-d0').textContent = fr.length ? d(fr[0]) : '';
      el.querySelector('.in-d1').textContent = fr.length ? d(fr[fr.length - 1]) : '';
      el.querySelector('.in-pos').textContent = fr.length ? `${st.i + 1} / ${fr.length}` : '';
    }

    /** cone from the inset to the selected field; also keeps the inset next to the point */
    scene.onOverlay((ctx) => {
      if (!st.on || !st.field || scene.mode !== 'sky' || cmp.isOpen) { if (st.on) el.style.visibility = 'hidden'; return; }
      const f = st.field, s = scene.project(f.ra, f.dec);
      if (!s) { el.style.visibility = 'hidden'; return; }
      el.style.visibility = 'visible';
      const w = el.offsetWidth, h = el.offsetHeight, vw = window.innerWidth, vh = window.innerHeight, bar = 70;
      let left = Math.min(vw - w - 10, Math.max(10, s[0] - w / 2));
      let top = s[1] - h - 70;
      const below = top < bar;
      if (below) top = Math.min(vh - h - 10, s[1] + 70);
      el.style.left = `${left}px`; el.style.top = `${top}px`;
      const box = el.querySelector('.in-box').getBoundingClientRect();
      const cd = Math.max(0.05, Math.cos((f.dec * Math.PI) / 180)), hs = f.size / 2;
      const q = [[f.ra + hs / cd, f.dec + hs], [f.ra - hs / cd, f.dec + hs], [f.ra - hs / cd, f.dec - hs], [f.ra + hs / cd, f.dec - hs]].map(([r, d]) => scene.project(r, d));
      if (q.some((x) => !x)) return;
      const ey = below ? box.top : box.bottom, near = below ? [q[0], q[1]] : [q[3], q[2]];
      ctx.save();
      ctx.fillStyle = 'rgba(140,150,255,.12)'; ctx.strokeStyle = 'rgba(160,170,255,.55)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(box.left, ey); ctx.lineTo(box.right, ey); ctx.lineTo(near[1][0], near[1][1]); ctx.lineTo(near[0][0], near[0][1]); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(box.left + box.width / 3, ey); ctx.lineTo(s[0], s[1]); ctx.moveTo(box.left + (2 * box.width) / 3, ey); ctx.lineTo(s[0], s[1]); ctx.stroke();
      ctx.strokeStyle = 'rgba(200,205,255,.9)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(s[0], s[1], 13, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    });

    cmp.subscribe(() => { if (st.on) { mark(); draw(); } });

    function open(field) {
      st.field = field; st.on = true; st.i = 0; st.paused = false;
      el.hidden = false; el.style.visibility = 'hidden';
      cmp.open({ ra: field.ra, dec: field.dec, name: field.name, size: field.size, band: field.band, sizeDeg: field.size }, { silent: true });
      restart(); mark(); draw();
    }
    function close() { st.on = false; clearInterval(st.timer); el.hidden = true; }
    return { open, close, get isOpen() { return st.on; } };
  };
})();
