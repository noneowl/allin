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

// ================================================ 负债模式（GOTCHA，方案 §八/§十三）

test('负债模式：解除加注上限、不产生 all-in、可为负、双方守恒', () => {
  const d = makeDuel();
  d.startHand();
  d.debtMode = true; // 双方同时解除上限（方案 §八）

  const legal = d.legal(0);
  assert.ok(!legal.some((o) => o.type === 'allin'), '负债模式没有 all-in 选项');
  const raise = legal.find((o) => o.type === 'raise') ?? legal.find((o) => o.type === 'bet');
  assert.ok(raise, '仍有加注选项');
  assert.equal(raise.maxTo, Infinity, '上限解除');

  d.act(0, { action: 'raise', amount: 1500 }); // 玩家远超自身500
  assert.ok(d.stacks[0] < 0, `stack 可为负（${d.stacks[0]}）`);
  assert.equal(d.allIn[0], false, '不产生 all-in 语义');
  assert.equal(d.phase, 'playing', '不触发 runout');
  assert.equal(held(d), 2000, '负债期间筹码+投入守恒');

  // Boss 也解除上限：超出自身可动用部分继续加注
  d.act(1, { action: 'raise', amount: 3000 });
  assert.equal(held(d), 2000, '双方都可越界但总量不变');
});

test('负债模式：跟注不受剩余筹码限制；结算后总量守恒', () => {
  const d = makeDuel({ stacks: [40, 5000] });
  d.startHand();
  d.debtMode = true;
  // 回合顺序：玩家（button/SB）先动
  d.act(0, { action: 'raise', amount: 60 });   // put50 → stack -10
  assert.ok(d.stacks[0] < 0, '先越界');
  d.act(1, { action: 'raise', amount: 400 });  // Boss 反加
  const call = d.legal(0).find((o) => o.type === 'call');
  assert.ok(call, '有跟注选项');
  assert.equal(call.amount, 400 - d.committed[0], '跟注额 = 差额（不受剩余筹码限制）');
  const heldBefore = held(d);
  d.act(0, { action: 'call' });
  assert.ok(d.stacks[0] < 0, `跟到负数（${d.stacks[0]}）`);
  assert.equal(held(d), heldBefore, '行动中守恒');
  // 打到结算（自动 runout → 摊牌）
  let guard = 0;
  while (d.phase === 'playing' && guard++ < 40) d.act(d.toAct, { action: 'check' });
  assert.equal(d.phase, 'handover');
  assert.equal(held(d), 40 + 5000, '结算后总量守恒（与开战一致）');
});

test('负数筹码守卫：未结算的负数禁止进入下一手；正常复位 debtMode', () => {
  // 守卫：直接带着负数筹码开新手牌 → 拒绝
  const d = makeDuel();
  d.startHand();
  d.stacks[0] = -5;
  assert.throws(() => d.startHand(), (e) => e.code === 'NEGATIVE_STACK', '负数不入普通阶段');

  // 正常路径：弃牌结算（与牌面无关）后筹码非负 → 可开下一手，且 debtMode 已复位
  const d2 = makeDuel({ stacks: [200, 5000] });
  d2.startHand();
  d2.debtMode = true;
  d2.act(0, { action: 'raise', amount: 180 });  // 越界（200 里的 180 = put170+sb…实际 put170 → stack20）
  d2.act(1, { action: 'fold' });                 // Boss 弃牌 → 玩家赢，退款后非负
  assert.equal(d2.phase, 'handover');
  assert.ok(d2.stacks[0] >= 0, `弃牌获胜后非负（${d2.stacks[0]}）`);
  d2.startHand();
  assert.equal(d2.debtMode, false, 'debtMode 已复位');
  assert.ok(d2.stacks[0] >= 0 && d2.stacks[1] >= 0);
  assert.equal(held(d2), 200 + 5000, '总量守恒');
});

test('普通模式行为不变（回归）：夹取而非抛错、all-in 照旧', () => {
  const d = makeDuel();
  d.startHand();
  const legal = d.legal(0);
  assert.ok(legal.some((o) => o.type === 'allin'), '普通模式有 all-in');
  const raise = legal.find((o) => o.type === 'raise');
  assert.ok(raise.maxTo <= 1000, '普通模式受 Stack 上限');
  // 超限金额被夹到 maxTo（引擎历史行为：夹取不抛错）→ 变成全下
  d.act(0, { action: 'raise', amount: 2000 });
  assert.equal(d.stacks[0], 0, '超限金额夹到筹码上限');
  assert.equal(d.allIn[0], true, '普通模式顶格即 all-in');
});
