#!/usr/bin/env node
/**
 * scripts/preview.mjs — 《allin》前端独立预览服务器（v4 编排）
 *
 *   node scripts/preview.mjs            # 默认端口 8791
 *   PORT=9000 node scripts/preview.mjs  # 端口覆盖
 *   PREVIEW_DEMO=victory node ...       # 预设结局走向（可被 newgame 请求体覆盖）
 *
 * 职责：
 * 1. 静态托管 web/（无构建、原生 ES Modules）；
 * 2. 实现 docs/PROTOCOL.md（v4）的 5 个 API，返回精心编排的 canned 数据，
 *    用于在没有真实服务端时自查全部 UI 分支：
 *    - READ 每手限量 2 次（READ_EXHAUSTED / READ_COOLING / NO_READS_TURN），一次返回一组 3–5 条
 *      碎片（read_batch manual，本手工 READ 的碎片带 id 可 PIN）；
 *    - PIN 单槽（view.pin 只有 text + verified）：换 PIN 覆盖，BAD_FRAGMENT / PIN_NOT_ALLOWED；
 *    - 新 CRACK = PIN 的真话 × 正确行动 × Boss 当前 intent（数据驱动规则表）；
 *      罐头把每批碎片的 frag0 与当前意图对齐（canCall → wants_fold×BLUFF / 否则 trap×VALUE），
 *      因此「PIN frag0 → call/check」必出 CRACK —— 链路可稳定复现；
 *      frag1 固定为 NOISE：「PIN 噪音对照」永远不出 CRACK；
 *    - 攒够 cracksForGotcha(2) → view.gotcha {cracks, need} → POST /api/gotcha {}
 *      进入 mode:"GOTCHA"（无 guess）：负债下注（chips 可为负）、阶梯 RAISE 翻倍、
 *      任意 CALL/RAISE 触发 read_batch 心理泄漏（source:"gotcha"、id=null、depth 递增、flashMs×0.6）；
 *    - 统一结算：退未跟部分 → Pot（含负债）→ 赢家收 Pot → stack<=0 判负
 *      （绝不负数进入下一手 NORMAL）；
 *    - BUSTED（第 4 手必发，Boss 获本手增益但不切换模式）、盲注升级（第 3/5/7/9 手 blindUp）、
 *      三状态情绪 CALM → SHAKEN → TILT（GOTCHA_HIT / GOTCHA_STREAK / 输大池 / 第 3、5 手保底）。
 * 3. 无浏览器环境下用 node 直连本服务即可驱动完整事件链（自查接线用）。
 *
 * ⚠️ 这是「编排好的演示服务端」，不是真实规则引擎 —— 一切以驱动 UI 为目的。
 * 预览专属扩展（真实服务端可以不实现，前端不依赖）：
 *   - POST /api/newgame 请求体可带 { demo: "victory" | "defeat" } 预设结局走向；
 *   - 手工 READ 批次的 frag0 恒为可验证真话且与当前 intent 对齐（保证演示链路稳定）。
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

const START_PLAYER = 500;        // 不对称挑战：500 vs 5000
const START_BOSS = 5000;
const READ_COOLDOWN_MS = 400;    // 契约：READ 冷却（超前请求 400 READ_COOLING）
const READ_USES_PER_HAND = 2;    // 契约：每手 readsUsesPerHand（配置 2）
const NORMAL_BATCH = [3, 5];     // normalReadFragmentCount：一次 READ 3–5 条
const GOTCHA_BATCH = [4, 6];     // gotchaReadFragmentCount：泄漏 4–6 条
const LEAK_TRUE_RATE = [0.45, 0.55, 0.65, 0.75]; // gotcha.trueRateByDepth（depth 1..4+）
const LEAK_FLASH_K = 0.6;        // 泄漏 flashMs 系数
const CRACKS_FOR_GOTCHA = 2;     // cracksForGotcha（建议 2）
const DUEL_START_HAND = 7;       // 第 7 手起 Boss 进入「全下决胜」节奏（NORMAL 演示用）

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
      readsLeft: READ_USES_PER_HAND,
      readsPerHand: READ_USES_PER_HAND,
      readCooldownUntil: 0,
    },
    boss: {
      chips: START_BOSS, bet: 0, hole: null,
      state: 'CALM', face: FACES.CALM[0], mood: FACES.CALM[1],
      stateHint: STATE_HINT.CALM,
      lastAction: null, lastLine: null,
    },
    pin: null,               // { text, verified } —— 只有这两个字段
    gotcha: null,            // { cracks, need } —— 非 null = 已解锁
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
    fragSeq: 0,
    crackSeq: 0,
    frags: new Map(),        // id → { id, type, tags, text, atHand }（服务端私有）
    pin: null,               // 服务端私有：{ id, type, tag, text, atHand, verified }
    armedFed: false,
    intent: 'PROBE',
    readBatchesThisHand: 0,
    crackedRulesThisHand: 0,
    debtMode: false,
    gotchaDepth: 0,
    gotchaRaiseStep: 0,
    lastRaiseSize: 0,
    lastGotchaHand: -1,
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
  const base = state.boss.state === 'CALM' ? 1400 : state.boss.state === 'SHAKEN' ? 1100 : 800;
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
  // 面板：整批按顺序插到最前（f0 在最上）
  state.readFragments.splice(0, 0, ...texts.map((text) => ({ id: null, text, atHand: state.handNo })));
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

/** 开一手：hand_start（blindUp 横幅）→ 保底情绪 → 发盲注 → 重置 v4 资源。 */
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
  state.mode = 'NORMAL';
  state.pot = 0;
  state.toAct = 0;
  state.phase = 'playing';
  state.player.readsLeft = READ_USES_PER_HAND;
  state.player.readsPerHand = READ_USES_PER_HAND;
  state.player.readCooldownUntil = 0;

  G.deck = shuffle(FULL_DECK);
  G.deckIdx = 0;
  G.pin = null;
  G.readBatchesThisHand = 0;
  G.crackedRulesThisHand = 0;
  G.armedFed = false;
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

  // 三状态保底演示：第 3 手必到 SHAKEN、第 5 手必到 TILT（GOTCHA 进入也会更早推进）
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
  G.lastRaiseSize = state.blind.bb; // 每街重置：阶梯起点 = 本街 lastRaiseSize（≥bb）
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
  const winner = decideWinner();
  showdownEvent(evs, winner);
  settleHand(evs, winner);
}

