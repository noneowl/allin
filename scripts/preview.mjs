#!/usr/bin/env node
/**
 * scripts/preview.mjs — 《allin》前端独立预览服务器（v5 · Tell Window 编排）
 *
 *   node scripts/preview.mjs              # 默认端口 8791（静态托管 web/ + canned API）
 *   PORT=9000 node scripts/preview.mjs    # 端口覆盖
 *   PREVIEW_DEMO=victory node ...         # 预设结局走向（可被 newgame 请求体覆盖）
 *   node scripts/preview.mjs --selftest   # 自测驱动：临时端口起服 → 3 轮全场景断言 → 关服退出
 *
 * 职责：
 * 1. 静态托管 web/（无构建、原生 ES Modules）；
 * 2. 实现 docs/PROTOCOL.md（v5）的 6 个 API，返回精心编排的 canned 数据，
 *    用于在没有真实服务端时自查全部 UI 分支：
 *    - Tell Window：Boss 每完成一个行动且 toAct 回到玩家 → 开窗（tell_window_open 事件 +
 *      view.tellWindow）；玩家任何成功行动 → 关窗 + 无条件清空 readFragments / pin（一窗一批）；
 *    - Focus：翻前 0，进 flop/turn/river 各 +1，上限 2，每手归 0；READ 消耗 1 + 400ms 冷却；
 *      READ 错误码顺序（selftest 镜像同一顺序）：
 *      BATTLE_OVER → GOTCHA_AUTO_READ → NO_TELL_WINDOW（未轮到你）→ NO_FOCUS →
 *      NO_TELL_WINDOW（无窗口）→ READ_COOLING；
 *    - 碎片窗口归属：id = `w{tellWindowId}f{n}`，view.readFragments 带 tellWindowId；
 *      跨窗口旧 id PIN → BAD_FRAGMENT；
 *    - 三态心理：CRACK / 进入 GOTCHA 推进 CALM → SHAKEN → EXPOSED（cause ∈ CRACK|GOTCHA_HIT，
 *      赢输底池不再触发任何情绪）；玩家侧对称（player_cracked → player_mental）；
 *    - Boss 最小反读：bossCounterRules 三条（数据驱动），窗口开启时按 Boss 行动档位布陷阱
 *      （本预览把 Tell 强度档位直接写进 tellWindow.bossAction：check < bet < raise < heavy …，
 *      heavy = put ≥ 1×池；真实服务端可只发引擎行动，前端对任意字符串都可显示）；
 *      保底计数 seeds 卡在阈值上（foldsToHeavy=2 / callsFaced=3 / lostAsAggressor=2），
 *      未触发的规则会主动「制造匹配行动」→ 三条 PLAYER CRACKED 都可稳定复现；
 *    - GOTCHA 窗口 = 资格 × 时机（mode NORMAL + EXPOSED + 转/河 + Boss 同街高承诺 + 玩家回合），
 *      view.gotcha = { street, bossAction }；进入后的负债、阶梯 RAISE、心理泄漏、统一结算沿用 v4；
 *    - 演示保底：EXPOSED 后按 negStreet(flop 重注反例) → negAction(转/河过牌反例) →
 *      positive(转/河高承诺点亮) 顺序强制 Boss 行动，保证正反例都可断言。
 * 3. `--selftest`：node 直连本服务的驱动脚本（写在同一文件里），按上面清单把
 *    全部场景断言走通 ×3 轮，结束时关闭监听、退出码非 0 即失败。
 *
 * ⚠️ 这是「编排好的演示服务端」，不是真实规则引擎 —— 一切以驱动 UI 为目的。
 * 预览专属扩展（真实服务端可以不实现，前端不依赖）：
 *   - POST /api/newgame 请求体可带 { demo: "victory" | "defeat" } 预设结局走向；
 *   - tellWindow.bossAction 携带 Tell 强度档位（含 heavy）；
 *   - Boss 反读计数保底、EXPOSED 演示强制行动、破产保底胜率。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(__dirname, '..', 'web');
const PORT = Number(process.env.PORT) || 8791;
const SELFTEST = process.argv.includes('--selftest');
const PREVIEW_DEMO = ['victory', 'defeat'].includes(process.env.PREVIEW_DEMO)
  ? process.env.PREVIEW_DEMO
  : null;

/* ------------------------------------------------------------ 静态文件 */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/* ------------------------------------------------------------ canned 常量 */

const START_PLAYER = 500;        // 不对称挑战：500 vs 5000
const START_BOSS = 5000;
const READ_COOLDOWN_MS = 400;    // 契约：READ 冷却（冷却内再读 400 READ_COOLING）
const FOCUS_MAX = 2;             // focus.max
const FOCUS_COST = 1;            // focus.cost
const STREET_GRANT = { flop: 1, turn: 1, river: 1 }; // focus.streetGrant
const NORMAL_BATCH = [3, 5];     // normalReadFragmentCount：一次 READ 3–5 条
const GOTCHA_BATCH = [4, 6];     // gotchaReadFragmentCount：泄漏 4–6 条
const LEAK_TRUE_RATE = [0.45, 0.55, 0.65, 0.75]; // gotcha.trueRateByDepth（depth 1..4+）
const LEAK_FLASH_K = 0.6;        // gotcha.flashScale
const HEAVY_FRAC = 1.0;          // sizing.heavyFrac：put ≥ 1×池 → Tell 档位 heavy
const DUEL_START_HAND = 7;       // 第 7 手起 Boss 进入「全下决胜」节奏（NORMAL 演示用）

const FACES = {
  CALM: ['😏', '冷静'],
  SHAKEN: ['😳', '动摇'],
  EXPOSED: ['😵', '暴露'],
};
const STATE_HINT = {
  CALM: '冷静：Tell 泄漏最少 —— 想读他，先击穿他。',
  SHAKEN: '动摇：真话变多、打法开始偏离 —— 欺骗型会更凶更爱演。',
  EXPOSED: '暴露：Tell 浓度最高、行为明显失控 —— 高承诺行动时亮出 GOTCHA 窗口。',
};
const PLAYER_MOOD = { CALM: '冷静', SHAKEN: '动摇', EXPOSED: '暴露' };
const LADDER = { CALM: 'SHAKEN', SHAKEN: 'EXPOSED' }; // 三态只有向右推进
const WINDOW_TIERS = new Set(['check', 'call', 'bet', 'raise', 'heavy', 'allin', 'fold']);
const HIGH_COMMIT = new Set(['bet', 'raise', 'allin']); // gotcha 时机：高承诺行动

/** 盲注梯度：第 upTo 手（含）之前使用该档；档位变化即 blindUp。 */
const TIERS = [
  { upTo: 2, sb: 10, bb: 20 },
  { upTo: 4, sb: 20, bb: 40 },
  { upTo: 6, sb: 40, bb: 80 },
  { upTo: 8, sb: 80, bb: 160 },
  { upTo: Infinity, sb: 160, bb: 320 },
];

function tierInfo(handNo) {
  const idx = TIERS.findIndex((t) => handNo <= t.upTo);
  const i = idx < 0 ? TIERS.length - 1 : idx;
  const t = TIERS[i];
  const start = i === 0 ? 1 : TIERS[i - 1].upTo + 1;
  const tier = Number.isFinite(t.upTo)
    ? `第 ${start}–${t.upTo} 手 · ${t.sb}/${t.bb}`
    : `第 ${start} 手起 · ${t.sb}/${t.bb}`;
  const next = TIERS[i + 1];
  const nextUp = next ? `第 ${t.upTo + 1} 手 → ${next.sb}/${next.bb}` : '—';
  return { idx, sb: t.sb, bb: t.bb, tier, nextUp };
}

/* ------------------------------------------------- 碎片池（类型只在服务端） */

const NOISE = [
  '筹码有点重。', '灯太亮了，晃眼。', '这副牌手感不错。', '我有点口渴。',
  '别磨蹭了。', '下次该换副新牌了。',
];
const DISTORTION = [
  '你根本看不懂我。', '这把我已经赢了。', '没人能接住我这一枪。', '我早就计划好了。',
];
const TAG_TEXT = {
  wants_fold: ['最好别跟。', '你现在弃，还来得及。', '这枪你接不动，弃了吧。'],
  fear_call: ['别再加了。', '你再推我就得弃了。', '这个价格我跟不动。'],
  fear_raise: ['你要是再加注，我就麻烦了。', '别加了，我接不住。', '你一加注我就难受。'],
  weak_hand: ['……这手我自己都没底。', '说真的，你可以跟。', '你要是跟，我就麻烦了。'],
  strong_hand: ['我劝你别接这一枪。', '这一枪你想清楚。', '我把整晚都压上了。'],
  trap: ['……你确定？', '我等你很久了。', '尽管加注，我不拦你。'],
  draw: ['给我一张就成。', '就差一点点。'],
  missed_board: ['这张牌我很不喜欢。', '牌面完全不理我。'],
  call_welcome: ['跟吧，我想看你的牌。', '这个价格欢迎你来。'],
  board_lock: '牌面已经听我的了。',
  overconfidence: '你已经输了，只是你还不知道。',
};
const pickText = (v) => (Array.isArray(v) ? v[Math.floor(Math.random() * v.length)] : v);

const LINES_OPEN = ['这一手你最好直接弃。', '你跟不动这一枪。', '信不信我这里全是价值？'];
const LINES_NORMAL = ['就这点筹码也敢看我？', '我赌你不敢跟。', '你的手在抖，我知道。', '跟注吧，我想亲眼看你输。'];
const LINES_RAISE = ['加注。你倒是接啊。', '这一枪我看你怎么接。', '大点好，我喜欢。'];
const LINES_ALLIN = ['全下？我接了。', '让你看看什么叫统治。', '好啊，一局定生死。'];
const LINES_BUSTED = ['我看穿你了 —— 全部下注！'];
const LINES_GOTCHA_ENTER = ['……你居然敢进这一步。', '好，那就看谁先扛不住。', '押上一切？成全你。'];
const HEART_V = '我只是……不想承认你真的看穿我了。';
const HEART_D = '……原来从头到尾，被看穿的人是我。';

/* ------------------------------------------------ CRACK 规则（数据驱动） */

const TRUTH_WEAK = ['BLUFF', 'PROBE'];
const TRUTH_STRONG = ['VALUE', 'TRAP', 'CONTROL'];
const CRACK_RULES = [
  { tag: 'wants_fold', actions: ['call'], truth: TRUTH_WEAK, kind: 'WEAKNESS', strength: 2 },
  { tag: 'fear_call', actions: ['call'], truth: TRUTH_WEAK, kind: 'WEAKNESS', strength: 2 },
  { tag: 'fear_raise', actions: ['raise', 'pressure', 'heavy', 'bet', 'allin'], truth: TRUTH_WEAK, kind: 'WEAKNESS', strength: 2 },
  { tag: 'weak_hand', actions: ['pressure', 'heavy', 'raise', 'bet', 'allin'], truth: TRUTH_WEAK, kind: 'WEAKNESS', strength: 2 },
  { tag: 'missed_board', actions: ['pressure', 'heavy', 'raise', 'bet', 'allin'], truth: TRUTH_WEAK, kind: 'WEAKNESS', strength: 2 },
  { tag: 'draw', actions: ['pressure', 'heavy', 'raise', 'bet', 'allin'], truth: TRUTH_WEAK, kind: 'WEAKNESS', strength: 2 },
  { tag: 'trap', actions: ['check'], truth: TRUTH_STRONG, kind: 'STRENGTH', strength: 2 },
  { tag: 'call_welcome', actions: ['fold', 'check'], truth: TRUTH_STRONG, kind: 'STRENGTH', strength: 2 },
  { tag: 'strong_hand', actions: ['fold', 'check'], truth: TRUTH_STRONG, kind: 'STRENGTH', strength: 2 },
  { tag: 'board_lock', actions: ['fold', 'check'], truth: TRUTH_STRONG, kind: 'STRENGTH', strength: 2 },
  { tag: 'overconfidence', actions: ['fold', 'check'], truth: TRUTH_STRONG, kind: 'STRENGTH', strength: 2 },
];
// 弱侧真话（配合 canCall 批次）/ 强侧真话（配合 check 批次）
const WEAK_TAGS = ['fear_call', 'fear_raise', 'weak_hand', 'fear_call', 'weak_hand'];
const STRONG_TAGS = ['strong_hand', 'overconfidence', 'board_lock', 'call_welcome'];
const ALL_TRUE_TAGS = [...new Set(CRACK_RULES.map((r) => r.tag))];

