import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decide, evaluateWeights, applyPersonality, applyEmotion,
  assembleMods, monteCarloEquity,
} from '../server/boss/ai.js';
import { Boss } from '../server/boss/boss.js';
import { Emotion, STATES, SCALE, ORDER, isDownEvent, FACES, MOODS, EVENT_NAMES } from '../server/boss/mental.js';
import { TALK, pickLine, pickWinQuip, WIN_QUIP } from '../server/boss/talk.js';
import { makeFragment, flashMs, TRUE_FAMILIES, NOISE_POOL, DISTORTION_POOL } from '../server/boss/fragments.js';
import { matchCrackRule, buildCrack } from '../server/boss/crack-rules.js';
import { PlayerModel } from '../server/boss/playermodel.js';
import { loadBalance } from '../server/battle.js';
import { seededRng } from '../server/engine/cards.js';

const rngOf = (seed) => {
  const r = seededRng(seed);
  return () => r.next();
};

const balance = loadBalance();

// ============================================================ 情绪（v3 三状态）

test('情绪转移表结构合法：三态、只被 CRACK 推进、无自环', () => {
  assert.deepEqual(STATES, ['CALM', 'SHAKEN', 'EXPOSED']);
  for (const [event, row] of Object.entries(balance.transitions)) {
    if (event === 'comment') continue;
    assert.ok(event in EVENT_NAMES, `${event} 要有中文名`);
    for (const [from, [to, chance]] of Object.entries(row)) {
      assert.ok(STATES.includes(from), `${event} 起点 ${from} 合法`);
      assert.ok(STATES.includes(to), `${event} 终点 ${to} 合法`);
      assert.notEqual(to, from, `${event}: 不允许自环`);
      assert.ok(chance >= 0 && chance <= 1, `${event}/${from} 概率 0..1`);
    }
  }
  // §6：连续 CRACK 必达（CALM→SHAKEN→EXPOSED），只有 CRACK 一张驱动表
  const T = balance.transitions;
  assert.deepEqual(T.CRACK.CALM, ['SHAKEN', 1]);
  assert.deepEqual(T.CRACK.SHAKEN, ['EXPOSED', 1]);
  assert.deepEqual(Object.keys(T).filter((k) => k !== 'comment'), ['CRACK'], '心理只被 CRACK 推进（§6/§8）');
  // 所有边都是向右推进（无回血、无旁支）—— 跳过 comment 字符串值
  for (const row of Object.values(T)) {
    if (typeof row !== 'object') continue;
    for (const [from, [to]] of Object.entries(row)) {
      assert.ok(isDownEvent(from, to), `${from} → ${to} 必须向右`);
    }
  }
});

test('Emotion：概率 1 必发、0 必不发、终态无边则不动', () => {
  const always = new Emotion({ transitions: { X: { CALM: ['SHAKEN', 1] } }, rng: () => 0.99 });
  assert.deepEqual(always.attempt('X'), { from: 'CALM', to: 'SHAKEN', cause: 'X' });
  assert.equal(always.state, 'SHAKEN');

  const never = new Emotion({ transitions: { X: { CALM: ['SHAKEN', 0] } }, rng: () => 0 });
  assert.equal(never.attempt('X'), null);

  // TILT 是终点：任何打击在 TILT 都无边可走
  const atTilt = new Emotion({ transitions: balance.transitions, rng: () => 0 });
  atTilt.state = 'EXPOSED';
  assert.equal(atTilt.attempt('CRACK'), null, 'EXPOSED 是终点，无边可走');
  assert.equal(atTilt.attempt('BLUFF_CAUGHT'), null, '筹码类事件不再推动心理（§8）');
  assert.equal(atTilt.state, 'EXPOSED');
});

test('三状态的表情/标签/方向判断', () => {
  for (const s of STATES) {
    assert.ok(FACES[s] && MOODS[s], `${s} 缺表情或标签`);
  }
  assert.equal(SCALE.length, 3);
  assert.equal(isDownEvent('CALM', 'SHAKEN'), true);
  assert.equal(isDownEvent('SHAKEN', 'CALM'), false);
});

// ============================================================ READ 碎片

function fragCtx(over = {}) {
  return {
    state: 'CALM', intent: null, equity: 0.5, street: 'flop',
    execution: false, balance, rng: rngOf(1), ...over,
  };
}

