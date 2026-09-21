import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/rooms.js';
import { buildMessages } from '../server/ai/prompt.js';
import { personalityById } from '../server/ai/personalities.js';
import { cardText } from '../server/engine/cards.js';

/**
 * The post-hand experience: the table becomes a review screen, the models get
 * session memory, and what the human types is fair game for them to read.
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
    postHandTalk: true,
    showAiCards: false,
    demoDelayMs: 0,
    table: { seats: 3, smallBlind: 10, bigBlind: 20, startingStack: 2000 },
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

/** Poll until a condition holds, so timing tests are not wall-clock sensitive. */
async function waitFor(predicate, timeoutMs = 4000, step = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, step));
  }
  return predicate();
}

/** Play a hand to completion, with the human always calling or checking. */
async function playHand(room) {
  const table = room.controller.table;
  let guard = 0;
  while (table.phase === 'playing' && guard++ < 400) {
    const seatIdx = table.toAct;
    if (seatIdx === null) break;
    if (table.seats[seatIdx].isHuman) {
      const legal = table.legalActions(seatIdx);
      const pick = legal.find((a) => a.type === 'check') || legal.find((a) => a.type === 'call') || legal[0];
      await room.controller.humanAction(seatIdx, { type: pick.type, amount: pick.to ?? pick.amount });
    } else {
      await room.controller.driveAI();
    }
  }
  return table;
}

// ------------------------------------------------------------- review screen

test('every hole card is face up once the hand is over', async () => {
  const { room } = makeRoom([HUMAN('我'), AI('ivan'), AI('biao')]);
  await room.controller.newGame();
  const table = await playHand(room);
  assert.notEqual(table.phase, 'playing', 'the hand finished');

  const view = room.controller.view(0);
  const dealt = table.seats.filter((s) => s.hole.length > 0);
  assert.ok(dealt.length >= 2, 'several players were dealt in');

  for (const seat of view.seats) {
    const original = table.seats[seat.seat];
    if (original.hole.length === 0) continue;
    assert.equal(seat.hole.length, 2, `seat ${seat.seat} cards hidden after the hand`);
    assert.equal(seat.hidden, false);
  }
  // Folded players are shown too — that is the point of the review screen.
  const folded = view.seats.filter((s) => s.folded && table.seats[s.seat].hole.length > 0);
  if (folded.length) {
    assert.ok(
      folded.every((s) => s.hole.length === 2),
      'a folded player should still be reviewable',
    );
  }
});

test('cards stay private while the hand is still running', async () => {
  const { room } = makeRoom([HUMAN('我'), AI('ivan'), AI('biao')]);
  await room.controller.newGame();
  const view = room.controller.view(0);
  assert.equal(view.phase, 'playing');
  for (const seat of view.seats) {
    if (seat.seat === view.viewerSeat) continue;
    assert.deepEqual(seat.hole, [], `seat ${seat.seat} exposed mid-hand`);
  }
});

// --------------------------------------------------------------- session memory

test('hand history and session stats accumulate across hands', async () => {
  const { room } = makeRoom([HUMAN('我'), AI('ivan'), AI('biao')]);
  await room.controller.newGame();
  const table = await playHand(room);

  assert.equal(table.handHistory.length, 1, 'the first hand was recorded');
  const first = table.handHistory[0];
  assert.equal(first.handId, 1);
  assert.ok(Array.isArray(first.deltas) && first.deltas.length === 3);
  assert.equal(
    first.deltas.reduce((sum, d) => sum + d.delta, 0),
    0,
    'deltas must sum to zero (chips are conserved)',
  );
  assert.ok(first.winners.length >= 1);

  const view = room.controller.view(0);
  assert.equal(view.handHistory.length, 1);
  assert.equal(view.sessionStats.length, 3);
  const totalHands = view.sessionStats.reduce((sum, s) => sum + s.hands, 0);
  assert.ok(totalHands > 0, 'at least someone played the hand');
  assert.equal(
    view.sessionStats.reduce((sum, s) => sum + s.net, 0),
    0,
    'net results must also sum to zero',
  );

  // Play a second hand and make sure it appends rather than replaces.
  table.phase = 'handover';
  await room.controller.nextHand();
  const table2 = await playHand(room);
  assert.equal(table2.handHistory.length, 2);
  assert.equal(room.controller.view(0).handHistory.length, 2);
});

test('the session memory reaches the prompt', async () => {
  const { room } = makeRoom([HUMAN('我'), AI('ivan'), AI('biao')]);
  await room.controller.newGame();
  const table = await playHand(room);
  table.phase = 'handover';
  await room.controller.nextHand();

  const messages = buildMessages({
    table: room.controller.table,
    seatIdx: 1,
    personality: personalityById('ivan'),
    tableTalk: true,
    reasoning: true,
    failures: [],
  });
  const user = messages[1].content;
  assert.match(user, /本局战绩/, 'standings section present');
  assert.match(user, /最近几手/, 'recent hands section present');
  assert.match(user, /第 1 手/, 'the previous hand is described');
  assert.match(user, /玩家发言/, 'player speech section present');
});

