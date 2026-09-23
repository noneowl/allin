#!/usr/bin/env node
/**
 * scripts/preview.mjs — 《allin》前端独立预览服务器（v3 编排）
 *
 *   node scripts/preview.mjs            # 默认端口 8791
 *   PORT=9000 node scripts/preview.mjs  # 端口覆盖
 *   PREVIEW_DEMO=victory node ...       # 预设结局走向（可被 newgame 请求体覆盖）
 *
 * 职责：
 * 1. 静态托管 web/（无构建、原生 ES Modules）；
 * 2. 实现 docs/PROTOCOL.md（v3）的 5 个 API，返回精心编排的 canned 数据，
 *    用于在没有真实服务端时自查全部 UI 分支：
 *    - READ 碎片闪现（0.5–1.5s、EXECUTION ×0.6、25% 连发）→ 第 2/3 条后 CRACK；
 *    - GOTCHA 双分支：判断正确 → EXECUTION（自由滑杆 + 高速 READ）；
 *                    判断错误 → COUNTER（Boss 反扑）；
 *      罐头把 CRACK kind 与 Boss intent 对齐（WEAKNESS↔BLUFF / STRENGTH↔VALUE），
 *      因此「按提示猜 = 对，反着猜 = 错」，两条路都稳定可复现；
 *    - BUSTED!（第 4 手必发；之后 3 次 READ + 重压再触发，冷却 4 手）；
 *    - 盲注升级横幅（第 3/5/7/9 手 blindUp；第 3 手必达，保证横幅可演示）；
 *    - 三状态情绪 CALM → SHAKEN → TILT（gotcha 命中 / 第 3、5 手保底推进）；
 *    - 筹码堆迁移（hand_end.stacks / pot_move）、victory / defeat 结局。
 * 3. 无浏览器环境下用 node 直连本服务即可驱动完整事件链（自查接线用）。
 *
 * ⚠️ 这是「编排好的演示服务端」，不是真实规则引擎 —— 一切以驱动 UI 为目的。
 * 预览专属扩展（真实服务端可以不实现，前端不依赖）：
 *   - POST /api/newgame 请求体可带 { demo: "victory" | "defeat" } 预设结局走向；
 *   - view.cracks[i] 附加 used: { guess, correct }（前端在缺省时用会话内记忆兜底）。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(__dirname, '..', 'web');
const PORT = Number(process.env.PORT) || 8791;
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

const START_PLAYER = 500;   // 不对称挑战：500 vs 5000
const START_BOSS = 5000;
const READ_COOLDOWN_MS = 400;   // 契约：READ 冷却（超前请求 400 READ_COOLING）
const EXECUTION_FLASH_K = 0.6;  // EXECUTION：碎片显示更快
const DUEL_START_HAND = 7;      // 第 7 手起 Boss 进入「全下决胜」节奏

const FACES = {
  CALM: ['😏', '冷静'],
  SHAKEN: ['😳', '动摇'],
  TILT: ['😡', '上头'],
};
const STATE_HINT = {
  CALM: '冷静：碎片短、噪音多，真话藏得很深。',
  SHAKEN: '动摇：碎片变多，情绪和真实意图开始泄漏。',
  TILT: '上头：真话密集，也开始说自欺的错觉。',
};
const LADDER = { CALM: 'SHAKEN', SHAKEN: 'TILT', TILT: 'TILT' };

/** 盲注梯度：第 upTo 手（含）之前使用该档；档位变化即 blindUp（第 3/5/7/9 手升级）。 */
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

const LINES_OPEN = ['这一手你最好直接弃。', '你跟不动这一枪。', '信不信我这里全是价值？'];
const LINES_NORMAL = ['就这点筹码也敢看我？', '我赌你不敢跟。', '你的手在抖，我知道。', '跟注吧，我想亲眼看你输。'];
const LINES_RAISE = ['加注。你倒是接啊。', '这一枪我看你怎么接。', '大点好，我喜欢。'];
const LINES_ALLIN = ['全下？我接了。', '让你看看什么叫统治。', '好啊，一局定生死。'];
const LINES_BUSTED = ['我看穿你了 —— 全部下注！'];
const LINES_COUNTER = ['……这手你可猜错了。', '换你被我盯上了。', '急了？我等的就是这个。'];
const LINES_EXEC_LOSS = ['……你居然真的看穿了。', '行，这手是我在诈。', '算你狠，记下了。'];
const HEART_V = '我只是……不想承认你真的看穿我了。';
const HEART_D = '……原来从头到尾，被看穿的人是我。';

