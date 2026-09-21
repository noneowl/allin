import test from 'node:test';
import assert from 'node:assert/strict';
import { WIRE, wireForModel, providerCatalog, OPENCODE_GO_MODELS } from '../server/providers/catalog.js';
import { complete, listModels, ProviderError } from '../server/providers/wire.js';

/** Install a fake fetch that records the request and returns a canned reply. */
function stubFetch(reply, { ok = true, status = 200 } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init, body: init?.body ? JSON.parse(init.body) : null });
    return {
      ok,
      status,
      statusText: ok ? 'OK' : 'Bad Request',
      text: async () => JSON.stringify(typeof reply === 'function' ? reply(calls.length) : reply),
    };
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

test('OpenCode Go maps each model to the endpoint documented for it', () => {
  // Anthropic Messages
  for (const id of ['minimax-m3', 'minimax-m2.7', 'qwen3.8-max', 'qwen3.7-plus', 'qwen3.6-plus']) {
    assert.equal(wireForModel('opencode-go', id), WIRE.MESSAGES, id);
  }
  // OpenAI Responses
  for (const id of ['grok-4.6', 'gpt-5.6-luna', 'muse-spark-1.3-contributor']) {
    assert.equal(wireForModel('opencode-go', id), WIRE.RESPONSES, id);
  }
  // OpenAI-compatible chat completions (the default)
  for (const id of ['glm-5.3-flash', 'glm-5.3', 'kimi-k3', 'deepseek-v4.1-flash', 'mimo-v2.5', 'hy3']) {
    assert.equal(wireForModel('opencode-go', id), WIRE.CHAT, id);
  }
  // Other providers always use chat completions.
  assert.equal(wireForModel('deepseek', 'grok-4.6'), WIRE.CHAT);
});

test('every catalogued Go model has a known wire protocol', () => {
  for (const model of OPENCODE_GO_MODELS) {
    const wire = wireForModel('opencode-go', model.id);
    assert.ok([WIRE.CHAT, WIRE.RESPONSES, WIRE.MESSAGES].includes(wire), model.id);
  }
});

test('opencode-go chat completions: URL, auth, session header and body', async () => {
  const stub = stubFetch({ choices: [{ message: { content: '{"action":"call"}' }, finish_reason: 'stop' }], usage: { total_tokens: 12 } });
  try {
    const result = await complete({
      providerId: 'opencode-go',
      baseUrl: 'https://opencode.ai/zen/go/v1/',
      apiKey: 'sk-test-123',
      model: 'glm-5.3-flash',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'usr' },
      ],
      maxTokens: 123,
      temperature: 0.5,
      sessionId: 'sess-abc',
    });

    assert.equal(stub.calls.length, 1);
    const [call] = stub.calls;
    assert.equal(call.url, 'https://opencode.ai/zen/go/v1/chat/completions');
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers.Authorization, 'Bearer sk-test-123');
    assert.equal(call.init.headers['x-opencode-session'], 'sess-abc');
    assert.match(call.init.headers['User-Agent'], /dezhou-poker/);
    assert.equal(call.body.model, 'glm-5.3-flash');
    assert.equal(call.body.max_tokens, 123);
    assert.equal(call.body.temperature, 0.5);
    assert.equal(call.body.messages.length, 2);
    assert.equal(result.text, '{"action":"call"}');
    assert.equal(result.wire, WIRE.CHAT);
    assert.deepEqual(result.usage, { total_tokens: 12 });
  } finally {
    stub.restore();
  }
});

test('opencode-go responses protocol: system becomes instructions', async () => {
  const stub = stubFetch({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }] });
  try {
    const result = await complete({
      providerId: 'opencode-go',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      apiKey: 'k',
      model: 'grok-4.6',
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hi' },
      ],
      maxTokens: 64,
      sessionId: 's1',
    });
    const [call] = stub.calls;
    assert.equal(call.url, 'https://opencode.ai/zen/go/v1/responses');
    assert.equal(call.body.instructions, 'be terse');
    assert.equal(call.body.max_output_tokens, 64);
    assert.ok(Array.isArray(call.body.input));
    assert.equal(call.body.input[0].role, 'user');
    assert.equal(result.text, 'hello');
    assert.equal(result.wire, WIRE.RESPONSES);
  } finally {
    stub.restore();
  }
});

