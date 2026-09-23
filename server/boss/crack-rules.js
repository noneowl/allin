/**
 * 情报 × 行动 = CRACK —— 数据驱动的验证规则（v4）。
 *
 * 旧的「碎片标签组合成链」已废弃。新 CRACK 的定义：
 *   玩家 PIN 了一条真实情报（TRUE），随后做出与该情报正确联动的 Poker 行动，
 *   且该情报与 Boss **当前** intent 的真相一致 → CRACK（成功利用心理情报做出正确决策）。
 *
 * 规则表放在 balance.json `psychologyActionRules`（可扩展，不散落在 battle 里）：
 *   { id, tag, actions[], truthIntents[], kind, why }
 *
 * 判定要件（缺一不可）：
 *   1. pin 存在且 pin.type === 'TRUE'（NOISE/DISTORTION 无标签 → 天然不匹配）
 *   2. pin 的 tag 命中规则 & 玩家行动 ∈ rule.actions
 *   3. Boss 当前 intent ∈ rule.truthIntents（他再次进攻后 intent 变化 → 旧情报自然失效）
 */

/**
 * @param {object} balance
 * @param {{type:string,tags:string[]}|null} pin
 * @param {string} playerAction  玩家本次行动（fold/call/check/pressure/heavy/allin/bet/raise）
 * @param {string|null} currentIntent  Boss 当前 intent
 * @returns {object|null} 命中的规则
 */
export function matchCrackRule(balance, pin, playerAction, currentIntent) {
  if (!pin || pin.type !== 'TRUE' || !Array.isArray(pin.tags) || pin.tags.length === 0) return null;
  if (!currentIntent) return null;
  for (const rule of balance.psychologyActionRules ?? []) {
    if (!rule.actions?.includes(playerAction)) continue;
    if (!rule.truthIntents?.includes(currentIntent)) continue;
    if (pin.tags.some((t) => rule.tag === t)) return rule;
  }
  return null;
}

/**
 * 由命中的规则构造 CRACK 记录（wire 形状见 docs/PROTOCOL.md）。
 * v1 无 critical crack（保留字段恒 false，向后兼容）。
 */
export function buildCrack(rule, pin, actionLabel, handNo, seq) {
  return {
    id: seq,
    kind: rule.kind ?? 'WEAKNESS',
    evidence: Array.isArray(pin.tags) ? pin.tags.slice() : [],
    action: actionLabel,
    strength: 2,
    critical: false,
    handNo,
    ruleId: rule.id ?? null,
    why: rule.why ?? '',
  };
}
