# 《allin》原型 · 前后端契约

单屏 1v1 Boss 战。服务端权威（底牌、牌堆、Boss 意图、心理状态全部只在服务端），
浏览器只拿「玩家视角 + 事件流」。无 SSE：每次玩家操作的响应里带上从上一次响应以来的全部事件，
客户端负责按节奏播放动画。

座位号：`0 = 玩家`，`1 = Boss`。

## HTTP 接口

| 方法 | 路径 | 请求体 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/state` | — | `{ view }` |
| POST | `/api/action` | `{ action, amount? }` | `{ view, events }` |
| POST | `/api/read` | — | `{ view, events }` |
| POST | `/api/speak` | `{ skill: "taunt" \| "challenge" \| "pressure" }` | `{ view, events }` |
| POST | `/api/object` | `{ id }` | `{ view, events, ok, reason? }` |
| POST | `/api/newgame` | — | `{ view, events }` |

`action ∈ check | call | bet | raise | fold | allin`；`bet/raise` 的 `amount` 语义是
**raise-to**（本街投入总计），服务端夹取到合法区间。非法操作返回 400 `{ error, code }`。

**门禁（服务端强制，前端只负责展示次数/可用性）**：

- `action` / `read` / `speak` 要求 `phase === 'playing'` 且 `toAct === 0`；
  次数不足返回 `NO_READS` / `NO_CHARGES`，非法 skill 返回 `BAD_SKILL`。
- `object` 只要窗口还开就能点（不要求轮到玩家）；失败 `reason ∈ stale | resolved | late`，
  其中 `stale/resolved` 会顺带作废窗口（客户端不应再等它）。
- `newgame` 随时可用，并**热加载 `server/balance.json`**。

## view（玩家视角，可安全整体渲染）

```jsonc
{
  "phase": "playing" | "victory" | "defeat",
  "handNo": 7,
  "street": "preflop" | "flop" | "turn" | "river",
  "pot": 240,
  "board": ["As", "Kd", "2c"],          // 0..5 张
  "button": 0,                            // 庄家（0=玩家，1=Boss）
  "toAct": 0,                             // 轮到谁，null = 无行动（结算中）

  "player": {
    "chips": 940, "bet": 40,             // bet = 本街已投入
    "hole": ["As", "Th"],
    "toCall": 60,                         // 面临下注还差多少
    "legal": {                            // 行动栏按钮可用性与数值
      "check": false, "call": 60, "fold": true,
      "bet": false, "raise": true,
      "minTo": 160, "maxTo": 940,         // raise-to 区间（bet 时同样适用）
      "allin": 940
    },
    "readsLeft": 2,                       // 本手剩余 READ 次数
    "speech": { "taunt": 1, "challenge": 1, "pressure": 1 },  // 本手剩余次数
    "canChallenge": false                 // 手里有可追打的破绽（质疑按钮的点亮依据，不泄露细节）
  },

  "boss": {
    "chips": 1060, "bet": 60,
    "hole": null,                          // 仅摊牌时为 ["9c","9d"]，其余时候 null
    "state": "CALM" | "SHAKEN" | "TILT" | "BREAKING" | "HOT" | "FLOW",
    "face": "😏",                          // 状态表情（六状态各一个，服务端给）
    "mood": "冷静",                         // 冷静|动摇|上头|崩坏|得意|神了
    "stateHint": "冷静难读、也不送分 —— …",   // 当前状态的打法含义（情绪刻度下的说明行）
    "effects": [                           // 言语命中的倾向贴纸（效果耗尽即消失）
      { "kind": "taunt", "icon": "🔥", "label": "被激怒", "desc": "他更想加注、注更大" }
    ],
    "lastAction": { "action": "raise", "amount": 120, "street": "flop" },  // street 是 READ 时机高亮的依据
    "lastLine": "这一手，你最好别碰。"        // 最近一句台词（刷新页面后用于重建气泡）
  },

  "objection": {                           // 当前仍可点击的异议窗口；过期为 null
    "id": 3, "deadline": 1730000000000,    // 毫秒时间戳（服务端时钟）
    "line": "这一手你最好直接弃。"
  },

  "reads": [{ "text": "他似乎非常期待你弃牌。", "lean": "fold", "leanLabel": "他想让你弃牌" }],
  //   ↑ 最近 3 条，reads[0] 最新。lean 是「他希望你出什么牌」的判断轴（fold/call/trap/unsure），
  //     不是答案；雾化/状态线/势头线 lean=null
  "history": [                              // 本手+历史行动记录，服务端截断到 60 条
    { "handNo": 7, "street": "preflop", "actor": "boss", "action": "raise", "amount": 120 }
  ],
  "feed": [                                 // 右侧信息栏持久内容，截断 100 条，按时间顺序追加
    { "kind": "talk", "text": "…" },        // kind: talk | read | mental | contradiction
                                             //       | objection | speech | hand | system
    { "kind": "hand", "text": "第 7 手 · 底池 240 → 你赢得 240" }
  ]
}
```

**硬约束（有测试钉死）**：

- `view.boss.hole` 非 null 只可能出现在摊牌后（`phase !== 'playing'` 或该手已结算）；
- `view` 里永远没有 `deck`、`intent`、`claim`、`contradiction`、Boss 内部权重等字段；
  字符串值经精确比对，Boss 底牌不会以任何形式出现（含 `toAct` 这类子串误报的坑）；
- 破绽窗口（wire 字段名仍为 `objection*`）只有 `id / deadline / line`，
  **是否真的构成矛盾由服务端点击时判定**，无效窗口根本不会开；
- 矛盾检测只针对真正的攻击动作（bet / raise / allin）——跟注与溜入永远不构成「言行不一」；
- 心理状态是**六格双向刻度**（`SCALE = FLOW·HOT·CALM·SHAKEN·TILT·BREAKING`）：
  赢钱事件可回血（`BIG_POT_WON`/`ALL_IN_WON`/`WIN_STREAK`），打击事件向下，
  抓千/言语类事件永不回血；HOT 有输钱护甲、FLOW 对言语免疫且 READ 雾化。
- 用户可见文案里「异议」已改称「抓千 / 破绽」，但事件类型与字段名保持稳定。

## events（按顺序播放的动画队列）

每次 POST 响应附带自上次响应以来的事件。客户端应当**串行、按节奏**播放，
播放期间禁用行动按钮，播完再渲染 `view.legal`。

```jsonc
{ "type": "hand_start",  "handNo": 7, "button": 0 }
{ "type": "blinds",      "seat": 1, "amount": 10, "potAfter": 30 }
{ "type": "action",      "seat": 1, "action": "raise", "amount": 120, "put": 110, "potAfter": 240, "allIn": false }
{ "type": "street",      "street": "flop", "cards": ["As","7d","2c"] }   // turn/river 每次 1 张
{ "type": "talk",        "line": "这一手，你最好别碰。" }                 // Boss 台词（打字机）
{ "type": "read",        "text": "他似乎非常期待你弃牌。",
                         "lean": "fold", "leanLabel": "他想让你弃牌" }    // READ 结果 + 倾向标签
{ "type": "speech",      "skill": "taunt", "result": "hit" | "resist" | "whiff",
                         "line": "就这点胆子？" }                         // Boss 对言语的回应
{ "type": "mental",      "from": "CALM", "to": "SHAKEN", "cause": "BLUFF_CAUGHT",
                         "causeName": "诈唬被抓",
                         "hint": "动摇 · 漏话变多……", "down": true }
