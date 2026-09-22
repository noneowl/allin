/**
 * app.js — 《allin》Boss 战前端主逻辑
 *
 * 结构：状态机（S）+ 串行事件队列（pump）+ 全量渲染（render）+ 交互。
 * 契约：docs/PROTOCOL.md —— 每个 POST 返回 { view, events }；
 * view 是权威快照（播完事件后整体渲染），events 串行按节奏播放，播放期间锁定行动栏。
 *
 * 防御性原则：
 * - 任何字段缺失都不崩（view.objection=null、history 空、未知事件 → console.warn 并跳过）；
 * - 事件播放单条 try/catch，异常路径最终一定解锁行动栏（pump 的 finally）；
 * - view 响应做 JSON 深拷贝，避免与事件播放中的可变状态共享引用。
 */
import { $, el, clear } from './dom.js';
import { CardRow } from './cards.js';
import { api } from './api.js';
import { sfx, unlockAudio } from './sound.js';
import { typewrite, cancelTypewrite } from './typewriter.js';
import * as fx from './effects.js';

/* ================================================================= 常量 */

const STATE_LABEL = {
  FLOW: '神了', HOT: '得意', CALM: '冷静', SHAKEN: '动摇', TILT: '上头', BREAKING: '崩坏',
};
// 情绪刻度顺序（与服务端 mental.js SCALE 一致）：下标变大 = 向坏（▼），变小 = 回血（▲）
const STATE_ORDER = ['FLOW', 'HOT', 'CALM', 'SHAKEN', 'TILT', 'BREAKING'];
const STREET_LABEL = { preflop: '翻牌前', flop: '翻牌圈', turn: '转牌圈', river: '河牌圈' };
const ACTION_LABEL = { check: '过牌', call: '跟注', bet: '下注', raise: '加注', fold: '弃牌', allin: '全下' };
const SPEECH_LABEL = { taunt: '挑衅', challenge: '质疑', pressure: '施压' };
const SPEECH_RESULT = { hit: '命中', resist: '被抵挡', whiff: '落空' };
const KIND_LABEL = {
  talk: '台词', read: 'READ', mental: '心理', contradiction: '矛盾',
  objection: '异议', speech: '言语', hand: '结算', system: '系统',
};
const CAUSE_LABEL = {
  BLUFF_CAUGHT: '诈唬被抓', OBJECTION: '谎言被戳穿', TAUNT: '被挑衅激怒',
  CHALLENGE: '遭到质疑', PRESSURE: '压力失控', SPEECH: '言语攻势',
};
const CONTRADICTION_LABEL = {
  spoken_vs_bet: '言行不一：说的和下的注对不上',
  behavior: '行为异常：与此前模式矛盾',
};
const REASON_LABEL = {
  stale: '窗口已关闭', resolved: '已经提过了', late: '太慢了，话已说完',
  window_closed: '窗口已关闭', expired: '超时',
  not_found: '窗口不存在', already: '已经提过了',
};

const FEED_CAP = 160;          // 单个列表 DOM 上限（服务端另有 100/60 截断）
const RING_CIRCUM = 125.66;    // 2πr, r=20
const POLL_MS = 1600;
const POLL_MAX = 20;