/* 碎片池：类型/标签只在服务端 —— 前端永远只看到 text。 */
const NOISE = [
  '筹码有点重。', '灯太亮了，晃眼。', '这副牌手感不错。', '我有点口渴。',
  '别磨蹭了。', '下次该换副新牌了。',
];
const DISTORTION = [
  '你根本看不懂我。', '这把我已经赢了。', '没人能接住我这一枪。', '我早就计划好了。',
];
const TAG_TEXT = {
  wants_fold: ['最好别跟。', '你现在弃，还来得及。', '这枪你接不动，弃了吧。'],
  weak_hand: ['……这手我自己都没底。', '说真的，你可以跟。', '你要是跟，我就麻烦了。'],
  strong_hand: ['我劝你别接这一枪。', '这一枪你想清楚。', '我把整晚都压上了。'],
  trap: ['……你确定？', '我等你很久了。', '尽管加注，我不拦你。'],
  fear_call: ['别再加了。', '你再推我就得弃了。', '这个价格我跟不动。'],
  draw: ['给我一张就成。', '就差一点点。'],
  missed_board: ['这张牌我很不喜欢。', '牌面完全不理我。'],
  overconfidence: ['你已经输了，只是你还不知道。'],
};
const CRITICAL_TEXT = '其实我什么都没有 —— 可你敢信吗？';

const EVIDENCE_RULES = [
  { key: 'wf_wh', kind: 'WEAKNESS', all: ['wants_fold', 'weak_hand'], strength: 2 },
  { key: 'fc_wh', kind: 'WEAKNESS', all: ['fear_call', 'weak_hand'], strength: 2 },
  { key: 'fc_wf', kind: 'WEAKNESS', all: ['fear_call', 'wants_fold'], strength: 2 },
  { key: 'sh_tr', kind: 'STRENGTH', all: ['strong_hand', 'trap'], strength: 2 },
  { key: 'sh_fc', kind: 'STRENGTH', all: ['strong_hand', 'fear_call'], strength: 3 },
];

const INTENTS = [
  ['BLUFF', 0.35], ['VALUE', 0.3], ['PROBE', 0.15], ['TRAP', 0.1], ['CONTROL', 0.1],
];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
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

/** 罐头用的粗略牌型名：四条 > 三条 > 两对 > 一对 > null（未成型）。 */
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
  // 高牌：给个最大张名字（仅供 HUD 展示，非规则判定）
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
      legal: null, readCooldownUntil: 0,
    },
    boss: {
      chips: START_BOSS, bet: 0, hole: null,
      state: 'CALM', face: FACES.CALM[0], mood: FACES.CALM[1],
      stateHint: STATE_HINT.CALM,
      lastAction: null, lastLine: '',
    },
    gotcha: null,
    cracks: [],
    history: [],
    readFragments: [],
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
    readSeqInHand: 0,
    readsThisHand: 0,
    tagWindow: new Set(),
    crackedRules: new Set(),
    crackSeq: 0,
    criticalUsedThisHand: false,
    intent: 'PROBE',
    correctStreak: 0,
    gotchaCount: 0,
    lastBustedHand: -99,
    bustedThisHand: false,
    lastHandAllIn: false,
    prevTierKey: null,
    force,
    st: { pActed: false, bActed: false, aggr: null, last: null },
    bossHole: [],
    extraSeq: 0,
  };
  const evs = [];
  startHand(evs);
  feedOf('system', `对局开始：你 ${START_PLAYER} vs Boss ${START_BOSS}，把他打到 0。`);
  return evs;
}

const draw = () => {
  const card = G.deck[G.deckIdx % G.deck.length];
  G.deckIdx += 1;
  return card;
};

const v = () => G.view;

function feedOf(kind, text) {
  const feed = v().feed;
  feed.push({ kind, text });
  if (feed.length > 100) feed.splice(0, feed.length - 100);
}

function refreshEffective(state = v()) {
  state.effectiveStack = Math.min(
    Math.max(0, Math.round(state.player.chips)),
    Math.max(0, Math.round(state.boss.chips)),
  );
}