/** Boss 最小反读（balance.bossCounterRules，计数保底卡在阈值上便于演示）。 */
const BOSS_COUNTER_RULES = [
  {
    id: 'fear_pressure', pattern: 'foldsToHeavy', threshold: 2,
    bossAction: 'heavy', playerAction: 'fold',
    why: '他面对重注就跑 → 我推重注，他果然跑',
  },
  {
    id: 'over_call', pattern: 'callsFaced', threshold: 3,
    bossAction: 'raise', playerAction: 'call',
    why: '他什么都接 → 我加注，他果然接',
  },
  {
    id: 'agg_punish', pattern: 'lostAsAggressor', threshold: 2,
    bossAction: 'check', playerAction: 'bet',
    why: '他输急眼爱开火 → 我让牌，他果然开火',
  },
];
const COUNTER_SEED = { foldsToHeavy: 2, callsFaced: 3, lostAsAggressor: 2 };

const INTENTS = [
  ['BLUFF', 0.35], ['VALUE', 0.3], ['PROBE', 0.15], ['TRAP', 0.1], ['CONTROL', 0.1],
];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
const rollIntent = () => {
  let r = Math.random();
  for (const [name, w] of INTENTS) {
    r -= w;
    if (r <= 0) return name;
  }
  return 'BLUFF';
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const shuffle = (a0) => {
  const a = [...a0];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

/* ------------------------------------------------------------ 极简牌型名 */

const RANKS = '23456789TJQKA'.split('');
const SUITS = ['s', 'h', 'd', 'c'];
const FULL_DECK = [];
for (const r of RANKS) for (const s of SUITS) FULL_DECK.push(`${r}${s}`);

const RANK_ORDER = '23456789TJQKA';

/** 罐头用的粗略牌型名：四条 > 三条 > 满堂红 > 两对 > 一对 > 高牌 > null（未成型）。 */
function evalHandName(hole, board) {
  const cards = [...(hole ?? []), ...(board ?? [])].filter((c) => typeof c === 'string' && c.length >= 2);
  if (cards.length < 2) return null;
  const counts = new Map();
  for (const c of cards) counts.set(c[0], (counts.get(c[0]) ?? 0) + 1);
  const buckets = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (buckets[0]?.[1] >= 4) return '四条';
  if (buckets[0]?.[1] === 3) return buckets.some(([, n]) => n === 2) ? '满堂红' : '三条';
  const pairs = buckets.filter(([, n]) => n === 2).length;
  if (pairs >= 2) return '两对';
  if (pairs === 1) return '一对';
  const max = [...cards].sort((a, b) => RANK_ORDER.indexOf(b[0]) - RANK_ORDER.indexOf(a[0]))[0];
  const name = { T: '10', J: 'J', Q: 'Q', K: 'K', A: 'A' }[max[0]] ?? max[0];
  return cards.length >= 5 ? `高牌 ${name}` : null;
}

/* ------------------------------------------------------------ 游戏状态 */

let G = null;

function baseView() {
  const t = tierInfo(1);
  return {
    phase: 'playing',
    handNo: 1,
    street: 'preflop',
    pot: 0,
    board: [],
    button: 0,
    toAct: 0,
    blind: { sb: t.sb, bb: t.bb, tier: t.tier, nextUp: t.nextUp },
    effectiveStack: START_PLAYER,
    mode: 'NORMAL',
    player: {
      chips: START_PLAYER, bet: 0, hole: [], toCall: 0, handName: null,
      legal: null,
      focus: 0,                       // v5：每手从 0 开始（翻前不开放 READ）
      focusMax: FOCUS_MAX,
      readCooldownUntil: 0,
      state: 'CALM', face: FACES.CALM[0], mood: FACES.CALM[1],   // 玩家三态（对称展示）
    },
    boss: {
      chips: START_BOSS, bet: 0, hole: null,
      state: 'CALM', face: FACES.CALM[0], mood: FACES.CALM[1],
      stateHint: STATE_HINT.CALM,
      lastAction: null, lastLine: null,
    },
    tellWindow: null,        // { id, actionId, handId, street, bossAction } / null = 不可 READ
    pin: null,               // { text, verified } —— 只有这两个字段
    gotcha: null,            // { street, bossAction } —— 非 null = 窗口点亮
    cracks: [],
    history: [],
    readFragments: [],       // 每项 { id, text, atHand, tellWindowId }（严格一窗一批）
    feed: [],
  };
}

function newGame(body) {
  const force = ['victory', 'defeat'].includes(body?.demo) ? body.demo : PREVIEW_DEMO;
  G = {
    view: baseView(),
    deck: shuffle(FULL_DECK),
    deckIdx: 0,
    readCooldownUntil: 0,
    fragSeq: 0,
    crackSeq: 0,
    frags: new Map(),        // id → { id, type, tags, text, atHand, tellWindowId }（服务端私有）
    pin: null,               // 服务端私有：{ id, type, tag, text, atHand, tellWindowId, verified }
    intent: 'PROBE',
    actionSeq: 0,            // 双方行动序号（tellWindow.actionId 用）
    windowSeq: 0,            // Tell Window 自增 id
    curWindow: null,
    lastBossTier: 'check',
    pendingCounter: null,    // 窗口上布下的反读陷阱（随窗口生死）
    counters: { ...COUNTER_SEED },          // PlayerModel 累计计数（保底卡阈值）
    counterFired: { fear_pressure: false, over_call: false, agg_punish: false },
    demo: { negStreet: false, negAction: false, positive: false }, // EXPOSED 演示进度
    readBatchesThisHand: 0,
    debtMode: false,
    gotchaDepth: 0,
    gotchaRaiseStep: 0,
    lastRaiseSize: 0,
    bossBluffedThisHand: false,
    bustedThisHand: false,
    bustedLastHand: -99,
    bustedBuff: false,
    lastHandAllIn: false,
    prevTierKey: null,
    force,
    st: { pActed: false, bActed: false, aggr: null, last: null },
    bossHole: [],
  };
  const evs = [];
  startHand(evs);
  feedOf('system', `对局开始：你 ${START_PLAYER} vs Boss ${START_BOSS}，把他打到 0。`);
  return evs;
}

const v = () => G.view;
const inGotcha = () => G.view.mode === 'GOTCHA';

const draw = () => {
  const card = G.deck[G.deckIdx % G.deck.length];
  G.deckIdx += 1;
  return card;
};

function feedOf(kind, text) {
  const feed = v().feed;
  feed.push({ kind, text });
  if (feed.length > 100) feed.splice(0, feed.length - 100);
}

function refreshEffective(state = v()) {
  // GOTCHA 中仅供参考：floor 0（负数是债务，不是 Effective Stack）
  state.effectiveStack = Math.max(0, Math.min(
    Math.round(state.player.chips),
    Math.round(state.boss.chips),
  ));
}

/* --------------------------------------------------------- 三态心理（双方） */

function applyState(state, name) {
  const [face, mood] = FACES[name] ?? FACES.CALM;
  state.boss.state = name;
  state.boss.face = face;
  state.boss.mood = mood;
  state.boss.stateHint = STATE_HINT[name] ?? STATE_HINT.CALM;
}

function applyPlayerState(state, name) {
  const [face, mood] = FACES[name] ?? FACES.CALM;
  state.player.state = name;
  state.player.face = face;
  state.player.mood = PLAYER_MOOD[name] ?? mood;
}

/** Boss 心理推进：cause ∈ { CRACK, GOTCHA_HIT }；EXPOSED 封顶则不发事件。 */
function pushMental(evs, { cause, causeName, hint }) {
  const state = v();
  const from = state.boss.state;
  const to = LADDER[from] ?? from;
  if (to === from) return false;
  applyState(state, to);
  evs.push({
    type: 'mental', from, to, cause, causeName,
    hint: hint ?? STATE_HINT[to], down: false,   // 三态只有向右推进（down 恒 false）
  });
  feedOf('mental', `${FACES[from]?.[1] ?? from} → ${FACES[to]?.[1] ?? to} · ${causeName ?? cause}`);
  refreshGotcha(state);
  return true;
}

/** 玩家心理推进（对称展示，暂不参与判定）。 */
function pushPlayerMental(evs) {
  const state = v();
  const from = state.player.state;
  const to = LADDER[from] ?? from;
  if (to === from) return false;
  applyPlayerState(state, to);
  evs.push({ type: 'player_mental', from, to });
  feedOf('mental', `你：${PLAYER_MOOD[from] ?? from} → ${PLAYER_MOOD[to] ?? to} · 被反读命中`);
  return true;
}

function pushTalk(evs, line) {
  v().boss.lastLine = line;
  evs.push({ type: 'talk', line });
  feedOf('talk', line);
}

/* ------------------------------------------------------------- legal 计算 */

function raiseTarget(state = v()) {
  // GOTCHA 阶梯：raise-to = 当前注 + step（currentBet=0 时即开注视额）
  return Math.round(state.boss.bet + G.gotchaRaiseStep);
}

function refreshLegal(state = v()) {
  const p = state.player;
  const b = state.boss;
  const pot = Math.round(state.pot) || 0;
  const inG = state.mode === 'GOTCHA';
  const rawCall = Math.max(0, Math.round(b.bet - p.bet));
  // NORMAL 受剩余筹码约束；GOTCHA 解除上限（负债跟注 = 全额）
  const toCall = inG ? rawCall : Math.min(rawCall, Math.max(0, Math.round(p.chips)));
  p.toCall = toCall;

  const maxTo = Math.round(p.bet + p.chips);
  const minTo = rawCall > 0
    ? Math.max(1, Math.round(b.bet * 2))
    : Math.max(10, Math.ceil(pot / 3));

  p.legal = {
    check: rawCall === 0,
    call: rawCall > 0 ? (inG ? rawCall : (p.chips > 0 ? Math.min(rawCall, Math.round(p.chips)) : null)) : null,
    fold: true,
    pressure: !inG && p.chips > 0,
    heavy: !inG && p.chips > 0,
    pressureTo: !inG && p.chips > 0 ? clamp(Math.round(p.bet + pot * 0.5), Math.min(minTo, Math.max(minTo, maxTo)), Math.max(minTo, maxTo)) : null,
    heavyTo: !inG && p.chips > 0 ? clamp(Math.round(p.bet + pot * 1.0), Math.min(minTo, Math.max(minTo, maxTo)), Math.max(minTo, maxTo)) : null,
    bet: false,
    raise: inG,
    minTo: inG ? (rawCall > 0 ? Math.max(1, Math.round(b.bet * 2)) : Math.max(1, G.gotchaRaiseStep)) : 0,
    maxTo: inG ? 1_000_000_000 : 0,
    allin: inG ? null : Math.max(0, Math.round(p.chips)),
    gotchaRaiseTo: inG ? raiseTarget(state) : null,
  };
  p.handName = evalHandName(p.hole, state.board);
  refreshEffective(state);
  return p.legal;
}

/* ------------------------------------------------------- GOTCHA 窗口（资格×时机） */

/**
 * v5 判定（缺一不可）：mode NORMAL + Boss EXPOSED + 转/河 +
 * Boss.lastAction ∈ {bet,raise,allin} 且同街 + 玩家回合。
 */
function refreshGotcha(state = v()) {
  if (state.phase !== 'playing' || state.mode !== 'NORMAL' || state.toAct !== 0) {
    state.gotcha = null;
    return null;
  }
  const b = state.boss;
  const la = b.lastAction;
  const ok = b.state === 'EXPOSED'
    && (state.street === 'turn' || state.street === 'river')
    && la && HIGH_COMMIT.has(la.action)
    && la.street === state.street;
  state.gotcha = ok ? { street: state.street, bossAction: la.action } : null;
  return state.gotcha;
}

/* --------------------------------------------------------- Tell Window 管理 */

/** Boss 行动落地且玩家仍需回应 → 开窗 + 发轻提示事件 + 布反读陷阱。 */
function maybeOpenWindow(evs, tier) {
  const state = v();
  if (state.phase !== 'playing' || state.mode === 'GOTCHA' || state.toAct !== 0) return null;
  if (!WINDOW_TIERS.has(tier)) return null;
  G.windowSeq += 1;
  const tw = {
    id: G.windowSeq,
    actionId: G.actionSeq,
    handId: state.handNo,
    street: state.street,
    bossAction: tier,
  };
  state.tellWindow = tw;
  G.curWindow = tw;
  armCounter(tier);
  evs.push({
    type: 'tell_window_open',
    id: tw.id,
    actionId: tw.actionId,
    street: tw.street,
    bossAction: tw.bossAction,
  });
  return tw;
}

/** 窗口开启时按 Boss 行动档位布陷阱（pattern 计数达标才布；随窗口生死）。 */
function armCounter(tier) {
  const rule = BOSS_COUNTER_RULES.find((r) =>
    !G.counterFired[r.id]
    && (G.counters[r.pattern] ?? 0) >= r.threshold
    && r.bossAction === tier);
  G.pendingCounter = rule ? { ...rule } : null;
}

/** 关窗 + 无条件清空碎片/PIN（玩家任何成功行动后调用；旧 id 留在 frags 里 → BAD_FRAGMENT）。 */
function closeWindowAndClear() {
  const state = v();
  state.tellWindow = null;
  G.curWindow = null;
  G.pendingCounter = null;
  state.readFragments = [];
  state.pin = null;
  G.pin = null;
}

/* ------------------------------------------------------------ 下注引擎（罐头） */

function newStreetState() {
  G.st = { pActed: false, bActed: false, aggr: null, last: null };
}

function markAction(seat, action) {
  const st = G.st;
  if (action === 'bet' || action === 'raise' || action === 'allin') st.aggr = seat;
  if (seat === 0) st.pActed = true;
  else st.bActed = true;
  st.last = seat;
}

function roundClosed() {
  const state = v();
  const st = G.st;
  if (Math.round(state.player.bet) !== Math.round(state.boss.bet)) return false;
  if (!st.pActed || !st.bActed) return false;
  if (st.aggr === null) return true;
  return st.last !== st.aggr;
}

/** GOTCHA 心理泄漏：任意一方完成 CALL / RAISE 即触发（depth 每次 +1）。 */
function emitLeak(evs) {
  const state = v();
  G.gotchaDepth += 1;
  const depth = G.gotchaDepth;
  const count = randInt(GOTCHA_BATCH[0], GOTCHA_BATCH[1]);
  const trueRate = LEAK_TRUE_RATE[Math.min(depth - 1, LEAK_TRUE_RATE.length - 1)];
  const base = state.boss.state === 'CALM' ? 1400 : state.boss.state === 'SHAKEN' ? 1100 : 900;
  const flashMs = Math.round(base * LEAK_FLASH_K);

  const texts = [];
  for (let i = 0; i < count; i += 1) {
    const r = Math.random();
    if (r < trueRate) texts.push(pickText(TAG_TEXT[pick(ALL_TRUE_TAGS)]));
    else if (r < trueRate + (1 - trueRate) / 2) texts.push(pick(NOISE));
    else texts.push(pick(DISTORTION));
  }
  const wire = texts.map((text) => ({ id: null, text })); // 自动泄漏不可 PIN
  evs.push({ type: 'read_batch', source: 'gotcha', depth, flashMs, fragments: wire });
  // 面板：整批按顺序插到最前（f0 在最上）；id / tellWindowId 恒 null
  state.readFragments.splice(0, 0,
    ...texts.map((text) => ({ id: null, text, atHand: state.handNo, tellWindowId: null })));
  if (state.readFragments.length > 30) state.readFragments.length = 30;
  feedOf('read', `心理泄漏 ×${count} · depth ${depth}`);
}

/**
 * 一次下注动作（seat 0=玩家 1=Boss）。bet/raise/pressure/heavy 的 amount 为 raise-to 语义。
 * debtMode 下解除上限：chips 可为负、不产生 all-in 语义。
 */
function seatAction(seat, action, amount, evs) {
  const state = v();
  const debt = G.debtMode;
  const who = seat === 0 ? state.player : state.boss;
  const other = seat === 0 ? state.boss : state.player;
  const potBefore = state.pot;
  let put = 0;
  let evAmount;
  let allIn = false;

  const minRaiseTo = other.bet > 0
    ? Math.max(1, Math.round(other.bet * 2))
    : Math.max(10, Math.ceil(potBefore / 3));
  const maxTo = debt ? Number.MAX_SAFE_INTEGER : Math.round(who.bet + who.chips);

  if (action === 'check') {
    put = 0;
    evAmount = 0;
  } else if (action === 'fold') {
    put = 0;
    evAmount = 0;
  } else if (action === 'call') {
    // 负债跟注：全额（可把 stack 扣成负数）
    put = debt
      ? Math.max(0, Math.round(other.bet - who.bet))
      : Math.min(Math.max(0, Math.round(other.bet - who.bet)), Math.round(who.chips));
    evAmount = put;
  } else if (action === 'bet' || action === 'raise') {
    let raiseTo;
    if (debt && (amount === undefined || amount === null)) {
      // GOTCHA 阶梯：currentBet + step（currentBet=0 时即开注视额）—— 金额全在服务端算
      raiseTo = other.bet > 0
        ? Math.round(other.bet + G.gotchaRaiseStep)
        : Math.round(G.gotchaRaiseStep);
    } else {
      const lo = debt
        ? (other.bet > 0 ? Math.max(1, Math.round(other.bet * 2)) : Math.max(1, Math.round(G.gotchaRaiseStep)))
        : Math.min(minRaiseTo, maxTo);
      const hi = debt ? Number.MAX_SAFE_INTEGER : Math.max(minRaiseTo, maxTo);
      const want = Number.isFinite(Number(amount)) ? Math.round(Number(amount))
        : (debt ? raiseTarget(state) : minRaiseTo);
      raiseTo = clamp(want, Math.min(lo, hi), Math.max(lo, hi));
    }
    put = Math.max(0, Math.round(raiseTo) - Math.round(who.bet));
    evAmount = Math.round(raiseTo);
  } else if (action === 'pressure' || action === 'heavy') {
    const frac = action === 'pressure' ? 0.5 : 1.0;
    const raiseTo = clamp(
      Math.round(who.bet + potBefore * frac),
      Math.min(minRaiseTo, maxTo),
      Math.max(minRaiseTo, maxTo),
    );
    put = Math.max(0, raiseTo - Math.round(who.bet));
    evAmount = raiseTo;
  } else if (action === 'allin') {
    const cap = seat === 1
      ? Math.round(state.player.bet + state.player.chips - state.boss.bet)
      : Number.MAX_SAFE_INTEGER;
    put = Math.min(Math.round(who.chips), Math.max(0, cap));
    evAmount = Math.round(who.bet) + put;
    allIn = true;
  }

  if (!debt && put > who.chips) {
    put = Math.round(who.chips);
    allIn = true;
  }
  if (who.chips <= 0 && !debt) put = Math.max(0, put);
  who.chips -= put; // debtMode：可为负（临时余额）
  who.bet += put;
  state.pot += put;
  if (!debt && who.chips === 0 && put > 0) allIn = true;
  if (action === 'allin') allIn = true;
  if (allIn) G.lastHandAllIn = true;

  G.actionSeq += 1; // 行动序号（tellWindow.actionId）
  evs.push({ type: 'action', seat, action, amount: evAmount, put, potAfter: state.pot, allIn });
  state.history.push({
    handNo: state.handNo,
    street: state.street,
    actor: seat === 0 ? 'player' : 'boss',
    action,
    amount: evAmount,
  });
  if (state.history.length > 60) state.history.splice(0, state.history.length - 60);

  // 本街上次加注尺寸（GOTCHA 阶梯起点参考，≥bb）
  if (action === 'bet' || action === 'raise') {
    G.lastRaiseSize = Math.max(state.blind.bb, put > 0 ? put : G.lastRaiseSize);
  }

  if (seat === 1) {
    state.boss.lastAction = { action, amount: evAmount, street: state.street };
    // Tell 强度档位：bet/raise 且 put ≥ heavyFrac×池 → heavy（窗口/反读用）
    if (action === 'bet' || action === 'raise') {
      G.lastBossTier = put >= HEAVY_FRAC * potBefore ? 'heavy' : action;
    } else {
      G.lastBossTier = action;
    }
    if (action === 'bet' || action === 'raise' || action === 'allin') {
      // 重要行动 → intent 更新（旧情报自然失效）；弱侧 intent 记「本手打过诈唬」
      G.intent = rollIntent();
      if (G.intent === 'BLUFF' || G.intent === 'PROBE') G.bossBluffedThisHand = true;
    }
  }

  if (debt) {
    // 阶梯：任意一方完成一次完整加注 → step ×= 2（每一次继续风险肉眼翻倍）
    if (action === 'raise') G.gotchaRaiseStep *= 2;
    // 心理泄漏：任意一方完成 CALL / RAISE
    if (action === 'call' || action === 'raise') emitLeak(evs);
  }

  return { put, allIn };
}

function postBlinds(evs) {
  const state = v();
  const sbSeat = state.button; // 1v1：button 是小盲
  const bbSeat = sbSeat === 0 ? 1 : 0;
  for (const [seat, amount] of [[sbSeat, state.blind.sb], [bbSeat, state.blind.bb]]) {
    const who = seat === 0 ? state.player : state.boss;
    const give = Math.min(amount, who.chips);
    who.chips -= give;
    who.bet += give;
    state.pot += give;
    evs.push({ type: 'blinds', seat, amount: give, potAfter: state.pot });
  }
}

/** 开一手：hand_start（blindUp 横幅）→ 发盲注 → 重置 v5 窗口/Focus 资源。 */
function startHand(evs) {
  const state = v();
  const t = tierInfo(state.handNo);
  const tierKey = t.idx;
  const blindUp = G.prevTierKey !== null && G.prevTierKey !== tierKey;
  G.prevTierKey = tierKey;

  state.blind = { sb: t.sb, bb: t.bb, tier: t.tier, nextUp: t.nextUp };
  state.street = 'preflop';
  state.board = [];
  state.player.bet = 0;
  state.boss.bet = 0;
  state.boss.hole = null;
  state.boss.lastAction = null;
  state.pin = null;
  state.gotcha = null;
  state.cracks = [];
  state.tellWindow = null;
  state.readFragments = [];
  state.mode = 'NORMAL';
  state.pot = 0;
  state.toAct = 0;
  state.phase = 'playing';
  state.player.focus = 0;          // v5：每手从 0 开始（翻前不开放 READ）
  state.player.focusMax = FOCUS_MAX;
  state.player.readCooldownUntil = 0;
  G.readCooldownUntil = 0;         // 冷却与 view 字段保持同步（绝不出现视图/服务端分歧）

  G.deck = shuffle(FULL_DECK);
  G.deckIdx = 0;
  G.pin = null;
  G.curWindow = null;
  G.pendingCounter = null;
  G.readBatchesThisHand = 0;
  G.debtMode = false;
  G.gotchaDepth = 0;
  G.gotchaRaiseStep = 0;
  G.lastRaiseSize = t.bb;
  G.bossBluffedThisHand = false;
  G.bustedThisHand = false;
  G.bustedBuff = false;
  G.lastHandAllIn = false;
  newStreetState();

  state.player.hole = [draw(), draw()];
  G.bossHole = [draw(), draw()];

  evs.push({
    type: 'hand_start',
    handNo: state.handNo,
    button: state.button,
    sb: t.sb,
    bb: t.bb,
    tier: t.tier,
    blindUp,
  });
  if (blindUp) feedOf('blind', `盲注升级 ${t.sb}/${t.bb} · ${t.tier}`);

  postBlinds(evs);

  // 罐头保底意图：能跟注的初始局面 = 弱侧（配合 wants_fold 批次）；否则强侧（配合 trap 批次）
  G.intent = Math.max(0, state.boss.bet - state.player.bet) > 0 ? 'BLUFF' : 'VALUE';

  refreshGotcha(state);
  refreshLegal(state);
}

const STREET_ORDER = ['preflop', 'flop', 'turn', 'river'];

function nextStreet(evs) {
  const state = v();
  const idx = STREET_ORDER.indexOf(state.street);
  if (idx < 0 || idx >= STREET_ORDER.length - 1) return false;
  const street = STREET_ORDER[idx + 1];
  state.street = street;
  const cards = [];
  const count = street === 'flop' ? 3 : 1;
  for (let i = 0; i < count; i += 1) cards.push(draw());
  state.board.push(...cards);
  state.player.bet = 0;
  state.boss.bet = 0;
  G.lastRaiseSize = state.blind.bb; // 每街重置：阶梯起点 = 本街 lastRaiseSize（≥bb）
  evs.push({ type: 'street', street, cards });

  // Focus：进 flop/turn/river 各 +1（一次跃迁多档就多次授予），封顶 focusMax
  const grant = STREET_GRANT[street] ?? 0;
  if (grant > 0) {
    state.player.focus = Math.min(FOCUS_MAX, Math.round(state.player.focus || 0) + grant);
  }
  state.player.handName = evalHandName(state.player.hole, state.board);
  refreshGotcha(state);
  return true;
}

function decideWinner() {
  const state = v();
  if (G.force === 'victory') return 0;
  if (G.force === 'defeat') return 1;
  let p = state.handNo >= DUEL_START_HAND ? 0.75 : 0.72;
  if (Math.round(state.player.chips) < 150) p = 0.92; // 预览保底：演示不因破产中断
  return Math.random() < p ? 0 : 1;
}

function showdownEvent(evs, winner) {
  const state = v();
  evs.push({
    type: 'showdown',
    hands: [
      {
        seat: 0,
        hole: state.player.hole,
        handName: evalHandName(state.player.hole, state.board),
        winner: winner === 0,
      },
      {
        seat: 1,
        hole: G.bossHole,
        handName: evalHandName(G.bossHole, state.board),
        winner: winner === 1,
      },
    ],
    split: false,
  });
}

function resolveShowdown(evs) {
  const winner = decideWinner();
  showdownEvent(evs, winner);
  settleHand(evs, winner);
}

/**
 * 统一结算（FOLD / SHOWDOWN 同一条路）：
 * 1) 退还未跟注部分 2) Pot = 全部已投入（含负债）3) 赢家收取 Pot
 * 4) mode 回落由下一手 hand_start 完成（hand_end.mode 记录本手终值）
 * 5) 结算后 stack <= 0 判负 —— 绝不允负数筹码进入下一手 NORMAL。
 * v5：不再触发任何情绪事件（心理与筹码分离，§8）。
 */
function settleHand(evs, winner, { bluffCaught = false } = {}) {
  const state = v();

  // 1) 未跟注部分退还（bet 差额回投入多的一方；摊牌时差额为 0）
  const diff = Math.round(state.player.bet) - Math.round(state.boss.bet);
  if (diff > 0) {
    state.player.chips += diff;
    state.pot -= diff;
    state.player.bet -= diff;
  } else if (diff < 0) {
    const back = -diff;
    state.boss.chips += back;
    state.pot -= back;
    state.boss.bet -= back;
  }

  // 2-3) Pot（含负债投入）全归赢家
  const pot = Math.round(state.pot);
  if (winner === 0) state.player.chips += pot;
  else if (winner === 1) state.boss.chips += pot;

  // PlayerModel 计数：当激进方输牌（输急眼模式的累计）
  if (winner === 1 && G.st.aggr === 0) G.counters.lostAsAggressor += 1;

  feedOf('hand', `第 ${state.handNo} 手 · 底池 ${pot} → ${winner === 0 ? '你' : '对手'}赢得 ${pot}`);
  evs.push({ type: 'pot_move', to: winner, amount: pot });

  const nextT = tierInfo(state.handNo + 1);
  const handMode = state.mode; // hand_end 记录本手终值（GOTCHA / NORMAL）
  evs.push({
    type: 'hand_end',
    handNo: state.handNo,
    winner,
    pot,
    stacks: { player: Math.round(state.player.chips), boss: Math.round(state.boss.chips) },
    effectiveStack: Math.max(0, Math.min(Math.round(state.player.chips), Math.round(state.boss.chips))),
    blind: { sb: nextT.sb, bb: nextT.bb },
    mode: handMode,
    bluffCaught: Boolean(bluffCaught),
  });
  state.pot = 0;

  // 5) 结算后判定：stack <= 0 → 终局（绝不负数进下一手）
  const pOut = Math.round(state.player.chips) <= 0;
  const bOut = Math.round(state.boss.chips) <= 0;
  if (pOut || bOut) {
    let phase;
    if (bOut && !pOut) phase = 'victory';
    else if (pOut && !bOut) phase = 'defeat';
    else phase = winner === 0 ? 'victory' : 'defeat'; // 双负（极端）：本手赢家通吃
    if (phase === 'victory') state.boss.chips = Math.min(0, state.boss.chips);
    else state.player.chips = Math.min(0, state.player.chips);
    state.phase = phase;
    state.toAct = null;
    refreshEffective(state);
    evs.push({ type: 'game_over', phase, heart: phase === 'victory' ? HEART_V : HEART_D });
    feedOf('system', phase === 'victory' ? 'Boss 筹码归零 —— VICTORY。' : '你的筹码归零 —— DEFEAT。');
    return 'over';
  }

  state.handNo += 1;
  state.button ^= 1;
  startHand(evs);
  return 'next';
}

function foldWin(evs, winner) {
  evs.push({ type: 'fold_win', winner });
  return settleHand(evs, winner);
}

/* ------------------------------------------------------- READ / PIN / CRACK */

function makeFrag(text, type, tags, atHand, tellWindowId) {
  G.fragSeq += 1;
  const id = `w${tellWindowId}f${G.fragSeq}`; // 碎片 id 归属窗口（w7f12 = 窗口7）
  const meta = { id, type, tags, text, atHand, tellWindowId };
  G.frags.set(id, meta);
  return meta;
}

/** 手工 READ 批次：frag0 = 可验证真话（与当前意图对齐），frag1 = NOISE（对照组）。 */
function makeManualBatch(tellWindowId) {
  const state = v();
  const count = randInt(NORMAL_BATCH[0], NORMAL_BATCH[1]);
  const canCall = Math.max(0, Math.round(state.boss.bet - state.player.bet)) > 0;

  // 罐头保底：把「Boss 当前意图」对齐到主标签的真值域
  //   能跟注 → wants_fold × [BLUFF,PROBE]（玩家 call 即验证）
  //   不能跟 → trap × [VALUE,TRAP,CONTROL]（玩家 check 即验证）
  G.intent = canCall ? 'BLUFF' : 'VALUE';

  const domain = canCall ? WEAK_TAGS : STRONG_TAGS;
  const metas = [];
  metas.push(makeFrag(pickText(TAG_TEXT[canCall ? 'wants_fold' : 'trap']), 'TRUE',
    [canCall ? 'wants_fold' : 'trap'], state.handNo, tellWindowId));
  metas.push(makeFrag(pick(NOISE), 'NOISE', [], state.handNo, tellWindowId));
  while (metas.length < count) {
    const r = Math.random();
    if (r < 0.45) metas.push(makeFrag(pick(NOISE), 'NOISE', [], state.handNo, tellWindowId));
    else if (r < 0.7) metas.push(makeFrag(pick(DISTORTION), 'DISTORTION', [], state.handNo, tellWindowId));
    else {
      const tag = pick(domain);
      metas.push(makeFrag(pickText(TAG_TEXT[tag]), 'TRUE', [tag], state.handNo, tellWindowId));
    }
  }
  return metas;
}

function emitManualBatch(evs) {
  const state = v();
  const tw = G.curWindow;
  const metas = makeManualBatch(tw.id);
  const base = state.boss.state === 'CALM' ? 1400 : state.boss.state === 'SHAKEN' ? 1100 : 900;
  const wire = metas.map((m) => ({ id: m.id, text: m.text }));
  evs.push({
    type: 'read_batch', source: 'manual',
    tellWindowId: tw.id, actionId: tw.actionId, flashMs: base, fragments: wire,
  });
  // 面板：整批按顺序插到最前（f0 在最上，与闪现一致），每项带 atHand + tellWindowId
  state.readFragments.splice(0, 0,
    ...metas.map((m) => ({ id: m.id, text: m.text, atHand: m.atHand, tellWindowId: m.tellWindowId })));
  if (state.readFragments.length > 30) state.readFragments.length = 30;
  feedOf('read', `READ ×${metas.length} 条碎片 · 窗口 ${tw.id}`);
}

/** PIN 的真话 × 玩家行动 × Boss 当前 intent → CRACK（玩家回应落地、关窗之前判定）。 */
function evaluateCrack(evs, action) {
  const state = v();
  const pin = G.pin;
  if (!pin || pin.verified || pin.type !== 'TRUE' || !pin.tag) return false;
  const rule = CRACK_RULES.find((r) => r.tag === pin.tag && r.actions.includes(action));
  if (!rule) return false;
  if (!rule.truth.includes(G.intent)) return false;

  pin.verified = true;
  if (state.pin) state.pin.verified = true;

  const entry = {
    id: ++G.crackSeq,
    kind: rule.kind,
    evidence: [pin.tag],
    action,
    strength: rule.strength,
    critical: false,
    handNo: state.handNo,
    result: null,          // 保留字段（不再兑现，恒 null）
  };
  state.cracks.push(entry);
  if (state.cracks.length > 12) state.cracks.splice(0, state.cracks.length - 12);
  feedOf('crack', `CRACK · ${pin.tag} × ${action.toUpperCase()}（${rule.kind}）`);
  evs.push({
    type: 'crack',
    id: entry.id,
    kind: entry.kind,
    evidence: entry.evidence,
    action: entry.action,
    strength: entry.strength,
    critical: false,
    handNo: entry.handNo,
  });
  // ★ v5：CRACK 命中 → 立即推进 Boss 心理状态（随后无论如何都关窗清理）
  pushMental(evs, {
    cause: 'CRACK',
    causeName: '被 CRACK 击中',
    hint: STATE_HINT[LADDER[state.boss.state] ?? state.boss.state],
  });
  return true;
}

/** Boss 反读命中判定：玩家本次回应踩中窗口上的陷阱 → PLAYER CRACKED + 玩家心理推进。 */
function evaluatePlayerCounter(evs, action) {
  const pc = G.pendingCounter;
  G.pendingCounter = null; // 陷阱随窗口生死：无论成败都清空
  if (!pc) return null;
  const hit = pc.playerAction === 'bet'
    ? (action === 'pressure' || action === 'heavy' || action === 'allin' || action === 'bet')
    : action === pc.playerAction;
  if (!hit) return null; // 不匹配 → 陷阱失败，静默清空

  G.counterFired[pc.id] = true;
  evs.push({
    type: 'player_cracked',
    ruleId: pc.id,
    action,
    bossAction: pc.bossAction,
    why: pc.why,
  });
  feedOf('model', `他在利用你：${pc.why}`);
  pushPlayerMental(evs);
  return pc.id;
}

/* ------------------------------------------------------- Boss 应对（罐头） */

/** 重注决策（档位 heavy）：put ≥ 1×池；筹码不够返回 null（回落常规决策）。 */
function heavyDecision(toCall, potBefore, isLead) {
  const state = v();
  const b = state.boss;
  const maxTo = Math.round(b.bet + b.chips);
  if (maxTo <= 0 || potBefore <= 0) return null;
  if (toCall > 0) {
    const raiseTo = Math.min(maxTo, Math.round(b.bet + toCall + potBefore));
    const put = Math.max(0, raiseTo - Math.round(b.bet));
    if (raiseTo > Math.round(state.player.bet) && put >= HEAVY_FRAC * potBefore) {
      return { action: 'raise', raiseTo };
    }
    return null;
  }
  const minBet = Math.max(10, Math.ceil(potBefore / 3));
  const raiseTo = clamp(Math.ceil(potBefore * 1.15), minBet, maxTo);
  const put = Math.max(0, raiseTo - Math.round(b.bet));
  if (raiseTo <= 0 || put < HEAVY_FRAC * potBefore) return null;
  return { action: isLead ? 'bet' : 'raise', raiseTo };
}

/** 小注加注（档位 raise，put < 池）：给 over_call 陷阱用。 */
function smallRaiseDecision(toCall, potBefore) {
  const state = v();
  const b = state.boss;
  if (toCall <= 0 || potBefore <= 0) return null;
  const maxTo = Math.round(b.bet + b.chips);
  const raiseTo = Math.min(maxTo, Math.round(b.bet + toCall + Math.floor(potBefore * 0.25)));
  const put = Math.max(0, raiseTo - Math.round(b.bet));
  if (raiseTo > Math.round(state.player.bet) && put < HEAVY_FRAC * potBefore) {
    return { action: 'raise', raiseTo };
  }
  return null;
}

/**
 * 强制行动编排（仅 NORMAL，优先级：EXPOSED 演示 > Boss 反读 > 常规）：
 * - EXPOSED：flop 先演示「街段反例」(negStreet)，转/河先演示「行动反例」(negAction，
 *   必须来自 lead 过牌才能开出非高承诺窗口)，最后才给 positive（高承诺 → 窗口点亮）；
 * - 反读：未触发且计数达标的规则，主动制造匹配 bossAction 的行动（heavy→重注、
 *   raise→小注加注、check→lead 过牌）；条件不满足时返回 null 走常规决策。
 */
function forcedPlan(ctx, toCall, potBefore) {
  const state = v();
  if (state.boss.state === 'EXPOSED') {
    if (state.street === 'flop' && !G.demo.negStreet) {
      const d = heavyDecision(toCall, potBefore, ctx.lead);
      if (d) { G.demo.negStreet = true; return d; }
    }
    if (state.street === 'turn' || state.street === 'river') {
      if (!G.demo.negAction && ctx.lead && toCall === 0) {
        G.demo.negAction = true;
        return { action: 'check' };
      }
      if (!G.demo.positive && state.street === 'turn') {
        const d = toCall > 0
          ? { action: 'raise', raiseTo: Math.round(state.boss.bet + toCall + Math.max(1, Math.ceil(potBefore * 0.5))) }
          : (() => {
            const minBet = Math.max(10, Math.ceil(potBefore / 3));
            const maxTo = Math.round(state.boss.bet + state.boss.chips);
            return { action: 'bet', raiseTo: clamp(Math.ceil(potBefore * 0.6), minBet, maxTo) };
          })();
        if (d.raiseTo > Math.round(state.player.bet) && d.raiseTo <= Math.round(state.boss.bet + state.boss.chips)) {
          G.demo.positive = true;
          return d;
        }
      }
    }
  }
  // Boss 反读：按规则顺序制造匹配行动（计数保底已达标 → 窗口开启即布陷阱）
  for (const r of BOSS_COUNTER_RULES) {
    if (G.counterFired[r.id] || (G.counters[r.pattern] ?? 0) < r.threshold) continue;
    if (r.bossAction === 'heavy') {
      const d = heavyDecision(toCall, potBefore, ctx.lead);
      if (d) return d;
    } else if (r.bossAction === 'raise') {
      const d = smallRaiseDecision(toCall, potBefore);
      if (d) return d;
    } else if (r.bossAction === 'check' && ctx.lead && toCall === 0) {
      return { action: 'check' };
    }
  }
  return null;
}

/** GOTCHA 负债阶段的 Boss 决策（沿用 v4：不弃牌、无全下、继续抬阶梯）。 */
function decideDebt() {
  const state = v();
  const toCall = Math.max(0, Math.round(state.player.bet - state.boss.bet));
  if (toCall === 0) return Math.random() < 0.7 ? { action: 'raise' } : { action: 'check' };
  return Math.random() < 0.55 ? { action: 'raise' } : { action: 'call' };
}

function decideBoss(ctx = {}) {
  const state = v();
  const b = state.boss;
  const p = state.player;
  const toCall = Math.max(0, Math.round(p.bet - b.bet));
  const potBefore = Math.round(state.pot);

  /* ---- GOTCHA 负债阶段 ---- */
  if (G.debtMode) return decideDebt();

  /* ---- EXPOSED 演示 / Boss 反读：主动制造匹配行动 ---- */
  const forced = forcedPlan(ctx, toCall, potBefore);
  if (forced) return forced;

  /* ---- NORMAL 常规（沿用 v4 权重） ---- */
  if (state.street === 'preflop' && state.handNo >= DUEL_START_HAND && Math.random() < 0.7) {
    return { action: 'allin' };
  }
  if (toCall === 0) {
    const betP = G.bustedBuff ? 0.75 : 0.55;
    if (Math.random() < betP && b.chips > 0) return { action: 'bet' };
    return { action: 'check' };
  }
  if (toCall >= b.chips) {
    return { action: Math.random() < 0.25 ? 'fold' : 'call' };
  }
  const weights = G.bustedBuff
    ? { fold: 0.05, call: 0.4, raise: 0.4, allin: 0.15 }
    : { fold: 0.18, call: 0.5, raise: 0.27, allin: 0.05 };
  let r = Math.random();
  let action = 'call';
  for (const [name, w] of Object.entries(weights)) {
    r -= w;
    if (r <= 0) { action = name; break; }
  }
  if (action === 'raise') {
    const minTo = Math.max(1, Math.round(p.bet * 2));
    const maxTo = Math.round(b.bet + b.chips);
    const want = Math.round(b.bet + toCall + state.pot * (0.4 + Math.random() * 0.7));
    const raiseTo = clamp(want, Math.min(minTo, maxTo), Math.max(minTo, maxTo));
    if (raiseTo <= Math.round(p.bet)) return { action: 'call' };
    return { action: 'raise', raiseTo };
  }
  return { action };
}

function bossRespond(evs) {
  const state = v();
  const decision = decideBoss({ lead: false });

  if (decision.action === 'fold') {
    seatAction(1, 'fold', undefined, evs);
    markAction(1, 'fold');
    pushTalk(evs, pick(LINES_OPEN));
    closeWindowAndClear();      // 手牌结束：窗口/碎片一并清理
    foldWin(evs, 0);
    return;
  }
  if (decision.action === 'bet') {
    seatAction(1, 'bet', decision.raiseTo, evs);
    markAction(1, 'bet');
    if (Math.random() < 0.5) pushTalk(evs, pick(LINES_RAISE));
  } else if (decision.action === 'raise') {
    // 负债：amount 省略 → 阶梯；NORMAL：按编排好的 raise-to
    seatAction(1, 'raise', G.debtMode ? undefined : decision.raiseTo, evs);
    markAction(1, 'raise');
    if (Math.random() < 0.5) pushTalk(evs, pick(LINES_RAISE));
  } else if (decision.action === 'allin') {
    seatAction(1, 'allin', undefined, evs);
    markAction(1, 'allin');
    pushTalk(evs, pick(LINES_ALLIN));
  } else {
    seatAction(1, decision.action, undefined, evs); // call / check
    markAction(1, decision.action);
    if (Math.random() < 0.3) pushTalk(evs, pick(LINES_NORMAL));
  }

  if (roundClosed()) {
    closeWindowAndClear();      // 双方收街：不产生窗口（玩家没有待回应的决策）
    advanceStreet(evs);
  } else {
    state.toAct = 0; // Boss 加注/开注 → 回到玩家决定
    if (!G.debtMode && state.player.chips <= 0) {
      closeWindowAndClear();
      while (nextStreet(evs)) { /* runout */ }
      resolveShowdown(evs);
      return;
    }
    maybeOpenWindow(evs, G.lastBossTier); // ★ 玩家仍需回应 → 开 Tell Window
  }
  refreshGotcha(state);
  refreshLegal(state);
}

function advanceStreet(evs) {
  const state = v();
  if (!nextStreet(evs)) {
    resolveShowdown(evs);
    return;
  }
  // NORMAL：任一方没筹码 → 不再有下注轮，跑完摊牌；GOTCHA（负债）不受此限
  if (!G.debtMode && (state.player.chips <= 0 || state.boss.chips <= 0)) {
    while (nextStreet(evs)) { /* runout */ }
    resolveShowdown(evs);
    return;
  }
  newStreetState();

  let bossActed = false;
  if (G.debtMode) {
    // 负债阶段：Boss 也会主动开注（走阶梯）
    if (Math.random() < 0.6) {
      seatAction(1, 'raise', undefined, evs);
      markAction(1, 'raise');
      bossActed = true;
      if (Math.random() < 0.4) pushTalk(evs, pick(LINES_RAISE));
    }
  } else {
    // 先跑编排（EXPOSED 演示 / 反读）；常规 lead 只发生在 turn/river ——
    // flop 不主动 lead，保证「玩家先手、无窗口」的反例（NO_TELL_WINDOW）总会出现。
    const forced = forcedPlan({ lead: true }, 0, Math.round(state.pot));
    const leadP = state.street === 'flop' ? 0 : 0.7;
    const wantLead = forced ? true : Math.random() < leadP;
    if (wantLead && state.boss.chips > 0) {
      const decision = forced ?? (() => {
        const minBet = Math.max(10, Math.ceil(state.pot / 3));
        const maxTo = Math.round(state.boss.bet + state.boss.chips);
        return {
          action: 'bet',
          raiseTo: clamp(Math.round(state.pot * (0.35 + Math.random() * 0.6)), minBet, maxTo),
        };
      })();
      seatAction(1, decision.action, decision.raiseTo, evs);
      markAction(1, decision.action);
      bossActed = true;
      if (Math.random() < 0.4) pushTalk(evs, pick(LINES_RAISE));
    }
  }
  state.toAct = 0;
  if (bossActed && !roundClosed()) maybeOpenWindow(evs, G.lastBossTier);
  refreshGotcha(state);
  refreshLegal(state);
}

/* ------------------------------------------------------- BUSTED 触发 */

function maybeBusted(evs, action) {
  const state = v();
  if (G.bustedThisHand || G.debtMode) return;
  const cooldownOk = state.handNo - G.bustedLastHand >= 4;
  const firstTime = state.handNo === 4 && G.bustedLastHand < 0;
  const late = G.readBatchesThisHand >= 2
    && cooldownOk
    && ['pressure', 'heavy', 'allin'].includes(action);
  if (!firstTime && !late) return;

  G.bustedThisHand = true;
  G.bustedLastHand = state.handNo;
  G.bustedBuff = true; // Boss 获得本手攻击增益（不切换模式）
  const line = pick(LINES_BUSTED);
  state.boss.lastLine = line;
  feedOf('model', line);
  evs.push({ type: 'busted', line });
}

/* ------------------------------------------------------------ 接口处理 */

function onPlayerAction(action, amount) {
  const state = v();
  if (state.phase !== 'playing') return fail(400, '对局已结束，请点「再来一局」', 'BATTLE_OVER');
  if (state.toAct !== 0) return fail(400, '还没轮到你', 'NOT_YOUR_TURN');

  const ALL = ['fold', 'call', 'check', 'pressure', 'heavy', 'allin', 'bet', 'raise'];
  if (!ALL.includes(action)) return fail(400, `未知动作：${action}`, 'INVALID_ACTION');

  if (state.mode === 'NORMAL') {
    // NORMAL：bet / raise 拒绝
    if (action === 'bet' || action === 'raise') {
      return fail(400, '只有进入 GOTCHA 才能自由加注', 'NOT_GOTCHA');
    }
  } else {
    // GOTCHA：只允许 fold / call / check / raise（无 all-in 语义）
    if (action === 'pressure' || action === 'heavy') {
      return fail(400, '负债阶段没有压力预设', 'GOTCHA_ACTIONS');
    }
    if (action === 'allin') {
      return fail(400, '负债阶段不产生全下语义', 'GOTCHA_ACTIONS');
    }
    if (action === 'bet') {
      return fail(400, '负债阶段请使用 RAISE（阶梯）', 'GOTCHA_ACTIONS');
    }
  }

  const legal = state.player.legal ?? refreshLegal(state);
  if (action === 'fold' && !legal.fold) return fail(400, '当前不能弃牌', 'ILLEGAL');
  if (action === 'call' && !(Number(legal.call) > 0)) return fail(400, '当前没有需要跟的注', 'ILLEGAL');
  if (action === 'check' && !legal.check) return fail(400, '必须先跟注或弃牌', 'ILLEGAL');
  if ((action === 'pressure' || action === 'heavy') && !legal[action]) {
    return fail(400, '筹码不足，无法加压', 'ILLEGAL');
  }
  if (action === 'allin' && !(Number(legal.allin) > 0)) return fail(400, '没有可全下的筹码', 'ILLEGAL');
  if ((action === 'bet' || action === 'raise') && amount !== undefined && amount !== null
    && !Number.isFinite(Number(amount))) {
    return fail(400, 'amount 必须是数字', 'INVALID_AMOUNT');
  }

  const evs = [];
  const windowTier = state.tellWindow ? state.tellWindow.bossAction : null;

  seatAction(0, action, amount, evs);
  markAction(0, action);

  // PlayerModel 计数（反读 pattern 的累计）
  if (action === 'call') G.counters.callsFaced += 1;
  if (action === 'fold' && windowTier === 'heavy') G.counters.foldsToHeavy += 1;

  // BUSTED!（Player Model 把握度 → 本手攻击增益，不切换模式）
  maybeBusted(evs, action);

  // ★ 玩家回应落地、窗口关闭之前：PIN 的真话 × 行动 × 当前 intent → CRACK + 心理推进
  evaluateCrack(evs, action);

  // ★ Boss 反读：回应踩中窗口陷阱 → PLAYER CRACKED + 玩家心理推进（随后清空陷阱）
  evaluatePlayerCounter(evs, action);

  // ★ 任何成功行动 → 窗口即灭 + 无条件清空碎片/PIN（一窗一批，无论 CRACK 成败）
  closeWindowAndClear();

  if (action === 'fold') {
    foldWin(evs, 1);
    refreshGotcha(state);
    refreshLegal(state);
    return succeed(evs);
  }
  if (roundClosed()) {
    advanceStreet(evs);
    refreshGotcha(state);
    refreshLegal(state);
    return succeed(evs);
  }
  bossRespond(evs);
  refreshGotcha(state);
  refreshLegal(state);
  return succeed(evs);
}

/**
 * READ：必须在 Tell Window 内 + Focus 充足 + 冷却结束。
 * 错误码顺序（selftest 的 expectedRead 与此完全一致）：
 *   BATTLE_OVER → GOTCHA_AUTO_READ → NO_TELL_WINDOW（非玩家回合）→ NO_FOCUS →
 *   NO_TELL_WINDOW（无窗口）→ READ_COOLING
 */
function onRead() {
  const state = v();
  if (state.phase !== 'playing') return fail(400, '对局已结束', 'BATTLE_OVER');
  if (state.mode === 'GOTCHA') return fail(400, '负债阶段不能手动 READ', 'GOTCHA_AUTO_READ');
  if (state.toAct !== 0) return fail(400, '还没轮到你，窗口没开', 'NO_TELL_WINDOW');
  if (Math.round(Number(state.player.focus) || 0) < FOCUS_COST) {
    return fail(400, 'FOCUS 不足（翻前不开放、进街才恢复）', 'NO_FOCUS');
  }
  if (!G.curWindow) return fail(400, '心理窗口未开启 —— 他还没行动', 'NO_TELL_WINDOW');
  const now = Date.now();
  if (now < G.readCooldownUntil) return fail(400, 'READ 冷却中 —— 稍等 0.4 秒', 'READ_COOLING');

  G.readCooldownUntil = now + READ_COOLDOWN_MS;
  state.player.readCooldownUntil = G.readCooldownUntil;
  state.player.focus = Math.max(0, Math.round(state.player.focus) - FOCUS_COST);
  G.readBatchesThisHand += 1;

  const evs = [];
  emitManualBatch(evs);
  return succeed(evs);
}

function onPin(fragmentId) {
  const state = v();
  if (state.phase !== 'playing') return fail(400, '对局已结束', 'BATTLE_OVER');
  if (state.toAct !== 0) return fail(400, '不是你的回合，不能 PIN', 'NOT_YOUR_TURN');
  if (state.mode === 'GOTCHA') return fail(400, '负债阶段不能 PIN', 'PIN_NOT_ALLOWED');
  if (typeof fragmentId !== 'string' || !fragmentId) {
    return fail(400, '碎片不存在', 'BAD_FRAGMENT');
  }
  const meta = G.frags.get(fragmentId);
  if (!meta || meta.id == null) {
    return fail(400, '只有当前窗口 READ 出的碎片可以 PIN', 'BAD_FRAGMENT');
  }
  // ★ 只能 PIN 当前窗口产生的碎片：跨窗口残留的旧 id 一律 BAD_FRAGMENT
  if (!G.curWindow || meta.tellWindowId !== G.curWindow.id) {
    return fail(400, '这是上一个心理窗口的碎片', 'BAD_FRAGMENT');
  }

  // 单槽：新 PIN 覆盖旧 PIN
  G.pin = {
    id: meta.id,
    type: meta.type,           // 服务端私有
    tag: meta.tags[0] ?? null, // 服务端私有
    text: meta.text,
    atHand: meta.atHand,
    tellWindowId: meta.tellWindowId,
    verified: false,
  };
  state.pin = { text: meta.text, verified: false }; // wire：只有 text + verified
  feedOf('pin', `📌 ${meta.text}`);
  return succeed([]);
}

function onGotcha() {
  const state = v();
  if (state.phase !== 'playing') return fail(400, '对局已结束', 'BATTLE_OVER');
  if (state.toAct !== 0) return fail(400, '还没轮到你', 'NOT_YOUR_TURN');
  if (state.mode !== 'NORMAL') return fail(400, '已经在负债阶段', 'ALREADY_GOTCHA');
  if (!refreshGotcha(state)) {
    return fail(400, 'GOTCHA 窗口未开启（EXPOSED + 转/河 + 他刚高承诺行动）', 'GOTCHA_WINDOW_CLOSED');
  }
  if (Math.round(state.player.chips) <= 0 || Math.round(state.boss.chips) <= 0) {
    return fail(400, '已有全下边缘，无法进入负债状态', 'GOTCHA_LOCKED');
  }

  // 进入 GOTCHA：解除 Stack 上限、阶梯就位、depth 归零
  state.mode = 'GOTCHA';
  state.gotcha = null;
  G.debtMode = true;
  G.gotchaDepth = 0;
  G.gotchaRaiseStep = Math.max(G.lastRaiseSize || 0, state.blind.bb);
  closeWindowAndClear(); // 进入流程 → 窗口/碎片一并收掉

  const evs = [{ type: 'mode', mode: 'GOTCHA' }];
  feedOf('gotcha', 'GOTCHA 窗口命中 —— 进入负债决胜');
  feedOf('mode', '模式 → GOTCHA · 负债决胜');
  pushTalk(evs, pick(LINES_GOTCHA_ENTER));

  // 情绪：GOTCHA_HIT（EXPOSED 已封顶时无事件 —— 三态只有向右推进）
  pushMental(evs, {
    cause: 'GOTCHA_HIT', causeName: '被看穿还敢全押',
    hint: '他把你的判定当成了全力一搏 —— 敢进 GOTCHA 的人不多。',
  });

  refreshGotcha(state);
  refreshLegal(state);
  return succeed(evs);
}

function onNewGame(body) {
  const evs = newGame(body);
  return succeed(evs);
}

/* ------------------------------------------------------------ HTTP 工具 */

const succeed = (events) => ({ status: 200, body: { view: G.view, events } });
const fail = (status, error, code) => ({ status, body: code ? { error, code } : { error } });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 64 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.resolve(WEB_ROOT, `.${rel}`);
  if (filePath !== WEB_ROOT && !filePath.startsWith(WEB_ROOT + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }
  try {
    const data = await readFile(filePath);
    const type = MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-cache',
      'Content-Length': data.length,
    });
    if (req.method === 'HEAD') res.end();
    else res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

/* ------------------------------------------------------------ 路由 */

async function handleApi(req, res, pathname) {
  if (!G) newGame();

  if (req.method === 'GET' && pathname === '/api/state') {
    sendJson(res, 200, { view: G.view });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: '方法不允许' });
    return;
  }

  let result;
  try {
    const body = await readBody(req);
    switch (pathname) {
      case '/api/action': {
        const { action, amount } = body ?? {};
        result = onPlayerAction(action, amount);
        break;
      }
      case '/api/read':
        result = onRead();
        break;
      case '/api/pin':
        result = onPin(body?.fragmentId);
        break;
      case '/api/gotcha':
        result = onGotcha();
        break;
      case '/api/newgame':
        result = onNewGame(body);
        break;
      default:
        result = fail(404, '未知接口', 'NOT_FOUND');
    }
  } catch (err) {
    console.error('[api] 处理失败：', err);
    result = fail(500, '预览服务内部错误', 'INTERNAL');
  }
  sendJson(res, result.status, result.body);
}

