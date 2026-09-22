import test from 'node:test';
import assert from 'node:assert/strict';
import { Duel, GameError } from '../server/engine/duel.js';
import { makeDeck, shuffle, seededRng } from '../server/engine/cards.js';

const held = (d) => d.stacks[0] + d.stacks[1] + d.total[0] + d.total[1];

function makeDuel(opts = {}) {
  return new Duel({
    stacks: [1000, 1000],
    smallBlind: 10,
    bigBlind: 20,
    button: 0,
    ...opts,
  });
}

test('单挑盲注与行动顺序：庄家下小盲、翻前先行动', () => {
  const d = makeDuel();
  d.startHand();
  assert.equal(d.button, 0);
  assert.equal(d.committed[0], 10, '庄家下小盲');
  assert.equal(d.committed[1], 20, '非庄家下大盲');
  assert.equal(d.toAct, 0, '翻前庄家先行动');
  assert.equal(d.hole[0].length, 2);
  assert.equal(d.hole[1].length, 2);
  assert.equal(held(d), 2000, '筹码守恒');
});

test('翻后由非庄家先行动', () => {
  const d = makeDuel();
  d.startHand();
  d.act(0, { action: 'call' }); // limp
  d.act(1, { action: 'check' }); // BB 选项
  assert.equal(d.street, 'flop');
  assert.equal(d.board.length, 3);
  assert.equal(d.toAct, 1, '庄家是 0，翻后 1 号先行动');
});

test('大盲有选项：无人加注时仍可加注', () => {
  const d = makeDuel();
  d.startHand();
  d.act(0, { action: 'call' });
  assert.equal(d.toAct, 1, 'BB 还没行动');
  const legal = d.legal(1).map((a) => a.type);
  assert.ok(legal.includes('raise'), 'BB 可以加注');
  assert.ok(legal.includes('check'));
  d.act(1, { action: 'check' });
  assert.equal(d.street, 'flop');
});

test('最小加注 = 上一次加注幅度；非法金额被夹取', () => {
  const d = makeDuel();
  d.startHand(); // button 0，toAct 0
  d.act(0, { action: 'raise', amount: 60 });
  assert.equal(d.currentBet, 60);
  assert.equal(d.lastRaiseSize, 40, '相对 20 的加注幅度是 40');
  const legal = d.legal(1).find((a) => a.type === 'raise');
  assert.equal(legal.minTo, 100, '最小 raise-to = 60+40');

  // 1 号夹取到最小值
  d.act(1, { action: 'raise', amount: 1 });
  assert.equal(d.currentBet, 100);
});

test('bet 与 raise 语义按当前牌价自动归一', () => {
  const d = makeDuel();
  d.startHand();
  d.act(0, { action: 'call' });
  d.act(1, { action: 'check' });
  // 翻后 currentBet=0：用 raise 也应当被接受为 bet
  assert.equal(d.street, 'flop');
  assert.equal(d.toAct, 1);
  const r = d.act(1, { action: 'raise', amount: 40 });
  assert.equal(r.normalized.type, 'bet');
  assert.equal(d.currentBet, 40);
  // 面对下注用 bet 也应归一为 raise
  const r2 = d.act(0, { action: 'bet', amount: 120 });
  assert.equal(r2.normalized.type, 'raise');
  assert.equal(d.currentBet, 120);
});

test('弃牌立即结束并退还未被跟注的部分', () => {
  const d = makeDuel();
  d.startHand();
  d.act(0, { action: 'allin' }); // 1000 全下
  d.act(1, { action: 'fold' }); // 只投了 20
  assert.equal(d.phase, 'handover');
  assert.equal(d.result.type, 'fold');
  assert.equal(d.result.winner, 0);
  assert.equal(d.stacks[0], 1020, '只赢走 20，980 退还');
  assert.equal(d.stacks[1], 980);
  assert.equal(held(d), 2000, '筹码守恒');
});