test('碎片按情绪取比例：CALM 噪音多，EXPOSED 真话与错觉密集', () => {
  const count = (state, n = 400) => {
    const c = { TRUE: 0, NOISE: 0, DISTORTION: 0 };
    const r = seededRng(7);
    for (let i = 0; i < n; i++) {
      const f = makeFragment(fragCtx({ state, intent: 'BLUFF', rng: () => r.next() }));
      c[f.type] += 1;
    }
    return c;
  };
  const calm = count('CALM');
  const tilt = count('EXPOSED');
  assert.ok(calm.NOISE > calm.TRUE, `CALM 噪音应多于真话（${calm.NOISE} vs ${calm.TRUE}）`);
  assert.ok(tilt.TRUE > calm.TRUE * 1.5, `EXPOSED 真话应显著多于 CALM（${tilt.TRUE} vs ${calm.TRUE}）`);
  assert.ok(tilt.TRUE + tilt.DISTORTION > (calm.TRUE + calm.DISTORTION) * 1.3, 'EXPOSED 信息更密集');
});

test('只有 TRUE 带标签；类型与标签绝不为 NOISE/DISTORTION 所带', () => {
  const r = seededRng(11);
  for (let i = 0; i < 300; i++) {
    const f = makeFragment(fragCtx({ state: 'TILT', intent: 'VALUE', rng: () => r.next() }));
    if (f.type === 'TRUE') {
      assert.ok(Array.isArray(f.tags) && f.tags.length > 0, 'TRUE 必须带标签');
      assert.ok(f.tags.every((t) => t in TRUE_FAMILIES), `未知标签 ${f.tags}`);
      assert.ok(f.strength > 0.4);
    } else {
      assert.deepEqual(f.tags, [], `${f.type} 不能带标签`);
    }
    assert.ok(typeof f.text === 'string' && f.text.length > 0);
  }
});

test('TRUE 碎片由 Boss 真实处境决定：BLUFF 意图漏弱点，VALUE 意图漏强牌', () => {
  const r = seededRng(13);
  const weakTags = new Set(['wants_fold', 'fear_call', 'fear_raise', 'weak_hand', 'missed_board', 'draw']);
  const strongTags = new Set(['strong_hand', 'call_welcome', 'trap', 'board_lock', 'overconfidence']);
  for (let i = 0; i < 200; i++) {
    const bluff = makeFragment(fragCtx({ state: 'SHAKEN', intent: 'BLUFF', rng: () => r.next() }));
    if (bluff.type === 'TRUE') assert.ok(bluff.tags.every((t) => weakTags.has(t)), `BLUFF 意图不得漏强牌标签: ${bluff.tags}`);
    const value = makeFragment(fragCtx({ state: 'SHAKEN', intent: 'VALUE', equity: 0.8, rng: () => r.next() }));
    if (value.type === 'TRUE') assert.ok(value.tags.every((t) => strongTags.has(t)), `VALUE 意图不得漏弱点标签: ${value.tags}`);
  }
  // Boss 还没做过重要行动 → 没有 intent 可泄漏，绝不产出 TRUE
  for (let i = 0; i < 100; i++) {
    const f = makeFragment(fragCtx({ intent: null, rng: () => r.next() }));
    assert.notEqual(f.type, 'TRUE', '没有 intent 就没有 TRUE');
  }
});

test('trueRate 覆盖与 fear_raise 家族（GOTCHA 泄漏与 §五规则所需）', () => {
  // trueRate=0 → 绝不 TRUE；trueRate=1 → 必 TRUE（有 intent 时）
  const r = rngOf(19); // 直接作为 rng 函数复用（rngOf 返回函数）
  for (let i = 0; i < 60; i++) {
    const f = makeFragment(fragCtx({ state: 'TILT', intent: 'BLUFF', trueRate: 0, rng: r }));
    assert.notEqual(f.type, 'TRUE');
  }
  for (let i = 0; i < 60; i++) {
    const f = makeFragment(fragCtx({ state: 'TILT', intent: 'BLUFF', trueRate: 1, rng: r }));
    assert.equal(f.type, 'TRUE');
  }
  assert.ok(TRUE_FAMILIES.fear_raise?.length > 0, '存在 fear_raise 家族（他怕你加注）');
  // BLUFF 意图可能抽到 fear_raise
  let saw = false;
  for (let i = 0; i < 200 && !saw; i++) {
    const f = makeFragment(fragCtx({ state: 'SHAKEN', intent: 'BLUFF', rng: r }));
    if (f.type === 'TRUE' && f.tags[0] === 'fear_raise') saw = true;
  }
  assert.ok(saw, 'BLUFF 家族池含 fear_raise');
  assert.equal(flashMs('EXPOSED', balance), balance.read.flashMs.EXPOSED);
  assert.ok(NOISE_POOL.length > 0 && Object.keys(DISTORTION_POOL).length === 3);
});

