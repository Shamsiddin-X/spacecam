/* Sectorа неба SpaceCam: 6 поясов по склонению (A — у северного полюса … F — у южного)
 * × 12 долей по прямому восхождению по 2ʰ (01 — 0ʰ…2ʰ, номера растут на восток).
 * Удобная «адресная сетка»: C07, E11 и т. п., с переходом к соседям.
 */
(function () {
  const SW = (window.SW = window.SW || {});
  const ROWS = 'ABCDEF';
  const DEC = [[60, 90], [30, 60], [0, 30], [-30, 0], [-60, -30], [-90, -60]];

  function make(row, col) {
    const [decMin, decMax] = DEC[row];
    const raMin = col * 30, raMax = (col + 1) * 30;
    const id = `${ROWS[row]}${String(col + 1).padStart(2, '0')}`;
    const cdec = row === 0 ? 72 : row === 5 ? -72 : (decMin + decMax) / 2;
    return { id, row, col, raMin, raMax, decMin, decMax, ra: raMin + 15, dec: cdec };
  }
  function at(ra, dec) {
    const r = ((ra % 360) + 360) % 360;
    const row = dec >= 60 ? 0 : dec >= 30 ? 1 : dec >= 0 ? 2 : dec >= -30 ? 3 : dec >= -60 ? 4 : 5;
    return make(row, Math.min(11, Math.floor(r / 30)));
  }
  function byId(id) {
    const m = String(id).trim().toUpperCase().match(/^([A-F])\s*0?(\d{1,2})$/);
    if (!m) return null;
    const col = +m[2] - 1;
    return col >= 0 && col < 12 ? make(ROWS.indexOf(m[1]), col) : null;
  }
  /** dir: 'n' | 's' | 'e' | 'w'  (восток — в сторону роста RA) */
  function neighbor(s, dir) {
    if (dir === 'n') return s.row > 0 ? make(s.row - 1, s.col) : null;
    if (dir === 's') return s.row < 5 ? make(s.row + 1, s.col) : null;
    if (dir === 'e') return make(s.row, (s.col + 1) % 12);
    if (dir === 'w') return make(s.row, (s.col + 11) % 12);
    return null;
  }
  function objectsIn(s) {
    return SW.astro.OBJECTS.filter((o) => at(o.ra, o.dec).id === s.id);
  }
  SW.sectors = { at, byId, neighbor, objectsIn, ROWS };
})();
