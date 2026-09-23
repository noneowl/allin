# 《ALL IN》原型 v4 · 前后端契约（增量修订）

复用 v3 的 Poker 引擎、Boss 三层决策、碎片池与 UI 骨架；本次只改
**READ 资源 / 批量碎片 / PIN / CRACK 判定 / GOTCHA 负债状态**。
座位：`0 = 玩家`，`1 = Boss`。服务端权威，客户端只拿 `{ view, events }`。

## 目标循环

```
Boss 行动 → READ（每手限量，一次返回一组碎片）
→ PIN 其中一条（最多1条有效保留）
→ 玩家做出 Poker Action
→ 服务端用「PIN 的真实标签 × 玩家行动 × Boss 当前 intent」验证 → CRACK
→ 累积 N 个 CRACK → GOTCHA 解锁
→ 进入 GOTCHA：双方解除 Stack 上限，允许负债下注（临时余额可为负）
→ 任意 CALL / RAISE 自动触发 Boss 心理泄漏（越深越真）
→ FOLD / SHOWDOWN 统一结算 Pot + 债务 → 判定胜负 / 下一手
```

## HTTP 接口

| 方法 | 路径 | 请求体 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/state` | — | `{ view }` |
| POST | `/api/action` | `{ action, amount? }` | 见下方动作语义 |
| POST | `/api/read` | — | 批量碎片；需玩家回合、剩余次数>0、冷却外 |
| POST | `/api/pin` | `{ fragmentId }` | 保留一条碎片（本手生成、玩家回合） |
| POST | `/api/gotcha` | `{}` | CRACK 达标后**进入 GOTCHA 状态**（无 guess） |
| POST | `/api/newgame` | — | 重开（热加载 balance.json） |

错误码：`READ_EXHAUSTED` / `READ_COOLING` / `NO_READS_TURN`、
`BAD_FRAGMENT` / `PIN_NOT_ALLOWED`、`GOTCHA_NOT_ARMED`、`BAD_GUESS`(移除)、
`NOT_GOTCHA`（NORMAL 里裸 bet/raise）、`GOTCHA_ACTIONS`（GOTCHA 里 pressure/heavy）、
`GOTCHA_LOCKED`（已有全下边缘，无法进入负债状态）、`NOT_YOUR_TURN` / `HAND_OVER` / `BATTLE_OVER`。

### 动作语义

- **NORMAL**：`fold | call | check | pressure(0.5池) | heavy(1池) | allin`
  —— 照旧受 Effective Stack 约束；`bet/raise` 拒绝（`NOT_GOTCHA`）。
- **GOTCHA**：`fold | call | check | raise`
  —— `raise` **不带金额也可以**：省略 amount 时服务端按**阶梯**给（见下）；
  带金额则按引擎区间夹取（仍受最小加注约束）。`pressure/heavy` 拒绝（`GOTCHA_ACTIONS`）。
- **阶梯**：`gotchaRaiseStep` 初始 = 本街 `lastRaiseSize`（≥bb）；玩家 RAISE 的
  raise-to = `currentBet + step`（currentBet=0 时即开注）；**任意一方完成一次完整加注后
  step ×= 2** —— 100 → 200 → 400 → 800 …，每一次继续风险肉眼翻倍。

## view

```jsonc
{
  "phase": "playing" | "victory" | "defeat",
  "handNo": 7, "street": "flop", "pot": 380, "board": [...], "button": 0, "toAct": 0,
  "blind": { "sb": 40, "bb": 80, "tier": "...", "nextUp": "..." },
  "effectiveStack": 620,                    // NORMAL 的风险上限；GOTCHA 中仅作参考显示
  "mode": "NORMAL" | "GOTCHA",              // EXECUTION/COUNTER 已废弃

  "player": {
    "chips": 500,                           // GOTCHA 结算前可以为负（负债）
    "bet": 0, "hole": [...], "toCall": 60,
    "handName": "一对",
    "readsLeft": 2,                         // ★ 本手剩余 READ 次数（readUsesPerHand 起）
    "readsPerHand": 2,                      // UI 显示 "READ 2/2"
    "readCooldownUntil": 1730000000000,
    "legal": {
      "check": true, "call": null, "fold": true,
      "pressure": true, "heavy": true, "pressureTo": 160, "heavyTo": 240, // 仅 NORMAL 有意义
      "bet": false, "raise": false, "minTo": 0, "maxTo": 0, "allin": 500,
      "gotchaRaiseTo": null                 // 仅 GOTCHA：阶梯给出的 raise-to（可为开注视额）
    }
  },

  "boss": { "chips": 4380, "bet": 60, "hole": null,             // hole 恒 null
            "state": "CALM"|"SHAKEN"|"TILT", "face": "😏", "mood": "冷静",
            "stateHint": "…", "lastAction": {...} | null, "lastLine": "…" | null },

  "pin": { "text": "他害怕我继续加注。", "verified": false } | null,
      // ★ 玩家唯一保留位（pinSlots=1）：只有 text + verified（命中 CRACK 后变 true）
      //   type/tags/sourceAction 只在服务端

  "gotcha": { "cracks": 2, "need": 2 } | null,   // 非 null = 已解锁，可 POST /api/gotcha
  "cracks": [ { "id": 5, "kind": "WEAKNESS", "evidence": ["fear_call"],
                "action": "call", "strength": 2, "critical": false,
                "handNo": 7, "result": null } ],
      // kind: 本次验证的性质；evidence = PIN 的真实标签；action = 触发的玩家行动；
      // result 保留字段（v4 不再由 gotcha 兑现，恒 null，向后兼容）

  "readFragments": [ { "id": "f12" | null, "text": "…", "atHand": 7 } ],
      // ★ 新增 id：本手手工 READ 生成的碎片有 id（可 PIN）；GOTCHA 自动泄漏 id=null 不可 PIN
  "history": [...], "feed": [...]
  //   feed.kind ∈ talk | read | pin | crack | gotcha | mode | blind | hand | model | mental | system
}
```

**硬约束（测试钉死）**：`boss.hole` 恒 null；永不下发 `deck / intent / 碎片 type·tags·strength /
pin 的 type·tags / Player Model`；`readFragments` 每项**只有** `{id, text, atHand}`；
`pin` 只有 `{text, verified}`。

## READ 批量与 PIN

- `POST /api/read` 消耗 `readsLeft`（`balance.readUsesPerHand`，`hand_start` 重置），
  一次生成 `normalReadFragmentCount`（min..max 随机）条碎片：
  ```jsonc
  { "type": "read_batch", "source": "manual",
    "flashMs": 1400,
    "fragments": [ { "id": "f12", "text": "最好现在结束。" },
                   { "id": "f13", "text": "灯光有点刺眼。" },
                   { "id": "f14", "text": "他不会真的敢跟吧？" } ] }
  ```
  - 内部仍是 TRUE / NOISE / DISTORTION 三类与语义标签，**绝不下发类型**。
  - `flashMs` 沿用状态表（EXECUTION 系数已废除）。
- `POST /api/pin { fragmentId }`：只能 PIN **本手手工 READ**（有 id）的碎片；
  单槽位，新 PIN 覆盖旧 PIN。响应的 `view.pin` 即最新保留。
- 面板 `readFragments` 每条带 id —— 客户端按「本手 + 有 id + 非 GOTCHA 模式」显示 PIN 按钮。

## 新 CRACK：情报 × 行动（数据驱动规则）

旧的「碎片标签组合成链」**废弃**。CRACK = 玩家拿着已 PIN 的**真实**情报做出了正确的牌桌行动：

```
PIN(标签 T) × 玩家行动 A × Boss 当前 intent ∈ 规则.truthIntents  →  CRACK
```

- 规则表在 **`balance.json → psychologyActionRules`**（数据驱动，可扩展），
  匹配器在 **`server/boss/crack-rules.js`**：
  ```jsonc
  { "id": "call_vs_wants_fold", "tag": "wants_fold", "actions": ["call"],
    "truthIntents": ["BLUFF", "PROBE"], "kind": "WEAKNESS",
    "why": "他想让你弃，你却跟了 —— 读对了" }
  ```
- 判定时机：**玩家每一次成功行动之后**（fold/call/check/pressure/heavy/allin/bet/raise）。
- 必要条件（缺一不可）：
  1. 本手存在 `pin` 且 `pin.type === 'TRUE'`（NOISE/DISTORTION 天然无标签 → 永不匹配）；
  2. `pin.tags[0]` 命中某规则的 `tag` 且玩家行动 ∈ `rule.actions`；
  3. **Boss 当前 intent**（`lastActionInfo.intent`，上次重要行动以来）∈ `rule.truthIntents`
     —— Boss 再次进攻后 intent 变化，旧情报自然失效。
- 成功 → `pin.verified = true`（该 PIN 不再产生新 CRACK，可换 PIN），
  `crackCount += 1`，发：
  ```jsonc
  { "type": "crack", "id": 5, "kind": "WEAKNESS", "evidence": ["wants_fold"],
    "action": "call", "strength": 2, "critical": false, "handNo": 7 }
  ```
- 基础规则集（按现有 tags 扩展，全部在配置里）：
  `wants_fold+call`、`fear_call+call`、`fear_raise+raise/pressure/heavy/bet/allin`、
  `weak_hand+pressure/heavy/raise/bet/allin`、`missed_board+…（同弱攻）`、`draw+…（同弱攻）`、
  `trap+check`、`call_welcome+fold/check`、`strong_hand+fold/check`、
  `board_lock+fold/check`、`overconfidence+fold/check`。
  真值域：弱侧标签 → `truthIntents ["BLUFF","PROBE"]`；强侧标签 → `["VALUE","TRAP","CONTROL"]`。
- `fragments.js` 新增 TRUE 家族 `fear_raise`（他怕你继续加注 → 你加注即验证）。

## GOTCHA（负债高风险状态）

- **解锁**：本手 `cracks.length >= balance.cracksForGotcha`（建议2） → `view.gotcha` 非 null。
  CRACK 计数**按手牌重置**；允许未来扩展 critical crack（v1 不做）。
- **进入**：玩家回合 `POST /api/gotcha {}`：
  - 校验：`gotcha` 已解锁、`mode === NORMAL`、双方都未处于全下锁定（`GOTCHA_LOCKED`）。
  - 生效：`mode = "GOTCHA"`、引擎 `debtMode = true`、`gotchaRaiseStep = lastRaiseSize`、
    `gotchaDepth = 0`；发 `{ "type": "mode", "mode": "GOTCHA" }` + 情绪事件
    （复用 `GOTCHA_HIT` 转移：被看穿到敢全押）+ feed。
- **负债下注**：debtMode 下引擎解除 Stack 上限 —— `call/bet/raise` 金额不受剩余筹码限制，
  `stack` 允许被扣成负数（临时余额），**不产生 all-in 语义、不触发 runout**；
  Effective Stack 限制只存在于 NORMAL。玩家 UI 不提供任何数字输入：FOLD / CALL / CHECK /
  RAISE（阶梯金额由 `legal.gotchaRaiseTo` 给出）。
- **自动 READ（心理泄漏）**：GOTCHA 中**任意一方完成 CALL 或 RAISE**（玩家或 Boss）即自动触发：
  ```jsonc
  { "type": "read_batch", "source": "gotcha", "depth": 2, "flashMs": 700,
    "fragments": [ { "id": null, "text": "…" }, … ] }
  ```
  - 条数 = `gotchaReadFragmentCount`（min..max，比普通多）；
  - TRUE 概率按深度查 `balance.gotcha.trueRateByDepth`：
    depth1 45% → 2:55% → 3:65% → 4+:75%（**风险越深，防线漏得越真**）；
  - `depth` 每次触发 +1；自动泄漏 `id = null`（不可 PIN）。
  - 玩家 READ 按钮在 GOTCHA 中禁用（不再手动 READ）。
- **结束**：只有 FOLD 或 SHOWDOWN。结算顺序（引擎内完成）：
  1. 退还未跟注部分；2. Pot = 全部已投入（含负债投入）；3. 赢家收取 Pot
     （`stack += pot`，负数债务被 Pot 覆盖或保留）；4. `mode → NORMAL`（下一手）、debtMode 关；
  5. 结算后 `stack <= 0` 判负（`victory/defeat`），`> 0` 打下一手。
  **绝不允许负数筹码进入下一手的 NORMAL 阶段**（负 → 立即终局判定）。
- `hand_end.mode` 记录本手终值（`GOTCHA` 或 `NORMAL`）。

## 情绪（不变，事件语义微调）

- 三态 `CALM → SHAKEN → TILT` 单向；触发：
  - `BLUFF_CAUGHT`（抓诈唬）、`BIG_POT_LOST`、`ALL_IN_LOST` 照旧；
  - **`GOTCHA_HIT`：玩家成功进入 GOTCHA 时触发一次**（被看穿到敢押上全部）；
  - **`GOTCHA_STREAK`：连续两手都进入 GOTCHA 时触发**（跨手上头）。
  - 旧的「猜对/猜错」语义废除。

## BUSTED（保留，微调）

`busted` 事件照旧（Player Model 把握度 + 冷却）；触发后 **Boss 获得本手攻击增益
（`balance.counter` 并入 phaseBuff）**，但**不再切换 mode**（mode 只有 NORMAL/GOTCHA）。
`mode` 事件仅用于 GOTCHA 进出。

## events（本次增删）

```jsonc
{ "type": "read_batch", "source": "manual"|"gotcha", "depth": 2,
  "flashMs": 1400, "fragments": [ { "id": "f12"|null, "text": "…" } ] }   // ★ 取代 read_fragment
{ "type": "crack", "id": 5, "kind": "WEAKNESS", "evidence": ["wants_fold"],
  "action": "call", "strength": 2, "critical": false, "handNo": 7 }
{ "type": "mode", "mode": "GOTCHA" }                                      // 仅进入 GOTCHA 时发
// 移除：read_fragment、gotcha_result、mode:"EXECUTION"|"COUNTER"
// 保留：hand_start(blindUp)、blinds、action、street、talk、busted、mental、
//       showdown、fold_win、pot_move、hand_end(含 mode/effectiveStack/blind/bluffCaught)、game_over
```

## 演出

| 触发 | 演出 |
| --- | --- |
| `read_batch(manual)` | Boss 区**成组闪现** 3–5 行（stacked，逐行错开，flashMs 后淡出，不阻塞队列）；每行旁有 **PIN 按钮**（仅本手有 id 的行）；面板同步 prepend |
| `pin` 响应 | 📌 卡片更新（Known 区）；被 PIN 行高亮 |
| `crack` | 白闪 + 震屏 + 「CRACK!」大字（副标 = evidence × action）+ 面板点亮 + **PIN 卡片打勾（verified）** |
| `mode:"GOTCHA"` | 全屏宣告「GOTCHA!」→ 屏幕红金警戒边（`data-mode="GOTCHA"`）→ 行动栏切换为 FOLD/CALL/RAISE 阶梯；筹码堆允许出现**红色负值段** |
| `read_batch(gotcha)` | 更快更密的泄漏闪现（flashMs 短、金色描边），带 depth 角标 |
| 负债显示 | chips 为负时筹码堆回缩到0并显示红色欠额（如 `-200`） |
| 其余（CRACK 前演出、mental、blind up、hand_end 迁移、结局）沿用 v3 |

**信息区四分区**不变（Action History / READ Fragments / CRACK Feedback / Battle Log），
新增 **Known（📌 PIN 卡片）** 独立小区（建议放玩家 HUD 或 READ Fragments 顶部）。

**行动栏**：
- NORMAL：`FOLD | CALL/CHECK | PRESSURE(至N) | HEAVY(至N) | ALL IN` + `READ(2/2 冷却环)`
  + `GOTCHA!`（解锁后点亮）
- GOTCHA：`FOLD | CALL/CHECK | RAISE(至N·阶梯)`；READ 禁用显示 `READ —`；
  GOTCHA! 按钮变为常亮「IN PROGRESS」态