// ------------------------------------------------------------ what models read

test('a human line reaches the AI prompts', async () => {
  const { room } = makeRoom([HUMAN('我'), AI('ivan'), AI('biao')]);
  await room.controller.newGame();
  await room.controller.say(0, '我这把是口袋对子A，你小心点');

  const messages = buildMessages({
    table: room.controller.table,
    seatIdx: 1,
    personality: personalityById('ivan'),
    tableTalk: true,
    reasoning: true,
    failures: [],
  });
  const user = messages[1].content;
  assert.match(user, /口袋对子A/, 'the human said it, the model must see it');
  assert.match(user, /我：「/, 'attributed to the speaker');
});

test('AI table talk still never reaches another model', async () => {
  const { room } = makeRoom([HUMAN('我'), AI('ivan'), AI('biao')]);
  await room.controller.newGame();
  const table = room.controller.table;

  // Plant a distinctive line attributed to an AI seat and one to the human.
  table.addLog({ seat: 1, name: '伊万', kind: 'talk', text: 'SECRET-AI-LINE' });
  table.addLog({ seat: 0, name: '我', kind: 'talk', text: 'PUBLIC-HUMAN-LINE' });

  const user = buildMessages({
    table,
    seatIdx: 2,
    personality: personalityById('biao'),
    tableTalk: true,
    reasoning: true,
    failures: [],
  })[1].content;

  assert.ok(!user.includes('SECRET-AI-LINE'), 'AI talk must stay private');
  assert.ok(user.includes('PUBLIC-HUMAN-LINE'), 'human talk must be shared');
});

test('a human line is length-capped and trimmed', async () => {
  const { room } = makeRoom([HUMAN('我'), AI('ivan')]);
  await room.controller.newGame();
  const long = `  ${'啊'.repeat(400)}  `;
  const entry = await room.controller.say(0, long);
  assert.ok(entry.text.length <= 140, 'a wall of text must not reach the models');
  assert.equal(entry.text, entry.text.trim());
  assert.equal(await room.controller.say(0, '   '), null, 'empty lines are ignored');
});

test('an AI seat cannot speak through the say endpoint', async () => {
  const { room } = makeRoom([HUMAN('我'), AI('ivan')]);
  await room.controller.newGame();
  // `say` is synchronous on purpose (see the speaker test below), so it throws
  // rather than rejecting.
  assert.throws(() => room.controller.say(1, '我插一句'), /只有人类座位/);
});

test('speaking works even while a model is mid-decision', async () => {
  // Regression: `say` used to go through the same queue as the AI turn loop,
  // which is held for a whole multi-second LLM call. A message typed while a
  // model was thinking silently stalled until the hand moved on.
  const { room } = makeRoom([HUMAN('我'), AI('ivan'), AI('biao')]);
  await room.controller.newGame();

  // Start a drive and do not await it: this is the "model is thinking" state.
  const driving = room.controller.driveAI();

  const started = Date.now();
  const entry = room.controller.say(0, '趁你想的时候我说一句');
  const elapsed = Date.now() - started;

  assert.ok(entry, 'the line was recorded');
  assert.equal(entry.text, '趁你想的时候我说一句');
  assert.ok(elapsed < 50, `speaking must not wait on the AI turn loop (took ${elapsed}ms)`);
  assert.ok(
    room.controller.table.log.some((e) => e.kind === 'talk' && e.text === '趁你想的时候我说一句'),
    'the line reached the table log immediately',
  );

  await driving;
});

test('a line spoken mid-hand reaches the NEXT deciding seat', async () => {
  const { room } = makeRoom([HUMAN('我'), AI('ivan'), AI('biao')]);
  await room.controller.newGame();
  room.controller.say(0, '我手里是坚果，你别乱来');

  // The prompt is built when a seat is about to act, so whatever was said
  // before that moment must be visible to it.
  const user = buildMessages({
    table: room.controller.table,
    seatIdx: 1,
    personality: personalityById('ivan'),
    tableTalk: true,
    reasoning: true,
    failures: [],
  })[1].content;
  assert.match(user, /我手里是坚果/);
});

// ----------------------------------------------------------- post-hand lines

