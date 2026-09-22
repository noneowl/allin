import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, assembleMods, monteCarloEquity, rollBreakingMode } from '../server/boss/ai.js';
import { Boss } from '../server/boss/boss.js';
import { Mental, STATES, SCALE, ORDER, isDownEvent, FACES, MOODS } from '../server/boss/mental.js';
import { pickLine, claimMatches, sizeLevel, pickSpeechReact, TALK } from '../server/boss/talk.js';
import { pickRead, LEANS, INTENT_LINES, STATE_LINES, FOG_LINES } from '../server/boss/reads.js';
import { loadBalance } from '../server/battle.js';
import { seededRng } from '../server/engine/cards.js';

const rngOf = (seed) => {
  const r = seededRng(seed);
  return () => r.next();
};

const balance = loadBalance();

// ------------------------------------------------------------------ 心理状态机

test('转移表结构合法：双向、无自环、概率在 0..1，关键边齐全', () => {
  for (const [event, row] of Object.entries(balance.transitions)) {
    if (event === 'comment') continue;
    for (const [from, spec] of Object.entries(row)) {
      const [to, chance] = spec;
      assert.ok(STATES.includes(from), `${event} 的起点 ${from} 合法`);
      assert.ok(STATES.includes(to), `${event} 的终点 ${to} 合法`);
      assert.notEqual(to, from, `${event}: ${from} → ${to} 不允许自环`);
      assert.ok(chance >= 0 && chance <= 1, `${event}/${from} 概率在 0..1`);
    }
  }
  const T = balance.transitions;
  // 打击向下（含从正轨打断）
  assert.deepEqual(T.BLUFF_CAUGHT.CALM, ['SHAKEN', 1]);
  assert.deepEqual(T.CONTRADICTION_EXPOSED.SHAKEN, ['TILT', 1]);
  assert.deepEqual(T.BLUFF_CAUGHT.HOT, ['CALM', 0.75], '顺风被抓诈唬 → 幻灭');
  // 赢钱向上（非线性回血）
  assert.deepEqual(T.BIG_POT_WON.TILT, ['SHAKEN', 0.65]);
  assert.deepEqual(T.ALL_IN_WON.BREAKING, ['TILT', 0.65]);
  assert.deepEqual(T.WIN_STREAK.CALM, ['HOT', 0.85], '连赢爬正向轴');
  assert.deepEqual(T.BIG_POT_WON.HOT, ['FLOW', 0.7], '得意时赢大底池 → 神了');
  // 顺风可被打断
  assert.deepEqual(T.HAND_LOST.FLOW, ['HOT', 1], '输一手神了就掉档');
  // 抓千/言语类事件永不回血：所有边必须是「向下或打断正轨」
  for (const ev of ['CONTRADICTION_EXPOSED', 'LANGUAGE_WEAKNESS_HIT', 'BLUFF_CAUGHT',
    'CONSECUTIVE_READ_SUCCESS', 'PLAYER_BLUFF_SUCCESS']) {
    for (const [from, [to]] of Object.entries(T[ev])) {
      assert.ok(isDownEvent(from, to), `${ev}: ${from} → ${to} 必须向下（心理打击不回血）`);
    }
  }
});

test('状态可以回升（赢钱事件）与护甲减伤（心理打击不吃护甲）', () => {
  const up = new Mental({ transitions: { WIN_STREAK: { CALM: ['HOT', 1] } }, rng: () => 0.99 });
  up.state = 'CALM';
  assert.deepEqual(up.attempt('WIN_STREAK'), { from: 'CALM', to: 'HOT', cause: 'WIN_STREAK' });

  // 护甲：HOT 对 BIG_POT_LOST ×0.45 —— 概率 0.6 被压到 0.27，rng=0.5 打不下来
  const table = { BIG_POT_LOST: { HOT: ['SHAKEN', 0.6] } };
  const armored = new Mental({ transitions: table, rng: () => 0.5 });
  armored.state = 'HOT';
  assert.equal(armored.attempt('BIG_POT_LOST', 0.45), null, '护甲兜住');
  assert.equal(armored.state, 'HOT');
  const naked = new Mental({ transitions: table, rng: () => 0.5 });
  naked.state = 'HOT';
  assert.deepEqual(naked.attempt('BIG_POT_LOST', 1), { from: 'HOT', to: 'SHAKEN', cause: 'BIG_POT_LOST' });
});