// ============================================================ CRACK 规则（情报×行动）

test('CRACK 规则匹配：只认 TRUE、行动与真值域都必须命中', () => {
  const RULES = balance.psychologyActionRules;
  assert.ok(RULES.length >= 8, '规则表已配置');
  const wantFold = RULES.find((r) => r.tag === 'wants_fold');
  assert.ok(wantFold, '存在 wants_fold 规则');
  assert.ok(wantFold.actions.includes('call'), '他想让你弃 → 你跟 = CRACK');
  assert.ok(wantFold.truthIntents.includes('BLUFF'), '真值域：他在诈唬时才成立');

  const pinTrue = { type: 'TRUE', tags: ['wants_fold'] };
  // 条件齐备 → 命中
  const hit = matchCrackRule(balance, pinTrue, 'call', 'BLUFF');
  assert.ok(hit && hit.id === wantFold.id);
  // NOISE / DISTORTION 永不匹配
  assert.equal(matchCrackRule(balance, { type: 'NOISE', tags: [] }, 'call', 'BLUFF'), null);
  assert.equal(matchCrackRule(balance, { type: 'DISTORTION', tags: [] }, 'call', 'BLUFF'), null);
  // 行动不符
  assert.equal(matchCrackRule(balance, pinTrue, 'fold', 'BLUFF'), null, '弃牌不满足 call 规则');
  // 真值不符（Boss 当前在做价值 → 旧的弱点情报失效）
  assert.equal(matchCrackRule(balance, pinTrue, 'call', 'VALUE'), null, '真值域不符不 CRACK');
  // 无 intent
  assert.equal(matchCrackRule(balance, pinTrue, 'call', null), null);

  // 强侧规则：trap + check
  const pinTrap = { type: 'TRUE', tags: ['trap'] };
  const trapRule = matchCrackRule(balance, pinTrap, 'check', 'TRAP');
  assert.ok(trapRule && trapRule.kind === 'STRENGTH');
  assert.equal(matchCrackRule(balance, pinTrap, 'check', 'BLUFF'), null, '强侧情报在诈唬 intent 下不成立');

  // buildCrack 形状
  const crack = buildCrack(wantFold, pinTrue, 'call', 7, 5);
  assert.equal(crack.id, 5);
  assert.equal(crack.kind, 'WEAKNESS');
  assert.deepEqual(crack.evidence, ['wants_fold']);
  assert.equal(crack.action, 'call');
  assert.equal(crack.handNo, 7);
  assert.equal(crack.critical, false);
});

// ============================================================ 三层决策

function decideCtx(over = {}) {
  const toCall = over.toCall ?? 0;
  const legal = over.legal ?? (toCall > 0
    ? [{ type: 'fold' }, { type: 'call', amount: 100 }, { type: 'raise', minTo: toCall + 60, maxTo: 1000 }, { type: 'allin', to: 1000 }]
    : [{ type: 'check' }, { type: 'bet', minTo: 10, maxTo: 1000 }, { type: 'allin', to: 1000 }]);
  return {
    legal, potBefore: 100, toCall, myCommitted: 0, myStack: 1000, street: 'flop',
    bigBlind: 10, playerAllIn: false, equity: 0.5,
    personality: balance.personality, mods: balance.emotions.CALM, sizing: balance.sizing,
    rng: rngOf(5), ...over,
  };
}

test('Layer1 评估：胜率越高越敢接越不弃（理性基础）', () => {
  const lo = evaluateWeights({ equity: 0.2, potBefore: 100, toCall: 60, sizing: balance.sizing });
  const hi = evaluateWeights({ equity: 0.8, potBefore: 100, toCall: 60, sizing: balance.sizing });
  assert.ok(hi.w.fold < lo.w.fold, '高胜率更不弃');
  assert.ok(hi.w.call > lo.w.call, '高胜率更敢接');
  assert.ok(hi.valueOpp && !lo.valueOpp, '机会标记按胜率划分');
  assert.ok(lo.bluffOpp && !hi.bluffOpp);
  assert.ok(lo.potOdds > 0.3 && lo.potOdds < 0.45, '底池赔率≈60/160');
});

