import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const dist = new URL('dist/', root);
await rm(dist, { recursive: true, force: true });
await cp(new URL('web/', root), dist, { recursive: true });
await writeFile(new URL('js/config.js', dist), "window.SKYCAM_PROXY = window.SKYCAM_PROXY || '/api/proxy';\n");
await mkdir(new URL('data/', dist), { recursive: true });
try { await readFile(new URL('data/fields.json', dist)); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  await writeFile(new URL('data/fields.json', dist), JSON.stringify({ generated: null, fields: [] }) + '\n');
}
console.log(`Static site built: ${fileURLToPath(dist)}`);
