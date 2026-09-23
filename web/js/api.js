/**
 * api.js — docs/PROTOCOL.md（v3）的 5 个 HTTP 接口的极薄 fetch 封装。
 * 服务端权威：这里不做任何状态缓存，只负责请求/解析/抛错。
 *
 *   GET  /api/state      → { view }
 *   POST /api/action     { action, amount? } → { view, events }
 *   POST /api/read       → { view, events }（无限次，READ_COOLDOWN_MS 冷却）
 *   POST /api/gotcha     { guess: "BLUFF" | "STRONG" } → { view, events }
 *   POST /api/newgame    → { view, events }
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
    throw Object.assign(new Error(error), { status: res.status, code: json?.code, payload: json });
  }
  return json;
}

export const api = {
  /** GET  /api/state  → { view }（初次加载 / 静默刷新，无事件） */
  state: () => request('GET', '/api/state'),

  /** POST /api/action { action, amount? } → { view, events }
   *  action ∈ fold|call|check|pressure|heavy|allin|bet|raise；
   *  bet/raise 仅 EXECUTION 模式合法（否则 400 NOT_EXECUTION）。 */
  action: (action, amount) =>
    request('POST', '/api/action', amount === undefined ? { action } : { action, amount }),

  /** POST /api/read → { view, events}（事件里带 read_fragment 闪现） */
  read: () => request('POST', '/api/read'),

  /** POST /api/gotcha { guess } → { view, events }（事件里带 gotcha_result） */
  gotcha: (guess) => request('POST', '/api/gotcha', { guess }),

  /** POST /api/newgame → { view, events }（随时可用，热加载 balance.json） */
  newgame: () => request('POST', '/api/newgame'),
};
