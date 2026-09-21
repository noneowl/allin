import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Serve a file from `root`, refusing anything that escapes it.
 * @returns {boolean} true when a response was sent
 */
export function serveStatic(root, urlPath, req, res) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';

  const safeRel = normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const full = resolve(join(root, safeRel));
  const rootResolved = resolve(root);

  if (full !== rootResolved && !full.startsWith(rootResolved + sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return true;
  }

  let stats;
  try {
    stats = statSync(full);
  } catch {
    return false;
  }
  if (stats.isDirectory()) return false;

  const ext = extname(full).toLowerCase();
  const type = MIME[ext] ?? 'application/octet-stream';
  const noCache = ext === '.html' || ext === '.js' || ext === '.css';

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stats.size,
    'Cache-Control': noCache ? 'no-cache, must-revalidate' : 'public, max-age=3600',
    'Last-Modified': stats.mtime.toUTCString(),
  });

  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  createReadStream(full).pipe(res);
  return true;
}