/**
 * 统一结算（FOLD / SHOWDOWN 同一条路）：
 * 1) 退还未跟注部分 2) Pot = 全部已投入（含负债）3) 赢家收取 Pot
 * 4) mode 回落由下一手 hand_start 完成（hand_end.mode 记录本手终值）
 * 5) 结算后 stack <= 0 判负 —— 绝不允负数筹码进入下一手 NORMAL。
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

  // 情绪：输大池 / 输全下 / 诈唬被抓（赢方为玩家时，按优先级触发一次）
  if (winner === 0) {
    if (G.bossBluffedThisHand) {
      pushMental(evs, {
        cause: 'BLUFF_CAUGHT', causeName: '诈唬被抓',
        hint: '动摇：被看穿一次后，他的碎片开始漏出真话。',
      });
    } else if (G.lastHandAllIn) {
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

function makeFrag(text, type, tags, atHand) {
  G.fragSeq += 1;
  const id = `f${G.fragSeq}`;
  const meta = { id, type, tags, text, atHand };
  G.frags.set(id, meta);
  return meta;
}

/** 手工 READ 批次：frag0 = 可验证真话（与当前意图对齐），frag1 = NOISE（对照组）。 */
function makeManualBatch() {
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
    [canCall ? 'wants_fold' : 'trap'], state.handNo));
  metas.push(makeFrag(pick(NOISE), 'NOISE', [], state.handNo));
  while (metas.length < count) {
    const r = Math.random();
    if (r < 0.45) metas.push(makeFrag(pick(NOISE), 'NOISE', [], state.handNo));
    else if (r < 0.7) metas.push(makeFrag(pick(DISTORTION), 'DISTORTION', [], state.handNo));
    else {
      const tag = pick(domain);
      metas.push(makeFrag(pickText(TAG_TEXT[tag]), 'TRUE', [tag], state.handNo));
    }
  }
  return metas;
}

