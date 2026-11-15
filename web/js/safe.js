/* SpaceCam · устойчивость: в превью и встроенных окнах (iframe с песочницей) браузер зAprещает
 * localStorage, history и буфер обмена — без этой обёртки ошибка обрывала запуск интерфейса.
 * Здесь же — журнал ошибок и диагностика связи с архивами (этап 0 плана: проверка рисков). */
(function () {
  const SW = (window.SW = window.SW || {});
  const mem = {};
  SW.store = {
    get(k) { try { return window.localStorage.getItem(k); } catch (_) { return k in mem ? mem[k] : null; } },
    set(k, v) { try { window.localStorage.setItem(k, v); } catch (_) { mem[k] = String(v); } },
  };
  SW.setURL = (hashOrUrl) => { try { history.replaceState(null, '', hashOrUrl); } catch (_) { /* песочница */ } };
  SW.copy = (text) => {
    try { if (navigator.clipboard) return navigator.clipboard.writeText(text); } catch (_) { /* нет доступа */ }
    return Promise.reject(new Error('clipboard'));
  };
  SW.errors = [];
  const note = (msg) => { SW.errors.push(`${new Date().toISOString().slice(11, 19)} ${msg}`); if (SW.errors.length > 50) SW.errors.shift(); };
  window.addEventListener('error', (e) => note(`${e.message} (${(e.filename || '').split('/').pop()}:${e.lineno})`));
  window.addEventListener('unhandledrejection', (e) => note(`promise: ${e.reason && e.reason.message ? e.reason.message : e.reason}`));
  SW.guard = (name, fn) => { try { return fn(); } catch (e) { note(`${name}: ${e.message}`); console.error(name, e); return undefined; } };

  /** проверка: WebGL, тайлы HiPS (IRSA, CDS), TAP IRSA, вырезки, JPL — что реально доступно отсюда */
  SW.diagnose = async function () {
    const res = [];
    const t0 = () => performance.now();
    const img = (name, url) => new Promise((ok) => {
      const s = t0(), i = new Image(); i.crossOrigin = 'anonymous';
      const tm = setTimeout(() => ok({ name, ok: false, info: 'no answer within 15 s' }), 15000);
      i.onload = () => { clearTimeout(tm); let cors = true; try { const c = document.createElement('canvas'); c.width = c.height = 1; const g = c.getContext('2d'); g.drawImage(i, 0, 0); g.getImageData(0, 0, 1, 1); } catch (_) { cors = false; } ok({ name, ok: cors, info: cors ? `${Math.round(t0() - s)} ms` : 'image loads but without CORS: unusable in WebGL' }); };
      i.onerror = () => { clearTimeout(tm); ok({ name, ok: false, info: 'blocked or offline' }); };
      i.src = url;
    });
    const http = async (name, url, opts) => {
      const s = t0();
      try { const r = await fetch(url, opts); return { name, ok: r.ok, info: `${r.status} · ${Math.round(t0() - s)} ms` }; }
      catch (e) { return { name, ok: false, info: /fetch|network|load/i.test(e.message) ? 'browser request not allowed (CORS) or offline' : e.message }; }
    };
    let gl = null;
    try { gl = document.createElement('canvas').getContext('webgl'); } catch (_) { /* нет */ }
    res.push({ name: 'WebGL', ok: !!gl, info: gl ? gl.getParameter(gl.VERSION) : 'not supported by the browser' });
    res.push({ name: 'Settings storage', ok: (() => { try { localStorage.setItem('__t', '1'); return true; } catch (_) { return false; } })(), info: 'in a sandbox, settings last until reload' });
    const tap = new URLSearchParams({ REQUEST: 'doQuery', LANG: 'ADQL', FORMAT: 'csv', QUERY: 'SELECT TOP 1 a.uri FROM spherex.artifact a' });
    res.push(...(await Promise.all([
      img('SPHEREx DR1 sky · IRSA', 'https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube/Norder3/Allsky.png'),
      img('2MASS K · IRSA mirror', 'https://irsa.ipac.caltech.edu/data/hips/CDS/2MASS/K/Norder3/Allsky.jpg'),
      img('AllWISE W2 · IRSA mirror', 'https://irsa.ipac.caltech.edu/data/hips/CDS/AllWISE/W2/Norder3/Allsky.jpg'),
      img('DSS2 red · IRSA mirror', 'https://irsa.ipac.caltech.edu/data/hips/CDS/DSS2/red/Norder3/Allsky.jpg'),
      img('AllWISE · CDS', 'https://alasky.cds.unistra.fr/AllWISE/RGB-W4-W2-W1/Norder3/Allsky.jpg'),
      img('Pan-STARRS · CDS', 'https://alasky.cds.unistra.fr/Pan-STARRS/DR1/color-z-zg-g/Norder3/Allsky.jpg'),
      img('Earth · NASA Blue Marble', 'https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg'),
      http('SPHEREx image search · IRSA TAP (direct)', `https://irsa.ipac.caltech.edu/TAP/sync?${tap}`),
      ...(SW.irsaProxy && SW.irsaProxy('https://x') !== 'https://x' ? [http('SPHEREx image search · via your proxy', SW.irsaProxy(`https://irsa.ipac.caltech.edu/TAP/sync?${tap}`))] : []),
      img('2MASS cutout · CDS hips2fits', 'https://alasky.cds.unistra.fr/hips-image-services/hips2fits?hips=CDS%2FP%2F2MASS%2Fcolor&width=64&height=64&fov=0.1&projection=TAN&coordsys=icrs&ra=83.82&dec=-5.39&format=jpg'),
      http('Small bodies · NASA JPL', 'https://ssd-api.jpl.nasa.gov/sb_ident.api?xobs=0,0,0&obs-time=2460800.5&fov-ra-center=12-00-00&fov-dec-center=00-00-00&fov-ra-hwidth=0.05&fov-dec-hwidth=0.05'),
      http("Site's ready-made fields", 'data/fields.json', { cache: 'no-cache' }),
    ])));
    return res;
  };
})();
