# 《ALL IN》原型 v5 · 前后端契约（Tell Window 循环）

复用 Poker 引擎、Boss 三层决策、碎片池、GOTCHA 负债状态；本轮**只修基础心理攻防循环**：
READ 不再是随时可用的按钮，而是绑定在 Boss 行动后的 **Tell Window** 上。

```
Boss 行动 → Tell Window 开启 → 玩家 READ（消耗 Focus）或直接回应
→ Poker Response（窗口即刻关闭并清空本轮碎片/PIN）
→ 心理结算：判断正确 → CRACK → Boss 心理状态推进
                                 ↓
         心理状态反过来修改 Boss 下一轮下注权重与 Tell 质量
                                 ↓
   Boss EXPOSED + 高承诺行动(TURN/RIVER × BET/RAISE/HEAVY) → GOTCHA WINDOW
```

座位 `0=玩家 1=Boss`；服务端权威；无 SSE，POST 响应带 `{ view, events }`。

## HTTP 接口

| 方法 | 路径 | 请求体 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/state` | — | `{ view }` |
| POST | `/api/action` | `{action, amount?}` | NORMAL/GOTCHA 动作语义与 v4 相同；**任何成功行动都会关闭当前 Tell Window 并清空碎片与 PIN** |
| POST | `/api/read` | — | 必须在 Tell Window 内：`NO_TELL_WINDOW` / `NO_FOCUS` / `READ_COOLING` / `GOTCHA_AUTO_READ` |
| POST | `/api/pin` | `{fragmentId}` | 只能 PIN **当前窗口**产生的碎片：`BAD_FRAGMENT`（含跨窗口残留的旧 id） |
| POST | `/api/gotcha` | `{}` | 见 §GOTCHA WINDOW：`GOTCHA_WINDOW_CLOSED` / `ALREADY_GOTCHA` / `GOTCHA_LOCKED` |
| POST | `/api/newgame` | — | 重开（热加载 balance.json，双方心理状态回 CALM） |

## Tell Window（状态结构）

Boss 每完成一个行动，若**玩家仍需在本街做出回应**（`toAct===PLAYER` 且手牌进行中），开启：

```jsonc
view.tellWindow = {
  "id": 7,                 // tellWindowId
  "actionId": 12,          // 触发它的 Boss 行动序号
  "handId": 7,             // handNo
  "street": "flop",
  "bossAction": "raise"    // check|call|bet|raise|allin|fold(罕见，弃牌则手结束无窗口)
}
```

- **玩家任何成功行动 → 窗口立即关闭**（含 street 前进、手牌结束的情况）；
- Boss 行动导致本街结束（双方过牌收街）→ **不产生窗口**（玩家没有待回应的决策）；
- 窗口只在 `view.toAct === 0` 时存在；`view.tellWindow = null` 表示当前不可 READ。
- wire 事件：`{ "type": "tell_window_open", "id":7, "actionId":12, "street":"flop", "bossAction":"raise" }`
  （客户端据此提示「心理窗口 · 他刚 X」；关闭以 `view.tellWindow === null` 为准）。

## Focus（替代 readUsesPerHand）

```jsonc
"focus": { "max": 2, "cost": 1, "streetGrant": { "flop": 1, "turn": 1, "river": 1 } }
```

- 翻前 **0**（不开放 READ）；进入 flop/turn/river 各 +1（一次 street 跃迁多档就多次授予）；
- 上限 `max`，未用可带到下一 street；**每手牌从 0 开始**（`hand_start` 重置）；
- READ 消耗 `cost`；UI 显示 `FOCUS 1/2`（`view.player.focus / focusMax`）。

## 碎片生命周期（严格一窗一批）

- READ 只在窗口内可用；一次返回一批 `read_batch`（条数仍 `normalReadFragmentCount`）：
  ```jsonc
  { "type": "read_batch", "source": "manual", "tellWindowId": 7, "actionId": 12,
    "flashMs": 1400, "fragments": [ { "id": "w7f1", "text": "…" }, … ] }
  ```
  - 碎片 id 归属窗口（`w7f1` = 窗口7），`handFragments` 登记 `{id, text, type, tags, sourceAction, binding:{handId,street,actionId,tellWindowId}}`；
  - `view.readFragments` 每项 `{ id, text, atHand, tellWindowId }`；
- **玩家完成本次回应后无条件清空**：`readFragments = []`、`pin = null`、窗口关闭 ——
  无论 CRACK 成功与否，即时心理信息不得跨越下一次 Poker 决策；
- `view.cracks`（战报列表）**保留**，不受生命周期影响。

## READ 信息质量（公式化，全配置）

TRUE 概率不再是固定随机权重：

```
trueRate = clamp(
    read.baseTrueWeight
  + read.tellStrength[bossActionTier]     // 行动的“Tell 强度”
  + read.streetModifier[street]           // 街段修正
  + read.stateModifier[boss.state]        // 心理状态修正
  + 走 GOTCHA 泄漏时用 gotcha.trueRateByDepth 覆盖
, 0, 0.95)
```

- `tellStrength` 档位（Boss 行动归类）：`check(低) < bet(中小) < fold < call < raise(高) < heavy(≥1池, 很高) < allin`
  —— 归类规则：engine `bet/raise` 且 put≥`heavyFrac×pot` → `heavy`，否则 `bet/raise`；
- `streetModifier`：flop 0 < turn < river 最高（信息越到后面越明确）；
- NOISE/DISTORTION 仍按 `read.mix[state]` 的剩余比例分配；
- 碎片三类与标签依旧只在服务端。

## CRACK = 心理攻击命中（判定不变，时机绑定窗口）

- 仍是三要件：`PIN.type==='TRUE'` ∧ `玩家行动∈规则 actions` ∧ `Boss 当前 intent∈truthIntents`
  （规则表仍是 `balance.psychologyActionRules`，匹配器仍是 `crack-rules.js`）；
- 判定发生在**玩家本次回应落地时**（窗口关闭前）：成功 → `pin.verified`、`cracks` 列表 +1、
  发 `crack` 事件（形状同 v4：kind/evidence/action/strength/critical/handNo）、
  **立即推进 Boss 心理状态**（见下）；随后无论成败都执行窗口清理。

## 心理状态（三态，双方对称）

```
CALM（冷静） → SHAKEN（动摇） → EXPOSED（暴露/被看穿）   ← 玩家 CRACK Boss 时推进
CALM → SHAKEN → EXPOSED                                  ← Boss CRACK 玩家时推进
```

- **不再使用 Mental HP**；`balance.transitions` 只剩一张驱动表（进入 GOTCHA 时已是
  EXPOSED、无需再转移，故没有 GOTCHA_HIT 行）：
  ```jsonc
  "CRACK": { "CALM": ["SHAKEN", 1.0], "SHAKEN": ["EXPOSED", 1.0] }
  ```
- **心理与筹码彻底分离（§8）**：赢/输 pot、抓诈唬等**不再触发情绪事件**——
  心理状态只被「被看穿」类事件（CRACK / GOTCHA 入场）推进；牌面结果只结算筹码。
- 状态**跨手持续**，`newgame` 双方回 CALM。
- Boss 侧影响（`emotions` 配置，保留人格差异，非统一削弱）：
  - `CALM`：按 Personality 正常打；Tell 增益0
  - `SHAKEN`：Tell 增益↑、bluff/aggression/方差↑（欺骗型更凶更爱演）
  - `EXPOSED`：Tell 增益↑↑、行为明显偏离基线（aggression/bluff/variance 再↑）、**满足 GOTCHA 心理资格**
- wire：`view.boss.state ∈ CALM|SHAKEN|EXPOSED`、`face/mood/stateHint`；事件
  `{type:"mental", from, to, cause:"CRACK", causeName, hint, down}`
  （cause 目前只有 CRACK；`down` 恒 false——三态只有向右推进；字段保留为展示兼容）。
- 玩家侧：`view.player.state/face/mood`（CALM 😏 / SHAKEN 😳 / EXPOSED 😵，mood 冷静/动摇/暴露），
  事件 `{type:"player_mental", from, to}`；**只展示，暂不参与判定**（为未来 Boss GOTCHA/对称结构铺垫）。

## Boss 最小反读（Boss CRACK Player）

三条**数据驱动**规则（`balance.bossCounterRules`，匹配器仍在 `crack-rules.js`）：

```jsonc
[
 { "id":"fear_pressure", "pattern":"foldsToHeavy", "threshold":2,
   "bossAction":"heavy", "playerAction":"fold",
   "why":"他面对重注就跑 → 我推重注，他果然跑" },
 { "id":"over_call",     "pattern":"callsFaced",   "threshold":3,
   "bossAction":"raise", "playerAction":"call",
   "why":"他什么都接 → 我加注，他果然接" },
 { "id":"agg_punish",     "pattern":"lostAsAggressor","threshold":2,
   "bossAction":"check", "playerAction":"bet",
   "why":"他输急眼爱开火 → 我让牌，他果然开火" }
]
```

- **pattern**（来自 PlayerModel 的当前累计计数，配置阈值）成立，且 Boss 当次行动语义命中
  `bossAction`（`heavy`=put≥heavyFrac×池；`raise`=engine raise；`check`=check）→ 布下陷阱
  （`pendingBossCounter`，随窗口生死）；
- 玩家的**本次回应**命中 `playerAction` → 触发：
  ```jsonc
  { "type":"player_cracked", "ruleId":"fear_pressure", "action":"fold", "bossAction":"heavy",
    "why":"他面对重注就跑 → 我推重注，他果然跑" }
  ```
  + `feed(kind:"model")` 显示 **PLAYER CRACKED** + 玩家心理 `player_mental` 推进一档；
- 玩家回应不匹配 → 陷阱失败，静默清空；换窗口重新评估。

## §GOTCHA WINDOW（资格 × 时机，不再数 CRACK）

`view.gotcha` 非 null 的**全部条件**（缺一不可）：

```
mode === NORMAL
&& boss.state === EXPOSED                    ← 心理状态创造资格
&& street ∈ {turn, river}                    ← 高承诺街段
&& boss.lastAction.action ∈ {bet, raise, allin}   ← Boss 刚做出高承诺行动（含 HEAVY 语义）
&& boss.lastAction.street === 当前 street
&& toAct === 0（玩家回合，可点）
```

```jsonc
view.gotcha = { "street":"river", "bossAction":"raise" }   // 非 null 即按钮点亮
```

- `POST /api/gotcha {}`：同条件校验，不满足 → `GOTCHA_WINDOW_CLOSED`；
  进入后 `mode=GOTCHA`、`debtMode=true`、发 `mode` 事件 + `GOTCHA_HIT` 情绪推进；
- **GOTCHA 内部规则完全沿用 v4**（负债、阶梯、CALL/RAISE 自动泄漏、深度真话率、FOLD/SHOWDOWN 统一结算），
  本轮不改内部；
- `cracksForGotcha` 配置移除（cracks 列表仅作战报展示）；EXECUTION/COUNTER 等依旧不存在。

## events（本轮增删）

```jsonc
{ "type":"tell_window_open", "id":7, "actionId":12, "street":"flop", "bossAction":"raise" }   // ★新增
{ "type":"read_batch", "source":"manual", "tellWindowId":7, "actionId":12, "flashMs":1400,    // ★增字段
  "fragments":[{"id":"w7f1","text":"…"}] }
{ "type":"player_cracked", "ruleId":"fear_pressure", "action":"fold", "bossAction":"heavy", "why":"…" }  // ★新增
{ "type":"player_mental", "from":"CALM", "to":"SHAKEN" }                                       // ★新增
{ "type":"mental", ..., "cause":"CRACK"|"GOTCHA_HIT" }                                          // cause 集合变化
// 移除：无（v4 的16类保留，语义仅上述变化）
```

## 演出

| 触发 | 演出 |
| --- | --- |
| `tell_window_open` | Boss 行动落地后，行动栏/READ 区浮出「🧠 心理窗口 · 他刚 X」提示（窗口存在=READ 可用的唯一时机），窗口随玩家行动即灭 |
| `read_batch` | 沿用成组闪现 + PIN（仅本窗口 id 可 PIN） |
| `crack` | 沿用 CRACK 大字 + 面板 + Known 打勾，**并紧接 `mental` 推进横幅**（冷静→动摇→暴露） |
| `player_cracked` | 红色「PLAYER CRACKED」大字 + Boss 侧反击音效 + Battle Log 记录「他在利用你」 |
| `player_mental` | 玩家 HUD 状态格变色（冷静→动摇→暴露） |
| `mental` | Boss 状态横幅换到三态色板，`stateHint` 更新（写明该状态下 Tell 更真/更凶） |
| GOTCHA 窗口 | 条件满足时 GOTCHA! 按钮点亮（资格=EXPOSED、时机=高承诺行动）；进入演出沿用 v4 |

## 节奏

沿用 v4；`tell_window_open` 是轻提示（不阻塞队列）；`player_cracked` 允许0.8–1.2s 停顿。

---

# v6 增量契约（Opening / Hypothesis / Combo + 战斗 UI 节奏）

**只增量，不改 v5 已定语义**（Tell Window 生命周期、Focus、CRACK 三要件、三态、GOTCHA 全部沿用）。
Wire 尽量不变：窗口仍叫 `tell_window/tellWindow`（对玩家呈现为 **OPENING!**）。

## 1. Opening 强度（新增字段）

开窗时计算一次，随窗口存续：

```
score = read.tellStrength[tier] + read.streetModifier[street]   // 状态不进分数，只走抬级（避免双重叠加）
tierIdx = (score < opening.thresholds.weak ? 0 : score < opening.thresholds.normal ? 1 : 2)
tierIdx = min(2, tierIdx + opening.stateTierBonus[state])      // SHAKEN/EXPOSED 抬一级
strength = ['WEAK','NORMAL','STRONG'][tierIdx]
```

- 配置：`opening: { thresholds: {weak, normal}, stateTierBonus: {CALM,SHAKEN,EXPOSED}, labels: {WEAK:'微弱',NORMAL:'明显',STRONG:'强烈'} }`
- wire：`tell_window_open` 与 `view.tellWindow` 各增 `strength: "WEAK"|"NORMAL"|"STRONG"`
- UI 文案（**绝不显示 TRUE 概率**）：`OPENING! 心理波动：微弱/明显/强烈`
- READ 门禁不变：无窗口 → `NO_TELL_WINDOW`（= 无 Opening）

## 2. Fragment 的 desire/fear（服务端私有）

TRUE 碎片按家族附带交互语义（NOISE/DISTORTION 一律没有）：

| 家族 | 语义 |
| --- | --- |
| wants_fold | desire FOLD |
| call_welcome / strong_hand / board_lock | desire CALL |
| trap / overconfidence | desire RAISE |
| fear_call / missed_board | fear CALL |
| fear_raise / weak_hand / draw | fear RAISE |

**不进 wire**：`read_batch.fragments` 仍是 `{id, text}`（选择层只见文案）。

## 3. HYPOTHESIS（PIN 即判断）

`POST /api/pin {fragmentId}` 成功后 view 增：

```jsonc
"hypothesis": { "mode": "want" | "fear", "action": "FOLD"|"CALL"|"RAISE"|"CHECK" } | null
```

- 由服务端从 pinned 碎片的 desire/fear 推导；碎片无 desire/fear（噪音）→ `hypothesis: null`（照常可 PIN，CRACK 不可能成立）
- 生命周期 = 窗口：玩家行动后 `pinned=null → hypothesis=null`；换手清空
- **CRACK 判定不变**（tag × 行动 × 当前 intent，规则表照旧——desire/fear 是同一批规则的玩家侧翻译）

## 4. 按钮关系文案（纯前端，无「推荐/正确/+CRACK」）

对假设目标 T=(mode,action)，本地生成三键提示：
- `A === T`：want → `顺从他的意图`；fear → `直接测试他的恐惧`
- `want && A !== T`：`CALL → 挑战他的意图`；`RAISE/PRESSURE/HEAVY → 施压`；`FOLD → 拒绝`；`CHECK → 观望`
- `fear && A !== T`：`CALL → 保守回应`；`RAISE → 反向追问`；`FOLD → 退开观察`；`CHECK → 原地试探`

## 5. Combo（仅 UI 反馈 + GOTCHA 前置参考，无 Buff）

- `this.comboCount`（战斗级，newgame 归0，不按手重置）；`view.comboCount`
- 玩家行动时：本次 **CRACK 成功 → +1**；未成功且**当时存在 Opening（有窗口）→ 归0**（错过或判断失败）；**无窗口的行动不计入**（没东西可错过）
- CRACK 大字副标：`CRACK ×N`（N≥2 时）

## 6. CRACK 即时反应

CRACK 事件后紧跟 Boss 受创台词：`{type:"talk", line}`（`talk.js → CRACK_REACT` 池，如「……」「他真的跟了？」）+ feed，随后才是 `mental` 推进。顺序：`crack → talk(受创) → mental`。

## 7. 碎片文案长度

TRUE/NOISE/DISTORTION 池全部压到 **2–10 个中文字**（服务端本轮会改池文案，wire 结构不变）。

## 8. 测试新增（方案 §15 A–I）

弱行为→WEAK/强承诺→STRONG、无 Opening 不可 READ、选碎片→hypothesis 正确、
TRUE+对→立即 CRACK、NOISE/DISTORTION 不 CRACK、错误行动不 CRACK、CRACK 立即改状态、
行动后 opening/fragments/hypothesis 全清、combo 递增与中断清零。

---

# v7 增量契约（THREAT 防守循环 / 选中即生效 / 四种防守结算）

**在 v6 之上增量**；OPENING 语义、Focus、选择层操作、GOTCHA 全部不变。不新增任何按钮。

## 1. 窗口二元化：kind

`tell_window_open` 与 `view.tellWindow` 增：

```jsonc
{ "kind": "OPENING" | "THREAT",
  "threat": { "type": "PLAYER_WILL_FOLD_TO_PRESSURE", "confidence": 0.72 }  // 仅 THREAT
}
```

- 开窗时判定：若 `pendingBossCounter` 成立（**行为模式成形 × Boss 本次行动语义命中**，即
  `#evaluateBossCounter` 命中 `bossCounterRules`）→ `kind:"THREAT"` + `threat{type,confidence}`；否则 `OPENING`。