function emitManualBatch(evs) {
  const state = v();
  const metas = makeManualBatch();
  const base = state.boss.state === 'CALM' ? 1400 : state.boss.state === 'SHAKEN' ? 1100 : 800;
  const wire = metas.map((m) => ({ id: m.id, text: m.text }));
  evs.push({ type: 'read_batch', source: 'manual', flashMs: base, fragments: wire });
  // 面板：整批按顺序插到最前（f0 在最上，与闪现一致），每项只有 {id, text, atHand}
  state.readFragments.splice(0, 0, ...metas.map((m) => ({ id: m.id, text: m.text, atHand: m.atHand })));
  if (state.readFragments.length > 30) state.readFragments.length = 30;
  feedOf('read', `READ ×${metas.length} 条碎片`);
}

/** PIN 的真话 × 玩家行动 × Boss 当前 intent → CRACK（每次成功行动之后判定）。 */
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
    critical: false,       // critical crack 留给未来版本（v1 不做）
    handNo: state.handNo,
    result: null,          // 保留字段（v4 不再兑现，恒 null）
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
  updateGotchaArmed(state);
  return true;
}

function updateGotchaArmed(state = v()) {
  if (state.mode === 'NORMAL' && state.cracks.length >= CRACKS_FOR_GOTCHA) {
    state.gotcha = { cracks: state.cracks.length, need: CRACKS_FOR_GOTCHA };
    if (!G.armedFed) {
      G.armedFed = true;
      feedOf('gotcha', `CRACK 达标 ${state.cracks.length}/${CRACKS_FOR_GOTCHA} —— GOTCHA 已解锁`);
    }
  } else {
    state.gotcha = null;
    if (state.cracks.length < CRACKS_FOR_GOTCHA) G.armedFed = false;
  }
}

/* ------------------------------------------------------- Boss 应对（罐头） */

