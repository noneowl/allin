#!/usr/bin/env node
/**
 * scripts/preview.mjs — 《allin》前端独立预览服务器
 *
 *   node scripts/preview.mjs            # 默认端口 8791
 *   PORT=9000 node scripts/preview.mjs  # 端口覆盖
 *
 * 职责：
 * 1. 静态托管 web/（无构建、原生 ES Modules）；
 * 2. 实现 docs/PROTOCOL.md 的 6 个 API，返回精心编排的 canned 数据，
 *    用于在没有真实服务端时自查全部 UI 分支：
 *    - Boss 状态阶梯 CALM → SHAKEN → TILT → BREAKING（异议/言语命中/被抓诈唬/大底池失利都会推进）；
 *    - 第 1 手：contradiction + objection_open（2.6s 倒计时）→ 点异议成功/超时失败两条路；
 *    - 第 2 手：完整跑街 → showdown（Boss 底牌逐张翻开）；
 *    - 第 3 手：翻牌后跟注 → hand_end(bluffCaught=true) 打击演出；
 *    - 第 4 手：随机正常流（跟注/加注/弃牌/发牌混合）；之后循环；
 *    - 任意手 ALL-IN → runout → 摊牌，筹码快速见底 → game_over（victory/defeat）。
 *
 * 注意：这是「编排好的演示服务端」，不是真实规则引擎——一切以驱动 UI 为目的。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(__dirname, '..', 'web');
const PORT = Number(process.env.PORT) || 8791;

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

/* ------------------------------------------------------------ canned 文案 */

const FACES = {
  CALM: ['😏', '冷静'],
  SHAKEN: ['😅', '动摇'],
  TILT: ['🤬', '上头'],
  BREAKING: ['🫠', '崩坏'],
};
const LADDER = { CALM: 'SHAKEN', SHAKEN: 'TILT', TILT: 'BREAKING', BREAKING: 'BREAKING' };
const SPEECH_LABEL = { taunt: '挑衅', challenge: '质疑', pressure: '施压' };
const SPEECH_RESULT_LABEL = { hit: '命中', resist: '被抵挡', whiff: '落空' };

/** 手牌主题轮换：每手一个，循环。 */
const THEMES = ['objection', 'showdown', 'bluff', 'random'];

const LINES_OPEN = [
  '这一手你最好直接弃，我不想弄脏筹码。',
  '你跟不动这一枪，别逞强。',
  '信不信我这里全是价值？',
];
const LINES_NORMAL = [
  '就这点筹码也敢看我？',
  '我赌你不敢跟。',
  '你的手在抖，我知道。',
  '这一手，你最好别碰。',
  '跟注吧，我想亲眼看你输。',
];
const LINES_ALLIN = ['全下？我接了。', '让你看看什么叫统治。', '好啊，一局定生死。'];
const LINES_BUSTED = ['……你居然真的看穿了。', '行，这手是我在诈。', '算你狠，记下了。'];
const LINES_OBJECTION_HIT = ['……被你抓到了又如何。', '哼，嘴硬的家伙。', '这次算你赢。'];

const SPEECH_LINES = {
  taunt: {
    hit: ['就这点胆子？被我说中了？', '哦？被激将了？', '……你说什么？！'],
    resist: ['无聊的激将法，省省吧。', '我见过太多你这种人。'],
    whiff: ['幼稚。', '毫无效果。'],
  },
  challenge: {
    hit: ['……这次确实是我虚张声势。', '你凭什么这么说？……好吧。'],
    resist: ['我的打法没有问题。', '质疑我？拿出证据。'],
    whiff: ['你看错了吧。', '这手我确实是价值下注。'],
  },
  pressure: {
    hit: ['你……你别催我！', '压力？我、我没有压力！'],
    resist: ['这种小把戏对我没用。', '尽管施压，我照单全收。'],
    whiff: ['你在逗我？', '这点压力不够看。'],
  },
};