test('状态级言语抗性：得意减半、神了免疫', () => {
  const buff = [{ skill: 'taunt', decisions: 2 }];
  const delta = (state) => {
    const m = assembleMods(balance, state, { buffs: buff });
    return m.aggression - balance.mentalModifiers[state].aggression;
  };
  const shaken = delta('SHAKEN'); // stateScale 1.0 × speechScale 1 = 全额
  const hot = delta('HOT');       // × speechScale 0.5 = 减半
  const flow = delta('FLOW');     // × speechScale 0 = 免疫
  assert.ok(hot > 0 && hot < shaken, `得意减半：SHAKEN=${shaken.toFixed(2)} HOT=${hot.toFixed(2)}`);
  assert.equal(flow, 0, '神了言语免疫');
});

test('确定概率的转移：1.0 必发、0 必不发', () => {
  const always = new Mental({ transitions: { X: { CALM: ['SHAKEN', 1] } }, rng: () => 0.99 });
  assert.deepEqual(always.attempt('X'), { from: 'CALM', to: 'SHAKEN', cause: 'X' });

  const never = new Mental({ transitions: { X: { CALM: ['SHAKEN', 0] } }, rng: () => 0.999 });
  assert.equal(never.attempt('X'), null);
  assert.equal(never.state, 'CALM');

  // 没有定义的事件/状态 → null，状态不动
  const m = new Mental({ transitions: {}, rng: () => 0 });
  assert.equal(m.attempt('WHATEVER'), null);
  assert.equal(m.state, 'CALM');
});

test('判定失败会累积躁动，让后续转移更容易', () => {
  // p=0.5，失败两次（debt 0.15→0.30）后 p≥0.8，第三次 0.3 必然成功
  const values = [0.7, 0.8, 0.3];
  let calls = 0;
  const m = new Mental({ transitions: { X: { SHAKEN: ['TILT', 0.5] } }, rng: () => values[calls++] ?? 1 });
  m.state = 'SHAKEN';
  assert.equal(m.attempt('X'), null);
  assert.ok(m.debt > 0, '失败要累积躁动');
  assert.equal(m.attempt('X'), null);
  assert.ok(m.debt >= 0.3, `躁动继续累积（实际 ${m.debt}）`);
  assert.deepEqual(m.attempt('X'), { from: 'SHAKEN', to: 'TILT', cause: 'X' });
  assert.equal(m.debt, 0, '转移成功后躁动回落');
});

test('四个状态都有表情和中文标签', () => {
  for (const s of STATES) {
    assert.ok(FACES[s], `${s} 缺表情`);
    assert.ok(MOODS[s], `${s} 缺标签`);
  }
  assert.equal(SCALE.length, 6, '情绪刻度六格');
  assert.equal(isDownEvent('CALM', 'SHAKEN'), true);
  assert.equal(isDownEvent('HOT', 'CALM'), true, '从得意掉下来也是向下');
  assert.equal(isDownEvent('SHAKEN', 'CALM'), false, '回血是向上');
});

// ------------------------------------------------------------------ 矛盾判定

test('注码分档', () => {
  const levels = balance.contradiction.sizeLevels; // [0.35, 0.55, 0.95, 1.5]
  assert.equal(sizeLevel(100, 25, levels), 0); // 0.25 池
  assert.equal(sizeLevel(100, 45, levels), 1); // 0.45 池
  assert.equal(sizeLevel(100, 70, levels), 2); // 0.70 池（基线）
  assert.equal(sizeLevel(100, 120, levels), 3); // 1.2 池
  assert.equal(sizeLevel(100, 200, levels), 4); // 超池
});

test('言行不一：强话配小注 = 矛盾，弱话配重注 = 矛盾，中性话安全', () => {
  assert.equal(claimMatches(2, 0), false, '放狠话 + 0.25 池 → 矛盾（规格示例）');
  assert.equal(claimMatches(2, 1), false, '放狠话 + 0.45 池 → 矛盾');
  assert.equal(claimMatches(2, 2), true, '放狠话 + 0.7 池 → 对得上');
  assert.equal(claimMatches(0, 2), false, '示弱 + 0.7 池 → 矛盾');
  assert.equal(claimMatches(0, 3), false, '示弱 + 超池 → 矛盾');
  assert.equal(claimMatches(0, 0), true, '示弱 + 小注 → 对得上');
  assert.equal(claimMatches(1, 2), true, '中性 + 正常注 → 对得上');
  assert.equal(claimMatches(1, 4), false, '中性 + 超池 → 矛盾');
});

