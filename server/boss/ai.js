/**
 * Boss 决策：Hand Strength + 随机权重 + Personality + Mental State Modifier。
 *
 * 纯函数，所有随机走注入的 rng，所有可调数值来自 balance.json ——
 * 测试可以固定 equity 与 rng，直接统计「挑衅后 Raise 是否真的变多」。
 */
import { evaluate } from '../engine/evaluator.js';
import { makeDeck } from '../engine/cards.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

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

/**
 * 汇总当前生效的修正：心理状态 + 言语 Buff + 异议命中后的本手偏移。
 * @returns {object} mods
 */
export function assembleMods(balance, state, { buffs = [], exposed = false } = {}) {
  const base = balance.mentalModifiers[state] ?? balance.mentalModifiers.CALM;
  const mods = { ...base, callMul: 1, foldMul: 1 };

  if (exposed) {
    // 被异议命中后，本手行为进一步偏移：更凶、注更大、更爱演
    mods.aggression += 0.15;
    mods.betSize += 0.15;
    mods.bluff += 0.1;
  }

  const fx = balance.speechEffects ?? {};
  for (const buff of buffs) {
    if (buff.skill === 'shame') {
      // 「害怕被认为胆小」：被逼弃牌之后，接下来几次决策更凶
      mods.aggression += 0.12;
      mods.betSize += 0.1;
      mods.bluff += 0.05;
      continue;
    }
    const effect = fx[buff.skill];
    if (!effect) continue;
    const scale = effect.stateScale?.[state] ?? 1;
    if (buff.skill === 'taunt') {
      mods.aggression += (effect.aggression ?? 0) * scale;
      mods.raiseFreq += (effect.raiseFreq ?? 0) * scale;
      mods.bluff += (effect.bluff ?? 0) * scale;
      mods.betSize += (effect.betSize ?? 0) * scale;
      mods.risk += (effect.risk ?? 0) * scale;
    } else if (buff.skill === 'pressure') {
      mods.callMul *= clamp(1 + (effect.callWeight ?? 0) * scale, 0.05, 3);
      mods.foldMul *= clamp(1 + (effect.foldWeight ?? 0) * scale, 0.05, 5);
      mods.aggression += (effect.aggression ?? 0) * scale; // 施压让他也不太敢再加注
    }
  }
  return mods;
}

/** BREAKING：同一状态内部也高度不稳定，每次决策抽一种失控模式。 */
export function rollBreakingMode(balance, rng = Math.random) {
  const modes = balance.breakingModes;
  if (!modes) return {};
  const entries = Object.entries(modes);
  const total = entries.reduce((s, [, m]) => s + (m.weight ?? 0), 0);
  let roll = rng() * (total || 1);
  for (const [, mode] of entries) {
    roll -= mode.weight ?? 0;
    if (roll <= 0) return mode;
  }
  return entries[entries.length - 1][1] ?? {};
}

/**
 * Boss 的一次决策。
 *
 * @param {object} ctx
 * @param {object[]} ctx.legal           引擎给出的合法动作
 * @param {number} ctx.potBefore         行动前底池
 * @param {number} ctx.toCall            还需要跟多少
 * @param {number} ctx.myCommitted       本街已投入
 * @param {string} ctx.street
 * @param {number} ctx.bigBlind
 * @param {boolean} ctx.playerAllIn      玩家刚全下
 * @param {object} ctx.personality       基线
 * @param {object} ctx.mods              汇总修正（assembleMods 产出，可含 BREAKING 模式）
 * @param {object} ctx.sizing            尺寸相关配置
 * @param {() => number} ctx.rng
 * @param {number} [ctx.equity]          测试可直接注入胜率
 * @returns {{ action: string, amount?: number, intent: string, equity: number }}
 */
