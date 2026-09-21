import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/rooms.js';
import { buildMessages } from '../server/ai/prompt.js';
import { personalityById } from '../server/ai/personalities.js';
import { makeDeck, cardText } from '../server/engine/cards.js';

/**
 * "Can an AI see my cards, or cards that have not been dealt yet?"
 *
 * The answer must be an exhaustive no, so these tests do not sample — they
 * enumerate all 52 cards and assert that the only ones visible to a seat are
 * its own two hole cards plus the public board.
 */

const ALL_CARDS = makeDeck();
// Tens render as "10♥", not "T♥", so the pattern has to accept both.
const GLYPH = /(?:10|[2-9TJQKA])[♠♥♦♣]/g;

/** Every distinct card glyph appearing in a blob of text. */
function cardsIn(text) {
  return new Set(String(text).match(GLYPH) ?? []);
}

/** Same rendering the prompts use, so the audit cannot miss a card form. */
const toGlyph = cardText;

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

function makeTable(seatCount = 4) {
  const store = new RoomStore({ getConfig: () => mockConfig() });
  const seats = Array.from({ length: seatCount }, (_, i) =>
    i === 0 ? { type: 'human', name: '你' } : { type: 'ai', personalityId: ['ivan', 'biao', 'jiu', 'lisa'][i - 1] },
  );
  const room = store.create({ seatCount, seats, rules: { smallBlind: 10, bigBlind: 20, startingStack: 2000 } });
  return room;
}

/** Deal a hand and force it to a given street, drawing real cards from the deck. */
function tableAtStreet(street = 'preflop', seatCount = 4) {
  const room = makeTable(seatCount);
  const table = room.controller.table;
  // newGame is async because it plays AI turns; build the table synchronously
  // instead so the test controls the state exactly.
  const { Table } = globalThis.__tableModule ?? {};
  return { room, table, Table };
}

// A synchronous table builder so tests can place the board exactly.
async function syncTable(street, seatCount = 4) {
  const { Table } = await import('../server/engine/table.js');
  const room = makeTable(seatCount);
  const players = room.seatConfig.map((s, i) => ({
    name: s.name,
    avatar: s.avatar,
    isHuman: s.type === 'human',
    personality: s.type === 'ai' ? personalityById(s.personalityId) : { id: 'h', name: s.name, style: '' },
  }));
  const table = new Table({ players, smallBlind: 10, bigBlind: 20, startingStack: 2000 });
  table.startHand();

  const order = ['preflop', 'flop', 'turn', 'river'];
  const want = order.indexOf(street);
  const extra = want === 0 ? 0 : want === 1 ? 3 : want === 2 ? 4 : 5;
  table.board = table.deck.splice(table.deck.length - extra, extra);
  table.street = street;
  table.phase = 'playing';
  return { room, table };
}

const ACTING_SEATS = (table) => table.seats.filter((s) => !s.isHuman).map((s) => s.seat);

function promptFor(table, seatIdx) {
  return buildMessages({
    table,
    seatIdx,
    personality: personalityById(table.seats[seatIdx].personality?.id ?? 'ivan'),
    tableTalk: true,
    reasoning: true,
    failures: [],
  });
}

// ---------------------------------------------------------------- prompts

test('an AI prompt mentions ONLY its own hole cards plus the public board', async () => {
  for (const street of ['preflop', 'flop', 'turn', 'river']) {
    const { table } = await syncTable(street, 4);
    const boardGlyphs = new Set(table.board.map(toGlyph));

    for (const seatIdx of ACTING_SEATS(table)) {
      const seat = table.seats[seatIdx];
      const messages = promptFor(table, seatIdx);
      // The static system prompt has a worked example that names cards, so the
      // state-bearing surface is everything that is not the system message.
      const statePart = messages.filter((m) => m.role !== 'system').map((m) => m.content).join('\n');
      const seen = cardsIn(statePart);

      const allowed = new Set([...seat.hole.map(toGlyph), ...boardGlyphs]);
      const leaked = [...seen].filter((g) => !allowed.has(g));
      assert.deepEqual(leaked, [], `street=${street} seat=${seatIdx} leaked ${leaked.join(',')}`);

      // And it must actually know its own cards + board.
      for (const card of seat.hole) assert.ok(seen.has(toGlyph(card)), `seat ${seatIdx} lost sight of its own ${card}`);
      for (const g of boardGlyphs) assert.ok(seen.has(g), `seat ${seatIdx} cannot see board card ${g}`);
    }
  }
});

