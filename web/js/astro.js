/* SPHEREx Sky Watch — астрономические утилиты (без зависимостей).
 * Системы координат:
 *   экваториальная (RA/Dec, ICRS) -> вектор сцены Three.js (Y — северный полюс мира):
 *   x = cosδ·cosα,  y = sinδ,  z = −cosδ·sinα   (правая тройка, без зеркалирования)
 */
(function () {
  const SW = (window.SW = window.SW || {});
  const D2R = Math.PI / 180;
  const R2D = 180 / Math.PI;
  const OBLIQUITY = 23.4392911 * D2R;

  // Начало обзора неба SPHEREx (1 May 2025) и длительность одного обзора всего неба (~полгода)
  const MISSION_START = new Date(Date.UTC(2025, 4, 1));
  const SURVEY_DAYS = 182.625;

  // Детекторы SPHEREx и их спектральные диапазоны, µm (IRSA)
  const BANDS = [
    { id: 'D1', min: 0.75, max: 1.1 },
    { id: 'D2', min: 1.1, max: 1.6 },
    { id: 'D3', min: 1.6, max: 2.4 },
    { id: 'D4', min: 2.4, max: 3.8 },
    { id: 'D5', min: 3.8, max: 4.4 },
    { id: 'D6', min: 4.4, max: 5.0 },
  ];

  const jd = (date) => date.getTime() / 86400000 + 2440587.5;
  const dateToMjd = (date) => date.getTime() / 86400000 + 40587;
  const mjdToDate = (mjd) => new Date((mjd - 40587) * 86400000);

  /** Среднее звёздное время по Гринвичу, градусы */
  function gmstDeg(date) {
    const d = jd(date) - 2451545.0;
    const g = 280.46061837 + 360.98564736629 * d;
    return ((g % 360) + 360) % 360;
  }

  /** Эклиптическая долгота Солнца (рад), НЕ приведённая к 0..2π — удобно для «накопленного» обзора */
  function sunEclLonUnwrapped(date) {
    const n = jd(date) - 2451545.0;
    const L = 280.46 + 0.9856474 * n;
    const g = (357.528 + 0.9856003 * n) * D2R;
    return (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * D2R;
  }

  /** Эклиптика -> экватор (рад) */
  function eclToEq(lon, lat) {
    const e = OBLIQUITY;
    const x = Math.cos(lat) * Math.cos(lon);
    const y = Math.cos(lat) * Math.sin(lon);
    const z = Math.sin(lat);
    const ye = y * Math.cos(e) - z * Math.sin(e);
    const ze = y * Math.sin(e) + z * Math.cos(e);
    return { ra: Math.atan2(ye, x), dec: Math.asin(Math.max(-1, Math.min(1, ze))) };
  }

  /** Галактические (l, b) -> экваториальные (рад), J2000 */
  const GAL = { raNGP: 192.85948 * D2R, decNGP: 27.12825 * D2R, lNCP: 122.93192 * D2R };
  function galToEq(l, b) {
    const { raNGP, decNGP, lNCP } = GAL;
    const sinDec = Math.sin(b) * Math.sin(decNGP) + Math.cos(b) * Math.cos(decNGP) * Math.cos(lNCP - l);
    const dec = Math.asin(Math.max(-1, Math.min(1, sinDec)));
    const y = Math.cos(b) * Math.sin(lNCP - l);
    const x = Math.sin(b) * Math.cos(decNGP) - Math.cos(b) * Math.sin(decNGP) * Math.cos(lNCP - l);
    return { ra: raNGP + Math.atan2(y, x), dec };
  }

  function sunRaDec(date) {
    return eclToEq(sunEclLonUnwrapped(date), 0);
  }

  function raDecToVec(ra, dec, r = 1) {
    return { x: r * Math.cos(dec) * Math.cos(ra), y: r * Math.sin(dec), z: -r * Math.cos(dec) * Math.sin(ra) };
  }

  function vecToRaDec(x, y, z) {
    const len = Math.hypot(x, y, z) || 1;
    let ra = Math.atan2(-z, x);
    if (ra < 0) ra += 2 * Math.PI;
    return { ra, dec: Math.asin(y / len) };
  }

  const pad = (n, w = 2) => String(n).padStart(w, '0');

  /** RA в градусах -> "hh:mm:ss.s" */
  function fmtRA(deg) {
    let s = (((deg % 360) + 360) % 360) / 15 * 3600;
    s = Math.round(s * 10) / 10;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s - h * 3600) / 60);
    const sec = s - h * 3600 - m * 60;
    return `${pad(h % 24)}ʰ${pad(m)}ᵐ${sec.toFixed(1).padStart(4, '0')}ˢ`;
  }

  /** Dec в градусах -> "+dd°mm′ss″" */
  function fmtDec(deg) {
    const sign = deg < 0 ? '−' : '+';
    let s = Math.round(Math.abs(deg) * 3600);
    const d = Math.floor(s / 3600);
    const m = Math.floor((s - d * 3600) / 60);
    const sec = s - d * 3600 - m * 60;
    return `${sign}${pad(d)}°${pad(m)}′${pad(sec)}″`;
  }

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtDate(date, withTime = false) {
    const d = `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
    return withTime ? `${d}, ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC` : d;
  }

  function surveyIndex(date) {
    const days = (date - MISSION_START) / 86400000;
    return Math.max(1, Math.floor(days / SURVEY_DAYS) + 1);
  }

  /** Разбор строки вида "83.82 -5.39" или "05:35:17 -05:23:28" -> {ra, dec} в градусах, либо null */
  function parseCoords(text) {
    const t = text.trim().replace(/[,;]/g, ' ').replace(/\s+/g, ' ');
    const num = t.match(/^(-?\d+(?:\.\d+)?)\s+([+-]?\d+(?:\.\d+)?)$/);
    if (num) {
      const ra = parseFloat(num[1]);
      const dec = parseFloat(num[2]);
      if (ra >= 0 && ra < 360 && dec >= -90 && dec <= 90) return { ra, dec };
      return null;
    }
    const sx = t.match(/^(\d{1,2})[:h ](\d{1,2})[:m ](\d{1,2}(?:\.\d+)?)s?\s+([+-−]?)(\d{1,2})[:d° ](\d{1,2})[:m′' ](\d{1,2}(?:\.\d+)?)/);
    if (sx) {
      const ra = (+sx[1] + +sx[2] / 60 + +sx[3] / 3600) * 15;
      const sgn = sx[4] === '-' || sx[4] === '−' ? -1 : 1;
      const dec = sgn * (+sx[5] + +sx[6] / 60 + +sx[7] / 3600);
      if (ra < 360 && Math.abs(dec) <= 90) return { ra, dec };
    }
    return null;
  }

  SW.astro = {
    D2R, R2D, OBLIQUITY, MISSION_START, SURVEY_DAYS, BANDS,
    jd, dateToMjd, mjdToDate, gmstDeg, sunEclLonUnwrapped, eclToEq, galToEq, sunRaDec,
    raDecToVec, vecToRaDec, fmtRA, fmtDec, fmtDate, surveyIndex, parseCoords,
  };
})();

/* Справочник объектов для поиска без сети (J2000, градусы) и спектральные каналы SPHEREx DR1 */
(function () {
  const SW = window.SW;
  SW.astro.OBJECTS = [
    ['M42', 'Orion Nebula', 83.8221, -5.3911], ['M31', 'Andromeda Galaxy', 10.6847, 41.269],
    ['M45', 'Pleiades', 56.75, 24.1167], ['Sgr A*', 'Galactic Center', 266.4168, -29.0078],
    ['LMC', 'Large Magellanic Cloud', 80.894, -69.756], ['SMC', 'Small Magellanic Cloud', 13.1867, -72.8286],
    ['M101', 'Pinwheel Galaxy', 210.8023, 54.349], ['M51', 'Whirlpool Galaxy', 202.4696, 47.1952],
    ['M81', "Bode's Galaxy", 148.8882, 69.0653], ['M87', 'Virgo A', 187.7059, 12.3911],
    ['M1', 'Crab Nebula', 83.6331, 22.0145], ['M8', 'Lagoon Nebula', 270.9208, -24.38],
    ['M16', 'Eagle Nebula', 274.7, -13.8167], ['M20', 'Trifid Nebula', 270.675, -22.9717],
    ['NGC 3372', 'Carina Nebula', 161.265, -59.8667], ['ρ Oph', 'Rho Ophiuchi cloud', 246.79, -24.54],
    ['Barnard', "Barnard's Star · the fastest star in the sky", 269.4521, 4.6934], ['Vega', 'Vega', 279.2347, 38.7837], ['Sirius', 'Sirius', 101.2872, -16.7161],
    ['Betelgeuse', 'Betelgeuse', 88.7929, 7.4071], ['Polaris', 'Polaris', 37.9546, 89.2641],
    ['NEP', 'North Ecliptic Pole · SPHEREx deep field', 270.0, 66.5607],
    ['SEP', 'South Ecliptic Pole · SPHEREx deep field', 90.0, -66.5607],
  ].map(([id, name, ra, dec]) => ({ id, name, ra, dec }));
  SW.astro.SPHEREX_LAMBDA = '0.753 0.771 0.790 0.809 0.828 0.848 0.868 0.889 0.910 0.932 0.955 0.978 1.001 1.025 1.050 1.075 1.102 1.113 1.139 1.167 1.195 1.224 1.254 1.284 1.315 1.346 1.378 1.412 1.446 1.481 1.517 1.554 1.592 1.631 1.656 1.695 1.735 1.775 1.818 1.861 1.905 1.949 1.995 2.041 2.089 2.139 2.189 2.240 2.292 2.345 2.399 2.445 2.506 2.575 2.646 2.719 2.794 2.871 2.951 3.033 3.118 3.204 3.293 3.383 3.476 3.570 3.667 3.768 3.833 3.867 3.901 3.935 3.970 4.005 4.040 4.076 4.112 4.148 4.184 4.220 4.257 4.294 4.331 4.368 4.405 4.435 4.467 4.500 4.533 4.566 4.600 4.635 4.669 4.704 4.739 4.773 4.808 4.843 4.879 4.915 4.951 4.988'.split(' ').map(Number);
  SW.astro.BLANK_FRAMES = [50, 51];
  SW.astro.findObject = (q) => {
    const s = q.trim().toLowerCase().replace(/\s+/g, ' ');
    return SW.astro.OBJECTS.find((o) => o.id.toLowerCase() === s || o.name.toLowerCase().includes(s)) || null;
  };
})();
