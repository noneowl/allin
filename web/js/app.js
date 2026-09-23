/**
 * app.js — 《allin》Boss 战前端主逻辑（v3）
 *
 * 结构：状态机（S）+ 串行事件队列（pump）+ 全量渲染（render）+ 交互。
 * 契约：docs/PROTOCOL.md（v3）—— 每个 POST 返回 { view, events }；
 * view 是权威快照（播完事件后整体渲染），events 串行按节奏播放，播放期间锁定行动栏。
 *
 * v3 核心循环：打牌 → READ 碎片 → 证据链 → CRACK → GOTCHA（BLUFF/STRONG）
 *   → 对 = EXECUTION（自由滑杆 + 高速 READ）/ 错 = COUNTER（Boss 反扑）→ 真实筹码结算。
 *
 * 防御性原则：
 * - 任何字段缺失都不崩（blind/gotcha/cracks/readFragments/legal 缺失 → 默认值）；
 * - 事件播放单条 try/catch，异常路径最终一定解锁行动栏（pump 的 finally + syncLock）；
 * - render 子步骤逐个 try/catch，一个面板炸了不影响其它面板；
 * - view 响应做 JSON 深拷贝，避免与事件播放中的可变状态共享引用；
 * - read_fragment 闪现 fire-and-forget，绝不阻塞事件队列。
 */
import { $, el, clear } from './dom.js';
import { CardRow } from './cards.js';
import { api } from './api.js';
import { sfx, unlockAudio } from './sound.js';
import { typewrite, cancelTypewrite } from './typewriter.js';
import * as fx from './effects.js';

/* ================================================================= 常量 */

const STATE_LABEL = { CALM: '冷静', SHAKEN: '动摇', TILT: '上头' };
const STATE_FACE = { CALM: '😏', SHAKEN: '😳', TILT: '😡' };
const STREET_LABEL = { preflop: '翻牌前', flop: '翻牌圈', turn: '转牌圈', river: '河牌圈' };
const ACTION_LABEL = {
  check: '过牌', call: '跟注', bet: '下注', raise: '加注',
  fold: '弃牌', allin: '全下', pressure: '加压', heavy: '重压',
};
const CRACK_KIND_LABEL = { WEAKNESS: '弱点链', STRENGTH: '强牌链', CRITICAL: '致命破绽' };
const EVIDENCE_LABEL = {
  wants_fold: '想让你弃', fear_call: '怕你跟', weak_hand: '牌弱', strong_hand: '牌强',
  draw: '在听牌', missed_board: '错过牌面', trap: '在设套', overconfidence: '过度自信',
};
const FEED_LABEL = {
  talk: '台词', read: 'READ', crack: 'CRACK', gotcha: 'GOTCHA', mode: '模式',
  blind: '盲注', hand: '结算', model: '针对', system: '系统', mental: '情绪',
};
const MODE_LABEL = { NORMAL: 'NORMAL', EXECUTION: 'EXECUTION', COUNTER: 'COUNTER' };
const MODE_HINT = { NORMAL: '正常对抗', EXECUTION: '自由下注 · 高速 READ', COUNTER: 'Boss 反扑中' };
const CAUSE_LABEL = {
  BLUFF_CAUGHT: '诈唬被抓', GOTCHA_HIT: '判断命中', GOTCHA_STREAK: '连续被猜中',
  BIG_POT_LOST: '输掉大底池', ALL_IN_LOST: '全下失利',
};
const GUESS_LABEL = { BLUFF: 'BLUFF', STRONG: 'STRONG' };
const MODES = new Set(['NORMAL', 'EXECUTION', 'COUNTER']);

const FEED_CAP = 160;          // 单个列表 DOM 上限（服务端另有 30/60 截断）
const POLL_MS = 1600;
const POLL_MAX = 20;
const READ_TICK_MS = 80;       // READ 冷却转圈刷新间隔

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
const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v, d = '') => (typeof v === 'string' ? v : d);

/* ================================================================= 状态 */

const S = {
  view: null,             // 最近一次响应的权威快照（深拷贝）
  queue: [],              // 待播放事件
  pumping: false,         // 事件队列播放中
  awaiting: false,        // 请求在途

  showdown: null,         // 最近一次 showdown { hands, split }
  board: [],              // 播放中的公共牌（终态由 view.board 校正）
  playHand: 0,            // 播放语境下的手数
  playStreet: '',         // 播放语境下的街
  liveBet: { 0: 0, 1: 0 },// 播放语境下的本街投入（betflag 用）

  heart: null,            // game_over 的临终台词
  endShown: false,

  raiseTouched: false,    // 用户是否动过滑杆
  raiseValue: 0,

  gotchaOpen: false,      // GOTCHA 二选一确认条是否展开
  gotchaPosting: false,   // gotcha 请求在途
  pendingGotchaId: null,  // 在途 gotcha 对应的 CRACK id（用于把结果挂回面板）

  crackEntries: {},       // id → 证据链条目（面板行重建用）
  crackResults: {},       // id → { guess, correct }（会话内记忆；服务端给 used 字段时优先）

  readUntil: 0,           // READ 冷却截止（ms）
  readWindowMs: 0,        // 转圈窗口（= 刚进入冷却时的剩余时长）
  readTimer: null,        // 冷却转圈 interval id

  chipsRef: 0,            // 筹码堆分母：本局筹码总量（chips + pot 恒定）

  guideOpen: false,
  guideIndex: 0,
  guideClosedOnce: false,
  hintReadDone: false,    // 「先 READ」一次性提示
  hintGotchaShown: false, // 「GOTCHA 解锁」一次性提示

  polls: 0,
  pollTimer: null,
};