test('选词：lineBias=1 必选对不上的台词（当池子里有）', () => {
  const levels = balance.contradiction.sizeLevels;
  // CALM+BLUFF 全是狠话(c2) → 小注(level0) 下必产出矛盾台词
  for (let seed = 1; seed <= 20; seed++) {
    const line = pickLine({
      state: 'CALM', intent: 'BLUFF', action: 'bet',
      potBefore: 100, put: 25, lineBias: 1, rng: rngOf(seed), sizeLevels: levels,
    });
    assert.equal(claimMatches(line.claim, sizeLevel(100, 25, levels)), false, `lineBias=1 应选矛盾台词，得到 ${JSON.stringify(line)}`);
  }
  // lineBias=0 时，池内有匹配台词则必选匹配的
  for (let seed = 1; seed <= 20; seed++) {
    const line = pickLine({
      state: 'CALM', intent: 'BLUFF', action: 'bet',
      potBefore: 100, put: 70, lineBias: 0, rng: rngOf(seed), sizeLevels: levels,
    });
    assert.equal(claimMatches(line.claim, sizeLevel(100, 70, levels)), true, `lineBias=0 应选对得上的台词，得到 ${JSON.stringify(line)}`);
  }
});

test('每个状态 × 意图都有台词池', () => {
  for (const state of STATES) {
    assert.ok(TALK[state], `${state} 缺台词池`);
    assert.ok(TALK[state].any.length > 0);
    for (const intent of ['VALUE', 'BLUFF', 'PROBE', 'TRAP', 'POT_CONTROL']) {
      assert.ok(TALK[state][intent]?.length > 0, `${state} 缺 ${intent} 台词`);
    }
  }
});

test('言语回应：每个状态 × 技能 × 结果都有话', () => {
  for (const state of STATES) {
    for (const skill of ['taunt', 'pressure', 'challenge']) {
      for (const result of ['hit', 'resist', 'whiff']) {
        const line = pickSpeechReact(skill, state, result, rngOf(1));
        assert.ok(typeof line === 'string' && line.length > 0, `${skill}/${state}/${result} 没有台词`);
      }
    }
  }
});

// ------------------------------------------------------------------ READ

test('READ 对每个状态 × 情境 × 意图都返回结构化信息', () => {
  for (const state of STATES) {
    for (const situation of ['bet', 'checked', 'neutral']) {
      for (const intent of [null, 'VALUE', 'BLUFF', 'PROBE', 'TRAP', 'POT_CONTROL']) {
        for (let seed = 1; seed <= 5; seed++) {
          const r = pickRead({
            state, clarity: balance.mentalModifiers[state].readClarity,
            situation, intent, rng: rngOf(seed * 7 + state.length),
          });
          assert.ok(typeof r.text === 'string' && r.text.length > 0, `${state}/${situation}/${intent} 返回空`);
          assert.ok(r.lean === null || LEANS[r.lean], `lean 只能是 null 或合法标签（得到 ${r.lean}）`);
          assert.equal(r.leanLabel, r.lean ? LEANS[r.lean] : null);
        }
      }
    }
  }
  // 神了：READ 必须雾化 —— 面对他的下注也读不出倾向
  for (let seed = 1; seed <= 20; seed++) {
    const r = pickRead({ state: 'FLOW', situation: 'bet', intent: 'BLUFF', rng: rngOf(seed) });
    assert.equal(r.lean, null, '神了读不出倾向');
    assert.ok(FOG_LINES.includes(r.text), '神了只能抽到雾化台词');
  }
  assert.ok(INTENT_LINES.BLUFF[0].length > 0 && STATE_LINES.BREAKING.length > 0 && STATE_LINES.HOT.length > 0);
});

// ------------------------------------------------------------------ 决策

