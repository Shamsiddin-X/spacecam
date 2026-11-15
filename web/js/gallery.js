/* SpaceCam · Gallery: все объекты каталога с настоящими снимками (SPHEREx, 2MASS, DSS),
 * фильтры по типу, переход на небо или в сравнение эпох. Миниатюры собираются из HiPS по мере прокрутки.
 */
(function () {
  const SW = (window.SW = window.SW || {});
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const FILTERS = [
    ['all', 'All', () => true],
    ['neb', 'Nebulae', (o) => /nebula|h ii|remnant|cloud/i.test(o.type_ru) && !/galaxy|star cloud/i.test(o.type_ru)],
    ['gal', 'Galaxies', (o) => /galaxy/i.test(o.type_ru)],
    ['clu', 'Clusters', (o) => /cluster|asterism/i.test(o.type_ru)],
    ['star', 'Stars', (o) => /star|giant|dwarf/i.test(o.type_ru) && !/cluster|cloud/i.test(o.type_ru)],
    ['fast', 'Moving', (o) => /″\/yr/.test(o.type_ru)],
    ['deep', 'SPHEREx fields', (o) => /SPHEREx/.test(o.type_ru)],
  ];
  const THUMBS = [['2mass', '2MASS'], ['spherex', 'SPHEREx'], ['dss2', 'DSS2']];

  SW.createGallery = function (root, { onSky, onCompare, getFrame }) {
    const A = SW.astro;
    let filter = 'all', src = '2mass', q = '', queue = [], active = 0, observer = null;
    root.innerHTML = `
      <div class="gal-top">
        <div class="gal-title"><span class="k">Gallery</span><b>${A.OBJECTS.length} places in the sky</b></div>
        <input class="gal-q" placeholder="Filter by name" />
        <div class="gal-f seg-s">${FILTERS.map(([id, l]) => `<button data-f="${id}">${l}</button>`).join('')}</div>
        <div class="gal-s seg-s">${THUMBS.map(([id, l]) => `<button data-s="${id}">${l}</button>`).join('')}</div>
        <button class="cmp-close gal-x" aria-label="Close">✕</button>
      </div>
      <div class="gal-grid"></div>`;
    const grid = root.querySelector('.gal-grid');
    root.querySelector('.gal-x').onclick = close;
    root.querySelector('.gal-q').oninput = (e) => { q = e.target.value.trim().toLowerCase(); render(); };
    root.querySelectorAll('.gal-f button').forEach((b) => (b.onclick = () => { filter = b.dataset.f; render(); }));
    root.querySelectorAll('.gal-s button').forEach((b) => (b.onclick = () => { src = b.dataset.s; render(); }));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && root.classList.contains('open')) close(); });

    function pump() {
      while (active < 4 && queue.length) {
        const job = queue.shift();
        if (!job.el.isConnected) continue;
        active++;
        const o = job.o, a = SW.hipscut.ALL.find((x) => x.id === job.src);
        const fov = Math.min(3, Math.max(0.12, A.sizeDeg(o.size) * 1.8));
        SW.hipscut.cut(a, o.ra, o.dec, 128, (fov * 3600) / 128, a.cube ? getFrame() : 0)
          .then((r) => { const c = job.el.querySelector('canvas'); c.getContext('2d').putImageData(r.image, 0, 0); job.el.classList.add('ok'); })
          .catch(() => job.el.classList.add('fail'))
          .finally(() => { active--; pump(); });
      }
    }
    function render() {
      root.querySelectorAll('.gal-f button').forEach((b) => b.classList.toggle('on', b.dataset.f === filter));
      root.querySelectorAll('.gal-s button').forEach((b) => b.classList.toggle('on', b.dataset.s === src));
      const fn = FILTERS.find((f) => f[0] === filter)[2];
      const list = A.OBJECTS.filter(fn).filter((o) => !q || `${o.id} ${o.ngc} ${o.name}`.toLowerCase().includes(q));
      queue = [];
      grid.innerHTML = '';
      if (observer) observer.disconnect();
      observer = 'IntersectionObserver' in window ? new IntersectionObserver((es) => es.forEach((en) => {
        if (en.isIntersecting && !en.target.dataset.q) { en.target.dataset.q = '1'; queue.push({ el: en.target, o: en.target._o, src }); pump(); }
      }), { root: grid, rootMargin: '200px' }) : null;
      list.forEach((o) => {
        const card = document.createElement('article');
        card.className = 'gal-card';
        card._o = o;
        card.innerHTML = `<div class="gal-img"><canvas width="128" height="128"></canvas><span class="mono">${esc(o.id)}</span></div>
          <b>${esc(o.name)}</b><span class="t">${esc(o.type_ru)}${o.mag ? ` · ${esc(o.mag)}ᵐ` : ''}</span>
          <div class="gal-a"><button data-a="sky">In the sky</button><button data-a="cmp">Compare epochs</button></div>`;
        card.querySelector('[data-a="sky"]').onclick = () => { close(); onSky(o); };
        card.querySelector('[data-a="cmp"]').onclick = () => { close(); onCompare(o); };
        grid.appendChild(card);
        if (observer) observer.observe(card); else { queue.push({ el: card, o, src }); }
      });
      if (!observer) pump();
      if (!list.length) grid.innerHTML = '<p class="muted">Nothing found.</p>';
    }
    function open() { root.classList.add('open'); document.body.classList.add('cmp-on'); render(); }
    function close() { root.classList.remove('open'); document.body.classList.remove('cmp-on'); queue = []; }
    return { open, close };
  };
})();
