/**
 * Boss 心理状态机：CALM → SHAKEN → TILT → BREAKING。
 *
 * 没有 HP，只有离散状态。状态只由事件驱动（balance.json 的 transitions 表），
 * 且只升不降 —— Boss 战是一场单向的崩坏。
 *
 * `debt`（躁动累积）：一次转移判定失败会小幅提高下一次的成功率，
 * 让「连续打击必定推动进度」成立，同时单次事件仍然可能落空。
 */

export const STATES = ['CALM', 'SHAKEN', 'TILT', 'BREAKING'];
export const ORDER = Object.fromEntries(STATES.map((s, i) => [s, i]));

export const FACES = {
  CALM: '😏',
  SHAKEN: '😳',
  TILT: '😡',
  BREAKING: '🤯',
};

export const MOODS = {
  CALM: '冷静',
  SHAKEN: '动摇',
  TILT: '上头',
  BREAKING: '崩坏',
};

/** 心理事件 → 中文名（进 feed 用） */
export const EVENT_NAMES = {
  BLUFF_CAUGHT: '诈唬被抓',
  PLAYER_BLUFF_SUCCESS: '被偷走底池',
  CONTRADICTION_EXPOSED: '矛盾被指出',
  LANGUAGE_WEAKNESS_HIT: '弱点被击中',
  BIG_POT_LOST: '输掉大底池',
  ALL_IN_LOST: '全下败北',
  CONSECUTIVE_READ_SUCCESS: '被连续看穿',
};

export class Mental {
  /**
   * @param {{ transitions: object, rng?: () => number }} opts
   */
  constructor({ transitions, rng = Math.random }) {
    this.transitions = transitions ?? {};
    this.rng = rng;
    this.state = 'CALM';
    this.debt = 0;
  }

  /** 一次状态转移判定。返回 {from,to,cause} 或 null。 */
  attempt(eventName) {
    const row = this.transitions[eventName]?.[this.state];
    if (!row) return null;
    const [to, chance] = row;
    if (!to || ORDER[to] <= ORDER[this.state]) return null; // 只升不降
    const p = Math.min(1, (chance ?? 0) + this.debt);
    if (this.rng() < p) {
      const from = this.state;
      this.state = to;
      this.debt = 0; // 转移成功，躁动清零
      return { from, to, cause: eventName };
    }
    // 没推动：积一点躁动，让连续打击终归见效
    this.debt = Math.min(0.5, this.debt + 0.15);
    return null;
  }

  reset() {
    this.state = 'CALM';
    this.debt = 0;
  }
}