test('Layer2 人格：DECEIVER 压低弃牌、抬高加注、开启诈唬权重 + 玩家模型适应', () => {
  const ev = evaluateWeights({ equity: 0.3, potBefore: 100, toCall: 60, sizing: balance.sizing });
  const neutralFold = ev.w.fold;
  const neutralRaise = ev.w.raiseValue;
  applyPersonality(ev, balance.personality, null, 0);
  assert.ok(ev.w.fold < neutralFold, 'DECEIVER 比中性更少弃');
  assert.ok(ev.w.raiseValue > neutralRaise, 'DECEIVER 比中性更敢加');
  assert.ok(ev.w.bluff > 0, '有诈唬机会就开诈唬权重');

  // Player Model 适应：玩家 READ 后爱开大 → 面对高压不再轻易弃
  const model = new PlayerModel();
  for (let i = 0; i < 5; i++) {
    model.record('read');
    model.record('action', { action: 'heavy', facingBet: true });
  }
  assert.equal(model.adaptation().noFoldVsHeavy, true);
  const ev2 = evaluateWeights({ equity: 0.3, potBefore: 100, toCall: 60, sizing: balance.sizing });
  const base = ev2.w.fold;
  applyPersonality(ev2, balance.personality, model, 1.2);
  assert.ok(ev2.w.fold <= base * 0.5, '适应后面对高压几乎不弃');
});

test('Layer3 情绪：EXPOSED 比 CALM 更凶、更敢接、方差更大', () => {
  const mk = (state) => {
    const ev = evaluateWeights({ equity: 0.45, potBefore: 100, toCall: 50, sizing: balance.sizing });
    applyPersonality(ev, balance.personality, null, 0.5);
    applyEmotion(ev, balance.emotions[state]);
    return ev;
  };
  const calm = mk('CALM');
  const tilt = mk('EXPOSED');
  assert.ok(tilt.w.fold < calm.w.fold, 'EXPOSED 更少弃');
  assert.ok(tilt.w.call > calm.w.call, 'EXPOSED 更敢接');
  assert.ok(tilt.w.raiseValue > calm.w.raiseValue, 'EXPOSED 更敢加');
  assert.ok(tilt.p.variance > calm.p.variance, 'EXPOSED 方差更大');
  assert.ok(tilt.p.bluffFrequency > calm.p.bluffFrequency, 'EXPOSED 诈唬更多');
});

test('采样统计：EXPOSED 比 CALM 更爱开火，注也更大', () => {
  const sample = (state, n = 300, equity = 0.3) => {
    const rng = rngOf(31);
    let bets = 0; let sizeSum = 0; let raises = 0;
    for (let i = 0; i < n; i++) {
      const d = decide(decideCtx({ equity, mods: balance.emotions[state], rng }));
      if (d.action === 'bet' || d.action === 'raise') { bets += 1; sizeSum += d.amount ?? 0; }
      if (d.action === 'raise') raises += 1;
    }
    return { betRate: bets / n, avgSize: sizeSum / Math.max(1, bets), raiseRate: raises / n };
  };
  const calm = sample('CALM');
  const tilt = sample('EXPOSED');
  assert.ok(tilt.betRate > calm.betRate + 0.1, `TILT 开火应更频繁：CALM=${calm.betRate.toFixed(2)} TILT=${tilt.betRate.toFixed(2)}`);
  assert.ok(tilt.avgSize > calm.avgSize * 1.1, `TILT 注应更大：CALM=${calm.avgSize.toFixed(0)} TILT=${tilt.avgSize.toFixed(0)}`);
});

test('决策稳定性：强牌几乎不弃、烂牌价格差必弃、全下抗性随风险上调', () => {
  const strong = decide(decideCtx({ equity: 0.8, toCall: 60, rng: rngOf(61) }));
  assert.notEqual(strong.action, 'fold');
  let folds = 0;
  for (let i = 0; i < 100; i++) {
    const d = decide(decideCtx({ equity: 0.15, toCall: 60, potBefore: 100, rng: rngOf(61 + i) }));
    if (d.action === 'fold') folds += 1;
  }
  assert.ok(folds > 70, `烂牌应以弃为主（${folds}/100）`);

  // COUNTER 增益（assembleMods extra）确实抬高攻击性
  const counterMods = assembleMods(balance, 'CALM', { extra: balance.counter });
  const baseMods = assembleMods(balance, 'CALM', {});
  assert.ok(counterMods.aggression > baseMods.aggression, 'COUNTER 增益进 mods');
  const ev = evaluateWeights({ equity: 0.5, potBefore: 100, toCall: 50, sizing: balance.sizing });
  applyPersonality(ev, balance.personality, null, 0.5);
  const before = ev.w.raiseValue;
  applyEmotion(ev, counterMods);
  assert.ok(ev.w.raiseValue > before, 'COUNTER 阶段加注权重更高');
});

