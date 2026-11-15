import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../web/js/irsa.js', import.meta.url), 'utf8');
function load({ custom, fetchImpl }) {
  const values = new Map(custom ? [['skycam_proxy', custom]] : []);
  const window = { SKYCAM_PROXY: '/api/proxy', SW: { store: { get: (key) => values.get(key), set: (key, value) => values.set(key, value) } } };
  vm.runInNewContext(source, { window, URLSearchParams, fetch: fetchImpl });
  return window.SW;
}

test('per-visit searches use the built-in same-origin proxy first', async () => {
  const calls = [];
  const sw = load({ fetchImpl: async (url) => { calls.push(url); return new Response('uri,time_bounds_lower\n'); } });
  await sw.irsa.observations(83.82, -5.39, 'D1');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].startsWith('/api/proxy?url='));
  assert.equal(sw.irsaRoute(), 'proxy');
});

test('a saved custom proxy overrides the hosted default', () => {
  const sw = load({ custom: 'https://custom.example/', fetchImpl: () => assert.fail('not needed') });
  assert.equal(sw.irsaProxy('https://irsa.ipac.caltech.edu/TAP/sync'), 'https://custom.example?url=https%3A%2F%2Firsa.ipac.caltech.edu%2FTAP%2Fsync');
});

test('plain static hosting falls back to direct archive access when the proxy route is absent', async () => {
  const calls = [];
  const sw = load({ fetchImpl: async (url) => {
    calls.push(url);
    return url.startsWith('/api/') ? new Response('Not found', { status: 404 }) : new Response('uri,time_bounds_lower\n');
  } });
  await sw.irsa.observations(83.82, -5.39, 'D1');
  assert.equal(calls.length, 2);
  assert.ok(calls[1].startsWith('https://irsa.ipac.caltech.edu/TAP/sync?'));
});
