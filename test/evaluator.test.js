import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, rank5, CATEGORY_ZH, compareHands, describeHole, describeMadeHand } from '../server/engine/evaluator.js';
import { makeDeck, isCard, shuffle, seededRng } from '../server/engine/cards.js';

const H = (s) => s.split(' ');

test('deck is a well-formed 52 card set', () => {
  const deck = makeDeck();
  assert.equal(deck.length, 52);
  assert.equal(new Set(deck).size, 52);
  assert.ok(deck.every(isCard));
});

test('seeded shuffle is deterministic and keeps every card', () => {
  const a = shuffle(makeDeck(), seededRng(42));
  const b = shuffle(makeDeck(), seededRng(42));
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, 52);
});

test('rank5 classifies every category', () => {
  const cases = [
    ['As Ks Qs Js Ts', 8, '同花顺'],
    ['9h 8h 7h 6h 5h', 8, '同花顺'],
    ['Ah 2h 3h 4h 5h', 8, '同花顺'],
    ['7c 7d 7h 7s Kd', 7, '四条'],
    ['Qc Qd Qh 4s 4d', 6, '葫芦'],
    ['Ah Jh 9h 6h 3h', 5, '同花'],
    ['Td 9c 8h 7s 6d', 4, '顺子'],
    ['Ah 2d 3c 4s 5h', 4, '顺子'],
    ['5c 5d 5h Ks 2d', 3, '三条'],
    ['Kc Kd 7h 7s 2d', 2, '两对'],
    ['Ac Ad 9h 5s 3d', 1, '一对'],
    ['Ac Kd 9h 5s 3d', 0, '高牌'],
  ];
  for (const [hand, cat, zh] of cases) {
    const r = rank5(H(hand));
    assert.equal(r.category, cat, `${hand} should be category ${cat}`);
    assert.equal(CATEGORY_ZH[r.category], zh);
  }
});

test('the wheel is the weakest straight', () => {
  const wheel = rank5(H('Ah 2d 3c 4s 5h'));
  const six = rank5(H('2h 3d 4c 5s 6h'));
  assert.ok(wheel.score < six.score);
  // Wheel must also lose to a pair, despite being a straight.
  assert.ok(wheel.score > rank5(H('Ac Ad Kh Qs Jd')).score);
});

test('kicker order matters and ties are exact', () => {
  const ak = rank5(H('Ac Kd 9h 5s 3d'));
  const aq = rank5(H('Ac Qd 9h 5s 3d'));
  assert.ok(ak.score > aq.score);
  assert.equal(ak.score, rank5(H('Ad Kc 9s 5h 3c')).score);
});

test('evaluate picks the best five of seven', () => {
  const ev = evaluate(H('As Ks Qs Js Ts 2d 3c'));
  assert.equal(ev.category, 8);
  assert.equal(ev.best5.length, 5);
  assert.deepEqual(new Set(ev.best5), new Set(H('As Ks Qs Js Ts')));

  // Two pair on the board must not beat a made flush.
  const flush = evaluate(H('Ah 3h 4h 8h Kh 8c 8d'));
  assert.equal(flush.nameZh, '同花');

  // Two sets on board: best five is the higher trips full of the lower.
  const fh = evaluate(H('7c 7d 7h Kc Kd Ks 2c'));
  assert.equal(fh.nameZh, '葫芦');
  assert.deepEqual(new Set(fh.best5), new Set(H('Kc Kd Ks 7c 7d')));
});

test('seven-card full house beats a flush', () => {
  const fh = evaluate(H('7c 7d 7h Kc Kd 2c 3d'));
  assert.equal(fh.nameZh, '葫芦');
  assert.ok(fh.score > evaluate(H('Ah 3h 4h 8h Kh 8c 8d')).score);
});

test('wheel straight flush is the lowest straight flush', () => {
  const a = evaluate(H('5s 4s 3s 2s As Kd Qd'));
  const b = evaluate(H('6s 5s 4s 3s 2s Kd Qd'));
  assert.equal(a.nameZh, '同花顺');
  assert.ok(a.score < b.score);
});

test('compareHands is a strict ordering', () => {
  const quads = evaluate(H('7c 7d 7h 7s Kd 2c 3d'));
  const boat = evaluate(H('Ac Ad Ah Kd Ks 2c 3d'));
  assert.ok(compareHands(quads, boat) > 0);
  assert.equal(compareHands(boat, boat), 0);
});

test('describeMadeHand only names a hand once five cards exist', () => {
  assert.equal(describeMadeHand(H('As Kd'), []), 'AK 不同花');
  assert.equal(describeMadeHand(H('As Ks'), []), 'AK 同花');
  assert.equal(describeMadeHand(H('As Ad'), []), '口袋对子 A');
  assert.match(describeMadeHand(H('As Ad'), H('Ah 7c 2d')), /三条/);
  assert.equal(describeMadeHand(H('As Ad'), H('2c 3d')), null);
});

test('describeHole names ranks correctly', () => {
  assert.equal(describeHole(H('Th Ts')), '口袋对子 10');
  assert.equal(describeHole(H('2c 7d')), '72 不同花');
});
