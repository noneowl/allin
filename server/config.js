import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { providerPreset, OPENCODE_GO_DEFAULT_MODEL } from './providers/catalog.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..');
const DATA_DIR = join(ROOT, '.data');
const CONFIG_PATH = join(DATA_DIR, 'config.json');

export const DEFAULT_CONFIG = {
  provider: 'opencode-go',
  baseUrl: 'https://opencode.ai/zen/go/v1',
  apiKey: '',
  model: OPENCODE_GO_DEFAULT_MODEL,
  temperature: 0.8,
  // Reasoning models (e.g. deepseek-v4.1-flash) spend thinking tokens out of
  // this same budget, so it needs headroom well above the tiny JSON we ask for.
  maxTokens: 1500,
  timeoutMs: 45000,
  tableTalk: true,
  reasoning: true,
  showAiCards: false,
  table: {
    seats: 4,
    smallBlind: 10,
    bigBlind: 20,
    startingStack: 2000,
  },
};

function readEnvKey(envNames) {
  for (const name of envNames) {
    const value = process.env[name];
    if (value && value.trim()) return { value: value.trim(), source: name };
  }
  return null;
}

let cached = null;

function readFile() {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    console.warn(`[config] ${CONFIG_PATH} 解析失败，使用默认值：${err.message}`);
    return {};
  }
}

/** Merge defaults <- file <- environment. Environment always wins. */
export function loadConfig({ force = false } = {}) {
  if (cached && !force) return cached;

  const file = readFile();
  const cfg = {
    ...DEFAULT_CONFIG,
    ...file,
    table: { ...DEFAULT_CONFIG.table, ...(file.table ?? {}) },
  };

  // Environment overrides
  if (process.env.DEZHOU_PROVIDER) cfg.provider = process.env.DEZHOU_PROVIDER;
  if (process.env.DEZHOU_BASE_URL) cfg.baseUrl = process.env.DEZHOU_BASE_URL;
  if (process.env.DEZHOU_MODEL) cfg.model = process.env.DEZHOU_MODEL;
  if (process.env.DEZHOU_TEMPERATURE) cfg.temperature = Number(process.env.DEZHOU_TEMPERATURE);
  if (process.env.DEZHOU_TIMEOUT_MS) cfg.timeoutMs = Number(process.env.DEZHOU_TIMEOUT_MS);

  const preset = providerPreset(cfg.provider);
  const fromEnv = readEnvKey(['DEZHOU_API_KEY', ...(preset?.keyEnv ?? [])]);
  if (fromEnv) {
    cfg.apiKey = fromEnv.value;
    cfg.apiKeySource = fromEnv.source;
  } else {
    cfg.apiKeySource = cfg.apiKey ? 'config' : null;
  }

  if (!cfg.baseUrl && preset?.baseUrl) cfg.baseUrl = preset.baseUrl;
  if (!cfg.model && preset?.defaultModel) cfg.model = preset.defaultModel;

  cached = cfg;
  return cfg;
}

export function saveConfig(patch) {
  const current = loadConfig();
  const next = {
    ...DEFAULT_CONFIG,
    provider: current.provider,
    baseUrl: current.baseUrl,
    apiKey: current.apiKey,
    model: current.model,
    temperature: current.temperature,
    maxTokens: current.maxTokens,
    timeoutMs: current.timeoutMs,
    tableTalk: current.tableTalk,
    reasoning: current.reasoning,
    showAiCards: current.showAiCards,
    table: { ...current.table },
  };

  if (patch.provider !== undefined) next.provider = String(patch.provider);
  if (patch.baseUrl !== undefined) next.baseUrl = String(patch.baseUrl).trim();
  if (patch.model !== undefined) next.model = String(patch.model).trim();
  if (patch.temperature !== undefined) next.temperature = clamp(Number(patch.temperature), 0, 2, DEFAULT_CONFIG.temperature);
  if (patch.maxTokens !== undefined) next.maxTokens = clamp(Math.round(Number(patch.maxTokens)), 128, 8000, DEFAULT_CONFIG.maxTokens);
  if (patch.timeoutMs !== undefined) next.timeoutMs = clamp(Math.round(Number(patch.timeoutMs)), 3000, 180000, DEFAULT_CONFIG.timeoutMs);
  if (patch.tableTalk !== undefined) next.tableTalk = Boolean(patch.tableTalk);
  if (patch.reasoning !== undefined) next.reasoning = Boolean(patch.reasoning);
  if (patch.showAiCards !== undefined) next.showAiCards = Boolean(patch.showAiCards);

  // An explicit empty string clears the stored key; undefined leaves it alone.
  if (patch.apiKey !== undefined) next.apiKey = String(patch.apiKey).trim();

  if (patch.table && typeof patch.table === 'object') {
    const t = { ...next.table, ...patch.table };
    next.table = {
      seats: clamp(Math.round(Number(t.seats)), 2, 6, DEFAULT_CONFIG.table.seats),
      smallBlind: clamp(Math.round(Number(t.smallBlind)), 1, 100000, DEFAULT_CONFIG.table.smallBlind),
      bigBlind: clamp(Math.round(Number(t.bigBlind)), 2, 200000, DEFAULT_CONFIG.table.bigBlind),
      startingStack: clamp(Math.round(Number(t.startingStack)), 100, 10000000, DEFAULT_CONFIG.table.startingStack),
    };
    if (next.table.bigBlind < next.table.smallBlind) next.table.bigBlind = next.table.smallBlind * 2;
  }

  // Switching provider swaps in that provider's default endpoint/model.
  if (patch.provider !== undefined && patch.baseUrl === undefined) {
    const preset = providerPreset(next.provider);
    if (preset?.baseUrl) next.baseUrl = preset.baseUrl;
  }
  if (patch.provider !== undefined && patch.model === undefined) {
    const preset = providerPreset(next.provider);
    if (preset?.defaultModel) next.model = preset.defaultModel;
  }
  if (!next.baseUrl) {
    const preset = providerPreset(next.provider);
    if (preset?.baseUrl) next.baseUrl = preset.baseUrl;
  }

  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  cached = null;
  return loadConfig({ force: true });
}

function clamp(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Config safe to hand to the browser: the key itself never leaves the server. */
export function publicConfig() {
  const cfg = loadConfig();
  return {
    provider: cfg.provider,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
    timeoutMs: cfg.timeoutMs,
    tableTalk: cfg.tableTalk,
    reasoning: cfg.reasoning,
    showAiCards: cfg.showAiCards,
    table: { ...cfg.table },
    hasApiKey: Boolean(cfg.apiKey),
    apiKeySource: cfg.apiKeySource,
    apiKeyHint: cfg.apiKey ? mask(cfg.apiKey) : null,
    ready: Boolean(cfg.baseUrl && cfg.model && (cfg.apiKey || !providerPreset(cfg.provider)?.needsKey)),
  };
}

function mask(key) {
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

export const configPath = CONFIG_PATH;
