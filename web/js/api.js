/**
 * api.js — docs/PROTOCOL.md 的 6 个 HTTP 接口的极薄 fetch 封装。
 * 服务端权威：这里不做任何状态缓存，只负责请求/解析/抛错。
 */

const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: method === 'GET' ? undefined : JSON_HEADERS,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw Object.assign(new Error('网络异常，无法连接服务端'), { status: 0, cause: err });
  }

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON 响应，走下面的错误分支 */
  }

  if (!res.ok) {
    const error = json?.error ?? `${res.status} ${res.statusText}`;
    throw Object.assign(new Error(error), { status: res.status, payload: json });
  }
  return json;
}

export const api = {
  /** GET  /api/state  → { view }（初次加载 / 静默刷新，无事件） */
  state: () => request('GET', '/api/state'),

  /** POST /api/action { action, amount? } → { view, events } */
  action: (action, amount) =>
    request('POST', '/api/action', amount === undefined ? { action } : { action, amount }),

  /** POST /api/read → { view, events } */
  read: () => request('POST', '/api/read'),

  /** POST /api/speak { skill } → { view, events } */
  speak: (skill) => request('POST', '/api/speak', { skill }),

  /** POST /api/object { id } → { view, events, ok, reason? } */
  object: (id) => request('POST', '/api/object', { id }),

  /** POST /api/newgame → { view, events } */
  newgame: () => request('POST', '/api/newgame'),
};
