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
import { EvidenceTracker } from '../server/boss/crack.js';
import { PlayerModel } from '../server/boss/playermodel.js';
import { loadBalance } from '../server/battle.js';
import { seededRng } from '../server/engine/cards.js';

const rngOf = (seed) => {
  const r = seededRng(seed);
  return () => r.next();
};

const balance = loadBalance();

// ============================================================ 情绪（v3 三状态）

test('情绪转移表结构合法：三状态、单向恶化、无自环、关键边齐全', () => {
  assert.deepEqual(STATES, ['CALM', 'SHAKEN', 'TILT']);
  for (const [event, row] of Object.entries(balance.transitions)) {
    if (event === 'comment') continue;
    assert.ok(event in EVENT_NAMES, `${event} 要有中文名`);
    for (const [from, [to, chance]] of Object.entries(row)) {
      assert.ok(STATES.includes(from), `${event} 起点 ${from} 合法`);
      assert.ok(STATES.includes(to), `${event} 终点 ${to} 合法`);
      assert.ok(ORDER[to] > ORDER[from], `${event}: ${from} → ${to} 必须单向恶化`);
      assert.ok(chance >= 0 && chance <= 1, `${event}/${from} 概率 0..1`);
    }
  }
  const T = balance.transitions;
  assert.deepEqual(T.BLUFF_CAUGHT.CALM, ['SHAKEN', 1]);
  assert.deepEqual(T.GOTCHA_HIT.CALM, ['SHAKEN', 1], 'GOTCHA 命中必推动摇');
  assert.deepEqual(T.GOTCHA_STREAK.SHAKEN, ['TILT', 1], '连续正确 GOTCHA 必上头');
  assert.deepEqual(T.ALL_IN_LOST.SHAKEN, ['TILT', 1]);
});

test('Emotion：概率 1 必发、0 必不发、终态无边则不动', () => {
  const always = new Emotion({ transitions: { X: { CALM: ['SHAKEN', 1] } }, rng: () => 0.99 });
  assert.deepEqual(always.attempt('X'), { from: 'CALM', to: 'SHAKEN', cause: 'X' });
  assert.equal(always.state, 'SHAKEN');

  const never = new Emotion({ transitions: { X: { CALM: ['SHAKEN', 0] } }, rng: () => 0 });
  assert.equal(never.attempt('X'), null);

  // TILT 是终点：任何打击在 TILT 都无边可走
  const atTilt = new Emotion({ transitions: balance.transitions, rng: () => 0 });
  atTilt.state = 'TILT';
  assert.equal(atTilt.attempt('BLUFF_CAUGHT'), null);
  assert.equal(atTilt.state, 'TILT');
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

test('碎片按情绪取比例：CALM 噪音多，TILT 真话与错觉密集', () => {
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
  const tilt = count('TILT');
  assert.ok(calm.NOISE > calm.TRUE, `CALM 噪音应多于真话（${calm.NOISE} vs ${calm.TRUE}）`);
  assert.ok(tilt.TRUE > calm.TRUE * 1.5, `TILT 真话应显著多于 CALM（${tilt.TRUE} vs ${calm.TRUE}）`);
  assert.ok(tilt.TRUE + tilt.DISTORTION > (calm.TRUE + calm.DISTORTION) * 1.3, 'TILT 信息更密集');
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
      assert.equal(f.critical, false, '非 TRUE 不可能 Critical');
    }
    assert.ok(typeof f.text === 'string' && f.text.length > 0);
  }
});

test('TRUE 碎片由 Boss 真实处境决定：BLUFF 意图漏弱点，VALUE 意图漏强牌', () => {
  const r = seededRng(13);
  const weakTags = new Set(['wants_fold', 'fear_call', 'weak_hand', 'missed_board', 'draw']);
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

test('Critical：单条高强度真话，EXECUTION 显示更快', () => {
  let criticals = 0;
  const r = seededRng(17);
  for (let i = 0; i < 400; i++) {
    const f = makeFragment(fragCtx({ state: 'TILT', intent: 'BLUFF', execution: true, rng: () => r.next() }));
    if (f.critical) {
      criticals += 1;
      assert.equal(f.type, 'TRUE');
      assert.ok(f.strength >= balance.read.criticalStrength, 'Critical 必须是高强度');
    }
  }
  assert.ok(criticals > 0, 'TILT 高强度池里应当能出 Critical');

  assert.equal(flashMs('TILT', balance, false), balance.read.flashMs.TILT);
  assert.equal(flashMs('TILT', balance, true), Math.round(balance.read.flashMs.TILT * balance.read.executionFlashScale));
  assert.ok(NOISE_POOL.length > 0 && Object.keys(DISTORTION_POOL).length === 3);
});

// ============================================================ CRACK 证据链

test('CRACK：两枚相关标签成链，链成即清空，Critical 单条直爆', () => {
  const tracker = new EvidenceTracker(balance.cracks);
  assert.equal(tracker.add({ type: 'NOISE', tags: [], strength: 0, critical: false }, 1), null);

  const t1 = tracker.add({ type: 'TRUE', tags: ['wants_fold'], strength: 0.7, critical: false }, 1);
  assert.equal(t1, null, '一枚标签还不够');
  const t2 = tracker.add({ type: 'TRUE', tags: ['weak_hand'], strength: 0.6, critical: false }, 1);
  assert.ok(t2, '两枚相关标签 → CRACK');
  assert.equal(t2.kind, 'WEAKNESS');
  assert.deepEqual(t2.evidence.sort(), ['wants_fold', 'weak_hand']);
  assert.deepEqual(tracker.snapshot(), [], '链条兑现后清空');

  // 强牌链
  const tracker2 = new EvidenceTracker(balance.cracks);
  tracker2.add({ type: 'TRUE', tags: ['strong_hand'], strength: 0.7, critical: false }, 2);
  const s = tracker2.add({ type: 'TRUE', tags: ['trap'], strength: 0.8, critical: false }, 2);
  assert.equal(s.kind, 'STRENGTH');

  // Critical Tell：单条直接成链
  const tracker3 = new EvidenceTracker(balance.cracks);
  const c = tracker3.add({ type: 'TRUE', tags: ['wants_fold'], strength: 0.9, critical: true }, 3);
  assert.ok(c);
  assert.equal(c.kind, 'CRITICAL');
  assert.equal(c.critical, true);
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

test('Layer3 情绪：TILT 比 CALM 更凶、更敢接、方差更大', () => {
  const mk = (state) => {
    const ev = evaluateWeights({ equity: 0.45, potBefore: 100, toCall: 50, sizing: balance.sizing });
    applyPersonality(ev, balance.personality, null, 0.5);
    applyEmotion(ev, balance.emotions[state]);
    return ev;
  };
  const calm = mk('CALM');
  const tilt = mk('TILT');
  assert.ok(tilt.w.fold < calm.w.fold, 'TILT 更少弃');
  assert.ok(tilt.w.call > calm.w.call, 'TILT 更敢接');
  assert.ok(tilt.w.raiseValue > calm.w.raiseValue, 'TILT 更敢加');
  assert.ok(tilt.p.variance > calm.p.variance, 'TILT 方差更大');
  assert.ok(tilt.p.bluffFrequency > calm.p.bluffFrequency, 'TILT 诈唬更多');
});

test('采样统计：TILT 比 CALM 更爱开火，注也更大', () => {
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
  const tilt = sample('TILT');
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
