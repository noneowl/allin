/**
 * api.js — docs/PROTOCOL.md（v5 · Tell Window 循环）的 6 个 HTTP 接口的极薄 fetch 封装。
 * 服务端权威：这里不做任何状态缓存，只负责请求/解析/抛错。
 *
 *   GET  /api/state      → { view }（含 tellWindow / player.focus / gotcha 窗口条件）
 *   POST /api/action     { action, amount? } → { view, events }
 *                         （任何成功行动都会关闭当前 Tell Window 并清空碎片与 PIN）
 *   POST /api/read       → { view, events }（必须在 Tell Window 内 + Focus 充足 + 冷却结束；
 *                            响应事件 read_batch 带 tellWindowId / actionId）
 *   POST /api/pin        { fragmentId } → { view, events }（单槽；只能 PIN 当前窗口的碎片）
 *   POST /api/gotcha     {} → { view, events }（资格×时机窗口：EXPOSED × 转/河 × 高承诺行动）
 *   POST /api/newgame    → { view, events }
 *
 * 错误码（400）：NO_TELL_WINDOW（不在窗口内 / 未轮到你）/ NO_FOCUS / READ_COOLING /
 * GOTCHA_AUTO_READ（负债阶段手动 READ 禁用）、BAD_FRAGMENT（含跨窗口残留的旧 id）/
 * PIN_NOT_ALLOWED、GOTCHA_WINDOW_CLOSED / ALREADY_GOTCHA / GOTCHA_LOCKED、
 * NOT_GOTCHA（NORMAL 里裸 bet/raise）、GOTCHA_ACTIONS（负债阶段的 pressure/heavy）、
 * NOT_YOUR_TURN / HAND_OVER / BATTLE_OVER。
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
   *  NORMAL：fold|call|check|pressure|heavy|allin（bet/raise → 400 NOT_GOTCHA）
   *  GOTCHA：fold|call|check|raise（raise 省略 amount = 服务端按阶梯给；
   *          pressure/heavy/allin → 400 GOTCHA_ACTIONS）。 */
  action: (action, amount) =>
    request('POST', '/api/action', amount === undefined ? { action } : { action, amount }),

  /** POST /api/read → { view, events }（事件里带 read_batch 批量碎片） */
  read: () => request('POST', '/api/read'),

  /** POST /api/pin { fragmentId } → { view, events }（view.pin = { text, verified }） */
  pin: (fragmentId) => request('POST', '/api/pin', { fragmentId }),

  /** POST /api/gotcha {} → { view, events }（事件里带 mode:"GOTCHA"） */
  gotcha: () => request('POST', '/api/gotcha', {}),

  /** POST /api/newgame → { view, events }（随时可用，热加载 balance.json） */
  newgame: () => request('POST', '/api/newgame'),
};
