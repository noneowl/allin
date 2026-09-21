import { complete, ProviderError } from '../providers/index.js';
import { GameError } from '../engine/table.js';
import { buildMessages, buildReactionMessages } from './prompt.js';
import { mockDecision, mockReaction } from './mock.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Only the offline demo provider short-circuits the network. */
const DEMO_PROVIDER = 'mock';

/** Hard ceiling when auto-growing the output budget after a truncation. */
const MAX_TOKEN_BUDGET = 8000;

export class AIError extends Error {
  constructor(message, { cause, attempts = [], failures = [] } = {}) {
    super(message);
    this.name = 'AIError';
    this.cause = cause;
    this.attempts = attempts;
    this.failures = failures;
  }
}

const ACTION_ALIASES = {
  fold: 'fold',
  f: 'fold',
  check: 'check',
  x: 'check',
  call: 'call',
  c: 'call',
  bet: 'bet',
  b: 'bet',
  raise: 'raise',
  r: 'raise',
  all_in: 'all_in',
  allin: 'all_in',
  all_in_raise: 'all_in',
  shove: 'all_in',
  jam: 'all_in',
  push: 'all_in',
};

/**
 * Pull the first complete JSON object out of a model reply.
 * Tolerates code fences, prose before/after, and trailing commas.
 */
export function extractJsonObject(text) {
  if (!text) return null;
  let s = String(text).trim();

  const fence = s.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();

  const start = s.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }

  const slice = end === -1 ? s.slice(start) : s.slice(start, end + 1);
  const candidates = [slice, slice.replace(/,\s*([}\]])/g, '$1')];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

const toText = (v, limit = 300) => (typeof v === 'string' ? v.trim().slice(0, limit) : '');

/**
 * Turn raw model text into a candidate decision.
 * @returns {{ ok:true, value:object } | { ok:false, error:string, raw:string }}
 */
export function parseDecision(text) {
  if (!text || !String(text).trim()) {
    return {
      ok: false,
      error: '模型没有输出任何内容——推理模型的思考 token 可能已经吃满了 max_tokens，请调大它',
      raw: text,
    };
  }

  const json = extractJsonObject(text);
  if (!json) return { ok: false, error: '输出里没有找到合法的 JSON 对象', raw: text };

  const rawAction = json.action ?? json.type ?? json.move ?? json.decision;
  if (rawAction === undefined || rawAction === null || rawAction === '') {
    return { ok: false, error: 'JSON 里缺少 action 字段', raw: text };
  }

  const key = String(rawAction).trim().toLowerCase().replace(/[\s-]+/g, '_');
  const action = ACTION_ALIASES[key];
  if (!action) {
    return { ok: false, error: `action "${rawAction}" 不是被允许的动作`, raw: text };
  }

  const amountRaw = json.amount ?? json.to ?? json.raise_to ?? json.raiseTo ?? json.total ?? json.size ?? null;
  let amount = null;
  if (amountRaw !== null && amountRaw !== undefined && amountRaw !== '') {
    amount = Number(String(amountRaw).replace(/[^0-9.-]/g, ''));
    if (!Number.isFinite(amount)) {
      return { ok: false, error: `amount "${amountRaw}" 不是有效数字`, raw: text };
    }
  }

  return {
    ok: true,
    value: {
      action,
      amount,
      reasoning: toText(json.reasoning ?? json.reason ?? json.why, 200),
      tableTalk: toText(json.table_talk ?? json.tableTalk ?? json.talk ?? json.say, 120),
      raw: typeof text === 'string' ? text.slice(0, 2000) : '',
    },
  };
}

/**
 * Rules-derived emergency action used only when the provider is unreachable.
 * This is not a strategy: it takes the free option if there is one.
 */
export function fallbackAction(table, seatIdx) {
  const legal = table.legalActions(seatIdx);
  if (legal.some((a) => a.type === 'check')) return { type: 'check', fallback: true };
  return { type: 'fold', fallback: true };
}

/**
 * One LLM-driven opponent. Every action this class returns comes from the
 * configured provider; nothing is decided locally.
 */
export class PokerAgent {
  constructor({ config, personality, sessionId, tableTalk = true, reasoning = true }) {
    this.config = config;
    this.personality = personality;
    this.sessionId = sessionId;
    this.tableTalk = tableTalk;
    this.reasoning = reasoning;
  }