const READS = [
  '他似乎非常期待你弃牌。',
  '他的下注节奏比平时更快，像是在掩饰什么。',
  '他嘴上强硬，但加注金额明显偏小。',
  '他盯着底池看了很久——也许在计算赔率。',
  '这次的语气里有一丝藏不住的犹豫。',
  '他可能在用大牌慢打，也可能什么都没有。',
  '他连续在河牌过牌，像是在埋伏。',
  '他说「弃吧」的时候，手却把筹码推得更近了。',
];

const HEART_V = '我只是……不想承认你真的看穿我了。';
const HEART_D = '……原来从头到尾，被看穿的人是我。';

const WIN_HANDS = ['两对', '同花', '顺子', '三条', '两对'];
const LOSE_HANDS = ['一对', '高牌', '一对', '两对', '高牌'];

/* ------------------------------------------------------------ 游戏状态 */

const RANKS = '23456789TJQKA'.split('');
const SUITS = ['s', 'h', 'd', 'c'];
const FULL_DECK = [];
for (const r of RANKS) for (const s of SUITS) FULL_DECK.push(`${r}${s}`);

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

let G = null;

function baseView() {
  return {
    phase: 'playing',
    handNo: 1,
    street: 'preflop',
    pot: 0,
    board: [],
    button: 0,
    toAct: 0,
    player: {
      chips: 1180, bet: 0, hole: [], toCall: 0, legal: null,
      readsLeft: 2, speech: { taunt: 1, challenge: 1, pressure: 1 },
    },
    boss: {
      chips: 1200, bet: 0, hole: null, state: 'CALM',
      face: FACES.CALM[0], mood: FACES.CALM[1],
      lastAction: null, lastLine: '',
    },
    objection: null,
    reads: [],
    history: [],
    feed: [],
  };
}

function newGame() {
  const view = baseView();
  G = {
    view,
    theme: 'objection',
    bossHole: [],
    deck: shuffle(FULL_DECK),
    deckIdx: 0,
    objectionSeq: 1,
    objectionUsed: false,
    bluffUsed: false,
    contraKind: 'spoken_vs_bet',
    readIdx: 0,
    skillUsed: { taunt: false, challenge: false, pressure: false },
  };
  const evs = [];
  startHand(evs);
  feedOf('system', '对局开始：击败 Boss，赢光他的筹码。');
  return evs;
}

const draw = () => {
  const card = G.deck[G.deckIdx % G.deck.length];
  G.deckIdx += 1;
  return card;
};

function feedOf(kind, text) {
  const v = G.view;
  v.feed.push({ kind, text });
  if (v.feed.length > 100) v.feed.splice(0, v.feed.length - 100);
}

function applyBossState(stateName) {
  const [face, mood] = FACES[stateName] ?? FACES.CALM;
  G.view.boss.state = stateName;
  G.view.boss.face = face;
  G.view.boss.mood = mood;
}

function pushMental(evs, cause) {
  const v = G.view;
  const from = v.boss.state;
  const to = LADDER[from] ?? from;
  applyBossState(to);
  evs.push({ type: 'mental', from, to, cause });
  feedOf('mental', `${from} → ${to}`);
}

function pushTalk(evs, line) {
  G.view.boss.lastLine = line;
  evs.push({ type: 'talk', line });
  feedOf('talk', line);
}

function refreshLegal(v) {
  const p = v.player;
  const b = v.boss;
  const rawCall = Math.max(0, b.bet - p.bet);
  const toCall = Math.min(rawCall, p.chips);
  p.toCall = toCall;
  const maxTo = p.bet + p.chips;
  const minTo = rawCall > 0
    ? Math.max(1, Math.min(maxTo, b.bet * 2))
    : Math.max(1, Math.min(maxTo, Math.max(10, Math.ceil(v.pot / 3))));
  p.legal = {
    check: rawCall === 0,
    call: rawCall > 0 ? toCall : false,
    fold: p.chips > 0,
    bet: rawCall === 0 && p.chips > 0,
    raise: rawCall > 0 && p.chips > 0,
    minTo,
    maxTo: Math.max(minTo, maxTo),
    allin: p.chips,
  };
  return p.legal;
}