const server = createServer(async (req, res) => {
  let pathname = '/';
  try {
    pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  } catch {
    res.writeHead(400);
    res.end('400');
    return;
  }

  if (pathname.startsWith('/api/')) {
    await handleApi(req, res, pathname);
    return;
  }
  await serveStatic(req, res, pathname);
});

/* ================================================================ 自测驱动 */

/**
 * `node scripts/preview.mjs --selftest` —— node 直连本服务的场景断言（×3 轮）。
 * 覆盖清单（与文件头一致）：
 *   tell_window 开与关 / READ 四类错误码 / Focus 进街+1·上限2·每手归0·耗尽 /
 *   碎片严格一窗一批（行动后清空 + 跨窗口 BAD_FRAGMENT）/
 *   CRACK → CALM/SHAKEN/EXPOSED（cause=CRACK）/ 玩家三态推进 /
 *   Boss 反读三规则 PLAYER CRACKED / GOTCHA 窗口恒等式（正反例）/
 *   GOTCHA 进入 · 泄漏 depth1/2 · 阶梯翻倍 · 三类错误码 · 结算后非负进下一手。
 * 期望值全部由 view 推导，与 canned 规则一一镜像；任何一条不满足 → 退出码非 0。
 */
async function selftest() {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  console.log(`[selftest] 临时服务已起：${base}`);

  const home = await http('GET', `${base}/`);
  assert(home.status === 200 && home.text.includes('id="app"'), `GET / → ${home.status}`);
  const css = await http('GET', `${base}/css/battle.css`);
  assert(css.status === 200, `GET /css/battle.css → ${css.status}`);
  const js = await http('GET', `${base}/js/app.js`);
  assert(js.status === 200, `GET /js/app.js → ${js.status}`);
  const st = await http('GET', `${base}/api/state`);
  assert(st.status === 200 && st.body && st.body.view, 'GET /api/state → 200 JSON');

  const ROUNDS = 3;
  for (let r = 1; r <= ROUNDS; r += 1) await runRound(base, r);
  console.log('[selftest] ✅ 3 轮全部场景断言通过');
}

