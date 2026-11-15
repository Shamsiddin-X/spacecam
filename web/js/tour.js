/* SpaceCam · guided tour and first-run examples.
 * The tour plays by itself (7 s per step), with Back / Pause / Next; every step does something real
 * on the page and highlights the control it talks about. */
(function () {
  const SW = (window.SW = window.SW || {});
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  SW.createTour = function (el, steps) {
    const st = { i: 0, on: false, paused: false, t: null };
    function hl(sel) {
      document.querySelectorAll('.tour-hl').forEach((e) => e.classList.remove('tour-hl'));
      if (!sel) return;
      const e = document.querySelector(sel);
      if (e) e.classList.add('tour-hl');
    }
    function render() {
      const s = steps[st.i];
      el.innerHTML = `<div class="tr-head mono"><span>TOUR · ${st.i + 1} OF ${steps.length}</span><button class="tr-x" aria-label="Close tour">✕</button></div>
        <h3>${esc(s.title)}</h3><p>${s.text}</p>
        <div class="tr-prog"><i style="animation-duration:${s.ms || 7000}ms" class="${st.paused ? 'paused' : ''}"></i></div>
        <div class="tr-ctl"><button data-c="back" ${st.i ? '' : 'disabled'}>◀</button><button data-c="pause">${st.paused ? '▶ Play' : '❚❚ Pause'}</button><button data-c="next" class="hot">${st.i === steps.length - 1 ? 'Finish' : 'Next ▶'}</button></div>
        <div class="tr-dots">${steps.map((_, k) => `<button data-k="${k}" class="${k === st.i ? 'on' : ''}">${k + 1}</button>`).join('')}</div>`;
      el.querySelector('.tr-x').onclick = stop;
      el.querySelector('[data-c="back"]').onclick = () => go(st.i - 1);
      el.querySelector('[data-c="next"]').onclick = () => (st.i === steps.length - 1 ? stop() : go(st.i + 1));
      el.querySelector('[data-c="pause"]').onclick = () => { st.paused = !st.paused; render(); schedule(); };
      el.querySelectorAll('.tr-dots button').forEach((b) => (b.onclick = () => go(+b.dataset.k)));
    }
    function schedule() {
      clearTimeout(st.t);
      if (st.paused || !st.on) return;
      st.t = setTimeout(() => (st.i < steps.length - 1 ? go(st.i + 1) : stop()), steps[st.i].ms || 7000);
    }
    function go(i) {
      st.i = Math.max(0, Math.min(steps.length - 1, i));
      const s = steps[st.i];
      try { s.run && s.run(); } catch (e) { console.warn('tour step', e); }
      setTimeout(() => hl(s.hl), 400);
      render(); schedule();
    }
    function start() { st.on = true; st.paused = false; el.hidden = false; document.body.classList.add('touring'); go(0); }
    function stop() { st.on = false; clearTimeout(st.t); el.hidden = true; hl(null); document.body.classList.remove('touring'); SW.store.set('skycam_toured', '1'); }
    return { start, stop, goto: (i) => go(i), get on() { return st.on; } };
  };
})();