/** 一次下注动作（seat 0=玩家 1=Boss），amount 对 bet/raise 是 raise-to。 */
function seatAction(seat, action, amount, evs) {
  const v = G.view;
  const who = seat === 0 ? v.player : v.boss;
  const other = seat === 0 ? v.boss : v.player;
  let put = 0;
  let evAmount;
  let allIn = false;

  if (action === 'call') {
    put = Math.min(Math.max(0, other.bet - who.bet), who.chips);
    evAmount = put;
  } else if (action === 'bet' || action === 'raise') {
    const maxTo = who.bet + who.chips;
    const minTo = other.bet > 0
      ? Math.max(1, other.bet * 2)
      : Math.max(10, Math.ceil(v.pot / 3));
    const raiseTo = clamp(Math.round(Number(amount) || minTo), Math.min(minTo, maxTo), maxTo);
    put = raiseTo - who.bet;
    evAmount = raiseTo; // 协议：bet/raise 的 amount 是 raise-to
  } else if (action === 'allin') {
    put = who.chips;
    evAmount = who.bet + put;
    allIn = true;
  }

  if (put > who.chips) {
    put = who.chips;
    allIn = true;
  }
  who.chips -= put;
  who.bet += put;
  v.pot += put;
  if (who.chips === 0 && put > 0) allIn = true;
  if (action === 'allin') allIn = true;

  evs.push({ type: 'action', seat, action, amount: evAmount, put, potAfter: v.pot, allIn });
  const histEntry = { handNo: v.handNo, street: v.street, actor: seat === 0 ? 'player' : 'boss', action, amount: evAmount };
  v.history.push(histEntry);
  if (v.history.length > 60) v.history.splice(0, v.history.length - 60);

  if (seat === 1) {
    v.boss.lastAction = evAmount === undefined ? { action } : { action, amount: evAmount };
  }
  return { put, allIn };
}

function postBlinds(evs) {
  const v = G.view;
  const sbSeat = v.button; // 1v1：button 是小盲
  const bbSeat = sbSeat === 0 ? 1 : 0;
  for (const [seat, amount] of [[sbSeat, 10], [bbSeat, 20]]) {
    const who = seat === 0 ? v.player : v.boss;
    const give = Math.min(amount, who.chips);
    who.chips -= give;
    who.bet += give;
    v.pot += give;
    evs.push({ type: 'blinds', seat, amount: give, potAfter: v.pot });
  }
}

/** 开一手：发底牌 + 下盲注（hand_start 事件由调用方先推）。 */
function startHand(evs) {
  const v = G.view;
  v.street = 'preflop';
  v.board = [];
  v.player.bet = 0;
  v.boss.bet = 0;
  v.boss.hole = null;
  v.boss.lastAction = null;
  v.objection = null;
  v.player.readsLeft = 2;
  v.player.speech = { taunt: 1, challenge: 1, pressure: 1 };
  v.reads = [];
  v.pot = 0;
  v.toAct = 0;
  v.phase = 'playing';
  G.deck = shuffle(FULL_DECK);
  G.deckIdx = 0;
  G.objectionUsed = false;
  G.bluffUsed = false;
  G.theme = THEMES[(v.handNo - 1) % THEMES.length];
  v.player.hole = [draw(), draw()];
  G.bossHole = [draw(), draw()];
  evs.push({ type: 'hand_start', handNo: v.handNo, button: v.button });
  postBlinds(evs);
  refreshLegal(v);
}

const STREET_ORDER = ['preflop', 'flop', 'turn', 'river'];

function nextStreet(evs) {
  const v = G.view;
  const idx = STREET_ORDER.indexOf(v.street);
  if (idx < 0 || idx >= STREET_ORDER.length - 1) return false;
  const street = STREET_ORDER[idx + 1];
  v.street = street;
  const cards = [];
  const count = street === 'flop' ? 3 : 1;
  for (let i = 0; i < count; i += 1) cards.push(draw());
  v.board.push(...cards);
  v.player.bet = 0;
  v.boss.bet = 0;
  evs.push({ type: 'street', street, cards });
  return true;
}