- 规则配置增 `type` 与 `confidence`（+ 超阈值每多1次 +0.05，封顶0.95）：
  `PLAYER_WILL_FOLD_TO_PRESSURE / PLAYER_WILL_CALL_TOO_MUCH / PLAYER_WILL_BLUFF_OVERRATED`。
- 模式计数沿用 PlayerModel 现有统计（foldsToHeavy / callsFaced / lostAsAggressor）——
  **Personality Prior + 简单统计**，不做预测（§16）。

## 2. THREAT 中的 READ：同一套 UI，语义不同

- 门禁、Focus 消耗、选择层、生命周期与 OPENING **完全一致**（§14：只改标题/文案/视觉）。
- 差异仅在 TRUE 碎片的交互语义：THREAT 窗口内，手工 READ 的 TRUE 碎片附带
  **`expects`（= Boss attackHypothesis 对玩家的预测，来自 pending 规则的 playerAction）**，
  随 PIN 进入 `view.hypothesis`：
  ```jsonc
  "hypothesis": { "mode": "want"|"fear"|"expect", "action": "…" } | null
  ```
  `mode:"expect"` = 我选中的这条说的是「Boss 赌我会 X」。噪音/distortion → null（不判错）。
- OPENING 窗口内仍只有 want/fear。

## 3. 选中即生效（删 Hypothesis 面板）

