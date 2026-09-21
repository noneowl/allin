import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/rooms.js';
import { buildMessages } from '../server/ai/prompt.js';
import { personalityById } from '../server/ai/personalities.js';
import { cardText } from '../server/engine/cards.js';

/**
 * Seat isolation is the property that matters most once a table can hold
 * several people and several models at once. These tests pin it down:
 * no private cards and no reasoning may ever cross a seat boundary.
 */

function mockConfig(extra = {}) {
  return {
    provider: 'mock',
    baseUrl: 'in-process://demo',
    model: 'demo-rules',
    apiKey: '',
    maxTokens: 1500,
    temperature: 0.8,
    timeoutMs: 5000,
    tableTalk: true,
    reasoning: true,
    showAiCards: false,
    demoDelayMs: 0,
    table: { seats: 4, smallBlind: 10, bigBlind: 20, startingStack: 2000 },
    ready: true,
    ...extra,
  };
}

const AI = (personalityId) => ({ type: 'ai', personalityId });
const HUMAN = (name) => ({ type: 'human', name });

function makeRoom(seats, configExtra = {}) {
  const store = new RoomStore({ getConfig: () => mockConfig(configExtra) });
  const room = store.create({
    seatCount: seats.length,
    seats,
    rules: { smallBlind: 10, bigBlind: 20, startingStack: 2000 },
  });
  return { store, room };
}

async function startedRoom(seats, configExtra) {
  const { store, room } = makeRoom(seats, configExtra);
  await room.controller.newGame();
  return { store, room, table: room.controller.table };
}

// ------------------------------------------------------- hole card privacy

test('each human seat sees only its own hole cards', async () => {
  const { room, table } = await startedRoom([HUMAN('房主'), AI('ivan'), HUMAN('小明'), AI('biao')]);
  const v0 = room.controller.view(0);
  const v2 = room.controller.view(2);

  assert.equal(v0.seats[0].hole.length, 2, 'seat 0 sees its own cards');
  assert.equal(v2.seats[2].hole.length, 2, 'seat 2 sees its own cards');
  assert.deepEqual(v0.seats[2].hole, [], 'seat 0 must not see seat 2');
  assert.deepEqual(v2.seats[0].hole, [], 'seat 2 must not see seat 0');

  // And the raw payload must not carry the codes at all.
  // Match the JSON token ("Ac"), not a bare substring: a 2-character card code
  // can otherwise collide with unrelated text in the payload.
  const raw2 = JSON.stringify(v2);
  const raw0 = JSON.stringify(v0);
  for (const card of table.seats[0].hole) assert.ok(!raw2.includes(`"${card}"`), `${card} leaked to seat 2`);
  for (const card of table.seats[2].hole) assert.ok(!raw0.includes(`"${card}"`), `${card} leaked to seat 0`);
});

test('AI hole cards are hidden from every human', async () => {
  const { room } = await startedRoom([HUMAN('A'), AI('ivan'), HUMAN('B'), AI('biao')]);
  for (const viewer of [0, 2]) {
    const view = room.controller.view(viewer);
    for (const seat of view.seats) {
      if (seat.seat === viewer) continue;
      assert.deepEqual(seat.hole, [], `seat ${seat.seat} exposed to viewer ${viewer}`);
      assert.equal(seat.hidden, true);
    }
  }
});

test('a live hand name is only computed for the viewer own seat', async () => {
  const { room } = await startedRoom([HUMAN('A'), AI('ivan'), HUMAN('B'), AI('biao')]);
  const v0 = room.controller.view(0);
  assert.ok(v0.seats[0].handNameZh, 'the viewer gets their own hand description');
  assert.equal(v0.seats[2].handNameZh, null);
  assert.equal(v0.seats[1].handNameZh, null);
  assert.equal(v0.seats[3].handNameZh, null);
});

test('showAiCards is opt-in and never applies to a spectator', async () => {
  const { room } = await startedRoom([HUMAN('A'), AI('ivan')], { showAiCards: true });
  const withPeek = room.controller.view(0);
  const asSpectator = room.controller.view(null);
  assert.ok(withPeek.seats[1].hole.length === 2, 'debug peek shows AI cards to a seated viewer');
  assert.deepEqual(asSpectator.seats[1].hole, [], 'a spectator still sees nothing');
  assert.deepEqual(asSpectator.seats[0].hole, [], 'not even the human seat');
});

// ---------------------------------------------------------- prompt privacy