function runout(evs) {
  while (nextStreet(evs)) { /* 发完剩余公共牌 */ }
}

function showdownEvent(evs, winner) {
  const v = G.view;
  const winName = pick(WIN_HANDS);
  const loseName = pick(LOSE_HANDS);
  evs.push({
    type: 'showdown',
    hands: [
      { seat: 0, hole: v.player.hole, handName: winner === 0 ? winName : loseName, winner: winner === 0 },
      { seat: 1, hole: G.bossHole, handName: winner === 1 ? winName : loseName, winner: winner === 1 },
    ],
    split: false,
  });
}

/**
 * 结算一手：分筹码 → pot_move → hand_end（必要时 game_over）。
 * 返回 'next'（可开下一手）或 'over'。
 */
function settleHand(evs, winner, { bluffCaught = false } = {}) {
  const v = G.view;
  const pot = v.pot;
  if (winner === 0) v.player.chips += pot;
  else if (winner === 1) v.boss.chips += pot;

  const who = winner === 0 ? '你' : '对手';
  feedOf('hand', `第 ${v.handNo} 手 · 底池 ${pot} → ${who}赢得 ${pot}`);

  evs.push({ type: 'pot_move', to: winner, amount: pot });
  evs.push({
    type: 'hand_end',
    handNo: v.handNo,
    winner,
    pot,
    stacks: { player: v.player.chips, boss: v.boss.chips },
    bluffCaught: Boolean(bluffCaught),
  });
  v.pot = 0;

  if (v.boss.chips <= 0) {
    v.phase = 'victory';
    v.toAct = null;
    evs.push({ type: 'game_over', phase: 'victory', heart: HEART_V });
    return 'over';
  }
  if (v.player.chips <= 0) {
    v.phase = 'defeat';
    v.toAct = null;
    evs.push({ type: 'game_over', phase: 'defeat', heart: HEART_D });
    return 'over';
  }

  v.handNo += 1;
  v.button ^= 1;
  startHand(evs);
  return 'next';
}

function foldWin(evs, winner) {
  evs.push({ type: 'fold_win', winner });
  return settleHand(evs, winner);
}

function bossRespondDefault(evs, playerAction) {
  const v = G.view;
  const raised = playerAction === 'bet' || playerAction === 'raise';

  // 弃牌给到的加注压力：showdown 主题从不弃，random 最爱弃
  let foldChance = 0;
  if (raised) {
    if (G.theme === 'showdown') foldChance = 0;
    else if (G.theme === 'random') foldChance = 0.5;
    else foldChance = 0.15;
  }
  if (raised && Math.random() < foldChance) {
    seatAction(1, 'fold', undefined, evs);
    foldWin(evs, 0);
    return;
  }

  const toCall = Math.max(0, v.player.bet - v.boss.bet);
  if (toCall > 0) {
    seatAction(1, 'call', undefined, evs);
  } else {
    seatAction(1, 'check', undefined, evs);
  }

  if (Math.random() < 0.55) pushTalk(evs, pick(LINES_NORMAL));

  if (!nextStreet(evs)) {
    // 河牌圈打完 → 摊牌
    const winner = Math.random() < 0.55 ? 0 : 1;
    showdownEvent(evs, winner);
    const result = settleHand(evs, winner);
    if (result === 'next' && winner === 1 && v.pot === 0 && Math.random() < 0.5) {
      pushMental(evs, 'BIG_LOSS'); // 打得太顺，Boss 反而上头（演示状态阶梯）
    }
    return;
  }

  // 新街上 Boss 主动领打（60%）
  if (Math.random() < 0.6) {
    const raiseTo = Math.min(
      v.boss.bet + v.boss.chips,
      v.boss.bet + Math.max(20, Math.round(v.pot * 0.5)),
    );
    seatAction(1, 'bet', raiseTo, evs);
  }
  refreshLegal(v);
  v.toAct = 0;
}

