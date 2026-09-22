import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point the config module at a throwaway directory BEFORE importing it, so
// these tests can never read or clobber the real .data/config.json.
const sandbox = mkdtempSync(join(tmpdir(), 'allin-config-'));
process.env.DEZHOU_DATA_DIR = sandbox;

const { saveConfig, publicConfig, configPath, DEFAULT_CONFIG } = await import('../server/config.js');

test.after(() => rmSync(sandbox, { recursive: true, force: true }));

// Deliberately short and obviously fake: a fixture that looks like a real
// credential trains everyone to ignore secret-scan hits.
const KEY = 'sk-test-4f2a1b9c';

test('the data directory is redirected, so the real config is untouched', () => {
  assert.equal(configPath, join(sandbox, 'config.json'));
});

test('a typed key is stored and trimmed', () => {
  const cfg = saveConfig({ apiKey: `  ${KEY}  ` });
  assert.equal(cfg.apiKey, KEY);
  assert.equal(publicConfig().hasApiKey, true);
});

test('the key never reaches the browser', () => {
  saveConfig({ apiKey: KEY });
  const exposed = JSON.stringify(publicConfig());
  assert.ok(!exposed.includes(KEY), 'publicConfig 泄露了明文 key');
  assert.ok(!exposed.includes(KEY.slice(4)), 'publicConfig 泄露了 key 片段');
  assert.equal(publicConfig().apiKeyHint, 'sk-t••••1b9c');
});

test('a blank key means "keep mine", not "delete mine"', () => {
  // This is the bug that silently wiped the user's opencode-go key: the
  // settings form always renders empty (the key is never sent to the browser),
  // so any save sent apiKey: '' and the server treated it as a deletion.
  saveConfig({ apiKey: KEY });
  const cfg = saveConfig({ apiKey: '', table: { seats: 2 } });
  assert.equal(cfg.apiKey, KEY, '空字符串把已保存的 key 清掉了');
  assert.equal(cfg.table.seats, 2);
});

test('omitting the key keeps it, even when other settings change', () => {
  saveConfig({ apiKey: KEY });
  const cfg = saveConfig({ model: 'glm-5.3-flash', maxTokens: 3000 });
  assert.equal(cfg.apiKey, KEY);
  assert.equal(cfg.model, 'glm-5.3-flash');
});

test('only an explicit clearApiKey deletes the key', () => {
  saveConfig({ apiKey: KEY });
  assert.equal(saveConfig({ clearApiKey: true }).apiKey, '');
  assert.equal(publicConfig().hasApiKey, false);
  assert.equal(publicConfig().apiKeyHint, null);
});

test('clearApiKey is not something a stray truthy value can trigger', () => {
  saveConfig({ apiKey: KEY });
  assert.equal(saveConfig({ clearApiKey: 'yes' }).apiKey, KEY);
  assert.equal(saveConfig({ clearApiKey: 1 }).apiKey, KEY);
});

test('provider defaults are still applied on switch', () => {
  const cfg = saveConfig({ provider: 'opencode-go' });
  assert.ok(cfg.baseUrl.startsWith('https://'));
  assert.ok(cfg.model);
  assert.equal(DEFAULT_CONFIG.table.seats, 4);
});