test('a prompt never contains another seat hole cards', async () => {
  const { table } = await startedRoom([HUMAN('A'), AI('ivan'), HUMAN('B'), AI('biao')]);
  const messages = buildMessages({
    table,
    seatIdx: 1,
    personality: personalityById('ivan'),
    tableTalk: true,
    reasoning: true,
    failures: [],
  });
  // The system prompt is static (it contains a worked example that happens to
  // name cards), so the only place table state can leak is the non-system part.
  const statePart = messages
    .filter((m) => m.role !== 'system')
    .map((m) => m.content)
    .join('\n');

  for (const seat of table.seats) {
    if (seat.seat === 1) continue;
    for (const card of seat.hole) {
      assert.ok(!statePart.includes(cardText(card)), `${cardText(card)} from seat ${seat.seat} leaked into the prompt`);
    }
  }
  // The acting seat's own cards must of course still be there.
  for (const card of table.seats[1].hole) {
    assert.ok(statePart.includes(cardText(card)), 'the acting seat needs its own cards');
  }
});

test('reasoning text is never fed forward into another model prompt', async () => {
  const { table } = await startedRoom([HUMAN('A'), AI('ivan'), HUMAN('B'), AI('biao')]);

  const reasoningTexts = table.log.filter((e) => e.kind === 'reason').map((e) => e.text);
  assert.ok(reasoningTexts.length > 0, 'the AI seats produced reasoning to leak');

  const talkTexts = table.log.filter((e) => e.kind === 'talk').map((e) => e.text);

  for (const seatIdx of [1, 3]) {
    const messages = buildMessages({
      table,
      seatIdx,
      personality: personalityById('ivan'),
      tableTalk: true,
      reasoning: true,
      failures: [],
    });
    const statePart = messages
      .filter((m) => m.role !== 'system')
      .map((m) => m.content)
      .join('\n');
    for (const text of reasoningTexts) {
      assert.ok(!statePart.includes(text), `reasoning leaked into seat ${seatIdx}'s prompt`);
    }
    for (const text of talkTexts) {
      assert.ok(!statePart.includes(text), `table talk leaked into seat ${seatIdx}'s prompt`);
    }
  }
});

test('but public actions do reach the prompt', async () => {
  const { table } = await startedRoom([HUMAN('A'), AI('ivan'), HUMAN('B'), AI('biao')]);
  const messages = buildMessages({
    table,
    seatIdx: 1,
    personality: personalityById('ivan'),
    tableTalk: true,
    reasoning: true,
    failures: [],
  });
  const prompt = messages.map((m) => m.content).join('\n');
  assert.match(prompt, /盲注|筹码/, 'public table state is present');
  assert.match(prompt, /行动记录/, 'the public action history section exists');
});

// ------------------------------------------------------- reasoning sealing

test('reasoning is sealed in every client view while the hand is live', async () => {
  const { room, table } = await startedRoom([HUMAN('A'), AI('ivan'), HUMAN('B'), AI('biao')]);
  assert.equal(table.phase, 'playing');

  const stored = table.log.filter((e) => e.kind === 'reason');
  assert.ok(stored.length > 0);

  for (const viewer of [0, 2]) {
    const view = room.controller.view(viewer);
    const reasons = view.log.filter((e) => e.kind === 'reason');
    for (const entry of reasons) {
      assert.equal(entry.sealed, true, 'live reasoning must be flagged sealed');
      assert.equal(entry.text, null, 'the text must not be serialised at all');
    }
    const raw = JSON.stringify(view);
    for (const entry of stored) {
      assert.ok(!raw.includes(entry.text), `reasoning text reached viewer ${viewer}`);
    }
  }
});

test('reasoning is revealed once the hand ends', async () => {
  const { room, table } = await startedRoom([HUMAN('A'), AI('ivan'), HUMAN('B'), AI('biao')]);
  table.phase = 'handover';

  const view = room.controller.view(0);
  const reasons = view.log.filter((e) => e.kind === 'reason');
  assert.ok(reasons.length > 0);
  assert.ok(reasons.every((e) => e.sealed !== true && typeof e.text === 'string' && e.text.length > 0));
  assert.equal(view.secretsRevealed, true);
});

test('a finished hand stays readable while the next hand is played', async () => {
  // Regression: sealing used to be driven by the global `phase !== 'playing'`
  // flag, so dealing the next hand re-sealed the previous hand's reasoning and
  // the player only had the result screen to read it.
  const store = new RoomStore({ getConfig: () => mockConfig() });
  const room = store.create({
    seatCount: 3,
    seats: [HUMAN('A'), AI('ivan'), AI('biao')],
    rules: { smallBlind: 10, bigBlind: 20, startingStack: 2000 },
  });
  await room.controller.newGame();
  // Three-handed the button (the human) acts first, so drive a call to give
  // the AI seats something to decide.
  await room.controller.humanAction(0, { action: 'call' });

  const table = room.controller.table;
  const hand1 = table.handId;
  const authored = table.log.filter((e) => e.kind === 'reason' && e.handId === hand1);
  assert.ok(authored.length > 0, 'hand 1 produced reasoning to check');

  table.phase = 'handover';
  table.startHand();
  assert.equal(table.handId, hand1 + 1, 'a new hand was dealt');
  assert.equal(table.phase, 'playing');

  const view = room.controller.view(0);
  const fromHand1 = view.log.filter((e) => e.kind === 'reason' && e.handId === hand1);
  assert.equal(fromHand1.length, authored.length, 'no hand 1 reasoning vanished');
  for (const entry of fromHand1) {
    assert.notEqual(entry.sealed, true, 'hand 1 reasoning must not be re-sealed');
    assert.equal(typeof entry.text, 'string');
    assert.ok(entry.text.length > 0);
  }
  // And the raw text really is in the payload, not just an unsealed flag.
  const raw = JSON.stringify(view);
  for (const entry of authored) assert.ok(raw.includes(entry.text), 'hand 1 text missing from the payload');
});

