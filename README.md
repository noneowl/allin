# ♠ ALL IN · 1v1 Poker Boss Battle（原型 v4）

**玩家不是单纯依靠发牌获胜，而是通过读取并利用对手，让自己的判断转化为筹码优势。**

```
Boss 做出 Poker 行动 → Tell Window（心理交锋窗口开启）
→ 你 READ（消耗 Focus，读到与“他刚做的行动/街段/心理状态”相关的碎片）
或直接回应
→ PIN 一条判断 → Poker Response（窗口即刻关闭，碎片/PIN 全部清空）
→ 系统验证「真话 × 行动 × Boss 当前 intent」→ CRACK
→ CRACK 立即推进 Boss 心理：CALM → SHAKEN → EXPOSED
→ 心理状态反过来改写下一轮下注权重与 Tell 真话浓度
→ Boss EXPOSED + 转牌/河牌 + 他刚高承诺下注 → GOTCHA 窗口
→ GOTCHA：负债下注、CALL/RAISE 自动泄漏（越深越真）→ FOLD/SHOWDOWN 统一结算
```

**双向心理战**：Boss 也会读你 —— 连续被重注打跑 / 什么都接 / 输急眼乱开火，
他看穿了就 `PLAYER CRACKED`，你的心理同样三态推进。心理胜负与筹码胜负**彻底分离**。

**不对称开局**：你 500，Boss（千面 DECEIVER）5000。筹码 = 生命值 = 战斗资源 =
**唯一成长资源**（赢 → Effective Stack ↑ → 单手 Pot ↑ → 伤害 ↑）。
**Boss 筹码归零 = BREAK 胜利**；你归零（含 GOTCHA 负债结算后 ≤0）= 失败。
盲注按手数升级（10/20 → 160/320），烈度随时间自然推向决战。

```
零 npm 依赖 · 无需构建 · node server/index.js 即可运行
```

---

```bash
node server/index.js        # 或 npm start，默认 http://localhost:8787
npm run preview             # UI 预览（canned 数据）http://localhost:8791
npm test                    # 65 个测试
```

---

## 核心循环（v5）

### 1. Tell Window：READ 只在“他行动之后”

你不能随时 READ。只有 Boss 完成一个有心理意义的行动（CHECK/CALL/BET/RAISE/…）
且你仍需在**本街**回应时，才开启一个短暂的 **Tell Window**
（`view.tellWindow {id, actionId, handId, street, bossAction}` + `tell_window_open` 事件）。
**你一旦行动，窗口立刻关闭** —— READ 不再是独立技能按钮，它长在牌桌上。

### 2. Focus：进街恢复的资源（取代 READ 2/手）

```
翻前：0（不开放 READ）     进入 Flop：+1     进入 Turn：+1     进入 River：+1
上限 2（FOCUS 1/2），READ 消耗 1，未用的可带到下一街，每手归 0
```

于是你自己选择：翻牌圈就读，还是把资源留给转牌/河牌更关键的一手。

### 3. 碎片只活一个窗口

READ 返回一批 3–5 条碎片（id 归属窗口 `w7f1`）。**你回应之后**，
`readFragments = []`、`PIN = null`、窗口关闭 —— 无论 CRACK 成败，
即时心理信息不得跨越下一次决策。PIN 旧窗口的碎片会被拒绝（`BAD_FRAGMENT`）。

### 4. 信息质量 = 他刚做了什么 + 第几条街 + 他什么状态

```
trueRate = baseTrueWeight
         + tellStrength[Boss行动档]   check < bet < fold < call < raise < heavy < allin
         + streetModifier[街段]        flop < turn < river
         + stateModifier[心理状态]     CALM < SHAKEN < EXPOSED
```

（全部数值在 `balance.json`；NOISE/DISTORTION 按状态比例分配剩余概率。）

### 5. CRACK = 心理攻击命中

