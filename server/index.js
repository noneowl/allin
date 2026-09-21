import http from 'node:http';
import os from 'node:os';
import { join } from 'node:path';
import { loadConfig, saveConfig, publicConfig, configPath, ROOT } from './config.js';
import { providerCatalog, testProvider, fetchModels } from './providers/index.js';
import { roster, personalityById } from './ai/personalities.js';
import { RoomStore, ROOM_LIMITS, newSeatToken } from './rooms.js';
import { serveStatic } from './static.js';

const WEB_ROOT = join(ROOT, 'web');
const PORT = Number(process.env.PORT ?? 8787);
// Bind to every interface so the table can be shared across the local network.
const HOST = process.env.HOST ?? '0.0.0.0';
const MAX_BODY = 512 * 1024;
const ROOM_COOKIE = 'allin_room';
const TOKEN_COOKIE = 'allin_token';

// `ready` is derived on every read so live config edits take effect mid-hand.
const getConfig = () => {
  const cfg = loadConfig();
  return { ...cfg, ready: publicConfig().ready };
};
const rooms = new RoomStore({ getConfig });

// ------------------------------------------------------------------ helpers

/** Non-loopback IPv4 addresses, best candidates first, for invite links. */
function lanAddresses() {
  const virtual = /^(utun|bridge|awdl|llw|lo|gif|stf|anpi|ap)\d/i;
  const linkLocal = /^169\.254\./;
  const benchmark = /^198\.(18|19)\./; // RFC 2544 range, used by tunnel interfaces
  const physical = [];
  const other = [];
  for (const [iface, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      if (linkLocal.test(addr.address) || benchmark.test(addr.address)) continue;
      const entry = { iface, address: addr.address };
      // Virtual interfaces are listed, but only if there is nothing better:
      // a guest cannot reach a VPN tunnel or a VM bridge.
      if (virtual.test(iface)) other.push(entry);
      else physical.push(entry);
    }
  }
  const ordered = [...physical.sort((a, b) => (/^en\d/i.test(b.iface) ? 1 : 0) - (/^en\d/i.test(a.iface) ? 1 : 0) || a.iface.localeCompare(b.iface))];
  return ordered.length ? ordered : other;
}

const isLoopbackHost = (host) => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host ?? '');

/**
 * The base URL a guest should open. If the host is browsing via localhost the
 * link would be useless to anyone else, so fall back to the LAN address.
 */
function inviteBaseUrl(req) {
  const host = req.headers.host ?? '';
  if (host && !isLoopbackHost(host)) return `http://${host}`;
  const lan = lanAddresses()[0];
  return lan ? `http://${lan.address}:${PORT}` : `http://${host || `127.0.0.1:${PORT}`}`;
}

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

function setAuthCookies(res, roomId, token) {
  const base = 'Path=/; HttpOnly; SameSite=Lax; Max-Age=86400';
  res.setHeader('Set-Cookie', [`${ROOM_COOKIE}=${roomId}; ${base}`, `${TOKEN_COOKIE}=${token}; ${base}`]);
}

/** Which room/token this request carries. Query wins over cookie so a shared
 *  link works on first open and then survives a refresh. */
function resolveAuth(req, url) {
  const cookies = parseCookies(req.headers.cookie);
  const roomId = String(url.searchParams.get('room') || cookies[ROOM_COOKIE] || '').toUpperCase();
  const token = url.searchParams.get('token') || cookies[TOKEN_COOKIE] || '';
  return { roomId, token };
}

function requireSeat(req, url) {
  const { roomId, token } = resolveAuth(req, url);
  // A room code is optional: a seat token identifies the room on its own.
  const room = rooms.get(roomId) ?? rooms.findByToken(token);
  if (!room) throw Object.assign(new Error('牌局不存在或已结束'), { status: 404 });
  const seat = room.seatForToken(token);
  if (!seat) throw Object.assign(new Error('入场凭证无效，请用邀请链接重新进入'), { status: 403 });
  return { room, seat, isHost: room.isHost(token) };
}

/**
 * Invite links for the human seats, excluding the requester's own.
 *
 * Your own seat is not an invitation — sharing it would hand someone your
 * chair — so it never appears in the list.
 */
function inviteLinks(room, req, excludeSeat = null) {
  const base = inviteBaseUrl(req);
  return room.humanSeats
    .filter((seat) => seat.index !== excludeSeat)
    .map((seat) => ({
      seat: seat.index,
      name: seat.name,
      connected: seat.connected,
      url: `${base}/?room=${room.id}&seat=${seat.index}&token=${seat.token}`,
    }));
}

/**
 * Seats currently occupied by an AI, which the host can hand to a person
 * instead. This is what makes "invite someone" possible on a table that was
 * created with the quick-start defaults (one human + N AI).
 */
function openSeats(room) {
  return room.seatConfig
    .filter((seat) => seat.type === 'ai')
    .map((seat) => ({
      index: seat.index,
      name: seat.name,
      avatar: seat.avatar,
      personalityId: seat.personalityId,
    }));
}

