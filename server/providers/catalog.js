/**
 * OpenCode Go model catalogue, mirroring https://opencode.ai/docs/go
 *
 * OpenCode Go exposes the same models over three wire protocols, so the
 * correct endpoint is chosen from the model id rather than guessed.
 *   chat      -> POST {base}/chat/completions   (OpenAI compatible)
 *   responses -> POST {base}/responses          (OpenAI Responses)
 *   messages  -> POST {base}/messages           (Anthropic Messages)
 */

export const WIRE = {
  CHAT: 'chat',
  RESPONSES: 'responses',
  MESSAGES: 'messages',
};

export const WIRE_PATH = {
  [WIRE.CHAT]: '/chat/completions',
  [WIRE.RESPONSES]: '/responses',
  [WIRE.MESSAGES]: '/messages',
};

/** model id -> wire protocol, per the OpenCode Go endpoint table. */
const WIRE_BY_MODEL = {
  // Anthropic Messages
  'minimax-m3': WIRE.MESSAGES,
  'minimax-m2.7': WIRE.MESSAGES,
  'minimax-m2.5': WIRE.MESSAGES,
  'qwen3.8-max': WIRE.MESSAGES,
  'qwen3.8-flash': WIRE.MESSAGES,
  'qwen3.7-max': WIRE.MESSAGES,
  'qwen3.7-plus': WIRE.MESSAGES,
  'qwen3.6-plus': WIRE.MESSAGES,
  // OpenAI Responses
  'grok-4.6': WIRE.RESPONSES,
  'gpt-5.6-luna': WIRE.RESPONSES,
  'muse-spark-1.3-contributor': WIRE.RESPONSES,
  'muse-spark-1.2-contributor': WIRE.RESPONSES,
  // Everything else on Go is OpenAI-compatible chat completions.
};

export const OPENCODE_GO_MODELS = [
  { id: 'glm-5.3-flash', label: 'GLM-5.3 Flash', note: '快而便宜，适合高频决策', recommended: true },
  { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', note: '便宜、结构化输出稳定', recommended: true },
  { id: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', note: '推理更强，仍很便宜', recommended: true },
  { id: 'mimo-v2.5', label: 'MiMo V2.5', note: '极低延迟', recommended: true },
  { id: 'qwen3.8-flash', label: 'Qwen3.8 Flash', note: '综合能力均衡', recommended: true },
  { id: 'longcat-2.0', label: 'LongCat 2.0', note: '便宜、上下文大', recommended: true },
  { id: 'glm-5.1', label: 'GLM-5.1', note: '更强，单价更高' },
  { id: 'glm-5.2', label: 'GLM-5.2', note: '更强，单价更高' },
  { id: 'glm-5.3', label: 'GLM-5.3', note: '旗舰' },
  { id: 'kimi-k2.6', label: 'Kimi K2.6', note: '角色扮演感好' },
  { id: 'kimi-k2.7-code', label: 'Kimi K2.7 Code' },
  { id: 'kimi-k3', label: 'Kimi K3', note: '最强也最贵' },
  { id: 'minimax-m3', label: 'MiniMax M3' },
  { id: 'minimax-m2.7', label: 'MiniMax M2.7' },
  { id: 'qwen3.7-plus', label: 'Qwen3.7 Plus' },
  { id: 'qwen3.7-max', label: 'Qwen3.7 Max' },
  { id: 'qwen3.8-max', label: 'Qwen3.8 Max' },
  { id: 'hy3', label: 'Hy3' },
  { id: 'hy4-preview', label: 'Hy4 preview' },
  { id: 'grok-4.6', label: 'Grok 4.6' },
  { id: 'gpt-5.6-luna', label: 'GPT 5.6 Luna' },
  { id: 'muse-spark-1.3-contributor', label: 'Muse Spark 1.3 Contributor' },
];

export const OPENCODE_GO_DEFAULT_MODEL = 'glm-5.3-flash';

export function wireForModel(providerId, model) {
  if (providerId === 'opencode-go' || providerId === 'opencode-zen') {
    return WIRE_BY_MODEL[model] ?? WIRE.CHAT;
  }
  return WIRE.CHAT;
}

export const PROVIDER_PRESETS = {
  'opencode-go': {
    id: 'opencode-go',
    label: 'OpenCode Go',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    style: 'auto',
    keyEnv: ['OPENCODE_GO_API_KEY', 'OPENCODE_API_KEY'],
    keyPrefix: '订阅 Go 后在 opencode.ai/auth 复制 API Key',
    docs: 'https://opencode.ai/docs/go/',
    needsKey: true,
    defaultModel: OPENCODE_GO_DEFAULT_MODEL,
    models: OPENCODE_GO_MODELS,
  },
  'opencode-zen': {
    id: 'opencode-zen',
    label: 'OpenCode Zen',
    baseUrl: 'https://opencode.ai/zen/v1',
    style: 'auto',
    keyEnv: ['OPENCODE_API_KEY', 'OPENCODE_ZEN_API_KEY'],
    keyPrefix: '按量计费，openCode Zen 的 API Key',
    docs: 'https://opencode.ai/docs/zen/',
    needsKey: true,
    defaultModel: 'claude-haiku-4-5',
    models: [],
  },
  'openai-compatible': {
    id: 'openai-compatible',
    label: 'OpenAI 兼容端点',
    baseUrl: '',
    style: 'chat',
    keyEnv: ['DEZHOU_API_KEY', 'OPENAI_API_KEY'],
    keyPrefix: '任意兼容 /chat/completions 的服务',
    needsKey: false,
    defaultModel: '',
    models: [],
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com/v1',
    style: 'chat',
    keyEnv: ['DEEPSEEK_API_KEY'],
    needsKey: true,
    defaultModel: 'deepseek-chat',
    models: [
      { id: 'deepseek-chat', label: 'deepseek-chat' },
      { id: 'deepseek-reasoner', label: 'deepseek-reasoner' },
    ],
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    style: 'chat',
    keyEnv: ['OPENROUTER_API_KEY'],
    needsKey: true,
    defaultModel: 'google/gemini-2.5-flash',
    models: [{ id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash' }],
  },
  ollama: {
    id: 'ollama',
    label: '本地 Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    style: 'chat',
    keyEnv: [],
    needsKey: false,
    defaultModel: 'qwen3:8b',
    models: [],
  },
  mock: {
    id: 'mock',
    label: '离线演示（非 LLM）',
    baseUrl: 'in-process://demo',
    style: 'demo',
    keyEnv: [],
    needsKey: false,
    defaultModel: 'demo-rules',
    badge: '仅供预览界面',
    docs: null,
    models: [{ id: 'demo-rules', label: '规则假 AI —— 不是真实模型' }],
  },
};

export function providerPreset(id) {
  return PROVIDER_PRESETS[id] ?? PROVIDER_PRESETS['openai-compatible'];
}

export function providerCatalog() {
  return Object.values(PROVIDER_PRESETS).map((p) => ({
    id: p.id,
    label: p.label,
    baseUrl: p.baseUrl,
    style: p.style,
    needsKey: p.needsKey,
    docs: p.docs ?? null,
    badge: p.badge ?? null,
    keyPrefix: p.keyPrefix ?? null,
    defaultModel: p.defaultModel ?? '',
    models: p.models ?? [],
  }));
}
