# ♠ 德州扑克 · LLM 对手

一个可以直接在浏览器里玩的无限注德州扑克（No-Limit Texas Hold'em）。
**牌桌上的每一个 AI 对手都由真实的大语言模型扮演和操作** —— 默认接入
[OpenCode Go](https://opencode.ai/docs/go/)，也支持任意 OpenAI 兼容端点。

```
零 npm 依赖 · 无需构建 · node server/index.js 即可运行
```

---

## 快速开始

```bash
cd dezhou
node server/index.js          # 或 npm start
```

打开 <http://127.0.0.1:8787>，点右上角 **设置**，填入供应商信息即可开局。

> 想先看看界面长什么样？在设置里选 **「离线演示（非 LLM）」**，
> 不需要 API Key 就能立刻打一局。**这只是界面预览**，不是真正的 AI —— 见下文说明。

---

## 接入 OpenCode Go

[OpenCode Go](https://opencode.ai/docs/go/) 是 $10/月的订阅，提供一批主流开源模型的稳定访问。

1. 到 <https://opencode.ai/auth> 订阅 Go 计划并复制 API Key
2. 打开游戏的 **设置 → AI 供应商 → OpenCode Go**
3. 粘贴 API Key，选模型，点 **测试连接**
4. 保存

已经内置好了，无需手填地址：

| 项目 | 值 |
| --- | --- |
| Base URL | `https://opencode.ai/zen/go/v1` |
| 默认模型 | `glm-5.3-flash` |

### 三种协议自动切换

OpenCode Go 的模型分布在三种不同的 wire protocol 上，本作会**根据模型 ID 自动选择正确的端点**，
不需要你手动配置：

| 协议 | 端点 | 典型模型 |
| --- | --- | --- |
| OpenAI 兼容 | `/chat/completions` | `glm-5.3-flash`、`deepseek-v4.1-flash`、`kimi-k2.6`、`mimo-v2.5`、`hy3` |
| OpenAI Responses | `/responses` | `grok-4.6`、`gpt-5.6-luna`、`muse-spark-1.3-contributor` |
| Anthropic Messages | `/messages` | `qwen3.8-max`、`qwen3.8-flash`、`minimax-m3`、`minimax-m2.7` |

同时按 OpenCode 的要求发送 `x-opencode-session` 会话头（用于路由与 prompt 缓存）
和自定义 `User-Agent`（`dezhou-poker/1.0`）。

### 推荐模型（打牌够用且便宜）

| 模型 | 说明 |
| --- | --- |
| `glm-5.3-flash` | 默认。快、便宜、结构化输出稳 |
| `deepseek-v4-flash` | 便宜，JSON 稳定 |
| `deepseek-v4.1-flash` | 推理更好，仍然很便宜 |
| `mimo-v2.5` | 延迟最低 |
| `qwen3.8-flash` | 综合均衡 |
| `longcat-2.0` | 便宜、上下文大 |

一局 5 人桌大概每手牌会产生 8–20 次请求。想省钱就用 Flash 级别的模型。

### 其他供应商

设置面板里还内置了 **OpenCode Zen、DeepSeek 官方、OpenRouter、本地 Ollama、任意 OpenAI 兼容端点**。
选「OpenAI 兼容端点」后自己填 Base URL + 模型名即可（vLLM、LM Studio、one-api 等都能用）。

### 环境变量（可选）

环境变量优先级高于设置面板里保存的值，适合不想把 Key 写进磁盘的场景：

```bash
export OPENCODE_GO_API_KEY=sk-...        # 或 OPENCODE_API_KEY
export DEZHOU_PROVIDER=opencode-go       # 供应商 id
export DEZHOU_BASE_URL=https://opencode.ai/zen/go/v1
export DEZHOU_MODEL=glm-5.3-flash
export PORT=8787
node server/index.js
```

配置保存在 `.data/config.json`（已 gitignore）。**API Key 只存在服务端**，
浏览器拿到的永远是掩码后的 `sk-a••••z9`。

---

## AI 是怎么决策的

这是本作最重要的设计约束：**没有本地启发式引擎**。

- 轮到 AI 行动时，服务端把完整的牌局状态序列化成结构化文本，连同该角色的性格设定一起发给 LLM
- LLM 必须返回严格 JSON：`{action, amount, reasoning, table_talk}`
- 服务端用 `Table.normalizeAction()` 校验动作合法性，非法就把错误回喂给模型重试（最多 3 次）
- 不同对手有**不同的性格设定**（紧凶 / 松凶 / 数学派 / 欺骗型 / 岩石 / 跟注站 / 稳健），
  所以打法差异是模型演出来的，不是本地参数调出来的

只有两种情况下不走 LLM，且都不构成"策略决策"：

1. **规则推导**：无需跟注、又不能下注时，只有"过牌"一个非弃牌选项 —— 没有决策可做，直接过牌
2. **故障兜底**：供应商彻底不可达时，取免费选项（能过牌就过牌，否则弃牌），并在牌桌实况里
   **红色高亮标注决策失败**，绝不伪装成正常决策

### 关于「离线演示（非 LLM）」

设置里的 `离线演示` 是一个明确标注的假 AI，用来在没有 Key 时预览界面。
它**不是** LLM，也**不是**默认选项，正常游玩请使用 OpenCode Go 或其他真实供应商。

### 桌边话

每个 AI 会输出 `table_talk`，以 `伊万：「这个注太小了，我加。」` 的形式出现在右侧实况栏里。
可以在设置里关掉。

---

## 牌桌功能

**引擎（完全实现，不是简化版）**

- 2–6 人桌，按钮位轮转，短筹码自动出局
- 无限注下注：最小加注跟踪、**短筹码全下不重开加注**、不足跟注的全下按跟注处理
- 完整的**边池**计算：多层 all-in 正确切分主池/边池，奇数筹码按庄家左手方向分配
- 未被跟注的下注自动退还
- 7 选 5 手牌评估（21 种组合），含 A-2-3-4-5 轮子顺子、轮子同花顺
- 筹码守恒：60 组种子 × 12 手随机模糊测试全程校验

**界面**

- 椭圆牌桌：木质围栏 + 毛毡 + 金色内圈虚线，座位沿椭圆自动布局（2–6 人自适应）
- 真实的牌面：标准点数布局（10 的十字排列、J/Q/K 宫廷框、下半个花色倒置）
- 发牌/翻牌 3D 动画，AI 底牌在摊牌时**原地翻转**而不是替换 DOM
- 筹码堆按面额配色，加注滑杆 + 1/2 池 / 3/4 池 / 1 池 / 全下 快捷键
- 右侧实况栏：行动日志 + AI 思考气泡（含耗时和推理原文）+ 桌边话
- 键盘快捷键：`F` 弃牌、`C` 过牌/跟注、`R` 加注、`A` 全下、`空格` 下一手
- 零音频资源：所有音效用 Web Audio 现场合成

---

## 项目结构

```
dezhou/
├── server/
│   ├── index.js              HTTP 服务：静态文件 + REST + SSE
│   ├── config.js             配置读写（默认值 ← 文件 ← 环境变量）
│   ├── game.js               对局控制器：串行化状态变更 + AI 回合循环
│   ├── sessions.js           每个浏览器会话一张桌子
│   ├── static.js             静态文件服务（含路径穿越防护）
│   ├── engine/
│   │   ├── cards.js          牌、洗牌（crypto 无偏 Fisher-Yates）
│   │   ├── evaluator.js      5/6/7 张手牌评估
│   │   ├── pots.js           主池/边池切分 + 无人可赢筹码的退还
│   │   └── table.js          无限注德州扑克状态机
│   ├── ai/
│   │   ├── personalities.js  7 个 AI 角色设定
│   │   ├── prompt.js         系统提示 + 局面序列化
│   │   ├── agent.js          JSON 解析、合法性校验、失败重试
│   │   └── mock.js           离线演示用的假 AI（非 LLM）
│   └── providers/
│       ├── catalog.js        供应商预设 + Go 模型表
│       ├── wire.js           三种协议 + 错误处理
│       └── index.js          连接测试 / 模型列表
├── web/
│   ├── index.html
│   ├── css/                  tokens / layout / cards / table / hud / dialog
│   └── js/                   app / api / tableView / hud / settings / cards / ...
└── test/                     43 个测试
```

---

## 测试

```bash
npm test
```

```
ℹ tests 43
ℹ pass 43
ℹ fail 0
```

覆盖：

- **评估器**：9 种牌型分类、轮子顺子是最弱顺子、踢脚比较、7 选 5
- **边池**：单池、一层边池、多层边池、弃牌筹码留在池中、无人可赢的层被退还
- **状态机**：盲注、单挑时按钮位下小盲、大盲最后行动权、最小加注、
  短筹码全下不重开加注、超额下注退还、边池分配、按钮轮转
- **模糊测试**：60 个种子 × 每个 12 手随机合法动作，全程校验筹码守恒、无负筹码、牌局必定终止
- **供应商协议**：三种 wire protocol 的 URL / 请求头 / 请求体 / 响应解析、
  `x-opencode-session` 会话头、`max_tokens` 被拒后改用 `max_completion_tokens` 重试、
  401 错误透传、模型列表解析

---

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/bootstrap` | 配置（Key 已掩码）+ 供应商目录 + 角色名单 + 当前状态 |
| GET | `/api/events` | SSE 事件流（`state` / `ai_start` / `ai_done` / `ai_error` / `toast`） |
| GET | `/api/models` | 从供应商拉取模型列表 |
| POST | `/api/config` | 保存设置 |
| POST | `/api/config/test` | 连通性测试 |
| POST | `/api/game/new` | 建桌开局 |
| POST | `/api/game/action` | 人类行动 `{action, amount}` |
| POST | `/api/game/next` | 下一手 |
| POST | `/api/game/retry` | 重试当前 AI 决策 |
| POST | `/api/game/cancel` | 取消进行中的 AI 请求 |

`amount` 的语义是 **raise-to**：你希望自己在本街投入的**总金额**，不是本次增量。
提示词里对模型也是这么约定的，服务端会再夹取到合法区间。

---

## 说明

- 这是一个本地单机游戏，会话按 Cookie 隔离，数据只存在内存里，重启即清空
- AI 每次决策需要一次真实的 LLM 请求，所以每步大约有 1–5 秒延迟（取决于模型）
- 想让节奏更快，选 `mimo-v2.5` / `glm-5.3-flash` 这类 Flash 模型，或把 `maxTokens` 调小
