/* SPHEREx Sky Watch — движок сцены на чистом WebGL.
 * Два режима камеры:
 *   orbit — Earth в центре, вокруг небесная сфера с настоящим небом SPHEREx и сеткой координат;
 *   sky   — камера в центре сферы, свободный обзор неба с приближением до тайлов 512×512.
 * Переход между ними — «нырок» через Землю.
 */
(function () {
  const SW = (window.SW = window.SW || {});
  const SKY_R = 50, ORBIT_R = 1 + 700 / 6371, SWATH_HALF_DEG = 6;
  const EARTH_TEX = {
    day: ['assets/earth-day.jpg', 'https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg'],
    night: ['assets/earth-night.jpg', 'https://unpkg.com/three-globe/example/img/earth-night.jpg'],
  };

  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const mulS = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const len = (a) => Math.hypot(a[0], a[1], a[2]);
  const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  function perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
  }
  const upFor = (f) => (Math.abs(f[1]) > 0.995 ? [0, 0, -1] : [0, 1, 0]);
  function lookDir(eye, f, up) {
    const z = mulS(f, -1), x = norm(cross(up, z)), y = cross(z, x);
    return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
  }
  function mat4mul(a, b) {
    const o = new Float32Array(16);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k]; o[i * 4 + j] = s; }
    return o;
  }
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const NICE = [45, 30, 15, 10, 5, 2, 1, 0.5, 0.25, 1 / 6, 1 / 12, 1 / 30, 1 / 60];

  SW.createScene = function (canvas, overlay, opts = {}) {
    const A = SW.astro, D = A.D2R;
    const gl = canvas.getContext('webgl', { antialias: true, alpha: false }) || canvas.getContext('experimental-webgl');
    if (!gl) throw new Error('WebGL is not available in this browser');
    const g2 = overlay.getContext('2d');

    // ---------- программы ----------
    function compile(type, src) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src.replace(/[^\x00-\x7F]/g, '')); // GLSL ES допускает только ASCII
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('GLSL: ' + gl.getShaderInfoLog(s));
      return s;
    }
    function program(vs, fs) {
      const p = gl.createProgram();
      gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
      gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('GLSL link: ' + gl.getProgramInfoLog(p));
      const u = {}, a = {};
      for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i++) { const n = gl.getActiveUniform(p, i).name; u[n] = gl.getUniformLocation(p, n); }
      for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES); i++) { const n = gl.getActiveAttrib(p, i).name; a[n] = gl.getAttribLocation(p, n); }
      return { p, u, a };
    }
    const S = SW.SHADERS;
    const P = {
      earth: program(S.mesh, S.earth), atmo: program(S.mesh, S.atmo), sky: program(S.mesh, S.sky),
      cover: program(S.mesh, S.cover), region: program(S.mesh, S.region), tile: program(S.tileV, S.tileF), line: program(S.line, S.lineF), point: program(S.pointV, S.pointF),
    };
    const buffer = (data, target = gl.ARRAY_BUFFER, usage = gl.STATIC_DRAW) => { const b = gl.createBuffer(); gl.bindBuffer(target, b); gl.bufferData(target, data, usage); return b; };

    // ---------- геометрия ----------
    const sph = (() => {
      const pos = [], idx = [], LAT = 96, LON = 160;
      for (let i = 0; i <= LAT; i++) { const th = (i / LAT) * Math.PI; for (let j = 0; j <= LON; j++) { const ph = (j / LON) * 2 * Math.PI; pos.push(Math.sin(th) * Math.cos(ph), Math.cos(th), -Math.sin(th) * Math.sin(ph)); } }
      for (let i = 0; i < LAT; i++) for (let j = 0; j < LON; j++) { const a = i * (LON + 1) + j, b = a + LON + 1; idx.push(a, b, a + 1, b, b + 1, a + 1); }
      return { vb: buffer(new Float32Array(pos)), ib: buffer(new Uint16Array(idx), gl.ELEMENT_ARRAY_BUFFER), count: idx.length };
    })();
    const v3 = (ra, dec, r) => { const p = A.raDecToVec(ra, dec, r); return [p.x, p.y, p.z]; };
    function lineBuf(segs, color, alpha, dynamic) {
      const arr = new Float32Array(segs.length * 3); segs.forEach((p, i) => arr.set(p, i * 3));
      return { vb: buffer(arr, gl.ARRAY_BUFFER, dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW), count: segs.length, color, alpha };
    }
    function setLines(l, segs) {
      const arr = new Float32Array(segs.length * 3); segs.forEach((p, i) => arr.set(p, i * 3));
      gl.bindBuffer(gl.ARRAY_BUFFER, l.vb); gl.bufferData(gl.ARRAY_BUFFER, arr, gl.DYNAMIC_DRAW); l.count = segs.length;
    }
    const curve = (fn, n = 360) => { const s = []; for (let i = 0; i < n; i++) s.push(fn((i / n) * 2 * Math.PI), fn(((i + 1) / n) * 2 * Math.PI)); return s; };
    const staticGrid = [];
    for (let h = 0; h < 24; h++) for (let d = -88; d < 88; d += 2) staticGrid.push(v3(h * 15 * D, d * D, SKY_R), v3(h * 15 * D, (d + 2) * D, SKY_R));
    for (let d = -80; d <= 80; d += 10) { if (d) for (let r = 0; r < 360; r += 2) staticGrid.push(v3(r * D, d * D, SKY_R), v3((r + 2) * D, d * D, SKY_R)); }
    const L = {
      grid: lineBuf(staticGrid, [0.86, 0.89, 0.96], 0.085),
      skyGrid: lineBuf([[0, 0, 0], [0, 0, 0]], [0.86, 0.89, 0.96], 0.2, true),
      equator: lineBuf(curve((t) => v3(t, 0, SKY_R)), [0.9, 0.93, 1.0], 0.26),
      ecliptic: lineBuf(curve((t) => { const e = A.eclToEq(t, 0); return v3(e.ra, e.dec, SKY_R); }), [1.0, 0.55, 0.3], 0.5),
      galactic: lineBuf(curve((t) => { const e = A.galToEq(t, 0); return v3(e.ra, e.dec, SKY_R); }), [0.86, 0.82, 1.0], 0.16),
      sectors: lineBuf((() => {
        const seg = [];
        for (let r = 0; r < 360; r += 30) for (let d = -90; d < 90; d += 2) seg.push(v3(r * D, d * D, SKY_R), v3(r * D, (d + 2) * D, SKY_R));
        for (const d of [-60, -30, 0, 30, 60]) for (let r = 0; r < 360; r += 2) seg.push(v3(r * D, d * D, SKY_R), v3((r + 2) * D, d * D, SKY_R));
        return seg;
      })(), [0.9, 0.92, 1.0], 0.2),
      orbit: lineBuf([[0, 0, 0], [0, 0, 0]], [1.0, 0.6, 0.36], 0.6, true),
      beam: lineBuf([[0, 0, 0], [0, 0, 0]], [1.0, 0.6, 0.36], 0.32, true),
    };
    // запасной звёздный фон — только пока не загрузилось настоящее небо
    const stars = (() => {
      const N = 7000, pos = new Float32Array(N * 3), col = new Float32Array(N * 3), size = new Float32Array(N);
      let a = 20250501;
      const rnd = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
      for (let i = 0; i < N; i++) {
        let ra, dec;
        if (i < N * 0.45) { const u = Math.max(1e-9, rnd()), v = rnd(); const e = A.galToEq(rnd() * 2 * Math.PI, Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * 0.1); ra = e.ra; dec = e.dec; }
        else { ra = rnd() * 2 * Math.PI; dec = Math.asin(2 * rnd() - 1); }
        pos.set(v3(ra, dec, SKY_R * 1.5), i * 3);
        const k = 0.25 + Math.pow(rnd(), 2) * 0.8, t = rnd();
        col.set(t < 0.2 ? [k, k * 0.8, k * 0.62] : t < 0.4 ? [k * 0.75, k * 0.82, k] : [k, k, k], i * 3);
        size[i] = 1.1 + Math.pow(rnd(), 7) * 3.2;
      }
      return { pos: buffer(pos), col: buffer(col), size: buffer(size), count: N };
    })();
    const sprites = { pos: buffer(new Float32Array(6), gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW), col: buffer(new Float32Array([1, 0.86, 0.66, 1, 0.75, 0.5])), size: buffer(new Float32Array([120, 13])), count: 2 };

    // ---------- текстуры Земли (если сеть разрешает) ----------
    const earthTex = { day: null, night: null };
    const loadTex = (url) => new Promise((res) => {
      const img = new Image(); img.crossOrigin = 'anonymous';
      const t = setTimeout(() => { img.onload = img.onerror = null; img.src = ''; res(null); }, 20000);
      img.onload = () => {
        clearTimeout(t);
        try {
          const x = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, x);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
          [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T].forEach((p) => gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE));
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          res(x);
        } catch (_) { res(null); }
      };
      img.onerror = () => { clearTimeout(t); res(null); };
      img.src = url;
    });
    const earthPending = {};
    function loadEarthTexture(kind) {
      if (earthTex[kind]) return Promise.resolve();
      if (earthPending[kind]) return earthPending[kind];
      earthPending[kind] = (async () => {
        for (const url of EARTH_TEX[kind]) {
          const texture = await loadTex(url);
          if (texture) { earthTex[kind] = texture; return; }
        }
        throw new Error(`Earth ${kind} texture is unavailable`);
      })().finally(() => { delete earthPending[kind]; });
      return earthPending[kind];
    }

    const hips = new SW.HipsLayer(gl);

    // ---------- состояние ----------
    const st = {
      mode: 'orbit', date: new Date(), active: true,
      theta: 0.45, phi: 1.3, dist: 46, eye: [0, 0, 46], vT: 0, vP: 0, auto: false,
      lookRa: 270 * D, lookDec: 66.56 * D, fov: 45, skyFov: 30, earthFade: 1, skyGain: 0.62,
      fly: null, cover: true, orbitOn: true, gridOn: true, labelsOn: true,
      sunDir: [1, 0, 0], ou: [1, 0, 0], ov: [0, 0, 1], rot: 0, lam0: 0, lam1: 0, sat: 0,
      w: 1, h: 1, dpr: 1, vp: null, fwd: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0],
      pins: [], picked: null, gamma: 1.0, gain: 1.0,
      skyOn: true, sectorsOn: true, hoverSec: null, selSec: null, field: null, lastClick: 0,
    };
    const eyeOrbit = () => [st.dist * Math.sin(st.phi) * Math.sin(st.theta), st.dist * Math.cos(st.phi), st.dist * Math.sin(st.phi) * Math.cos(st.theta)];
    st.eye = eyeOrbit();
    const HOME = { theta: 0.45, phi: 1.36, dist: 5.6 };

    function applyDate() {
      const s = A.sunRaDec(st.date);
      st.sunDir = norm(v3(s.ra, s.dec, 1));
      const now = new Date();
      const eff = new Date(Date.UTC(st.date.getUTCFullYear(), st.date.getUTCMonth(), st.date.getUTCDate(), now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds()));
      st.rot = A.gmstDeg(eff) * D;
      st.lam0 = A.sunEclLonUnwrapped(A.MISSION_START);
      st.lam1 = st.date > A.MISSION_START ? A.sunEclLonUnwrapped(st.date) : st.lam0;
      // орбита по терминатору: нормаль к плоскости орбиты смотрит на Солнце
      const n = st.sunDir, ref = Math.abs(n[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
      st.ou = norm(cross(n, ref)); st.ov = cross(n, st.ou);
      setLines(L.orbit, curve((t) => add(mulS(st.ou, Math.cos(t) * ORBIT_R), mulS(st.ov, Math.sin(t) * ORBIT_R)), 180));
    }
    applyDate();

    function resize() {
      st.dpr = Math.min(window.devicePixelRatio || 1, 2);
      st.w = canvas.clientWidth || window.innerWidth; st.h = canvas.clientHeight || window.innerHeight;
      canvas.width = overlay.width = Math.round(st.w * st.dpr);
      canvas.height = overlay.height = Math.round(st.h * st.dpr);
    }
    resize();
    window.addEventListener('resize', resize);

    // ---------- камера ----------
    function updateCamera(now, dt) {
      if (st.fly) {
        const f = st.fly, t = clamp((now - f.t0) / f.ms, 0, 1), k = easeInOut(t);
        st.eye = lerp(f.e0, f.e1, k);
        st.fwd = norm(lerp(f.f0, f.f1, k));
        st.fov = f.fov0 + (f.fov1 - f.fov0) * k;
        st.earthFade = f.ef0 + (f.ef1 - f.ef0) * k;
        st.skyGain = f.g0 + (f.g1 - f.g0) * k;
        if (t >= 1) { st.fly = null; f.done && f.done(); }
      } else if (st.mode === 'orbit') {
        if (!drag) { st.vT *= 0.93; st.vP *= 0.93; st.theta += st.vT + (st.auto ? dt * 0.025 : 0); st.phi = clamp(st.phi + st.vP, 0.08, Math.PI - 0.08); }
        st.eye = eyeOrbit();
        st.fwd = norm(mulS(st.eye, -1));
        st.fov = 45;
      } else if (st.mode === 'sky') {
        st.eye = [0, 0, 0];
        st.fwd = norm(v3(st.lookRa, st.lookDec, 1));
        st.fov = st.skyFov;
      }
      let up0 = upFor(st.fwd);
      if (st.mode === 'sky' && !st.fly) up0 = Math.abs(st.lookDec) > 89.5 * D ? [-Math.cos(st.lookRa), 0, Math.sin(st.lookRa)] : [0, 1, 0];
      st.right = norm(cross(st.fwd, up0));
      st.up = cross(st.right, st.fwd);
      st.vp = mat4mul(perspective(st.fov * D, st.w / st.h, 0.005, 400), lookDir(st.eye, st.fwd, st.up));
    }
    function rayAt(x, y) {
      const nx = (x / st.w) * 2 - 1, ny = -((y / st.h) * 2 - 1), t = Math.tan((st.fov * D) / 2);
      return norm(add(st.fwd, add(mulS(st.right, nx * t * (st.w / st.h)), mulS(st.up, ny * t))));
    }
    function skyAt(x, y) {
      const o = st.eye, d = rayAt(x, y);
      const b = dot(o, d);
      if (st.mode === 'orbit' && st.earthFade > 0.5) {
        const c = dot(o, o) - 1, disc = b * b - c;
        if (disc > 0 && -b - Math.sqrt(disc) > 0) return null; // луч упирается в Землю
      }
      const c = dot(o, o) - SKY_R * SKY_R, t = -b + Math.sqrt(Math.max(0, b * b - c));
      const p = add(o, mulS(d, t)), rd = A.vecToRaDec(p[0], p[1], p[2]);
      return { ra: rd.ra / D, dec: rd.dec / D, p };
    }
    function project(p) {
      const m = st.vp;
      const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
      if (w <= 0.001) return null;
      return [((x / w) * 0.5 + 0.5) * st.w, (0.5 - (y / w) * 0.5) * st.h];
    }
    function behindEarth(p) {
      if (st.mode !== 'orbit' || st.earthFade < 0.5) return false;
      const o = st.eye, d0 = sub(p, o), l = len(d0), d = mulS(d0, 1 / l), b = dot(o, d), c = dot(o, o) - 1, disc = b * b - c;
      if (disc <= 0) return false;
      const t = -b - Math.sqrt(disc);
      return t > 0 && t < l;
    }

    // ---------- ввод ----------
    let drag = null;
    const touches = new Map();
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      touches.set(e.pointerId, [e.clientX, e.clientY]);
      drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY };
      st.auto = false;
    });
    canvas.addEventListener('pointermove', (e) => {
      const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      if (touches.size === 2 && touches.has(e.pointerId)) {
        const [a, b] = [...touches.values()], before = Math.hypot(a[0] - b[0], a[1] - b[1]);
        touches.set(e.pointerId, [e.clientX, e.clientY]);
        const [c, d] = [...touches.values()], after = Math.hypot(c[0] - d[0], c[1] - d[1]);
        if (before > 0 && after > 0) zoom(before / after);
        return;
      }
      if (touches.has(e.pointerId)) touches.set(e.pointerId, [e.clientX, e.clientY]);
      if (drag && (e.buttons & 1) && !st.fly) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        drag.x = e.clientX; drag.y = e.clientY;
        if (st.mode === 'orbit') {
          const k = 0.0045 * clamp(st.dist / 7, 0.3, 1.2);
          st.vT = -dx * k; st.vP = -dy * k; st.theta += st.vT; st.phi = clamp(st.phi + st.vP, 0.08, Math.PI - 0.08);
        } else if (st.mode === 'sky') {
          const k = (st.skyFov * D) / st.h;
          st.lookRa = (st.lookRa + (dx * k) / Math.max(0.05, Math.cos(st.lookDec)) + 2 * Math.PI) % (2 * Math.PI);
          st.lookDec = clamp(st.lookDec + dy * k, -89.9 * D, 89.9 * D);
          emitView();
        }
      }
      const h = skyAt(x, y);
      st.hoverSec = h && st.mode === 'orbit' && st.sectorsOn ? SW.sectors.at(h.ra, h.dec) : null;
      canvas.style.cursor = st.hoverSec ? 'pointer' : '';
      opts.onHover && opts.onHover(h ? { ra: h.ra, dec: h.dec } : null);
    });
    const end = (e) => {
      touches.delete(e.pointerId);
      if (!drag) return;
      const moved = Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0);
      drag = null;
      clearTimeout(st.autoTimer);
      st.autoTimer = setTimeout(() => { st.auto = st.mode === 'orbit'; }, 5000);
      if (moved > 5 || st.fly) return;
      const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      const pin = st.pins.find((p) => p.screen && Math.hypot(p.screen[0] - x, p.screen[1] - y) < 14);
      if (pin) { opts.onPin && opts.onPin(pin); return; }
      const p = skyAt(x, y);
      if (!p) return;
      const now = performance.now(), dbl = now - st.lastClick < 320;
      st.lastClick = now;
      if (st.mode === 'orbit') {
        if (dbl) { opts.onDive && opts.onDive({ ra: p.ra, dec: p.dec }); return; }
        if (st.sectorsOn) { st.selSec = SW.sectors.at(p.ra, p.dec); opts.onSector && opts.onSector(st.selSec, { ra: p.ra, dec: p.dec }); return; }
      }
      st.picked = p;
      opts.onPick && opts.onPick({ ra: p.ra, dec: p.dec, mode: st.mode });
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', (e) => { touches.delete(e.pointerId); drag = null; });
    canvas.addEventListener('wheel', (e) => { e.preventDefault(); zoom(Math.exp(e.deltaY * 0.0012)); }, { passive: false });
    function zoom(f) {
      if (st.fly) return;
      if (st.mode === 'orbit') st.dist = clamp(st.dist * f, 1.7, 46);
      else if (st.mode === 'sky') { st.skyFov = clamp(st.skyFov * f, 0.15, 110); emitView(); }
    }
    const emitView = () => opts.onView && opts.onView({ ra: st.lookRa / D, dec: st.lookDec / D, fov: st.skyFov });

    // ---------- переходы ----------
    function fly(spec, ms, done) {
      st.fly = { e0: st.eye.slice(), f0: st.fwd.slice(), fov0: st.fov, ef0: st.earthFade, g0: st.skyGain, t0: performance.now(), ms, done, ...spec };
    }
    function intro() {
      Object.assign(st, { theta: 0.9, phi: 1.1, dist: 46 });
      st.eye = eyeOrbit();
      Object.assign(st, HOME);
      const e1 = eyeOrbit();
      fly({ e1, f1: norm(mulS(e1, -1)), fov1: 45, ef1: 1, g1: 0.62 }, 2000, () => { st.auto = true; });
    }
    function enterSky(raDeg, decDeg, fovDeg, done) {
      st.auto = false;
      st.mode = 'transit';
      const dir = norm(v3(raDeg * D, decDeg * D, 1));
      fly({ e1: mulS(dir, 1.35), f1: dir, fov1: 40, ef1: 1, g1: 0.8 }, 1500, () => {
        fly({ e1: [0, 0, 0], f1: dir, fov1: fovDeg, ef1: 0, g1: 1 }, 1100, () => {
          Object.assign(st, { mode: 'sky', lookRa: raDeg * D, lookDec: decDeg * D, skyFov: fovDeg, earthFade: 0, skyGain: 1 });
          emitView(); done && done();
        });
      });
    }
    function exitSky(done) {
      if (st.mode !== 'sky') return;
      const dir = st.fwd.slice();
      st.mode = 'transit';
      fly({ e1: mulS(dir, 1.35), f1: dir, fov1: 45, ef1: 1, g1: 0.8 }, 1100, () => {
        const e = mulS(dir, 1.35);
        st.phi = Math.acos(clamp(e[1] / len(e), -1, 1)); st.theta = Math.atan2(e[0], e[2]); st.dist = HOME.dist;
        const e1 = eyeOrbit();
        fly({ e1, f1: norm(mulS(e1, -1)), fov1: 45, ef1: 1, g1: 0.62 }, 1500, () => { st.mode = 'orbit'; st.auto = true; done && done(); });
      });
    }

    // ---------- адаптивная сетка неба ----------
    let lastGridKey = '';
    const gridLabels = [];
    function updateSkyGrid() {
      const fov = st.skyFov, ra0 = st.lookRa / D, dec0 = st.lookDec / D, want = fov / 5;
      const stepDec = NICE.find((s) => s <= want) || NICE[NICE.length - 1];
      const cosd = Math.max(0.05, Math.cos(st.lookDec));
      const stepRa = NICE.find((s) => s <= want / cosd) || NICE[NICE.length - 1];
      const key = [stepDec, stepRa, Math.round(ra0 / stepRa), Math.round(dec0 / stepDec), Math.round(fov * 10)].join('|');
      if (key === lastGridKey) return;
      lastGridKey = key;
      const span = Math.min(180, fov * 1.6);
      const dMin = Math.max(-90, dec0 - span), dMax = Math.min(90, dec0 + span);
      const raSpan = Math.abs(dec0) + span >= 88 ? 180 : Math.min(180, span / cosd);
      const segs = [], nSub = 48;
      gridLabels.length = 0;
      for (let r = Math.floor((ra0 - raSpan) / stepRa) * stepRa; r <= ra0 + raSpan; r += stepRa) {
        for (let i = 0; i < nSub; i++) segs.push(v3(r * D, (dMin + ((dMax - dMin) * i) / nSub) * D, SKY_R), v3(r * D, (dMin + ((dMax - dMin) * (i + 1)) / nSub) * D, SKY_R));
        gridLabels.push({ text: A.fmtRA(((r % 360) + 360) % 360).replace(/\.\dˢ$/, 'ˢ'), ra: r, dec: dec0 - fov * 0.42 });
      }
      for (let d = Math.ceil(dMin / stepDec) * stepDec; d <= dMax; d += stepDec) {
        if (Math.abs(d) >= 89.999) continue;
        for (let i = 0; i < nSub; i++) segs.push(v3((ra0 - raSpan + (2 * raSpan * i) / nSub) * D, d * D, SKY_R), v3((ra0 - raSpan + (2 * raSpan * (i + 1)) / nSub) * D, d * D, SKY_R));
        gridLabels.push({ text: A.fmtDec(d), ra: ra0 + (fov * 0.62 * (st.w / st.h)) / cosd, dec: d });
      }
      setLines(L.skyGrid, segs);
    }

    // ---------- тайлы ----------
    function visibleTiles(now) {
      const sv = hips.survey, pxDeg = st.skyFov / st.h;
      if (st.skyFov > 70) return [];
      let order = 3;
      while (order < sv.maxOrder && 58.63 / (2 ** order * 512) > pxDeg) order++;
      const set = new Set(), N = 14;
      for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
        const d = rayAt((i / N) * st.w, (j / N) * st.h), rd = A.vecToRaDec(d[0], d[1], d[2]);
        set.add(SW.healpix.ang2pix(order, Math.sin(rd.dec), rd.ra));
      }
      return hips.want(order, [...set], now);
    }

    // ---------- отрисовка ----------
    function bindMesh(pr) {
      gl.bindBuffer(gl.ARRAY_BUFFER, sph.vb);
      gl.enableVertexAttribArray(pr.a.aPos);
      gl.vertexAttribPointer(pr.a.aPos, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, sph.ib);
      gl.uniformMatrix4fv(pr.u.uVP, false, st.vp);
      gl.uniform3fv(pr.u.uOrigin, [0, 0, 0]);
    }
    function drawLine(l, mul = 1) {
      const pr = P.line; gl.useProgram(pr.p);
      gl.uniformMatrix4fv(pr.u.uVP, false, st.vp);
      gl.uniform4f(pr.u.uColor, l.color[0], l.color[1], l.color[2], l.alpha * mul);
      gl.bindBuffer(gl.ARRAY_BUFFER, l.vb); gl.enableVertexAttribArray(pr.a.aPos); gl.vertexAttribPointer(pr.a.aPos, 3, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.LINES, 0, l.count);
    }
    function drawPoints(set, glow, count = set.count) {
      const pr = P.point; gl.useProgram(pr.p);
      gl.uniformMatrix4fv(pr.u.uVP, false, st.vp); gl.uniform1f(pr.u.uPx, st.dpr); gl.uniform1f(pr.u.uGlow, glow ? 1 : 0);
      [['aPos', set.pos, 3], ['aColor', set.col, 3], ['aSize', set.size, 1]].forEach(([n, b, k]) => { gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.enableVertexAttribArray(pr.a[n]); gl.vertexAttribPointer(pr.a[n], k, gl.FLOAT, false, 0, 0); });
      gl.drawArrays(gl.POINTS, 0, count);
      gl.disableVertexAttribArray(pr.a.aColor); gl.disableVertexAttribArray(pr.a.aSize);
    }

    let last = performance.now();
    function frame(now) {
      requestAnimationFrame(frame);
      if (!st.active) { last = now; return; }
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      updateCamera(now, dt);
      const inSky = st.mode === 'sky';

      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0.004, 0.005, 0.012, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.disable(gl.DEPTH_TEST); gl.depthMask(false); gl.disable(gl.CULL_FACE);

      // 1. небо
      const sv = hips.survey;
      if (hips.allsky && (inSky || st.skyOn)) {
        gl.disable(gl.BLEND);
        const pr = P.sky; gl.useProgram(pr.p); bindMesh(pr);
        gl.uniform1f(pr.u.uScale, SKY_R);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, hips.allsky.tex); gl.uniform1i(pr.u.uAll, 0);
        gl.uniform2f(pr.u.uAllSize, hips.allsky.w, hips.allsky.h);
        gl.uniform1f(pr.u.uMono, sv.mono ? 1 : 0); gl.uniform1f(pr.u.uGain, st.skyGain * st.gain); gl.uniform1f(pr.u.uGamma, st.gamma);
        gl.drawElements(gl.TRIANGLES, sph.count, gl.UNSIGNED_SHORT, 0);
        if (inSky) {
          const tiles = visibleTiles(now);
          const tp = P.tile; gl.useProgram(tp.p);
          gl.uniformMatrix4fv(tp.u.uVP, false, st.vp); gl.uniform1f(tp.u.uScale, SKY_R * 0.999);
          gl.uniform1f(tp.u.uMono, sv.mono ? 1 : 0); gl.uniform1f(tp.u.uGain, st.gain); gl.uniform1f(tp.u.uGamma, st.gamma); gl.uniform1i(tp.u.uTex, 0);
          for (const t of tiles) {
            gl.bindBuffer(gl.ARRAY_BUFFER, t.vb);
            gl.enableVertexAttribArray(tp.a.aPos); gl.vertexAttribPointer(tp.a.aPos, 3, gl.FLOAT, false, 20, 0);
            gl.enableVertexAttribArray(tp.a.aUV); gl.vertexAttribPointer(tp.a.aUV, 2, gl.FLOAT, false, 20, 12);
            gl.bindTexture(gl.TEXTURE_2D, t.tex);
            gl.drawArrays(gl.TRIANGLES, 0, SW.HIPS_GRID * SW.HIPS_GRID * 6);
          }
          if (tp.a.aUV != null) gl.disableVertexAttribArray(tp.a.aUV);
        }
      } else {
        gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
        drawPoints(stars, false);
      }

      // 2. покрытие: ещё не снятое к выбранной дате небо затемнено, текущая полоса обзора подсвечена
      if (st.cover && !inSky) {
        gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        const pr = P.cover; gl.useProgram(pr.p); bindMesh(pr);
        gl.uniform1f(pr.u.uScale, SKY_R * 0.99);
        gl.uniform1f(pr.u.lam0, st.lam0); gl.uniform1f(pr.u.lam1, st.lam1);
        gl.uniform1f(pr.u.sinW, Math.sin(SWATH_HALF_DEG * D)); gl.uniform1f(pr.u.eps, A.OBLIQUITY); gl.uniform1f(pr.u.uOn, st.earthFade);
        gl.drawElements(gl.TRIANGLES, sph.count, gl.UNSIGNED_SHORT, 0);
      }

      // 2б. подсветка сектора
      if (!inSky && st.sectorsOn && (st.selSec || st.hoverSec)) {
        gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
        const pr = P.region; gl.useProgram(pr.p); bindMesh(pr);
        gl.uniform1f(pr.u.uScale, SKY_R * 0.985);
        const r4 = (q) => (q ? [q.raMin * D, q.raMax * D, q.decMin * D, q.decMax * D] : [0, 0, 0, 0]);
        gl.uniform4fv(pr.u.uSel, r4(st.selSec)); gl.uniform4fv(pr.u.uHov, r4(st.hoverSec));
        gl.uniform1f(pr.u.uSelOn, st.selSec ? 1 : 0); gl.uniform1f(pr.u.uHovOn, st.hoverSec ? 1 : 0);
        gl.uniform1f(pr.u.uTime, now / 1000);
        gl.drawElements(gl.TRIANGLES, sph.count, gl.UNSIGNED_SHORT, 0);
      }

      // 3. Earth и атмосфера
      if (st.earthFade > 0.01 && len(st.eye) > 1.01) {
        gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.clear(gl.DEPTH_BUFFER_BIT);
        if (st.earthFade < 0.999) { gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); } else gl.disable(gl.BLEND);
        const E = P.earth; gl.useProgram(E.p); bindMesh(E);
        gl.uniform1f(E.u.uScale, 1); gl.uniform3fv(E.u.uSun, st.sunDir); gl.uniform3fv(E.u.uEye, st.eye);
        gl.uniform1f(E.u.uRot, st.rot); gl.uniform1f(E.u.uFade, st.earthFade); gl.uniform1f(E.u.uHasTex, earthTex.day && earthTex.night ? 1 : 0);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, earthTex.day); gl.uniform1i(E.u.uDay, 0);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, earthTex.night); gl.uniform1i(E.u.uNight, 1);
        gl.activeTexture(gl.TEXTURE0);
        gl.drawElements(gl.TRIANGLES, sph.count, gl.UNSIGNED_SHORT, 0);
        gl.depthMask(false);
        if (len(st.eye) > 1.1) {
          gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
          gl.enable(gl.CULL_FACE); gl.cullFace(gl.FRONT);
          const At = P.atmo; gl.useProgram(At.p); bindMesh(At);
          gl.uniform1f(At.u.uScale, 1.09); gl.uniform3fv(At.u.uEye, st.eye); gl.uniform3fv(At.u.uSun, st.sunDir); gl.uniform1f(At.u.uFade, st.earthFade);
          gl.drawElements(gl.TRIANGLES, sph.count, gl.UNSIGNED_SHORT, 0);
          gl.disable(gl.CULL_FACE);
        }
      }

      // 4. линии и спрайты
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
      if (!inSky && st.sectorsOn && !st.gridOn) drawLine(L.sectors);
      if (st.gridOn) {
        if (inSky) { updateSkyGrid(); drawLine(L.skyGrid); }
        else drawLine(L.grid, 0.7 + 0.3 * clamp(st.dist / 12, 0, 1));
        if (!inSky && st.sectorsOn) drawLine(L.sectors);
        drawLine(L.equator); drawLine(L.ecliptic); drawLine(L.galactic);
      }
      st.sat += dt * 0.32;
      const sat = add(mulS(st.ou, Math.cos(st.sat) * ORBIT_R), mulS(st.ov, Math.sin(st.sat) * ORBIT_R));
      st.satPos = sat;
      if (!inSky) {
        gl.bindBuffer(gl.ARRAY_BUFFER, sprites.pos);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array([...mulS(st.sunDir, SKY_R * 0.97), ...sat]));
        if (st.orbitOn && st.earthFade > 0.5) {
          setLines(L.beam, [sat, mulS(norm(sat), SKY_R * 0.98)]);
          drawLine(L.orbit); drawLine(L.beam);
          drawPoints(sprites, true, 2);
        } else drawPoints(sprites, true, 1);
      }
      drawOverlay(now);
    }
    requestAnimationFrame(frame);

    // ---------- 2D-слой: подписи, метки, прицел ----------
    const FIX = [];
    for (let h = 0; h < 24; h += 2) FIX.push({ t: `${h}h`, p: v3(h * 15 * D, 1.6 * D, SKY_R), c: 'rgba(200,212,240,0.75)', f: '500 11px' });
    [-60, -30, 30, 60].forEach((d) => FIX.push({ t: `${d > 0 ? '+' : '−'}${Math.abs(d)}°`, p: v3(1.2 * D, d * D, SKY_R), c: 'rgba(200,212,240,0.6)', f: '500 11px' }));
    { const e = A.eclToEq(150 * D, 2.2 * D); FIX.push({ t: 'ECLIPTIC', p: v3(e.ra, e.dec, SKY_R), c: 'rgba(255,170,110,0.9)', f: '600 10px', sp: 2 }); }
    { const e = A.galToEq(40 * D, 2.2 * D); FIX.push({ t: 'GALACTIC PLANE', p: v3(e.ra, e.dec, SKY_R), c: 'rgba(200,180,255,0.85)', f: '600 10px', sp: 2 }); }
    FIX.push({ t: 'CELESTIAL EQUATOR', p: v3(205 * D, 1.8 * D, SKY_R), c: 'rgba(170,200,255,0.85)', f: '600 10px', sp: 2 });
    FIX.push({ t: 'N', p: v3(0, 89.4 * D, SKY_R), c: 'rgba(230,236,255,0.9)', f: '600 12px' });
    FIX.push({ t: 'S', p: v3(0, -89.4 * D, SKY_R), c: 'rgba(230,236,255,0.9)', f: '600 12px' });

    function text(t, x, y, color, font, spacing = 0, align = 'center') {
      g2.font = `${font} "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace`;
      g2.textAlign = align; g2.textBaseline = 'middle';
      if ('letterSpacing' in g2) g2.letterSpacing = `${spacing}px`;
      g2.fillStyle = 'rgba(0,0,0,0.6)'; g2.fillText(t, x + 1, y + 1);
      g2.fillStyle = color; g2.fillText(t, x, y);
      if ('letterSpacing' in g2) g2.letterSpacing = '0px';
    }
    function drawOverlay(now) {
      g2.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
      g2.clearRect(0, 0, st.w, st.h);
      const inSky = st.mode === 'sky';
      if (st.labelsOn && st.gridOn) {
        if (!inSky) {
          // подписи появляются только при приближении: на общем плане — чистая картинка
          const k = clamp((4.8 - st.dist) / 1.2, 0, 1);
          if (k > 0.01 && !st.fly) {
            g2.globalAlpha = k;
            for (const l of FIX) { if (behindEarth(l.p)) continue; const s = project(l.p); if (s) text(l.t, s[0], s[1], l.c, l.f, l.sp); }
            if (st.orbitOn && st.earthFade > 0.5 && st.satPos && !behindEarth(st.satPos)) { const s = project(st.satPos); if (s) text('SPHEREx', s[0] + 10, s[1] - 10, 'rgba(255,200,160,0.95)', '600 10px', 1, 'left'); }
            g2.globalAlpha = 1;
          }
        } else {
          for (const l of gridLabels) { const s = project(v3(l.ra * D, l.dec * D, SKY_R)); if (s && s[0] > 40 && s[0] < st.w - 40 && s[1] > 20 && s[1] < st.h - 20) text(l.text, s[0], s[1], 'rgba(205,215,240,0.7)', '500 10px'); }
          if (st.skyFov < 60) for (const o of A.OBJECTS) {
            const p = v3(o.ra * D, o.dec * D, SKY_R);
            if (dot(norm(p), st.fwd) < 0) continue;
            const s = project(p);
            if (!s || s[0] < 0 || s[0] > st.w || s[1] < 0 || s[1] > st.h) continue;
            g2.strokeStyle = 'rgba(255,255,255,0.55)'; g2.lineWidth = 1; g2.beginPath(); g2.arc(s[0], s[1], 5, 0, Math.PI * 2); g2.stroke();
            text(o.label || o.name, s[0] + 10, s[1], 'rgba(235,240,255,0.85)', '500 11px', 0.5, 'left');
          }
        }
      }
      if (!inSky && st.sectorsOn && !st.fly) {
        for (const q of [st.hoverSec, st.selSec]) {
          if (!q) continue;
          const c = v3(q.ra * D, q.dec * D, SKY_R);
          if (behindEarth(c)) continue;
          const s2 = project(c);
          if (s2) text(q.id, s2[0], s2[1], q === st.selSec ? 'rgba(255,170,130,1)' : 'rgba(236,238,243,0.85)', '600 13px', 2);
        }
      }
      if (st.overlayHook) { try { st.overlayHook(g2); } catch (_) { /* hook error */ } }
      if (inSky && st.field) {
        const f = st.field, h2 = f.size / 2, cd = Math.cos(f.dec * D);
        const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => project(v3((f.ra + (sx * h2) / Math.max(cd, 0.05)) * D, (f.dec + sy * h2) * D, SKY_R)));
        if (corners.every(Boolean)) {
          g2.strokeStyle = 'rgba(255,122,69,0.95)'; g2.lineWidth = 1.5; g2.beginPath();
          corners.forEach((c, i) => (i ? g2.lineTo(c[0], c[1]) : g2.moveTo(c[0], c[1]))); g2.closePath(); g2.stroke();
          g2.fillStyle = 'rgba(255,122,69,0.06)'; g2.fill();
          const top = corners.reduce((a, b) => (b[1] < a[1] ? b : a));
          text(f.label || 'SELECTED', top[0], top[1] - 12, 'rgba(255,170,130,1)', '600 11px', 1.5);
        }
      }
      for (const p of st.pins) {
        const w = v3(p.ra * D, p.dec * D, SKY_R);
        p.screen = null;
        if (behindEarth(w) || (inSky && dot(norm(w), st.fwd) < 0)) continue;
        const s = project(w); if (!s) continue;
        p.screen = s;
        const pulse = 0.5 + 0.5 * Math.sin(now / 420 + p.ra);
        g2.strokeStyle = `rgba(255,122,69,${0.55 + 0.45 * pulse})`; g2.lineWidth = 1.5;
        g2.beginPath(); g2.arc(s[0], s[1], 6 + 3 * pulse, 0, Math.PI * 2); g2.stroke();
        g2.fillStyle = '#ff7a45'; g2.beginPath(); g2.arc(s[0], s[1], 2.2, 0, Math.PI * 2); g2.fill();
        if (p.label) text(p.label, s[0] + 12, s[1], 'rgba(255,190,160,0.95)', '600 10px', 1, 'left');
      }
      if (st.picked && !behindEarth(st.picked.p)) {
        const s = project(st.picked.p);
        if (s) {
          const r = 16;
          g2.strokeStyle = '#ffffff'; g2.lineWidth = 1.2; g2.beginPath();
          [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([sx, sy]) => { g2.moveTo(s[0] + sx * r, s[1] + sy * (r - 6)); g2.lineTo(s[0] + sx * r, s[1] + sy * r); g2.lineTo(s[0] + sx * (r - 6), s[1] + sy * r); });
          g2.stroke();
        }
      }
      if (inSky && !st.fly) {
        const cx = st.w / 2, cy = st.h / 2;
        g2.strokeStyle = 'rgba(255,255,255,0.5)'; g2.lineWidth = 1; g2.beginPath();
        g2.moveTo(cx - 18, cy); g2.lineTo(cx - 6, cy); g2.moveTo(cx + 6, cy); g2.lineTo(cx + 18, cy);
        g2.moveTo(cx, cy - 18); g2.lineTo(cx, cy - 6); g2.moveTo(cx, cy + 6); g2.lineTo(cx, cy + 18); g2.stroke();
      }
    }

    return {
      hips,
      loadEarthTexture,
      get mode() { return st.mode; },
      setDate(d) { st.date = d; applyDate(); },
      setActive(on) { st.active = on; },
      setCoverage(on) { st.cover = on; },
      setOrbit(on) { st.orbitOn = on; },
      setGrid(on) { st.gridOn = on; },
      setLabels(on) { st.labelsOn = on; },
      setTone(gain, gamma) { st.gain = gain; st.gamma = gamma; },
      setSkyMap(on) { st.skyOn = on; },
      setSectors(on) { st.sectorsOn = on; if (!on) { st.hoverSec = null; } },
      selectSector(q) { st.selSec = q; },
      setField(f) { st.field = f; },
      onOverlay(fn) { st.overlayHook = fn; },
      get sectorsOn() { return st.sectorsOn; },
      project(ra, dec) { const p = v3(ra * D, dec * D, SKY_R); if (behindEarth(p) || (st.mode === 'sky' && dot(norm(p), st.fwd) < 0)) return null; return project(p); },
      home() { if (st.mode === 'orbit' && !st.fly) { Object.assign(st, HOME); } },
      setPins(pins) { st.pins = pins.map((p) => ({ ...p })); },
      clearPick() { st.picked = null; },
      intro, enterSky, exitSky,
      goto(ra, dec, fov) { if (st.mode !== 'sky') return; st.lookRa = ra * D; st.lookDec = dec * D; if (fov) st.skyFov = fov; emitView(); },
      view() { return { ra: st.lookRa / D, dec: st.lookDec / D, fov: st.skyFov }; },
    };
  };
})();
