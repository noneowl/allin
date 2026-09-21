import test from 'node:test';
import assert from 'node:assert/strict';
import { Table, GameError } from '../server/engine/table.js';
import { seededRng } from '../server/engine/cards.js';

const players = (n) =>
  Array.from({ length: n }, (_, i) => ({
    name: `P${i}`,
    avatar: '🙂',
    isHuman: i === 0,
  }));

function makeTable(n, opts = {}) {
  return new Table({
    players: players(n),
    smallBlind: 10,
    bigBlind: 20,
    startingStack: 1000,
    rng: seededRng(opts.seed ?? 7),
    ...opts,
  });
}

/** Chips a player holds plus what they have already put in the middle. */
const held = (t) => t.seats.reduce((sum, s) => sum + s.stack + s.totalCommitted, 0);
const chips = (t) => t.seats.reduce((sum, s) => sum + s.stack, 0);
const START = 1000;

test('a hand posts blinds, deals two cards and sets the first actor', () => {
  const t = makeTable(4);
  assert.equal(t.startHand(), true);
  assert.equal(t.phase, 'playing');
  assert.equal(t.street, 'preflop');
  assert.equal(t.board.length, 0);
  assert.equal(t.buttonIndex, 0);
  assert.equal(t.sbSeat, 1);
  assert.equal(t.bbSeat, 2);
  assert.equal(t.seats[1].committed, 10, 'small blind posted');
  assert.equal(t.seats[2].committed, 20, 'big blind posted');
  assert.equal(t.currentBet, 20);
  assert.equal(t.minRaiseTo, 40);
  assert.equal(t.toAct, 3, 'action starts left of the big blind');
  for (const s of t.seats) assert.equal(s.hole.length, 2);
  assert.equal(held(t), 4 * START);
});

test('heads-up: the button posts the small blind and acts first preflop', () => {
  const t = makeTable(2);
  t.startHand();
  assert.equal(t.buttonIndex, 0);
  assert.equal(t.sbSeat, 0);
  assert.equal(t.bbSeat, 1);
  assert.equal(t.seats[0].committed, 10);
  assert.equal(t.seats[1].committed, 20);
  assert.equal(t.toAct, 0);
});

test('the big blind gets the option when nobody raises', () => {
  const t = makeTable(3);
  t.startHand();
  assert.equal(t.buttonIndex, 0);
  assert.equal(t.sbSeat, 1);
  assert.equal(t.bbSeat, 2);
  assert.equal(t.toAct, 0, 'button acts first three-handed');

  t.applyAction(0, { action: 'call' });
  assert.equal(t.toAct, 1);
  t.applyAction(1, { action: 'call' });
  assert.equal(t.toAct, 2, 'big blind still has the option');
  t.applyAction(2, { action: 'check' });
  assert.equal(t.street, 'flop', 'round closes after the big blind checks');
  assert.equal(t.board.length, 3);
});

test('everyone folding to the big blind ends the hand immediately', () => {
  const t = makeTable(3);
  t.startHand();
  t.applyAction(0, { action: 'fold' });
  t.applyAction(1, { action: 'fold' });
  assert.equal(t.phase, 'handover');
  assert.equal(t.handResult.uncontested, true);
  assert.equal(t.handResult.winnerSeat, 2);
  assert.equal(t.seats[2].stack, START + 10, 'big blind wins the small blind');
  assert.equal(chips(t), 3 * START, 'chips are conserved');
});

test('raises update the minimum raise and reopen the action', () => {
  const t = makeTable(4);
  t.startHand();
  assert.equal(t.toAct, 3);
  t.applyAction(3, { action: 'raise', amount: 60 });
  assert.equal(t.currentBet, 60);
  assert.equal(t.minRaiseTo, 100, 'min raise is the size of the previous raise');
  assert.equal(t.toAct, 0, 'action continues from the button');
});