const fmt = (n) => {
  const v = Math.round(Number(n) || 0);
  return v.toLocaleString('en-US');
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const parseNum = (s) => {
  const n = Number(String(s ?? '').replace(/[^0-9]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const clone = (obj) => {
  try { return JSON.parse(JSON.stringify(obj)); } catch { return obj; }
};

/* ================================================================= 状态 */

const S = {
  view: null,             // 最近一次响应的权威快照（深拷贝）
  queue: [],              // 待播放事件
  pumping: false,         // 事件队列播放中
  awaiting: false,        // 请求在途

  objection: null,        // { id, deadline, line, windowMs } 活跃的异议窗口
  objTimer: null,         // 倒计时 interval id（过期即清理）
  objectionPending: false,// 异议请求在途

  showdown: null,         // 最近一次 showdown { hands, split }，跨渲染保留 winner/dim
  board: [],              // 播放中的公共牌（终态由 view.board 校正）
  playHand: 0,            // 播放语境下的手数（live history 用）
  playStreet: '',         // 播放语境下的街
  liveBet: { 0: 0, 1: 0 },// 播放语境下的本街投入（betflag 用）

  heart: null,            // game_over 的临终台词
  endShown: false,

  raiseTouched: false,    // 用户是否动过滑杆
  raiseValue: 0,

  guideOpen: false,       // 新手引导浮层
  guideIndex: 0,
  guideClosedOnce: false, // 关闭过一次后才开始发上下文小提示
  usedRead: false,        // 本局已用过 READ（首手提示的触发条件）
  hintReadDone: false,
  pendingLean: null,      // 最近一次 READ 的倾向标签（「你信吗？」问句用）

  polls: 0,               // 静默刷新次数（有界，防止无限轮询）
  pollTimer: null,
};

/** DOM 引用（bindDom 时赋值）。 */
const D = {
  app: null, bossZone: null, boss: null, bossAvatar: null, bossFace: null, bossMood: null,
  bossChips: null, bossBet: null, bossDealer: null, bossHole: null, bossHandname: null, bossAct: null,
  bubble: null, bubbleText: null, bubbleCaret: null,
  objection: null, objRingFg: null, objMs: null, btnObjection: null, objectionLine: null,
  streetBadge: null, board: null, pot: null, potValue: null,
  playerZone: null, playerHole: null, playerHandname: null, playerDealer: null,
  playerChips: null, playerBet: null, playerTocall: null,
  handPill: null, history: null, talk: null, readLeftPill: null, readLatest: null, reads: null, important: null,
  abStatus: null, abStatusText: null,
  btnCheck: null, checkLabel: null, btnCall: null, callLabel: null, btnFold: null,
  btnAllin: null, allinLabel: null, raiseBox: null, raiseSlider: null, raiseAmt: null,
  raiseLabelTop: null, raiseBtnLabel: null, btnRaise: null,
  btnRead: null, readBadge: null, btnTaunt: null, tauntLeft: null,
  btnChallenge: null, challengeLeft: null, btnPressure: null, pressureLeft: null,
  end: null, endCard: null, endHeart: null, endKicker: null, endTitle: null, endSub: null, btnAgain: null,
  guide: null, guideStep: null, guidePages: null, guideDots: null,
  guidePrev: null, guideSkip: null, guideNext: null, btnGuide: null,
  stateScale: null, stateScaleSteps: null, stateHint: null,
  bossEffects: null, mentalHint: null, readLean: null,
};

let boardRow = null;
let playerRow = null;
let bossRow = null;

/* ============================================================= 工具函数 */

const isBusy = () => S.awaiting || S.pumping;

function setStatus(text, mode = 'ok') {
  if (!D.abStatusText) return;
  D.abStatusText.textContent = text;
  D.abStatus.classList.toggle('is-busy', mode === 'busy');
  D.abStatus.classList.toggle('is-wait', mode === 'wait');
  D.abStatus.classList.toggle('is-over', mode === 'over');
}

function statusFor(view, busy) {
  if (!view) return ['连接中…', 'wait'];
  if (view.phase !== 'playing') {
    return view.phase === 'victory' ? ['已击溃 Boss', 'over'] : ['对局结束', 'over'];
  }
  if (busy) return ['演出播放中…', 'busy'];
  if (view.toAct === 0) return ['轮到你行动', 'ok'];
  if (view.toAct === 1) return ['对手思考中…', 'wait'];
  return ['结算中…', 'wait'];
}

/* ====================================================== 信息栏：行构造 */

function historyNode(h) {
  const isBoss = h.actor === 1 || h.actor === 'boss';
  return el('div', { class: 'hrow' }, [
    el('span', { class: 'hrow__hand num', text: `#${h.handNo ?? '—'}` }),
    el('span', { class: 'hrow__street', text: STREET_LABEL[h.street] ?? (h.street ?? '') }),
    el('span', { class: `hrow__who ${isBoss ? 'is-boss' : 'is-me'}`, text: isBoss ? 'Boss' : '你' }),
    el('span', { class: 'hrow__act', text: ACTION_LABEL[h.action] ?? (h.action ?? '—') }),
    Number(h.amount) > 0 ? el('span', { class: 'hrow__amt num', text: fmt(h.amount) }) : null,
  ]);
}

function feedNode(item) {
  const kind = typeof item?.kind === 'string' ? item.kind : 'system';
  const text = item?.text ?? '';
  if (kind === 'talk') return el('div', { class: 'trow', text });
  if (kind === 'read') return el('div', { class: 'rrow', text });
  return el('div', { class: `irow irow--${kind}` }, [
    el('span', { class: 'irow__kind', text: KIND_LABEL[kind] ?? kind }),
    el('span', { text }),
  ]);
}

function appendCapped(host, node) {
  if (!host || !node) return;
  const atBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 48;
  host.appendChild(node);
  while (host.children.length > FEED_CAP) host.firstChild.remove();
  if (atBottom) host.scrollTop = host.scrollHeight;
}

function fillFeed(host, nodes) {
  if (!host) return;
  const atBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 48;
  const prevScroll = host.scrollTop;
  clear(host);
  for (const n of nodes) host.appendChild(n);
  host.scrollTop = atBottom || nodes.length < 2 ? host.scrollHeight : prevScroll;
}

function updateReadLatest(text, { flash = false } = {}) {
  const node = D.readLatest;
  if (!node) return;
  if (!text) {
    node.classList.add('is-empty');
    node.textContent = '尚未进行 READ。';
    node.dataset.text = '';
    return;
  }
  if (node.dataset.text === text) return; // 打字机刚写完的同一条不重复高亮
  cancelTypewrite(node);
  node.dataset.text = text;
  node.classList.remove('is-empty');
  node.textContent = text;
  if (flash) flashReadLatest();
}

function flashReadLatest() {
  const node = D.readLatest;
  node.classList.remove('is-flash');
  void node.offsetWidth;
  node.classList.add('is-flash');
  setTimeout(() => node.classList.remove('is-flash'), 1500);
}

/* ============================================================== 渲染 */

function render(view) {
  if (!view || typeof view !== 'object') return;
  S.view = view;

  // 播放语境与权威快照对齐（供下一轮事件播放期间的 live 更新使用）
  S.playHand = Number(view.handNo) || S.playHand;
  S.playStreet = typeof view.street === 'string' ? view.street : S.playStreet;
  S.liveBet = {
    0: Math.round(Number(view.player?.bet) || 0),
    1: Math.round(Number(view.boss?.bet) || 0),
  };

  renderBoss(view);
  renderBoard(view);
  renderCenter(view);
  renderPlayer(view);
  renderSidebar(view);
  renderObjectionFromView(view);
  renderActionbar(view);
  renderPhase(view);
  maybeContextHints();
}

function handOf(seat) {
  const hands = Array.isArray(S.showdown?.hands) ? S.showdown.hands : [];
  return hands.find((h) => h?.seat === seat) ?? null;
}

function holeSpecs(hole, seat) {
  const sh = handOf(seat);
  return (Array.isArray(hole) ? hole : []).map((card) => ({
    card,
    down: false,
    winner: Boolean(sh?.winner),
    dim: Boolean(sh) && !sh.winner,
  }));
}

function setHandname(node, seat) {
  const sh = handOf(seat);
  if (!node) return;
  if (!sh) {
    node.hidden = true;
    node.textContent = '';
    return;
  }
  const who = seat === 0 ? '你' : 'Boss';
  node.textContent = `${who} · ${sh.handName ?? '—'}${sh.winner ? ' ★' : ''}`;
  node.classList.toggle('is-lose', !sh.winner);
  node.hidden = false;
}

function setBetFlag(node, amount) {
  if (!node) return;
  const v = Math.round(Number(amount) || 0);
  if (v > 0) {
    node.hidden = false;
    const numEl = node.querySelector('.num');
    if (numEl) numEl.textContent = fmt(v);
  } else {
    node.hidden = true;
  }
}

function renderBoss(view) {
  const boss = view.boss ?? {};
  const stateName = typeof boss.state === 'string' ? boss.state : 'CALM';
  D.bossZone.dataset.state = stateName;

  if (boss.face) D.bossFace.textContent = boss.face;
  D.bossMood.textContent = boss.mood ?? STATE_LABEL[stateName] ?? stateName;
  D.bossChips.textContent = fmt(boss.chips ?? 0);
  setBetFlag(D.bossBet, boss.bet);
  D.bossDealer.hidden = view.button !== 1;

  const la = boss.lastAction;
  if (la && ACTION_LABEL[la.action]) {
    D.bossAct.hidden = false;
    D.bossAct.textContent = Number(la.amount) > 0
      ? `${ACTION_LABEL[la.action]} ${fmt(la.amount)}`
      : ACTION_LABEL[la.action];
  } else {
    D.bossAct.hidden = true;
  }

  renderEffects(boss);

  // 台词气泡：无打字进行时才整体替换（打字机由事件驱动）
  const line = typeof boss.lastLine === 'string' ? boss.lastLine : '';
  if ((D.bubbleText.dataset.line ?? '') !== line) {
    cancelTypewrite(D.bubbleText);
    D.bubbleText.textContent = line;
    D.bubbleText.dataset.line = line;
    D.bubbleCaret.classList.remove('is-on');
  }
  if (!S.objection) D.bubble.classList.remove('is-hot');

  const hole = boss.hole;
  if (Array.isArray(hole) && hole.length > 0) {
    bossRow.render(holeSpecs(hole, 1));
  } else {
    bossRow.render([{ card: null, down: true }, { card: null, down: true }]);
  }
  setHandname(D.bossHandname, 1);
}

function renderBoard(view) {
  if (Array.isArray(view.board)) {
    S.board = view.board.filter((c) => typeof c === 'string');
    boardRow.render(S.board.map((card) => ({ card, down: false })));
  }
}

function renderCenter(view) {
  const street = typeof view.street === 'string' ? view.street : '';
  D.streetBadge.textContent = STREET_LABEL[street] ?? street ?? '—';
  D.streetBadge.dataset.street = street;
  D.potValue.textContent = fmt(view.pot ?? 0);
  D.playerDealer.hidden = view.button !== 0;
  D.bossDealer.hidden = view.button !== 1;

  // 情绪刻度：当前格点亮 + 打法含义
  const state = typeof view.boss?.state === 'string' ? view.boss.state : 'CALM';
  if (D.stateScaleSteps) {
    for (const step of D.stateScaleSteps.children) {
      step.classList.toggle('is-active', step.dataset.state === state);
    }
  }
  const hint = typeof view.boss?.stateHint === 'string' ? view.boss.stateHint : '';
  if (D.stateHint) {
    D.stateHint.textContent = hint || '—';
    D.stateHint.title = hint;
  }

  const playing = view.phase === 'playing';
  D.bossZone.classList.toggle('is-turn', playing && view.toAct === 1);
  D.playerZone.classList.toggle('is-turn', playing && view.toAct === 0);
}

/** 言语命中的倾向贴纸：心理攻击落回牌桌的可见形态（效果耗尽即消失）。 */
function renderEffects(boss) {
  if (!D.bossEffects) return;
  const effects = Array.isArray(boss.effects) ? boss.effects : [];
  const sig = effects.map((e) => `${e.kind}:${e.desc}`).join('|');
  if (D.bossEffects.dataset.sig === sig) return;
  D.bossEffects.dataset.sig = sig;
  clear(D.bossEffects);
  for (const e of effects) {
    D.bossEffects.appendChild(el('span', { class: `effect-chip effect-chip--${e.kind ?? ''}` }, [
      el('span', { class: 'effect-chip__icon', text: e.icon ?? '•' }),
      el('b', { text: e.label ?? '' }),
      el('i', { text: e.desc ?? '' }),
    ]));
  }
  D.bossEffects.hidden = effects.length === 0;
}

/** 他刚在这条街下注/加注？ → READ 的黄金时机。 */
function bossJustBet(view) {
  const la = view.boss?.lastAction;
  if (!la || la.street !== view.street) return false;
  return la.action === 'bet' || la.action === 'raise' || la.action === 'allin';
}

/** READ 倾向标签（判断轴，不是答案）。 */
function setLeanChip(item) {
  if (!D.readLean) return;
  const label = item && item.lean ? item.leanLabel : null;
  if (!label) {
    D.readLean.hidden = true;
    D.readLean.textContent = '';
    D.readLean.dataset.lean = '';
    return;
  }
  if (D.readLean.dataset.lean === label) return;
  D.readLean.dataset.lean = label;
  D.readLean.textContent = `💛 ${label}`;
  D.readLean.hidden = false;
}

/**
 * 心理操作区的情境提示 —— 回答三个「什么时候用」：
 * 有倾向问句 > 有破绽可追问 > READ 黄金时机 > 默认循环提示。
 */
function updateMentalHint(view, { readHot = false } = {}) {
  if (!D.mentalHint) return;
  let text;
  if (S.pendingLean) text = `倾向：${S.pendingLean} —— 你信吗？`;
  else if (view?.player?.canChallenge && !S.objection) text = '他的话有破绽 —— 质疑可以追打';
  else if (readHot) text = '他刚下注 · 此刻 READ 最有价值';
  else text = '瞄准 READ · 布局言语 · 破绽亮起按抓千';
  if (D.mentalHint.textContent !== text) D.mentalHint.textContent = text;
  D.mentalHint.classList.toggle('is-question', Boolean(S.pendingLean));
}

function renderPlayer(view) {
  const p = view.player ?? {};
  D.playerChips.textContent = fmt(p.chips ?? 0);
  setBetFlag(D.playerBet, p.bet);

  const toCall = Math.round(Number(p.toCall) || 0);
  if (view.phase === 'playing' && toCall > 0) {
    D.playerTocall.hidden = false;
    D.playerTocall.textContent = `需跟注 ${fmt(toCall)}`;
  } else if (view.phase === 'playing' && p.legal?.check === true) {
    D.playerTocall.hidden = false;
    D.playerTocall.textContent = '可过牌';
  } else {
    D.playerTocall.hidden = true;
  }

  playerRow.render(holeSpecs(p.hole, 0));
  setHandname(D.playerHandname, 0);
}

function renderSidebar(view) {
  D.handPill.textContent = `第 ${view.handNo ?? '—'} 手`;

  fillFeed(D.history, (Array.isArray(view.history) ? view.history : [])
    .filter((h) => h && typeof h === 'object')
    .map(historyNode));

  const talkNodes = [];
  const readNodes = [];
  const importantNodes = [];
  let latestRead = null;
  for (const item of (Array.isArray(view.feed) ? view.feed : [])) {
    if (!item || typeof item !== 'object') continue;
    const node = feedNode(item);
    if (item.kind === 'talk') talkNodes.push(node);
    else if (item.kind === 'read') {
      readNodes.push(node);
      latestRead = item.text ?? latestRead; // feed 按时间顺序 → 最后一条 read 最新
    } else importantNodes.push(node);
  }
  fillFeed(D.talk, talkNodes);
  fillFeed(D.reads, readNodes);
  fillFeed(D.important, importantNodes);

  const readsArr = Array.isArray(view.reads) ? view.reads : [];
  // 「最近 3 条」以 reads[0] 为最新；feed 缺 read 条目时兜底取其最后一条
  updateReadLatest(readsArr[0]?.text ?? latestRead ?? '', { flash: false });
  if (readsArr[0]) setLeanChip(readsArr[0]); // 刷新页面后倾向标签还在

  const left = Math.max(0, Math.round(Number(view.player?.readsLeft) || 0));
  D.readLeftPill.textContent = `本手 ${left} 次`;
}

function renderObjectionFromView(view) {
  const o = view.objection;
  if (!o || typeof o !== 'object' || !Number.isFinite(Number(o.deadline))) {
    if (S.objection && !S.objectionPending) clearObjection();
    return;
  }
  const deadline = Number(o.deadline);
  if (deadline - Date.now() <= 0) {
    clearObjection();
    return;
  }
  if (S.objection && S.objection.id === o.id) return; // 已在倒计时
  openObjection({ id: o.id, deadline, line: o.line ?? '' }, deadline - Date.now(), { sound: false });
}

function renderActionbar(view) {
  const busy = isBusy();
  const playing = view.phase === 'playing';
  const myTurn = playing && view.toAct === 0 && !busy;
  const legal = (view.player && typeof view.player.legal === 'object' && view.player.legal)
    ? view.player.legal
    : {};

  D.checkLabel.textContent = '过牌';
  D.btnCheck.disabled = !(myTurn && legal.check === true);

  const callAmt = Math.round(Number(legal.call) || 0);
  D.callLabel.textContent = callAmt > 0 ? `跟注 ${fmt(callAmt)}` : '跟注';
  D.btnCall.disabled = !(myTurn && callAmt > 0);

  D.btnFold.disabled = !(myTurn && legal.fold === true);

  const allinAmt = Math.round(Number(legal.allin) || 0);
  D.allinLabel.textContent = allinAmt > 0 ? `全下 ${fmt(allinAmt)}` : '全下';
  D.btnAllin.disabled = !(myTurn && allinAmt > 0);

  // BET / RAISE 合并控件（滑杆 + 快捷比例）
  const minTo = Math.round(Number(legal.minTo) || 0);
  const maxTo = Math.round(Number(legal.maxTo) || 0);
  const canRaise = myTurn && (legal.bet === true || legal.raise === true) && maxTo > 0;
  D.raiseBox.classList.toggle('is-locked', !canRaise);
  D.raiseBox.classList.toggle('is-armed', canRaise);
  D.btnRaise.disabled = !canRaise;

  if (maxTo > 0) {
    D.raiseSlider.min = String(minTo);
    D.raiseSlider.max = String(maxTo);
    const span = Math.max(1, maxTo - minTo);
    D.raiseSlider.step = String(Math.max(1, Math.round(span / 50)));
    if (!S.raiseTouched || S.raiseValue < minTo || S.raiseValue > maxTo) {
      S.raiseValue = clamp(S.raiseValue || minTo, minTo, maxTo);
    }
    D.raiseSlider.value = String(S.raiseValue);
  }
  D.raiseSlider.disabled = !canRaise;
  updateRaiseUI();

  // 心理操作（每手剩余次数，0 次禁用；不依赖 toAct，由服务端裁决合法性）
  const mentalOk = playing && !busy;
  const reads = Math.max(0, Math.round(Number(view.player?.readsLeft) || 0));
  D.readBadge.textContent = `×${reads}`;
  const readHot = myTurn && reads > 0 && bossJustBet(view);
  D.btnRead.disabled = !(mentalOk && reads > 0);
  D.btnRead.classList.toggle('is-hot', readHot); // 他刚下注 → READ 呼吸高亮

  const canChallenge = view.player?.canChallenge === true;
  const speech = (view.player?.speech && typeof view.player.speech === 'object') ? view.player.speech : {};
  for (const [btn, badge, key] of [
    [D.btnTaunt, D.tauntLeft, 'taunt'],
    [D.btnChallenge, D.challengeLeft, 'challenge'],
    [D.btnPressure, D.pressureLeft, 'pressure'],
  ]) {
    const n = Math.max(0, Math.round(Number(speech[key]) || 0));
    badge.textContent = `×${n}`;
    // 质疑（清算）只有「手里有破绽」时才亮 —— 教会玩家别乱按
    const armed = key !== 'challenge' || canChallenge;
    btn.disabled = !(mentalOk && n > 0 && armed);
    if (key === 'challenge') btn.classList.toggle('is-armed', Boolean(canChallenge && n > 0 && mentalOk));
  }
  updateMentalHint(view, { readHot });

  const [text, mode] = statusFor(view, busy);
  setStatus(text, mode);
}

function updateRaiseUI() {
  const v = S.view;
  if (!v || !D.raiseSlider) return;
  const isRaise = Math.round(Number(v.player?.toCall) || 0) > 0;
  const val = Math.round(Number(S.raiseValue) || 0);
  D.raiseLabelTop.textContent = isRaise ? '加注至' : '下注至';
  D.raiseAmt.textContent = fmt(val);
  D.raiseBtnLabel.textContent = `${isRaise ? '加注' : '下注'} ${fmt(val)}`;
  const minTo = Number(D.raiseSlider.min) || 0;
  const maxTo = Number(D.raiseSlider.max) || 0;
  const pct = maxTo > minTo ? ((val - minTo) / (maxTo - minTo)) * 100 : 0;
  D.raiseSlider.style.setProperty('--fill', `${clamp(pct, 0, 100)}%`);
}

function renderPhase(view) {
  const ended = view.phase === 'victory' || view.phase === 'defeat';
  if (ended && !S.endShown) showEnd(view, { withHeart: Boolean(S.heart) });
  else if (!ended && S.endShown) hideEnd();
}

/* ======================================================= 异议窗口生命周期 */

function openObjection(obj, windowMs, { sound = true } = {}) {
  clearObjection();
  const winMs = Math.max(400, Math.round(Number(windowMs) || 2400));
  S.objection = {
    id: obj.id,
    deadline: Number(obj.deadline),
    line: typeof obj.line === 'string' ? obj.line : '',
    windowMs: winMs,
  };
  D.objection.hidden = false;
  D.objectionLine.textContent = S.objection.line;
  D.btnObjection.disabled = false;
  D.bubble.classList.add('is-hot');
  if (D.app) D.app.classList.add('is-catchtime'); // 三拍：屏息态（气泡+注码发亮）
  if (sound) sfx.notify();
  tickObjection();
  S.objTimer = setInterval(tickObjection, 80);
}

function tickObjection() {
  const o = S.objection;
  if (!o) return;
  const remaining = o.deadline - Date.now();
  if (remaining <= 0) {
    clearObjection(); // 过期自动消失
    return;
  }
  D.objMs.textContent = String(Math.ceil(remaining));
  const frac = clamp(remaining / o.windowMs, 0, 1);
  D.objRingFg.style.strokeDashoffset = String(RING_CIRCUM * (1 - frac));
}

function clearObjection() {
  if (S.objTimer !== null) {
    clearInterval(S.objTimer);
    S.objTimer = null;
  }
  S.objection = null;
  if (D.objection) {
    D.objection.hidden = true;
    D.objMs.textContent = '0';
    D.objRingFg.style.strokeDashoffset = '0';
    D.btnObjection.disabled = false;
  }
  if (D.bubble) D.bubble.classList.remove('is-hot');
  if (D.app) D.app.classList.remove('is-catchtime');
}

async function onObjectionClick() {
  const o = S.objection;
  if (!o || S.objectionPending) return;
  if (S.awaiting) return; // 其它请求在途：避免并发响应覆盖 view 的竞态
  if (o.deadline - Date.now() <= 0) {
    clearObjection();
    return;
  }
  S.objectionPending = true;
  D.btnObjection.disabled = true;
  sfx.objection();
  fx.popup(D.btnObjection, 'OBJECTION!', 'crit');

  let resp = null;
  try {
    resp = await api.object(o.id);
  } catch (err) {
    console.warn('[异议] 请求失败', err);
    fx.toast(err?.message || '异议提交失败', 'error');
    sfx.miss();
  }
  S.objectionPending = false;

  if (resp) {
    applyResponse(resp);
    const hasResultEvent = Array.isArray(resp.events)
      && resp.events.some((e) => e?.type === 'objection_result');
    if (resp.ok === false && !hasResultEvent) {
      // 服务端判定失败但未附事件：本地补轻量反馈并关窗
      clearObjection();
      sfx.miss();
      const why = REASON_LABEL[resp.reason] ?? (resp.reason ? String(resp.reason) : '');
      fx.popup(D.bubble, `异议无效${why ? ` · ${why}` : ''}`, 'miss');
    }
  } else {
    D.btnObjection.disabled = false; // 网络抖动：窗口若还在，允许重试
  }
  await pump();
}

/* ========================================================= 请求与事件队列 */

function applyResponse(resp) {
  if (resp && resp.view && typeof resp.view === 'object') {
    S.view = clone(resp.view); // 深拷贝：播放期间绝不与响应对象共享引用
  }
  const events = Array.isArray(resp?.events) ? resp.events : [];
  if (events.length) S.queue.push(...events);
}

/** 统一请求入口：串行守卫 → 应用响应 → 泵送事件队列 → 解锁。 */
async function request(fn) {
  if (isBusy()) return null;
  S.awaiting = true;
  syncLock();
  let resp = null;
  try {
    resp = await fn();
  } catch (err) {
    console.warn('[请求失败]', err);
    fx.toast(err?.message || '请求失败', 'error');
    sfx.error();
  }
  S.awaiting = false;
  if (resp) applyResponse(resp);
  await pump();
  return resp;
}

/**
 * 串行播放事件队列。
 * - 单条事件异常只 warn，不中断队列；
 * - finally 之后必渲染 + 解锁 —— 异常路径也不会卡死行动栏；
 * - 播放中新增的事件（如异议响应）会在下一轮 while 判断被取走。
 */
async function pump() {
  if (S.pumping) return;
  S.pumping = true;
  syncLock();
  try {
    while (S.queue.length > 0) {
      const ev = S.queue.shift();
      try {
        await playEvent(ev);
      } catch (err) {
        console.warn('[事件播放失败]', ev?.type, err);
      }
    }
  } finally {
    S.pumping = false;
  }
  if (S.view) {
    try {
      render(S.view);
    } catch (err) {
      console.warn('[渲染失败]', err);
    }
  }
  syncLock();
  schedulePoll();
}

/**
 * 播放/等待期间锁定行动栏。只在锁定时改 disabled，
 * 解锁交给 render(S.view) 按 legal 精确恢复 —— 绝不盲目启用按钮。
 */
function syncLock() {
  if (!D.btnCheck) return;
  const lock = isBusy();
  const playing = S.view ? S.view.phase === 'playing' : true;
  const [text, mode] = statusFor(S.view, isBusy());
  setStatus(text, mode);

  if (lock || !playing) {
    D.btnCheck.disabled = true;
    D.btnCall.disabled = true;
    D.btnFold.disabled = true;
    D.btnAllin.disabled = true;
    D.btnRaise.disabled = true;
    D.raiseBox.classList.toggle('is-locked', true);
    D.btnRead.disabled = true;
    D.btnTaunt.disabled = true;
    D.btnChallenge.disabled = true;
    D.btnPressure.disabled = true;
  }
}

/* ------------------------------------------------------------ 事件播放 */

async function playEvent(ev) {
  if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') {
    console.warn('[事件] 忽略非法事件：', ev);
    return;
  }
  const player = EVENT_PLAYERS[ev.type];
  if (!player) {
    console.warn('[事件] 未知事件类型，已忽略：', ev.type, ev);
    return;
  }
  await player(ev);
}

/** mental / objection_result 共用：换色换表情 + 横幅（含行为后果）+ 音效 + feed。 */
function showMental(from, to, cause, hint = null, down = null) {
  const fromT = STATE_LABEL[from] ?? String(from ?? '');
  const toT = STATE_LABEL[to] ?? String(to ?? '');
  const orderFrom = STATE_ORDER.indexOf(from);
  const orderTo = STATE_ORDER.indexOf(to);
  const isDown = down === null || down === undefined
    ? (orderFrom < 0 || orderTo < 0 ? true : orderTo > orderFrom)
    : Boolean(down);
  const arrow = isDown ? '▼' : '▲';

  if (to) D.bossZone.dataset.state = to;
  const finalBoss = S.view?.boss;
  if (finalBoss && finalBoss.state === to) {
    if (finalBoss.face) D.bossFace.textContent = finalBoss.face;
    D.bossMood.textContent = finalBoss.mood ?? toT;
  } else {
    D.bossMood.textContent = toT; // face 保持服务端给的上一次值，终态渲染时校正
  }
  // 回血用明亮提示音，打击用沉心理音 —— 方向感也要能听出来
  if (isDown) sfx.mental();
  else sfx.notify();

  const causeText = CAUSE_LABEL[cause] ?? (cause ? String(cause) : '');
  appendCapped(D.important, feedNode({
    kind: 'mental',
    text: `${arrow} ${fromT} → ${toT}${causeText ? ` · ${causeText}` : ''}${hint ? ` · ${hint}` : ''}`,
  }));
  // 横幅副标题优先显示「他接下来会怎么变」——命中必须说清因果
  return fx.mentalBanner(fromT, toT, hint || causeText, { recover: !isDown });
}

async function typeBossLine(line) {
  sfx.testimony();
  D.bubbleText.dataset.line = '';
  await typewrite(D.bubbleText, line, { ms: 28, caret: D.bubbleCaret });
  D.bubbleText.dataset.line = line;
}

const EVENT_PLAYERS = {
  async hand_start(ev) {
    S.showdown = null;
    S.board = [];
    S.playHand = Number(ev.handNo) || S.playHand;
    S.playStreet = 'preflop';
    S.liveBet = { 0: 0, 1: 0 };
    boardRow.render([]);
    setHandname(D.playerHandname, 0);
    setHandname(D.bossHandname, 1);
    fx.tableZoom(false);
    setBetFlag(D.playerBet, 0);
    setBetFlag(D.bossBet, 0);
    sfx.notify();
    fx.popup(D.streetBadge, `第 ${ev.handNo ?? ''} 手`, 'hit');
    await fx.sleep(520);
  },

  async blinds(ev) {
    const seat = ev.seat === 1 ? 1 : 0;
    const amount = Math.max(0, Math.round(Number(ev.amount) || 0));
    S.liveBet[seat] = (S.liveBet[seat] || 0) + amount;
    const chipsEl = seat === 1 ? D.bossChips : D.playerChips;
    if (amount > 0) {
      const from = parseNum(chipsEl.textContent);
      fx.animateNumber(chipsEl, from, Math.max(0, from - amount), 340);
    }
    setBetFlag(seat === 1 ? D.bossBet : D.playerBet, S.liveBet[seat]);
    if (ev.potAfter != null) {
      D.potValue.textContent = fmt(ev.potAfter);
      fx.animate(D.pot, [{ transform: 'scale(1)' }, { transform: 'scale(1.12)' }, { transform: 'scale(1)' }],
        { duration: 320, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
    }
    sfx.chip();
    await fx.sleep(430);
  },

  async action(ev) {
    const isBoss = ev.seat === 1;
    if (isBoss) await fx.sleep(800 + Math.random() * 600); // 思考停顿 0.8–1.4s

    const put = Math.max(0, Math.round(Number(ev.put) || 0));
    const chipsEl = isBoss ? D.bossChips : D.playerChips;
    if (put > 0) {
      const from = parseNum(chipsEl.textContent);
      fx.animateNumber(chipsEl, from, Math.max(0, from - put), 420); // 输家筹码倒数
      S.liveBet[ev.seat === 1 ? 1 : 0] = (S.liveBet[ev.seat === 1 ? 1 : 0] || 0) + put;
      sfx.chip();
    }
    setBetFlag(isBoss ? D.bossBet : D.playerBet, S.liveBet[ev.seat === 1 ? 1 : 0]);

    if (ev.potAfter != null) {
      D.potValue.textContent = fmt(ev.potAfter);
      fx.animate(D.pot, [{ transform: 'scale(1)' }, { transform: 'scale(1.14)' }, { transform: 'scale(1)' }],
        { duration: 340, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
    }

    const label = ACTION_LABEL[ev.action] ?? ev.action;
    appendCapped(D.history, historyNode({
      handNo: S.playHand,
      street: S.playStreet,
      actor: ev.seat === 1 ? 1 : 0,
      action: ev.action,
      amount: ev.amount,
    }));

    if (isBoss) {
      if (ev.action && ACTION_LABEL[ev.action]) {
        D.bossAct.hidden = false;
        D.bossAct.textContent = Number(ev.amount) > 0 ? `${label} ${fmt(ev.amount)}` : label;
      }
      if (ev.action !== 'fold') fx.popup(D.bossAvatar, label, 'miss');
    } else {
      fx.popup(D.playerHole, label, 'hit');
    }

    if (ev.action === undefined) console.warn('[事件] action 事件缺少 action 字段', ev);
    switch (ev.action) {
      case 'check': sfx.check(); break;
      case 'call': sfx.chip(); break;
      case 'bet':
      case 'raise': sfx.raise(); break;
      case 'fold': sfx.fold(); break;
      case 'allin': sfx.allin(); break;
      default: break;
    }
    // 全下演出：action==='allin'，或跟注/加注带 allIn 标记（顶格跟到全下）
    if (ev.action === 'allin' || ev.allIn === true) {
      if (ev.action !== 'allin') sfx.allin();
      fx.tableZoom(true);
      fx.popup(isBoss ? D.bossAvatar : D.playerHole, 'ALL IN!', 'crit');
      fx.screenShake(520, 8);
    }
    await fx.sleep(ev.allIn ? 950 : 520);
  },

  async street(ev) {
    const cards = Array.isArray(ev.cards) ? ev.cards.filter((c) => typeof c === 'string') : [];
    const street = typeof ev.street === 'string' ? ev.street : '';
    sfx.turn();
    S.playStreet = street;
    S.liveBet = { 0: 0, 1: 0 };
    setBetFlag(D.playerBet, 0);
    setBetFlag(D.bossBet, 0);
    D.streetBadge.textContent = STREET_LABEL[street] ?? street;
    D.streetBadge.dataset.street = street;
    for (const card of cards) {
      S.board.push(card);
      boardRow.render(S.board.map((c) => ({ card: c, down: false })));
      sfx.deal();
      await fx.sleep(450); // 公共牌逐张 0.45s
    }
    await fx.sleep(240);
  },

  async talk(ev) {
    const line = typeof ev.line === 'string' ? ev.line : '';
    appendCapped(D.talk, feedNode({ kind: 'talk', text: line }));
    await typeBossLine(line);
    await fx.sleep(340);
  },

  async read(ev) {
    const text = typeof ev.text === 'string' ? ev.text : '';
    sfx.notify();
    appendCapped(D.reads, feedNode({ kind: 'read', text }));
    D.readLatest.classList.remove('is-empty');
    D.readLatest.dataset.text = '';
    await typewrite(D.readLatest, text, { ms: 24 });
    D.readLatest.dataset.text = text;
    flashReadLatest();
    // 倾向标签 = 判断轴；随后行动栏给出「你信吗？」
    setLeanChip({ lean: ev.lean, leanLabel: ev.leanLabel });
    S.pendingLean = ev.lean ? ev.leanLabel : null;
    updateMentalHint(S.view, {});
    await fx.sleep(520);
  },

  async speech(ev) {
    const skill = SPEECH_LABEL[ev.skill] ?? String(ev.skill ?? '言语');
    const resultLabel = SPEECH_RESULT[ev.result] ?? String(ev.result ?? '');
    const line = typeof ev.line === 'string' ? ev.line : '';

    sfx.speech();
    await fx.sleep(200);
    if (ev.result === 'hit') {
      fx.popup(D.bossAvatar, `${skill}命中！`, 'hit');
      sfx.hit();
      fx.avatarShake(380, 10);
    } else {
      fx.popup(D.bossAvatar, ev.result === 'resist' ? `${skill}被抵挡` : `${skill}落空`, 'miss');
      sfx.miss();
    }
    appendCapped(D.important, feedNode({
      kind: 'speech',
      text: `${skill} · ${resultLabel}${line ? ` · 「${line}」` : ''}`,
    }));

    if (line) await typeBossLine(line);
    await fx.sleep(360);
  },

  async mental(ev) {
    await showMental(ev.from, ev.to, ev.causeName ?? ev.cause, ev.hint ?? null, ev.down);
  },

  async contradiction(ev) {
    sfx.notify();
    D.bubble.classList.add('is-hot');
    // 三拍的第三拍：破绽连线 —— 台词气泡与注码一起发亮、心跳两声、画面进入「屏息」态
    if (D.app) D.app.classList.add('is-catchtime');
    sfx.heartbeat();
    setTimeout(() => sfx.heartbeat(), 430);
    const why = CONTRADICTION_LABEL[ev.kind] ?? (ev.kind ? String(ev.kind) : '出现破绽');
    fx.popup(D.bubble, '破绽出现', 'crit');
    appendCapped(D.important, feedNode({ kind: 'contradiction', text: `${why} · 按下抓千！` }));

    // 首次破绽 = 教学定格（一次性）：不挡住队列，窗口照常紧接着打开
    let coached = false;
    try { coached = localStorage.getItem('allin.coach.v1') === '1'; } catch { coached = true; }
    if (!coached) {
      try { localStorage.setItem('allin.coach.v1', '1'); } catch { /* 忽略 */ }
      fx.hitstop(380);
      fx.bigText('破绽！', why, { tone: 'red', holdMs: 1500 });
    }
    await fx.sleep(600);
  },

  async objection_open(ev) {
    if (!Number.isFinite(Number(ev.deadline))) {
      console.warn('[事件] objection_open 缺少合法 deadline，已忽略', ev);
      return;
    }
    const windowMs = Math.max(400, Math.round(Number(ev.windowMs) || 2400));
    const line = typeof ev.line === 'string' ? ev.line : '';
    if (line && D.bubbleText.dataset.line !== line) {
      await typeBossLine(line); // 异议窗口 = 打字机结束 + 余下时间（deadline 为准）
    }
    openObjection({ id: ev.id, deadline: ev.deadline, line }, windowMs, { sound: true });
    fx.popup(D.bubble, '就是现在 — 抓千！', 'crit');
    appendCapped(D.important, feedNode({ kind: 'objection', text: '破绽亮起：倒计时内按下抓千！' }));
    await fx.sleep(260);
  },

  async objection_result(ev) {
    clearObjection();
    if (ev.success) {
      await fx.impact({ title: '抓千成功！', sub: 'CAUGHT', tone: 'red', sfxName: 'objection' });
      const tr = ev.transition;
      if (tr && tr.to) await showMental(tr.from, tr.to, 'OBJECTION', ev.hint ?? null);
      appendCapped(D.important, feedNode({
        kind: 'objection',
        text: tr ? '抓千成功！心理防线崩了一格' : '抓千成功！他嘴硬了一句，但防线松了',
      }));
    } else {
      sfx.miss();
      fx.popup(D.bubble, '没抓住', 'miss');
      fx.screenShake(300, 5);
      appendCapped(D.important, feedNode({ kind: 'objection', text: '抓千失败：窗口已经过去' }));
      await fx.sleep(560);
    }
  },

  async showdown(ev) {
    const hands = Array.isArray(ev.hands) ? ev.hands : [];
    S.showdown = { hands, split: Boolean(ev.split) };
    sfx.turn();

    const bossHand = hands.find((h) => h?.seat === 1);
    const bossHole = Array.isArray(bossHand?.hole) ? bossHand.hole : null;
    if (bossHole && bossHole.length) {
      // 先以背面画出牌面，再逐张翻转（复用 CardRow 的 is-down 翻转动画）
      const down = bossHole.map(() => true);
      bossRow.render(bossHole.map((card, i) => ({ card, down: down[i] })));
      await fx.sleep(340);
      for (let i = 0; i < bossHole.length; i += 1) {
        down[i] = false;
        bossRow.render(bossHole.map((card, j) => ({
          card,
          down: down[j],
          winner: Boolean(bossHand?.winner),
          dim: !bossHand?.winner,
        })));
        sfx.turn();
        await fx.sleep(480);
      }
    }

    playerRow.render(holeSpecs(S.view?.player?.hole, 0));
    setHandname(D.playerHandname, 0);
    setHandname(D.bossHandname, 1);

    if (ev.split) fx.popup(D.pot, '平分底池', 'hit');
    await fx.sleep(680);
  },

  async fold_win(ev) {
    const playerWon = ev.winner === 0;
    if (playerWon) sfx.win(); else sfx.fold();
    await fx.banner({
      text: playerWon ? '对手弃牌' : '你选择弃牌',
      sub: playerWon ? 'BOSS FOLDS' : 'FOLD',
      cls: playerWon ? 'fx-banner--win' : 'fx-banner--lose',
      holdMs: 1050,
    });
  },

  async pot_move(ev) {
    const amount = Math.max(0, Math.round(Number(ev.amount) || 0));
    const target = ev.to === 1 ? D.bossChips : D.playerChips;
    sfx.chip();
    await fx.flyChip(D.pot, target, fmt(amount));
    const from = parseNum(target.textContent);
    fx.animateNumber(target, from, from + amount, 480); // 赢家筹码累加
    D.potValue.textContent = fmt(0);
    await fx.sleep(160);
  },

  async hand_end(ev) {
    fx.tableZoom(false);
    const winner = ev.winner;
    const pot = Math.max(0, Math.round(Number(ev.pot) || 0));

    const pFrom = parseNum(D.playerChips.textContent);
    const bFrom = parseNum(D.bossChips.textContent);
    fx.animateNumber(D.playerChips, pFrom, ev.stacks?.player ?? pFrom, 620);
    fx.animateNumber(D.bossChips, bFrom, ev.stacks?.boss ?? bFrom, 620);

    const who = winner === 0 ? '你' : winner === 1 ? '对手' : '双方';
    const text = winner == null
      ? `底池 ${fmt(pot)}`
      : `${who}${ev.split ? '平分' : '赢得'}底池 ${fmt(pot)}`;
    const cls = winner === 0 ? 'fx-banner--win' : winner === 1 ? 'fx-banner--lose' : '';

    appendCapped(D.important, feedNode({
      kind: 'hand',
      text: `第 ${ev.handNo ?? S.playHand} 手 · 底池 ${fmt(pot)} → ${who}${ev.split ? '平分' : `赢得 ${fmt(pot)}`}`,
    }));

    if (winner === 0) sfx.win();
    else if (winner === 1) sfx.lose();
    else sfx.notify();

    // 结算横幅 ≈2.2s，之后才轮到队列里的下一手 hand_start
    const settle = fx.banner({ text, sub: ev.bluffCaught ? 'BLUFF CAUGHT' : '', cls, holdMs: 2200 });
    if (ev.bluffCaught) {
      await fx.sleep(420);
      await fx.impact({ title: 'READ SUCCESS', sub: '抓到诈唬', tone: 'gold', sfxName: 'hit' });
    }
    await settle;
  },

  async game_over(ev) {
    if (typeof ev.heart === 'string' && ev.heart) S.heart = ev.heart;
    sfx.heart();
    const viewAtEnd = (S.view && S.view.phase && S.view.phase !== 'playing') ? S.view : { phase: ev.phase };
    await showEnd(viewAtEnd, { withHeart: Boolean(S.heart) });
  },
};

/* ================================================================ 结局 */

function showEnd(view, { withHeart = false } = {}) {
  if (S.endShown) return Promise.resolve();
  S.endShown = true;
  const phase = view?.phase === 'defeat' ? 'defeat' : 'victory';

  D.end.hidden = false;
  D.end.classList.toggle('is-defeat', phase === 'defeat');
  D.endKicker.textContent = phase === 'defeat' ? 'DEFEAT' : 'VICTORY';
  D.endTitle.textContent = 'BREAK';
  const pChips = fmt(S.view?.player?.chips ?? 0);
  const bChips = fmt(S.view?.boss?.chips ?? 0);
  D.endSub.textContent = phase === 'defeat'
    ? `你被 Boss 击溃了 · 最终筹码 ${pChips} : ${bChips}`
    : `你击溃了 Boss · 最终筹码 ${pChips} : ${bChips}`;

  if (withHeart && S.heart) {
    // 先打字机播放 heart 台词，再显示大标题
    D.endCard.classList.add('is-pre');
    D.endHeart.textContent = '';
    return typewrite(D.endHeart, S.heart, { ms: 42 })
      .then(() => fx.sleep(700))
      .then(() => D.endCard.classList.remove('is-pre'));
  }
  D.endHeart.textContent = S.heart ?? '';
  D.endCard.classList.remove('is-pre');
  return Promise.resolve();
}

function hideEnd() {
  cancelTypewrite(D.endHeart);
  S.endShown = false;
  S.heart = null;
  D.end.hidden = true;
  D.endCard.classList.add('is-pre');
  D.endHeart.textContent = '';
}

/* ============================================== 上下文提示 & 新手引导 */

/** 引导看过之后、首手还没动过时，给一次「先 READ」的轻提示（每局最多一次）。 */
function maybeContextHints() {
  if (!S.guideClosedOnce || S.guideOpen || S.hintReadDone) return;
  const v = S.view;
  if (!v || v.phase !== 'playing' || isBusy() || v.toAct !== 0) return;
  if (S.usedRead) {
    S.hintReadDone = true;
    return;
  }
  if (v.handNo <= 1 && (v.player?.readsLeft ?? 0) > 0) {
    S.hintReadDone = true;
    setTimeout(() => {
      if (!S.guideOpen) fx.toast('提示：先用 READ 看他一眼，再决定跟还是弃', 'info');
    }, 700);
  }
}

/* ============================================================ 新手引导 */

const GUIDE_KEY = 'allin.guide.v1';

function guideSeen() {
  try {
    return localStorage.getItem(GUIDE_KEY) === '1';
  } catch {
    return false; // 隐私模式拿不到 localStorage：当作没看过，每次都能重看也无妨
  }
}

function markGuideSeen() {
  try {
    localStorage.setItem(GUIDE_KEY, '1');
  } catch {
    /* 忽略 */
  }
}

function openGuide(page = 0) {
  if (!D.guide) return;
  S.guideOpen = true;
  S.guideIndex = clamp(Number(page) || 0, 0, Math.max(0, D.guidePages.length - 1));
  D.guide.hidden = false;
  renderGuide();
  sfx.notify();
}

function closeGuide() {
  if (!S.guideOpen || !D.guide) return;
  S.guideOpen = false;
  D.guide.hidden = true;
  S.guideClosedOnce = true;
  markGuideSeen();
}

function renderGuide() {
  const pages = D.guidePages ?? [];
  const i = clamp(S.guideIndex, 0, Math.max(0, pages.length - 1));
  S.guideIndex = i;
  pages.forEach((p, idx) => p.classList.toggle('is-on', idx === i));
  Array.from(D.guideDots?.children ?? []).forEach((d, idx) => d.classList.toggle('is-on', idx === i));
  D.guideStep.textContent = `${i + 1} / ${pages.length}`;
  D.guidePrev.disabled = i === 0;
  D.guideNext.textContent = i === pages.length - 1 ? '开始战斗' : '下一步';
}

function onGuideNext() {
  if (S.guideIndex >= (D.guidePages?.length ?? 1) - 1) closeGuide();
  else {
    S.guideIndex += 1;
    renderGuide();
  }
}

function buildGuide() {
  D.guidePages = Array.from(document.querySelectorAll('#guide .guide__page'));
  clear(D.guideDots);
  D.guidePages.forEach((_, i) => {
    const dot = el('button', { class: 'guide__dot', type: 'button', 'aria-label': `第 ${i + 1} 页` });
    dot.addEventListener('click', () => {
      S.guideIndex = i;
      renderGuide();
    });
    D.guideDots.appendChild(dot);
  });
}

/* ============================================================ 静默刷新 */

function schedulePoll() {
  if (S.pollTimer !== null) {
    clearTimeout(S.pollTimer);
    S.pollTimer = null;
  }
  const v = S.view;
  if (!v || v.phase !== 'playing' || isBusy()) return;
  if (v.toAct === 0) {
    S.polls = 0;
    return;
  }
  if (S.polls >= POLL_MAX) return; // 有界轮询：服务端迟迟不轮到玩家时不无限打请求
  S.polls += 1;
  S.pollTimer = setTimeout(async () => {
    S.pollTimer = null;
    if (isBusy()) return;
    await request(() => api.state());
  }, POLL_MS);
}

/* ================================================================ 交互 */

async function doAction(action, amount) {
  unlockAudio();
  S.polls = 0;
  S.pendingLean = null; // 已经做出回答 —— 「你信吗？」收起
  if (S.pollTimer !== null) {
    clearTimeout(S.pollTimer);
    S.pollTimer = null;
  }
  const resp = await request(() => api.action(action, amount));
  if (resp) S.raiseTouched = false; // 新的一轮回到默认档位
  return resp;
}

function bindActions() {
  D.btnCheck.addEventListener('click', () => doAction('check'));
  D.btnCall.addEventListener('click', () => doAction('call'));
  D.btnFold.addEventListener('click', () => doAction('fold'));
  D.btnAllin.addEventListener('click', () => doAction('allin'));
  D.btnRaise.addEventListener('click', () => {
    const toCall = Math.round(Number(S.view?.player?.toCall) || 0);
    doAction(toCall > 0 ? 'raise' : 'bet', Math.round(S.raiseValue));
  });

  D.raiseSlider.addEventListener('input', () => {
    S.raiseTouched = true;
    S.raiseValue = Number(D.raiseSlider.value);
    updateRaiseUI();
  });

  document.querySelectorAll('.raise__quick [data-frac]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const v = S.view;
      if (!v) return;
      const legal = v.player?.legal ?? {};
      const minTo = Math.round(Number(legal.minTo) || 0);
      const maxTo = Math.round(Number(legal.maxTo) || 0);
      if (maxTo <= 0) return;
      let target;
      if (btn.dataset.frac === 'max') {
        target = maxTo;
      } else {
        const invested = Math.round(Number(v.player?.bet) || 0) + Math.round(Number(v.player?.toCall) || 0);
        target = Math.round(invested + Math.round(Number(v.pot) || 0) * Number(btn.dataset.frac));
        target = clamp(Math.max(target, minTo), minTo, maxTo);
      }
      S.raiseTouched = true;
      S.raiseValue = target;
      D.raiseSlider.value = String(target);
      updateRaiseUI();
      sfx.chip();
    });
  });

  D.btnRead.addEventListener('click', async () => {
    unlockAudio();
    S.polls = 0;
    S.usedRead = true;
    await request(() => api.read());
  });

  const speak = (skill) => async () => {
    unlockAudio();
    S.polls = 0;
    await request(() => api.speak(skill));
  };
  D.btnTaunt.addEventListener('click', speak('taunt'));
  D.btnChallenge.addEventListener('click', speak('challenge'));
  D.btnPressure.addEventListener('click', speak('pressure'));

  D.btnObjection.addEventListener('click', onObjectionClick);

  D.btnAgain.addEventListener('click', async () => {
    unlockAudio();
    S.polls = 0;
    await request(() => api.newgame());
  });

  // 新手引导
  D.btnGuide.addEventListener('click', () => openGuide(S.guideIndex));
  D.guidePrev.addEventListener('click', () => {
    if (S.guideIndex > 0) {
      S.guideIndex -= 1;
      renderGuide();
    }
  });
  D.guideNext.addEventListener('click', onGuideNext);
  D.guideSkip.addEventListener('click', closeGuide);
  D.guide.addEventListener('click', (e) => {
    if (e.target === D.guide) closeGuide(); // 点遮罩关闭
  });
}

function bindKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && S.guideOpen) {
      closeGuide();
      return;
    }
    if (S.guideOpen) return; // 引导打开时屏蔽快捷键，避免误操作
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (!S.view || S.view.phase !== 'playing' || isBusy()) return;

    const key = e.key.toLowerCase();
    if (key === 'f') {
      if (!D.btnFold.disabled) D.btnFold.click();
    } else if (key === 'c') {
      if (!D.btnCall.disabled) D.btnCall.click();
      else if (!D.btnCheck.disabled) D.btnCheck.click();
    } else if (key === 'r') {
      e.preventDefault();
      D.raiseSlider.focus();
    } else if (key === 'a') {
      if (!D.btnAllin.disabled) D.btnAllin.click();
    } else if (e.key === 'Enter') {
      if (!D.btnRaise.disabled) {
        e.preventDefault();
        D.btnRaise.click();
      }
    }
  });
}