export function decide(ctx) {
  const {
    legal, potBefore, toCall, myCommitted, street, bigBlind,
    playerAllIn = false, personality, mods, sizing, rng = Math.random,
  } = ctx;

  const eq = ctx.equity ?? monteCarloEquity(ctx.hole, ctx.board, rng);

  const p = {
    aggression: clamp(personality.aggression + (mods.aggression ?? 0), 0, 0.98),
    bluffFreq: clamp(personality.bluffFrequency + (mods.bluff ?? 0), 0, 0.95),
    raiseFreq: clamp(personality.raiseFrequency + (mods.raiseFreq ?? 0), 0, 0.95),
    betSize: clamp(personality.normalBetSize * (1 + (mods.betSize ?? 0)), 0.15, sizing.overbetCeiling),
    foldTh: clamp(personality.foldThreshold + (mods.foldThreshold ?? 0), 0.03, 0.85),
    callTh: clamp(personality.callThreshold + (mods.callThreshold ?? 0), 0.05, 0.9),
    risk: clamp(mods.risk ?? 0, 0, 1),
    variance: clamp(mods.variance ?? 0.1, 0, 1),
    callMul: clamp(mods.callMul ?? 1, 0.05, 3),
    foldMul: clamp(mods.foldMul ?? 1, 0.05, 5),
    trapChance: clamp(mods.trapChance ?? 0.1, 0, 0.9),
    valueLine: sizing.valueLine,
    bluffLine: sizing.bluffLine,
    trapLine: sizing.trapLine,
    sizeJitter: sizing.sizeJitter,
    probeRatio: sizing.probeRatio,
    overbetCeiling: sizing.overbetCeiling,
  };

  const byType = new Map(legal.map((a) => [a.type, a]));
  const canFold = byType.has('fold');
  const canCheck = byType.has('check');
  const callOpt = byType.get('call');
  const betOpt = byType.get('bet');
  const raiseOpt = byType.get('raise');
  const allinOpt = byType.get('allin');
  const canRaise = Boolean(raiseOpt);
  const canBet = Boolean(betOpt);

  const jitter = 1 + (rng() * 2 - 1) * p.sizeJitter * (0.6 + p.variance);

  // ---------------------------------------------------------- 面临下注
  if (toCall > 0) {
    const potOdds = toCall / Math.max(1, potBefore + toCall);

    // 对方全下（或我方跟注即全下）：只判「接不接」，这是 TILT 最容易犯错的地方
    const callingAllIn = playerAllIn || (callOpt && ctx.myStack !== undefined && callOpt.amount >= ctx.myStack && !canRaise);
    if (callingAllIn && canFold) {
      const threshold = clamp(potOdds - 0.04 - p.risk * 0.12 - p.aggression * 0.05, 0, 0.95);
      let accept = eq >= threshold;
      if (rng() < p.variance * 0.3) accept = !accept;
      if (accept) {
        return { action: 'call', intent: eq >= p.valueLine ? 'VALUE' : eq >= p.callTh ? 'POT_CONTROL' : 'PROBE', equity: eq };
      }
      return { action: 'fold', intent: 'POT_CONTROL', equity: eq };
    }

    // 常规权重
    let wFold = 0.001;
    let wCall = 0.001;
    let wRaise = canRaise ? 0.001 : 0;

    wFold += eq < p.foldTh ? (p.foldTh - eq + 0.12) * 2.2 : 0.05;
    if (eq < potOdds - 0.08) wFold += 0.9;
    else if (eq < potOdds) wFold += 0.3;
    wFold *= p.foldMul;

    const priceOk = eq + 0.04 >= potOdds;
    wCall += (eq >= p.callTh || priceOk) ? 0.4 + eq * 1.6 : 0.1;
    if (eq >= p.callTh && priceOk) wCall += 0.6;
    wCall *= p.callMul;

    if (canRaise) {
      if (eq >= p.valueLine) {
        wRaise = p.aggression * (0.9 + eq) + p.raiseFreq * 0.3;
      } else if (rng() < p.bluffFreq) {
        // 演的：用加注打退对手
        wRaise = p.aggression * (0.55 + p.raiseFreq);
      } else {
        wRaise = 0.02;
      }
      wRaise *= 1 + (mods.raiseFreq ?? 0);
    }

    // 高方差：把权重往均匀里搅（BREAKING 的失控感）
    if (rng() < p.variance * 0.4) {
      wFold += 0.5;
      wCall += 0.5;
      if (canRaise) wRaise += 0.5;
    }

    const choices = [];
    if (canFold) choices.push(['fold', wFold]);
    if (callOpt) choices.push(['call', wCall]);
    if (canRaise) choices.push(['raise', wRaise]);
    const pick = weighted(choices, rng);

    if (pick === 'raise') {
      const afterCallPot = potBefore + toCall * 2;
      const target = myCommitted + toCall + afterCallPot * p.betSize * jitter;
      const amount = Math.round(clamp(target, raiseOpt.minTo, raiseOpt.maxTo));
      const intent = eq >= p.valueLine ? 'VALUE' : 'BLUFF';
      return { action: 'raise', amount, intent, equity: eq };
    }
    if (pick === 'call') {
      const intent = eq >= p.trapLine ? 'TRAP' : eq >= p.callTh ? 'POT_CONTROL' : 'PROBE';
      return { action: 'call', intent, equity: eq };
    }
    return { action: 'fold', intent: 'POT_CONTROL', equity: eq };
  }

  // ------------------------------------------------------------ 自主行动

  // 慢打：牌力强但偶尔想钓一杆
  if (eq >= p.trapLine && rng() < p.trapChance) {
    if (canCheck) return { action: 'check', intent: 'TRAP', equity: eq };
  }

  // 要不要开火
  let betProb;
  if (eq >= p.valueLine) betProb = clamp(p.aggression * 1.25 + p.raiseFreq * 0.3, 0, 0.95);
  else if (eq <= p.bluffLine) betProb = clamp(p.bluffFreq * (0.85 + p.aggression * 0.6), 0, 0.9);
  else betProb = clamp(p.aggression * 0.55, 0, 0.85);

  let wantBet = rng() < betProb;
  if (rng() < p.variance * 0.3) wantBet = !wantBet; // 失控翻转

  const aggressiveOption = canBet || canRaise;
  // 高风险容忍时的推土机：要么不开，开了就可能直接全下
  const shoveRoll = p.risk > 0.35 && rng() < (p.risk - 0.35) * 0.5;

  if ((wantBet || shoveRoll) && aggressiveOption) {
    const opt = canBet ? betOpt : raiseOpt;
    let intent;
    let target;

    if (shoveRoll && allinOpt && allinOpt.to > (opt.minTo ?? 0)) {
      // 全下式开火
      intent = eq >= p.valueLine ? 'VALUE' : 'BLUFF';
      target = allinOpt.to;
    } else if (street === 'preflop' && canRaise && !betOpt) {
      // 翻前（BB 溜入后的加注）用大盲倍数定尺度
      const openBb = sizing.preflopOpenBb * (1 + (mods.betSize ?? 0) * 0.5) * jitter;
      intent = eq >= p.valueLine ? 'VALUE' : 'BLUFF';
      target = Math.max(opt.minTo, Math.round(bigBlind * openBb));
    } else {
      let size = potBefore * p.betSize * jitter;
      if (eq <= p.bluffLine && rng() < 0.3 + p.risk * 0.35) {
        size *= 1.3 + p.risk * 0.5; // 演凶一点，直接超池压
      }
      intent = eq >= p.valueLine ? 'VALUE' : eq <= p.bluffLine ? 'BLUFF' : null;
      if (!intent || (eq > p.bluffLine && eq < p.valueLine)) {
        // 中等牌力：小的是尝探，大一点的当价值打
        intent = size / Math.max(1, potBefore) < 0.45 ? 'PROBE' : 'VALUE';
        if (size / Math.max(1, potBefore) < 0.45) size = Math.max(size, potBefore * p.probeRatio);
      }
      target = myCommitted + size;
    }

    const amount = Math.round(clamp(target, opt.minTo, opt.maxTo));
    const action = betOpt ? 'bet' : 'raise';
    return { action, amount, intent, equity: eq };
  }

  // 过牌
  if (canCheck) {
    const intent = eq >= p.trapLine || eq >= p.valueLine ? 'TRAP'
      : eq >= p.callTh ? 'POT_CONTROL'
      : 'PROBE';
    return { action: 'check', intent, equity: eq };
  }

  // 没得过牌（面对盲注差额）：只能跟或弃
  if (callOpt) {
    const wCall2 = (eq >= p.callTh || eq + 0.04 >= toCall / Math.max(1, potBefore + toCall)) ? 2 : 0.4;
    const wFold2 = canFold ? (eq < p.foldTh ? 1.5 : 0.3) * p.foldMul : 0;
    if (canFold && wFold2 > wCall2 * rng()) {
      return { action: 'fold', intent: 'POT_CONTROL', equity: eq };
    }
    return { action: 'call', intent: eq >= p.trapLine ? 'TRAP' : 'POT_CONTROL', equity: eq };
  }
  if (allinOpt) return { action: 'allin', intent: eq >= p.valueLine ? 'VALUE' : 'BLUFF', equity: eq };
  return { action: 'check', intent: 'POT_CONTROL', equity: eq };
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
