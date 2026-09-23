/**
 * 证据链 → CRACK（方案 §16-17）。
 *
 * 玩家 READ 到的 TRUE 碎片携带语义标签；自上次 Boss 重要行动以来累计的标签
 * 命中 balance.json `cracks.rules`（all-of）即形成 CRACK，解锁 GOTCHA。
 * Critical Tell：单条高强度 TRUE 碎片直接成链（低概率高刺激）。
 *
 * 形成一次后清空证据（链条已兑现）；Boss 下重要行动 / 新手牌由上层调用 reset()。
 */

export class EvidenceTracker {
  /** @param {{ rules: {kind:string, need:string[]}[] }} crackConfig */
  constructor(crackConfig) {
    this.rules = crackConfig?.rules ?? [];
    this.tags = new Set();
    this._seq = 0;
  }

  reset() {
    this.tags.clear();
  }

  /**
   * 记录一条碎片，可能直接形成 CRACK。
   * @param {{type:string, tags:string[], strength:number, critical:boolean}} fragment
   * @param {number} handNo
   * @returns {{id:number, kind:string, evidence:string[], strength:number, critical:boolean, handNo:number}|null}
   */
  add(fragment, handNo) {
    if (!fragment || fragment.type !== 'TRUE' || !fragment.tags?.length) return null;

    // Critical Tell：单条高强度真话直接成链
    if (fragment.critical) {
      const evidence = [...fragment.tags];
      this.tags.clear();
      return {
        id: ++this._seq, kind: 'CRITICAL', evidence,
        strength: Math.max(2, Math.round(fragment.strength * 3)), critical: true, handNo,
      };
    }

    for (const tag of fragment.tags) this.tags.add(tag);

    for (const rule of this.rules) {
      const need = rule.need ?? [];
      if (need.length && need.every((t) => this.tags.has(t))) {
        const evidence = need.slice();
        this.tags.clear(); // 链条已兑现
        return {
          id: ++this._seq, kind: rule.kind ?? 'WEAKNESS', evidence,
          strength: evidence.length, critical: false, handNo,
        };
      }
    }
    return null;
  }

  /** 当前累计标签（调试/测试用；绝不下发）。 */
  snapshot() {
    return [...this.tags];
  }
}