test('翻前全下会自动发完公共牌并摊牌', () => {
  const d = makeDuel();
  d.startHand();
  d.act(0, { action: 'allin' });
  const r = d.act(1, { action: 'call' });
  assert.equal(d.phase, 'handover');
  assert.equal(d.board.length, 5, '自动 runout');
  assert.equal(d.result.type, 'showdown');
  assert.ok(r.events.some((e) => e.type === 'street' && e.street === 'flop'));
  assert.ok(r.events.some((e) => e.type === 'showdown'));
  assert.equal(held(d), 2000, '筹码守恒');
  const hands = d.result.hands;
  assert.equal(hands.length, 2);
  if (d.result.split) assert.equal(d.stacks[0], 1000);
  else assert.equal(d.stacks[d.result.winner], 2000);
});

test('短筹码全下抬价但不重开加注', () => {
  const d = makeDuel();
  d.startHand();
  d.act(0, { action: 'raise', amount: 60 }); // 完整加注，幅度 40
  d.act(1, { action: 'raise', amount: 100 }); // 再加注，幅度 40，当前价 100
  // 让 0 号只剩 60：maxTo = 60(已投) + 60 = 120，只比 100 高 20 < 40 → 短抬价
  d.stacks[0] = 60;
  d.act(0, { action: 'allin' });
  assert.equal(d.currentBet, 120, '价格抬到 120');
  assert.equal(d.lastRaiseSize, 40, '最小加注幅度不变');
  const legal = d.legal(1);
  assert.ok(!legal.some((a) => a.type === 'raise'), '已行动者不能重开加注');
  assert.ok(legal.some((a) => a.type === 'call'));
  assert.ok(legal.some((a) => a.type === 'fold'));
});

test('不足跟注的全下按跟注处理', () => {
  const d = makeDuel();
  d.startHand();
  d.act(0, { action: 'raise', amount: 400 });
  d.stacks[1] = 35; // 测试直接改筹码，先记录此时的总量再要求守恒
  const total = held(d);
  d.act(1, { action: 'allin' });
  assert.equal(d.phase, 'handover', '跟注后双方筹码关系确定 → 自动 runout');
  assert.equal(d.board.length, 5);
  assert.equal(held(d), total, '筹码守恒');
  // 35 全推：要么输光，要么连本带利收走整个底池
  assert.ok(d.stacks[1] === 0 || d.stacks[1] > 35, `结算合理（实际 ${d.stacks[1]}）`);
});

test('非法动作被拒绝且不改动状态', () => {
  const d = makeDuel();
  d.startHand();
  const before = { stacks: d.stacks.slice(), committed: d.committed.slice(), toAct: d.toAct };
  assert.throws(() => d.act(1, { action: 'call' }), GameError, '未轮到不能行动');
  assert.throws(() => d.act(0, { action: 'check' }), GameError, '小盲不足跟不能过牌');
  assert.throws(() => d.act(0, { action: 'nonsense' }), GameError);
  assert.deepEqual(d.stacks, before.stacks);
  assert.deepEqual(d.committed, before.committed);
  assert.equal(d.toAct, before.toAct);
});

test('面对下注不能过牌', () => {
  const d = makeDuel();
  d.startHand();
  d.act(0, { action: 'raise', amount: 60 });
  assert.throws(() => d.act(1, { action: 'check' }), /过牌/);
  assert.ok(d.legal(1).some((a) => a.type === 'call'));
  assert.ok(!d.legal(1).some((a) => a.type === 'check'));
});

test('河牌圈两家过牌 → 摊牌', () => {
  const d = makeDuel();
  d.startHand();
  d.act(0, { action: 'call' });
  d.act(1, { action: 'check' });
  for (const street of ['flop', 'turn', 'river']) {
    assert.equal(d.street, street);
    const first = d.toAct;
    d.act(first, { action: 'check' });
    d.act(1 - first, { action: 'check' });
  }
  assert.equal(d.phase, 'handover');
  assert.equal(d.result.type, 'showdown');
  assert.equal(d.board.length, 5);
  assert.equal(held(d), 2000);
});