// ↑ 六状态双向转移；hint = 新状态的打法含义（横幅副标题），down=false 表示回血（向好，▲）          // causeName 是中文，优先用于展示
{ "type": "contradiction","id": 3, "kind": "spoken_vs_bet" | "behavior" } // 检测到矛盾（先于 objection_open）
{ "type": "objection_open", "id": 3, "deadline": 1730000000000, "line": "…", "windowMs": 2400 }
{ "type": "objection_result", "id": 3, "success": true,
    "kind": "spoken_vs_bet",
    "transition": { "from": "CALM", "to": "SHAKEN" },
    "hint": "动摇 · 漏话变多……" }                                // success=false 时 transition=null
{ "type": "showdown", "hands": [{ "seat": 0, "hole": ["As","Th"], "handName": "两对", "winner": true },
                                 { "seat": 1, "hole": ["9c","9d"], "handName": "一对", "winner": false }],
                      "split": false }
{ "type": "fold_win", "winner": 1 }
{ "type": "pot_move",  "to": 0, "amount": 240 }        // 筹码飞向赢家
{ "type": "hand_end",  "handNo": 7, "winner": 0, "pot": 240,
                       "stacks": { "player": 1240, "boss": 760 },
                       "bluffCaught": true }            // Boss 诈唬被抓（触发打击演出）
{ "type": "game_over", "phase": "victory", "heart": "我只是……不想承认你真的看穿我了。" }
```

事件永远按真实发生顺序返回；`hand_start`（下一手）总在上一手的
`hand_end / showdown / pot_move` 之后。客户端在 `hand_end` 处留出结算演出时间，
再继续播放 `hand_start` 起的新手事件。

## 演出要求（§19 打击反馈）

| 触发 | 演出 |
| --- | --- |
| `objection_result(success)` | Hitstop → 头像震动 → 屏幕轻震 → 白闪 → 「抓千成功！CAUGHT」弹字 → 音效 |
| `hand_end(bluffCaught)` | 同上，弹字「READ SUCCESS / 抓到诈唬」 |
| `mental` | 状态横幅：副标题 = `hint`（新状态的行为后果）；`down` 用打击音+深色，回血用明亮音+绿色横幅；情绪刻度当前格切换 |
| `contradiction` | **三拍第三拍**：心跳两声、台词气泡与 Boss 注码同时发红脉冲、牌桌压暗进入屏息态；首次出现触发教学定格（localStorage 一次性） |
| `pot_move` | 底池数字飞向赢家筹码，输家筹码倒数减少 |
| `allin` 动作 | 牌桌轻微 zoom，`showdown` 手牌逐张翻开，逐张音效 |
| `speech(result=hit)` | Boss 身上出现倾向贴纸（🔥被激怒 / ⛓被压制，持续到 Buff 耗尽） |
| READ 事件 | 台词打字机 + 倾向标签 chip + 行动栏「你信吗？」问句（下次行动收起） |

## 节奏建议（客户端自行掌握）

- Boss 行动事件前停 0.8–1.4s（思考感）；行动本身 0.5s。
- 台词打字机 ≈ 28ms/字；异议窗口 = 打字机结束 + 1.6s（服务端 `deadline` 为准，窗口显示倒计时；
  服务端 deadline 含 ≈3.2s 的播放排队余量，点击校验另给 900ms 宽限）。
- 公共牌逐张 0.45s；`hand_end` 结算横幅 ≈ 2.2s 后再播下一手。
- `game_over` 的 `heart` 对 victory 与 defeat 都存在（各自的临终台词），
  先打字机播完再显示大标题。
