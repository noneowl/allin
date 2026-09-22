# ♠ allin · 1v1 德州扑克 Boss 战（最小原型）

**RPG 提供牌桌层面的攻防意义，德州扑克提供心理层面的判断与博弈。**

你不直接施放任何技能 —— 你通过扑克动作完成全部战斗：

```
打牌 → 观察行为 → 读心 → 判断意图 → 用言语影响对手心理
→ 对手打法改变 → 利用变化继续打牌 → 赢走筹码
```

双方各 1000 筹码。筹码同时是下注资源、生命值、战斗进度与风险资源：

- **Boss 筹码归零** → `BREAK`，战斗胜利
- **玩家筹码归零** → 战斗失败

Boss **千面（🎭 欺骗型）** 全部使用脚本决策：高频率诈唬、用语言制造强势假象、
害怕被认为胆小、被连续看穿后会急躁上头。他的心理状态 `CALM → SHAKEN → TILT → BREAKING`
由你的每一次识破推动，而状态变化会真实地改变他的下注频率、注码尺度与弃牌阈值 ——
最后通过筹码结算你制造出的错误。

```
零 npm 依赖 · 无需构建 · node server/index.js 即可运行
```

---

## 快速开始

```bash
node server/index.js        # 或 npm start，默认 http://localhost:8787
```

打开浏览器即是单屏牌桌。想看 UI 不打服务端（canned 数据演示）：

```bash
npm run preview             # http://localhost:8791
```

测试：

```bash
npm test                    # 59 个测试
```

---

## 操作

| 扑克动作 | 战斗语义 |
| --- | --- |
| Bet / Raise | 攻击、施压 |
| Call | 防御、接招、抓诈唬 |
| Check | 示弱、诱敌、等待反击 |
| Fold | 撤退、止损 |
| All-in | 必杀、高风险决战 |

牌桌之外还有三个**心理操作**（每手各限次数）：

| 操作 | 效果 |
| --- | --- |
| **READ**（×2/手） | 返回一条模糊的心理信息：情绪与倾向，不是答案。牌力判断永远由你完成 |
| **挑衅** | Boss 攻击性↑、加注与诈唬频率↑、注码变大。动摇后效果显著，上头后极强 |
| **质疑** | 攻击言行不一/前后矛盾。命中即触发 `CALM→SHAKEN / SHAKEN→TILT` 级联 |
| **施压** | Boss 跟注意愿↓、弃牌意愿↑。用于掩护自己的诈唬，动摇/崩坏期效果明显 |

**异议窗口**：检测到真实矛盾时，Boss 的台词播放期间会出现红色「异议！」按钮
（带倒计时）。窗口内点击成功 → Hitstop + 打击演出 + 心理状态恶化。
窗口只在服务端判定为真矛盾时开启，真假判定绝不下发到客户端。

### 心理状态如何被感知

- 头像表情/配色/标签：冷静 😏 → 动摇 😳 → 上头 😡 → 崩坏 🤯
- 台词池随状态切换（CALM 克制 → SHAKEN 嘴硬 → TILT 攻击性 → BREAKING 泄露真实情绪）
- 下注行为真实变化：诈唬率 20% → 30% → 45%+，注码 +30%，弃牌阈值下降，
  崩坏后每次决策随机抽取「异常激进 / 异常保守 / 混乱」三种失控模式
- READ 在后期更清晰（BREAKING 的他藏不住事）
- 归零时播放最终 Heart：*“我只是……不想承认你真的看穿我了。”* → **BREAK**

键盘：`F` 弃牌 · `C` 过牌/跟注 · `R` 聚焦加注 · `A` 全下 · `Enter` 提交加注。

---

## 数值调优

**所有可调数值都在 `server/balance.json`**，改完点结局画面的「重新开始」
（`/api/newgame` 会热加载配置）即生效，无需重启：

| 区块 | 内容 |
| --- | --- |
| `stacks` / `blinds` | 双方筹码 1000、盲注 5/10（100BB 深筹码，给翻后心理战留空间） |
| `personality` | 行为基线：normalBetSize 0.7 池、bluffFrequency 20%、aggression… |
| `mentalModifiers` | 四状态在基线上的偏移（bluff/betSize/foldThreshold/risk/variance/lineBias…） |
| `breakingModes` | 崩坏期三种失控模式的权重与幅度 |
| `transitions` | 心理事件 → 状态转移表（`BLUFF_CAUGHT`、`CONTRADICTION_EXPOSED`、`BIG_POT_LOST`…），只升不降 |
| `speechEffects` | 三个言语技能的权重影响 × 各状态系数 |
| `contradiction` | 注码分档、言行不一判定、行为矛盾超池阈值、异议窗口时长 |
| `read` / `speech` | 每手 READ 与言语次数 |

台词池在 `server/boss/talk.js`，READ 池在 `server/boss/reads.js`。

---

## 项目结构

