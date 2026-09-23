/**
 * 双方心理状态机（v5 三态，对称）：
 *
 *   CALM（冷静）→ SHAKEN（动摇）→ EXPOSED（暴露/被看穿）
 *
 * 只被「被看穿」类事件推进：玩家 CRACK Boss、Boss CRACK 玩家、进入 GOTCHA。
 * 赢输 pot 不再影响心理 —— 心理胜负与筹码胜负分离（方案 §8）。
 * 没有 Mental HP；事件表在 balance.json `transitions`（同一张表供双方使用），
 * 结构由测试校验。状态跨手持续，newgame 复位 CALM。
 */

export const STATES = ['CALM', 'SHAKEN', 'EXPOSED'];
export const ORDER = Object.fromEntries(STATES.map((s, i) => [s, i]));
export const SCALE = ['CALM', 'SHAKEN', 'EXPOSED'];
export const isDownEvent = (from, to) => (ORDER[to] ?? 0) > (ORDER[from] ?? 0);

export const FACES = { CALM: '😏', SHAKEN: '😳', EXPOSED: '😵' };
export const MOODS = { CALM: '冷静', SHAKEN: '动摇', EXPOSED: '暴露' };

/** 心理事件 → 中文名（feed / 横幅用）。 */
export const EVENT_NAMES = {
  CRACK: '心理攻击命中',
};

/**
 * 一次状态转移判定（表驱动；当前表全部向右推进）。
 * @returns {{from,to,cause:string}|null}
 */
export function applyTransition(transitions, state, eventName, rng = Math.random) {
  const row = transitions?.[eventName]?.[state];
  if (!row) return null;
  const [to, chance] = row;
  if (!to || to === state) return null;
  // rng 兼容两种形态：函数（Emotion/Battle 传入 this.rng）或直接数值 roll
  const roll = typeof rng === 'function' ? rng() : rng;
  if (roll >= Math.min(1, chance)) return null;
  return { from: state, to, cause: eventName };
}

/** Boss 侧情绪容器（玩家侧用 battle.playerState + applyTransition 即可）。 */
export class Emotion {
  constructor({ transitions, rng = Math.random }) {
    this.transitions = transitions ?? {};
    this.rng = rng;
    this.state = 'CALM';
  }

  attempt(eventName) {
    const t = applyTransition(this.transitions, this.state, eventName, this.rng);
    if (t) this.state = t.to;
    return t;
  }

  reset() {
    this.state = 'CALM';
  }
}
