import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import proxy from '../api/proxy.js';

const root = fileURLToPath(new URL('../web/', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.bin': 'application/octet-stream' };
const port = Number(process.env.PORT || 3000);
createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${port}`);
    if (url.pathname === '/api/proxy') {
      const response = await proxy.fetch(new Request(url, { method: req.method }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) await pipeline(Readable.fromWeb(response.body), res);
      else res.end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
    const path = resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!path.startsWith(root.endsWith(sep) ? root : root + sep)) { res.writeHead(403); res.end(); return; }
    let data;
    if (url.pathname === '/js/config.js') data = "window.SKYCAM_PROXY = window.SKYCAM_PROXY || '/api/proxy';\n";
    else {
      try { data = await readFile(path); }
      catch (error) {
        if (error.code !== 'ENOENT' || url.pathname !== '/data/fields.json') throw error;
        data = JSON.stringify({ generated: null, fields: [] });
      }
    }
    res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch (error) {
    if (res.headersSent) res.destroy();
    else { res.writeHead(error.code === 'ENOENT' ? 404 : 500); res.end('Request could not be completed'); }
  }
}).listen(port, '127.0.0.1', () => console.log(`SpaceCam: http://localhost:${port}`));
