/**
 * SpaceCam IRSA proxy — a Cloudflare Worker (free plan is enough).
 * NASA/IPAC IRSA and NASA JPL do not send CORS headers, so a browser page cannot read
 * their TAP answers or FITS cutouts directly. This worker forwards GET requests to an
 * allow-list of NASA hosts only, adds CORS headers and caches answers for a day.
 *
 * Deploy: dash.cloudflare.com → Workers → Create → paste this file → Deploy.
 * Then open SpaceCam → About → IRSA proxy → paste https://<name>.<you>.workers.dev
 */
const ALLOW = ['irsa.ipac.caltech.edu', 'ssd-api.jpl.nasa.gov'];
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Max-Age': '86400' };

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'GET') return new Response('GET only', { status: 405, headers: CORS });
    const target = new URL(request.url).searchParams.get('url');
    let u;
    try { u = new URL(target); } catch { return new Response('Missing ?url=', { status: 400, headers: CORS }); }
    if (u.protocol !== 'https:' || !ALLOW.includes(u.hostname)) return new Response('Host not allowed', { status: 403, headers: CORS });
    const r = await fetch(u.toString(), { headers: { 'User-Agent': 'SpaceCam/1.0 (+github.com/Shamsiddin-X/spacecam)' }, cf: { cacheEverything: true, cacheTtl: 86400 } });
    const h = new Headers(r.headers);
    Object.entries(CORS).forEach(([k, v]) => h.set(k, v));
    h.delete('set-cookie');
    return new Response(r.body, { status: r.status, headers: h });
  },
};