/** 固定情境跑 N 次决策，统计动作分布。 */
function sample({ n = 300, seed = 1, equity, toCall = 0, potBefore = 100, playerAllIn = false, state = 'CALM', buffs = [], exposed = false, street = 'flop' }) {
  const rng = rngOf(seed);
  const mods = assembleMods(balance, state, { buffs, exposed });
  const counts = { check: 0, call: 0, fold: 0, bet: 0, raise: 0, allin: 0 };
  const amounts = [];
  const legal = toCall > 0
    ? [
        { type: 'fold' },
        { type: 'call', amount: 100 },
        { type: 'raise', minTo: toCall + 60, maxTo: 1000 },
        { type: 'allin', to: 1000 },
      ]
    : [
        { type: 'check' },
        { type: 'bet', minTo: 10, maxTo: 1000 },
        { type: 'allin', to: 1000 },
      ];
  for (let i = 0; i < n; i++) {
    const d = decide({
      legal, potBefore, toCall, myCommitted: 0, myStack: 1000, street,
      bigBlind: 10, playerAllIn, equity,
      personality: balance.personality, mods, sizing: balance.sizing, rng,
    });
    counts[d.action] = (counts[d.action] ?? 0) + 1;
    if (d.amount) amounts.push(d.amount);
  }
  const total = n;
  return {
    foldRate: counts.fold / total,
    callRate: counts.call / total,
    raiseRate: (counts.raise + counts.allin) / total,
    betRate: (counts.bet + counts.allin) / total,
    avgAmount: amounts.length ? amounts.reduce((a, b) => a + b, 0) / amounts.length : 0,
    counts,
  };
}

test('强牌不弃：equity 0.8 面对下注几乎不 fold', () => {
  const s = sample({ equity: 0.8, toCall: 60, seed: 12 });
  assert.ok(s.foldRate < 0.1, `foldRate=${s.foldRate}`);
  assert.ok(s.raiseRate + s.callRate > 0.9);
});

test('烂牌价格差必弃：equity 0.15 面对大注以 fold 为主', () => {
  const s = sample({ equity: 0.15, toCall: 60, potBefore: 100, seed: 13 });
  assert.ok(s.foldRate > 0.55, `foldRate=${s.foldRate}`);
});

test('挑衅真的让 Boss 更凶：Raise 频率上升', () => {
  const base = sample({ equity: 0.5, toCall: 40, state: 'SHAKEN', seed: 21 });
  const taunted = sample({ equity: 0.5, toCall: 40, state: 'SHAKEN', buffs: [{ skill: 'taunt', decisions: 2 }], seed: 21 });
  assert.ok(taunted.raiseRate > base.raiseRate + 0.05,
    `挑衅后 raise 应明显变多：base=${base.raiseRate.toFixed(2)} taunt=${taunted.raiseRate.toFixed(2)}`);
});

test('施压真的让 Boss 更容易退缩：Fold 频率上升、Call 下降', () => {
  // 边缘牌（0.30）面对中等下注：价格一般、牌力一般 —— 施压最容易撬动的地方
  const base = sample({ equity: 0.3, toCall: 50, potBefore: 100, state: 'SHAKEN', seed: 22 });
  const pressured = sample({ equity: 0.3, toCall: 50, potBefore: 100, state: 'SHAKEN', buffs: [{ skill: 'pressure', decisions: 2 }], seed: 22 });
  assert.ok(pressured.foldRate > base.foldRate + 0.1,
    `施压后 fold 应明显变多：base=${base.foldRate.toFixed(2)} pressure=${pressured.foldRate.toFixed(2)}`);
  assert.ok(pressured.callRate < base.callRate, '施压后 call 应下降');
});

test('TILT 比 CALM 更敢演、注更大', () => {
  const calm = sample({ equity: 0.3, state: 'CALM', seed: 31 });
  const tilt = sample({ equity: 0.3, state: 'TILT', seed: 31 });
  assert.ok(tilt.betRate > calm.betRate + 0.1, `TILT 开火应更频繁：CALM=${calm.betRate.toFixed(2)} TILT=${tilt.betRate.toFixed(2)}`);
  assert.ok(tilt.avgAmount > calm.avgAmount * 1.15, `TILT 注应更大：CALM=${calm.avgAmount.toFixed(0)} TILT=${tilt.avgAmount.toFixed(0)}`);
});

test('全下对抗：TILT 比 CALM 更愿意接', () => {
  const calm = sample({ equity: 0.24, toCall: 300, potBefore: 600, playerAllIn: true, state: 'CALM', seed: 41 });
  const tilt = sample({ equity: 0.24, toCall: 300, potBefore: 600, playerAllIn: true, state: 'TILT', seed: 41 });
  assert.ok(tilt.callRate > calm.callRate + 0.4,
    `TILT 应更敢接全下：CALM call=${calm.callRate.toFixed(2)} TILT call=${tilt.callRate.toFixed(2)}`);
});

