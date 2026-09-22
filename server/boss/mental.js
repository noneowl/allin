/**
 * Boss 心理状态机：六格情绪刻度（非线性、可双向）。
 *
 *   神了(FLOW) ← 得意(HOT) ← 冷静(CALM) ← 动摇(SHAKEN) ← 上头(TILT) ← 崩坏(BREAKING)
 *
 * - 打击类事件把状态往右砸（含从正轨 HOT/FLOW 打断）
 * - 赢钱类事件把状态往左拉（BIG_POT_WON / ALL_IN_WON / WIN_STREAK）
 * - 抓千与言语类事件永不回血；两端极端状态一票否决双刃：
 *   崩坏纯弊（被收割），神了纯利但不可持续（输一手就掉档）
 *
 * 没有 HP —— 状态本身由 balance.json 的双向转移表驱动，
 * 每条边各自声明方向与概率，表非法在测试里直接报错。
 */

export const STATES = ['CALM', 'SHAKEN', 'TILT', 'BREAKING', 'HOT', 'FLOW'];

/** 情绪刻度顺序（负极端在右）：UI 与「回血/掉档」方向判断都用它。 */
export const SCALE = ['FLOW', 'HOT', 'CALM', 'SHAKEN', 'TILT', 'BREAKING'];
export const ORDER = Object.fromEntries(SCALE.map((s, i) => [s, i]));
/** 是否在负向轴上（被打击推进的方向）。 */
export const isDownEvent = (from, to) => ORDER[to] > ORDER[from];

export const FACES = {
  FLOW: '✨',
  HOT: '🤑',
  CALM: '😏',
  SHAKEN: '😳',
  TILT: '😡',
  BREAKING: '🤯',
};

export const MOODS = {
  FLOW: '神了',
  HOT: '得意',
  CALM: '冷静',
  SHAKEN: '动摇',
  TILT: '上头',
  BREAKING: '崩坏',
};

/** 心理事件 → 中文名（进 feed / 横幅用） */
export const EVENT_NAMES = {
  BLUFF_CAUGHT: '诈唬被抓',
  PLAYER_BLUFF_SUCCESS: '被偷走底池',
  CONTRADICTION_EXPOSED: '谎言被戳穿',
  LANGUAGE_WEAKNESS_HIT: '弱点被击中',
  BIG_POT_LOST: '输掉大底池',
  ALL_IN_LOST: '全下败北',
  CONSECUTIVE_READ_SUCCESS: '被连续看穿',
  HAND_LOST: '顺风被打断',
  BIG_POT_WON: '赢下大底池',
  ALL_IN_WON: '全下获胜',
  WIN_STREAK: '连赢上头',
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

  /**
   * 一次状态转移判定（方向由表决定，可升可降）。
   * @param {string} eventName
   * @param {number} [armor] 当前状态对该事件的抗性系数（0..1，乘在概率上）
   * @returns {{from:string,to:string,cause:string}|null}
   */
  attempt(eventName, armor = 1) {
    const row = this.transitions[eventName]?.[this.state];
    if (!row) return null;
    const [to, chance] = row;
    if (!to || to === this.state) return null;
    const p = Math.max(0, Math.min(1, chance * (Number.isFinite(armor) ? armor : 1) + this.debt));
    if (this.rng() < p) {
      const from = this.state;
      this.state = to;
      this.debt = 0; // 转移成功，躁动清零
      return { from, to, cause: eventName };
    }
    // 没推动：积一点躁动，让连续打击终会见效
    this.debt = Math.min(0.5, this.debt + 0.15);
    return null;
  }

  reset() {
    this.state = 'CALM';
    this.debt = 0;
  }
}