三要件缺一不可：`PIN 的 TRUE 标签` ∧ `行动命中规则` ∧ `Boss 当前 intent ∈ truthIntents`。
规则数据驱动（`psychologyActionRules`，11 条起步）；NOISE/DISTORTION 天然不通；
他再次换进攻意图，旧情报立即失效。**验证成功 → CRACK → 立即推进其心理状态**。

### 6. 三态心理（双方对称，无 Mental HP）

```
CALM（冷静 😏）→ SHAKEN（动摇 😳）→ EXPOSED（暴露 😵）
```

- 只被“被看穿”类事件推进（CRACK）—— 赢输 pot **不再影响心理**（心理≠筹码）；
- **状态真的改打法**：SHAKEN/EXPOSED 提高 bluff/aggression/variance/注码
  （欺骗型被看穿后更凶更爱演，而非统一变弱），同时 **Tell 真话率持续上升**；
- 玩家侧同表：被 `PLAYER CRACKED` 时推进，显示在 HUD（为未来 Boss GOTCHA/对称结构铺垫）。

### 7. Boss 的最小反读（PLAYER CRACKED）

三条数据驱动规则（`bossCounterRules`）：面对重注连续弃牌≥2 / 面对下注连续跟注≥3 /
诈唬被抓≥2 —— 模式成形 + 他的行动语义命中（重注/加注/让牌）+ 你的回应踩中预期
→ 红色 **PLAYER CRACKED** 大字 + 你的心理推进。**他在观察你。**

### 8. GOTCHA 窗口：心理状态创造资格，Poker 行为创造时机

不再数 CRACK 数量。同时满足才点亮 `view.gotcha`：

```
Boss EXPOSED（资格） × 转牌/河牌 × Boss 刚做出 BET/RAISE/HEAVY/ALLIN（本街）× 你的回合
```

进入后沿用 v4 内核：**允许临时负债下注**、阶梯 RAISE（×2 翻倍）、
任意 CALL/RAISE 自动心理泄漏（深度越深 TRUE 越多 45→75%）、
FOLD/SHOWDOWN 统一结算 —— 负数绝不进入下一手。

### 9. Boss 人格与演出

- DECEIVER 三层决策 `Poker Evaluation → Personality(+Player Model) → Emotion`；
- **BUSTED!** 把握够了宣告「我看穿你了 —— 全部下注！」并**本手**提高攻击性；
- HUD 必显：当前牌型、Pot、Call Cost、双方 Stack、**Effective Stack**、盲注档、
  **FOCUS、Tell Window 提示、双方心理状态**。
  键盘：`F` 弃牌 · `C` 过牌/跟注 · `A` 全下 · `↵` 提交。

---

## 数值调优（全部在 `server/balance.json`，newgame 热加载）

| 区块 | 内容 |
| --- | --- |
| `stacks` / `blindSchedule` | 500/5000 比例；盲注升级表 |
| `focus` | max/cost + 各街授予量（翻前0） |
| `read` | **baseTrueWeight / tellStrength / streetModifier / stateModifier**（真话浓度公式）、各街段 mix、闪现与冷却、`normalReadFragmentCount` |
| `psychologyActionRules` | ★ 玩家 CRACK 规则（tag × actions × truthIntents × kind） |
| `bossCounterRules` | ★ Boss 反读规则（pattern × 阈值 × bossAction × playerAction） |
| `transitions` | 心理转移表（只有 CRACK：CALM→SHAKEN→EXPOSED） |
| `personality` / `emotions` | DECEIVER 基线；三态行为修正（bluff/agg/variance/…+hint） |
| `gotcha` | `trueRateByDepth`（45→75%）、`flashScale`、泄漏条数 |
| `busted` / `counter` | BUSTED 门槛冷却与本手攻击增益 |

台词池 `server/boss/talk.js`，碎片池 `server/boss/fragments.js`，
CRACK 匹配器 `server/boss/crack-rules.js`。

## 项目结构