const assert = (cond, msg) => {
  if (!cond) throw new Error(`断言失败：${msg}`);
};

async function http(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: method === 'GET' ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  return { status: res.status, text, body: json };
}
const json = (method, url, body) => http(method, url, body);

/** 与 onRead 的错误码顺序完全镜像。 */
function expectedRead(v) {
  if (v.phase !== 'playing') return 'BATTLE_OVER';
  if (v.mode === 'GOTCHA') return 'GOTCHA_AUTO_READ';
  if (v.toAct !== 0) return 'NO_TELL_WINDOW';
  if (Math.round(Number(v.player?.focus) || 0) < FOCUS_COST) return 'NO_FOCUS';
  if (!v.tellWindow) return 'NO_TELL_WINDOW';
  if (Date.now() < Math.round(Number(v.player?.readCooldownUntil) || 0)) return 'READ_COOLING';
  return null;
}

/** GOTCHA 窗口恒等式（资格 × 时机，与 refreshGotcha 完全一致）。 */
function expectedGotcha(v) {
  const la = v.boss?.lastAction;
  return v.mode === 'NORMAL'
    && v.toAct === 0
    && v.boss?.state === 'EXPOSED'
    && (v.street === 'turn' || v.street === 'river')
    && Boolean(la) && HIGH_COMMIT.has(la.action)
    && la.street === v.street;
}