function onPlayerAction(action, amount) {
  const v = G.view;
  if (v.phase !== 'playing') return fail(400, '对局已结束，请点「再来一局」');
  if (v.toAct !== 0) return fail(400, '还没轮到你');
  if (!['check', 'call', 'bet', 'raise', 'fold', 'allin'].includes(action)) {
    return fail(400, `未知动作：${action}`);
  }
  const legal = v.player.legal ?? refreshLegal(v);
  if (action === 'bet' && !legal.bet) return fail(400, '当前不能下注');
  if (action === 'raise' && !legal.raise) return fail(400, '当前不能加注');
  if (action === 'check' && !legal.check) return fail(400, '必须先跟注或弃牌');
  if ((action === 'call' || action === 'fold') && !legal.fold) return fail(400, '当前不能执行该动作');
  if ((action === 'bet' || action === 'raise') && amount !== undefined && !Number.isFinite(Number(amount))) {
    return fail(400, 'amount 必须是数字');
  }

  const evs = [];
  seatAction(0, action, amount, evs); // seatAction 内部已写 history
  if (v.objection) v.objection = null; // 玩家行动即关闭异议窗口
  refreshLegal(v);

  /* ---------------------------------------------------------- 弃牌 */
  if (action === 'fold') {
    foldWin(evs, 1);
    return succeed(evs);
  }

  /* -------------------------------------------------------- ALL-IN */
  if (action === 'allin') {
    pushTalk(evs, pick(LINES_ALLIN));
    const toCall = Math.max(0, v.player.bet - v.boss.bet);
    if (toCall > 0) {
      const callAllIn = toCall >= v.boss.chips;
      const willing = Math.random() < (callAllIn ? 0.9 : 0.8);
      if (willing) {
        seatAction(1, callAllIn ? 'allin' : 'call', undefined, evs);
      } else {
        seatAction(1, 'fold', undefined, evs);
        foldWin(evs, 0);
        return succeed(evs);
      }
    } else {
      seatAction(1, 'check', undefined, evs);
    }
    runout(evs);
    const winner = Math.random() < 0.55 ? 0 : 1;
    showdownEvent(evs, winner);
    settleHand(evs, winner);
    refreshLegal(v);
    return succeed(evs);
  }

  /* ------------------------------------------------- 主题 1：异议窗口 */
  if (G.theme === 'objection' && !G.objectionUsed && (v.street === 'preflop' || v.street === 'flop')) {
    G.objectionUsed = true;
    const raiseTo = Math.min(
      v.boss.bet + v.boss.chips,
      Math.max(v.boss.bet * 2, v.player.bet + Math.round(v.pot * 0.5)),
    );
    seatAction(1, 'raise', raiseTo, evs);
    pushTalk(evs, pick(LINES_OPEN));

    const id = G.objectionSeq++;
    const windowMs = 2600;
    const deadline = Date.now() + windowMs;
    G.contraKind = Math.random() < 0.5 ? 'spoken_vs_bet' : 'behavior';
    evs.push({ type: 'contradiction', id, kind: G.contraKind });
    evs.push({ type: 'objection_open', id, deadline, line: v.boss.lastLine, windowMs });
    v.objection = { id, deadline, line: v.boss.lastLine };
    feedOf('objection', `检测到矛盾（#${id}）：立即提出异议！`);
    refreshLegal(v);
    v.toAct = 0;
    return succeed(evs);
  }

  /* ------------------------------------------- 主题 3：翻牌后跟注被抓诈唬 */
  if (
    G.theme === 'bluff' && !G.bluffUsed && action === 'call' && v.street !== 'preflop'
  ) {
    G.bluffUsed = true;
    pushTalk(evs, pick(LINES_BUSTED));
    pushMental(evs, 'BLUFF_CAUGHT');
    settleHand(evs, 0, { bluffCaught: true });
    refreshLegal(v);
    return succeed(evs);
  }

  /* ------------------------------------------- 默认：Boss 应对 + 推进 */
  bossRespondDefault(evs, action);
  refreshLegal(v);
  return succeed(evs);
}

