/**
 * 《allin》原型服务器：静态文件 + 单局 Boss 战 API。
 *
 * 无房间、无 LLM、无 SSE —— 一个进程一场战斗，前端每次操作拿回
 * `{ view, events }`，自己按节奏播放。
 */
import http from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStatic } from './static.js';
import { Battle } from './battle.js';
import { GameError } from './engine/duel.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(HERE, '..', 'web');
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';
const MAX_BODY = 64 * 1024;

const battle = new Battle();

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

const ROUTES = {
  'GET /api/state': () => ({ view: battle.view() }),

  'POST /api/action': async (req) => {
    const body = await readBody(req);
    if (typeof body.action !== 'string') throw new GameError('缺少 action 字段', 'BAD_REQUEST');
    return battle.act(body.action, body.amount);
  },

  'POST /api/read': () => battle.read(),

  'POST /api/pin': async (req) => {
    const body = await readBody(req);
    return battle.pin(body.fragmentId);
  },

  'POST /api/gotcha': () => battle.gotcha(),

  'POST /api/newgame': () => battle.newGame(),
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const key = `${req.method} ${url.pathname}`;
  try {
    const handler = ROUTES[key];
    if (handler) {
      const payload = await handler(req, res);
      sendJson(res, 200, payload);
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: `未知接口：${key}` });
      return;
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(WEB_ROOT, url.pathname, req, res)) return;
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  } catch (err) {
    const status = err?.status ?? (err instanceof GameError ? 400 : 500);
    if (status >= 500) console.error(`[${key}]`, err);
    if (!res.headersSent) sendJson(res, status, { error: err?.message ?? '服务器内部错误', code: err?.code ?? null });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  ♠ ♥ allin 原型 · 1v1 Boss 战  ♦ ♣');
  console.log('');
  console.log(`  本机   → http://localhost:${PORT}`);
  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1') {
    console.log(`  监听   → ${HOST}:${PORT}`);
  } else {
    console.log('  ⚠ HOST 在回环地址上，局域网内其他人打不开。');
  }
  console.log('');
});

const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { server, battle };