const NEED_READ_ERRS = ['NO_FOCUS', 'NO_TELL_WINDOW', 'READ_COOLING', 'GOTCHA_AUTO_READ'];

function newCoverage() {
  return {
    readErrs: new Set(),
    readOk: 0,
    stalePin: false,
    windowClosed: 0,
    tellEvents: 0,
    bossStates: new Set(),
    mentalCauses: new Set(),
    counters: new Set(),
    playerStates: new Set(),
    gotchaPos: false,
    gotchaNegStreet: false,
    gotchaNegAction: false,
    gotchaEnter: false,
    gotchaErrClosed: false,
    gotchaErrAlready: false,
    gotchaErrActions: false,
    leaks: new Set(),
    ladderUp: false,
    focusReset: false,
    focusCap: false,
    cracks: 0,
  };
}

function coverageMissing(cov) {
  const miss = [];
  for (const c of NEED_READ_ERRS) if (!cov.readErrs.has(c)) miss.push(`READ:${c}`);
  if (cov.readOk < 1) miss.push('READ:成功批次');
  if (!cov.stalePin) miss.push('PIN:跨窗口BAD_FRAGMENT');
  if (cov.tellEvents < 1) miss.push('事件:tell_window_open');
  for (const s of ['CALM', 'SHAKEN', 'EXPOSED']) if (!cov.bossStates.has(s)) miss.push(`Boss状态:${s}`);
  if (!cov.mentalCauses.has('CRACK')) miss.push('事件:mental(CRACK)');
  for (const id of ['fear_pressure', 'over_call', 'agg_punish']) {
    if (!cov.counters.has(id)) miss.push(`反读:${id}`);
  }
  for (const s of ['CALM', 'SHAKEN', 'EXPOSED']) if (!cov.playerStates.has(s)) miss.push(`玩家状态:${s}`);
  if (!cov.gotchaPos) miss.push('GOTCHA:点亮');
  if (!cov.gotchaNegStreet) miss.push('GOTCHA:街段反例');
  if (!cov.gotchaNegAction) miss.push('GOTCHA:行动反例');
  if (!cov.gotchaEnter) miss.push('GOTCHA:进入');
  if (!cov.gotchaErrClosed) miss.push('GOTCHA:WINDOW_CLOSED');
  if (!cov.gotchaErrAlready) miss.push('GOTCHA:ALREADY');
  if (!cov.gotchaErrActions) miss.push('GOTCHA:ACTIONS');
  if (!cov.leaks.has(1) || !cov.leaks.has(2)) miss.push('GOTCHA:泄漏depth1/2');
  if (!cov.ladderUp) miss.push('GOTCHA:阶梯翻倍');
  if (!cov.focusReset) miss.push('Focus:每手归0');
  if (!cov.focusCap) miss.push('Focus:上限2');
  if (cov.cracks < 1) miss.push('事件:crack');
  if (cov.windowClosed < 1) miss.push('碎片:行动后清空');
  return miss;
}