- wire **不新增**字段：`view.hypothesis` 仍是提示数据源；**UI 不再有独立 Hypothesis 横条/确认步**——
  选中后锁定该碎片（极短「追击态」高亮）→ 按钮下小字**立即**换成本选择对应的关系文案 → 焦点回 Poker。
- 小字文案（v7 口径，**只在“可利用该信息的动作”上出现**，不解释、不判错）：
  - `want D`：非攻击动作（call/check/fold）且 ≠D → `追击`；攻击动作（pressure/heavy/raise/bet/allin）且 ≠D → `施压`；==D → 无
  - `fear F`：==F → `追击`（照他怕的来）；≠F 的攻击动作 → `施压`；其他 → 无
  - `expect X`：==X → `按他的剧本`；≠X → `打破预测`
  - 禁止出现：推荐/正确/必定CRACK/真假类型。

## 4. OPENING 强度继续影响信息质量（§7）

READ 真话率追加 `read.openingBonus[strength]`（WEAK 0 / NORMAL / STRONG，配置），
**仅 OPENING 窗口**；强度仍绝不下发概率。

## 5. 防守结算（玩家在 THREAT 窗口内的成功行动）

判定仅用 **服务端真相**（`pendingBossCounter`）+ 玩家行动 + **是否看穿**（`saw`）：

