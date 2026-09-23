/**
 * Boss 情绪状态机（v3 三状态，单向恶化）：
 *
 *   CALM（冷静）→ SHAKEN（动摇）→ TILT（上头）
 *
 * 由真实战斗事件推动（方案 §11）：诈唬被抓、GOTCHA 命中与连击、输掉大底池…
 * 胜负筹码本身不直接改情绪 —— 情绪只回应「被看穿」与重大挫败。
 * 没有 HP；事件表在 balance.json `transitions`，结构由测试校验（单向、无自环、概率合法）。
 */

export const STATES = ['CALM', 'SHAKEN', 'TILT'];
export const ORDER = Object.fromEntries(STATES.map((s, i) => [s, i]));
export const SCALE = ['CALM', 'SHAKEN', 'TILT'];
export const isDownEvent = (from, to) => (ORDER[to] ?? 0) > (ORDER[from] ?? 0);

export const FACES = { CALM: '😏', SHAKEN: '😳', TILT: '😡' };
export const MOODS = { CALM: '冷静', SHAKEN: '动摇', TILT: '上头' };

/** 心理事件 → 中文名（feed / 横幅用）。 */
export const EVENT_NAMES = {
  BLUFF_CAUGHT: '诈唬被抓',
  GOTCHA_HIT: '被 GOTCHA 命中',
  GOTCHA_STREAK: '被连续看穿',
  BIG_POT_LOST: '输掉大底池',
  ALL_IN_LOST: '全下败北',
};

export class Emotion {
  /**
   * @param {{ transitions: object, rng?: () => number }} opts
   */
  constructor({ transitions, rng = Math.random }) {
    this.transitions = transitions ?? {};
    this.rng = rng;
    this.state = 'CALM';
  }

  /**
   * 一次情绪转移判定（只升不降）。
   * @returns {{from:string,to:string,cause:string}|null}
   */
  attempt(eventName) {
    const row = this.transitions[eventName]?.[this.state];
    if (!row) return null;
    const [to, chance] = row;
    if (!to || to === this.state) return null;
    if ((ORDER[to] ?? -1) <= (ORDER[this.state] ?? 0)) return null; // 单向恶化
    if (this.rng() >= Math.min(1, chance)) return null;
    const from = this.state;
    this.state = to;
    return { from, to, cause: eventName };
  }

  reset() {
    this.state = 'CALM';
  }
}