/** DOM 引用（bindDom 时赋值）。 */
const D = {
  app: null, bossZone: null, boss: null, bossAvatar: null, bossFace: null, bossMood: null,
  bossChips: null, bossStackFill: null, bossBet: null, bossDealer: null,
  bossHole: null, bossHandname: null, bossAct: null,
  bubble: null, bubbleText: null, bubbleCaret: null, fragFlash: null,
  hudHand: null, hudTocall: null, hudEff: null, hudBlind: null, hudBlindNext: null,
  hudMode: null, hudMood: null, stateHint: null,
  streetBadge: null, board: null, pot: null, potValue: null,
  playerZone: null, playerHole: null, playerHandname: null, playerDealer: null,
  playerChips: null, playerStackFill: null, playerBet: null, playerTocall: null,
  handPill: null, history: null, fragPill: null, fragments: null,
  crackPill: null, cracks: null, battlelog: null,
  abStatus: null, abStatusText: null,
  btnFold: null, btnCallcheck: null, callcheckLabel: null,
  btnPressure: null, pressureTo: null, btnHeavy: null, heavyTo: null,
  btnAllin: null, allinLabel: null,
  raiseBox: null, raiseSlider: null, raiseAmt: null,
  raiseLabelTop: null, raiseBtnLabel: null, btnRaise: null,
  mentalHint: null, btnRead: null, readRing: null, readCd: null,
  btnGotcha: null, gotchaConfirm: null,
  btnGuessBluff: null, btnGuessStrong: null, btnGuessCancel: null,
  end: null, endCard: null, endHeart: null, endKicker: null, endTitle: null, endSub: null, btnAgain: null,
  guide: null, guideStep: null, guidePages: null, guideDots: null,
  guidePrev: null, guideSkip: null, guideNext: null, btnGuide: null,
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

const modeOf = (view) => {
  const m = str(view?.mode, 'NORMAL');
  return MODES.has(m) ? m : 'NORMAL';
};

/* ====================================================== 信息栏：行构造 */

function historyNode(h) {
  const isBoss = h.actor === 1 || h.actor === 'boss';
  return el('div', { class: 'hrow' }, [
    el('span', { class: 'hrow__hand num', text: `#${h.handNo ?? '—'}` }),
    el('span', { class: 'hrow__street', text: STREET_LABEL[h.street] ?? str(h.street) }),
    el('span', { class: `hrow__who ${isBoss ? 'is-boss' : 'is-me'}`, text: isBoss ? 'Boss' : '你' }),
    el('span', { class: 'hrow__act', text: ACTION_LABEL[h.action] ?? str(h.action, '—') }),
    Number(h.amount) > 0 ? el('span', { class: 'hrow__amt num', text: fmt(h.amount) }) : null,
  ]);
}

/** READ Fragments 面板行：纯文本（类型/标签绝不下发，也不展示）。 */
function fragmentNode(f) {
  return el('div', { class: 'frow', text: str(f?.text, '……') || '……' });
}

/** Battle Log 行（feed 中 read/crack 有自己的面板，其余全部进这里）。 */
function logNode(item) {
  const kind = str(item?.kind, 'system');
  return el('div', { class: `irow irow--${kind}` }, [
    el('span', { class: 'irow__kind', text: FEED_LABEL[kind] ?? kind }),
    el('span', { text: str(item?.text) }),
  ]);
}

/** CRACK Feedback 面板行：kind + 证据标签胶囊 + strength 点数 + gotcha 结果。 */
function crackNode(c) {
  const kind = str(c?.kind, 'WEAKNESS');
  const strength = clamp(Math.round(Number(c?.strength) || 0), 0, 9);
  const result = c?.result ?? c?.used ?? S.crackResults[c?.id] ?? null;
  const kids = [
    el('span', { class: `crow__kind crow__kind--${kind}`, text: CRACK_KIND_LABEL[kind] ?? kind }),
    el('span', {
      class: 'crow__str',
      title: `证据强度 ${strength}`,
      text: `${'●'.repeat(strength)}${'○'.repeat(Math.max(0, 4 - strength))}`,
    }),
    c?.critical ? el('span', { class: 'crow__crit', text: 'CRITICAL' }) : null,
    c?.handNo != null ? el('span', { class: 'crow__hand num', text: `#${c.handNo}` }) : null,
  ];
  const evid = el('div', { class: 'crow__evs' },
    arr(c?.evidence).map((tag) => el('span', {
      class: 'crow__ev',
      text: EVIDENCE_LABEL[tag] ?? (typeof tag === 'string' ? tag : '…'),
    })));
  const resNode = result
    ? el('div', { class: `crow__res ${result.correct ? 'is-right' : 'is-wrong'}` },
      [`GOTCHA ${GUESS_LABEL[result.guess] ?? result.guess} → ${result.correct ? '判断正确' : '判断失误'}`])
    : null;
  return el('div', {
    class: 'crow',
    dataset: { id: String(c?.id ?? '') },
  }, [el('div', { class: 'crow__head' }, kids), evid, resNode]);
}

function appendCapped(host, node) {
  if (!host || !node) return;
  const atBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 48;
  host.appendChild(node);
  while (host.children.length > FEED_CAP) host.firstChild.remove();
  if (atBottom) host.scrollTop = host.scrollHeight;
}

/** 最新在上的列表：头部插入。 */
function prependCapped(host, node) {
  if (!host || !node) return;
  host.insertBefore(node, host.firstChild);
  while (host.children.length > FEED_CAP) host.lastChild.remove();
  host.scrollTop = 0;
}

function fillFeed(host, nodes) {
  if (!host) return;
  const atBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 48;
  const prevScroll = host.scrollTop;
  clear(host);
  for (const n of nodes) host.appendChild(n);
  host.scrollTop = atBottom || nodes.length < 2 ? host.scrollHeight : prevScroll;
}

/** 最新在上的列表整体重绘（用户翻看旧内容时保留位置，否则钉在顶部）。 */
function fillTop(host, nodes) {
  if (!host) return;
  const keepScroll = host.scrollTop > 48;
  const prevScroll = host.scrollTop;
  clear(host);
  for (const n of nodes) host.appendChild(n);
  host.scrollTop = keepScroll ? prevScroll : 0;
}

function updateFragPill() {
  if (!D.fragPill) return;
  D.fragPill.textContent = `${D.fragments?.children.length ?? 0} 条`;
}

function updateCrackPill(view) {
  if (!D.crackPill) return;
  const armed = Boolean(view?.gotcha);
  const n = arr(view?.cracks).length;
  D.crackPill.textContent = armed ? 'GOTCHA 可发动 ⚡' : n > 0 ? `${n} 条链` : '未解锁';
  D.crackPill.classList.toggle('is-on', armed);
}

/* ================================================= READ 碎片闪现（不阻塞队列） */

function showFragmentFlash(text, flashMs, exec) {
  const host = D.fragFlash;
  if (!host || !text) return;
  const node = el('div', { class: `fragflash__line${exec ? ' is-exec' : ''}`, text });
  host.appendChild(node);
  while (host.children.length > 3) host.firstChild.remove();
  // flashMs 后自行淡出移除 —— 与事件队列完全解耦
  setTimeout(() => {
    node.classList.add('is-out');
    setTimeout(() => node.remove(), 460);
  }, flashMs);
}

/* ============================================================== 渲染 */

function render(view) {
  if (!view || typeof view !== 'object') return;
  S.view = view;

  // 播放语境与权威快照对齐（供下一轮事件播放期间的 live 更新使用）
  S.playHand = Number(view.handNo) || S.playHand;
  S.playStreet = str(view.street, S.playStreet);
  S.liveBet = {
    0: Math.round(Number(view.player?.bet) || 0),
    1: Math.round(Number(view.boss?.bet) || 0),
  };

  for (const step of [
    renderBoss, renderBoard, renderHud, renderPlayer, renderStacks,
    renderSidebar, renderActionbar, renderPhase,
  ]) {
    try {
      step(view);
    } catch (err) {
      console.warn(`[渲染] ${step.name} 失败`, err);
    }
  }
  try {
    maybeContextHints();
  } catch {
    /* 提示失败不影响渲染 */
  }
}

function handOf(seat) {
  const hands = arr(S.showdown?.hands);
  return hands.find((h) => h?.seat === seat) ?? null;
}

function holeSpecs(hole, seat) {
  const sh = handOf(seat);
  return arr(hole).map((card) => ({
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
  const stateName = str(boss.state, 'CALM');
  if (STATE_LABEL[stateName]) D.bossZone.dataset.state = stateName;

  D.bossFace.textContent = str(boss.face, STATE_FACE[stateName] ?? '😏');
  D.bossMood.textContent = str(boss.mood, STATE_LABEL[stateName] ?? stateName);
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

  // 台词气泡：无打字进行时才整体替换（打字机由事件驱动）
  const line = str(boss.lastLine);
  if ((D.bubbleText.dataset.line ?? '') !== line) {
    cancelTypewrite(D.bubbleText);
    D.bubbleText.textContent = line;
    D.bubbleText.dataset.line = line;
    D.bubbleCaret.classList.remove('is-on');
  }

  const hole = boss.hole;
  if (arr(hole).length > 0) {
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

/** 牌桌上方窄 HUD：牌型 / Call Cost / Effective Stack / 盲注 / 模式 / 三状态情绪。 */
function renderHud(view) {
  const p = view.player ?? {};
  const boss = view.boss ?? {};
  const playing = view.phase === 'playing';

  D.hudHand.textContent = str(p.handName) || '—';

  const toCall = Math.round(Number(p.toCall) || 0);
  if (playing) {
    D.hudTocall.textContent = toCall > 0
      ? `跟 ${fmt(toCall)}`
      : p.legal?.check === true ? '可过牌' : '—';
  } else {
    D.hudTocall.textContent = '—';
  }

  const effFallback = Math.min(Math.round(Number(p.chips) || 0), Math.round(Number(boss.chips) || 0));
  const eff = Number(view.effectiveStack);
  D.hudEff.textContent = fmt(Number.isFinite(eff) ? eff : effFallback);

  const blind = (view.blind && typeof view.blind === 'object') ? view.blind : {};
  D.hudBlind.textContent = Number(blind.sb) > 0 && Number(blind.bb) > 0
    ? `${fmt(blind.sb)}/${fmt(blind.bb)}`
    : '—';
  const nextUp = str(blind.nextUp);
  D.hudBlindNext.textContent = nextUp || '—';
  D.hudBlindNext.title = str(blind.tier);
  D.hudBlind.title = str(blind.tier);

  const mode = modeOf(view);
  D.hudMode.dataset.mode = mode;
  D.hudMode.textContent = MODE_LABEL[mode];
  D.hudMode.title = `${MODE_LABEL[mode]} · ${MODE_HINT[mode]}`;
  D.app.dataset.mode = mode;

  const stateName = str(boss.state, 'CALM');
  for (const cell of D.hudMood.children) {
    cell.classList.toggle('is-active', cell.dataset.state === stateName);
  }
  const hint = str(boss.stateHint, '…');
  D.stateHint.textContent = hint || '…';
  D.stateHint.title = hint;

  D.streetBadge.textContent = STREET_LABEL[view.street] ?? str(view.street, '—');
  D.streetBadge.dataset.street = str(view.street);
  D.potValue.textContent = fmt(view.pot ?? 0);
  D.playerDealer.hidden = view.button !== 0;
  D.bossDealer.hidden = view.button !== 1;

  D.bossZone.classList.toggle('is-turn', playing && view.toAct === 1);
  D.playerZone.classList.toggle('is-turn', playing && view.toAct === 0);
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

/* --------------------------------------------------------- 筹码堆（§27） */

/** 本局筹码总量：chips + pot 恒定，作为筹码条分母（只增不减，防御服务端异常）。 */
function chipsRef() {
  const v = S.view;
  if (v) {
    const sum = (Math.round(Number(v.player?.chips) || 0)
      + Math.round(Number(v.boss?.chips) || 0)
      + Math.round(Number(v.pot) || 0));
    if (sum > S.chipsRef) S.chipsRef = sum;
  }
  return Math.max(1, S.chipsRef);
}

function setStackFill(seat, chips) {
  const fill = seat === 1 ? D.bossStackFill : D.playerStackFill;
  if (!fill) return;
  const pct = clamp((Math.max(0, Math.round(Number(chips) || 0)) / chipsRef()) * 100, 0, 100);
  fill.style.width = `${pct.toFixed(2)}%`;
}

function renderStacks(view) {
  setStackFill(1, view.boss?.chips);
  setStackFill(0, view.player?.chips);
}

/* ------------------------------------------------------------- 右侧四分区 */

function renderSidebar(view) {
  D.handPill.textContent = `第 ${view.handNo ?? '—'} 手`;

  // 1) Action History（时间顺序，底部对齐）
  fillFeed(D.history, arr(view.history)
    .filter((h) => h && typeof h === 'object')
    .map(historyNode));

  // 2) READ Fragments（纯文本，最新在上）
  const frags = arr(view.readFragments).filter((f) => f && typeof f === 'object');
  fillTop(D.fragments, frags.map(fragmentNode));
  updateFragPill();

  // 3) CRACK Feedback（证据链 + gotcha 结果；最新在上，与 live 插入一致）
  const cracks = arr(view.cracks).filter((c) => c && typeof c === 'object');
  S.crackEntries = {};
  for (const c of cracks) if (c.id != null) S.crackEntries[c.id] = c;
  fillTop(D.cracks, [...cracks].reverse().map(crackNode));
  updateCrackPill(view);

  // 4) Battle Log（read/crack 有自己的面板 → 过滤掉）
  const logItems = arr(view.feed)
    .filter((item) => item && typeof item === 'object')
    .filter((item) => item.kind !== 'read' && item.kind !== 'crack');
  fillFeed(D.battlelog, logItems.map(logNode));
}

/* ------------------------------------------------------------- 行动栏 */

function syncReadCooldown(view) {
  const until = Math.round(Number(view?.player?.readCooldownUntil) || 0);
  const now = Date.now();
  if (until > now) {
    if (until > S.readUntil) {
      // 新一轮冷却：重置转圈窗口
      S.readUntil = until;
      S.readWindowMs = Math.max(300, until - now);
    }
    if (S.readTimer === null) {
      tickReadCd();
      S.readTimer = setInterval(tickReadCd, READ_TICK_MS);
    }
  } else if (S.readTimer !== null) {
    stopReadCd();
    paintReadCd(0, true);
  } else {
    paintReadCd(0, true);
  }
}

function stopReadCd() {
  if (S.readTimer !== null) {
    clearInterval(S.readTimer);
    S.readTimer = null;
  }
  S.readUntil = 0;
  S.readWindowMs = 0;
}

function tickReadCd() {
  const remain = S.readUntil - Date.now();
  if (remain <= 0) {
    stopReadCd();
    paintReadCd(0, true);
    // 冷却结束 → 恢复按钮（若此刻空闲）
    try {
      if (S.view) renderActionbar(S.view);
    } catch { /* 忽略 */ }
    return;
  }
  paintReadCd(remain, false);
}

function paintReadCd(remain, ready) {
  const frac = ready || S.readWindowMs <= 0 ? 1 : clamp(remain / S.readWindowMs, 0, 1);
  if (D.readRing) D.readRing.style.setProperty('--cd', `${(frac * 360).toFixed(1)}deg`);
  if (D.readCd) D.readCd.textContent = ready ? 'READY' : `${Math.ceil(remain / 100) / 10}s`;
  if (D.btnRead) D.btnRead.classList.toggle('is-ready', ready);
}

function renderActionbar(view) {
  const busy = isBusy();
  const playing = view.phase === 'playing';
  const myTurn = playing && view.toAct === 0 && !busy;
  const legal = (view.player && typeof view.player.legal === 'object' && view.player.legal)
    ? view.player.legal
    : {};
  const mode = modeOf(view);

  // FOLD | CALL/CHECK | PRESSURE | HEAVY | ALL IN
  D.btnFold.disabled = !(myTurn && legal.fold === true);

  const callAmt = Math.round(Number(legal.call) || 0);
  if (legal.check === true && callAmt <= 0) {
    D.callcheckLabel.textContent = '过牌';
    D.btnCallcheck.disabled = !myTurn;
  } else if (callAmt > 0) {
    D.callcheckLabel.textContent = `跟注 ${fmt(callAmt)}`;
    D.btnCallcheck.disabled = !myTurn;
  } else {
    D.callcheckLabel.textContent = '过牌';
    D.btnCallcheck.disabled = true;
  }

  const pressureTo = Math.round(Number(legal.pressureTo) || 0);
  D.pressureTo.textContent = pressureTo > 0 ? fmt(pressureTo) : '—';
  D.btnPressure.disabled = !(myTurn && legal.pressure === true);

  const heavyTo = Math.round(Number(legal.heavyTo) || 0);
  D.heavyTo.textContent = heavyTo > 0 ? fmt(heavyTo) : '—';
  D.btnHeavy.disabled = !(myTurn && legal.heavy === true);

  const allinAmt = Math.round(Number(legal.allin) || 0);
  D.allinLabel.textContent = allinAmt > 0 ? `全下 ${fmt(allinAmt)}` : '全下';
  D.btnAllin.disabled = !(myTurn && allinAmt > 0);

  // EXECUTION 专属自由滑杆：mode 门禁 + legal.bet/raise 双保险
  D.raiseBox.hidden = mode !== 'EXECUTION';
  const minTo = Math.round(Number(legal.minTo) || 0);
  const maxTo = Math.round(Number(legal.maxTo) || 0);
  const canRaise = mode === 'EXECUTION'
    && myTurn
    && (legal.bet === true || legal.raise === true)
    && maxTo > 0;
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

  // READ：冷却转圈按 readCooldownUntil
  const now = Date.now();
  const cdUntil = Math.round(Number(view.player?.readCooldownUntil) || 0);
  const cooling = cdUntil > now;
  D.btnRead.disabled = !(playing && !busy && !cooling);
  syncReadCooldown(view);

  // GOTCHA!：仅 view.gotcha 非空可用（确认条竞态：快照里已无 gotcha 即收起）
  const armed = Boolean(view.gotcha);
  if (S.gotchaOpen && !armed) closeGotchaConfirm();
  D.btnGotcha.disabled = !(playing && !busy && armed && !S.gotchaPosting);
  D.btnGotcha.classList.toggle('is-armed', armed);

  updateMentalHint(view);

  const [text, status] = statusFor(view, busy);
  setStatus(text, status);
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

/** 特殊操作区的情境提示行。 */
function updateMentalHint(view) {
  if (!D.mentalHint) return;
  let text;
  const mode = modeOf(view);
  if (view.gotcha) text = 'CRACK 成立 —— 押注你的判断：他是在诈，还是真有货？';
  else if (mode === 'EXECUTION') text = 'EXECUTION：自由下注尺寸开放 · READ 高速连发';
  else if (mode === 'COUNTER') text = 'COUNTER：他正在反扑 —— 大注比平时更真';
  else text = 'READ 攒碎片 → 串成证据链 CRACK → GOTCHA 押注判断';
  if (D.mentalHint.textContent !== text) D.mentalHint.textContent = text;
}

function renderPhase(view) {
  const ended = view.phase === 'victory' || view.phase === 'defeat';
  if (ended && !S.endShown) showEnd(view, { withHeart: Boolean(S.heart) });
  else if (!ended && S.endShown) hideEnd();
}

/* ========================================================= 请求与事件队列 */

function applyResponse(resp) {
  if (resp && resp.view && typeof resp.view === 'object') {
    S.view = clone(resp.view); // 深拷贝：播放期间绝不与响应对象共享引用
    // 「再来一局」：权威快照已回到 playing → 先收掉结局遮罩，
    // 否则 hand_start 的横幅/弹字会被 z-index 更高的结局层盖住
    if (S.view.phase === 'playing' && S.endShown) hideEnd();
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
 * - finally 之后必渲染 + 解锁 —— 异常路径也不会卡死行动栏与 GOTCHA 确认条；
 * - 播放中新增的事件会在下一轮 while 判断被取走。
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
    // 队列异常路径的兜底：确认条若还开着但 gotcha 已不存在，收起
    try {
      if (S.gotchaOpen && !S.view?.gotcha) closeGotchaConfirm();
    } catch { /* 忽略 */ }
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
  if (!D.btnFold) return;
  const lock = isBusy();
  const playing = S.view ? S.view.phase === 'playing' : true;
  const [text, mode] = statusFor(S.view, isBusy());
  setStatus(text, mode);

  if (lock || !playing) {
    D.btnFold.disabled = true;
    D.btnCallcheck.disabled = true;
    D.btnPressure.disabled = true;
    D.btnHeavy.disabled = true;
    D.btnAllin.disabled = true;
    D.btnRaise.disabled = true;
    D.raiseBox.classList.toggle('is-locked', true);
    D.btnRead.disabled = true;
    D.btnGotcha.disabled = true;
    D.btnGuessBluff.disabled = true;
    D.btnGuessStrong.disabled = true;
  } else {
    D.btnGuessBluff.disabled = false;
    D.btnGuessStrong.disabled = false;
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

/** 三状态情绪横幅（v3 单向恶化：CALM → SHAKEN → TILT）。 */
function showMental(from, to, causeName, hint = null, down = null) {
  const fromT = STATE_LABEL[from] ?? String(from ?? '');
  const toT = STATE_LABEL[to] ?? String(to ?? '');
  const isDown = down === null || down === undefined ? true : Boolean(down);

  if (to && STATE_LABEL[to]) D.bossZone.dataset.state = to;
  const finalBoss = S.view?.boss;
  if (finalBoss && finalBoss.state === to) {
    D.bossFace.textContent = str(finalBoss.face, STATE_FACE[to] ?? '😏');
    D.bossMood.textContent = str(finalBoss.mood, toT);
  } else {
    D.bossFace.textContent = STATE_FACE[to] ?? D.bossFace.textContent;
    D.bossMood.textContent = toT;
  }

  if (isDown) sfx.mental();
  else sfx.notify();

  appendCapped(D.battlelog, logNode({
    kind: 'mental',
    text: `${isDown ? '▼' : '▲'} ${fromT} → ${toT}${causeName ? ` · ${causeName}` : ''}${hint ? ` · ${hint}` : ''}`,
  }));
  return fx.mentalBanner(fromT, toT, hint || causeName || '', { recover: !isDown });
}

async function typeBossLine(line) {
  if (!line) return;
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
    S.crackEntries = {};
    S.crackResults = {};
    closeGotchaConfirm();
    boardRow.render([]);
    setHandname(D.playerHandname, 0);
    setHandname(D.bossHandname, 1);
    fx.tableZoom(false);
    setBetFlag(D.playerBet, 0);
    setBetFlag(D.bossBet, 0);
    clear(D.cracks);
    updateCrackPill(S.view);

    if (ev.blindUp === true) {
      sfx.blindup();
      appendCapped(D.battlelog, logNode({
        kind: 'blind',
        text: `盲注升级 ${ev.sb ?? '?'}/${ev.bb ?? '?'}${str(ev.tier) ? ` · ${ev.tier}` : ''}`,
      }));
      await fx.banner({
        text: `BLIND UP ${ev.sb ?? '?'}/${ev.bb ?? '?'}`,
        sub: str(ev.tier) || '盲注升级',
        cls: 'fx-banner--blind',
        holdMs: 1500,
      });
      await fx.sleep(120);
    } else {
      sfx.notify();
      await fx.sleep(520);
    }
    fx.popup(D.streetBadge, `第 ${ev.handNo ?? ''} 手`, 'hit');
  },

  async blinds(ev) {
    const seat = ev.seat === 1 ? 1 : 0;
    const amount = Math.max(0, Math.round(Number(ev.amount) || 0));
    S.liveBet[seat] = (S.liveBet[seat] || 0) + amount;
    if (amount > 0) {
      const chipsEl = seat === 1 ? D.bossChips : D.playerChips;
      const from = parseNum(chipsEl.textContent);
      const to = Math.max(0, from - amount);
      fx.animateNumber(chipsEl, from, to, 340);
      setStackFill(seat, to);
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
    if (isBoss) await fx.sleep(700 + Math.random() * 500); // 思考停顿 0.7–1.2s

    const put = Math.max(0, Math.round(Number(ev.put) || 0));
    const seat = isBoss ? 1 : 0;
    const chipsEl = isBoss ? D.bossChips : D.playerChips;
    if (put > 0) {
      const from = parseNum(chipsEl.textContent);
      const to = Math.max(0, from - put);
      fx.animateNumber(chipsEl, from, to, 420); // 输家筹码倒数
      setStackFill(seat, to);
      S.liveBet[seat] = (S.liveBet[seat] || 0) + put;
      sfx.chip();
    }
    setBetFlag(isBoss ? D.bossBet : D.playerBet, S.liveBet[seat]);

    if (ev.potAfter != null) {
      D.potValue.textContent = fmt(ev.potAfter);
      fx.animate(D.pot, [{ transform: 'scale(1)' }, { transform: 'scale(1.14)' }, { transform: 'scale(1)' }],
        { duration: 340, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
    }

    const label = ACTION_LABEL[ev.action] ?? ev.action ?? '—';
    appendCapped(D.history, historyNode({
      handNo: S.playHand,
      street: S.playStreet,
      actor: isBoss ? 1 : 0,
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
      case 'raise':
      case 'pressure':
      case 'heavy': sfx.raise(); break;
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
    const cards = arr(ev.cards).filter((c) => typeof c === 'string');
    const street = str(ev.street);
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
    const line = str(ev.line);
    appendCapped(D.battlelog, logNode({ kind: 'talk', text: line }));
    await typeBossLine(line);
    await fx.sleep(340);
  },

  /**
   * READ 碎片闪现：fire-and-forget —— flashMs 后自行淡出，
   * 这里只同步追加面板并让出极短一拍，绝不阻塞队列。
   */
  async read_fragment(ev) {
    const text = str(ev.text);
    const flashMs = clamp(Math.round(Number(ev.flashMs) || 1000), 300, 4000);
    const exec = modeOf(S.view) === 'EXECUTION';
    sfx.fragment();
    showFragmentFlash(text, flashMs, exec);
    if (text) {
      prependCapped(D.fragments, fragmentNode({ text }));
      updateFragPill();
    }
    if (ev.burst === true) fx.popup(D.bossFace, '信息量暴增', 'hit');
    await fx.sleep(90); // 只让出一拍给音效/浮层起步 —— 不等 flashMs
  },

  /** CRACK：白闪 + 震屏 + 大字 + 面板点亮（允许 1.4s 演出停顿）。 */
  async crack(ev) {
    const kind = str(ev.kind, 'WEAKNESS');
    const strength = clamp(Math.round(Number(ev.strength) || 0), 0, 9);
    const entry = {
      id: ev.id,
      kind,
      evidence: arr(ev.evidence),
      strength,
      critical: ev.critical === true,
      handNo: S.playHand,
    };
    if (entry.id != null) S.crackEntries[entry.id] = entry;
    prependCapped(D.cracks, crackNode(entry));
    updateCrackPill(S.view);

    sfx.crack();
    fx.flash();
    fx.screenShake(460, 9);
    await fx.bigText('CRACK!',
      `${CRACK_KIND_LABEL[kind] ?? kind} · ${strength} 重证据${entry.critical ? ' · CRITICAL' : ''}`,
      { tone: entry.critical ? 'red' : 'gold', holdMs: 1400 });
  },

  /**
   * GOTCHA 结果：
   * 正确 → GOTCHA! → Hitstop → 牌桌 zoom → Boss 表情 → EXECUTION 大字；
   * 错误 → GOTCHA! → 停顿 → Boss 反应台词 → COUNTER! 红字 + 红闪。
   */
  async gotcha_result(ev) {
    const id = S.pendingGotchaId;
    S.pendingGotchaId = null;
    const guess = str(ev.guess, '—');
    const correct = ev.correct === true;
    if (id != null) {
      S.crackResults[id] = { guess, correct };
      refreshCrackRow(id); // 已在面板上的那条链补上结果徽章
    }

    appendCapped(D.battlelog, logNode({
      kind: 'gotcha',
      text: `押注 ${GUESS_LABEL[guess] ?? guess} → ${correct ? `判断正确 · ${ev.mode ?? 'EXECUTION'}` : `判断失误 · ${ev.mode ?? 'COUNTER'}`}`,
    }));

    sfx.gotcha();
    await fx.bigText('GOTCHA!', `${GUESS_LABEL[guess] ?? guess} · ${correct ? '你赌对了' : '你赌错了'}`,
      { tone: correct ? 'gold' : 'red', holdMs: 780 });

    if (correct) {
      await fx.hitstop(260);
      fx.tableZoom(true);
      // Boss 表情变化（view 已是终态）
      const boss = S.view?.boss;
      if (boss) {
        D.bossFace.textContent = str(boss.face, STATE_FACE[boss.state] ?? '😏');
        D.bossMood.textContent = str(boss.mood, STATE_LABEL[boss.state] ?? '');
        if (boss.state && STATE_LABEL[boss.state]) D.bossZone.dataset.state = boss.state;
      }
      fx.avatarShake(360, 8);
      sfx.execution();
      await fx.bigText('EXECUTION', '自由下注 · 高速 READ', { tone: 'gold', holdMs: 1300 });
    } else {
      await fx.sleep(300); // 短暂停顿
      const line = str(S.view?.boss?.lastLine);
      if (line && line !== D.bubbleText.dataset.line) await typeBossLine(line);
      else fx.popup(D.bossAvatar, '被他骗过去了', 'crit');
      sfx.counter();
      fx.flash('red');
      fx.screenShake(440, 8);
      await fx.bigText('COUNTER!', '他要反扑了', { tone: 'red', holdMs: 1300 });
    }
  },

  /** 模式切换（EXECUTION / COUNTER / NORMAL 回落）。 */
  async mode(ev) {
    const mode = MODES.has(str(ev.mode)) ? ev.mode : 'NORMAL';
    appendCapped(D.battlelog, logNode({
      kind: 'mode',
      text: `模式 → ${MODE_LABEL[mode]} · ${MODE_HINT[mode]}`,
    }));
    D.hudMode.dataset.mode = mode;
    D.hudMode.textContent = MODE_LABEL[mode];
    D.app.dataset.mode = mode;
    if (mode === 'NORMAL') fx.popup(D.hudMode, '回到 NORMAL', 'miss');
    await fx.sleep(240);
  },

  /** BUSTED!：立绘震动 + 大字 → 随后的 mode 事件切入 COUNTER。 */
  async busted(ev) {
    const line = str(ev.line, '我看穿你了！');
    sfx.busted();
    fx.avatarShake(620, 16);
    fx.screenShake(520, 9);
    appendCapped(D.battlelog, logNode({ kind: 'model', text: line }));
    await fx.bigText('BUSTED!', line, { tone: 'red', holdMs: 1500 });
    await typeBossLine(line);
    await fx.sleep(220);
  },

  async mental(ev) {
    await showMental(ev.from, ev.to, str(ev.causeName) || str(ev.cause), str(ev.hint) || null, ev.down);
  },

  async showdown(ev) {
    const hands = arr(ev.hands);
    S.showdown = { hands, split: Boolean(ev.split) };
    sfx.turn();

    const bossHand = hands.find((h) => h?.seat === 1);
    const bossHole = arr(bossHand?.hole);
    if (bossHole.length) {
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
    const seat = ev.to === 1 ? 1 : 0;
    const target = seat === 1 ? D.bossChips : D.playerChips;
    sfx.chip();
    await fx.flyChip(D.pot, target, fmt(amount));
    const from = parseNum(target.textContent);
    const to = from + amount;
    fx.animateNumber(target, from, to, 480); // 赢家筹码累加
    setStackFill(seat, to);
    D.potValue.textContent = fmt(0);
    await fx.sleep(160);
  },

  /** 结算：筹码堆迁移（数字滚动 + 分段条宽度过渡）≈2s。 */
  async hand_end(ev) {
    fx.tableZoom(false);
    closeGotchaConfirm();
    const winner = ev.winner;
    const pot = Math.max(0, Math.round(Number(ev.pot) || 0));

    const pFrom = parseNum(D.playerChips.textContent);
    const bFrom = parseNum(D.bossChips.textContent);
    const pTo = Math.round(Number(ev.stacks?.player ?? pFrom));
    const bTo = Math.round(Number(ev.stacks?.boss ?? bFrom));
    fx.animateNumber(D.playerChips, pFrom, pTo, 620);
    fx.animateNumber(D.bossChips, bFrom, bTo, 620);
    setStackFill(0, pTo);
    setStackFill(1, bTo);

    const who = winner === 0 ? '你' : winner === 1 ? '对手' : '双方';
    const text = winner == null
      ? `底池 ${fmt(pot)}`
      : `${who}${ev.split ? '平分' : '赢得'}底池 ${fmt(pot)}`;
    const cls = winner === 0 ? 'fx-banner--win' : winner === 1 ? 'fx-banner--lose' : '';

    appendCapped(D.battlelog, logNode({
      kind: 'hand',
      text: `第 ${ev.handNo ?? S.playHand} 手 · 底池 ${fmt(pot)} → ${winner == null ? '平分'
        : `${who}${ev.split ? '平分' : `赢得 ${fmt(pot)}`}`}${ev.mode && ev.mode !== 'NORMAL' ? ` · 模式 ${ev.mode}` : ''}`,
    }));

    if (winner === 0) sfx.win();
    else if (winner === 1) sfx.lose();
    else sfx.notify();

    // 结算横幅 ≈2.2s（筹码堆迁移），之后才轮到队列里的下一手 hand_start
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

/** 把 gotcha 结果徽章补进已在面板上的那条链。 */
function refreshCrackRow(id) {
  if (!D.cracks || id == null) return;
  const node = D.cracks.querySelector(`[data-id="${CSS.escape(String(id))}"]`);
  const entry = S.crackEntries[id];
  if (!node || !entry) return;
  const fresh = crackNode(entry);
  node.replaceWith(fresh);
}

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

/** 引导看过之后的一次性情境提示：首手先 READ；首次 CRACK 提醒 GOTCHA。 */
function maybeContextHints() {
  if (!S.guideClosedOnce || S.guideOpen) return;
  const v = S.view;
  if (!v || v.phase !== 'playing' || isBusy()) return;

  if (!S.hintReadDone && !S.hintGotchaShown && Number(v.handNo) <= 1 && v.toAct === 0) {
    S.hintReadDone = true;
    setTimeout(() => {
      if (!S.guideOpen) fx.toast('提示：先按 READ 偷看他的碎片，攒出 CRACK 才有 GOTCHA', 'info');
    }, 700);
    return;
  }
  if (!S.hintGotchaShown && v.gotcha) {
    S.hintGotchaShown = true;
    S.hintReadDone = true;
    setTimeout(() => {
      if (!S.guideOpen) fx.toast('证据链成立 —— 按 GOTCHA! 押注你的判断', 'info');
    }, 500);
  }
}

/* ============================================================ 新手引导 */

const GUIDE_KEY = 'allin.guide.v3'; // v3 大改 → 重新弹一次

function guideSeen() {
  try {
    return localStorage.getItem(GUIDE_KEY) === '1';
  } catch {
    return false; // 隐私模式拿不到 localStorage：当作没看过
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
  if (S.polls >= POLL_MAX) return; // 有界轮询：不无限打请求
  S.polls += 1;
  S.pollTimer = setTimeout(async () => {
    S.pollTimer = null;
    if (isBusy()) return;
    await request(() => api.state());
  }, POLL_MS);
}

function clearPoll() {
  if (S.pollTimer !== null) {
    clearTimeout(S.pollTimer);
    S.pollTimer = null;
  }
}

/* ========================================================= GOTCHA 流程 */

function openGotchaConfirm() {
  if (!S.view?.gotcha || isBusy() || S.gotchaPosting) return;
  S.gotchaOpen = true;
  D.gotchaConfirm.hidden = false;
  D.btnGuessBluff.disabled = false;
  D.btnGuessStrong.disabled = false;
  sfx.notify();
}

function closeGotchaConfirm() {
  S.gotchaOpen = false;
  if (D.gotchaConfirm) D.gotchaConfirm.hidden = true;
}

async function fireGotcha(guess) {
  if (!S.gotchaOpen || S.gotchaPosting) return;
  if (isBusy()) return;            // 其它请求在途：避免并发响应覆盖 view 的竞态
  if (!S.view?.gotcha) {           // 快照已过期（链被清空）→ 收起确认条
    closeGotchaConfirm();
    return;
  }
  unlockAudio();
  S.polls = 0;
  clearPoll();

  S.gotchaPosting = true;
  S.pendingGotchaId = S.view.gotcha.id ?? null;
  closeGotchaConfirm();
  D.btnGuessBluff.disabled = true;
  D.btnGuessStrong.disabled = true;
  D.btnGotcha.disabled = true;

  const resp = await request(() => api.gotcha(guess));

  S.gotchaPosting = false;
  D.btnGuessBluff.disabled = false;
  D.btnGuessStrong.disabled = false;
  if (!resp) S.pendingGotchaId = null; // 失败：不把结果挂到错误的链上
  // 解锁交给 pump → render → renderActionbar（按最新 view.gotcha 恢复）
}

/* ================================================================ 交互 */

async function doAction(action, amount) {
  unlockAudio();
  S.polls = 0;
  clearPoll();
  closeGotchaConfirm(); // 已经做出扑克回答 —— 确认条收起
  const resp = await request(() => api.action(action, amount));
  if (resp) S.raiseTouched = false; // 新的一轮回到默认档位
  return resp;
}

function bindActions() {
  D.btnFold.addEventListener('click', () => doAction('fold'));
  D.btnCallcheck.addEventListener('click', () => {
    const legal = S.view?.player?.legal ?? {};
    const callAmt = Math.round(Number(legal.call) || 0);
    if (legal.check === true && callAmt <= 0) doAction('check');
    else if (callAmt > 0) doAction('call');
  });
  D.btnPressure.addEventListener('click', () => doAction('pressure'));
  D.btnHeavy.addEventListener('click', () => doAction('heavy'));
  D.btnAllin.addEventListener('click', () => doAction('allin'));
  D.btnRaise.addEventListener('click', () => {
    const toCall = Math.round(Number(S.view?.player?.toCall) || 0);
    // mode 门禁的最后一道保险
    if (modeOf(S.view) !== 'EXECUTION') return;
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
      if (!v || modeOf(v) !== 'EXECUTION') return;
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
    clearPoll();
    closeGotchaConfirm();
    await request(() => api.read());
  });

  D.btnGotcha.addEventListener('click', () => {
    unlockAudio();
    if (S.gotchaOpen) closeGotchaConfirm();
    else openGotchaConfirm();
  });
  D.btnGuessBluff.addEventListener('click', () => fireGotcha('BLUFF'));
  D.btnGuessStrong.addEventListener('click', () => fireGotcha('STRONG'));
  D.btnGuessCancel.addEventListener('click', () => closeGotchaConfirm());

  D.btnAgain.addEventListener('click', async () => {
    unlockAudio();
    S.polls = 0;
    clearPoll();
    closeGotchaConfirm();
    S.chipsRef = 0; // 新一局：筹码堆分母重新观测
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
    if (e.key === 'Escape') {
      if (S.guideOpen) closeGuide();
      else if (S.gotchaOpen) closeGotchaConfirm();
      return;
    }
    if (S.guideOpen) return; // 引导打开时屏蔽快捷键
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (!S.view || S.view.phase !== 'playing' || isBusy()) return;

    const key = e.key.toLowerCase();
    if (key === 'f') {
      if (!D.btnFold.disabled) D.btnFold.click();
    } else if (key === 'c') {
      if (!D.btnCallcheck.disabled) D.btnCallcheck.click();
    } else if (key === 'p') {
      if (!D.btnPressure.disabled) D.btnPressure.click();
    } else if (key === 'h') {
      if (!D.btnHeavy.disabled) D.btnHeavy.click();
    } else if (key === 'a') {
      if (!D.btnAllin.disabled) D.btnAllin.click();
    } else if (key === 'r') {
      if (!D.btnRead.disabled) D.btnRead.click();
    } else if (key === 'g') {
      if (!D.btnGotcha.disabled) {
        e.preventDefault();
        if (S.gotchaOpen) closeGotchaConfirm();
        else openGotchaConfirm();
      }
    } else if (e.key === 'Enter') {
      if (!D.btnRaise.disabled && !D.raiseBox.hidden) {
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
  D.bossStackFill = $('#boss-stack-fill');
  D.bossBet = $('#boss-bet');
  D.bossDealer = $('#boss-dealer');
  D.bossHole = $('#boss-hole');
  D.bossHandname = $('#boss-handname');
  D.bossAct = $('#boss-act');
  D.bubble = $('#boss-bubble');
  D.bubbleText = $('#bubble-text');
  D.bubbleCaret = $('#bubble-caret');
  D.fragFlash = $('#frag-flash');

  D.hudHand = $('#hud-hand');
  D.hudTocall = $('#hud-tocall');
  D.hudEff = $('#hud-eff');
  D.hudBlind = $('#hud-blind');
  D.hudBlindNext = $('#hud-blind-next');
  D.hudMode = $('#hud-mode');
  D.hudMood = $('#hud-mood');
  D.stateHint = $('#state-hint');

  D.streetBadge = $('#street-badge');
  D.board = $('#board');
  D.pot = $('#pot');
  D.potValue = $('#pot-value');

  D.playerZone = $('#player-zone');
  D.playerHole = $('#player-hole');
  D.playerHandname = $('#player-handname');
  D.playerDealer = $('#player-dealer');
  D.playerChips = $('#player-chips');
  D.playerStackFill = $('#player-stack-fill');
  D.playerBet = $('#player-bet');
  D.playerTocall = $('#player-tocall');

  D.handPill = $('#hand-pill');
  D.history = $('#history');
  D.fragPill = $('#frag-pill');
  D.fragments = $('#fragments');
  D.crackPill = $('#crack-pill');
  D.cracks = $('#cracks');
  D.battlelog = $('#battlelog');

  D.abStatus = $('#ab-status');
  D.abStatusText = $('#ab-status-text');
  D.btnFold = $('#btn-fold');
  D.btnCallcheck = $('#btn-callcheck');
  D.callcheckLabel = $('#callcheck-label');
  D.btnPressure = $('#btn-pressure');
  D.pressureTo = $('#pressure-to');
  D.btnHeavy = $('#btn-heavy');
  D.heavyTo = $('#heavy-to');
  D.btnAllin = $('#btn-allin');
  D.allinLabel = $('#allin-label');
  D.raiseBox = $('#raise-box');
  D.raiseSlider = $('#raise-slider');
  D.raiseAmt = $('#raise-amt');
  D.raiseLabelTop = $('#raise-label-top');
  D.raiseBtnLabel = $('#raise-btn-label');
  D.btnRaise = $('#btn-raise');

  D.mentalHint = $('#mental-hint');
  D.btnRead = $('#btn-read');
  D.readRing = $('#read-ring');
  D.readCd = $('#read-cd');
  D.btnGotcha = $('#btn-gotcha');
  D.gotchaConfirm = $('#gotcha-confirm');
  D.btnGuessBluff = $('#btn-guess-bluff');
  D.btnGuessStrong = $('#btn-guess-strong');
  D.btnGuessCancel = $('#btn-guess-cancel');

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

  paintReadCd(0, true); // READ 冷却环初始态
}

async function boot(retries = 4) {
  setStatus('连接中…', 'wait');
  try {
    const resp = await api.state();
    if (!resp?.view || typeof resp.view !== 'object') throw new Error('服务端返回了空状态');
    S.view = clone(resp.view);
    S.chipsRef = 0;
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
