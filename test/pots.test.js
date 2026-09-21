import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPots, returnUncalled, totalPot } from '../server/engine/pots.js';

const seat = (s, totalCommitted, folded = false) => ({ seat: s, totalCommitted, folded });

test('single pot when everyone commits the same', () => {
  const { pots, refunds } = buildPots([seat(0, 100), seat(1, 100), seat(2, 100)]);
  assert.equal(pots.length, 1);
  assert.equal(pots[0].amount, 300);
  assert.deepEqual(pots[0].eligible, [0, 1, 2]);
  assert.deepEqual(refunds, []);
});

test('one side pot from a short all-in', () => {
  const { pots } = buildPots([seat(0, 200), seat(1, 200), seat(2, 50)]);
  assert.equal(pots.length, 2);
  assert.equal(pots[0].amount, 150);
  assert.deepEqual(pots[0].eligible, [0, 1, 2]);
  assert.equal(pots[1].amount, 300);
  assert.deepEqual(pots[1].eligible, [0, 1]);
  assert.equal(totalPot(pots), 450);
});

test('two side pots with three distinct stacks', () => {
  const { pots } = buildPots([seat(0, 500), seat(1, 300), seat(2, 100)]);
  assert.equal(pots.length, 3);
  assert.deepEqual(pots.map((p) => p.amount), [300, 400, 200]);
  assert.deepEqual(pots.map((p) => p.eligible), [[0, 1, 2], [0, 1], [0]]);
  assert.equal(totalPot(pots), 900);
});

test('folded money stays in the pot but removes eligibility', () => {
  const { pots } = buildPots([seat(0, 100), seat(1, 100, true), seat(2, 100)]);
  assert.equal(pots.length, 1);
  assert.equal(pots[0].amount, 300);
  assert.deepEqual(pots[0].eligible, [0, 2]);
});

test('consecutive levels with identical eligibility merge', () => {
  const { pots } = buildPots([seat(0, 100), seat(1, 100, true), seat(2, 50, true)]);
  assert.equal(pots.length, 1);
  assert.equal(pots[0].amount, 250);
  assert.deepEqual(pots[0].eligible, [0]);
});

test('a level no live player reached is refunded, never dropped', () => {
  // Two players each committed 166 then folded; the only live players are
  // all-in for 8 and 4. The 332 above the live cap cannot be won by anyone.
  const seats = [seat(0, 0), seat(1, 166, true), seat(2, 0), seat(3, 8), seat(4, 4), seat(5, 166, true)];
  const { pots, refunds } = buildPots(seats);
  const returned = refunds.reduce((sum, r) => sum + r.amount, 0);
  const inPots = totalPot(pots);
  assert.equal(returned, 316);
  assert.deepEqual(refunds, [{ seat: 1, amount: 158 }, { seat: 5, amount: 158 }]);
  assert.equal(returned + inPots, seats.reduce((s, x) => s + x.totalCommitted, 0), 'nothing vanishes');
  assert.deepEqual(pots.map((p) => p.eligible), [[3, 4], [3]]);
});

test('uncalled excess is returned, not put in a pot', () => {
  const seats = [seat(0, 500), seat(1, 200)];
  const refund = returnUncalled(seats);
  assert.deepEqual(refund, { seat: 0, amount: 300 });
  assert.equal(seats[0].totalCommitted, 200);
  const { pots } = buildPots(seats);
  assert.equal(totalPot(pots), 400);
});

test('returnUncalled is a no-op when the top two are equal', () => {
  const seats = [seat(0, 200), seat(1, 200), seat(2, 50)];
  assert.equal(returnUncalled(seats), null);
  assert.equal(seats[0].totalCommitted, 200);
});