function sse(req, res, controller, viewerSeat) {
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
      /* the socket went away; close handler cleans up */
    }
  };

  // Each subscriber serialises its OWN view, so a seat can never receive
  // another seat's private cards.
  send('state', controller.view(viewerSeat));
  const unsubscribe = controller.subscribe((event, payload) => {
    if (event === 'state') send('state', controller.view(viewerSeat));
    else send(event, payload);
  });

  controller.addConnection(viewerSeat);

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
    controller.removeConnection(viewerSeat);
  });
}

// ------------------------------------------------------------------- routes

const ROUTES = {
  'GET /api/bootstrap': (req, res) => {
    sendJson(res, 200, {
      config: publicConfig(),
      providers: providerCatalog(),
      roster: roster(),
      limits: { ...ROOM_LIMITS },
      lan: lanAddresses(),
      inviteBase: inviteBaseUrl(req),
      configPath,
    });
  },

  'GET /api/state': (req, res, ctx) => sendJson(res, 200, ctx.room.controller.view(ctx.seat.index)),

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
    saveConfig(body);
    sendJson(res, 200, { ok: true, config: publicConfig() });
  },

  'POST /api/config/test': async (req, res) => {
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
    sendJson(res, 200, await testProvider(probe, { sessionId: 'connectivity-test' }));
  },

  // ------------------------------------------------------------- lobby

  'POST /api/room': async (req, res) => {
    const body = await readBody(req);
    const room = rooms.create({
      seatCount: body.seats,
      seats: body.players,
      rules: body.rules ?? body,
    });
    const host = room.seatConfig[room.hostSeat];
    setAuthCookies(res, room.id, host.token);

    await room.controller.newGame({ waitForAI: false });
    sendJson(res, 200, {
      ok: true,
      roomId: room.id,
      seat: host.index,
      token: host.token,
      room: room.describe(),
      invites: inviteLinks(room, req, host.index),
    });
  },

  'POST /api/room/join': async (req, res) => {
    const body = await readBody(req);
    const roomId = String(body.roomId ?? '').toUpperCase();
    const room = rooms.get(roomId);
    if (!room) {
      sendJson(res, 404, { error: '找不到这个牌局，让房主重新发一次链接' });
      return;
    }
    const seat = body.token
      ? room.seatForToken(body.token)
      : room.humanSeats.find((s) => !s.connected);
    if (!seat) {
      sendJson(res, 403, { error: '链接无效，或者这个座位已经被别人坐了' });
      return;
    }
    setAuthCookies(res, room.id, seat.token);
    sendJson(res, 200, {
      ok: true,
      roomId: room.id,
      seat: seat.index,
      token: seat.token,
      room: room.describe(),
      isHost: room.isHost(seat.token),
    });
  },

  'GET /api/room': (req, res, ctx) => {
    sendJson(res, 200, {
      ok: true,
      roomId: ctx.room.id,
      seat: ctx.seat.index,
      isHost: ctx.isHost,
      room: ctx.room.describe(),
      invites: ctx.isHost ? inviteLinks(ctx.room, req, ctx.seat.index) : [],
      openSeats: ctx.isHost ? openSeats(ctx.room) : [],
      state: ctx.room.controller.view(ctx.seat.index),
    });
  },

  'GET /api/room/invites': (req, res, ctx) => {
    if (!ctx.isHost) {
      sendJson(res, 403, { error: '只有房主可以查看邀请链接' });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      invites: inviteLinks(ctx.room, req, ctx.seat.index),
      openSeats: openSeats(ctx.room),
    });
  },

  /**
   * Turn a seat into a human one (and back), so the host can invite somebody
   * to an existing table instead of having to rebuild it from the lobby.
   * The seat composition is part of the table, so a fresh hand is dealt.
   */
  'POST /api/room/seat': async (req, res, ctx) => {
    if (!ctx.isHost) {
      sendJson(res, 403, { error: '只有房主可以改座位' });
      return;
    }
    const body = await readBody(req);
    const index = Number(body.seat);
    const seat = ctx.room.seatConfig[index];
    if (!seat) {
      sendJson(res, 404, { error: `没有 ${body.seat} 号座位` });
      return;
    }
    if (index === ctx.room.hostSeat && body.type !== 'human') {
      sendJson(res, 400, { error: '房主自己的座位不能改成 AI' });
      return;
    }
    const type = body.type === 'human' ? 'human' : 'ai';
    if (seat.type !== type) {
      seat.type = type;
      seat.connected = false;
      if (type === 'human') {
        // A brand new credential: the old AI seat never had one worth keeping.
        seat.token = newSeatToken();
        seat.personalityId = null;
        if (!seat.name || /^AI /.test(seat.name)) seat.name = `玩家 ${index + 1}`;
      } else {
        const personality = personalityById(body.personalityId ?? seat.personalityId);
        seat.personalityId = personality.id;
        seat.name = personality.name;
        seat.avatar = personality.avatar;
      }
      await ctx.room.controller.newGame({ waitForAI: false });
    }
    sendJson(res, 200, {
      ok: true,
      room: ctx.room.describe(),
      invites: inviteLinks(ctx.room, req, ctx.seat.index),
      openSeats: openSeats(ctx.room),
    });
  },

  'POST /api/room/restart': async (req, res, ctx) => {
    if (!ctx.isHost) {
      sendJson(res, 403, { error: '只有房主可以重开一局' });
      return;
    }
    await ctx.room.controller.newGame({ waitForAI: false });
    sendJson(res, 200, ctx.room.controller.view(ctx.seat.index));
  },

  // ------------------------------------------------------------ gameplay

  'POST /api/room/action': async (req, res, ctx) => {
    const body = await readBody(req);
    if (!body || typeof body.action !== 'string') {
      sendJson(res, 400, { error: '缺少 action 字段' });
      return;
    }
    await ctx.room.controller.humanAction(ctx.seat.index, { action: body.action, amount: body.amount });
    sendJson(res, 200, ctx.room.controller.view(ctx.seat.index));
  },

  'POST /api/room/next': async (req, res, ctx) => {
    await ctx.room.controller.nextHand({ waitForAI: false });
    sendJson(res, 200, ctx.room.controller.view(ctx.seat.index));
  },

  'POST /api/room/force': async (req, res, ctx) => {
    if (!ctx.isHost) {
      sendJson(res, 403, { error: '只有房主可以托管' });
      return;
    }
    const body = await readBody(req);
    await ctx.room.controller.forceAction(Number(body.seat));
    sendJson(res, 200, ctx.room.controller.view(ctx.seat.index));
  },

  'POST /api/room/retry': async (req, res, ctx) => {
    await ctx.room.controller.retryCurrentAI();
    sendJson(res, 200, ctx.room.controller.view(ctx.seat.index));
  },

  'POST /api/room/cancel': (req, res, ctx) => {
    ctx.room.controller.cancelAI();
    sendJson(res, 200, { ok: true });
  },
};

