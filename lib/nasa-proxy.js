const HOSTS = new Set(['irsa.ipac.caltech.edu', 'ssd-api.jpl.nasa.gov']);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function permitted(url) {
  return url.protocol === 'https:' && HOSTS.has(url.hostname) &&
    !url.username && !url.password && !url.port;
}

function failure(status, message, extra = {}) {
  return Response.json({ error: message }, {
    status,
    headers: { 'Cache-Control': 'no-store', ...extra },
  });
}

// Only public NASA data is forwarded. Browser cookies, credentials and headers
// are never sent upstream, and every redirect is checked against the allowlist.
export function createProxy({ fetchImpl = globalThis.fetch, timeoutMs = 50_000 } = {}) {
  return async function proxy(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { Allow: 'GET, OPTIONS' } });
    if (request.method !== 'GET') return failure(405, 'GET only', { Allow: 'GET, OPTIONS' });
    const values = new URL(request.url).searchParams.getAll('url');
    if (values.length !== 1 || !values[0]) return failure(400, 'Provide one ?url= parameter');
    let target;
    try { target = new URL(values[0]); }
    catch { return failure(400, 'Invalid upstream URL'); }
    if (!permitted(target)) return failure(403, 'Only HTTPS requests to the NASA IRSA and JPL archives are allowed');

    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]);
    try {
      for (let redirects = 0; redirects <= 3; redirects++) {
        const upstream = await fetchImpl(target, {
          method: 'GET',
          redirect: 'manual',
          signal,
          headers: { Accept: '*/*', 'User-Agent': 'SpaceCam/1.0 (SPHEREx sky viewer)' },
        });
        if (REDIRECTS.has(upstream.status)) {
          const location = upstream.headers.get('location');
          await upstream.body?.cancel();
          if (!location) return failure(502, 'Archive returned a redirect without a destination');
          target = new URL(location, target);
          if (!permitted(target)) return failure(403, 'Archive redirect is outside the allowed NASA hosts');
          continue;
        }
        const headers = new Headers({
          'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
          'Cache-Control': upstream.ok ? 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400' : 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; sandbox",
        });
        // Stream FITS files rather than buffering them into a serverless payload.
        return new Response(upstream.body, { status: upstream.status, headers });
      }
      return failure(502, 'Too many archive redirects');
    } catch {
      return signal.aborted ? failure(504, 'Archive request timed out or was cancelled') : failure(502, 'Archive is temporarily unreachable');
    }
  };
}
