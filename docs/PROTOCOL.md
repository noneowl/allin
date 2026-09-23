# 《ALL IN》原型 v3 · 前后端契约

单屏 1v1 Poker Boss Battle。服务端权威（底牌、牌堆、Boss intent、碎片真假只在服务端）。
无 SSE：每次玩家操作的响应附带 `{ view, events }`，客户端按节奏串行播放。
座位：`0 = 玩家`，`1 = Boss`。

## 核心循环（契约级语义）

```
打牌 → READ（碎片闪现）→ 证据链成立 → CRACK → GOTCHA（押注判断：BLUFF / STRONG）
  ├─ 判断正确 → EXECUTION（自由下注 + 高速连续 READ 的高压阶段）
  └─ 判断错误 → COUNTER（Boss 主动提高攻击强度的高压阶段）
→ 真实筹码结算 → 赢家成长（Effective Stack ↑）
```

## HTTP 接口

| 方法 | 路径 | 请求体 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/state` | — | `{ view }` |
| POST | `/api/action` | `{ action, amount? }` | `{ view, events }` |
| POST | `/api/read` | — | `{ view, events }`（无限次，400ms 冷却） |
| POST | `/api/gotcha` | `{ guess: "BLUFF" \| "STRONG" }` | `{ view, events }` |
| POST | `/api/newgame` | — | `{ view, events }` |

`action ∈ fold | call | check | pressure | heavy | allin | bet | raise`：

- **NORMAL 模式**玩家可用：`fold / call / check / pressure / heavy / allin`
  - `pressure` = 额外投入 0.5×当前 Pot；`heavy` = 1.0×当前 Pot（服务端算好 raise-to 并按引擎合法区间夹取）
  - `bet / raise`（带 amount，raise-to 语义）**仅在 EXECUTION 模式合法**，否则 400 `NOT_EXECUTION`
- 非法操作 400 `{ error, code }`。门禁：`phase === 'playing'` 且 `toAct === 0`；
  `read` 另有冷却（`READ_COOLDOWN_MS`，超前请求 400 `READ_COOLING`）。
- `newgame` 随时可用，并**热加载 `server/balance.json`**。

## view（玩家视角）

```jsonc
{
  "phase": "playing" | "victory" | "defeat",
  "handNo": 7,
  "street": "preflop" | "flop" | "turn" | "river",
  "pot": 380,
  "board": ["As", "Kd", "2c"],
  "button": 0,
  "toAct": 0,

  "blind": { "sb": 40, "bb": 80, "tier": "第 5–6 手 · 40/80", "nextUp": "第 7 手 → 80/160" },
  "effectiveStack": 620,                  // min(player, boss)：每手最大风险
  "mode": "NORMAL" | "EXECUTION" | "COUNTER",

  "player": {
    "chips": 620, "bet": 0,
    "hole": ["Ah", "Ad"],
    "toCall": 60,
    "handName": "一对",                    // 当前成牌；未成型为 null
    "legal": {
      "check": false, "call": 60, "fold": true,
      "pressure": true, "heavy": true,     // 两个预设按钮（服务端已算好金额）
      "pressureTo": 160, "heavyTo": 240,   // 各自的 raise-to（服务器算）
      "bet": false, "raise": false,        // 自由尺寸字段；客户端还必须用 mode===EXECUTION 门禁
      "minTo": 160, "maxTo": 620,
      "allin": 620
    },
    "readCooldownUntil": 1730000000000     // READ 冷却截止（毫秒时间戳）
  },

  "boss": {
    "chips": 4380, "bet": 60,
    "hole": null,                          // 恒为 null；摊牌走 showdown 事件
    "state": "CALM" | "SHAKEN" | "TILT",
    "face": "😏",                          // 😏 冷静 / 😳 动摇 / 😡 上头
    "mood": "冷静",
    "stateHint": "…",                      // 当前情绪的行为含义一句话
    "lastAction": { "action": "heavy", "amount": 180, "street": "flop" } | null,
    "lastLine": "这手最好别碰。" | null
  },

  "gotcha": {                              // 可发动时非 null
    "id": 2,                               // 最近一次 CRACK 的 id
    "kind": "WEAKNESS" | "STRENGTH" | "CRITICAL",
    "evidence": ["wants_fold", "weak_hand"]
  },
  "cracks": [                              // 本手已形成的证据链（CRACK Feedback 面板）
    { "id": 2, "kind": "WEAKNESS", "evidence": ["wants_fold", "weak_hand"],
      "strength": 2, "critical": false, "handNo": 7, "result": null }
    //   ↑ result 在被 GOTCHA 兑现后变为 { "guess": "BLUFF", "correct": true }
  ],

  "history": [ { "handNo": 7, "street": "flop", "actor": "boss", "action": "heavy", "amount": 180 } ], // 截断 60
  "readFragments": [                       // READ Fragments 面板；截断 30，最新在前
    { "text": "最好别跟。", "atHand": 7 }   // ★ 只有 text + atHand：类型与标签绝不下发
  ],
  "feed": [ { "kind": "talk", "text": "…" } ]
  //   feed.kind ∈ talk | read | crack | gotcha | mode | blind | hand | model | mental | system
}
```

**硬约束（测试钉死）**：

- `view.boss.hole` 恒为 null（摊牌信息只在 `showdown` 事件里）；
- `view` 与 `events` 中**永远没有** `deck`、`intent`、碎片的 `type/tags/strength`、Player Model
  内容、crack 判定中间量；
- `readFragments` 每项**只有** `{ text, atHand }`；
- GOTCHA 的 `guess` 与 Boss `intent` 比对只在服务端完成，结果以 `gotcha_result` 事件下发。

## 碎片 → CRACK → GOTCHA 语义

- `POST /api/read` 生成**一条**碎片（EXECUTION 模式 25% 概率连发两条 = 「信息量更高」），
  以事件闪现下发，**不阻塞事件队列**：
  ```jsonc
  { "type": "read_fragment", "text": "最好现在结束。", "flashMs": 900, "burst": false }
  ```
  - `flashMs`：CALM ≈1400 / SHAKEN ≈1100 / TILT ≈800（EXECUTION ×0.6 = 显示更快）
  - 碎片类型 TRUE / NOISE / DISTORTION 与语义标签**只在服务端**：
    - CALM：噪音多、泄漏少、碎片短
    - SHAKEN：碎片增多、情绪与真实意图更易泄漏
    - TILT：TRUE 密集 + DISTORTION（他自己的错误判断/过度自信）同增
    - NOISE = 真实但无关的念头；DISTORTION = 来自他真实意识但**内容可能错误**的话 —— 两者都无标签，
      **只有 TRUE 带标签**，玩家无法直接看到类型，只能靠牌局实况交叉验证。
- TRUE 碎片标签：`wants_fold / fear_call / weak_hand / strong_hand / draw / missed_board / trap / overconfidence`…
  自**上次 Boss 重要行动以来**累计的标签满足任一 crack 规则（all-of 组合）→ 发：
  ```jsonc
  { "type": "crack", "id": 2, "kind": "WEAKNESS" | "STRENGTH" | "CRITICAL",
    "evidence": ["wants_fold", "weak_hand"], "strength": 2, "critical": false }
  ```
  - `WEAKNESS`：证据指向诈唬/牌弱（引导猜 BLUFF）；`STRENGTH`：指向真实强牌/陷阱（引导猜 STRONG）；
  - **Critical Tell**：单条高强度 TRUE 碎片直接成 CRACK（`kind: "CRITICAL"`，低概率高刺激）；
  - CRACK 形成时置 `view.gotcha`（同时只保留最近一个未使用的 CRACK）；
  - **Boss 下一次重要行动会清空证据与「待兑现」的 CRACK**（`view.gotcha` 置空，旧意图过期）；
    `view.cracks` 面板历史**保留**，未兑现条目的 `result` 为 null（即已过期）。
- `POST /api/gotcha { guess }`：
  - 比对映射：`BLUFF ↔ intent ∈ {BLUFF, PROBE}`；`STRONG ↔ intent ∈ {VALUE, TRAP, CONTROL}`
  - **正确** → `mode: EXECUTION`：开放自由 bet/raise（客户端还需以 `mode` 门禁滑杆）、
    READ 高速连发（flashMs×0.6、25% 双发）。演出：GOTCHA! → Hitstop → 镜头推进 → Boss 表情变 → EXECUTION。
  - **错误** → `mode: COUNTER`：Boss 本手内攻击强度提升（aggression/betSize/bluff 上调，配置 `counter`）。
    演出：GOTCHA! → 短暂停顿 → Boss 反应 → COUNTER!。
  - 解析后 `gotcha` 置空；EXECUTION/COUNTER 期间新 CRACK 照常记录但不再重复发动 gotcha。
  - 模式在**手牌结束**时回落 `NORMAL`（`hand_end.mode` 记录本手终值），下一手必为 NORMAL。
- 证据、CRACK、gotcha 均**按手牌重置**（`hand_start` 清空）。

## Boss 三层决策（仅锁定语义，wire 不可见）

```
Poker Evaluation（equity / 牌面 / 底池赔率 / 位置 / 玩家历史 / Estimated Range / Pot / Effective Stack / Street）
  → foldWeight / callWeight / raiseWeight / bluffOpportunity / valueOpportunity