function onRead() {
  const v = G.view;
  if (v.phase !== 'playing') return fail(400, '对局已结束');
  if (Number(v.player.readsLeft) <= 0) return fail(400, '本手的 READ 次数已用完');
  const text = READS[G.readIdx % READS.length];
  G.readIdx += 1;
  v.player.readsLeft -= 1;
  v.reads.unshift({ text });
  if (v.reads.length > 3) v.reads.length = 3;
  feedOf('read', text);
  return succeed([{ type: 'read', text }]);
}

function onSpeak(skill) {
  const v = G.view;
  if (v.phase !== 'playing') return fail(400, '对局已结束');
  if (!SPEECH_LABEL[skill]) return fail(400, `未知言语技能：${skill}`);
  if (Number(v.player.speech?.[skill]) <= 0) {
    return fail(400, `${SPEECH_LABEL[skill]}本手已用完`);
  }
  v.player.speech[skill] -= 1;

  // 首次使用必命中（保证 canned 覆盖 speech(hit) + mental 阶梯），其后按概率
  let result;
  if (!G.skillUsed[skill]) result = 'hit';
  else {
    const r = Math.random();
    result = r < 0.4 ? 'hit' : r < 0.72 ? 'resist' : 'whiff';
  }
  G.skillUsed[skill] = true;

  const line = pick(SPEECH_LINES[skill][result]);
  v.boss.lastLine = line;
  feedOf('speech', `${SPEECH_LABEL[skill]} · ${SPEECH_RESULT_LABEL[result]}`);
  const evs = [{ type: 'speech', skill, result, line }];
  if (result === 'hit') pushMental(evs, skill.toUpperCase());
  refreshLegal(v);
  return succeed(evs);
}

function onObject(id) {
  const v = G.view;
  if (v.phase !== 'playing') return fail(400, '对局已结束');
  const o = v.objection;
  const numId = Number(id);
  if (!o || !Number.isFinite(numId) || Number(o.id) !== numId) {
    return fail(400, '异议窗口已关闭');
  }
  const evs = [];
  if (Date.now() > o.deadline) {
    v.objection = null;
    evs.push({ type: 'objection_result', id: o.id, success: false, kind: G.contraKind, transition: null });
    feedOf('objection', '异议超时：错失机会');
    refreshLegal(v);
    return { status: 200, body: { view: v, events: evs, ok: false, reason: 'expired' } };
  }

  const from = v.boss.state;
  const to = LADDER[from] ?? from;
  applyBossState(to);
  v.objection = null;
  evs.push({ type: 'objection_result', id: o.id, success: true, kind: G.contraKind, transition: { from, to } });
  feedOf('objection', '异议成立：Boss 的谎言被戳穿');
  pushTalk(evs, pick(LINES_OBJECTION_HIT));
  refreshLegal(v);
  v.toAct = 0;
  return { status: 200, body: { view: v, events: evs, ok: true } };
}

function onNewGame() {
  const evs = newGame();
  return succeed(evs);
}

/* ------------------------------------------------------------ HTTP 工具 */

function prune(v) {
  if (v?.objection && Date.now() > v.objection.deadline) v.objection = null;
}

const succeed = (events) => ({ status: 200, body: { view: G.view, events } });
const fail = (status, error) => ({ status, body: { error } });

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
    prune(G.view);
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
      case '/api/speak':
        result = onSpeak(body?.skill);
        break;
      case '/api/object':
        result = onObject(body?.id);
        break;
      case '/api/newgame':
        result = onNewGame();
        break;
      default:
        result = fail(404, '未知接口');
    }
  } catch (err) {
    console.error('[api] 处理失败：', err);
    result = fail(500, '预览服务内部错误');
  }
  prune(result.body?.view ?? null);
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
  console.log(`《allin》预览服务已启动：http://localhost:${PORT}`);
  console.log(`静态根目录：${WEB_ROOT}`);
  console.log('canned 流程：手1 异议窗口 → 手2 摊牌 → 手3 抓诈唬 → 手4 随机流 → 循环；ALL-IN 可快速触发结局。');
});