/** 观察一个 view：全部不变式 + 覆盖记录（幂等，可重复调用同一 view）。 */
function observeView(v, cov, ctx, tag) {
  const inG = v.mode === 'GOTCHA';
  // 1) Tell Window：只在玩家回合 / NORMAL / 手牌进行中
  if (v.tellWindow) {
    assert(v.toAct === 0 && v.phase === 'playing' && !inG,
      `${tag} 窗口只在玩家回合/NORMAL：${JSON.stringify(v.tellWindow)}`);
    assert(v.tellWindow.id >= ctx.prevWinId, `${tag} 窗口 id 单调`);
    ctx.prevWinId = Math.max(ctx.prevWinId, v.tellWindow.id);
    assert(WINDOW_TIERS.has(v.tellWindow.bossAction), `${tag} 窗口档位=${v.tellWindow.bossAction}`);
    assert(Number(v.tellWindow.handId) === Number(v.handNo), `${tag} 窗口 handId 对齐`);
    assert(v.tellWindow.street === v.street, `${tag} 窗口 street 对齐`);
  }
  // 2) GOTCHA 窗口恒等式（资格×时机；正反例都由它兜底）
  assert(Boolean(v.gotcha) === expectedGotcha(v),
    `${tag} gotcha 恒等式失败：view=${JSON.stringify(v.gotcha)} street=${v.street} `
    + `state=${v.boss.state} la=${JSON.stringify(v.boss.lastAction)} mode=${v.mode} toAct=${v.toAct}`);
  if (v.gotcha) {
    assert(HIGH_COMMIT.has(v.gotcha.bossAction) && v.gotcha.street === v.street,
      `${tag} gotcha 字段 = ${JSON.stringify(v.gotcha)}`);
    cov.gotchaPos = true;
  }
  // 反例覆盖（非空场景：EXPOSED 且本街已有 Boss 行动）
  const la = v.boss.lastAction;
  if (v.boss.state === 'EXPOSED' && v.toAct === 0 && !inG && la && la.street === v.street) {
    if (v.street === 'flop' && HIGH_COMMIT.has(la.action)) cov.gotchaNegStreet = true;
    if ((v.street === 'turn' || v.street === 'river') && !HIGH_COMMIT.has(la.action)) {
      cov.gotchaNegAction = true;
    }
  }
  // 3) 碎片严格一窗一批
  assert(Array.isArray(v.readFragments), `${tag} readFragments 必须是数组`);
  if (v.readFragments.length) {
    if (inG) {
      for (const f of v.readFragments) assert(f.id === null, `${tag} 泄漏碎片不可有 id`);
    } else {
      assert(v.tellWindow, `${tag} 有碎片必须有窗口`);
      for (const f of v.readFragments) {
        assert(Number(f.tellWindowId) === Number(v.tellWindow.id),
          `${tag} 碎片必须属于当前窗口：${JSON.stringify(f)}`);
      }
    }
  }
  // 4) Focus 不变式
  const focus = Math.round(Number(v.player.focus) || 0);
  assert(focus >= 0 && focus <= FOCUS_MAX, `${tag} focus ∈ [0,${FOCUS_MAX}]：${focus}`);
  assert(Math.round(Number(v.player.focusMax) || 0) === FOCUS_MAX, `${tag} focusMax=${v.player.focusMax}`);
  if (focus === FOCUS_MAX) cov.focusCap = true;
  // 5) 三态取值
  assert(['CALM', 'SHAKEN', 'EXPOSED'].includes(v.boss.state), `${tag} boss.state=${v.boss.state}`);
  assert(['CALM', 'SHAKEN', 'EXPOSED'].includes(v.player.state), `${tag} player.state=${v.player.state}`);

  cov.bossStates.add(v.boss.state);
  cov.playerStates.add(v.player.state);
}