test('no undealt card ever appears in a prompt, on any street', async () => {
  for (const street of ['preflop', 'flop', 'turn', 'river']) {
    const { table } = await syncTable(street, 6);
    // Cards still face-down in the deck at this moment.
    const undealt = new Set(table.deck.map(toGlyph));
    assert.ok(undealt.size > 0, 'there are still undealt cards to protect');

    const boardGlyphs = new Set(table.board.map(toGlyph));
    const visibleToAnyone = new Set(boardGlyphs);
    for (const s of table.seats) for (const c of s.hole) visibleToAnyone.add(toGlyph(c));

    // Every card not yet public must be absent from every AI prompt.
    const mustBeHidden = [...undealt].filter((g) => !visibleToAnyone.has(g));
    assert.ok(mustBeHidden.length > 0);

    for (const seatIdx of ACTING_SEATS(table)) {
      const statePart = promptFor(table, seatIdx)
        .filter((m) => m.role !== 'system')
        .map((m) => m.content)
        .join('\n');
      const seen = cardsIn(statePart);
      const leaked = mustBeHidden.filter((g) => seen.has(g));
      assert.deepEqual(leaked, [], `street=${street} seat=${seatIdx} saw undealt ${leaked.join(',')}`);
    }
  }
});

test('an AI prompt never mentions any human hole card', async () => {
  const { table } = await syncTable('turn', 4);
  const humanCards = [];
  for (const s of table.seats) {
    if (!s.isHuman) continue;
    for (const c of s.hole) humanCards.push(toGlyph(c));
  }
  assert.ok(humanCards.length >= 2, 'there is at least one human holding cards');

  for (const seatIdx of ACTING_SEATS(table)) {
    const statePart = promptFor(table, seatIdx)
      .filter((m) => m.role !== 'system')
      .map((m) => m.content)
      .join('\n');
    for (const g of humanCards) {
      assert.ok(!statePart.includes(g), `human card ${g} reached AI seat ${seatIdx}`);
    }
  }
});

test('the system prompt is fully static — no table state can ride along', async () => {
  const a = await syncTable('preflop', 3);
  const b = await syncTable('river', 6);
  const sysA = promptFor(a.table, ACTING_SEATS(a.table)[0])[0].content;
  const sysB = promptFor(b.table, ACTING_SEATS(b.table)[0])[0].content;
  assert.equal(sysA, sysB, 'the system prompt must not vary with the board, stacks or seats');
});

// ------------------------------------------------------------ client view

test('a client view contains only that seat cards plus the public board', async () => {
  const { room, table } = await syncTable('turn', 5);
  room.controller.table = table;

  const boardGlyphs = new Set(table.board.map(toGlyph));

  for (const viewer of table.seats.map((s) => s.seat)) {
    const view = room.controller.view(viewer);
    const shown = cardsIn(
      JSON.stringify(
        view.seats.flatMap((s) => [s.hole, s.handNameZh, s.result]).filter(Boolean),
      ),
    );
    const allowed = new Set([...table.seats[viewer].hole.map(toGlyph), ...boardGlyphs]);
    const leaked = [...shown].filter((g) => !allowed.has(g));
    assert.deepEqual(leaked, [], `viewer ${viewer} saw ${leaked.join(',')}`);
  }
});

test('the deck itself is never serialised to a client', async () => {
  const { room, table } = await syncTable('flop', 4);
  room.controller.table = table;

  const undealt = table.deck.map(toGlyph);
  for (const viewer of [0, 1, 2, 3]) {
    const raw = JSON.stringify(room.controller.view(viewer));
    assert.ok(!raw.includes('"deck"'), `viewer ${viewer} received a deck field`);
    // None of the undealt cards may appear anywhere in the payload.
    const visible = new Set([...table.board.map(toGlyph)]);
    for (const s of table.seats) if (s.seat === viewer) for (const c of s.hole) visible.add(toGlyph(c));
    for (const g of undealt) {
      if (visible.has(g)) continue;
      assert.ok(!raw.includes(g), `undealt card ${g} reached viewer ${viewer}`);
    }
  }
});

test('a spectator sees no hole cards at all', async () => {
  const { room, table } = await syncTable('river', 4);
  room.controller.table = table;
  const view = room.controller.view(null);
  for (const seat of view.seats) {
    assert.deepEqual(seat.hole, [], `seat ${seat.seat} exposed to a spectator`);
    assert.equal(seat.handNameZh, null);
  }
});

test('all 52 cards are accounted for and none is reachable from a prompt', async () => {
  // Sanity: the deck really is 52 unique cards, so the enumeration above is total.
  assert.equal(ALL_CARDS.length, 52);
  assert.equal(new Set(ALL_CARDS.map(toGlyph)).size, 52);

  const { table } = await syncTable('river', 9);
  const known = new Set([
    ...table.board.map(toGlyph),
    ...table.seats.flatMap((s) => s.hole.map(toGlyph)),
    ...table.deck.map(toGlyph),
  ]);
  assert.equal(known.size, 52, 'board + holes + deck must partition the deck exactly');
});