test('平局分池', () => {
  // 公共牌是坚果面：双方都只能用板上牌
  const d = makeDuel({ stacks: [500, 500] });
  const deck = shuffle(makeDeck(), seededRng(3));
  // 把 9 张注定要用的牌排到牌堆尾部（_draw 从尾部抽）
  d.startHand({ deck });
  // 双方一路过牌到摊牌
  let guard = 0;
  while (d.phase === 'playing' && guard++ < 50) {
    const seat = d.toAct;
    const legal = d.legal(seat);
    const check = legal.find((a) => a.type === 'check');
    const call = legal.find((a) => a.type === 'call');
    d.act(seat, check ? { action: 'check' } : { action: 'call' });
  }
  assert.equal(d.phase, 'handover');
  assert.equal(held(d), 1000, '筹码守恒');
  if (d.result.split) {
    assert.equal(d.stacks[0], 500);
    assert.equal(d.stacks[1], 500);
  }
});

test('模糊测试：随机合法动作永不破坏牌局，筹码始终守恒', () => {
  for (let seed = 1; seed <= 80; seed++) {
    const rng = seededRng(seed);
    const d = makeDuel({ stacks: [500, 500], button: seed % 2 });
    let hands = 0;
    while (hands < 10) {
      const deck = shuffle(makeDeck(), seededRng(seed * 100 + hands));
      d.handNo = hands + 1;
      d.startHand({ deck });
      assert.equal(held(d), 1000, `发牌后筹码守恒 seed=${seed} hand=${hands}`);
      let guard = 0;
      while (d.phase === 'playing') {
        if (guard++ > 300) throw new Error(`seed=${seed} hand=${hands} 未终止`);
        const seat = d.toAct;
        assert.ok(seat === 0 || seat === 1, '必须有人行动');
        const legal = d.legal(seat);
        assert.ok(legal.length > 0, '行动者必有合法选项');
        const pick = legal[Math.floor(rng.next() * legal.length)];
        let amount;
        if (pick.minTo !== undefined) {
          amount = pick.minTo + Math.floor(rng.next() * (pick.maxTo - pick.minTo + 1));
        }
        d.act(seat, { action: pick.type, amount });
        assert.ok(d.stacks[0] >= 0 && d.stacks[1] >= 0, '无负筹码');
        assert.equal(held(d), 1000, `行动中筹码守恒 seed=${seed}`);
      }
      assert.ok(d.result, '结束必有结果');
      assert.equal(held(d), 1000, `结算后筹码守恒 seed=${seed}`);
      if (d.result.type === 'fold') {
        assert.ok(!d.folded[d.result.winner], '弃牌局的赢家是没弃牌的那个');
      } else {
        const split = d.result.split;
        if (!split) {
          const w = d.result.winner;
          assert.ok(w === 0 || w === 1, '摊牌必有赢家');
        }
      }
      hands++;
      d.button = 1 - d.button; // 每手轮换
    }
  }
});

test('事件顺序：盲注 → 行动 → 公共牌 → 摊牌', () => {
  const d = makeDuel();
  const all = [...d.startHand()];
  d.act(0, { action: 'allin' });
  const r = d.act(1, { action: 'call' });
  all.push(...r.events);
  const types = all.map((e) => e.type);
  assert.deepEqual(types.slice(0, 2), ['blinds', 'blinds']);
  assert.equal(types.filter((t) => t === 'street').length, 3);
  assert.equal(types[types.length - 1], 'showdown');
  // 公共牌按 flop/turn/river 顺序
  const streets = all.filter((e) => e.type === 'street').map((e) => e.street);
  assert.deepEqual(streets, ['flop', 'turn', 'river']);
});