// -------------------------------------------------------------------- server

// Routes that need a validated seat before they may run. Everything else under
// /api/room is public (creating or joining a room).
const ROOM_SCOPED = new Set([
  'GET /api/state',
  'GET /api/room',
  'GET /api/room/invites',
  'POST /api/room/restart',
  'POST /api/room/action',
  'POST /api/room/next',
  'POST /api/room/force',
  'POST /api/room/seat',
  'POST /api/room/retry',
  'POST /api/room/cancel',
]);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const key = `${req.method} ${url.pathname}`;

  try {
    if (key === 'GET /api/events') {
      const { roomId, token } = resolveAuth(req, url);
      const room = rooms.get(roomId);
      const seat = room?.seatForToken(token);
      if (!room || !seat) {
        sendJson(res, 403, { error: '牌局不存在或凭证无效' });
        return;
      }
      sse(req, res, room.controller, seat.index);
      return;
    }

    const handler = ROUTES[key];
    if (handler) {
      if (ROOM_SCOPED.has(key)) {
        const ctx = requireSeat(req, url);
        // A link brought us here: persist it so a refresh keeps working.
        if (url.searchParams.get('token')) setAuthCookies(res, ctx.room.id, url.searchParams.get('token'));
        await handler(req, res, ctx);
      } else {
        await handler(req, res);
      }
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: `未知接口：${key}` });
      return;
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(WEB_ROOT, url.pathname, req, res)) {
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  } catch (err) {
    const status = err?.status ?? (err?.name === 'GameError' ? 400 : 500);
    if (status >= 500) console.error(`[${key}]`, err);
    if (!res.headersSent) {
      sendJson(res, status, { error: err?.message ?? '服务器内部错误', code: err?.code ?? null });
    } else {
      res.end();
    }
  }
});

server.listen(PORT, HOST, () => {
  const cfg = publicConfig();
  const lan = lanAddresses();
  const loopbackOnly = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';
  console.log('');
  console.log('  ♠ ♥ allin · 德州扑克，对手是 LLM  ♦ ♣');
  console.log('');
  console.log(`  本机   → http://localhost:${PORT}`);
  if (loopbackOnly) {
    console.log('');
    console.log('  ⚠ HOST 绑定在回环地址上，同网络的其他人打不开邀请链接。');
    console.log('    想让朋友入座，请用 HOST=0.0.0.0 启动。');
  } else {
    for (const { iface, address } of lan) {
      console.log(`  局域网 → http://${address}:${PORT}   (${iface})`);
    }
    if (lan.length === 0) console.log('  （没检测到局域网地址，暂时只有本机能访问）');
  }
  console.log('');
  console.log(`  供应商 : ${cfg.provider}`);
  console.log(`  模型   : ${cfg.model || '(未配置)'}`);
  console.log(`  API Key: ${cfg.hasApiKey ? `已配置 (${cfg.apiKeyHint})` : '未配置 — 打开页面右上角「设置」填写'}`);
  console.log(`  设置   : ${configPath}`);
  console.log('');
});

setInterval(() => rooms.sweep(), 10 * 60 * 1000).unref();

const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { server };
