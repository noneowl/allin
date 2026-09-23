/**
 * Boss 本体（v3）：情绪 + 台词 + 决策入口 + 高压阶段增益。
 *
 * 持有的是剧本信息：情绪状态、COUNTER/BUSTED 的本手增益、最近一次重要行动的 intent
 * （GOTCHA 与证据链都锚定在它上面）。筹码结算永远在牌桌上发生。
 *
 * 证据链、碎片、Player Model 由 battle.js 持有（战斗层资源，按手/按局重置）。
 */
import { Emotion, FACES, MOODS, EVENT_NAMES, isDownEvent } from './mental.js';
import { decide, assembleMods, monteCarloEquity } from './ai.js';
import { pickLine, pickWinQuip } from './talk.js';

export class Boss {
  /** @param {{ balance: object, rng?: () => number }} opts */
  constructor({ balance, rng = Math.random }) {
    this.balance = balance;
    this.rng = rng;
    this.personality = balance.personality;
    this.emotion = new Emotion({ transitions: balance.transitions, rng });
    this.phaseBuff = null; // COUNTER / BUSTED：本手内的攻击增益（mods extra）
    this.lastActionInfo = null; // { action, intent, street } —— GOTCHA 的判定锚点
    this.lastEquity = null; // 最近一次决策的胜率（READ 碎片用，避免重算）
  }

  get state() {
    return this.emotion.state;
  }

  get face() {
    return FACES[this.state] ?? FACES.CALM;
  }

  get mood() {
    return MOODS[this.state] ?? MOODS.CALM;
  }

  get stateHint() {
    return this.balance.emotions?.[this.state]?.hint ?? null;
  }

  /** 每手开始：本手增益与行动锚点清空。 */
  resetHand() {
    this.lastActionInfo = null;
    this.phaseBuff = null;
    this.lastEquity = null;
  }

  setPhaseBuff(extra) {
    this.phaseBuff = extra ?? null;
  }

  /** 当前生效修正：情绪差值（+ COUNTER/BUSTED 增益）。 */
  currentMods() {
    return assembleMods(this.balance, this.state, { extra: this.phaseBuff });
  }

  /**
   * 三层管线决策（见 ai.js）。
   * @returns {{ action, amount?, intent, equity }}
   */
  decide(ctx) {
    const mods = this.currentMods();
    const result = decide({
      ...ctx,
      mods,
      personality: this.personality,
      sizing: this.balance.sizing,
      model: ctx.model ?? null,
      rng: this.rng,
    });
    this.lastEquity = result.equity;
    result.mods = mods;
    return result;
  }

  /** 记录重要行动（GOTCHA/证据链的锚点）。 */
  noteAction({ action, intent, street }) {
    this.lastActionInfo = { action, intent, street };
  }

  // ---------------------------------------------------------------- 台词

  /**
   * 这次行动配不配台词？重要动作（下注/加注/全下）永远说。
   * @returns {{ text: string, street: string } | null}
   */
  talkFor({ action, street }) {
    const isAggressive = action === 'bet' || action === 'raise' || action === 'allin'
      || action === 'pressure' || action === 'heavy';
    if (!isAggressive) {
      if (action === 'fold') return null;
      const talkative = { CALM: 0.18, SHAKEN: 0.3, TILT: 0.42 }[this.state] ?? 0.2;
      if (this.rng() > talkative) return null;
    }
    const intent = this.lastActionInfo?.intent ?? null;
    const text = pickLine({ state: this.state, intent, rng: this.rng });
    return { text, street };
  }

  /** 赢下一手之后的台词（有概率沉默）。 */
  winQuip() {
    return pickWinQuip(this.state, this.balance.winQuipChance ?? 0.45, this.rng);
  }

  // ---------------------------------------------------------------- 心理

  /**
   * 一次情绪事件（只升不降）。
   * @returns {{from,to,cause,causeName,hint,down}|null}
   */
  mentalEvent(name) {
    const t = this.emotion.attempt(name);
    if (!t) return null;
    t.causeName = EVENT_NAMES[name] ?? name;
    t.hint = this.balance.emotions?.[t.to]?.hint ?? null;
    t.down = isDownEvent(t.from, t.to);
    return t;
  }

  /** 最近一次重要行动的 intent（GOTCHA 判定用）。 */
  currentIntent() {
    return this.lastActionInfo?.intent ?? null;
  }
}

export { monteCarloEquity };
