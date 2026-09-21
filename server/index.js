import http from 'node:http';
import { join } from 'node:path';
import { loadConfig, saveConfig, publicConfig, configPath, ROOT } from './config.js';
import { providerCatalog, testProvider, fetchModels } from './providers/index.js';
import { roster } from './ai/personalities.js';
import { SessionStore } from './sessions.js';
import { serveStatic } from './static.js';

const WEB_ROOT = join(ROOT, 'web');
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const MAX_BODY = 512 * 1024;
const SESSION_COOKIE = 'dezhou_sid';

const getConfig = () => loadConfig();
// `ready` is derived on every read so live edits take effect immediately.
const configWithReadiness = () => {
  const cfg = loadConfig();
  return { ...cfg, ready: publicConfig().ready };
};

const sessions = new SessionStore({ getConfig: configWithReadiness });

// ------------------------------------------------------------------ helpers

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, status >= 400 ? 2 : 0);
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

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

/** Resolve (or mint) the session for this request. */
function sessionFor(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  let id = cookies[SESSION_COOKIE];
  const { id: sessionId, controller } = sessions.getOrCreate(id);
  if (sessionId !== id) {
    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
    );
  }
  return controller;
}

function sse(req, res, controller) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  const send = (event, data) => {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      /* the socket went away; the close handler will clean up */
    }
  };

  send('state', controller.view());
  const unsubscribe = controller.subscribe(send);
  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* ignore */
    }
  }, 15000);

  req.on('close', () => {
    clearInterval(ping);
    unsubscribe();
  });
}

// ------------------------------------------------------------------- routes

const ROUTES = {
  'GET /api/bootstrap': (req, res, controller) => {
    sendJson(res, 200, {
      config: publicConfig(),
      providers: providerCatalog(),
      roster: roster(),
      configPath,
      state: controller.view(),
    });
  },

  'GET /api/state': (req, res, controller) => sendJson(res, 200, controller.view()),

  'GET /api/models': async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const cfg = loadConfig();
    const result = await fetchModels({
      provider: url.searchParams.get('provider') ?? cfg.provider,
      baseUrl: url.searchParams.get('baseUrl') || cfg.baseUrl,
      apiKey: url.searchParams.get('apiKey') || cfg.apiKey,
    });
    sendJson(res, 200, result);
  },

  'POST /api/config': async (req, res) => {
    const body = await readBody(req);
    const saved = saveConfig(body);
    sendJson(res, 200, { ok: true, config: publicConfig(), savedAt: saved ? Date.now() : null });
  },

  'POST /api/config/test': async (req, res, controller) => {
    const body = await readBody(req);
    const live = loadConfig();
    const probe = {
      provider: body.provider ?? live.provider,
      baseUrl: body.baseUrl ?? live.baseUrl,
      apiKey: body.apiKey !== undefined && body.apiKey !== '' ? body.apiKey : live.apiKey,
      model: body.model ?? live.model,
      timeoutMs: body.timeoutMs ?? live.timeoutMs,
    };
    if (!probe.baseUrl || !probe.model) {
      sendJson(res, 200, { ok: false, error: '请先填写 Base URL 和模型名' });
      return;
    }
    const result = await testProvider(probe, { sessionId: controller.sessionId });
    sendJson(res, 200, result);
  },

  'POST /api/game/new': async (req, res, controller) => {
    const body = await readBody(req);
    await controller.newGame(body);
    sendJson(res, 200, controller.view());
  },

  'POST /api/game/start': async (req, res, controller) => {
    await controller.startHand();
    sendJson(res, 200, controller.view());
  },

  'POST /api/game/next': async (req, res, controller) => {
    const body = await readBody(req);
    await controller.nextHand(Number(body.delayMs ?? 0));
    sendJson(res, 200, controller.view());
  },

  'POST /api/game/action': async (req, res, controller) => {
    const body = await readBody(req);
    if (!body || typeof body.action !== 'string') {
      sendJson(res, 400, { error: '缺少 action 字段' });
      return;
    }
    await controller.humanAction({ action: body.action, amount: body.amount });
    sendJson(res, 200, controller.view());
  },

  'POST /api/game/retry': async (req, res, controller) => {
    await controller.retryCurrentAI();
    sendJson(res, 200, controller.view());
  },

  'POST /api/game/cancel': (req, res, controller) => {
    controller.cancelAI();
    sendJson(res, 200, { ok: true });
  },

  'POST /api/game/reset': (req, res, controller) => {
    controller.cancelAI();
    controller.table = null;
    controller.lastError = null;
    controller.broadcast();
    sendJson(res, 200, controller.view());
  },
};

// -------------------------------------------------------------------- server

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const key = `${req.method} ${url.pathname}`;

  try {
    if (key === 'GET /api/events') {
      sse(req, res, sessionFor(req, res));
      return;
    }

    const handler = ROUTES[key];
    if (handler) {
      const controller = sessionFor(req, res);
      await handler(req, res, controller);
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: `未知接口：${key}` });
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (serveStatic(WEB_ROOT, url.pathname, req, res)) return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  } catch (err) {
    const status = err?.status ?? (err?.name === 'GameError' ? 400 : 500);
    if (status >= 500) console.error(`[${key}]`, err);
    if (!res.headersSent) {
      sendJson(res, status, {
        error: err?.message ?? '服务器内部错误',
        code: err?.code ?? null,
      });
    } else {
      res.end();
    }
  }
});

server.listen(PORT, HOST, () => {
  const cfg = publicConfig();
  console.log('');
  console.log('  ♠ ♥ 德州扑克 · 由 LLM 扮演对手 ♦ ♣');
  console.log(`  → http://${HOST}:${PORT}`);
  console.log('');
  console.log(`  供应商 : ${cfg.provider}`);
  console.log(`  端点   : ${cfg.baseUrl || '(未配置)'}`);
  console.log(`  模型   : ${cfg.model || '(未配置)'}`);
  console.log(`  API Key: ${cfg.hasApiKey ? `已配置 (${cfg.apiKeyHint}${cfg.apiKeySource ? ` via ${cfg.apiKeySource}` : ''})` : '未配置 — 打开页面右上角「设置」填写'}`);
  console.log(`  设置   : ${configPath}`);
  console.log('');
});

const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { server };
