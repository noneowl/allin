# ♠ ALL IN · 1v1 Poker Boss Battle（原型 v3）

**玩家不是单纯依靠发牌获胜，而是通过读取并利用对手，让自己的判断转化为筹码优势。**

```
打牌 → READ（心理碎片闪现）→ 证据链成立 → CRACK
→ GOTCHA（押注你的判断：BLUFF / STRONG）
   ├─ 判断正确 → EXECUTION：自由下注 + 高速连续 READ 的高压阶段
   └─ 判断错误 → COUNTER：Boss 主动反扑的高压阶段
→ 真实 Poker 结算 → 赢家筹码成长（Effective Stack ↑）→ 盲注升级推向决战
```

**不对称开局**：你 500，Boss（千面 DECEIVER）5000 —— 1:10 的挑战者。
筹码同时是**生命值、战斗资源与唯一成长资源**：

```
赢得筹码 → Effective Stack ↑ → 单手可形成的 Pot ↑ → 能造成的最大伤害 ↑
```

**Boss 筹码归零 = BREAK 胜利**；你的筹码归零 = 失败。
盲注按手数自动升级（10/20 → 160/320），战斗时间越长烈度越高，
最终决战由你自己的成功自然推动产生。

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
npm test                    # 61 个测试
```

---

## 操作

**首次进入会弹出 6 页新手引导**（不对称挑战 → 简化操作 → READ 碎片 → CRACK →
GOTCHA → 三阶段节奏），看过后用行动栏的 **?** 随时重看。

### 普通行动（系统自动算合法金额）

| 按钮 | 含义 |
| --- | --- |
| **FOLD** | 撤退止损 |
| **CALL / CHECK** | 接招 |
| **PRESSURE** | 0.5×当前池 的下注/加注（金额服务端算好并显示） |
| **HEAVY** | 1.0×当前池 的下注/加注 |
| **ALL IN** | 必杀决战 |

EXECUTION 阶段额外开放**自由滑杆**（任意 bet/raise 尺寸）。

### 心理操作

| 按钮 | 什么时候 | 效果 |
| --- | --- | --- |
| **READ** | 任何轮到你的时候，可**连续发动**（400ms 冷却） | 闪现一条 0.5–1.5s 的心理碎片：可能是**真话（TRUE）**、**噪音（NOISE）**、或者**他自己的错觉（DISTORTION）** —— 服务端不标类型，靠你和牌局实况交叉验证 |
| **GOTCHA!** | 出现 **CRACK** 之后 | 押上你的判断：`BLUFF`（他认为你在诈唬/想让你弃）或 `STRONG`（他真有货/在设套）。对 → EXECUTION；错 → COUNTER |

### 碎片 → CRACK → GOTCHA

- 只有**真话**带语义标签（`wants_fold / weak_hand / strong_hand / trap / draw…`）
- 自 Boss 上次进攻以来，累计的相关标签连成**证据链** → `CRACK!`（面板点亮证据）
- **Critical Tell**：单条高强度真话直接成链（低概率高刺激）
- GOTCHA 判定：`BLUFF ↔ intent∈{BLUFF,PROBE}`，`STRONG ↔ intent∈{VALUE,TRAP,CONTROL}`
  —— 映射写在服务端，**Boss 的 intent 永不下发**
- Boss 下一次进攻会作废旧证据与未使用的 CRACK：**机会只属于当下**

### 情绪与 Boss 人格

- 三状态单向：**冷静 😏 → 动摇 😳 → 上头 😡**，由「被看穿」类事件推动
  （被抓诈唬、GOTCHA 命中与连击、输掉大底池/全下）
- 越失控越容易被读：碎片里真话变多、决策方差变大 —— 同时他嘴里的**错觉也变多**，
  不再全是可靠信息
- **DECEIVER 人格**：Bluff High / Aggression M-H / Trap High —— 喜欢制造强势假象、诱导你做判断
- **Player Model + BUSTED!**：他会统计你的弃/跟/压力/READ 习惯；
  把握度足够时宣告专属技 `我看穿你了 —— 全部下注！` 并进入 COUNTER 高压阶段
  （Battle Log 里能看到，但模型本身绝不下发）

HUD 必显：当前牌型、Pot、Call Cost、双方 Stack、**Effective Stack**、盲注级别与下次升级。

键盘：`F` 弃牌 · `C` 过牌/跟注 · `A` 全下 · `↵` 提交加注（EXECUTION）。

---

## 数值调优

**所有可调数值都在 `server/balance.json`**，改完点结局的「重新开始」
（`/api/newgame` 会热加载配置）即生效：

| 区块 | 内容 |
| --- | --- |
| `stacks` | 不对称开局 500 / 5000（比例可调：1:8 / 1:10 / 1:15） |
| `blindSchedule` | 盲注升级表（手数区间 → sb/bb） |
| `read` | READ 冷却、各状态 TRUE/NOISE/DISTORTION 比例、闪现时长、Critical 概率 |
| `cracks.rules` | 证据链规则（all-of 标签组合 → WEAKNESS / STRENGTH） |
| `gotcha` / `counter` / `busted` | 连击阈值、COUNTER 增益、BUSTED 门槛与冷却 |
| `personality` | DECEIVER 基线（bluff 0.35、aggression 0.65、trap 0.2…） |
| `emotions` | 三状态在基线上的偏移 + 每格打法提示 |
| `transitions` | 情绪事件表（单向、概率），结构有测试校验 |
| `sizing` | 价值/诈唬线、注码抖动、PRESSURE/HEAVY 比例 |

台词池 `server/boss/talk.js`，碎片池 `server/boss/fragments.js`。

---

## 项目结构

```
allin/
├── server/
│   ├── index.js            HTTP：静态 + 5 个 API（无房间、无 LLM、无 SSE）
│   ├── battle.js           战斗编排：盲注升级、预设行动、碎片/CRACK/GOTCHA、
│   │                       EXECUTION/COUNTER、Player Model、BUSTED、结算
│   ├── balance.json        ★ 全部可调数值
│   ├── static.js           静态文件服务（含路径穿越防护）
│   ├── engine/
│   │   ├── cards.js        牌与洗牌（注入随机源，可复现）
│   │   ├── evaluator.js    5/6/7 张手牌评估
│   │   └── duel.js         单挑无限注状态机（盲注/四街/最小加注/BB选项/
│   │                       短筹码全下不重开/未跟注退还/自动runout/摊牌分池）
│   └── boss/
│       ├── ai.js           三层决策管线：Poker Evaluation → Personality → Emotion
│       ├── boss.js         Boss 本体：情绪、台词、COUNTER/BUSTED 增益、决策入口
│       ├── mental.js       三状态情绪机（单向、事件表驱动）
│       ├── fragments.js    READ 碎片池（TRUE 带标签 / NOISE / DISTORTION）
│       ├── crack.js        证据链 → CRACK（含 Critical Tell）
│       ├── playermodel.js  玩家行为模型（弃率/习惯/把握度 → BUSTED）
│       └── talk.js         三状态台词池与赢牌台词
├── web/                    单屏牌桌：index.html + battle.css + app.js（事件队列/演出）
├── scripts/preview.mjs     独立 UI 预览服务器（canned 数据）
├── docs/PROTOCOL.md        前后端契约（view / events / 碎片与 GOTCHA 语义 / 演出）
└── test/                   61 个测试
```

---

## 核心机制实现

**三层决策**（`server/boss/ai.js`）

```
Layer 1  Poker Evaluation：蒙特卡洛胜率 / 底池赔率 / Pot / Effective Stack / Street
         → 中性权重 + 机会标记（valueOpp / bluffOpp）
