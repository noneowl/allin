# ♠ ALL IN · 1v1 Poker Boss Battle（原型 v4）

**玩家不是单纯依靠发牌获胜，而是通过读取并利用对手，让自己的判断转化为筹码优势。**

```
Boss 行动 → READ（每手限量，一次返回一组心理碎片）
→ PIN 保留你认为有用的一条
→ 你做出 Poker Action
→ 系统验证「真话 × 行动 × Boss 当前 intent」→ CRACK
→ 累积 CRACK → GOTCHA：双方解除筹码上限，允许负债下注
→ CALL/RAISE 自动触发心理泄漏（越深越真）
→ FOLD / SHOWDOWN 统一结算 Pot + 债务 → 判定胜负 / 下一手
```

**不对称开局**：你 500，Boss（千面 DECEIVER）5000。筹码 = 生命值 = 战斗资源 =
**唯一成长资源**（赢 → Effective Stack ↑ → 单手 Pot ↑ → 伤害 ↑）。
**Boss 筹码归零 = BREAK 胜利**；你归零（含 GOTCHA 负债结算后 ≤0）= 失败。
盲注按手数升级（10/20 → 160/320），烈度随时间自然推向决战。

```
零 npm 依赖 · 无需构建 · node server/index.js 即可运行
```

---

## 快速开始

```bash
node server/index.js        # 或 npm start，默认 http://localhost:8787
npm run preview             # UI 预览（canned 数据）http://localhost:8791
npm test                    # 68 个测试
```

---

## 核心循环（v4）

### 1. READ 是有限资源

每手 `READ 2/2`（`balance.readUsesPerHand` 可调），耗尽禁用，另有 400ms 冷却。
**一次 READ 返回一组 3–5 条碎片**（数量可配），全部以闪现 + 面板流水呈现。
碎片内部只有三类 —— 真话 / 噪音 / 他自己的错觉 —— **绝不标注类型**，靠你和牌局交叉验证。

### 2. PIN：保留你相信的那一条

每条手工 READ 的碎片都可以 **PIN**（单槽，新覆盖旧），显示在 **Known 📌** 区。
保留位携带服务端元数据（类型/标签/来源），你只看得到文字。

### 3. CRACK = 真实情报 × 正确行动

旧的「碎片组合成链」已废弃。现在 CRACK 表示：
**你拿着真话，在正确的时机做了正确的牌桌动作**。

```
PIN「他害怕我继续加注。」(fear_raise·TRUE) → 你 RAISE → Boss 当前真在忌惮 → CRACK!
PIN「他一定会 Fold。」(DISTORTION·错觉)    → 你 RAISE → 永远不会 CRACK
```

- 规则**数据驱动**：`balance.psychologyActionRules`（11 条起步：`wants_fold×call`、
  `trap×check`、`call_welcome×fold/check`、强侧标签×撤退动作……），匹配器在
  `server/boss/crack-rules.js`
- 必须三者齐备：`TRUE 标签` + `行动命中` + `Boss 当前 intent ∈ truthIntents`
  —— 他再次进攻换意图，旧情报立即失效；NOISE/DISTORTION 无标签天然不通
- 每个 PIN 只兑现一次（打勾 verified）

### 4. GOTCHA：允许负债的高风险状态

本手攒够 `cracksForGotcha`（默认2）个 CRACK → GOTCHA! 点亮 → 进入：

- **解除双方 Stack 上注码上限**：临时余额可以为负（`你: 500 → 300 → -200`），
  直到 FOLD / SHOWDOWN 统一结算 —— **绝不让负数进入下一手的普通阶段**
- **无任何数字输入**：`FOLD / CALL / CHECK / RAISE`，加注金额由**阶梯**给出
  （100 → 200 → 400 → 800…，任意一方完整加注后步长翻倍，风险肉眼升级）
- **Poker Action 就是 READ 的触发器**：任意一方 CALL/RAISE → 自动泄漏一组 Boss 心理碎片
  （4–6 条，比普通 READ 更快更多），**不用手动点 READ**
- **越深越真**：自动泄漏的 TRUE 概率按深度递增 45% → 55% → 65% → 75%（可配）——
  风险越高，他的防线漏得越多
- 结算：退款 → Pot 吸收全部投入（含负债）→ 赢家收取 → `stack ≤ 0` 判负

### 5. Boss 人格与情绪

- 三态单向 **冷静 😏 → 动摇 😳 → 上头 😡**：被抓诈唬、进入 GOTCHA、连续两手上头、
  输大池/全下 推动；越失控碎片里真话越多（同时错觉也越多）
- **DECEIVER**：Bluff High / Aggression M-H / Trap High —— 三层决策管线
  `Poker Evaluation → Personality(+Player Model) → Emotion`
- **Player Model + BUSTED!**：统计你的弃/跟/压力/READ 习惯；把握够了宣告
  「我看穿你了 —— 全部下注！」并**本手**全面提高攻击性（模型本身绝不下发）

HUD 必显：当前牌型、Pot、Call Cost、双方 Stack、**Effective Stack**、盲注档与下次升级。
键盘：`F` 弃牌 · `C` 过牌/跟注 · `A` 全下 · `↵` 提交。

---

## 数值调优（全部在 `server/balance.json`，newgame 热加载）

| 区块 | 内容 |
| --- | --- |
| `stacks` / `blindSchedule` | 500/5000 比例；盲注升级表 |
| `readUsesPerHand` / `normalReadFragmentCount` / `gotchaReadFragmentCount` | READ 限量与批量条数 |
| `read` | 各状态 TRUE/NOISE/DISTORTION 比例、闪现时长、冷却 |
| `pinSlots` / `cracksForGotcha` | PIN 槽位；解锁 GOTCHA 所需 CRACK 数 |
| `psychologyActionRules` | ★ CRACK 规则（tag × actions × truthIntents × kind） |
| `gotcha` | `trueRateByDepth`（45→75%）、`flashScale`、阶梯参数 |
| `personality` / `emotions` / `transitions` | DECEIVER 基线、三态偏移与提示语、情绪事件表 |
| `busted` / `counter` | BUSTED 门槛冷却与本手攻击增益 |

台词池 `server/boss/talk.js`，碎片池 `server/boss/fragments.js`。

---

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
npm test    # 68 个
```

- **引擎（19）**：单挑规则全家桶 + 80 组模糊守恒；**负债模式4例**
  （上限解除/可为负/无 all-in/结算守恒/负数守卫/普通模式回归）
- **评估器（16）**、**Boss 层（17）**：情绪单向结构、碎片比例与 intent 方向、
  trueRate 覆盖、CRACK 规则匹配（三要件逐一断言）、三层权重方向、Player Model
- **战斗层（12）**：隐私字段白名单、盲注升级、模式门禁、READ/PIN、BUSTED、
  GOTCHA 情绪触发与连击、事件契约与守恒、Victory/Defeat 与重开
- **Scenario A–I（9）**：方案 §十七 全部检查项逐一落地

所有随机（含洗牌）走注入随机源，整场战斗完全可复现。

---

## 说明

- 单进程单场战斗，状态在内存里；旧版本在提交历史，多人 LLM 牌桌在 `archive/old-prototype`
- 换端口 `PORT=9000`；只绑本机 `HOST=127.0.0.1`

## License

[MIT](LICENSE)
