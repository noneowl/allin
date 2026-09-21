import test from 'node:test';
import assert from 'node:assert/strict';
import { Table } from '../server/engine/table.js';
import { PokerAgent, AIError, parseDecision, extractJsonObject, fallbackAction } from '../server/ai/agent.js';
import { personalityById } from '../server/ai/personalities.js';

const CONFIG = {
  provider: 'opencode-go',
  baseUrl: 'https://opencode.ai/zen/go/v1',
  apiKey: 'sk-test',
  model: 'deepseek-v4.1-flash',
  maxTokens: 400,
  temperature: 0.8,
  timeoutMs: 5000,
};

/** Heads-up table frozen on the AI's preflop decision (big blind option). */
function aiTurnTable() {
  const table = new Table({
    players: [
      { name: '你', isHuman: true, personality: { id: 'you', name: '你', style: 'human' } },
      { name: '伊万', isHuman: false, personality: personalityById('ivan') },
    ],
    smallBlind: 10,
    bigBlind: 20,
    startingStack: 2000,
  });
  table.startHand();
  table.applyAction(0, { action: 'call' }); // small blind completes, BB gets the option
  assert.equal(table.toAct, 1);
  return table;
}

const chatReply = (content, finishReason = 'stop') => ({
  choices: [{ message: { role: 'assistant', content, reasoning_content: '...' }, finish_reason: finishReason }],
  usage: { completion_tokens: 10 },
});

function stubFetch(replies) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(reply) };
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

// ------------------------------------------------------------------ parsing

test('an empty reply is reported as a likely max_tokens problem', () => {
  for (const empty of ['', '   ', null, undefined]) {
    const result = parseDecision(empty);
    assert.equal(result.ok, false);
    assert.match(result.error, /max_tokens/);
  }
});

