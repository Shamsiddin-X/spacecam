/* Собственный HiPS-движок: вSepебесные мозаики (IRSA, CDS) прямо в WebGL, без сторонних библиотек.
 * Нижний слой — мозаика Allsky 3-го порядка (одна картинка на всё небо), поверх при приближении
 * подгружаются тайлы 512×512 нужного порядка. Для куба SPHEREx можно выбрать любой из 102 каналов.
 */
(function () {
  const SW = (window.SW = window.SW || {});

  const SURVEYS = [
    { id: 'spherex', name: 'SPHEREx DR1', sub: '0.75–5.0 µm · 102 channels', base: 'https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube', fmt: 'png', maxOrder: 5, cube: true, mono: true },
    { id: 'allwise', name: 'AllWISE', sub: '3.4 · 4.6 · 22 µm', base: 'https://irsa.ipac.caltech.edu/data/hips/CDS/AllWISE/RGB-W4-W2-W1', alt: 'https://alasky.cds.unistra.fr/AllWISE/RGB-W4-W2-W1', fmt: 'jpg', maxOrder: 8 },
    { id: '2mass', name: '2MASS', sub: '1.2 · 1.6 · 2.2 µm', base: 'https://irsa.ipac.caltech.edu/data/hips/CDS/2MASS/Color', alt: 'https://alasky.cds.unistra.fr/2MASS/Color', fmt: 'jpg', maxOrder: 9 },
    { id: 'ps1', name: 'Pan-STARRS', sub: '0.48–0.87 µm · north', base: 'https://alasky.cds.unistra.fr/Pan-STARRS/DR1/color-z-zg-g', fmt: 'jpg', maxOrder: 11 },
    { id: 'dss', name: 'DSS2', sub: 'visible light · 1985–2000', base: 'https://irsa.ipac.caltech.edu/data/hips/CDS/DSS2/color', alt: 'https://alasky.cds.unistra.fr/DSS/DSSColor', fmt: 'jpg', maxOrder: 9 },
  ];
  const GRID = 8;

  function loadImage(url, timeout = 20000) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      const t = setTimeout(() => { img.src = ''; rej(new Error('timeout')); }, timeout);
      img.onload = () => { clearTimeout(t); res(img); };
      img.onerror = () => { clearTimeout(t); rej(new Error('load')); };
      img.src = url;
    });
  }

  class HipsLayer {
    constructor(gl) {
      this.gl = gl;
      this.survey = SURVEYS[0];
      this.frame = 0;
      this.allsky = null;
      this.tiles = new Map();
      this.queue = [];
      this.loading = 0;
      this.maxLoading = 6;
      this.maxTiles = 220;
      this.listeners = new Set();
      this.generation = 0;
    }
    onChange(fn) { this.listeners.add(fn); }
    emit(ev) { this.listeners.forEach((fn) => fn(ev)); }
    suffix() { return this.survey.cube && this.frame > 0 ? `_${this.frame}` : ''; }
    tileUrl(order, ipix) {
      const dir = Math.floor(ipix / 10000) * 10000;
      return `${this.survey.base}/Norder${order}/Dir${dir}/Npix${ipix}${this.suffix()}.${this.survey.fmt}`;
    }
    allskyUrl() { return `${this.survey.base}/Norder3/Allsky${this.suffix()}.${this.survey.fmt}`; }

    async set(surveyId, frame = this.frame) {
      const s = SURVEYS.find((x) => x.id === surveyId) || SURVEYS[0];
      this.survey = s;
      this.frame = s.cube ? frame : 0;
      this.clearTiles();
      const gen = ++this.generation;
      this.emit({ type: 'loading', survey: s });
      try {
        // The initial channel ships with the site; zoom tiles and other channels stay live.
        let img;
        if (s.id === 'spherex' && this.frame === 0) {
          try { img = await loadImage('assets/spherex-allsky.png', 10000); } catch (_) { /* try the archive */ }
        }
        if (!img) img = await loadImage(this.allskyUrl(), 20000);
        if (gen !== this.generation) return;
        const tex = this.texture(img);
        if (this.allsky) this.gl.deleteTexture(this.allsky.tex);
        this.allsky = { tex, w: img.naturalWidth, h: img.naturalHeight };
        this.emit({ type: 'ready', survey: s });
      } catch (e) {
        if (gen !== this.generation) return;
        this.emit({ type: 'error', survey: s, error: e });
      }
    }

    texture(img) {
      const gl = this.gl;
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    }

    clearTiles() {
      const gl = this.gl;
      for (const t of this.tiles.values()) { if (t.tex) gl.deleteTexture(t.tex); if (t.vb) gl.deleteBuffer(t.vb); }
      this.tiles.clear();
      this.queue = [];
    }

    /** геометрия тайла: сетка GRID×GRID на единичной сфере + UV внутри картинки тайла */
    patch(order, ipix) {
      const H = SW.healpix;
      const { face, ix, iy } = H.pix2fxy(order, ipix);
      const ns = 2 ** order;
      const vert = (u, v) => {
        const a = H.fxy2ang(face, (ix + u) / ns, (iy + v) / ns);
        const c = Math.sqrt(Math.max(0, 1 - a.z * a.z));
        // в картинке тайла HiPS: столбец ← ось y грани, строка ← ось x грани
        return [c * Math.cos(a.phi), a.z, -c * Math.sin(a.phi), v, u];
      };
      const data = [];
      for (let i = 0; i < GRID; i++) for (let j = 0; j < GRID; j++) {
        const u0 = i / GRID, u1 = (i + 1) / GRID, v0 = j / GRID, v1 = (j + 1) / GRID;
        const p00 = vert(u0, v0), p10 = vert(u1, v0), p01 = vert(u0, v1), p11 = vert(u1, v1);
        data.push(...p00, ...p10, ...p11, ...p00, ...p11, ...p01);
      }
      const gl = this.gl;
      const vb = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vb);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
      return vb;
    }

    want(order, list, now) {
      const ready = [];
      for (const ipix of list) {
        const key = `${order}/${ipix}`;
        let t = this.tiles.get(key);
        if (!t) { t = { order, ipix, state: 'queued', used: now }; this.tiles.set(key, t); this.queue.push(t); }
        t.used = now;
        if (t.state === 'ready') ready.push(t);
      }
      this.pump();
      this.evict();
      return ready;
    }

    pump() {
      this.queue.sort((a, b) => b.used - a.used);
      while (this.loading < this.maxLoading && this.queue.length) {
        const t = this.queue.shift();
        if (t.state !== 'queued') continue;
        t.state = 'loading';
        this.loading++;
        const gen = this.generation;
        loadImage(this.tileUrl(t.order, t.ipix))
          .then((img) => {
            if (gen !== this.generation) return;
            t.tex = this.texture(img);
            t.vb = this.patch(t.order, t.ipix);
            t.state = 'ready';
          })
          .catch(() => { t.state = 'failed'; })
          .finally(() => { this.loading--; this.pump(); });
      }
    }

    evict() {
      if (this.tiles.size <= this.maxTiles) return;
      const arr = [...this.tiles.entries()].filter(([, t]) => t.state === 'ready' || t.state === 'failed').sort((a, b) => a[1].used - b[1].used);
      const gl = this.gl;
      for (let i = 0; i < arr.length && this.tiles.size > this.maxTiles; i++) {
        const [k, t] = arr[i];
        if (t.tex) gl.deleteTexture(t.tex);
        if (t.vb) gl.deleteBuffer(t.vb);
        this.tiles.delete(k);
      }
    }
  }

  SW.HipsLayer = HipsLayer;
  SW.HIPS_SURVEYS = SURVEYS;
  SW.HIPS_GRID = GRID;
})();