test('a short all-in does not reopen raising for players who already acted', () => {
  const t = makeTable(4, { seed: 11 });
  t.startHand();
  t.applyAction(3, { action: 'raise', amount: 60 }); // full raise: size 40
  t.applyAction(0, { action: 'call' }); // button flat calls
  t.seats[1].stack = 80 - t.seats[1].committed; // small blind can only reach 80
  t.applyAction(1, { action: 'all_in' }); // short raise: +20, less than the 40 minimum

  assert.equal(t.currentBet, 80, 'the short all-in still raises the price');
  assert.equal(t.minRaiseTo, 100, 'the minimum raise is unchanged by a short all-in');
  assert.equal(t.seats[0].mayRaise, false, 'a caller may not re-raise over a short all-in');
  assert.equal(t.seats[3].mayRaise, false, 'the original raiser may not re-raise either');
  assert.equal(t.seats[2].mayRaise, true, 'the big blind has not acted and may still raise');
  assert.equal(t.toAct, 2, 'action continues at the big blind');
});

test('an all-in for less than the current bet is simply a call', () => {
  const t = makeTable(4);
  t.startHand();
  t.applyAction(3, { action: 'raise', amount: 200 });
  t.seats[0].stack = 35;
  const norm = t.applyAction(0, { action: 'all_in' });
  assert.equal(norm.type, 'call', 'shoving below the price is normalised to a call');
  assert.equal(t.currentBet, 200, 'the price does not move');
  assert.equal(t.seats[0].stack, 0);
  assert.equal(t.seats[0].allIn, true);
});

test('illegal amounts are clamped into the legal range', () => {
  const t = makeTable(3);
  t.startHand();
  const norm = t.applyAction(0, { action: 'raise', amount: 1 });
  assert.equal(norm.to, 40, 'clamped up to the minimum raise');
  assert.equal(t.currentBet, 40);
});

test('illegal actions throw instead of silently mutating state', () => {
  const t = makeTable(3);
  t.startHand();
  const snapshot = t.seats.map((s) => ({ ...s, hole: s.hole.slice() }));
  assert.throws(() => t.applyAction(1, { action: 'check' }), GameError, 'cannot check facing a bet');
  assert.throws(() => t.applyAction(0, { action: 'nonsense' }), /不合法/);
  assert.throws(() => t.applyAction(0, { action: 'raise' }), /amount/);
  assert.throws(() => t.applyAction(2, { action: 'call' }), GameError, 'cannot act out of turn');
  assert.deepEqual(t.seats.map((s) => s.stack), snapshot.map((s) => s.stack), 'stacks untouched by rejects');
  assert.equal(t.toAct, 0, 'turn pointer untouched by rejects');
});

test('uncalled over-bet is returned to the bettor', () => {
  const t = makeTable(2);
  t.startHand();
  // Button shoves 1000 into a 20 big blind; the big blind folds.
  t.applyAction(0, { action: 'all_in' });
  t.applyAction(1, { action: 'fold' });
  assert.equal(t.phase, 'handover');
  // Button wins only the big blind's 20, keeps the rest.
  assert.equal(t.seats[0].stack, START + 20);
  assert.equal(t.seats[1].stack, START - 20);
  assert.equal(chips(t), 2 * START);
});

test('a completed hand conserves chips and can be followed by another', () => {
  const t = makeTable(4);
  for (let i = 0; i < 5; i++) {
    const ok = t.startHand();
    if (!ok) break;
    let guard = 0;
    while (t.phase === 'playing' && guard++ < 200) {
      const seat = t.toAct;
      const legal = t.legalActions(seat);
      const pick = legal.find((a) => a.type === 'check') || legal.find((a) => a.type === 'call') || legal[0];
      t.applyAction(seat, { type: pick.type, amount: pick.to ?? pick.amount });
      if (t.phase === 'playing') {
        assert.equal(held(t), 4 * START, `chips conserved mid-hand (hand ${i})`);
      }
    }
  }
  assert.equal(chips(t), 4 * START);
});