```
allin/
├── server/
│   ├── index.js            HTTP：静态 + 6 个 API（无房间、无 LLM、无 SSE）
│   ├── battle.js           战斗编排：手牌流转、台词/矛盾/异议、READ/言语、结算
│   ├── balance.json        ★ 全部可调数值
│   ├── static.js           静态文件服务（含路径穿越防护）
│   ├── engine/
│   │   ├── cards.js        牌与洗牌
│   │   ├── evaluator.js    5/6/7 张手牌评估
│   │   └── duel.js         单挑无限注状态机（盲注/四街/最小加注/BB选项/
│   │                       短筹码全下不重开/未跟注退还/自动runout/摊牌分池）
│   └── boss/
│       ├── boss.js         Boss 本体：状态、Buff、台词、READ、决策入口
│       ├── ai.js           决策：蒙特卡洛胜率 + 权重 + 人格基线 + 状态修正
│       ├── mental.js       离散心理状态机（事件驱动、只升不降、躁动累积）
│       ├── talk.js         台词池 + 行话选词（lineBias 主动制造矛盾）
│       └── reads.js        READ 读心台词池
├── web/                    单屏牌桌：index.html + battle.css + app.js（事件队列/演出）
├── scripts/preview.mjs     独立 UI 预览服务器（canned 数据）
├── docs/PROTOCOL.md        前后端契约（view / events / 演出要求）
└── test/                   59 个测试
```

---

## 核心机制实现说明

**决策系统**（`server/boss/ai.js`）

```
action = f(蒙特卡洛胜率, 底池赔率, 人格基线, MentalState 修正, 言语Buff, 随机权重)
         → { action, amount, intent }    intent ∈ VALUE|BLUFF|PROBE|TRAP|POT_CONTROL
```

`intent` 是内部剧本信息：用于选台词、生成 READ 提示、矛盾检测 —— **从不下发给客户端**。

**两类矛盾**（`server/battle.js`）

1. **言行不一**：台词的 claim（示弱/中性/放狠话）与实际注码档位（<0.35 / <0.55 / <0.95 / <1.5 / 超池）
   明显不符。Boss 在 SHAKEN 之后 `lineBias` 提高 —— 他会越来越频繁地说一套下一套。
2. **前后矛盾**：本手此前每一条街都在示弱，却在转牌/河牌突然超池开火。

检测到矛盾 → 播台词 → 开异议窗口。**异议点击成功 = 窗口必然有效**
（无效窗口根本不会开）；窗口过期后仍可用「质疑」追打这条矛盾。

**心理事件 → 状态转移**（`balance.json → transitions`）

`BLUFF_CAUGHT` / `PLAYER_BLUFF_SUCCESS` / `CONTRADICTION_EXPOSED` /
`LANGUAGE_WEAKNESS_HIT` / `BIG_POT_LOST` / `ALL_IN_LOST` / `CONSECUTIVE_READ_SUCCESS`
→ 按当前状态查表判定（失败会累积「躁动」提高下一次成功率，连续打击终会见效）。

**信息隔离**

- `view` 里没有：Boss 底牌（摊牌事件除外）、牌堆、intent、claim、矛盾判定
- 异议窗口只含 `{id, deadline, line}`，真假由服务端点击时裁决
- 测试逐字段扫描视图与事件，钉死这条边界（`test/battle.test.js`）

---

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | `{ view }`（仅首次加载 / 静默刷新） |
| POST | `/api/action` | `{action, amount?}` → `{view, events}` |
| POST | `/api/read` | READ → `{view, events}` |
| POST | `/api/speak` | `{skill: taunt\|challenge\|pressure}` → `{view, events}` |
| POST | `/api/object` | `{id}` 异议 → `{view, events, ok, reason?}` |
| POST | `/api/newgame` | 重开一场（热加载 balance.json） |

事件流（打字机台词、异议倒计时、打击演出、筹码飞行的播放顺序）见
[docs/PROTOCOL.md](docs/PROTOCOL.md)。

---

## 测试

```bash
npm test
```

- **引擎**（15）：盲注与行动顺序、BB 选项、最小加注、短筹码全下不重开、
  未跟注退还、自动 runout、摊牌分池、非法动作拒绝、80 组种子 ×10 手模糊测试筹码守恒
- **心理层**（17）：状态转移表只升不降、躁动累积、注码分档与言行不一判定、
  lineBias 选词、台词/READ/言语池完整性、**统计断言**（挑衅后 Raise↑、施压后 Fold↑、
  TILT 比 CALM 更敢演注更大、TILT 更愿意接全下）
- **战斗**（11）：视图隐私扫描、门禁与次数、异议命中/过期/重复点击、质疑落空与命中、
  有机矛盾必现、庄家轮换与自动下一手、事件契约校验、整场战斗（筹码守恒 + 终局 Heart + 重开）、
  战败分支、心理事件通路烟测
- **评估器/牌**（16）：9 种牌型、轮子顺子、踢脚比较、7 选 5、洗牌

---

## 说明

- 单进程单场战斗，状态在内存里，重启即清空；所有随机（含洗牌）走注入的随机源，测试完全可复现
- 旧版本（多人 LLM 牌桌原型）已归档在分支 `archive/old-prototype`
- 旧的 LLM 配置 `.data/config.json` 不再被读取，可自行删除
- 想换端口：`PORT=9000 node server/index.js`；只绑本机：`HOST=127.0.0.1`

## License

[MIT](LICENSE)
