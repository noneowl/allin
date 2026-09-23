/**
 * Player Model（方案 §24-26）：Boss 对玩家的行为建模。
 *
 * 纯统计：玩家的行动频率、READ 之后的习惯、对下注的弃/跟倾向、摊牌历史。
 * 输出两件事：
 *   1. 给 Poker Evaluation 的估计（玩家弃牌倾向 → Boss 该不该诈唬；玩家爱跟 → 少诈唬多价值）
 *   2. BUSTED! 的把握度（confidence 由样本量决定）
 *
 * 模型本体绝不下发 —— 玩家只能从 BUSTED 的宣告与 Boss 的打法变化反推。
 */

export class PlayerModel {
  constructor() {
    this.reset();
  }

  reset() {
    this.s = {
      decisions: 0,
      folds: 0, calls: 0, checks: 0, pressure: 0, heavy: 0, allins: 0, betraises: 0,
      // 面对 Boss 下注时的反应（评估诈唬收益用）
      facedBet: 0, foldsToFaced: 0, callsFaced: 0, raisesFaced: 0,
      // 习惯与针对性
      reads: 0, readThenHeavy: 0, readWindow: false,
      pressureThenHeavy: 0, pressureWindow: false,
      // 摊牌
      showdowns: 0, wonShowdown: 0, lostAsAggressor: 0,
      gotchaRight: 0, gotchaWrong: 0,
    };
    this.lastBustedAtHand = -999;
  }

  /**
   * @param {string} kind 玩家行动/事件
   * @param {object} [meta]
   */
  record(kind, meta = {}) {
    const s = this.s;
    switch (kind) {
      case 'action': {
        s.decisions += 1;
        const a = meta.action;
        if (a === 'fold') s.folds += 1;
        else if (a === 'call') s.calls += 1;
        else if (a === 'check') s.checks += 1;
        else if (a === 'pressure') s.pressure += 1;
        else if (a === 'heavy') s.heavy += 1;
        else if (a === 'allin') s.allins += 1;
        else s.betraises += 1;

        // READ → HEAVY 习惯（§26 的针对性）
        if (s.readWindow && (a === 'heavy' || a === 'pressure')) s.readThenHeavy += 1;
        if (s.pressureWindow && a === 'heavy') s.pressureThenHeavy += 1;
        s.readWindow = false;
        s.pressureWindow = false;

        // 面对下注的弃/跟
        if (meta.facingBet) {
          s.facedBet += 1;
          if (a === 'fold') s.foldsToFaced += 1;
          else if (a === 'call') s.callsFaced += 1;
          else if (a === 'raise' || a === 'pressure' || a === 'heavy' || a === 'allin') s.raisesFaced += 1;
        }
        break;
      }
      case 'read':
        s.reads += 1;
        s.readWindow = true;
        break;
      case 'pressure':
        s.pressureWindow = true;
        break;
      case 'showdown':
        s.showdowns += 1;
        if (meta.playerWon) s.wonShowdown += 1;
        if (!meta.playerWon && meta.playerAggressive) s.lostAsAggressor += 1;
        break;
      case 'gotcha':
        if (meta.correct) s.gotchaRight += 1;
        else s.gotchaWrong += 1;
        break;
      default:
        break;
    }
  }

  /** 把握度：样本量决定（0..1）。 */
  confidence() {
    return Math.max(0, Math.min(1, this.s.decisions / 14));
  }

  /** 面对下注时玩家的大致弃牌率（拉普拉斯平滑）。 */
  estFoldVsBet() {
    const s = this.s;
    return (s.foldsToFaced + 1) / (s.foldsToFaced + s.callsFaced + s.raisesFaced + 2);
  }

  /** 玩家疑似诈唬率（激进却输掉摊牌 + READ→HEAVY 习惯）。 */
  estPlayerBluff() {
    const s = this.s;
    return (s.lostAsAggressor + s.readThenHeavy + 1) / (s.showdowns + s.readThenHeavy + 3);
  }

  /** 适应：玩家「READ 之后喜欢开大」→ 面对高压不再轻易弃牌（§26）。 */
  adaptation() {
    const s = this.s;
    return {
      noFoldVsHeavy: s.readThenHeavy >= 2 && s.reads >= 3,
      trapSuspect: s.pressureThenHeavy >= 2 && s.pressure >= 3,
    };
  }

  /** BUSTED! 是否可发动（外加冷却与最小手数由调用方校验）。 */
  bustedReady(confidenceThreshold) {
    return this.confidence() >= confidenceThreshold;
  }
}