test('the hand being played is still sealed', async () => {
  const store = new RoomStore({ getConfig: () => mockConfig() });
  const room = store.create({
    seatCount: 3,
    seats: [HUMAN('A'), AI('ivan'), AI('biao')],
    rules: { smallBlind: 10, bigBlind: 20, startingStack: 2000 },
  });
  await room.controller.newGame();
  await room.controller.humanAction(0, { action: 'call' });

  const table = room.controller.table;
  const view = room.controller.view(0);
  const live = view.log.filter((e) => e.kind === 'reason' && e.handId === table.handId);
  assert.ok(live.length > 0, 'the live hand has reasoning');
  assert.ok(live.every((e) => e.sealed === true && e.text === null), 'live reasoning must stay sealed');

  const raw = JSON.stringify(view);
  for (const entry of table.log.filter((e) => e.kind === 'reason')) {
    assert.ok(!raw.includes(entry.text), 'live reasoning text must not be serialised');
  }
});

// ------------------------------------------------------- session isolation

test('every AI seat talks to the provider on its own session', async () => {
  const sessions = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sessions.push({ session: init.headers['x-opencode-session'], body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({ choices: [{ message: { content: '{"action":"fold"}' }, finish_reason: 'stop' }] }),
    };
  };

  try {
    const store = new RoomStore({
      getConfig: () => mockConfig({ provider: 'opencode-go', baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: 'sk-test' }),
    });
    const room = store.create({
      seatCount: 3,
      seats: [HUMAN('A'), AI('ivan'), AI('biao')],
      rules: { smallBlind: 10, bigBlind: 20, startingStack: 2000 },
    });
    await room.controller.newGame();
    // Three-handed the button (seat 0, the human) acts first, so drive a call
    // to hand the turn to the two AI seats.
    await room.controller.humanAction(0, { action: 'call' });

    assert.ok(sessions.length >= 2, `at least two AI decisions happened (got ${sessions.length})`);
    for (const call of sessions) {
      assert.match(call.session, /^ROOM|^[A-Z0-9]{5}-seat\d/, `session header missing or wrong: ${call.session}`);
    }
    const unique = new Set(sessions.map((s) => s.session));
    assert.ok(unique.size >= 2, `each seat must be its own session, got ${JSON.stringify([...unique])}`);
    // Every session must be attributable to exactly one seat.
    for (const session of unique) {
      assert.match(session, /-seat\d$/);
    }
  } finally {
    globalThis.fetch = original;
  }
});

// -------------------------------------------------------------- room model

test('seat config is normalised and every seat gets a unique token', () => {
  const { room } = makeRoom([HUMAN('房主'), AI('ivan'), HUMAN('小明'), AI('biao')]);
  const tokens = room.seatConfig.map((s) => s.token);
  assert.equal(new Set(tokens).size, tokens.length, 'tokens must be unique');
  assert.equal(room.hostSeat, 0);
  assert.equal(room.hostToken, room.seatConfig[0].token);
  assert.equal(room.seatForToken(tokens[1]).index, 1);
  assert.equal(room.seatForToken('nope'), null);
});

test('the seat count is clamped to what the table supports', () => {
  const store = new RoomStore({ getConfig: () => mockConfig() });
  assert.equal(store.create({ seatCount: 1 }).seatConfig.length, 2, 'minimum is heads-up');
  assert.equal(store.create({ seatCount: 99 }).seatConfig.length, 9, 'maximum is nine handed');
});

test('an AI seat falls back to a real personality and a name', () => {
  const { room } = makeRoom([HUMAN('A'), { type: 'ai' }, { type: 'ai', personalityId: 'nonexistent' }]);
  assert.equal(room.seatConfig[1].type, 'ai');
  assert.ok(room.seatConfig[1].personalityId, 'a default personality is chosen');
  assert.ok(room.seatConfig[1].name, 'a name is derived');
  assert.ok(room.seatConfig[2].personalityId, 'an unknown personality id is replaced');
});

test('findByToken resolves a room from the token alone', () => {
  const { store, room } = makeRoom([HUMAN('A'), AI('ivan')]);
  const token = room.seatConfig[1].token;
  assert.equal(store.findByToken(token)?.id, room.id);
  assert.equal(store.findByToken('nope'), null);
});