test('蒙特卡洛胜率方向正确', () => {
  const aa = monteCarloEquity(['As', 'Ad'], [], rngOf(7), 300);
  const r72 = monteCarloEquity(['7s', '2c'], [], rngOf(7), 300);
  assert.ok(aa > 0.75 && aa < 0.95, `AA ≈0.85，实际 ${aa}`);
  assert.ok(r72 > 0.25 && r72 < 0.5, `72o 明显偏低，实际 ${r72}`);
  assert.ok(aa > r72 + 0.3);
});

test('翻前 BB 溢价加注尺度合理（2.6bb ± 抖动）', () => {
  let opens = 0;
  for (let i = 0; i < 60; i++) {
    const d = decide(decideCtx({
      equity: 0.8, toCall: 0, street: 'preflop', potBefore: 30, myCommitted: 20,
      legal: [{ type: 'raise', minTo: 40, maxTo: 1000 }, { type: 'allin', to: 1000 }],
      mods: balance.emotions.CALM, rng: rngOf(71 + i),
    }));
    if (d.action === 'raise') {
      opens += 1;
      assert.ok(d.amount >= 40 && d.amount <= 120, `BB 溢价加注应在 40–120，实际 ${d.amount}`);
    }
  }
  assert.ok(opens > 40, '强牌在 BB 溢价位应当常加注');
});

// ============================================================ 台词与赢牌

test('台词池：三状态 × 五意图 + any 齐全，选词返回非空', () => {
  for (const state of STATES) {
    assert.ok(TALK[state], `${state} 缺台词池`);
    for (const intent of ['VALUE', 'BLUFF', 'PROBE', 'TRAP', 'CONTROL']) {
      assert.ok(TALK[state][intent]?.length > 0, `${state} 缺 ${intent}`);
    }
    assert.ok(TALK[state].any.length > 0);
    const line = pickLine({ state, intent: 'BLUFF', rng: rngOf(3) });
    assert.ok(typeof line === 'string' && line.length > 0);
  }
  for (const s of STATES) assert.ok(WIN_QUIP[s]?.length > 0, `${s} 缺赢牌台词`);
  assert.equal(pickWinQuip('CALM', 0, rngOf(1)), null, '概率 0 不说话');
  assert.ok(pickWinQuip('CALM', 1, rngOf(1))?.length > 0, '概率 1 必说话');
});

// ============================================================ Player Model

test('Player Model：习惯识别、弃率估计、把握度与 BUSTED 门槛', () => {
  const m = new PlayerModel();
  assert.equal(m.confidence(), 0);
  assert.equal(m.bustedReady(0.7), false);

  // READ → HEAVY 习惯（§26 针对性）
  for (let i = 0; i < 3; i++) {
    m.record('read');
    m.record('action', { action: 'heavy', facingBet: true });
    m.record('action', { action: 'pressure', facingBet: true });
    m.record('pressure');
    m.record('action', { action: 'heavy' });
  }
  assert.equal(m.adaptation().noFoldVsHeavy, true, '识别 READ→HEAVY 习惯');
  assert.equal(m.adaptation().trapSuspect, true, '识别 压力→重注 习惯');

  // 弃率估计在 [0,1]，样本越多越可信
  for (let i = 0; i < 12; i++) m.record('action', { action: 'fold', facingBet: true });
  const fold = m.estFoldVsBet();
  assert.ok(fold > 0.5, `爱弃的玩家估计弃率应偏高（${fold.toFixed(2)}）`);
  assert.ok(m.confidence() >= 0.7, '20+ 决策后把握度过门槛');
  assert.equal(m.bustedReady(0.7), true);

  m.record('gotcha', { correct: false });
  assert.equal(m.s.gotchaWrong, 1);
  m.record('showdown', { playerWon: true, playerAggressive: true });
  assert.equal(m.s.wonShowdown, 1);
});
