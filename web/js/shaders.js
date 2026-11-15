/* GLSL-шейдеры сцены (WebGL 1, без расширений) */
(function () {
  const SW = (window.SW = window.SW || {});
  const PREC = `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
`;
  const IRMAP = `
    vec3 irmap(float t){
      t = clamp(t, 0.0, 1.0);
      vec3 c0 = vec3(0.004, 0.004, 0.018), c1 = vec3(0.13, 0.04, 0.30), c2 = vec3(0.50, 0.11, 0.42);
      vec3 c3 = vec3(0.88, 0.32, 0.22), c4 = vec3(0.99, 0.72, 0.30), c5 = vec3(1.0, 0.98, 0.90);
      if (t < 0.2) return mix(c0, c1, t / 0.2);
      if (t < 0.4) return mix(c1, c2, (t - 0.2) / 0.2);
      if (t < 0.62) return mix(c2, c3, (t - 0.4) / 0.22);
      if (t < 0.84) return mix(c3, c4, (t - 0.62) / 0.22);
      return mix(c4, c5, (t - 0.84) / 0.16);
    }`;

  SW.SHADERS = {
    mesh: `attribute vec3 aPos; uniform mat4 uVP; uniform vec3 uOrigin; uniform float uScale; varying vec3 vW; varying vec3 vD;
      void main(){ vD = aPos; vW = aPos * uScale; gl_Position = uVP * vec4(vW + uOrigin, 1.0); }`,

    earth: PREC + `
      uniform vec3 uSun; uniform vec3 uEye; uniform float uRot; uniform float uFade;
      uniform sampler2D uDay; uniform sampler2D uNight; uniform float uHasTex;
      varying vec3 vW;
      void main(){
        vec3 n = normalize(vW);
        float c = cos(uRot), s = sin(uRot);
        vec3 L = vec3(n.x * c - n.z * s, n.y, n.x * s + n.z * c);
        float lat = asin(clamp(L.y, -1.0, 1.0));
        float lon = atan(-L.z, L.x);
        float ndl = dot(n, uSun);
        float dayMix = smoothstep(-0.10, 0.20, ndl);
        vec3 V = normalize(uEye - vW);
        vec3 col;
        if (uHasTex > 0.5) {
          vec2 uv = vec2((lon + 3.1415927) / 6.2831853, 0.5 + lat / 3.1415927);
          vec3 day = texture2D(uDay, uv).rgb;
          vec3 night = texture2D(uNight, uv).rgb;
          float ocean = 1.0 - smoothstep(0.08, 0.2, max(day.r, day.g));
          col = mix(night * vec3(1.25, 1.05, 0.8), day * (0.10 + 1.05 * max(ndl, 0.0)), dayMix);
          vec3 H = normalize(uSun + V);
          col += vec3(1.0, 0.92, 0.78) * pow(max(dot(n, H), 0.0), 70.0) * 0.5 * dayMix * ocean;
        } else {
          // стилизованная «инструментальная» Earth: тёмный шар, сетка, линия терминатора
          vec3 base = mix(vec3(0.012, 0.016, 0.028), vec3(0.075, 0.095, 0.13), dayMix * (0.35 + 0.65 * max(ndl, 0.0)));
          float gLat = abs(fract(lat / 0.2617994 + 0.5) - 0.5) * 0.2617994;
          float gLon = abs(fract(lon / 0.2617994 + 0.5) - 0.5) * 0.2617994 * cos(lat);
          float grid = max(1.0 - smoothstep(0.0, 0.006, gLat), 1.0 - smoothstep(0.0, 0.006, gLon));
          col = base + vec3(0.30, 0.38, 0.52) * grid * (0.18 + 0.4 * dayMix);
          float eq = 1.0 - smoothstep(0.0, 0.008, abs(lat));
          col += vec3(0.95, 0.45, 0.25) * eq * 0.35;
          float term = 1.0 - smoothstep(0.0, 0.07, abs(ndl));
          col += vec3(1.0, 0.55, 0.28) * term * 0.22;
        }
        float rim = pow(1.0 - max(dot(n, V), 0.0), 3.0);
        col += vec3(0.32, 0.55, 1.0) * rim * (0.08 + 0.7 * dayMix);
        gl_FragColor = vec4(col * uFade, uFade);
      }`,

    atmo: PREC + `
      uniform vec3 uEye; uniform vec3 uSun; uniform float uFade; varying vec3 vW;
      void main(){
        vec3 n = normalize(vW); vec3 V = normalize(uEye - vW);
        float i = smoothstep(0.0, 0.42, -dot(n, V));
        float sunSide = 0.25 + 0.75 * smoothstep(-0.35, 0.5, dot(n, uSun));
        gl_FragColor = vec4(vec3(0.30, 0.58, 1.0) * i * i * 1.2 * sunSide * uFade, 1.0);
      }`,

    // небо: выборка из мозаики Allsky по формулам HEALPix прямо в фрагментном шейдере
    sky: PREC + SW.healpix.GLSL + IRMAP + `
      uniform sampler2D uAll; uniform vec2 uAllSize; uniform float uMono; uniform float uGain; uniform float uGamma;
      varying vec3 vD;
      void main(){
        vec3 d = normalize(vD);
        vec3 c = texture2D(uAll, hpxAllskyUV(d, uAllSize)).rgb;
        if (uMono > 0.5) c = irmap(pow(c.r, uGamma));
        gl_FragColor = vec4(c * uGain, 1.0);
      }`,

    tileV: `attribute vec3 aPos; attribute vec2 aUV; uniform mat4 uVP; uniform float uScale; varying vec2 vUV;
      void main(){ vUV = aUV; gl_Position = uVP * vec4(aPos * uScale, 1.0); }`,
    tileF: PREC + IRMAP + `
      uniform sampler2D uTex; uniform float uMono; uniform float uGain; uniform float uGamma; varying vec2 vUV;
      void main(){
        vec3 c = texture2D(uTex, vUV).rgb;
        if (uMono > 0.5) c = irmap(pow(c.r, uGamma));
        gl_FragColor = vec4(c * uGain, 1.0);
      }`,

    cover: PREC + `
      uniform float lam0; uniform float lam1; uniform float sinW; uniform float eps; uniform float uOn;
      varying vec3 vD;
      float passes(float c, float d){
        float kmin = ceil((lam0 - c - d) / 6.2831853);
        float kmax = floor((lam1 - c + d) / 6.2831853);
        return max(0.0, kmax - kmin + 1.0);
      }
      void main(){
        vec3 d = normalize(vD);
        float X = d.x; float Y = -d.z; float Z = d.y;
        float ye = Y * cos(eps) + Z * sin(eps);
        float ze = -Y * sin(eps) + Z * cos(eps);
        float beta = asin(clamp(ze, -1.0, 1.0));
        float l = atan(ye, X);
        float cb = max(cos(beta), 1e-4);
        float dl = asin(min(1.0, sinW / cb));
        float n = passes(l + 1.5707963, dl) + passes(l - 1.5707963, dl);
        if (lam1 <= lam0) n = 0.0;
        float scan = abs(cb * cos(l - lam1));
        float now = (1.0 - smoothstep(sinW * 0.45, sinW * 1.2, scan)) * step(lam0 + 0.001, lam1);
        float edge = (1.0 - smoothstep(sinW * 0.9, sinW * 1.2, scan)) * smoothstep(sinW * 0.75, sinW * 0.95, scan);
        // не отснятое к выбранной дате небо затемняется, текущая полоса подсвечивается
        float unseen = n > 0.0 ? 0.0 : 1.0;
        gl_FragColor = vec4(vec3(1.0, 0.48, 0.25) * (now * 0.16 + edge * 0.5) * uOn, unseen * 0.55 * uOn);
      }`,

    // подсветка сектора: выбранный — заливка и контур, под курсором — лёгкая заливка
    region: PREC + `
      uniform vec4 uSel; uniform vec4 uHov; uniform float uSelOn; uniform float uHovOn; uniform float uTime;
      varying vec3 vD;
      float inside(vec4 r, float ra, float dec){ return step(r.x, ra) * step(ra, r.y) * step(r.z, dec) * step(dec, r.w); }
      void main(){
        vec3 d = normalize(vD);
        float dec = asin(clamp(d.y, -1.0, 1.0));
        float ra = atan(-d.z, d.x); if (ra < 0.0) ra += 6.2831853;
        float s = inside(uSel, ra, dec) * uSelOn;
        float h = inside(uHov, ra, dec) * uHovOn;
        float dRa = min(abs(ra - uSel.x), abs(ra - uSel.y)) * cos(dec);
        float dDe = min(abs(dec - uSel.z), abs(dec - uSel.w));
        float e = s * (1.0 - smoothstep(0.0, 0.010, min(dRa, dDe)));
        float pulse = 0.85 + 0.15 * sin(uTime * 2.2);
        vec3 col = vec3(1.0, 0.48, 0.27) * (s * 0.09 + e * 0.9 * pulse) + vec3(0.9, 0.93, 1.0) * h * (1.0 - s) * 0.045;
        gl_FragColor = vec4(col, 1.0);
      }`,
    line: `attribute vec3 aPos; uniform mat4 uVP; void main(){ gl_Position = uVP * vec4(aPos, 1.0); }`,
    lineF: PREC + `uniform vec4 uColor; void main(){ gl_FragColor = vec4(uColor.rgb * uColor.a, 1.0); }`,

    pointV: `attribute vec3 aPos; attribute vec3 aColor; attribute float aSize; uniform mat4 uVP; uniform float uPx; varying vec3 vC;
      void main(){ vC = aColor; gl_Position = uVP * vec4(aPos, 1.0); gl_PointSize = aSize * uPx; }`,
    pointF: PREC + `varying vec3 vC; uniform float uGlow;
      void main(){ float d = length(gl_PointCoord - 0.5) * 2.0; if (d > 1.0) discard;
        float a = uGlow > 0.5 ? pow(1.0 - d, 2.4) : exp(-d * d * 5.0);
        gl_FragColor = vec4(vC * a, 1.0); }`,
  };
})();
