const JSON_HEADERS = { 'Content-Type': 'application/json' };
const STORAGE_KEY = 'allin.auth';

/** { room, token } for the seat this browser is sitting in. */
let auth = { room: null, token: null };
const listeners = new Set();

export function setAuth(room, token, { persist = true } = {}) {
  auth = { room: room ?? null, token: token ?? null };
  if (persist) {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(auth));
    } catch {
      /* private mode */
    }
  }
  for (const fn of listeners) fn(auth);
}

export function getAuth() {
  return { ...auth };
}

export function onAuthChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Pick up an invite link, then fall back to whatever this tab already had. */
export function restoreAuth() {
  const params = new URLSearchParams(location.search);
  const room = params.get('room');
  const token = params.get('token');
  if (token) {
    setAuth(room, token);
    return { ...auth, fromLink: true };
  }
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null');
    if (saved?.token) auth = { room: saved.room ?? null, token: saved.token };
  } catch {
    /* ignore */
  }
  return { ...auth, fromLink: false };
}

export function clearAuth() {
  setAuth(null, null, { persist: false });
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export function clearInviteParams() {
  if (location.search) history.replaceState(null, '', location.pathname);
}

function authQuery() {
  const q = new URLSearchParams();
  if (auth.room) q.set('room', auth.room);
  if (auth.token) q.set('token', auth.token);
  const s = q.toString();
  return s ? `?${s}` : '';
}

async function request(method, path, body, { scoped = false } = {}) {
  const url = scoped ? `${path}${authQuery()}` : path;
  const res = await fetch(url, {
    method,
    headers: method === 'GET' ? undefined : JSON_HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* fall through to the raw text */
  }
  if (!res.ok) {
    const error = json?.error ?? `${res.status} ${res.statusText}`;
    throw Object.assign(new Error(error), { status: res.status, payload: json });
  }
  return json;
}

export const api = {
  bootstrap: () => request('GET', '/api/bootstrap'),
  saveConfig: (patch) => request('POST', '/api/config', patch),
  testConfig: (patch) => request('POST', '/api/config/test', patch),
  models: (params) => request('GET', `/api/models?${new URLSearchParams(params)}`),

  createRoom: (payload) => request('POST', '/api/room', payload),
  joinRoom: (roomId, token) => request('POST', '/api/room/join', { roomId, token }),
  room: () => request('GET', '/api/room', undefined, { scoped: true }),
  invites: () => request('GET', '/api/room/invites', undefined, { scoped: true }),
  setSeat: (seat, type, personalityId) =>
    request('POST', '/api/room/seat', { seat, type, personalityId }, { scoped: true }),

  action: (action) => request('POST', '/api/room/action', action, { scoped: true }),
  nextHand: () => request('POST', '/api/room/next', {}, { scoped: true }),
  restart: () => request('POST', '/api/room/restart', {}, { scoped: true }),
  force: (seat) => request('POST', '/api/room/force', { seat }, { scoped: true }),
  retry: () => request('POST', '/api/room/retry', {}, { scoped: true }),
  cancel: () => request('POST', '/api/room/cancel', {}, { scoped: true }),
};

/** Subscribe to the server-sent event stream. Returns a disposer. */
export function connectEvents(handlers = {}) {
  const source = new EventSource(`/api/events${authQuery()}`);
  const bind = (name, fn) => {
    if (!fn) return;
    source.addEventListener(name, (event) => {
      let data = null;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      fn(data);
    });
  };

  bind('state', handlers.onState);
  bind('game_new', handlers.onGameNew);
  bind('ai_start', handlers.onAiStart);
  bind('ai_done', handlers.onAiDone);
  bind('ai_error', handlers.onAiError);
  bind('toast', handlers.onToast);

  source.addEventListener('open', () => handlers.onOpen?.());
  source.addEventListener('error', () => handlers.onError?.());
  return () => source.close();
}