test('异议命中后本手行为偏移（exposed）', () => {
  const base = sample({ equity: 0.4, state: 'SHAKEN', seed: 51 });
  const exposed = sample({ equity: 0.4, state: 'SHAKEN', exposed: true, seed: 51 });
  assert.ok(exposed.betRate + exposed.raiseRate >= base.betRate + base.raiseRate - 0.001,
    '点破后攻击性不应下降');
  assert.ok(exposed.avgAmount >= base.avgAmount * 0.999, '点破后注码不应变小');
});

test('BREAKING 每次决策抽一种失控模式', () => {
  const modes = new Set();
  for (let seed = 1; seed <= 60; seed++) {
    const mode = rollBreakingMode(balance, rngOf(seed));
    assert.ok(mode && typeof mode === 'object');
    modes.add(JSON.stringify(mode));
  }
  assert.ok(modes.size >= 2, '应出现多种失控模式');
});

test('蒙特卡洛胜率方向正确', () => {
  const aa = monteCarloEquity(['As', 'Ad'], [], rngOf(7), 300);
  const r72 = monteCarloEquity(['7s', '2c'], [], rngOf(7), 300);
  assert.ok(aa > 0.75 && aa < 0.95, `AA 翻前胜率应约 0.85，实际 ${aa}`);
  assert.ok(r72 > 0.25 && r72 < 0.5, `72o 翻前胜率应明显偏低，实际 ${r72}`);
  assert.ok(aa > r72 + 0.3);
});

// ------------------------------------------------------------------ Boss 本体

test('Boss：Buff 按决策次数衰减，状态表情正确', () => {
  const boss = new Boss({ balance, rng: rngOf(61) });
  boss.applySpeechBuff('taunt');
  assert.equal(boss.buffs.length, 1);
  const ctx = {
    legal: [{ type: 'check' }, { type: 'bet', minTo: 10, maxTo: 500 }, { type: 'allin', to: 500 }],
    potBefore: 100, toCall: 0, myCommitted: 0, myStack: 500, street: 'flop', bigBlind: 10,
    hole: ['As', 'Kd'], board: ['2c', '7d'], equity: 0.5,
  };
  boss.decide(ctx);
  assert.equal(boss.buffs[0]?.decisions, 1, '消耗一次');
  boss.decide(ctx);
  assert.equal(boss.buffs.length, 0, '两次之后 Buff 消失');

  assert.equal(boss.state, 'CALM');
  assert.equal(boss.face, FACES.CALM);
  boss.mental.state = 'BREAKING';
  assert.equal(boss.mood, MOODS.BREAKING);
});

test('Boss：下注类动作永远配台词，弃牌从不说话', () => {
  const boss = new Boss({ balance, rng: () => 0.5 });
  for (const state of STATES) {
    boss.mental.state = state;
    const betTalk = boss.talkFor({ action: 'bet', intent: 'BLUFF', potBefore: 100, put: 60, street: 'flop' });
    assert.ok(betTalk && betTalk.text.length > 0, `${state} 下注必须说话`);
    const foldTalk = boss.talkFor({ action: 'fold', intent: 'POT_CONTROL', potBefore: 100, put: 0, street: 'flop' });
    assert.equal(foldTalk, null, '弃牌是安静的');
  }
});

test('READ 优先给 live intent（本街刚下注的倾向）', () => {
  const boss = new Boss({ balance, rng: rngOf(71) });
  boss.noteAction({ action: 'raise', intent: 'BLUFF', street: 'flop' });
  let leanSeen = null;
  for (let i = 0; i < 16 && !leanSeen; i++) {
    const r = boss.read({ street: 'flop' });
    assert.ok(r.text.length > 0);
    if (r.lean) leanSeen = r;
  }
  assert.ok(leanSeen, '面对他的加注，BLUFF 意图应当能读出倾向');
  assert.equal(leanSeen.lean, 'fold');
  assert.equal(leanSeen.leanLabel, '他想让你弃牌');
  // 换街之后 live intent 失效，回落到状态信息（无 lean）
  const neutral = boss.read({ street: 'river' });
  assert.ok(neutral.text.length > 0);
});