test('extractJsonObject survives prose, fences and trailing commas', () => {
  assert.deepEqual(extractJsonObject('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJsonObject('Sure! Here you go: {"a":1} hope that helps'), { a: 1 });
  assert.deepEqual(extractJsonObject('{"a":1,}'), { a: 1 });
  assert.deepEqual(extractJsonObject('{"a":{"b":[1,2]}} trailing'), { a: { b: [1, 2] } });
  assert.equal(extractJsonObject('no json here'), null);
  assert.equal(extractJsonObject('{"unterminated": '), null);
});

test('parseDecision normalises action aliases and amounts', () => {
  assert.equal(parseDecision('{"action":"all-in"}').value.action, 'all_in');
  assert.equal(parseDecision('{"action":"SHOVE"}').value.action, 'all_in');
  assert.equal(parseDecision('{"action":"call"}').value.action, 'call');
  assert.equal(parseDecision('{"action":"raise","amount":"120"}').value.amount, 120);
  assert.equal(parseDecision('{"action":"raise","to":80}').value.amount, 80);
  assert.equal(parseDecision('{"action":"bogus"}').ok, false);
  assert.equal(parseDecision('{"amount":50}').ok, false);
});

// ------------------------------------------------------- truncation recovery

test('a truncated reply grows the token budget and retries successfully', async () => {
  const table = aiTurnTable();
  const stub = stubFetch([
    chatReply('', 'length'), // reasoning ate the whole budget, no content
    chatReply('{"action":"raise","amount":60,"reasoning":"加注施压","table_talk":"我加。"}'),
  ]);
  try {
    const agent = new PokerAgent({ config: CONFIG, personality: personalityById('ivan'), sessionId: 't' });
    const decision = await agent.decide(table, 1);

    assert.equal(decision.action, 'raise');
    assert.equal(decision.amount, 60);
    assert.equal(decision.attempts, 2, 'should have retried once');
    assert.equal(stub.calls.length, 2);
    assert.equal(stub.calls[0].body.max_tokens, 400, 'first attempt uses the configured budget');
    assert.equal(stub.calls[1].body.max_tokens, 800, 'retry doubles the budget for reasoning headroom');
    assert.equal(decision.tableTalk, '我加。');
    // The retry must tell the model what went wrong.
    const retryMessages = stub.calls[1].body.messages;
    assert.match(retryMessages[retryMessages.length - 1].content, /截断/);
    assert.equal(decision.requested.action, 'raise', 'the raw request is preserved');
  } finally {
    stub.restore();
  }
});

test('a half-written JSON object is also treated as truncation', async () => {
  const table = aiTurnTable();
  const stub = stubFetch([
    chatReply('{"action":"fold","amount":null,"reason', 'length'),
    chatReply('{"action":"check"}'),
  ]);
  try {
    const agent = new PokerAgent({ config: CONFIG, personality: personalityById('ivan'), sessionId: 't' });
    const decision = await agent.decide(table, 1);
    assert.equal(decision.action, 'check');
    assert.equal(stub.calls[1].body.max_tokens, 800);
  } finally {
    stub.restore();
  }
});

test('persistent truncation eventually fails loudly with the budget trail', async () => {
  const table = aiTurnTable();
  const stub = stubFetch([chatReply('', 'length')]);
  try {
    const agent = new PokerAgent({ config: CONFIG, personality: personalityById('ivan'), sessionId: 't' });
    await assert.rejects(
      () => agent.decide(table, 1),
      (err) => {
        assert.ok(err instanceof AIError);
        assert.match(err.message, /合法动作/);
        assert.deepEqual(
          err.attempts.map((a) => a.budget),
          [400, 800, 1600],
          'the budget escalates on every truncation',
        );
        return true;
      },
    );
  } finally {
    stub.restore();
  }
});

test('the budget never grows past the hard ceiling', async () => {
  const table = aiTurnTable();
  const stub = stubFetch([chatReply('', 'length')]);
  try {
    const agent = new PokerAgent({
      config: { ...CONFIG, maxTokens: 6000 },
      personality: personalityById('ivan'),
      sessionId: 't',
    });
    await assert.rejects(() => agent.decide(table, 1));
    assert.deepEqual(
      stub.calls.map((c) => c.body.max_tokens),
      [6000, 8000, 8000],
    );
  } finally {
    stub.restore();
  }
});

// ------------------------------------------------------- illegal action loop

test('an illegal action is retried with the rejection fed back to the model', async () => {
  const table = aiTurnTable();
  // The big blind has the option, so "call" parses but is not a legal action.
  const stub = stubFetch([
    chatReply('{"action":"call"}'),
    chatReply('{"action":"check"}'),
  ]);
  try {
    const agent = new PokerAgent({ config: CONFIG, personality: personalityById('ivan'), sessionId: 't' });
    const decision = await agent.decide(table, 1);
    assert.equal(decision.action, 'check');
    assert.equal(decision.attempts, 2);
    assert.equal(decision.attemptLog[0].illegal !== undefined, true, 'first attempt recorded as illegal');
    const retry = stub.calls[1].body.messages;
    assert.match(retry[retry.length - 1].content, /不合法/);
  } finally {
    stub.restore();
  }
});

test('an over-sized raise is clamped into the legal range rather than rejected', async () => {
  const table = aiTurnTable();
  const stub = stubFetch([chatReply('{"action":"raise","amount":999999}')]);
  try {
    const agent = new PokerAgent({ config: CONFIG, personality: personalityById('ivan'), sessionId: 't' });
    const decision = await agent.decide(table, 1);
    assert.equal(decision.action, 'raise');
    assert.equal(decision.amount, 2000, 'clamped to the stack');
    assert.equal(decision.attempts, 1, 'clamping is not an error');
  } finally {
    stub.restore();
  }
});

test('a transport failure is retried and finally surfaced', async () => {
  const table = aiTurnTable();
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: false, status: 500, statusText: 'Server Error', text: async () => JSON.stringify({ error: { message: 'upstream exploded' } }) };
  };
  try {
    const agent = new PokerAgent({ config: CONFIG, personality: personalityById('ivan'), sessionId: 't' });
    await assert.rejects(
      () => agent.decide(table, 1),
      (err) => {
        assert.ok(err instanceof AIError);
        assert.match(err.message, /upstream exploded/);
        return true;
      },
    );
    assert.equal(calls, 3, 'transport errors are retried up to the attempt limit');
  } finally {
    globalThis.fetch = original;
  }
});

test('an auth failure is fatal and never retried', async () => {
  const table = aiTurnTable();
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: false, status: 401, statusText: 'Unauthorized', text: async () => JSON.stringify({ error: { message: 'invalid api key' } }) };
  };
  try {
    const agent = new PokerAgent({ config: CONFIG, personality: personalityById('ivan'), sessionId: 't' });
    await assert.rejects(() => agent.decide(table, 1), /invalid api key/);
    assert.equal(calls, 1, 'a bad key must not burn three requests');
  } finally {
    globalThis.fetch = original;
  }
});

// ----------------------------------------------------------------- fallback

test('fallbackAction takes the free option when there is one, else folds', () => {
  const table = aiTurnTable(); // big blind, nothing to call
  assert.deepEqual(fallbackAction(table, 1), { type: 'check', fallback: true });

  const facing = aiTurnTable();
  facing.applyAction(1, { action: 'check' }); // flop; heads-up the big blind acts first
  assert.equal(facing.toAct, 1);
  facing.applyAction(1, { action: 'check' }); // check to the button
  assert.equal(facing.toAct, 0);
  facing.applyAction(0, { action: 'bet', amount: 100 }); // now the AI faces a bet
  assert.equal(facing.toAct, 1);
  assert.equal(facing.currentBet, 100);
  assert.deepEqual(fallbackAction(facing, 1), { type: 'fold', fallback: true });
});