test('opencode-go anthropic messages protocol: top-level system, max_tokens', async () => {
  const stub = stubFetch({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });
  try {
    const result = await complete({
      providerId: 'opencode-go',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      apiKey: 'k',
      model: 'qwen3.8-max',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'u' },
      ],
      sessionId: 's1',
    });
    const [call] = stub.calls;
    assert.equal(call.url, 'https://opencode.ai/zen/go/v1/messages');
    assert.equal(call.body.system, 'sys');
    assert.equal(call.body.max_tokens, 600);
    assert.equal(call.body.messages.length, 1);
    assert.equal(result.text, 'ok');
    assert.equal(result.wire, WIRE.MESSAGES);
  } finally {
    stub.restore();
  }
});

test('a provider error surfaces the upstream message and status', async () => {
  const stub = stubFetch({ error: { message: 'invalid api key' } }, { ok: false, status: 401 });
  try {
    await assert.rejects(
      () =>
        complete({
          providerId: 'opencode-go',
          baseUrl: 'https://opencode.ai/zen/go/v1',
          apiKey: 'bad',
          model: 'glm-5.3-flash',
          messages: [{ role: 'user', content: 'x' }],
        }),
      (err) => {
        assert.ok(err instanceof ProviderError);
        assert.equal(err.status, 401);
        assert.equal(err.code, 'AUTH');
        assert.match(err.message, /invalid api key/);
        return true;
      },
    );
  } finally {
    stub.restore();
  }
});

test('a rejected max_tokens is retried as max_completion_tokens', async () => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body);
    if (seen.length === 1) {
      return {
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => JSON.stringify({ error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model." } }),
      };
    }
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
    };
  };
  try {
    const result = await complete({
      providerId: 'opencode-go',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      apiKey: 'k',
      model: 'glm-5.3-flash',
      messages: [{ role: 'user', content: 'x' }],
      maxTokens: 200,
    });
    assert.equal(seen.length, 2);
    assert.equal(seen[0].max_tokens, 200);
    assert.equal(seen[1].max_completion_tokens, 200);
    assert.equal(result.text, 'ok');
  } finally {
    globalThis.fetch = original;
  }
});

test('model listing reads data[].id and sorts', async () => {
  const stub = stubFetch({ data: [{ id: 'b-model' }, { id: 'a-model' }] });
  try {
    const models = await listModels({ providerId: 'opencode-go', baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: 'k' });
    assert.deepEqual(models, ['a-model', 'b-model']);
    assert.equal(stub.calls[0].url, 'https://opencode.ai/zen/go/v1/models');
    assert.equal(stub.calls[0].init.method, 'GET');
  } finally {
    stub.restore();
  }
});

test('the catalog exposes opencode-go with its documented base URL', () => {
  const go = providerCatalog().find((p) => p.id === 'opencode-go');
  assert.ok(go, 'opencode-go preset exists');
  assert.equal(go.baseUrl, 'https://opencode.ai/zen/go/v1');
  assert.equal(go.needsKey, true);
  assert.ok(go.models.length >= 15);
  assert.ok(go.models.some((m) => m.id === 'glm-5.3-flash'));
});

test('a missing base URL or model fails fast instead of calling out', async () => {
  await assert.rejects(() => complete({ providerId: 'openai-compatible', baseUrl: '', model: 'x', messages: [] }), /Base URL/);
  await assert.rejects(() => complete({ providerId: 'openai-compatible', baseUrl: 'https://x/v1', model: '', messages: [] }), /模型/);
});
