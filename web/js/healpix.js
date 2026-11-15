/* HEALPix (схема NESTED) — то, на чём построены вSepебесные мозаики HiPS.
 * Непрерывные преобразования «нAprавление ↔ (грань, x, y)», номера pxелей,
 * а также GLSL-версия для выборки из мозаики Allsky прямо в шейдере.
 * Соглашения как в healpix_base: x идёт от южного угла грани к восточному, y — к западному.
 */
(function () {
  const SW = (window.SW = window.SW || {});
  const HALFPI = Math.PI / 2;
  const JRLL = [2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4];
  const JPLL = [1, 3, 5, 7, 0, 2, 4, 6, 1, 3, 5, 7];

  /** z = sin(dec), phi = RA (рад) → {face, x, y}, x,y ∈ [0,1) */
  function ang2fxy(z, phi) {
    const za = Math.abs(z);
    let tt = phi / HALFPI;
    tt = ((tt % 4) + 4) % 4;
    if (za <= 2 / 3) {
      const t1 = 0.5 + tt, t2 = 0.75 * z;
      const jp = t1 - t2, jm = t1 + t2;
      const ifp = Math.floor(jp), ifm = Math.floor(jm);
      const face = ifp === ifm ? (ifp % 4) + 4 : ifp < ifm ? ifp % 4 : (ifm % 4) + 8;
      return { face, x: jm - ifm, y: 1 - (jp - ifp) };
    }
    const ntt = Math.min(3, Math.floor(tt));
    const tp = tt - ntt;
    const tmp = Math.sqrt(3 * (1 - za));
    const jp = Math.min(tp * tmp, 0.999999999), jm = Math.min((1 - tp) * tmp, 0.999999999);
    if (z > 0) return { face: ntt, x: 1 - jm, y: 1 - jp };
    return { face: ntt + 8, x: jp, y: jm };
  }

  /** {face, x, y} → {z, phi} */
  function fxy2ang(face, x, y) {
    const jr = JRLL[face] - x - y;
    let nr, z;
    if (jr < 1) { nr = jr; z = 1 - (nr * nr) / 3; }
    else if (jr > 3) { nr = 4 - jr; z = (nr * nr) / 3 - 1; }
    else { nr = 1; z = ((2 - jr) * 2) / 3; }
    let tmp = JPLL[face] * nr + x - y;
    if (tmp < 0) tmp += 8;
    if (tmp >= 8) tmp -= 8;
    const phi = nr < 1e-15 ? 0 : (0.5 * HALFPI * tmp) / nr;
    return { z, phi };
  }

  function spread(v) { let r = 0; for (let b = 0; b < 15; b++) r += ((v >> b) & 1) * 2 ** (2 * b); return r; }
  function compact(v) { let r = 0; for (let b = 0; b < 15; b++) r += (Math.floor(v / 2 ** (2 * b)) % 2) << b; return r; }

  /** номер pxеля NESTED порядка order для (z, phi) */
  function ang2pix(order, z, phi) {
    const { face, x, y } = ang2fxy(z, phi);
    const ns = 2 ** order;
    const ix = Math.min(ns - 1, Math.floor(x * ns));
    const iy = Math.min(ns - 1, Math.floor(y * ns));
    return face * ns * ns + spread(ix) + 2 * spread(iy);
  }
  function pix2fxy(order, ipix) {
    const npf = 4 ** order;
    const face = Math.floor(ipix / npf);
    const r = ipix - face * npf;
    let ix = 0, iy = 0;
    for (let b = 0; b < order; b++) {
      ix += (Math.floor(r / 4 ** b) % 2) << b;
      iy += (Math.floor(r / (2 * 4 ** b)) % 2) << b;
    }
    return { face, ix, iy };
  }

  /** GLSL: нAprавление (экваториальное, z = sinδ, phi = α) → UV в мозаике Allsky (27 колонок тайлов 3-го порядка) */
  const GLSL = `
    float hpxMod(float a, float b){ return a - b * floor(a / b); }
    vec3 hpxFXY(float z, float phi){
      float za = abs(z);
      float tt = hpxMod(phi / 1.5707963268, 4.0);
      if (za <= 0.6666667) {
        float t1 = 0.5 + tt; float t2 = 0.75 * z;
        float jp = t1 - t2; float jm = t1 + t2;
        float ifp = floor(jp); float ifm = floor(jm);
        float face;
        if (ifp == ifm) face = hpxMod(ifp, 4.0) + 4.0;
        else if (ifp < ifm) face = hpxMod(ifp, 4.0);
        else face = hpxMod(ifm, 4.0) + 8.0;
        return vec3(face, jm - ifm, 1.0 - (jp - ifp));
      }
      float ntt = min(3.0, floor(tt));
      float tp = tt - ntt;
      float tmp = sqrt(3.0 * (1.0 - za));
      float jp = min(tp * tmp, 0.99999); float jm = min((1.0 - tp) * tmp, 0.99999);
      if (z > 0.0) return vec3(ntt, 1.0 - jm, 1.0 - jp);
      return vec3(ntt + 8.0, jp, jm);
    }
    float hpxSpread3(float v){
      float b0 = hpxMod(v, 2.0); float b1 = hpxMod(floor(v / 2.0), 2.0); float b2 = hpxMod(floor(v / 4.0), 2.0);
      return b0 + 4.0 * b1 + 16.0 * b2;
    }
    vec2 hpxAllskyUV(vec3 d, vec2 texSize){
      // d — нAprавление в координатах сцены: x = cosδcosα, y = sinδ, z = −cosδsinα
      float z = clamp(d.y, -1.0, 1.0);
      float phi = atan(-d.z, d.x); if (phi < 0.0) phi += 6.2831853;
      vec3 f = hpxFXY(z, phi);
      float ix = min(7.0, floor(f.y * 8.0)); float iy = min(7.0, floor(f.z * 8.0));
      float fx = f.y * 8.0 - ix; float fy = f.z * 8.0 - iy;
      float n = f.x * 64.0 + hpxSpread3(ix) + 2.0 * hpxSpread3(iy);
      float tile = texSize.x / 27.0;
      float col = hpxMod(n, 27.0); float row = floor(n / 27.0);
      float inset = 0.5 / tile;
      fx = clamp(fx, inset, 1.0 - inset); fy = clamp(fy, inset, 1.0 - inset);
      // в тайле HiPS ось x грани идёт вниз по строкам, ось y — вправо по столбцам
      return vec2((col + fy) * tile / texSize.x, (row + fx) * tile / texSize.y);
    }`;

  SW.healpix = { ang2fxy, fxy2ang, ang2pix, pix2fxy, spread, compact, GLSL };
})();