Personality（DECEIVER：Bluff High · Aggression M-H · Risk M · Trap High · Stability M）
Emotional State（CALM / SHAKEN / TILT 修正 + 决策方差）
  → 最终 { action, amount, intent }      intent ∈ VALUE|BLUFF|TRAP|PROBE|CONTROL（内部，绝不下发）
```

- **Intent 有效至 Boss 下一次重要行动**（GOTCHA 与证据链都锚定于此）。
- **Player Model**（服务端内部）：统计 fold / pressure / heavy / allin / READ 后行动 / showdown 等频率，
  输出 Estimated Fold / Bluff 概率喂给 Evaluation；把握度 `confidence ≥ busted.confidence` 时 Boss 可发动
  专属技 **BUSTED!**：
  ```jsonc
  { "type": "busted", "line": "我看穿你了 —— 全部下注！" }
  { "type": "mode", "mode": "COUNTER" }   // BUSTED 同样进入 Boss 主导的 COUNTER 高压阶段
  ```
  - 冷却 `bustedCooldownHands`；`confidence` 由样本量决定；模型本体**绝不下发**，
    玩家只能从宣告感知「他开始针对我了」。
  - 适应示例（真实生效）：玩家高频「READ → HEAVY」→ Boss 上调「READ 后诈唬」估计 → 面对高压更不爱弃。

## 情绪（v3 三状态，单向恶化）

- 事件表（balance.json `transitions`，只含 CALM→SHAKEN→TILT）：
  `BLUFF_CAUGHT` / `GOTCHA_HIT`（单次）→ SHAKEN；`GOTCHA_STREAK`（连续正确）/ `BIG_POT_LOST` /
  `ALL_IN_LOST` → TILT（按表概率）。胜负筹码不再直接改情绪（与 v2 不同）。
- 影响：Bluff 频率、Aggression、Risk、Bet Size、Decision Variance、碎片比例、台词语气。
- wire：`mental` 事件（含 `hint`/`down`），`view.boss.state/face/mood/stateHint`。

## events（完整清单）

```jsonc
{ "type": "hand_start", "handNo": 7, "button": 0, "sb": 40, "bb": 80, "tier": "第 5–6 手 · 40/80", "blindUp": true }
{ "type": "blinds", "seat": 1, "amount": 40, "potAfter": 120 }
{ "type": "action", "seat": 1, "action": "heavy", "amount": 180, "put": 120, "potAfter": 360, "allIn": false }
{ "type": "street", "street": "flop", "cards": ["As","7d","2c"] }
{ "type": "talk", "line": "这手最好别碰。" }
{ "type": "read_fragment", "text": "最好现在结束。", "flashMs": 900, "burst": false }
{ "type": "crack", "id": 2, "kind": "WEAKNESS", "evidence": ["wants_fold","weak_hand"], "strength": 2, "critical": false }
{ "type": "gotcha_result", "guess": "BLUFF", "correct": true, "mode": "EXECUTION" }
{ "type": "mode", "mode": "EXECUTION" | "COUNTER" | "NORMAL" }
{ "type": "busted", "line": "我看穿你了 —— 全部下注！" }
{ "type": "mental", "from": "CALM", "to": "SHAKEN", "cause": "BLUFF_CAUGHT",
  "causeName": "诈唬被抓", "hint": "…", "down": true }
{ "type": "showdown", "hands": [{ "seat":0, "hole":[...], "handName":"一对", "winner":true }, ...], "split": false }
{ "type": "fold_win", "winner": 1 }
{ "type": "pot_move", "to": 0, "amount": 620 }
{ "type": "hand_end", "handNo": 7, "winner": 0, "pot": 620,
  "stacks": { "player": 1240, "boss": 3760 },
  "effectiveStack": 1240, "blind": { "sb": 80, "bb": 160 },
  "mode": "EXECUTION", "bluffCaught": true }
{ "type": "game_over", "phase": "victory", "heart": "我只是……不想承认你真的看穿我了。" }
```

- `hand_start`：`blindUp=true` 表示本手盲注升级（先播 BLIND UP 横幅再发牌语义由客户端安排）。
- `mode=NORMAL` 的 `mode` 事件只出现在 `hand_end` 之后的回落语义中（或省略，以 hand_end.mode 为准）。

## 演出要求（方案 §19-22 / §27 / §30）

| 触发 | 演出 |
| --- | --- |
| `read_fragment` | Boss 区**闪现**一行碎片（flashMs 后淡出，不阻塞队列），同步追加 READ Fragments 面板；EXECUTION 金色描边 + 更短 |
| `crack` | 白闪 + 震屏 + 「CRACK!」大字 + 音效；CRACK Feedback 面板点亮证据链 |
| `gotcha_result(correct=true)` | 「GOTCHA!」→ Hitstop → 牌桌 zoom 推进 → Boss 表情变化 → 「EXECUTION」大字；行动栏切换出自由滑杆 |
| `gotcha_result(correct=false)` | 「GOTCHA!」→ 短暂停顿 → Boss 反应台词 → 「COUNTER!」红字 + 红闪 |
| `busted` | 立绘震动 + 大字「BUSTED!」→ 切入 COUNTER |
| `mental` | 三状态横幅 + 头像表情/配色切换；`stateHint` 常驻 |
| `pot_move` / `hand_end` | 底池飞向赢家；**筹码堆条**（分段色块，宽度随 chips 过渡）+ 数字滚动 |
| `showdown` | 手牌逐张翻开 |
| `hand_start(blindUp)` | 「BLIND UP 40/80」横幅 |

**筹码堆（§27）**：玩家/Boss 各一条实体筹码条（宽度 ∝ chips / 初始比例，转移时平滑过渡），
上面标注当前 stack —— 让玩家直观看到「自己正在从 Boss 身上把力量夺过来」。

**信息区（§30，四分区）**：

1. `Action History` — 行动记录
2. `READ Fragments` — 碎片流水（纯文本，最新在上）
3. `CRACK Feedback` — 证据链列表（kind + evidence + strength + gotcha 结果）
4. `Battle Log` — 盲注升级 / 情绪变化 / BUSTED / 结算（feed 中 kind ∈ blind,mental,model,hand,system,gotcha,mode,talk）

**行动栏**：`FOLD | CALL/CHECK | PRESSURE(0.5池) | HEAVY(1.0池) | ALL IN`；
EXECUTION 追加自由滑杆（bet/raise，以 `mode` 门禁）；特殊操作：`READ`（冷却转圈，按 `readCooldownUntil`）、
`GOTCHA!`（仅 `view.gotcha` 非空，点击出 BLUFF / STRONG 二选一确认）。

**HUD 必显（§7 示例样式）**：当前牌型 `handName`、Pot、Call Cost、You/Boss Stack、
**Effective Stack**、盲注级别与下次升级（`view.blind`）。

## 节奏

- Boss 思考停顿 0.6–1.2s；碎片闪现 fire-and-forget 不阻塞队列。
- CRACK / GOTCHA / EXECUTION / COUNTER / BUSTED 节点允许队列暂停等演出（1.2–2s），播完解锁行动栏。
- `hand_end` 结算横幅 ≈2s（筹码堆迁移），随后 `hand_start`（blindUp 先播横幅）。