```
allin/
├── server/
│   ├── index.js            HTTP：静态 + 6 个 API（无房间、无 LLM、无 SSE）
│   ├── battle.js           战斗编排：READ 限量/批量、PIN、CRACK 验证、
│   │                       GOTCHA 进入与阶梯、自动泄漏、盲注升级、结算与判负
│   ├── balance.json        ★ 全部可调数值（含 CRACK 规则表）
│   ├── engine/
│   │   ├── cards.js / evaluator.js
│   │   ├── duel.js         单挑无限注状态机 + debtMode 负债模式 + 负数守卫
│   └── boss/
│       ├── ai.js           三层决策：Evaluation → Personality(+PlayerModel) → Emotion
│       ├── boss.js         Boss 本体：情绪、台词、BUSTED 增益、决策入口
│       ├── mental.js       三状态情绪机（单向、事件表驱动）
│       ├── fragments.js    碎片池（TRUE 带标签 / NOISE / DISTORTION + trueRate 覆盖）
│       ├── crack-rules.js  ★ 情报×行动 CRACK 匹配器（数据驱动）
│       ├── playermodel.js  玩家行为模型（弃率/习惯/把握度 → BUSTED）
│       └── talk.js         三状态台词池
├── web/                    单屏牌桌（READ 计数、成组闪现、PIN/KNOWN、GOTCHA 行动栏、负债显示）
├── scripts/preview.mjs     UI 预览（canned 全链路演示）
├── docs/PROTOCOL.md        v4 前后端契约
└── test/                   68 个测试（含 Scenario A–I 实测）
```

---

## 信息隔离（测试钉死）

- `view.boss.hole` 恒为 null（摊牌只在 showdown 事件）
- 永不下发：`deck`、`intent`、碎片的 `type/tags/strength`、PIN 的 `type/tags/sourceAction`、
  Player Model、判定中间量
- `readFragments` 每项只有 `{id, text, atHand}`；`pin` 只有 `{text, verified}`
- GOTCHA 判定与 CRACK 匹配只在服务端

---

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | `{ view }` |
| POST | `/api/action` | `{action, amount?}`：NORMAL 用 fold/call/check/pressure/heavy/allin；GOTCHA 用 fold/call/check/raise（省略金额=阶梯） |
| POST | `/api/read` | 批量碎片（限量/冷却：`READ_EXHAUSTED`/`READ_COOLING`） |
| POST | `/api/pin` | `{fragmentId}` 单槽保留（`BAD_FRAGMENT`） |
| POST | `/api/gotcha` | `{}` 进入负债状态（`GOTCHA_NOT_ARMED`/`GOTCHA_LOCKED`） |
| POST | `/api/newgame` | 重开（热加载 balance.json） |

---

## 测试

```bash
npm test    # 65 个
```

- **引擎（19）**：单挑规则全家桶 + 模糊守恒 + **负债模式4例**（上限解除/可为负/
  结算守恒/负数守卫/普通模式回归）
- **评估器（16）**、**Boss 层（17）**：三态情绪表结构、碎片比例与 intent 方向、
  trueRate 覆盖、CRACK 规则三要件、三层权重方向、Player Model（含反读计数器）
- **战斗层（12）**：隐私字段白名单（含窗口/批量/玩家状态）、盲注升级、模式门禁、
  BUSTED、事件契约与守恒、Victory/Defeat 与重开
- **Scenario A–H（8）**：方案 §15 全部检查项 —— Tell Window / 碎片生命周期 /
  Focus / CRACK（含噪音反例）/ 心理≠筹码 / 三态推进与行为影响 / Boss 反读 /
  GOTCHA 窗口条件

所有随机（含洗牌）走注入随机源，整场战斗完全可复现。

---

## 说明

- 单进程单场战斗，状态在内存里；旧版本在提交历史，多人 LLM 牌桌在 `archive/old-prototype`
- 换端口 `PORT=9000`；只绑本机 `HOST=127.0.0.1`

## License

[MIT](LICENSE)
