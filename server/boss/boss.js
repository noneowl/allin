/**
 * Boss 本体：心理状态 + 台词 + READ + 决策的统一入口。
 *
 * 持有的都是「剧本信息」：状态、言语 Buff、本手被点破的矛盾、最近一次行动的
 * intent。所有真正的筹码结算仍在牌桌上发生。
 */
import { Mental, FACES, MOODS, EVENT_NAMES } from './mental.js';
import { decide, assembleMods, rollBreakingMode, monteCarloEquity } from './ai.js';
import { pickLine, pickSpeechReact } from './talk.js';
import { pickRead } from './reads.js';

export class Boss {
  /** @param {{ balance: object, rng?: () => number }} opts */
  constructor({ balance, rng = Math.random }) {
    this.balance = balance;
    this.rng = rng;
    this.personality = balance.personality;
    this.mental = new Mental({ transitions: balance.transitions, rng });
    this.buffs = []; // 言语技能的持续效果
    this.lastActionInfo = null; // { action, intent, street } —— READ 的 live 依据
    this.exposedHand = false; // 本手被异议命中过：行为进一步偏移
    this.contradictions = []; // 本手检测到的矛盾 { id, kind, resolved, ... }
    this._seq = 0;
  }

  get state() {
    return this.mental.state;
  }

  get face() {
    return FACES[this.state] ?? FACES.CALM;
  }

  get mood() {
    return MOODS[this.state] ?? MOODS.CALM;
  }

  get readClarity() {
    return this.balance.mentalModifiers[this.state]?.readClarity ?? 0;
  }

  /** 每手开始：暴露偏移清零。矛盾跨手保留 —— 异议窗口可能还没过期。 */
  resetHand() {
    this.lastActionInfo = null;
    this.exposedHand = false;
  }

  /** 当前生效的修正（含 BREAKING 失控模式 —— 每次决策重抽）。 */
  currentMods() {
    const mods = assembleMods(this.balance, this.state, {
      buffs: this.buffs,
      exposed: this.exposedHand,
    });
    if (this.state === 'BREAKING') {
      const mode = rollBreakingMode(this.balance, this.rng);
      for (const [k, v] of Object.entries(mode)) {
        if (k === 'weight') continue;
        mods[k] = (mods[k] ?? 0) + v;
      }
      mods.breakingMode = mode;
    }
    return mods;
  }

  /**
   * 做一次决策。调用方负责把它交给引擎执行。
   * @returns {{ action, amount?, intent, equity, mods }}
   */
  decide(ctx) {
    const mods = this.currentMods();
    const result = decide({ ...ctx, mods, personality: this.personality, sizing: this.balance.sizing, rng: this.rng });
    // 言语 Buff 按「Boss 的决策次数」衰减
    this.buffs = this.buffs.map((b) => ({ ...b, decisions: b.decisions - 1 })).filter((b) => b.decisions > 0);
    result.mods = mods;
    return result;
  }

  /** 记录本手/本街的行动信息，供 READ 与矛盾检测使用。 */
  noteAction({ action, intent, street }) {
    this.lastActionInfo = { action, intent, street };
  }

  // ---------------------------------------------------------------- 台词

  /**
   * 这次行动要不要配一句台词？重要动作（下注/加注/全下）永远说。
   * @returns {{ text: string, claim: number } | null}
   */
  talkFor({ action, intent, potBefore, put, street }) {
    // 下注/加注/全下永远说话；过牌/跟注按状态话痨度随机；弃牌安静
    const isAggressive = action === 'bet' || action === 'raise' || action === 'allin';
    if (!isAggressive) {
      if (action === 'fold') return null;
      const talkative = { CALM: 0.18, SHAKEN: 0.3, TILT: 0.42, BREAKING: 0.55 }[this.state] ?? 0.2;
      if (this.rng() > talkative) return null;
    }
    const mods = this.currentMods();
    const line = pickLine({
      state: this.state,
      intent,
      action,
      potBefore,
      put,
      lineBias: mods.lineBias ?? 0.2,
      rng: this.rng,
      sizeLevels: this.balance.contradiction?.sizeLevels ?? [0.35, 0.55, 0.95, 1.5],
    });
    return { ...line, street };
  }

  // ---------------------------------------------------------------- READ

  /** @returns {string} 一条模糊的心理信息 */
  read({ street }) {
    const live = this.liveIntent(street);
    const situation = !live ? 'neutral'
      : live.action === 'check' || live.action === 'call' ? 'checked'
      : 'bet';
    return pickRead({
      state: this.state,
      clarity: this.readClarity,
      situation,
      intent: live?.intent ?? null,
      rng: this.rng,
    });
  }

  /** live intent（本街有效）给 READ 判断当前下注用。 */
  liveIntent(street) {
    if (!this.lastActionInfo) return null;
    if (this.lastActionInfo.street !== street) return null;
    return this.lastActionInfo;
  }

  // ---------------------------------------------------------------- 言语

  /**
   * 被玩家言语攻击后的回应。
   * @param {'taunt'|'challenge'|'pressure'} skill
   * @param {'hit'|'resist'|'whiff'} result
   */
  react(skill, result) {
    return pickSpeechReact(skill, this.state, result, this.rng);
  }

  /** 挂一个言语 Buff，影响接下来若干次决策。 */
  applySpeechBuff(skill) {
    const n = this.balance.speech?.buffDecisions ?? 2;
    this.buffs.push({ skill, decisions: n });
    if (skill === 'taunt') {
      // 被激将会积一点躁动，提高下一次状态转移的把握
      this.mental.debt = Math.min(0.5, this.mental.debt + 0.1);
    }
  }

  // ---------------------------------------------------------------- 心理

  /** @returns {{from,to,cause}|null} */
  mentalEvent(name) {
    const t = this.mental.attempt(name);
    if (t) t.causeName = EVENT_NAMES[name] ?? name;
    return t;
  }

  /** 记录一个矛盾（异议窗口用）。只清已经处理掉的旧记录。 */
  addContradiction({ kind, handNo, detail }) {
    const item = { id: ++this._seq, kind, handNo, resolved: false, detail, at: Date.now() };
    this.contradictions.push(item);
    // 上限保护：优先丢弃已处理的最旧一条，绝不丢还没处理的
    if (this.contradictions.length > 12) {
      const done = this.contradictions.findIndex((c) => c.resolved);
      this.contradictions.splice(done === -1 ? 0 : done, 1);
    }
    return item;
  }

  findContradiction(id) {
    if (id === undefined || id === null) return null;
    return this.contradictions.find((c) => c.id === Number(id)) ?? null;
  }

  unresolvedContradiction() {
    return this.contradictions.find((c) => !c.resolved) ?? null;
  }

  markExposed() {
    this.exposedHand = true;
  }
}

export { monteCarloEquity };