test('AI seats comment on the result once the hand ends', async () => {
  const { room } = makeRoom([HUMAN('我'), AI('ivan'), AI('biao')]);
  await room.controller.newGame();
  const table = await playHand(room);

  // Reactions are fired detached and in parallel; wait for them rather than
  // assuming a fixed delay (the suite runs test files concurrently).
  await waitFor(() => table.log.filter((e) => e.kind === 'talk' && e.postHand).length >= 2);

  const reactions = table.log.filter((e) => e.kind === 'talk' && e.postHand);
  assert.ok(reactions.length >= 2, `expected remarks from both AI seats, got ${reactions.length}`);
  for (const entry of reactions) {
    assert.ok(entry.text && entry.text.length > 0);
    assert.ok(!entry.secret, 'a reaction is public by design');
    assert.equal(entry.handId, table.handId, 'tagged with the hand it is about');
  }
  // And they are actually different characters saying different things.
  const texts = reactions.map((r) => r.text);
  assert.ok(new Set(reactions.map((r) => r.seat)).size >= 2, 'more than one seat spoke');
});

test('post-hand remarks can be switched off', async () => {
  const { room } = makeRoom([HUMAN('我'), AI('ivan'), AI('biao')], { postHandTalk: false });
  await room.controller.newGame();
  const table = await playHand(room);
  // Give the (disabled) reaction path every chance to run before asserting.
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(table.log.filter((e) => e.kind === 'talk' && e.postHand).length, 0);
});

// -------------------------------------------------------------- character depth

test('every character card carries concrete ranges, sizing and leaks', async () => {
  const { PERSONALITIES } = await import('../server/ai/personalities.js');
  assert.ok(PERSONALITIES.length >= 8, 'enough distinct opponents for a 9-max table');
  for (const p of PERSONALITIES) {
    for (const field of ['style', 'ranges', 'aggression', 'sizing', 'leaks']) {
      assert.ok(typeof p[field] === 'string' && p[field].length > 40, `${p.id}.${field} is too thin`);
    }
    assert.ok(Array.isArray(p.talk) && p.talk.length >= 3, `${p.id} needs a line pool`);
  }
  // Ids must be unique or two seats would share a brain.
  assert.equal(new Set(PERSONALITIES.map((p) => p.id)).size, PERSONALITIES.length);
});

test('the character card is rendered into the system prompt', async () => {
  const { room } = makeRoom([HUMAN('我'), AI('ivan')]);
  await room.controller.newGame();
  const system = buildMessages({
    table: room.controller.table,
    seatIdx: 1,
    personality: personalityById('ivan'),
    tableTalk: true,
    reasoning: true,
    failures: [],
  })[0].content;

  for (const heading of ['起手范围', '激进度', '下注尺度', '弱点']) {
    assert.match(system, new RegExp(heading), `missing section: ${heading}`);
  }
  // The gambler framing is the point of the card: desire AND fear, plus the
  // situations that break their discipline.
  assert.match(system, /心里真实的想法/);
  assert.match(system, /什么会让你失控/);
  assert.match(system, /你不是计算器，你是个赌徒/);
  assert.match(system, /想赌的/);
  assert.match(system, /想怕的/);
  assert.match(system, /关于"打错牌"/);
  // Anti-shove guidance survives, but framed as a gambler's preference.
  assert.match(system, /不要习惯性地直接全下/);
  assert.match(system, /如何利用历史信息/);
});

test('every character has a gambler heart, not just frequencies', async () => {
  const { PERSONALITIES } = await import('../server/ai/personalities.js');
  for (const p of PERSONALITIES) {
    assert.ok(typeof p.heart === 'string' && p.heart.length > 80, `${p.id}.heart is too thin`);
    assert.ok(typeof p.triggers === 'string' && p.triggers.length > 60, `${p.id}.triggers is too thin`);
    // Desire and fear must both be audible in the inner voice.
    assert.match(p.heart, /怕|不敢|恐惧|难受/, `${p.id}.heart never mentions fear`);
    assert.match(p.heart, /想|渴望|享受|上瘾|快感/, `${p.id}.heart never mentions wanting`);
  }
});

test('the reasoning instruction asks for the inner tug-of-war', async () => {
  const { room } = makeRoom([HUMAN('我'), AI('ivan')]);
  await room.controller.newGame();
  const system = buildMessages({
    table: room.controller.table,
    seatIdx: 1,
    personality: personalityById('ivan'),
    tableTalk: true,
    reasoning: true,
    failures: [],
  })[0].content;
  assert.match(system, /看出你心里的拉扯/);
  assert.match(system, /不要写成概率报告/);
});

test('hole cards are only rendered for the acting seat', async () => {
  const { room } = makeRoom([HUMAN('我'), AI('ivan'), AI('biao')]);
  await room.controller.newGame();
  const table = room.controller.table;
  const user = buildMessages({
    table,
    seatIdx: 1,
    personality: personalityById('ivan'),
    tableTalk: true,
    reasoning: true,
    failures: [],
  })[1].content;

  for (const seat of table.seats) {
    if (seat.seat === 1) continue;
    for (const card of seat.hole) {
      assert.ok(!user.includes(cardText(card)), `${cardText(card)} from seat ${seat.seat} leaked`);
    }
  }
});