```
saw = pinned 非空 且 pinned.expects === trap.playerAction   // 真选中了带预测的碎片

A === 预测X：
   saw && A === 'fold' → EVASION       // 看懂了但牌不值得：理性退出，FOLD ≠ 心理失败
   否则                → PLAYER_CRACKED // 他要的到手了 → player_cracked + player_mental 推进
A !== 预测X：
   A ∈ 攻击族(pressure/heavy/raise/bet/allin) → REVERSAL  // 打破且反压：攻势结束、pending清空、
                                                          // 下一个窗口天然是 OPENING（抢回主动）
   其他（call/check/fold）                     → BREAK     // 打破预测：他的心理攻击失败
```

- 事件：`{type:"defense", outcome:"EVASION"|"BREAK"|"REVERSAL", expects, action, saw, threatType}`
  + feed(kind:"model")；PLAYER CRACKED 沿用现有 `player_cracked` + `player_mental`。
- **THREAT 窗口内不做进攻 CRACK**（`validatePinCrack` 仅在无 pending 时执行；§10.3 反击只抢主动、不自动 CRACK）。
- **Poker ≠ 心理**（§12）继续成立：defense/crack 事件在行动响应里即时定型，后续 pot 输赢不回滚。
- combo（v6 §9）修正：**仅 OPENING 窗口**未命中才清段数；THREAT 窗口的防守行动**不清**攻击连段。

## 6. 视觉反馈（Hit Confirm，无长动画）

`OPENING`（进攻机会）/ `THREAT`（Boss 攻击你，红系）/ `CRACK` / `EVASION` / `BREAK` /
`REVERSAL` / `PLAYER CRACKED` —— 七种短促横幅，事件驱动。

## 7. 生命周期（不变）

玩家行动后：窗口（含 kind/threat）、碎片、pinned、hypothesis 全清；Focus 攻守共用同一池。

## 8. 测试（方案 §18 十三项）

见 `test/threat.test.js`（新）：正确链 CRACK、选错不即时报错、错碎片无CRACK、
模式成形→THREAT、THREAT READ 识别 expects、EVASION≠CRACKED、BREAK、REVERSAL→新OPENING、
成立→PLAYER CRACKED、Poker≠心理、Focus 双用途、选中即回操作无面板、结算后全清。