function decideBoss() {
  const state = v();
  const b = state.boss;
  const p = state.player;
  const toCall = Math.max(0, Math.round(p.bet - b.bet));

  /* ---- GOTCHA 负债阶段：绝不弃牌、无全下语义，接招并继续抬阶梯 ---- */
  if (G.debtMode) {
    if (toCall === 0) {
      return Math.random() < 0.7 ? { action: 'raise' } : { action: 'check' }; // 开注走阶梯
    }
    return Math.random() < 0.55 ? { action: 'raise' } : { action: 'call' };
  }

  /* ---- NORMAL ---- */
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
    // 负债：amount 省略 → 阶梯；NORMAL：按引擎算好的 raise-to
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
    advanceStreet(evs);
  } else {
    state.toAct = 0; // Boss 加注/开注 → 回到玩家决定
    if (!G.debtMode && state.player.chips <= 0) {
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
  // NORMAL：任一方没筹码 → 不再有下注轮，跑完摊牌；GOTCHA（负债）不受此限
  if (!G.debtMode && (state.player.chips <= 0 || state.boss.chips <= 0)) {
    while (nextStreet(evs)) { /* runout */ }
    resolveShowdown(evs);
    return;
  }
  newStreetState();
  if (!G.debtMode) {
    const leadP = G.bustedBuff ? 0.7 : 0.5;
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
  } else {
    // 负债阶段：Boss 也会主动开注（走阶梯）
    if (Math.random() < 0.6) {
      seatAction(1, 'raise', undefined, evs);
      markAction(1, 'raise');
      if (Math.random() < 0.4) pushTalk(evs, pick(LINES_RAISE));
    }
  }
  state.toAct = 0;
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
  if (action === 'call' && !legal.call) return fail(400, '当前没有需要跟的注', 'ILLEGAL');
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
  seatAction(0, action, amount, evs);
  markAction(0, action);

  // BUSTED!（Player Model 把握度 → 本手攻击增益，不切换模式）
  maybeBusted(evs, action);

  // ★ 每次成功行动之后：PIN 的真话 × 行动 × 当前 intent → CRACK
  evaluateCrack(evs, action);

  if (action === 'fold') {
    foldWin(evs, 1);
    return succeed(evs);
  }
  if (roundClosed()) {
    advanceStreet(evs);
    refreshLegal(state);
    return succeed(evs);
  }
  bossRespond(evs);
  refreshLegal(state);
  return succeed(evs);
}

function onRead() {
  const state = v();
  if (state.phase !== 'playing') return fail(400, '对局已结束', 'BATTLE_OVER');
  if (state.toAct !== 0) return fail(400, '还没轮到你，不能 READ', 'NO_READS_TURN');
  if (state.mode === 'GOTCHA') return fail(400, '负债阶段不能手动 READ', 'NO_READS_TURN');
  if (Math.round(Number(state.player.readsLeft) || 0) <= 0) {
    return fail(400, '本手的 READ 次数已用完', 'READ_EXHAUSTED');
  }
  const now = Date.now();
  if (now < G.readCooldownUntil) return fail(400, 'READ 冷却中 —— 稍等 0.4 秒', 'READ_COOLING');

  G.readCooldownUntil = now + READ_COOLDOWN_MS;
  state.player.readCooldownUntil = G.readCooldownUntil;
  state.player.readsLeft = Math.max(0, Math.round(state.player.readsLeft) - 1);
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
    return fail(400, '只有本手工 READ 的碎片可以 PIN', 'BAD_FRAGMENT');
  }
  if (meta.atHand !== state.handNo) {
    return fail(400, '只能 PIN 本手生成的碎片', 'PIN_NOT_ALLOWED');
  }

  // 单槽：新 PIN 覆盖旧 PIN
  G.pin = {
    id: meta.id,
    type: meta.type,       // 服务端私有
    tag: meta.tags[0] ?? null, // 服务端私有
    text: meta.text,
    atHand: meta.atHand,
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
  if (!state.gotcha) return fail(400, 'CRACK 未达标，无法发动', 'GOTCHA_NOT_ARMED');
  if (state.mode !== 'NORMAL') return fail(400, '已经在负债阶段', 'GOTCHA_NOT_ARMED');
  if (Math.round(state.player.chips) <= 0 || Math.round(state.boss.chips) <= 0) {
    return fail(400, '已有全下边缘，无法进入负债状态', 'GOTCHA_LOCKED');
  }

  // 进入 GOTCHA：解除 Stack 上限、阶梯就位、depth 归零；解锁标记随状态消费掉
  state.mode = 'GOTCHA';
  state.gotcha = null;
  G.armedFed = false;
  G.debtMode = true;
  G.gotchaDepth = 0;
  G.gotchaRaiseStep = Math.max(G.lastRaiseSize || 0, state.blind.bb);

  const evs = [{ type: 'mode', mode: 'GOTCHA' }];
  feedOf('mode', '模式 → GOTCHA · 负债决胜');
  pushTalk(evs, pick(LINES_GOTCHA_ENTER));

  // 情绪：GOTCHA_HIT（进入时触发一次）；连续两手进入 → GOTCHA_STREAK
  pushMental(evs, {
    cause: 'GOTCHA_HIT', causeName: '被看穿还敢全押',
    hint: '他把你的判定当成了全力一搏 —— 敢进 GOTCHA 的人不多。',
  });
  if (G.lastGotchaHand === state.handNo - 1) {
    pushMental(evs, {
      cause: 'GOTCHA_STREAK', causeName: '连续两手上头',
      hint: '上头：注更大、更敢接全下。',
    });
  }
  G.lastGotchaHand = state.handNo;

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
  console.log(`《allin》v4 预览服务已启动：http://localhost:${PORT}`);
  console.log(`静态根目录：${WEB_ROOT}`);
  console.log('canned 流程：READ(2/次·批量) → PIN frag0 → call/check 出 CRACK ×2 →');
  console.log('             GOTCHA 负债（阶梯翻倍 · 心理泄漏 depth 递增 · 负数筹码）→ 统一结算 → 下一手/终局。');
  console.log('             对照组：PIN frag1（NOISE）永远不会出 CRACK。');
  if (PREVIEW_DEMO) console.log(`结局预设：${PREVIEW_DEMO}（可被 /api/newgame { demo } 覆盖）`);
});
