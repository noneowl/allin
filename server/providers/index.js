export {
  PROVIDER_PRESETS,
  OPENCODE_GO_MODELS,
  OPENCODE_GO_DEFAULT_MODEL,
  WIRE,
  WIRE_PATH,
  providerPreset,
  providerCatalog,
  wireForModel,
} from './catalog.js';
export { complete, listModels, ProviderError } from './wire.js';

import { providerPreset } from './catalog.js';
import { complete, listModels, ProviderError } from './wire.js';

/**
 * Round-trip a tiny prompt through the configured provider so the user can
 * verify their key, base URL and model before sitting down at the table.
 */
export async function testProvider(config, { sessionId = 'connectivity-test' } = {}) {
  const started = Date.now();
  try {
    const res = await complete({
      providerId: config.provider,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      messages: [
        { role: 'system', content: 'Reply with JSON only.' },
        { role: 'user', content: 'Return {"ok":true} and nothing else.' },
      ],
      maxTokens: 512,
      temperature: 0,
      timeoutMs: Math.min(config.timeoutMs ?? 45000, 30000),
      sessionId,
    });
    return {
      ok: true,
      latencyMs: Date.now() - started,
      wire: res.wire,
      sample: res.text.slice(0, 200),
      finishReason: res.finishReason ?? null,
      usage: res.usage,
      note: res.text.trim()
        ? null
        : '模型没有返回文本内容。如果这是推理模型，它可能把整个输出预算花在思考上了，请调大「最大输出 tokens」。',
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      code: err instanceof ProviderError ? err.code : 'ERROR',
      status: err instanceof ProviderError ? err.status : 0,
      error: err?.message ?? String(err),
    };
  }
}

export async function fetchModels(config) {
  const preset = providerPreset(config.provider);
  const builtin = preset?.models ?? [];
  if (!config.baseUrl) return { ok: false, error: '未配置 Base URL', models: builtin };
  try {
    const models = await listModels({
      providerId: config.provider,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      sessionId: 'model-list',
    });
    return { ok: true, models: models.map((id) => ({ id, label: id })) };
  } catch (err) {
    return {
      ok: false,
      error: err?.message ?? String(err),
      models: builtin,
    };
  }
}