/* ================================================================= 启动 */

function bindDom() {
  D.app = $('#app');
  D.bossZone = $('#boss-zone');
  D.boss = $('#boss');
  D.bossAvatar = $('#boss-avatar');
  D.bossFace = $('#boss-face');
  D.bossMood = $('#boss-mood');
  D.bossChips = $('#boss-chips');
  D.bossBet = $('#boss-bet');
  D.bossDealer = $('#boss-dealer');
  D.bossHole = $('#boss-hole');
  D.bossHandname = $('#boss-handname');
  D.bossAct = $('#boss-act');
  D.bubble = $('#boss-bubble');
  D.bubbleText = $('#bubble-text');
  D.bubbleCaret = $('#bubble-caret');
  D.objection = $('#objection');
  D.objRingFg = $('#obj-ring-fg');
  D.objMs = $('#obj-ms');
  D.btnObjection = $('#btn-objection');
  D.objectionLine = $('#objection-line');
  D.streetBadge = $('#street-badge');
  D.board = $('#board');
  D.pot = $('#pot');
  D.potValue = $('#pot-value');
  D.playerZone = $('#player-zone');
  D.playerHole = $('#player-hole');
  D.playerHandname = $('#player-handname');
  D.playerDealer = $('#player-dealer');
  D.playerChips = $('#player-chips');
  D.playerBet = $('#player-bet');
  D.playerTocall = $('#player-tocall');
  D.handPill = $('#hand-pill');
  D.history = $('#history');
  D.talk = $('#talk');
  D.readLeftPill = $('#read-left-pill');
  D.readLatest = $('#read-latest');
  D.reads = $('#reads');
  D.important = $('#important');
  D.abStatus = $('#ab-status');
  D.abStatusText = $('#ab-status-text');
  D.btnCheck = $('#btn-check');
  D.checkLabel = $('#check-label');
  D.btnCall = $('#btn-call');
  D.callLabel = $('#call-label');
  D.btnFold = $('#btn-fold');
  D.btnAllin = $('#btn-allin');
  D.allinLabel = $('#allin-label');
  D.raiseBox = $('#raise-box');
  D.raiseSlider = $('#raise-slider');
  D.raiseAmt = $('#raise-amt');
  D.raiseLabelTop = $('#raise-label-top');
  D.raiseBtnLabel = $('#raise-btn-label');
  D.btnRaise = $('#btn-raise');
  D.btnRead = $('#btn-read');
  D.readBadge = $('#read-left-badge');
  D.btnTaunt = $('#btn-taunt');
  D.tauntLeft = $('#taunt-left');
  D.btnChallenge = $('#btn-challenge');
  D.challengeLeft = $('#challenge-left');
  D.btnPressure = $('#btn-pressure');
  D.pressureLeft = $('#pressure-left');
  D.end = $('#end');
  D.endCard = D.end.querySelector('.end__card');
  D.endHeart = $('#end-heart');
  D.endKicker = $('#end-kicker');
  D.endTitle = $('#end-title');
  D.endSub = $('#end-sub');
  D.btnAgain = $('#btn-again');

  boardRow = new CardRow(D.board, { stagger: 70 });
  playerRow = new CardRow(D.playerHole, { stagger: 70 });
  bossRow = new CardRow(D.bossHole, { stagger: 90 });

  D.endCard.classList.add('is-pre');

  D.guide = $('#guide');
  D.guideStep = $('#guide-step');
  D.guideDots = $('#guide-dots');
  D.guidePrev = $('#guide-prev');
  D.guideSkip = $('#guide-skip');
  D.guideNext = $('#guide-next');
  D.btnGuide = $('#btn-guide');
  buildGuide();

  D.stateScale = $('#state-scale');
  D.stateScaleSteps = $('#state-scale-steps');
  D.stateHint = $('#state-hint');
  D.bossEffects = $('#boss-effects');
  D.mentalHint = $('#mental-hint');
  D.readLean = $('#read-lean');
}

async function boot(retries = 4) {
  setStatus('连接中…', 'wait');
  try {
    const resp = await api.state();
    if (!resp?.view || typeof resp.view !== 'object') throw new Error('服务端返回了空状态');
    S.view = clone(resp.view);
    render(S.view);
    syncLock();
    schedulePoll(); // 若服务端把 toAct 留给了对方，静默轮询兜底
  } catch (err) {
    console.warn('[启动] 加载状态失败', err);
    fx.toast(`加载失败：${err?.message || '未知错误'}`, 'error');
    if (retries > 0) {
      setStatus('加载失败，重试中…', 'wait');
      setTimeout(() => boot(retries - 1), 2000);
    } else {
      setStatus('无法连接服务端', 'over');
    }
  }
}

function init() {
  bindDom();
  bindActions();
  bindKeyboard();

  const unlock = () => {
    unlockAudio();
    document.removeEventListener('pointerdown', unlock);
  };
  document.addEventListener('pointerdown', unlock);

  // 没看过引导 → 开局自动弹出；看过 → 左下角 ? 随时重看
  if (guideSeen()) S.guideClosedOnce = true;
  else openGuide(0);

  boot();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