function observeEvents(evs, v, cov, ctx) {
  for (const ev of evs ?? []) {
    if (!ev || typeof ev !== 'object') continue;
    switch (ev.type) {
      case 'tell_window_open': {
        cov.tellEvents += 1;
        assert(WINDOW_TIERS.has(ev.bossAction), `窗口档位非法：${ev.bossAction}`);
        assert(ev.id >= ctx.prevWinId, '窗口事件 id 递增');
        ctx.prevWinId = Math.max(ctx.prevWinId, ev.id);
        assert(ev.actionId != null && ev.street, 'tell_window_open 字段齐全');
        break;
      }
      case 'read_batch': {
        if (ev.source === 'manual') {
          cov.readOk += 1;
          assert(ev.tellWindowId != null && v.tellWindow
            && Number(ev.tellWindowId) === Number(v.tellWindow.id),
          `read_batch.tellWindowId=${ev.tellWindowId} 窗口=${v.tellWindow && v.tellWindow.id}`);
          assert(Number(ev.actionId) === Number(v.tellWindow.actionId), 'read_batch.actionId 对齐窗口');
          const frags = ev.fragments ?? [];
          assert(frags.length >= NORMAL_BATCH[0] && frags.length <= NORMAL_BATCH[1],
            `批量条数 3–5：${frags.length}`);
          for (const f of frags) {
            assert(typeof f.id === 'string' && f.id.startsWith(`w${ev.tellWindowId}f`),
              `碎片 id 归属窗口：${f.id}`);
          }
        } else {
          const depth = Math.round(Number(ev.depth) || 0);
          if (depth > 0) cov.leaks.add(depth);
          for (const f of ev.fragments ?? []) assert(f.id === null, '泄漏碎片 id=null');
        }
        break;
      }
      case 'crack': {
        cov.cracks += 1;
        assert(ev.evidence && ev.action, 'crack 事件字段');
        break;
      }
      case 'mental': {
        assert(['CRACK', 'GOTCHA_HIT'].includes(ev.cause), `v5 mental.cause=${ev.cause}`);
        assert(ev.down === false, '三态只有向右推进：down 恒 false');
        cov.mentalCauses.add(ev.cause);
        break;
      }
      case 'player_cracked': {
        cov.counters.add(ev.ruleId);
        ctx.fired.add(ev.ruleId);              // 本局已触发（newgame 重置）
        assert(typeof ev.why === 'string' && ev.why.length > 0, 'player_cracked.why');
        assert(ev.bossAction && ev.action, 'player_cracked 字段齐全');
        break;
      }
      case 'player_mental': {
        assert(['CALM', 'SHAKEN', 'EXPOSED'].includes(ev.to), `player_mental.to=${ev.to}`);
        break;
      }
      case 'mode': {
        if (ev.mode === 'GOTCHA') cov.gotchaEnter = true;
        break;
      }
      case 'street': {
        // Focus：进街 +1（封顶）—— 与 nextStreet 的授予完全镜像
        ctx.focusExpected = Math.min(FOCUS_MAX, ctx.focusExpected + 1);
        break;
      }
      case 'hand_start': {
        if (ctx.lastHandEnd) {
          const st = ctx.lastHandEnd.stacks ?? {};
          assert(Math.round(Number(st.player)) > 0 && Math.round(Number(st.boss)) > 0,
            `绝不允许非正筹码进入下一手：${JSON.stringify(ctx.lastHandEnd.stacks)}`);
        }
        ctx.lastHandEnd = null;
        ctx.focusExpected = 0;
        ctx.pinFor = null;
        ctx.pinWindow = null;
        break;
      }
      case 'hand_end': {
        ctx.lastHandEnd = ev;   // 若随后出现 hand_start，stacks 必须为正
        break;
      }
      case 'game_over': {
        ctx.lastHandEnd = null;
        break;
      }
      default:
        break;
    }
  }
  cov.playerStates.add(v.player.state);
  cov.bossStates.add(v.boss.state);
}

