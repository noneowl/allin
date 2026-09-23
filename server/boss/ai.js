/**
 * Boss 决策：三层管线（方案 §8-10）。
 *
 *   Layer 1  Poker Evaluation   理性评估：equity / 牌面 / 底池赔率 / Pot / Effective Stack /
 *                              Position / Street / 玩家历史 → 中性权重 + 机会标记
 *   Layer 2  Personality        DECEIVER 偏移 + Player Model 适应（估计弃率、针对性）
 *   Layer 3  Current Emotion    CALM/SHAKEN/TILT 修正 + 决策方差（COUNTER 等高压增益也从这进）
 *   Finalize                    采样 + 定尺度 + 产出 { action, amount, intent }
 *
 * intent ∈ VALUE | BLUFF | PROBE | TRAP | CONTROL —— 内部剧本信息，绝不下发。
 */
import { evaluate } from '../engine/evaluator.js';
import { makeDeck } from '../engine/cards.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** 中性（无人格无情绪）参数：Layer 1 的评估基准。 */
const NEUTRAL = {
  aggression: 0.5,
  bluffFrequency: 0.15,
  raiseFrequency: 0.3,
  foldThreshold: 0.32,
  callThreshold: 0.5,
  betSize: 0.6,
  trapChance: 0.1,
  risk: 0,
  variance: 0.15,
};

/**
 * 蒙特卡洛胜率：对随机对手底牌 + 补完公共牌。
 * @returns {number} 0..1（平局计 0.5）
 */
export function monteCarloEquity(hole, board, rng = Math.random, samples = 160) {
  const dead = new Set([...hole, ...board]);
  const rest = makeDeck().filter((c) => !dead.has(c));
  const need = 5 - board.length;
  let score = 0;
  for (let i = 0; i < samples; i++) {
    const pool = rest.slice();
    const draw = () => pool.splice(Math.floor(rng() * pool.length), 1)[0];
    const o1 = draw();
    const o2 = draw();
    const extra = [];
    for (let k = 0; k < need; k++) extra.push(draw());
    const fullBoard = board.length === 5 ? board : [...board, ...extra];
    const mine = evaluate([...hole, ...fullBoard]).score;
    const theirs = evaluate([o1, o2, ...fullBoard]).score;
    score += mine > theirs ? 1 : mine === theirs ? 0.5 : 0;
  }
  return score / samples;
}

// ============================================================ Layer 1

/**
 * 理性评估：中性参数下的权重、机会标记与价格信息。
 * 输入含 Pot / Effective Stack 相关量（potBefore、toCall、equity 由调用方算好）。
 */
export function evaluateWeights({ equity: eq, potBefore, toCall, sizing }, out = {}) {
  const potOdds = toCall > 0 ? toCall / Math.max(1, potBefore + toCall) : 0;
  const valueOpp = eq >= sizing.valueLine;
  const bluffOpp = eq <= sizing.bluffLine;

  // 中性权重（NEUTRAL 参数）
  let fold = eq < NEUTRAL.foldThreshold ? (NEUTRAL.foldThreshold - eq + 0.12) * 2.2 : 0.05;
  if (eq < potOdds - 0.08) fold += 0.9;
  else if (eq < potOdds) fold += 0.3;

  const priceOk = eq + 0.04 >= potOdds;
  let call = eq >= NEUTRAL.callThreshold || priceOk ? 0.4 + eq * 1.6 : 0.1;
  if (eq >= NEUTRAL.callThreshold && priceOk) call += 0.6;

  const raiseValue = valueOpp ? NEUTRAL.aggression * (0.9 + eq) + NEUTRAL.raiseFrequency * 0.3 : 0.02;

  out.potOdds = potOdds;
  out.valueOpp = valueOpp;
  out.bluffOpp = bluffOpp;
  out.w = { fold, call, raiseValue };
  out.p = { ...NEUTRAL, betSize: sizing.betSize ?? NEUTRAL.betSize };
  return out;
}

// ============================================================ Layer 2

/**
 * 人格偏移：DECEIVER 修改中性权重；同时叠入 Player Model 的估计与适应。
 */
