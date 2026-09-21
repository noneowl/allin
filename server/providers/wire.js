import { WIRE, WIRE_PATH, wireForModel } from './catalog.js';

export class ProviderError extends Error {
  constructor(message, { status = 0, body = null, code = 'PROVIDER_ERROR' } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.body = body;
    this.code = code;
  }
}

const trimBase = (baseUrl) => String(baseUrl || '').replace(/\/+$/, '');

/** Build the shared auth/tracing headers a provider expects. */
function buildHeaders({ apiKey, sessionId, providerId, extra = {} }) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    // OpenCode asks clients to identify themselves instead of looking like a raw SDK.
    'User-Agent': 'dezhou-poker/1.0 (+https://github.com/local/dezhou)',
    ...extra,
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  // Stable per-conversation id so the gateway can route and cache prompts.
  if (sessionId && (providerId === 'opencode-go' || providerId === 'opencode-zen')) {
    headers['x-opencode-session'] = String(sessionId).slice(0, 128);
  }
  return headers;
}

async function requestJson(url, { method = 'POST', headers, body, timeoutMs = 45000, signal }) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: composed,
    });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new ProviderError(`请求超时（${Math.round(timeoutMs / 1000)} 秒）：${url}`, {
        code: err?.name === 'TimeoutError' ? 'TIMEOUT' : 'ABORTED',
      });
    }
    throw new ProviderError(`无法连接 ${url}：${err?.message ?? err}`, { code: 'NETWORK' });
  }

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* keep raw text for the error message */
  }

  if (!res.ok) {
    const detail =
      json?.error?.message ??
      json?.message ??
      json?.error ??
      (text ? text.slice(0, 400) : '');
    throw new ProviderError(`${res.status} ${res.statusText}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`, {
      status: res.status,
      body: json ?? text,
      code: res.status === 401 || res.status === 403 ? 'AUTH' : 'HTTP',
    });
  }
  return json ?? {};
}

/** Normalise the many shapes a chat/completions message body can take. */
function readChatContent(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text ?? part?.content ?? ''))
      .join('');
  }
  if (typeof message?.reasoning_content === 'string' && !content) return message.reasoning_content;
  return '';
}

function readAnthropicContent(payload) {
  const blocks = payload?.content;
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((b) => b?.type === 'text' || typeof b?.text === 'string')
    .map((b) => b.text)
    .join('');
}

function readResponsesContent(payload) {
  if (typeof payload?.output_text === 'string' && payload.output_text) return payload.output_text;
  const out = payload?.output;
  if (!Array.isArray(out)) return '';
  const parts = [];
  for (const item of out) {
    if (typeof item?.content === 'string') parts.push(item.content);
    else if (Array.isArray(item?.content)) {
      for (const c of item.content) {
        if (typeof c?.text === 'string') parts.push(c.text);
      }
    }
  }
  return parts.join('');
}

/**
 * One completion from any supported wire protocol.
 *
 * @param {object} opts
 * @param {string} opts.providerId
 * @param {string} opts.baseUrl
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {{role:string, content:string}[]} opts.messages  system/user/assistant
 * @returns {Promise<{ text:string, raw:any, wire:string, usage:any }>}
 */
export async function complete(opts) {
  const { providerId, baseUrl, apiKey, model, messages } = opts;
  if (!baseUrl) throw new ProviderError('未配置 Base URL', { code: 'CONFIG' });
  if (!model) throw new ProviderError('未配置模型', { code: 'CONFIG' });

  const wire = wireForModel(providerId, model);
  const base = trimBase(baseUrl);
  const url = `${base}${WIRE_PATH[wire]}`;
  const headers = buildHeaders(opts);
  const timeoutMs = opts.timeoutMs ?? 45000;
  const maxTokens = opts.maxTokens ?? 600;
  const temperature = opts.temperature ?? 0.7;

  if (wire === WIRE.CHAT) {
    const body = { model, messages, max_tokens: maxTokens, temperature };
    if (opts.jsonMode) body.response_format = { type: 'json_object' };
    let json;
    try {
      json = await requestJson(url, { headers, body, timeoutMs, signal: opts.signal });
    } catch (err) {
      // Some newer OpenAI models reject `max_tokens` in favour of `max_completion_tokens`.
      const retryable =
        err instanceof ProviderError &&
        err.status === 400 &&
        /max_tokens|max_completion_tokens|response_format/i.test(String(err.body?.error?.message ?? err.message));
      if (!retryable) throw err;
      const retryBody = { model, messages, max_completion_tokens: maxTokens, temperature };
      json = await requestJson(url, { headers, body: retryBody, timeoutMs, signal: opts.signal });
    }
    const choice = json?.choices?.[0];
    return {
      text: readChatContent(choice?.message ?? choice),
      raw: json,
      wire,
      usage: json?.usage ?? null,
      finishReason: choice?.finish_reason ?? null,
    };
  }

  if (wire === WIRE.MESSAGES) {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const rest = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content) }));
    const json = await requestJson(url, {
      headers,
      body: { model, max_tokens: maxTokens, temperature, system: system || undefined, messages: rest },
      timeoutMs,
      signal: opts.signal,
    });
    return {
      text: readAnthropicContent(json),
      raw: json,
      wire,
      usage: json?.usage ?? null,
      finishReason: json?.stop_reason ?? null,
    };
  }

  // OpenAI Responses API
  const instructions = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const input = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content) }));
  const json = await requestJson(url, {
    headers,
    body: {
      model,
      input,
      instructions: instructions || undefined,
      max_output_tokens: maxTokens,
      temperature,
    },
    timeoutMs,
    signal: opts.signal,
  });
  return {
    text: readResponsesContent(json),
    raw: json,
    wire,
    usage: json?.usage ?? null,
    finishReason: json?.status ?? null,
  };
}

/** List model ids available at a base URL. */
export async function listModels({ providerId, baseUrl, apiKey, timeoutMs = 15000, sessionId }) {
  if (!baseUrl) throw new ProviderError('未配置 Base URL', { code: 'CONFIG' });
  const url = `${trimBase(baseUrl)}/models`;
  const headers = buildHeaders({ apiKey, sessionId, providerId, extra: {} });
  delete headers['Content-Type'];
  const json = await requestJson(url, { method: 'GET', headers, timeoutMs });
  const rows = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
  return rows
    .map((m) => (typeof m === 'string' ? m : m?.id ?? m?.name))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}