Layer 2  Personality：DECEIVER 压弃、抬加、开诈唬权重
         + Player Model 适应（你 READ 后爱开大 → 他面对高压不再轻易弃）
Layer 3  Emotion：三状态差值 + 方差；COUNTER/BUSTED 增益也从这层进
Final    采样 + 定尺度 → { action, amount, intent }   intent ∈ VALUE|BLUFF|PROBE|TRAP|CONTROL
```

`intent` 是内部剧本信息：READ 碎片按它生成真话、GOTCHA 按它判对错 —— **绝不下发**。

**信息隔离（测试钉死）**

- `view.boss.hole` 恒为 null（摊牌只在 showdown 事件）
- 永不下发：`deck`、`intent`、碎片的 `type/tags/strength`、Player Model、判定中间量
- `readFragments` 每项只有 `{ text, atHand }`；GOTCHA 比对只在服务端
- `test/battle.test.js` 逐字段扫描视图与事件

**盲注升级**：`blindSchedule` 按 `handNo` 分档，`hand_start` 带 `tier/blindUp`，
升档时 feed 记 `BLIND UP`；Effective Stack 实时 = `min(双方)`。

---

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | `{ view }`（首次加载 / 静默刷新） |
| POST | `/api/action` | `{action, amount?}` → `{view, events}`；action ∈ fold/call/check/**pressure/heavy**/allin，bet/raise 仅 EXECUTION |
| POST | `/api/read` | READ 碎片 → `{view, events}`（冷却内 400 `READ_COOLING`） |
| POST | `/api/gotcha` | `{guess: "BLUFF"\|"STRONG"}` → `{view, events}` |
| POST | `/api/newgame` | 重开一场（热加载 balance.json） |

事件流与碎片/GOTCHA 完整语义见 [docs/PROTOCOL.md](docs/PROTOCOL.md)。

---

## 测试

```bash
npm test
```

- **引擎**（15）：盲注与行动顺序、BB 选项、最小加注、短筹码全下不重开、
  未跟注退还、自动 runout、摊牌分池、非法动作拒绝、80 组种子模糊测试筹码守恒
- **评估器/牌**（16）：9 种牌型、轮子顺子、踢脚比较、7 选 5、洗牌
- **Boss 层**（17）：情绪表单向结构校验、概率 1/0、碎片比例（CALM 噪音多 / TILT 真话密集）、
  只有 TRUE 带标签、intent 决定泄漏方向、Critical 与 EXECUTION 提速、证据链成/清/直爆、
  三层权重方向（人格压弃抬加、TILT 更凶更敢接）、采样统计、全下抗性、
  台词池完整、Player Model 习惯识别与把握度
- **战斗层**（13）：隐私扫描（无 intent/tags/类型泄露）、500vs5000 与 Effective Stack、
  盲注分档与升级事件、PRESSURE/HEAVY 金额、EXECUTION 门禁、READ 冷却与双发、
  CRACK→GOTCHA 正确/错误/连击、旧 CRACK 过期、BUSTED、事件契约与筹码守恒、
  Victory/Defeat 路径与重开恢复配置

所有随机（含洗牌）走注入随机源，整场战斗完全可复现。

---

## 说明

- 单进程单场战斗，状态在内存里，重启即清空
- 旧版本已归档：v2 心理战原型在提交历史，多人 LLM 牌桌在分支 `archive/old-prototype`
- 旧的 LLM 配置 `.data/config.json` 不再被读取，可自行删除
- 换端口 `PORT=9000`；只绑本机 `HOST=127.0.0.1`

## License

[MIT](LICENSE)