export function applyPersonality(ev, personality, model, facingFrac = 0) {
  const p = ev.p;
  const w = ev.w;
  if (!personality) return ev;

  // p 直接落到人格参数（NEUTRAL + 人格差值 = 人格值）
  p.aggression += personality.aggression - NEUTRAL.aggression;
  p.bluffFrequency += personality.bluffFrequency - NEUTRAL.bluffFrequency;
  p.raiseFrequency += personality.raiseFrequency - NEUTRAL.raiseFrequency;
  p.foldThreshold += personality.foldThreshold - NEUTRAL.foldThreshold;
  p.callThreshold += personality.callThreshold - NEUTRAL.callThreshold;
  p.betSize += personality.normalBetSize - NEUTRAL.betSize;
  p.trapChance += personality.trapChance - NEUTRAL.trapChance;

  // 人格对中性权重的偏移（§10 示例：Raise 被抬高、Fold 被压低）
  w.fold *= clamp(1 + (personality.foldThreshold - NEUTRAL.foldThreshold) * 4, 0.4, 1.6);
  w.call *= clamp(1 + (personality.callThreshold - NEUTRAL.callThreshold) * 3, 0.5, 1.5);
  w.raiseValue *= clamp(1 + (personality.aggression - NEUTRAL.aggression) * 1.6, 0.5, 2);

  if (model) {
    const adapt = model.adaptation();
    // 玩家爱弃 → 诈唬更有利可图；玩家爱跟 → 别浪费筹码去演
    const foldTendency = model.estFoldVsBet();
    w.bluff = ev.bluffOpp ? personality.bluffFrequency * (0.5 + foldTendency) * (0.5 + personality.aggression) : 0;
    if (w.bluff > 0 && personality.aggression < 0.55) w.bluff *= 0.7;

    // 适应：玩家 READ 后爱开大 → 面对高压不再轻易弃牌（§26）
    if (adapt.noFoldVsHeavy && facingFrac >= 0.9) w.fold *= 0.45;
    // 适应：玩家的小注+重注组合像陷阱 → 面对压力少加注、多观望
    if (adapt.trapSuspect) w.raiseValue *= 0.8;
  } else {
    w.bluff = ev.bluffOpp ? personality.bluffFrequency * (0.5 + personality.aggression) : 0;
  }
  return ev;
}

// ============================================================ Layer 3

/**
 * 情绪修正：CALM/SHAKEN/TILT 的差值；COUNTER 等高压增益已由上层并入 mods。
 */
export function applyEmotion(ev, mods) {
  if (!mods) return ev;
  const p = ev.p;
  const w = ev.w;

  p.aggression += mods.aggression ?? 0;
  p.bluffFrequency += mods.bluff ?? 0;
  p.raiseFrequency += mods.raiseFreq ?? 0;
  p.foldThreshold += mods.foldThreshold ?? 0;
  p.callThreshold += mods.callThreshold ?? 0;
  p.betSize += mods.betSize ?? 0;
  p.risk += mods.risk ?? 0;
  p.variance += mods.variance ?? 0;
  p.trapChance += mods.trapChance ?? 0;
  p.bluffFrequency = clamp(p.bluffFrequency, 0, 0.9);
  p.aggression = clamp(p.aggression, 0, 0.95);

  w.fold *= clamp(1 + (mods.foldThreshold ?? 0) * 4, 0.3, 2);     // 阈值降 → 更少弃
  w.call *= clamp(1 - (mods.callThreshold ?? 0) * 3, 0.3, 2);      // 阈值降 → 更敢接
  w.raiseValue *= clamp(1 + (mods.aggression ?? 0) * 1.6, 0.5, 2.4);
  if (w.bluff) w.bluff *= clamp(1 + (mods.bluff ?? 0) * 1.5, 0.5, 3);
  return ev;
}

// ============================================================ Finalize

/**
 * 决策入口：L1 → L2 → L3 → 采样与定尺度。
 * @param {object} ctx
 *  必填：legal, potBefore, toCall, myCommitted, street, bigBlind, sizing,
 *        personality, mods（情绪+COUNTER 增益），rng
 *  可选：hole/board/equity（不给则蒙卡）、model（PlayerModel）、playerAllIn、myStack
 * @returns {{ action, amount?, intent, equity }}
 */