test('side pots pay the short stack only what they can win', () => {
  const t = makeTable(3);
  t.startHand();
  // Aim for all-in totals of exactly 40 / 200 / 200 including posted blinds.
  t.seats[0].stack = 40;
  t.seats[1].stack = 200 - t.seats[1].committed;
  t.seats[2].stack = 200 - t.seats[2].committed;
  const total = t.seats.reduce((sum, s) => sum + s.stack + s.totalCommitted, 0);

  t.applyAction(0, { action: 'all_in' }); // 40 total
  t.applyAction(1, { action: 'all_in' }); // 200 total
  t.applyAction(2, { action: 'all_in' }); // 200 total

  assert.ok(t.phase === 'handover' || t.phase === 'gameover', `hand finished (got ${t.phase})`);
  assert.equal(t.pots.length, 2, 'a main pot and one side pot');
  assert.equal(t.pots[0].amount, 120, 'main pot is 3 x 40');
  assert.deepEqual(t.pots[0].eligible, [0, 1, 2]);
  assert.equal(t.pots[1].amount, 320, 'side pot is 2 x 160');
  assert.deepEqual(t.pots[1].eligible, [1, 2]);
  assert.equal(chips(t), total, 'chips are conserved');
  assert.ok(t.seats[0].stack <= total, 'the short stack cannot win more than the table');
});

test('fuzz: random legal actions never break the game', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const seatCount = 2 + (seed % 5);
    const t = makeTable(seatCount, { seed, startingStack: 300 });
    const total = seatCount * 300;
    let hands = 0;

    while (hands < 12 && t.startHand()) {
      let guard = 0;
      while (t.phase === 'playing') {
        if (guard++ > 400) throw new Error(`hand ${hands} of seed ${seed} did not terminate`);
        const seatIdx = t.toAct;
        assert.notEqual(seatIdx, null, 'there must be someone to act');
        const legal = t.legalActions(seatIdx);
        assert.ok(legal.length > 0, 'a player on turn always has an option');

        const r = seededRng(seed * 1000 + guard);
        const roll = r.next();
        let choice;
        if (roll < 0.55) choice = legal.find((a) => a.type === 'call') || legal.find((a) => a.type === 'check') || legal[0];
        else if (roll < 0.7) choice = legal.find((a) => a.type === 'check') || legal.find((a) => a.type === 'fold');
        else if (roll < 0.85) choice = legal.find((a) => a.type === 'raise') || legal.find((a) => a.type === 'bet') || legal[0];
        else if (roll < 0.93) choice = legal.find((a) => a.type === 'all_in') || legal[0];
        else choice = legal.find((a) => a.type === 'fold') || legal[0];

        let amount;
        if (choice.minTo !== undefined) {
          const span = choice.maxTo - choice.minTo;
          amount = choice.minTo + Math.floor(r.next() * (span + 1));
        }

        assert.equal(t.seats.reduce((s, x) => s + x.stack + x.totalCommitted, 0), total, 'chips conserved');
        assert.ok(t.seats.every((s) => s.stack >= 0), 'no negative stacks');
        t.applyAction(seatIdx, { type: choice.type, amount });
      }

      assert.equal(t.seats.reduce((s, x) => s + x.stack, 0), total, `payout conserves chips (seed ${seed})`);
      assert.ok(t.handResult, 'a finished hand always has a result');
      assert.ok(t.board.length === 5 || t.handResult.uncontested, 'board runs out or hand ends early');
      for (const s of t.seats) {
        assert.ok(s.hole.length === 2 || s.out, 'active players hold two cards');
      }
      hands++;
    }
  }
});

test('button rotates and a busted player is removed from the rotation', () => {
  const t = makeTable(3, { startingStack: 100 });
  t.startHand();
  const firstButton = t.buttonIndex;
  t.seats[0].stack = 0;
  t.phase = 'handover';
  t.startHand();
  assert.notEqual(t.buttonIndex, firstButton);
  assert.equal(t.seats[0].out, true);
  assert.equal(t.seats[0].folded, true);
});
