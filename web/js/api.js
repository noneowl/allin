const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function request(method, url, body) {
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
    const message = json?.error ?? `${res.status} ${res.statusText}`;
    throw Object.assign(new Error(message), { status: res.status, payload: json });
  }
  return json;
}

export const api = {
  bootstrap: () => request('GET', '/api/bootstrap'),
  state: () => request('GET', '/api/state'),
  saveConfig: (patch) => request('POST', '/api/config', patch),
  testConfig: (patch) => request('POST', '/api/config/test', patch),
  models: (params) => request('GET', `/api/models?${new URLSearchParams(params)}`),
  newGame: (rules) => request('POST', '/api/game/new', rules ?? {}),
  startHand: () => request('POST', '/api/game/start', {}),
  nextHand: (delayMs = 0) => request('POST', '/api/game/next', { delayMs }),
  action: (action) => request('POST', '/api/game/action', action),
  retry: () => request('POST', '/api/game/retry', {}),
  cancel: () => request('POST', '/api/game/cancel', {}),
  reset: () => request('POST', '/api/game/reset', {}),
};

/**
 * Subscribe to the server-sent event stream. Returns a disposer.
 */
export function connectEvents(handlers = {}) {
  const source = new EventSource('/api/events');
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
