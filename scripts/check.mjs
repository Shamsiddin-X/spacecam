import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
let count = 0;
for (const dir of ['web/js/', 'api/', 'lib/', 'scripts/', 'tests/']) {
  for (const name of await readdir(new URL(dir, root))) {
    if (!/\.m?js$/.test(name)) continue;
    const result = spawnSync(process.execPath, ['--check', fileURLToPath(new URL(dir + name, root))], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
    count++;
  }
}
for (const path of ['package.json', 'vercel.json']) JSON.parse(await readFile(new URL(path, root), 'utf8'));
const html = await readFile(new URL('web/index.html', root), 'utf8');
for (const match of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
  if (/^(?:https?:|data:|mailto:)/.test(match[1])) continue;
  await readFile(new URL('web/' + match[1].split('?')[0], root));
}
console.log(`Checked ${count} JavaScript files, JSON configuration and local HTML assets.`);