export function decide(ctx) {
  const {
    legal, potBefore, toCall, myCommitted, street, bigBlind,
    playerAllIn = false, personality, mods, sizing, model = null,
    rng = Math.random,
  } = ctx;

  const equity = ctx.equity ?? monteCarloEquity(ctx.hole, ctx.board, rng);
  const facingFrac = potBefore > 0 ? toCall / Math.max(1, potBefore) : 0;

  // ---- Layer 1：理性评估 ----
  const ev = evaluateWeights({ equity, potBefore, toCall, sizing });
  // ---- Layer 2：人格 + 玩家模型 ----
  applyPersonality(ev, personality, model, toCall > 0 ? Math.max(facingFrac, (toCall * 2) / Math.max(1, potBefore)) : 0);
  // ---- Layer 3：情绪（含 COUNTER 高压增益）----
  applyEmotion(ev, mods);
  const p = ev.p;
  const w = ev.w;

  const byType = new Map(legal.map((a) => [a.type, a]));
  const canFold = byType.has('fold');
  const canCheck = byType.has('check');
  const callOpt = byType.get('call');
  const betOpt = byType.get('bet');
  const raiseOpt = byType.get('raise');
  const allinOpt = byType.get('allin');
  const canRaise = Boolean(raiseOpt);

  const jitter = 1 + (rng() * 2 - 1) * sizing.sizeJitter * (0.6 + p.variance);
  const eq = equity;

  // ------------------------------------------------- 面临下注
  if (toCall > 0) {
    const potOdds = ev.potOdds;

    // 全下对抗（对方全下 / 跟注即全下）：只判接不接
    const callingAllIn = playerAllIn
      || (callOpt && ctx.myStack !== undefined && callOpt.amount >= ctx.myStack && !canRaise);
    if (callingAllIn && canFold) {
      const threshold = clamp(potOdds - 0.04 - p.risk * 0.12 - p.aggression * 0.05, 0, 0.95);
      let accept = eq >= threshold;
      if (rng() < p.variance * 0.3) accept = !accept;
      if (accept) {
        return {
          action: 'call',
          intent: eq >= sizing.valueLine ? 'VALUE' : eq >= p.callThreshold ? 'CONTROL' : 'PROBE',
          equity: eq,
        };
      }
      return { action: 'fold', intent: 'CONTROL', equity: eq };
    }

    // 方差搅动（TILT/COUNTER 的失控感）
    if (rng() < p.variance * 0.4) {
      w.fold += 0.5;
      w.call += 0.5;
      if (canRaise) { w.raiseValue += 0.5; w.bluff = (w.bluff ?? 0) + 0.3; }
    }

    const choices = [];
    if (canFold) choices.push(['fold', Math.max(0, w.fold)]);
    if (callOpt) choices.push(['call', Math.max(0, w.call)]);
    if (canRaise) {
      let raiseW = Math.max(0, w.raiseValue);
      // 诈唬加注：按最终 bluff 频率做抽样级 roll（保留人格/情绪的方差感）
      if (w.bluff && rng() < p.bluffFrequency) raiseW += Math.max(0, w.bluff) * 2.2;
      choices.push(['raise', raiseW]);
    }
    const pick = weighted(choices, rng);

    if (pick === 'raise') {
      const afterCallPot = potBefore + toCall * 2;
      const target = myCommitted + toCall + afterCallPot * p.betSize * jitter;
      const amount = Math.round(clamp(target, raiseOpt.minTo, raiseOpt.maxTo));
      const intent = eq >= sizing.valueLine ? 'VALUE' : 'BLUFF';
      return { action: 'raise', amount, intent, equity: eq };
    }
    if (pick === 'call') {
      const intent = eq >= sizing.trapLine ? 'TRAP' : eq >= p.callThreshold ? 'CONTROL' : 'PROBE';
      return { action: 'call', intent, equity: eq };
    }
    return { action: 'fold', intent: 'CONTROL', equity: eq };
  }

  // ------------------------------------------------- 自主行动（过牌或下注）

  // 慢打
  if (eq >= sizing.trapLine && rng() < p.trapChance && canCheck) {
    return { action: 'check', intent: 'TRAP', equity: eq };
  }

  // 开火概率（人格 + 情绪的最终参数）
  let betProb;
  if (eq >= sizing.valueLine) betProb = clamp(p.aggression * 1.25 + p.raiseFrequency * 0.3, 0, 0.95);
  else if (eq <= sizing.bluffLine) betProb = clamp(p.bluffFrequency * (0.85 + p.aggression * 0.6), 0, 0.9);
  else betProb = clamp(p.aggression * 0.55, 0, 0.85);

  let wantBet = rng() < betProb;
  if (rng() < p.variance * 0.3) wantBet = !wantBet;

  const aggressiveOption = Boolean(betOpt) || canRaise;
  const shoveRoll = p.risk > 0.35 && rng() < (p.risk - 0.35) * 0.5; // 高风险容忍 → 推土机

  if ((wantBet || shoveRoll) && aggressiveOption) {
    const opt = betOpt ?? raiseOpt;
    let intent;
    let target;

    if (shoveRoll && allinOpt && allinOpt.to > (opt.minTo ?? 0)) {
      intent = eq >= sizing.valueLine ? 'VALUE' : 'BLUFF';
      target = allinOpt.to;
    } else if (street === 'preflop' && canRaise && !betOpt) {
      const openBb = sizing.preflopOpenBb * (1 + (p.betSize - NEUTRAL.betSize) * 0.5) * jitter;
      intent = eq >= sizing.valueLine ? 'VALUE' : 'BLUFF';
      target = Math.max(opt.minTo, Math.round(bigBlind * openBb));
    } else {
      let size = potBefore * p.betSize * jitter;
      if (eq <= sizing.bluffLine && rng() < 0.3 + p.risk * 0.35) {
        size *= 1.3 + p.risk * 0.5; // 演凶一点
      }
      intent = eq >= sizing.valueLine ? 'VALUE' : eq <= sizing.bluffLine ? 'BLUFF' : null;
      if (!intent || (eq > sizing.bluffLine && eq < sizing.valueLine)) {
        const frac = size / Math.max(1, potBefore);
        intent = frac < 0.45 ? 'PROBE' : 'CONTROL';
        if (frac < 0.45) size = Math.max(size, potBefore * sizing.probeRatio);
      }
      target = myCommitted + size;
    }

    const amount = Math.round(clamp(target, opt.minTo, opt.maxTo));
    const action = betOpt ? 'bet' : 'raise';
    return { action, amount, intent, equity: eq };
  }

  // 过牌
  if (canCheck) {
    const intent = eq >= sizing.trapLine || eq >= sizing.valueLine ? 'TRAP'
      : eq >= p.callThreshold ? 'CONTROL'
      : 'PROBE';
    return { action: 'check', intent, equity: eq };
  }

  // 盲注差额：只能跟或弃
  if (callOpt) {
    const potOdds = ev.potOdds;
    const wCall = (eq >= p.callThreshold || eq + 0.04 >= potOdds) ? 2 : 0.4;
    const wFold = canFold ? (eq < p.foldThreshold ? 1.5 : 0.3) : 0;
    if (canFold && wFold > wCall * rng()) {
      return { action: 'fold', intent: 'CONTROL', equity: eq };
    }
    return { action: 'call', intent: eq >= sizing.trapLine ? 'TRAP' : 'CONTROL', equity: eq };
  }
  if (allinOpt) return { action: 'allin', intent: eq >= sizing.valueLine ? 'VALUE' : 'BLUFF', equity: eq };
  return { action: 'check', intent: 'CONTROL', equity: eq };
}

function weighted(entries, rng) {
  const total = entries.reduce((s, [, w]) => s + Math.max(0, w), 0);
  if (total <= 0) return entries[0][0];
  let roll = rng() * total;
  for (const [key, w] of entries) {
    roll -= Math.max(0, w);
    if (roll <= 0) return key;
  }
  return entries[entries.length - 1][0];
}

// ============================================================ 修正汇总

/**
 * 情绪差值 +（COUNTER/BUSTED 等高压增益）→ 交给 applyEmotion 的 mods。
 * 结构与 balance.json `emotions[state]` 同形，额外并入 `extra`（高压阶段增益）。
 */
export function assembleMods(balance, state, { extra = null } = {}) {
  const base = balance.emotions?.[state] ?? balance.emotions?.CALM ?? {};
  const mods = { ...base };
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (k === 'hint' || k === 'comment') continue;
      mods[k] = (mods[k] ?? 0) + v;
    }
  }
  return mods;
}
