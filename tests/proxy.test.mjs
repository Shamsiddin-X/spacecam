import test from 'node:test';
import assert from 'node:assert/strict';
import { createProxy } from '../lib/nasa-proxy.js';

const target = 'https://irsa.ipac.caltech.edu/TAP/sync?QUERY=SELECT+TOP+1';
const request = (url = target, options) => new Request(`https://spacecam.example/api/proxy?url=${encodeURIComponent(url)}`, options);

test('rejects unsafe targets before making any upstream request', async () => {
  const proxy = createProxy({ fetchImpl: () => assert.fail('must not fetch an unsafe target') });
  for (const url of [
    'http://irsa.ipac.caltech.edu/TAP/sync', 'https://example.com/',
    'https://irsa.ipac.caltech.edu.evil.example/', 'https://127.0.0.1/',
    'https://user:secret@irsa.ipac.caltech.edu/', 'https://irsa.ipac.caltech.edu:8443/',
  ]) assert.equal((await proxy(request(url))).status, 403, url);
  assert.equal((await proxy(request('not a URL'))).status, 400);
  assert.equal((await proxy(new Request('https://spacecam.example/api/proxy'))).status, 400);
  assert.equal((await proxy(new Request('https://spacecam.example/api/proxy?url=a&url=b'))).status, 400);
  assert.equal((await proxy(request(target, { method: 'POST', body: 'ignored' }))).status, 405);
  assert.equal((await proxy(request(target, { method: 'OPTIONS' }))).status, 204);
});

test('streams binary data intact without forwarding browser credentials or upstream cookies', async () => {
  const bytes = new Uint8Array([0, 255, 83, 73, 77, 80, 76, 69]);
  const proxy = createProxy({ fetchImpl: async (url, options) => {
    assert.equal(String(url), target);
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Cookie, undefined);
    assert.equal(options.headers.Authorization, undefined);
    return new Response(bytes, { headers: { 'Content-Type': 'application/fits', 'Set-Cookie': 'private=1' } });
  } });
  const response = await proxy(request(target, { headers: { Cookie: 'browser=secret', Authorization: 'Bearer private' } }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/fits');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.match(response.headers.get('cache-control'), /s-maxage=3600/);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
});

test('blocks an external redirect without following it', async () => {
  let calls = 0;
  const proxy = createProxy({ fetchImpl: async () => {
    calls++;
    return new Response(null, { status: 302, headers: { Location: 'https://example.com/private' } });
  } });
  assert.equal((await proxy(request())).status, 403);
  assert.equal(calls, 1);
});

test('follows a relative NASA redirect and preserves upstream errors without caching them', async () => {
  let calls = 0;
  const proxy = createProxy({ fetchImpl: async (url) => {
    if (++calls === 1) return new Response(null, { status: 302, headers: { Location: '/TAP/error' } });
    assert.equal(String(url), 'https://irsa.ipac.caltech.edu/TAP/error');
    return new Response('Archive unavailable', { status: 503 });
  } });
  const response = await proxy(request());
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(await response.text(), 'Archive unavailable');
});

test('bounds redirect loops and converts network failures to gateway errors', async () => {
  let calls = 0;
  const loop = createProxy({ fetchImpl: async () => { calls++; return new Response(null, { status: 302, headers: { Location: target } }); } });
  assert.equal((await loop(request())).status, 502);
  assert.equal(calls, 4);
  const offline = createProxy({ fetchImpl: async () => { throw new TypeError('network failure'); } });
  assert.equal((await offline(request())).status, 502);
});

test('reports an aborted request as a timeout', async () => {
  const controller = new AbortController();
  controller.abort();
  const proxy = createProxy({ fetchImpl: async (_, options) => { options.signal.throwIfAborted(); } });
  const response = await proxy(request(target, { signal: controller.signal }));
  assert.equal(response.status, 504);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