  async decide(table, seatIdx, { signal, maxAttempts = 3 } = {}) {
    const failures = [];
    const attemptLog = [];
    const startedAt = Date.now();
    // Grows automatically if the provider reports a truncated reply.
    let budget = this.config.maxTokens ?? 1500;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const messages = buildMessages({
        table,
        seatIdx,
        personality: this.personality,
        tableTalk: this.tableTalk,
        reasoning: this.reasoning,
        failures,
      });

      let response;
      try {
        if (this.config.provider === DEMO_PROVIDER) {
          // Offline demo: no network, but the same JSON protocol and the same
          // validation below, so nothing about the real path is bypassed.
          const delay = this.config.demoDelayMs ?? 500 + Math.random() * 900;
          if (delay > 0) await sleep(delay);
          if (signal?.aborted) {
            throw new ProviderError('已取消', { code: 'ABORTED' });
          }
          response = { text: mockDecision(table, seatIdx, this.personality), usage: null, wire: 'demo' };
        } else {
          response = await complete({
            providerId: this.config.provider,
            baseUrl: this.config.baseUrl,
            apiKey: this.config.apiKey,
            model: this.config.model,
            messages,
            maxTokens: budget,
            temperature: this.config.temperature,
            timeoutMs: this.config.timeoutMs,
            sessionId: this.sessionId,
            signal,
          });
        }
      } catch (err) {
        const fatal =
          err instanceof ProviderError && (err.code === 'AUTH' || err.code === 'CONFIG' || err.code === 'ABORTED');
        attemptLog.push({ attempt, transportError: err.message });
        if (fatal || attempt >= maxAttempts) {
          throw new AIError(`${this.personality.name} 的决策请求失败：${err.message}`, {
            cause: err,
            attempts: attemptLog,
            failures,
          });
        }
        failures.push({ raw: '', error: `请求出错（${err.message}），请重新输出 JSON。` });
        continue;
      }

      const parsed = parseDecision(response.text);
      if (!parsed.ok) {
        // A reasoning model can burn the whole output budget on thinking and
        // emit nothing, or emit half a JSON object. Grow the budget and retry.
        if (response.finishReason === 'length') {
          const grown = Math.min(budget * 2, MAX_TOKEN_BUDGET);
          attemptLog.push({ attempt, truncated: true, budget, retriedWith: grown });
          failures.push({
            raw: response.text,
            error: `输出被 max_tokens=${budget} 截断了（推理模型的思考 token 也计入这个预算）。已把预算调大到 ${grown}，请重新只输出 JSON。`,
          });
          budget = grown;
        } else {
          attemptLog.push({ attempt, parseError: parsed.error });
          failures.push({ raw: response.text, error: parsed.error });
        }
        continue;
      }

      try {
        const requested = { action: parsed.value.action };
        if (parsed.value.amount !== null) requested.amount = parsed.value.amount;
        const normalized = table.normalizeAction(seatIdx, requested);
        attemptLog.push({ attempt, action: normalized.type, ok: true });
        return {
          action: normalized.type,
          amount: normalized.to ?? null,
          requested,
          normalized,
          reasoning: parsed.value.reasoning,
          tableTalk: parsed.value.tableTalk,
          attempts: attempt,
          attemptLog,
          latencyMs: Date.now() - startedAt,
          usage: response.usage,
          finishReason: response.finishReason ?? null,
          wire: response.wire,
          model: this.config.model,
          provider: this.config.provider,
          personality: this.personality,
        };
      } catch (err) {
        if (err instanceof GameError) {
          attemptLog.push({ attempt, illegal: err.message });
          failures.push({ raw: response.text, error: err.message });
          continue;
        }
        throw err;
      }
    }

    throw new AIError(`${this.personality.name} 连续 ${maxAttempts} 次都没有给出合法动作`, {
      attempts: attemptLog,
      failures,
    });
  }

  /**
   * One short line about the hand that just finished.
   *
   * Best-effort by design: a post-hand remark must never break the game, so any
   * failure resolves to null instead of throwing.
   */
  async react(table, seatIdx, { signal } = {}) {
    const messages = buildReactionMessages({ table, seatIdx, personality: this.personality });
    if (!messages) return null;

    const budget = Math.min(this.config.maxTokens ?? 1500, 1200);
    const startedAt = Date.now();

    try {
      let text;
      if (this.config.provider === DEMO_PROVIDER) {
        if (this.config.demoDelayMs !== 0) await sleep(150 + Math.random() * 350);
        text = mockReaction(table, seatIdx, this.personality);
      } else {
        const response = await complete({
          providerId: this.config.provider,
          baseUrl: this.config.baseUrl,
          apiKey: this.config.apiKey,
          model: this.config.model,
          messages,
          maxTokens: budget,
          temperature: Math.min(1, (this.config.temperature ?? 0.8) + 0.15),
          timeoutMs: this.config.timeoutMs,
          sessionId: `${this.sessionId}-react`,
          signal,
        });
        text = response.text;
      }

      const parsed = extractJsonObject(text);
      const line = typeof parsed?.reaction === 'string' ? parsed.reaction.trim() : '';
      if (!line) return null;
      return { text: line.slice(0, 140), latencyMs: Date.now() - startedAt, personality: this.personality };
    } catch {
      return null;
    }
  }
}