/** 一轮完整驱动：newgame → 全场景 → 覆盖齐了才收工。 */
async function runRound(base, roundNo) {
  const cov = newCoverage();
  const ctx = {
    fired: new Set(),          // 本局已触发的反读规则（newgame 重置）
    prevWinId: 0,
    readTriedKeys: new Set(),
    cooldownTried: false,
    staleId: null,
    pinFor: null,              // 当前窗口已 PIN 的碎片 id（兑现 CRACK 用）
    pinWindow: null,
    gotchaClosedTried: false,
    gotchaReadTried: false,
    gotchaAlreadyTried: false,
    gotchaPressureTried: false,
    raised: false,
    called: false,
    firstStep: null,           // 首次 RAISE 前的阶梯步长（翻倍断言用）
    oldBossBet: 0,             // 首次 RAISE 前 Boss 的本街投入（跨街也能还原步长）
    lastHandEnd: null,         // 最近一次 hand_end（与 hand_start 配对做非负断言）
    focusExpected: 0,
    newgame: async () => {
      const r = await json('POST', `${base}/api/newgame`, {});
      assert(r.status === 200 && r.body && r.body.view, `newgame → ${r.status}`);
      ctx.fired = new Set();
      ctx.readTriedKeys = new Set();
      ctx.pinFor = null;
      ctx.pinWindow = null;
      ctx.focusExpected = 0;
      ctx.lastHandEnd = null;
      ctx.prevWinId = 0;              // 服务端 windowSeq 每局归零
      assert(Math.round(r.body.view.player.focus) === 0, 'newgame 后 focus=0');
      return r.body;
    },
  };

  let resp = await ctx.newgame();
  let v = resp.view;
  observeView(v, cov, ctx, `r${roundNo} 开局`);
  observeEvents(resp.events, v, cov, ctx);
  cov.focusReset = true;

  const MAX = 700;
  for (let i = 0; i < MAX; i += 1) {
    const tag = `r${roundNo}#${i}`;
    observeView(v, cov, ctx, tag);
    if (coverageMissing(cov).length === 0) break;

    /* ---------- 结局 / 低筹码：重开（覆盖保留、本局状态重置） ---------- */
    if (v.phase !== 'playing' || (v.mode === 'NORMAL' && Math.round(v.player.chips) < 150)) {
      resp = await ctx.newgame();
      v = resp.view;
      observeView(v, cov, ctx, `${tag} 重开`);
      observeEvents(resp.events, v, cov, ctx);
      continue;
    }

    /* ---------- 未轮到你（罐头同步，理论不出现）：静默轮询 ---------- */
    if (v.toAct !== 0) {
      const r = await json('GET', `${base}/api/state`);
      v = r.body.view;
      continue;
    }

    /* ---------- GOTCHA 负债阶段：错误码三连 → RAISE 泄漏 → CALL 泄漏 → FOLD ---------- */
    if (v.mode === 'GOTCHA') {
      assert(v.tellWindow === null, `${tag} 负债阶段不应有 Tell Window`);
      assert(expectedRead(v) === 'GOTCHA_AUTO_READ', `${tag} 负债阶段 READ 期望码`);
      if (!ctx.gotchaReadTried) {
        ctx.gotchaReadTried = true;
        const r = await json('POST', `${base}/api/read`, {});
        assert(r.status === 400 && r.body && r.body.code === 'GOTCHA_AUTO_READ',
          `${tag} 负债 READ → GOTCHA_AUTO_READ：${JSON.stringify(r.body)}`);
        cov.readErrs.add('GOTCHA_AUTO_READ');
      }
      if (!ctx.gotchaAlreadyTried) {
        ctx.gotchaAlreadyTried = true;
        const r = await json('POST', `${base}/api/gotcha`, {});
        assert(r.status === 400 && r.body && r.body.code === 'ALREADY_GOTCHA',
          `${tag} 二次发动 → ALREADY_GOTCHA：${JSON.stringify(r.body)}`);
        cov.gotchaErrAlready = true;
      }
      if (!ctx.gotchaPressureTried) {
        ctx.gotchaPressureTried = true;
        const r = await json('POST', `${base}/api/action`, { action: 'pressure' });
        assert(r.status === 400 && r.body && r.body.code === 'GOTCHA_ACTIONS',
          `${tag} 负债 pressure → GOTCHA_ACTIONS：${JSON.stringify(r.body)}`);
        cov.gotchaErrActions = true;
      }

      const legalG = v.player.legal ?? {};
      let action;
      if (!ctx.raised) action = 'raise';
      else if (!ctx.called) action = Number(legalG.call) > 0 ? 'call' : 'raise';
      else action = 'fold';
      const target = Math.round(Number(legalG.gotchaRaiseTo) || 0);
      if (action === 'raise' && !ctx.raised) {
        // 首次 RAISE：记录旧步长 = 目标 − Boss 本街已投入（之后每步必须 ≥ 2×）
        assert(target > 0, `${tag} 阶梯 RAISE 目标存在`);
        ctx.oldBossBet = Math.round(v.boss.bet);
        ctx.firstStep = target - ctx.oldBossBet;
        assert(ctx.firstStep > 0, `${tag} 旧阶梯步长为正：${ctx.firstStep}`);
      }

      const r = await json('POST', `${base}/api/action`, { action });
      assert(r.status === 200, `${tag} GOTCHA ${action} → ${JSON.stringify(r.body)}`);
      const evs = Array.isArray(r.body.events) ? r.body.events : [];
      const nv = r.body.view;

      if (action === 'raise' || action === 'call') {
        const leaks = evs.filter((e) => e.type === 'read_batch' && e.source === 'gotcha');
        assert(leaks.length >= 1, `${tag} ${action} 必须触发心理泄漏`);
      }
      if (action === 'raise') ctx.raised = true;
      if (action === 'call') ctx.called = true;
      if (action === 'fold') {
        assert(nv.mode === 'NORMAL' || nv.phase !== 'playing',
          `${tag} FOLD 结算后必须退出负债：mode=${nv.mode} phase=${nv.phase}`);
        if (nv.phase === 'playing') {
          // 进手前筹码 >0 的严格断言在 observeEvents 的 hand_end/hand_start 配对里；
          // 这里只保证结算不产生负数（0 = 盲注把最后一点筹码吃掉的边缘态）
          assert(Math.round(nv.player.chips) >= 0, `${tag} 结算不产生负数筹码`);
        }
      }
      if (ctx.firstStep !== null) {
        if (nv.mode === 'GOTCHA' && nv.phase === 'playing') {
          const nt = Math.round(Number(nv.player.legal?.gotchaRaiseTo) || 0);
          const impliedStep = nt - Math.round(nv.boss.bet);   // 隐含阶梯步长（street 无关）
          if (impliedStep >= ctx.firstStep * 2) cov.ladderUp = true;
        }
      }

      v = nv;
      observeView(v, cov, ctx, `${tag} GOTCHA后`);
      observeEvents(evs, v, cov, ctx);
      if (v.phase === 'playing') {
        assert(Math.round(v.player.focus) === ctx.focusExpected,
          `${tag} GOTCHA后 focus 期望 ${ctx.focusExpected} 实际 ${v.player.focus}`);
      }
      continue;
    }

    /* ---------- 窗口没亮时发动 GOTCHA → GOTCHA_WINDOW_CLOSED（每轮一次） ---------- */
    if (!ctx.gotchaClosedTried && !v.gotcha) {
      ctx.gotchaClosedTried = true;
      const r = await json('POST', `${base}/api/gotcha`, {});
      assert(r.status === 400 && r.body && r.body.code === 'GOTCHA_WINDOW_CLOSED',
        `${tag} 未点亮时发动 → GOTCHA_WINDOW_CLOSED：${JSON.stringify(r.body)}`);
      cov.gotchaErrClosed = true;
    }

    /* ---------- GOTCHA 窗口点亮 → 只在转牌进入（河牌点亮先记覆盖、正常回应） ---------- */
    if (v.gotcha && v.gotcha.street === 'turn') {
      assert(expectedGotcha(v), `${tag} 进入前窗口必须满足恒等式`);
      const r = await json('POST', `${base}/api/gotcha`, {});
      assert(r.status === 200, `${tag} 进入 GOTCHA → ${JSON.stringify(r.body)}`);
      const evs = Array.isArray(r.body.events) ? r.body.events : [];
      assert(evs.some((e) => e.type === 'mode' && e.mode === 'GOTCHA'), `${tag} mode 事件`);
      v = r.body.view;
      assert(v.mode === 'GOTCHA' && v.gotcha === null && v.tellWindow === null,
        `${tag} 进入后 mode/window 状态`);
      assert(v.readFragments.length === 0 && v.pin === null,
        `${tag} 进入流程清空碎片与 PIN`);
      cov.gotchaEnter = true;
      observeView(v, cov, ctx, `${tag} 进入GOTCHA`);
      observeEvents(evs, v, cov, ctx);
      continue;
    }

    /* ---------- 当前窗口上下文（PIN 只跟随当前窗口） ---------- */
    let tw = v.tellWindow;
    if (tw) {
      if (ctx.pinWindow !== String(tw.id)) {
        ctx.pinFor = null;
        ctx.pinWindow = String(tw.id);
      }
    } else {
      ctx.pinFor = null;
      ctx.pinWindow = null;
    }
    const counter = tw
      ? BOSS_COUNTER_RULES.find((r) => !ctx.fired.has(r.id) && r.bossAction === tw.bossAction)
      : null;

    /* ---------- READ：错误覆盖 / 主动读（与 expectedRead 镜像） ---------- */
    const exp = expectedRead(v);
    const key = tw ? `w${tw.id}` : `nowin:${exp ?? 'ok'}`;
    // 演示 Focus 上限：flop 一律先不读，把 1 点带到 turn 撞出 FOCUS 2/2
    const deferCap = !cov.focusCap && v.street === 'flop' && Math.round(v.player.focus) >= 1;
    const wantRead = Boolean(tw)
      && Math.round(v.player.focus) >= FOCUS_COST
      && !counter
      && !deferCap;

    if (!ctx.readTriedKeys.has(key)) {
      let attempt = false;
      if (exp === null) {
        attempt = wantRead;
        if (!attempt) ctx.readTriedKeys.add(key);
      } else if (NEED_READ_ERRS.includes(exp) && !cov.readErrs.has(exp)) {
        attempt = true;
      } else {
        ctx.readTriedKeys.add(key);
      }

      if (attempt) {
        const r = await json('POST', `${base}/api/read`, {});
        if (exp === null) {
          assert(r.status === 200, `${tag} READ 应成功 → ${JSON.stringify(r.body)}`);
          const beforeFocus = Math.round(v.player.focus);
          v = r.body.view;
          observeView(v, cov, ctx, `${tag} READ后`);
          observeEvents(r.body.events, v, cov, ctx);
          assert(Math.round(v.player.focus) === beforeFocus - FOCUS_COST,
            `${tag} READ 消耗 1 Focus：${beforeFocus} → ${v.player.focus}`);
          ctx.focusExpected = Math.round(v.player.focus);

          // 冷却立刻补一刀 → READ_COOLING（每轮一次）
          if (!ctx.cooldownTried) {
            ctx.cooldownTried = true;
            const r2 = await json('POST', `${base}/api/read`, {});
            assert(r2.status === 400 && r2.body && r2.body.code === 'READ_COOLING',
              `${tag} 连读 → READ_COOLING：${JSON.stringify(r2.body)}`);
            cov.readErrs.add('READ_COOLING');
          }

          // PIN frag0（只对当前窗口有效）
          const f0 = v.readFragments[0];
          assert(f0 && f0.id, `${tag} READ 后必须有碎片`);
          assert(Number(f0.tellWindowId) === Number(v.tellWindow && v.tellWindow.id),
            `${tag} 碎片属于当前窗口`);
          const rp = await json('POST', `${base}/api/pin`, { fragmentId: f0.id });
          assert(rp.status === 200, `${tag} PIN → ${JSON.stringify(rp.body)}`);
          v = rp.body.view;
          assert(v.pin && v.pin.text === f0.text, `${tag} view.pin 对齐 frag0`);
          ctx.pinFor = String(f0.id);
          ctx.pinWindow = String(f0.tellWindowId);
          ctx.staleId = String(f0.id);   // 关窗后留作跨窗口 BAD_FRAGMENT 断言
          ctx.readTriedKeys.add(key);
        } else {
          assert(r.status === 400 && r.body && r.body.code === exp,
            `${tag} READ 期望 ${exp} → ${JSON.stringify(r.body)}`);
          cov.readErrs.add(exp);
          ctx.readTriedKeys.add(key);
        }
      }
    }

    /* ---------- 选牌桌行动 ---------- */
    tw = v.tellWindow;
    const toCall = Math.round(v.player.toCall) > 0;
    const pinnedHere = Boolean(tw && ctx.pinFor && ctx.pinWindow === String(tw.id));
    const legal = v.player.legal ?? {};
    let action;
    if (pinnedHere) {
      action = toCall ? 'call' : 'check';            // 兑现 frag0 对齐（CRACK 判定）
    } else if (counter) {
      action = counter.playerAction === 'bet' ? 'pressure' : counter.playerAction;
    } else if (!toCall && ctx.fired.size < BOSS_COUNTER_RULES.length
      && legal.pressure && Math.round(v.player.chips) > 150) {
      action = 'pressure';                            // 挑逗 Boss 回出反读窗口
    } else {
      action = toCall ? 'call' : 'check';
    }
    // 合法性兜底（绝不发出会被 400 的行动）
    if (action === 'call' && !(Number(legal.call) > 0)) action = legal.check ? 'check' : 'fold';
    // 没 PIN 时绝不硬接昂贵跟注（保住演示筹码；PIN 过的对齐行动照接 → CRACK）
    if (action === 'call' && !pinnedHere && !counter
      && Math.round(Number(legal.call) || 0) > Math.max(80, Math.round(v.player.chips) * 0.3)) {
      action = 'fold';
    }
    if (action === 'check' && legal.check !== true) action = Number(legal.call) > 0 ? 'call' : 'fold';
    if (action === 'pressure' && !legal.pressure) action = toCall ? 'call' : 'check';
    if (action === 'fold' && !legal.fold) action = 'call';

    const prevState = v.boss.state;
    const prevWindowId = tw ? tw.id : 0;
    const pinned = pinnedHere ? String(ctx.pinFor) : null;

    const r = await json('POST', `${base}/api/action`, { action });
    assert(r.status === 200, `${tag} action ${action} → ${JSON.stringify(r.body)}`);
    const evs = Array.isArray(r.body.events) ? r.body.events : [];
    const nv = r.body.view;

    /* ---------- 行动后断言：窗口即灭、碎片 / PIN 无条件清空（一窗一批） ---------- */
    if (nv.mode === 'NORMAL') {
      assert(Array.isArray(nv.readFragments) && nv.readFragments.length === 0,
        `${tag} 行动后碎片必须清空：${JSON.stringify(nv.readFragments)}`);
      assert(nv.pin === null, `${tag} 行动后 PIN 必须清空`);
      assert(!nv.tellWindow || nv.tellWindow.id > prevWindowId,
        `${tag} 旧窗口必须关闭（新窗口 id 更大）`);
      cov.windowClosed += 1;
    }

    /* ---------- 反读断言：匹配窗口陷阱的行动必须踩中 ---------- */
    if (counter) {
      const pc = evs.find((e) => e.type === 'player_cracked');
      assert(pc && pc.ruleId === counter.id,
        `${tag} 期望 player_cracked(${counter.id}) action=${action} 窗口=${tw && tw.bossAction}`
        + ` 事件=[${evs.map((e) => e.type).join(',')}]`);
    }

    /* ---------- CRACK 断言：PIN 的真话 × 对齐行动（canned 意图对齐保证） ---------- */
    if (pinned && (action === 'call' || action === 'check')) {
      assert(evs.some((e) => e.type === 'crack'),
        `${tag} PIN + 对齐行动必须出 CRACK：action=${action}`);
      if (prevState !== 'EXPOSED') {
        assert(evs.some((e) => e.type === 'mental' && e.cause === 'CRACK'),
          `${tag} CRACK 后必须紧跟 mental 推进`);
      }
    }

    v = nv;
    observeView(v, cov, ctx, `${tag} 行动后`);
    observeEvents(evs, v, cov, ctx);
    if (v.phase === 'playing' && v.mode === 'NORMAL') {
      assert(Math.round(v.player.focus) === ctx.focusExpected,
        `${tag} focus 期望 ${ctx.focusExpected} 实际 ${v.player.focus}`);
    }

    /* ---------- 跨窗口旧 id PIN → BAD_FRAGMENT（每轮一次） ---------- */
    if (!cov.stalePin && ctx.staleId && v.mode === 'NORMAL' && v.phase === 'playing') {
      const rp = await json('POST', `${base}/api/pin`, { fragmentId: ctx.staleId });
      assert(rp.status === 400 && rp.body && rp.body.code === 'BAD_FRAGMENT',
        `${tag} 跨窗口旧 id PIN → BAD_FRAGMENT：${JSON.stringify(rp.body)}`);
      cov.stalePin = true;
    }
  }

  const miss = coverageMissing(cov);
  assert(miss.length === 0, `第 ${roundNo} 轮覆盖缺失：${miss.join('、')}`);
  console.log(
    `[selftest] 第 ${roundNo} 轮 ✅ READ错误[${[...cov.readErrs].join('/')}] 读取×${cov.readOk}`
    + ` 窗口×${cov.tellEvents} 清空×${cov.windowClosed}`
    + ` Boss[${[...cov.bossStates].join('→')}] 玩家[${[...cov.playerStates].join('→')}]`
    + ` 反读[${[...cov.counters].join(',')}]`
    + ` GOTCHA亮/街反/行反/进=${+cov.gotchaPos}/${+cov.gotchaNegStreet}/${+cov.gotchaNegAction}/${+cov.gotchaEnter}`
    + ` 泄漏depth[${[...cov.leaks].join(',')}]`
    + ` CRACK×${cov.cracks}`,
  );
}

/* ------------------------------------------------------------- 启动 */

function shutdown(code) {
  try {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  } catch { /* 忽略 */ }
  if (!server.listening) {
    process.exit(code);
    return;
  }
  server.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 1500).unref();
}

if (SELFTEST) {
  selftest()
    .then(() => shutdown(0))
    .catch((err) => {
      console.error('[selftest] ❌', err && err.stack ? err.stack : err);
      shutdown(1);
    });
} else {
  server.listen(PORT, () => {
    console.log(`《allin》v5 预览服务已启动：http://localhost:${PORT}`);
    console.log(`静态根目录：${WEB_ROOT}`);
    console.log('canned 流程：Boss 行动 → 🧠 Tell Window → READ(FOCUS 一窗一批) → PIN frag0 →');
    console.log('             对齐行动出 CRACK → CALM/SHAKEN/EXPOSED；Boss 反读 → PLAYER CRACKED；');
    console.log('             EXPOSED + 转/河高承诺 → GOTCHA 窗口（资格×时机）→ 负债决胜 → 统一结算。');
    console.log('自测：node scripts/preview.mjs --selftest（3 轮全场景断言）');
    if (PREVIEW_DEMO) console.log(`结局预设：${PREVIEW_DEMO}（可被 /api/newgame { demo } 覆盖）`);
  });
}