function applyState(state, name) {
  const [face, mood] = FACES[name] ?? FACES.CALM;
  state.boss.state = name;
  state.boss.face = face;
  state.boss.mood = mood;
  state.boss.stateHint = STATE_HINT[name] ?? STATE_HINT.CALM;
}

function pushMental(evs, { cause, causeName, hint }) {
  const state = v();
  const from = state.boss.state;
  const to = LADDER[from] ?? from;
  if (to === from) return false;
  applyState(state, to);
  evs.push({
    type: 'mental', from, to, cause, causeName,
    hint: hint ?? STATE_HINT[to], down: true,
  });
  feedOf('mental', `${FACES[from]?.[1] ?? from} → ${FACES[to]?.[1] ?? to} · ${causeName ?? cause}`);
  return true;
}

function pushTalk(evs, line) {
  v().boss.lastLine = line;
  evs.push({ type: 'talk', line });
  feedOf('talk', line);
}

/* ------------------------------------------------------------ legal 计算 */

function refreshLegal(state = v()) {
  const p = state.player;
  const b = state.boss;
  const pot = Math.round(state.pot) || 0;
  const rawCall = Math.max(0, Math.round(b.bet - p.bet));
  const toCall = Math.min(rawCall, Math.max(0, Math.round(p.chips)));
  p.toCall = toCall;

  const maxTo = Math.round(p.bet + p.chips);
  const minTo = rawCall > 0
    ? Math.max(1, Math.round(b.bet * 2))
    : Math.max(10, Math.ceil(pot / 3));
  const lo = Math.min(minTo, maxTo);
  const hi = Math.max(lo, maxTo);

  p.legal = {
    check: rawCall === 0,
    call: rawCall > 0 && p.chips > 0 ? toCall : false,
    fold: p.chips > 0,
    pressure: p.chips > 0,
    heavy: p.chips > 0,
    pressureTo: clamp(Math.round(p.bet + pot * 0.5), lo, hi),
    heavyTo: clamp(Math.round(p.bet + pot * 1.0), lo, hi),
    // 自由尺寸字段：客户端必须再用 mode==='EXECUTION' 门禁
    bet: rawCall === 0 && p.chips > 0,
    raise: rawCall > 0 && p.chips > 0,
    minTo,
    maxTo: hi,
    allin: Math.max(0, Math.round(p.chips)),
  };
  p.handName = evalHandName(p.hole, state.board);
  refreshEffective(state);
  return p.legal;
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

/** Boss 下一次重要行动 → 未使用的证据与 CRACK 过期（旧意图作废）。 */
function expirePendingCrack() {
  const state = v();
  G.tagWindow.clear();
  G.crackedRules.clear();
  if (state.gotcha) state.gotcha = null;
  G.intent = rollIntent();
}

/**
 * 一次下注动作（seat 0=玩家 1=Boss）。
 * bet/raise/pressure/heavy 的 amount 为 raise-to 语义；pressure/heavy 不带 amount，服务端算。
 */
function seatAction(seat, action, amount, evs) {
  const state = v();
  const who = seat === 0 ? state.player : state.boss;
  const other = seat === 0 ? state.boss : state.player;
  const potBefore = state.pot;
  let put = 0;
  let evAmount;
  let allIn = false;

  const minRaiseTo = other.bet > 0
    ? Math.max(1, Math.round(other.bet * 2))
    : Math.max(10, Math.ceil(potBefore / 3));
  const maxTo = Math.round(who.bet + who.chips);

  if (action === 'call') {
    put = Math.min(Math.max(0, Math.round(other.bet - who.bet)), Math.round(who.chips));
    evAmount = put;
  } else if (action === 'bet' || action === 'raise') {
    const want = Number.isFinite(Number(amount)) ? Math.round(Number(amount)) : minRaiseTo;
    const raiseTo = clamp(want, Math.min(minRaiseTo, maxTo), Math.max(minRaiseTo, maxTo));
    put = Math.max(0, raiseTo - Math.round(who.bet));
    evAmount = raiseTo;
  } else if (action === 'pressure' || action === 'heavy') {
    const frac = action === 'pressure' ? 0.5 : 1.0;
    const raiseTo = clamp(Math.round(who.bet + potBefore * frac), Math.min(minRaiseTo, maxTo), Math.max(minRaiseTo, maxTo));
    put = Math.max(0, raiseTo - Math.round(who.bet));
    evAmount = raiseTo;
  } else if (action === 'allin') {
    // 不对称筹码：大筹码一方的全下按「小筹码一方最多能接」截断（免 side-pot）
    const cap = seat === 1
      ? Math.round(state.player.bet + state.player.chips - state.boss.bet)
      : Infinity;
    put = Math.min(Math.round(who.chips), Math.max(0, cap));
    evAmount = Math.round(who.bet) + put;
    allIn = true;
  }

  if (put > who.chips) {
    put = Math.round(who.chips);
    allIn = true;
  }
  if (who.chips <= 0) put = 0;
  who.chips -= put;
  who.bet += put;
  state.pot += put;
  if (who.chips === 0 && put > 0) allIn = true;
  if (action === 'allin') allIn = true;
  if (allIn) G.lastHandAllIn = true;

  if (evAmount === undefined) evAmount = put; // fold / check / call 统一带上投入额
  evs.push({ type: 'action', seat, action, amount: evAmount, put, potAfter: state.pot, allIn });
  state.history.push({
    handNo: state.handNo,
    street: state.street,
    actor: seat === 0 ? 'player' : 'boss',
    action,
    amount: evAmount,
  });
  if (state.history.length > 60) state.history.splice(0, state.history.length - 60);

  if (seat === 1) {
    state.boss.lastAction = { action, amount: evAmount, street: state.street };
    // 重要行动（下注/加注/全下）→ 证据窗口与未使用的 CRACK 过期
    if (action === 'bet' || action === 'raise' || action === 'allin') expirePendingCrack();
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

/** 开一手：hand_start（blindUp 横幅）→ 保底情绪推进 → 发盲注。 */
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
  state.gotcha = null;
  state.cracks = [];
  state.mode = 'NORMAL';
  state.pot = 0;
  state.toAct = 0;
  state.phase = 'playing';
  state.player.readCooldownUntil = state.player.readCooldownUntil ?? 0;

  G.deck = shuffle(FULL_DECK);
  G.deckIdx = 0;
  G.readSeqInHand = 0;
  G.readsThisHand = 0;
  G.tagWindow.clear();
  G.crackedRules.clear();
  G.criticalUsedThisHand = false;
  G.bustedThisHand = false;
  G.lastHandAllIn = false;
  G.extraSeq = 0;
  G.intent = rollIntent();
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

  // 三状态保底演示：第 3 手必到 SHAKEN、第 5 手必到 TILT（gotcha 命中会更早）
  if (state.handNo === 3 && state.boss.state === 'CALM') {
    pushMental(evs, {
      cause: 'BLUFF_CAUGHT',
      causeName: '被你摸清了路数',
      hint: '动摇：碎片变多，情绪和真实意图开始泄漏。',
    });
  }
  if (state.handNo === 5 && state.boss.state === 'SHAKEN') {
    pushMental(evs, {
      cause: 'GOTCHA_STREAK',
      causeName: '连续被压制',
      hint: '上头：注更大、弃得更少、更敢接全下。',
    });
  }

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
  evs.push({ type: 'street', street, cards });
  state.player.handName = evalHandName(state.player.hole, state.board);
  return true;
}

function decideWinner() {
  const state = v();
  if (G.force === 'victory') return 0;
  if (G.force === 'defeat') return 1;
  const p = state.handNo >= DUEL_START_HAND ? 0.66 : 0.52;
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
  const state = v();
  const winner = decideWinner();
  showdownEvent(evs, winner);
  settleHand(evs, winner);
}

/**
 * 结算一手：分筹码 → pot_move → hand_end（含 stacks/effectiveStack/blind/mode）→ 可能 game_over。
 * 返回 'next'（可开下一手）或 'over'。
 */
function settleHand(evs, winner, { bluffCaught = false } = {}) {
  const state = v();
  const pot = state.pot;
  if (winner === 0) state.player.chips += pot;
  else if (winner === 1) state.boss.chips += pot;
  refreshEffective(state);

  feedOf('hand', `第 ${state.handNo} 手 · 底池 ${pot} → ${winner === 0 ? '你' : '对手'}赢得 ${pot}`);

  evs.push({ type: 'pot_move', to: winner, amount: pot });

  const nextT = tierInfo(state.handNo + 1);
  const handMode = state.mode;
  evs.push({
    type: 'hand_end',
    handNo: state.handNo,
    winner,
    pot,
    stacks: { player: Math.round(state.player.chips), boss: Math.round(state.boss.chips) },
    effectiveStack: state.effectiveStack,
    blind: { sb: nextT.sb, bb: nextT.bb },
    mode: handMode,
    bluffCaught: Boolean(bluffCaught),
  });
  state.pot = 0;

  // 输大池 / 输全下 → Boss 情绪单向恶化（契约 transitions）
  if (winner === 0) {
    if (G.lastHandAllIn) {
      pushMental(evs, {
        cause: 'ALL_IN_LOST', causeName: '全下失利',
        hint: '上头：他开始用更大的注掩饰不安。',
      });
    } else if (pot >= 300 && Math.random() < 0.7) {
      pushMental(evs, {
        cause: 'BIG_POT_LOST', causeName: '输掉大底池',
        hint: '动摇：话变多，注码也开始失控。',
      });
    }
  }

  if (state.boss.chips <= 0) {
    state.boss.chips = 0;
    state.phase = 'victory';
    state.toAct = null;
    refreshEffective(state);
    evs.push({ type: 'game_over', phase: 'victory', heart: HEART_V });
    feedOf('system', 'Boss 筹码归零 —— VICTORY。');
    return 'over';
  }
  if (state.player.chips <= 0) {
    state.player.chips = 0;
    state.phase = 'defeat';
    state.toAct = null;
    refreshEffective(state);
    evs.push({ type: 'game_over', phase: 'defeat', heart: HEART_D });
    feedOf('system', '你的筹码归零 —— DEFEAT。');
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

/* ------------------------------------------------------- READ / CRACK */

function makeCrack(evs, { kind, evidence, strength, critical }) {
  const state = v();
  const entry = {
    id: ++G.crackSeq,
    kind,
    evidence: [...evidence],
    strength,
    critical: Boolean(critical),
    handNo: state.handNo,
  };
  state.cracks.push(entry);
  if (state.cracks.length > 12) state.cracks.splice(0, state.cracks.length - 12);

  // 罐头对齐：让 CRACK 的指向与 Boss 真实 intent 一致（按提示猜 = 对）
  if (kind === 'WEAKNESS') G.intent = 'BLUFF';
  else if (kind === 'STRENGTH') G.intent = 'VALUE';
  else G.intent = state.handNo % 2 === 1 ? 'BLUFF' : 'VALUE';

  // EXECUTION/COUNTER 期间只记录，不再置 gotcha（不重复发动）
  if (state.mode === 'NORMAL') {
    state.gotcha = { id: entry.id, kind, evidence: [...evidence] };
  }
  feedOf('crack', `CRACK · ${kind}${critical ? '（CRITICAL）' : ''} · ${entry.evidence.join(' + ')}`);
  evs.push({
    type: 'crack',
    id: entry.id,
    kind,
    evidence: entry.evidence,
    strength,
    critical: entry.critical,
  });
}

function evaluateCrack(evs, frag) {
  if (frag.critical) {
    makeCrack(evs, {
      kind: 'CRITICAL',
      evidence: frag.tags,
      strength: 3,
      critical: true,
    });
    G.criticalUsedThisHand = true;
    return;
  }
  for (const rule of EVIDENCE_RULES) {
    if (G.crackedRules.has(rule.key)) continue;
    if (rule.all.every((tag) => G.tagWindow.has(tag))) {
      G.crackedRules.add(rule.key);
      makeCrack(evs, { kind: rule.kind, evidence: rule.all, strength: rule.strength, critical: false });
      return;
    }
  }
}

function nextFragment() {
  const state = v();
  const st = state.boss.state;
  G.readSeqInHand += 1;
  const n = G.readSeqInHand;
  const parity = state.handNo % 2 === 1;
  const tagA = parity ? 'wants_fold' : 'strong_hand';
  const tagB = parity ? 'weak_hand' : 'trap';

  const trueFrag = (tag) => ({
    text: pick(TAG_TEXT[tag] ?? [tag]),
    tags: [tag],
    type: 'TRUE',
  });
  const noiseFrag = () => ({ text: pick(NOISE), tags: [], type: 'NOISE' });
  const distortFrag = () => ({ text: pick(DISTORTION), tags: [], type: 'DISTORTION' });

  // 脚本保底：第 1 条噪音 → 第 2/3 条真话成链（保证「第二三条后 CRACK」）
  if (n === 1) return noiseFrag();
  if (n === 2) return trueFrag(tagA);
  if (n === 3) return trueFrag(tagB);
  // TILT + 第 5 条 → 单条高强度真话直接成链（CRITICAL）
  if (n === 5 && st === 'TILT' && !G.criticalUsedThisHand) {
    return { text: CRITICAL_TEXT, tags: ['overconfidence'], type: 'TRUE', critical: true };
  }
  // 窗口被 Boss 重要行动清掉后：按固定顺序补真话，两三条内重新成链
  const extras = parity
    ? ['fear_call', 'weak_hand', 'wants_fold']
    : ['trap', 'strong_hand', 'missed_board'];
  const extra = extras[G.extraSeq % extras.length];
  G.extraSeq += 1;

  const r = Math.random();
  if (st === 'CALM') {
    if (r < 0.62) return noiseFrag();
    if (r < 0.8) return distortFrag();
    return trueFrag(extra);
  }
  if (st === 'SHAKEN') {
    if (r < 0.38) return noiseFrag();
    if (r < 0.72) return trueFrag(extra);
    return distortFrag();
  }
  // TILT：TRUE 密集 + DISTORTION 同增
  if (r < 0.24) return noiseFrag();
  if (r < 0.64) return trueFrag(extra);
  return distortFrag();
}

function flashMsFor(state) {
  const base = state.boss.state === 'CALM' ? 1400 : state.boss.state === 'SHAKEN' ? 1100 : 800;
  return state.mode === 'EXECUTION' ? Math.round(base * EXECUTION_FLASH_K) : base;
}

function emitFragment(evs, frag, burst = false) {
  const state = v();
  const flashMs = flashMsFor(state);
  evs.push({ type: 'read_fragment', text: frag.text, flashMs, burst });
  feedOf('read', frag.text);
  state.readFragments.unshift({ text: frag.text, atHand: state.handNo });
  if (state.readFragments.length > 30) state.readFragments.length = 30;

  if (frag.type === 'TRUE' && frag.tags?.length) {
    for (const tag of frag.tags) G.tagWindow.add(tag);
    evaluateCrack(evs, frag);
  }
}

/* ------------------------------------------------------- Boss 应对（罐头） */

function decideBoss() {
  const state = v();
  const b = state.boss;
  const p = state.player;
  const mode = state.mode;
  const toCall = Math.max(0, Math.round(p.bet - b.bet));

  // 第 7 手起：全下决胜节奏（把 Effective Stack 直接推进结局）
  if (state.street === 'preflop' && state.handNo >= DUEL_START_HAND && Math.random() < 0.7) {
    return { action: 'allin' };
  }

  if (toCall === 0) {
    const betP = mode === 'COUNTER' ? 0.75 : mode === 'EXECUTION' ? 0.42 : 0.55;
    if (Math.random() < betP && b.chips > 0) return { action: 'bet' };
    return { action: 'check' };
  }

  if (toCall >= b.chips) {
    // 接不下 → 25% 弃牌，否则全下跟到底
    return { action: Math.random() < 0.25 ? 'fold' : 'call' };
  }

  const weights = mode === 'COUNTER'
    ? { fold: 0.1, call: 0.42, raise: 0.3, allin: 0.18 }
    : mode === 'EXECUTION'
      ? { fold: 0.3, call: 0.45, raise: 0.2, allin: 0.05 }
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

function bossRespond(evs, playerAction) {
  const state = v();
  const decision = decideBoss();

  if (decision.action === 'fold') {
    seatAction(1, 'fold', undefined, evs);
    markAction(1, 'fold');
    pushTalk(evs, pick(LINES_OPEN));
    foldWin(evs, 0);
    return;
  }
  if (decision.action === 'bet') {
    const minBet = Math.max(10, Math.ceil(state.pot / 3));
    const maxTo = Math.round(state.boss.bet + state.boss.chips);
    const raiseTo = clamp(
      Math.round(state.pot * (0.4 + Math.random() * 0.7)),
      Math.min(minBet, maxTo),
      Math.max(minBet, maxTo),
    );
    seatAction(1, 'bet', raiseTo, evs);
    markAction(1, 'bet');
    if (Math.random() < 0.5) pushTalk(evs, pick(LINES_RAISE));
  } else if (decision.action === 'raise') {
    seatAction(1, 'raise', decision.raiseTo, evs);
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
    advanceStreet(evs);
  } else {
    state.toAct = 0; // Boss 加注/全下 → 回到玩家决定
    if (state.player.chips <= 0) {
      // 玩家已全下（无筹码可再行动）→ 直接跑完公共牌摊牌
      while (nextStreet(evs)) { /* runout */ }
      resolveShowdown(evs);
      return;
    }
  }
  refreshLegal(state);
}

function advanceStreet(evs) {
  const state = v();
  if (!nextStreet(evs)) {
    resolveShowdown(evs);
    return;
  }
  // 任一方没筹码了 → 不再有下注轮，直接跑完摊牌
  if (state.player.chips <= 0 || state.boss.chips <= 0) {
    while (nextStreet(evs)) { /* runout */ }
    resolveShowdown(evs);
    return;
  }
  newStreetState();
  const leadP = state.mode === 'COUNTER' ? 0.7 : state.mode === 'EXECUTION' ? 0.4 : 0.5;
  if (Math.random() < leadP && state.boss.chips > 0) {
    const minBet = Math.max(10, Math.ceil(state.pot / 3));
    const maxTo = Math.round(state.boss.bet + state.boss.chips);
    const raiseTo = clamp(
      Math.round(state.pot * (0.35 + Math.random() * 0.6)),
      Math.min(minBet, maxTo),
      Math.max(minBet, maxTo),
    );
    seatAction(1, 'bet', raiseTo, evs);
    markAction(1, 'bet');
    if (Math.random() < 0.4) pushTalk(evs, pick(LINES_RAISE));
  }
  state.toAct = 0;
  refreshLegal(state);
}

/* ------------------------------------------------------- BUSTED 触发 */

function maybeBusted(evs, action) {
  const state = v();
  if (G.bustedThisHand) return;
  const cooldownOk = state.handNo - G.lastBustedHand >= 4;
  const firstTime = state.handNo === 4 && G.lastBustedHand < 0;
  const late = G.readsThisHand >= 3
    && cooldownOk
    && ['pressure', 'heavy', 'allin'].includes(action);
  if (!firstTime && !late) return;

  G.bustedThisHand = true;
  G.lastBustedHand = state.handNo;
  const line = pick(LINES_BUSTED);
  state.mode = 'COUNTER';
  state.boss.lastLine = line;
  feedOf('model', line);
  feedOf('mode', '模式 → COUNTER');
  evs.push({ type: 'busted', line });
  evs.push({ type: 'mode', mode: 'COUNTER' });
}

/* ------------------------------------------------------------ 接口处理 */

function onPlayerAction(action, amount) {
  const state = v();
  if (state.phase !== 'playing') return fail(400, '对局已结束，请点「再来一局」', 'NOT_PLAYING');
  if (state.toAct !== 0) return fail(400, '还没轮到你', 'NOT_YOUR_TURN');

  const LISTED = ['fold', 'call', 'check', 'pressure', 'heavy', 'allin', 'bet', 'raise'];
  if (!LISTED.includes(action)) return fail(400, `未知动作：${action}`, 'INVALID_ACTION');

  // 契约门禁：bet / raise 仅 EXECUTION 模式合法
  if ((action === 'bet' || action === 'raise') && state.mode !== 'EXECUTION') {
    return fail(400, '仅在 EXECUTION 模式可以自由下注', 'NOT_EXECUTION');
  }

  const legal = state.player.legal ?? refreshLegal(state);
  if (action === 'fold' && !legal.fold) return fail(400, '当前不能弃牌', 'ILLEGAL');
  if (action === 'call' && !legal.call) return fail(400, '当前没有需要跟的注', 'ILLEGAL');
  if (action === 'check' && !legal.check) return fail(400, '必须先跟注或弃牌', 'ILLEGAL');
  if ((action === 'pressure' || action === 'heavy') && !legal[action]) {
    return fail(400, '筹码不足，无法加压', 'ILLEGAL');
  }
  if (action === 'allin' && !(legal.allin > 0)) return fail(400, '没有可全下的筹码', 'ILLEGAL');
  if ((action === 'bet' || action === 'raise') && amount !== undefined && !Number.isFinite(Number(amount))) {
    return fail(400, 'amount 必须是数字', 'INVALID_AMOUNT');
  }

  const evs = [];
  seatAction(0, action, amount, evs);
  markAction(0, action);

  // BUSTED!（Boss 读穿了你 → COUNTER 高压阶段）
  maybeBusted(evs, action);

  if (action === 'fold') {
    foldWin(evs, 1);
    return succeed(evs);
  }

  if (roundClosed()) {
    advanceStreet(evs);
    refreshLegal(state);
    return succeed(evs);
  }

  bossRespond(evs, action);
  refreshLegal(state);
  return succeed(evs);
}

function onRead() {
  const state = v();
  if (state.phase !== 'playing') return fail(400, '对局已结束', 'NOT_PLAYING');
  const now = Date.now();
  if (now < G.readCooldownUntil) {
    return fail(400, 'READ 冷却中 —— 稍等 0.4 秒', 'READ_COOLING');
  }
  G.readCooldownUntil = now + READ_COOLDOWN_MS;
  state.player.readCooldownUntil = G.readCooldownUntil;

  const evs = [];
  G.readsThisHand += 1;
  emitFragment(evs, nextFragment());
  // EXECUTION：25% 概率连发两条 = 「信息量更高」
  if (state.mode === 'EXECUTION' && Math.random() < 0.25) {
    emitFragment(evs, nextFragment(), true);
  }
  return succeed(evs);
}

function onGotcha(guess) {
  const state = v();
  if (state.phase !== 'playing') return fail(400, '对局已结束', 'NOT_PLAYING');
  if (guess !== 'BLUFF' && guess !== 'STRONG') {
    return fail(400, 'guess 必须是 BLUFF 或 STRONG', 'INVALID_GUESS');
  }
  if (!state.gotcha) return fail(400, '证据链已过期或不存在', 'GOTCHA_UNAVAILABLE');
  if (state.mode !== 'NORMAL') return fail(400, 'EXECUTION/COUNTER 期间不能再次发动', 'GOTCHA_UNAVAILABLE');

  const intent = G.intent;
  const correct = guess === 'BLUFF'
    ? intent === 'BLUFF' || intent === 'PROBE'
    : intent === 'VALUE' || intent === 'TRAP' || intent === 'CONTROL';
  const mode = correct ? 'EXECUTION' : 'COUNTER';

  const crackId = state.gotcha.id;
  const entry = state.cracks.find((c) => c.id === crackId);
  if (entry) entry.used = { guess, correct }; // 预览专属：面板可跨刷新显示结果
  state.gotcha = null;
  state.mode = mode;

  feedOf('gotcha', `押注 ${guess} → ${correct ? '判断正确，进入 EXECUTION' : '判断失误，被 COUNTER'}`);
  feedOf('mode', `模式 → ${mode}`);

  const evs = [
    { type: 'gotcha_result', guess, correct, mode },
    { type: 'mode', mode },
  ];

  if (correct) {
    G.correctStreak += 1;
    G.gotchaCount += 1;
    if (G.correctStreak === 1) {
      pushMental(evs, {
        cause: 'BLUFF_CAUGHT', causeName: '诈唬被抓',
        hint: '动摇：被看穿一次后，他的碎片开始漏出真话。',
      });
    } else if (G.correctStreak >= 2) {
      pushMental(evs, {
        cause: 'GOTCHA_STREAK', causeName: '连续被猜中',
        hint: '上头：注更大、更敢接全下，也开始自欺。',
      });
    }
    state.boss.lastLine = pick(LINES_EXEC_LOSS);
  } else {
    G.correctStreak = 0;
    state.boss.lastLine = pick(LINES_COUNTER);
  }

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
      case '/api/gotcha':
        result = onGotcha(body?.guess);
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
    pathname = new URL(req.url, `http://127.0.0.1:${PORT}`).pathname;
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

server.listen(PORT, () => {
  console.log(`《allin》v3 预览服务已启动：http://localhost:${PORT}`);
  console.log(`静态根目录：${WEB_ROOT}`);
  console.log('canned 流程：READ×3 → CRACK → GOTCHA（对=EXECUTION / 错=COUNTER）→ BUSTED(第4手)');
  console.log('             → BLIND UP(第3/5/7手) → CALM/SHAKEN/TILT → 筹码堆迁移 → 结局。');
  if (PREVIEW_DEMO) console.log(`结局预设：${PREVIEW_DEMO}（可被 /api/newgame { demo } 覆盖）`);
});
