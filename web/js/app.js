/**
 * app.js — 《allin》Boss 战前端主逻辑（v5 · Tell Window 循环）
 *
 * 结构：状态机（S）+ 串行事件队列（pump）+ 全量渲染（render）+ 交互。（沿用 v3/v4 骨架）
 * 契约：docs/PROTOCOL.md（v5）—— 每个 POST 返回 { view, events }；
 * view 是权威快照（播完事件后整体渲染），events 串行按节奏播放，播放期间锁定行动栏。
 *
 * v5 核心循环：Boss 行动 → Tell Window 开启（READ 唯一可用时机）→ READ 消耗 Focus 取一组碎片
 *   → PIN 一条真话进 Known（单槽，仅当前窗口 id 可钉）→ 正确的牌桌行动 →
 *   判定落地：CRACK → Boss 三态推进 CALM/SHAKEN/EXPOSED（你的回应也会被反读 → PLAYER CRACKED）
 *   → Boss EXPOSED × 转/河 × 高承诺行动 = GOTCHA 窗口（资格×时机，不再数 CRACK）
 *   → FOLD / 摊牌统一结算 → 判定胜负 / 下一手（绝不负数进下一手）。
 *
 * 防御性原则：
 * - 任何字段缺失都不崩（tellWindow/focus/focusMax/gotcha/cracks/pin/readFragments/legal 缺失 → 默认值）；
 * - 事件播放单条 try/catch，异常路径最终一定解锁行动栏（pump 的 finally + syncLock）；
 * - tell_window_open 是轻提示（不阻塞队列）；read_batch 成组闪现 fire-and-forget；
 * - 碎片 / PIN 高亮一律以 view 为准整体重渲染 —— 玩家行动后不跨窗口保留任何本地缓存；
 * - render 子步骤逐个 try/catch，一个面板炸了不影响其它面板；
 * - view 响应做 JSON 深拷贝；chips 可为负（负债）→ 筹码堆回缩 0 + 红色欠额。
 */
import { $, el, clear } from './dom.js';
import { CardRow } from './cards.js';
import { api } from './api.js';
import { sfx, unlockAudio } from './sound.js';
import { typewrite, cancelTypewrite } from './typewriter.js';
import * as fx from './effects.js';

/* ================================================================= 常量 */

const STATE_LABEL = { CALM: '冷静', SHAKEN: '动摇', EXPOSED: '暴露' };
const STATE_FACE = { CALM: '😏', SHAKEN: '😳', EXPOSED: '😵' };
const STREET_LABEL = { preflop: '翻牌前', flop: '翻牌圈', turn: '转牌圈', river: '河牌圈' };
const ACTION_LABEL = {
  check: '过牌', call: '跟注', bet: '下注', raise: '加注',
  fold: '弃牌', allin: '全下', pressure: '加压', heavy: '重压',
};
const CRACK_KIND_LABEL = { WEAKNESS: '弱点链', STRENGTH: '强牌链', CRITICAL: '致命破绽' };
const EVIDENCE_LABEL = {
  wants_fold: '想让你弃', fear_call: '怕你跟', fear_raise: '怕你加注', weak_hand: '牌弱',
  strong_hand: '牌强', draw: '在听牌', missed_board: '错过牌面', trap: '在设套',
  call_welcome: '欢迎你跟', board_lock: '牌面锁定', overconfidence: '过度自信',
};
const FEED_LABEL = {
  talk: '台词', read: 'READ', pin: 'PIN', crack: 'CRACK', gotcha: 'GOTCHA', mode: '模式',
  blind: '盲注', hand: '结算', model: '反读', system: '系统', mental: '情绪',
};
const MODE_LABEL = { NORMAL: 'NORMAL', GOTCHA: 'GOTCHA' };
const MODE_HINT = { NORMAL: '正常对抗', GOTCHA: '负债决胜 · 无上限下注' };
/** v5 mental 事件 cause ∈ { CRACK, GOTCHA_HIT }（causeName 缺失时的兜底文案）。 */
const CAUSE_LABEL = {
  CRACK: '被你看穿', GOTCHA_HIT: '被看穿还敢全押',
};
const MODES = new Set(['NORMAL', 'GOTCHA']);
const HIGH_COMMIT = new Set(['bet', 'raise', 'allin']); // GOTCHA 窗口的「高承诺行动」集合

const FEED_CAP = 160;          // 单个列表 DOM 上限（服务端另有 30/60 截断）
const POLL_MS = 1600;
const POLL_MAX = 20;
const READ_TICK_MS = 80;       // READ 冷却转圈刷新间隔
const BATCH_STAGGER_MS = 110;  // 批量碎片逐行错开
const TELL_LIGHT_MS = 150;     // tell_window_open 轻提示只让出这一拍（不阻塞队列）

const fmt = (n) => {
  const v = Math.round(Number(n) || 0);
  return v.toLocaleString('en-US');
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const parseNum = (s) => {
  // 允许负数（负债显示），只吃掉千分位逗号；非数字（—）→ 0
  const n = Number(String(s ?? '').replace(/,/g, ''));
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

  gotchaPosting: false,   // 进入 GOTCHA 的请求在途
  pinPosting: false,      // PIN 请求在途
  pinnedId: null,         // 本窗口当前 PIN 的碎片 id（行高亮用；跨窗口/清空即失效）
  fragWindow: null,       // 本地碎片所属窗口 id（与 view 不一致 → 清 PIN 高亮，以 view 为准）
  tellId: null,           // 当前 Tell Window id（提示动画只在换窗时重播一次）

  crackEntries: {},       // id → 证据链条目（面板行重建用）

  readUntil: 0,           // READ 冷却截止（ms）
  readWindowMs: 0,        // 转圈窗口（= 刚进入冷却时的剩余时长）
  readTimer: null,        // 冷却转圈 interval id

  chipsRef: 0,            // 筹码堆分母：本局筹码总量（chips + pot 恒定，负债下依然成立）

  guideOpen: false,
  guideIndex: 0,
  guideClosedOnce: false,
  hintReadDone: false,    // 「先 READ/PIN」一次性提示
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
  playerMood: null,
  handPill: null, history: null, fragPill: null, fragments: null,
  knownCard: null, knownText: null, knownCheck: null,
  crackPill: null, cracks: null, battlelog: null,
  abStatus: null, abStatusText: null,
  btnFold: null, btnCallcheck: null, callcheckLabel: null,
  btnPressure: null, pressureTo: null, btnHeavy: null, heavyTo: null,
  btnAllin: null, allinLabel: null,
  btnRaise: null, raiseTo: null,
  mentalHint: null, btnRead: null, readRing: null, readCd: null,
  tellToast: null, tellToastText: null,
  btnGotcha: null, gotchaLabel: null,
  end: null, endCard: null, endHeart: null, endKicker: null, endTitle: null, endSub: null, btnAgain: null,
  guide: null, guideStep: null, guidePages: null, guideDots: null,
  guidePrev: null, guideSkip: null, guideNext: null, btnGuide: null, btnNewgame: null,
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

/** 当前 Tell Window（v5：非 null = READ/PIN 的唯一可用时机；缺字段一律回落 null）。 */
const tellWindowOf = (view) => {
  const tw = view?.tellWindow;
  return tw && typeof tw === 'object' ? tw : null;
};

/** Focus（v5 资源，取代旧的每手次数）：focus 缺省 0（翻前/耗尽都不可读），focusMax 缺省 2。 */
function focusOf(view) {
  const p = view?.player;
  const focus = Math.round(Number(p?.focus));
  const max = Math.round(Number(p?.focusMax));
  return {
    focus: Number.isFinite(focus) ? Math.max(0, focus) : 0,
    focusMax: Number.isFinite(max) && max > 0 ? max : 2,
  };
}

/** GOTCHA 窗口（v5 资格×时机）：非 null 即按钮点亮；字段缺失回落 null。 */
function gotchaOf(view) {
  const g = view?.gotcha;
  return g && typeof g === 'object' ? g : null;
}

/**
 * view 缺字段全默认值（防御性规范化，浅层即可 —— 各面板还有各自的 ?? 兜底）。
 * 只补「缺失/类型错误」，不覆盖合法的 null（tellWindow/gotcha/pin 的 null 都是契约值）。
 */
function applyDefaults(view) {
  if (!view || typeof view !== 'object') return view;
  if (!view.player || typeof view.player !== 'object') view.player = {};
  if (!view.boss || typeof view.boss !== 'object') view.boss = {};
  const tw = view.tellWindow;
  if (tw !== undefined && tw !== null && typeof tw !== 'object') view.tellWindow = null;
  if (view.tellWindow === undefined) view.tellWindow = null;
  if (view.gotcha === undefined) view.gotcha = null;
  if (view.pin === undefined) view.pin = null;
  if (!Array.isArray(view.readFragments)) view.readFragments = [];
  if (!Array.isArray(view.cracks)) view.cracks = [];
  if (!Array.isArray(view.feed)) view.feed = [];
  if (!Array.isArray(view.history)) view.history = [];
  return view;
}

/* ============================================ PIN / 碎片行（📌 判定） */

/**
 * 可 PIN：只对「当前 Tell Window 产生的、仍在权威快照里」的碎片开放。
 * 跨窗口残留的旧 id（服务端已清空）在这里天然失效 —— 与 BAD_FRAGMENT 双保险。
 */
function pinnable(f) {
  if (!f || f.id === null || f.id === undefined) return false;
  const view = S.view;
  if (!view || view.phase !== 'playing') return false;
  if (modeOf(view) === 'GOTCHA') return false;
  if (view.toAct !== 0) return false;
  const tw = tellWindowOf(view);
  if (!tw) return false;
  if (f.atHand !== null && f.atHand !== undefined && Number(f.atHand) !== Number(view.handNo)) return false;
  if (f.tellWindowId !== null && f.tellWindowId !== undefined
    && Number(f.tellWindowId) !== Number(tw.id)) return false;
  const id = String(f.id);
  return arr(view.readFragments).some((r) => r && r.id !== null && r.id !== undefined && String(r.id) === id);
}

/** 当前 PIN 的行（优先本窗口内的 id；刷新后回退文本匹配 —— view.pin 只有 text）。 */
function isPinned(f) {
  const pin = S.view?.pin;
  if (!pin || typeof pin.text !== 'string' || !pin.text) return false;
  if (S.pinnedId !== null && f && f.id !== null && f.id !== undefined) return String(S.pinnedId) === String(f.id);
  return Boolean(f && typeof f.text === 'string' && f.text === pin.text);
}

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

/** READ Fragments 面板行：文本 + 可 PIN 的 📌 按钮（类型/标签绝不下发）。 */
function fragmentNode(f) {
  const view = S.view;
  const canPin = pinnable(f);
  const pinned = isPinned(f);
  const verified = pinned && view?.pin?.verified === true;
  const kids = [
    el('span', { class: 'frow__text', text: str(f?.text, '……') || '……' }),
  ];
  if (canPin) {
    kids.push(el('button', {
      class: `frow__pin${pinned ? ' is-on' : ''}`,
      type: 'button',
      title: pinned ? '已 PIN（再点可重新钉）' : 'PIN 进 Known',
      text: pinned && verified ? '📌✓' : '📌',
      on: { click: (e) => { e.stopPropagation(); firePin(f.id); } },
    }));
  }
  return el('div', {
    class: `frow${pinned ? ' is-pinned' : ''}${verified ? ' is-verified' : ''}`,
    dataset: { id: f?.id == null ? '' : String(f.id), text: str(f?.text), at: f?.atHand == null ? '' : String(f.atHand) },
  }, kids);
}

/** Battle Log 行（feed 中 read/crack 有自己的面板 → 过滤掉）。 */
function logNode(item) {
  const kind = str(item?.kind, 'system');
  return el('div', { class: `irow irow--${kind}` }, [
    el('span', { class: 'irow__kind', text: FEED_LABEL[kind] ?? kind }),
    el('span', { text: str(item?.text) }),
  ]);
}

/** CRACK Feedback 面板行：kind + evidence 标签 + 触发行动 + strength 点数。 */
function crackNode(c) {
  const kind = str(c?.kind, 'WEAKNESS');
  const action = str(c?.action);
  const strength = clamp(Math.round(Number(c?.strength) || 0), 0, 9);
  const kids = [
    el('span', { class: `crow__kind crow__kind--${kind}`, text: CRACK_KIND_LABEL[kind] ?? kind }),
    action ? el('span', { class: 'crow__action', text: `× ${action.toUpperCase()}` }) : null,
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
      title: typeof tag === 'string' ? tag : '',
      text: EVIDENCE_LABEL[tag] ?? (typeof tag === 'string' ? tag : '…'),
    })));
  return el('div', {
    class: 'crow',
    dataset: { id: String(c?.id ?? '') },
  }, [el('div', { class: 'crow__head' }, kids), evid]);
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
  const g = gotchaOf(view);
  const n = arr(view?.cracks).length;
  if (g && modeOf(view) === 'NORMAL') {
    // v5：GOTCHA 是「资格×时机」窗口，不再数 CRACK
    D.crackPill.textContent = 'GOTCHA 窗口 ⚡';
    D.crackPill.title = `窗口条件满足：${STREET_LABEL[g.street] ?? str(g.street, '—')}`
      + ` · 他刚${ACTION_LABEL[g.bossAction] ?? str(g.bossAction, '行动')}`;
  } else {
    D.crackPill.textContent = `${n} 条链`;
    D.crackPill.title = 'CRACK 战报（不再用于解锁 GOTCHA）';
  }
  D.crackPill.classList.toggle('is-on', Boolean(g) && modeOf(view) === 'NORMAL');
}

/** Known 📌 卡片（view.pin 只有 text + verified）。 */
function renderPin(view) {
  if (!D.knownCard) return;
  const pin = (view?.pin && typeof view.pin === 'object') ? view.pin : null;
  const text = str(pin?.text);
  D.knownText.textContent = text || '尚未 PIN';
  D.knownCard.classList.toggle('is-empty', !text);
  const verified = Boolean(pin && pin.verified === true);
  D.knownCheck.hidden = !verified;
  D.knownCard.dataset.verified = String(verified);
}

/** READ Fragments 面板整体重绘（PIN / verified 状态按当前快照判定）。 */
function renderFragments(view) {
  const frags = arr(view?.readFragments).filter((f) => f && typeof f === 'object');
  fillTop(D.fragments, frags.map(fragmentNode));
  updateFragPill();
}

/* ====================================== READ 批量闪现（fire-and-forget） */

function showFragmentBatch(frags, flashMs, source, depth) {
  const host = D.fragFlash;
  if (!host || !frags.length) return;
  const leak = source === 'gotcha';
  frags.forEach((f, i) => {
    const canPin = pinnable(f);
    const line = el('div', {
      class: `fragflash__line${leak ? ' is-leak' : ''}`,
      style: { '--i': String(i) },
    }, [
      leak && depth > 0 ? el('i', { class: 'fragflash__depth', text: `d${depth}` }) : null,
      el('span', { class: 'fragflash__text', text: str(f?.text, '……') || '……' }),
      canPin ? el('button', {
        class: 'fragflash__pin',
        type: 'button',
        title: 'PIN 进 Known',
        text: '📌',
        on: { click: (e) => { e.stopPropagation(); firePin(f.id); } },
      }) : null,
    ]);
    host.appendChild(line);
    const life = flashMs + i * BATCH_STAGGER_MS;
    setTimeout(() => {
      line.classList.add('is-out');
      setTimeout(() => line.remove(), 480);
    }, life);
  });
  while (host.children.length > 9) host.firstChild.remove();
}

/* ============================================================== 渲染 */

function render(view) {
  if (!view || typeof view !== 'object') return;
  applyDefaults(view);          // view 缺字段全默认值（null 是契约值，保留）
  S.view = view;

  // 播放语境与权威快照对齐（供下一轮事件播放期间的 live 更新使用）
  S.playHand = Number(view.handNo) || S.playHand;
  S.playStreet = str(view.street, S.playStreet);
  S.liveBet = {
    0: Math.round(Number(view.player?.bet) || 0),
    1: Math.round(Number(view.boss?.bet) || 0),
  };

  // 碎片/PIN 本地状态以 view 为准：换窗口即清高亮 id（不再跨窗口保留任何本地缓存）
  syncFragmentWindow(view);

  for (const step of [
    renderBoss, renderBoard, renderHud, renderPlayer, renderStacks,
    renderSidebar, renderActionbar, renderPhase, syncTellToast,
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

/** 碎片面板本地高亮与权威快照同步：窗口 id 变了 / 碎片被清空 → 丢弃本地 PIN id。 */
function syncFragmentWindow(view) {
  const frags = arr(view.readFragments).filter((f) => f && typeof f === 'object');
  const tw = tellWindowOf(view);
  let cur = tw && tw.id !== null && tw.id !== undefined ? String(tw.id) : null;
  if (frags.length && frags[0].tellWindowId !== null && frags[0].tellWindowId !== undefined) {
    cur = String(frags[0].tellWindowId);
  }
  if (S.fragWindow !== cur) {
    S.fragWindow = cur;
    S.pinnedId = null;         // 旧窗口的 PIN 高亮不留
  }
  if (!frags.length && !view.pin) S.pinnedId = null;
}

/**
 * Tell Window 轻提示（READ 可用时机的唯一提示）：
 * 开窗 = 浮出「🧠 心理窗口 · 他刚 X」，玩家行动后随 view.tellWindow === null 即灭。
 * 纯展示，不阻塞事件队列。
 */
function syncTellToast(view) {
  if (!D.tellToast) return;
  const playing = view.phase === 'playing';
  const tw = playing && view.toAct === 0 ? tellWindowOf(view) : null;
  if (!tw) {
    D.tellToast.hidden = true;
    D.tellToast.classList.remove('is-new');
    S.tellId = null;
    return;
  }
  const label = ACTION_LABEL[tw.bossAction] ?? (tw.bossAction ? String(tw.bossAction) : '行动');
  const text = `🧠 心理窗口 · 他刚${label}`;
  if (D.tellToastText.textContent !== text) D.tellToastText.textContent = text;
  D.tellToast.hidden = false;
  D.tellToast.title = `${STREET_LABEL[tw.street] ?? str(tw.street, '')} · READ 只在此窗口内可用`;
  const id = tw.id === null || tw.id === undefined ? `#${text}` : String(tw.id);
  if (S.tellId !== id) {
    S.tellId = id;
    D.tellToast.classList.remove('is-new');
    void D.tellToast.offsetWidth;   // 强制 reflow：换窗口才重播入场动画
    D.tellToast.classList.add('is-new');
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
  D.hudEff.textContent = fmt(Number.isFinite(eff) ? eff : Math.max(0, effFallback));

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

  // v5 玩家心理状态格（view.player.state / face / mood，双方对称展示）
  const stateName = STATE_LABEL[p.state] ? str(p.state) : 'CALM';
  D.playerZone.dataset.state = stateName;
  if (D.playerMood) {
    const moodText = `${str(p.face, STATE_FACE[stateName] ?? '😏')} ${str(p.mood, STATE_LABEL[stateName] ?? '')}`;
    if (D.playerMood.textContent !== moodText) D.playerMood.textContent = moodText;
    D.playerMood.dataset.state = stateName;
    D.playerMood.title = `你的心理状态：${STATE_LABEL[stateName] ?? stateName}`
      + '（被反读 / 被看穿时推进，暂不影响判定）';
  }

  playerRow.render(holeSpecs(p.hole, 0));
  setHandname(D.playerHandname, 0);
}

/* --------------------------------------------------------- 筹码堆（§27） */

/** 本局筹码总量：chips + pot 恒定（负债下依然成立），作为筹码条分母。 */
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
  const value = Math.round(Number(chips) || 0);
  const pct = clamp((Math.max(0, value) / chipsRef()) * 100, 0, 100);
  fill.style.width = `${pct.toFixed(2)}%`;
  // 负债：条回缩到 0，数字变红
  const num = seat === 1 ? D.bossChips : D.playerChips;
  if (num) num.classList.toggle('is-debt', value < 0);
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

  // 2) Known 卡 + READ Fragments（纯文本，最新在上，带 PIN 按钮）
  renderPin(view);
  renderFragments(view);

  // 3) CRACK Feedback（evidence × action 证据链）
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

/** 只负责冷却环与 READY 态（次数文本由 renderActionbar 写）。 */
function paintReadCd(remain, ready) {
  const frac = ready || S.readWindowMs <= 0 ? 1 : clamp(remain / S.readWindowMs, 0, 1);
  if (D.readRing) D.readRing.style.setProperty('--cd', `${(frac * 360).toFixed(1)}deg`);
  if (D.btnRead) D.btnRead.classList.toggle('is-ready', ready);
}

function renderActionbar(view) {
  const busy = isBusy();
  const playing = view.phase === 'playing';
  const myTurn = playing && view.toAct === 0 && !busy;
  const legal = (view.player && typeof view.player.legal === 'object' && view.player.legal)
    ? view.player.legal
    : {};
  const inG = modeOf(view) === 'GOTCHA';

  /* ---- 模式可见性：负债阶段只留 FOLD / CALL-CHECK / RAISE ---- */
  D.btnPressure.hidden = inG;
  D.btnHeavy.hidden = inG;
  D.btnAllin.hidden = inG;
  D.btnRaise.hidden = !inG;

  /* ---- FOLD | CALL/CHECK ---- */
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

  /* ---- NORMAL：PRESSURE / HEAVY / ALL IN ---- */
  const pressureTo = Math.round(Number(legal.pressureTo) || 0);
  D.pressureTo.textContent = pressureTo > 0 ? fmt(pressureTo) : '—';
  D.btnPressure.disabled = inG || !(myTurn && legal.pressure === true);

  const heavyTo = Math.round(Number(legal.heavyTo) || 0);
  D.heavyTo.textContent = heavyTo > 0 ? fmt(heavyTo) : '—';
  D.btnHeavy.disabled = inG || !(myTurn && legal.heavy === true);

  const allinAmt = Math.round(Number(legal.allin) || 0);
  D.allinLabel.textContent = allinAmt > 0 ? `全下 ${fmt(allinAmt)}` : '全下';
  D.btnAllin.disabled = inG || !(myTurn && allinAmt > 0);

  /* ---- GOTCHA：阶梯 RAISE（金额全在服务端，无任何数字输入） ---- */
  const rawRaiseTo = legal.gotchaRaiseTo;
  const raiseTo = Math.round(Number(rawRaiseTo) || 0);
  D.raiseTo.textContent = inG && raiseTo > 0 ? fmt(raiseTo) : '—';
  const raiseOk = inG && myTurn && raiseTo > 0
    && rawRaiseTo !== null && rawRaiseTo !== undefined
    && (legal.raise === true || legal.raise === null || legal.raise === undefined);
  D.btnRaise.disabled = !raiseOk;

  /* ---- READ：Tell Window 门禁 + FOCUS 资源 + 冷却环 ---- */
  const tw = tellWindowOf(view);
  const inWindow = Boolean(tw) && view.toAct === 0;
  const { focus, focusMax } = focusOf(view);
  const now = Date.now();
  const cdUntil = Math.round(Number(view.player?.readCooldownUntil) || 0);
  const cooling = cdUntil > now;
  const exhausted = focus <= 0;
  D.readCd.textContent = inG ? '—' : `FOCUS ${focus}/${focusMax}`;
  D.btnRead.classList.toggle('is-empty', !inG && (exhausted || !inWindow));
  D.btnRead.classList.toggle('is-cd', !inG && !exhausted && inWindow && cooling);
  // 双门禁：窗口存在（READ 唯一时机）+ Focus 充足 + 冷却结束 + 非负债 + 空闲
  D.btnRead.disabled = !(playing && myTurn && !inG && inWindow && !exhausted && !cooling && !busy);
  D.btnRead.title = inG
    ? '负债阶段 READ 禁用 —— 情报只从心理泄漏里来'
    : !playing ? '对局结束'
      : !inWindow ? 'READ 只在他刚行动后的心理窗口内开放（等你回应的一瞬）'
        : exhausted ? `FOCUS 耗尽（${focus}/${focusMax}）—— 翻前不开放、进街 +1、上限 2`
          : cooling ? 'READ 冷却中…' : `窗口开启 · 他刚${tw.bossAction ? (ACTION_LABEL[tw.bossAction] ?? tw.bossAction) : '行动'} —— 消耗 1 FOCUS`;
  syncReadCooldown(view);

  /* ---- GOTCHA!：资格×时机窗口点亮 → 玩家回合发动（与 mode 双门禁） ---- */
  const g = gotchaOf(view);
  const armed = Boolean(g) && !inG;
  D.gotchaLabel.textContent = inG ? 'IN PROGRESS' : 'GOTCHA!';
  D.btnGotcha.classList.toggle('is-armed', armed);
  D.btnGotcha.classList.toggle('is-progress', inG);
  D.btnGotcha.disabled = !(playing && !busy && !S.gotchaPosting && !inG && armed && myTurn);
  D.btnGotcha.title = inG
    ? '负债决胜进行中'
    : armed
      ? `窗口条件满足：${STREET_LABEL[g.street] ?? str(g.street, '—')} · 他刚${ACTION_LABEL[g.bossAction] ?? str(g.bossAction, '行动')} —— 按钮点亮`
      : `需要 Boss EXPOSED + 转/河 + 他刚在本街做过 ${[...HIGH_COMMIT].join('/')} + 轮到你`;

  updateMentalHint(view);

  const [text, status] = statusFor(view, busy);
  setStatus(text, status);
}

/** 特殊操作区的情境提示行（v5：窗口 / Focus / GOTCHA 窗口条件）。 */
function updateMentalHint(view) {
  if (!D.mentalHint) return;
  let text;
  const inG = modeOf(view) === 'GOTCHA';
  const g = gotchaOf(view);
  const tw = tellWindowOf(view);
  const { focus, focusMax } = focusOf(view);
  if (inG) text = 'GOTCHA：FOLD / CALL / RAISE 阶梯 —— 每次加注风险翻倍';
  else if (g) {
    text = `窗口亮起：他 EXPOSED 刚${ACTION_LABEL[g.bossAction] ?? str(g.bossAction, '行动')}`
      + `（${STREET_LABEL[g.street] ?? str(g.street, '—')}）—— 按 GOTCHA! 发动`;
  } else if (view.phase !== 'playing') text = '对局结束 —— 点「再来一局」重新挑战';
  else if (tw) text = focus > 0
    ? `心理窗口开启 · READ ${focus}/${focusMax} —— PIN 真话 → 用对行动验证 → CRACK 推进状态`
    : `窗口开着但 FOCUS ${focus}/${focusMax} —— 只能靠已 PIN 的情报回应`;
  else text = 'READ 只在他刚行动后的心理窗口内开放 —— 先回应牌局，等窗口浮出';
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
    S.view = applyDefaults(clone(resp.view)); // 深拷贝 + 缺字段默认值：播放期间绝不与响应对象共享引用
    // 「再来一局」：权威快照已回到 playing → 先收掉结局遮罩，
    // 否则 hand_start 的横幅/弹字会被 z-index 更高的结局层盖住
    if (S.view.phase === 'playing' && S.endShown) hideEnd();
    // 碎片/PIN/窗口以 view 为准「落地即同步」：玩家行动一回来就清空面板与窗口提示，
    // 不等事件播完（本地绝不存在能活过下一个窗口的缓存）
    try {
      syncFragmentWindow(S.view);
      renderFragments(S.view);
      renderPin(S.view);
      if (!tellWindowOf(S.view)) syncTellToast(S.view); // 关窗立刻收提示；开窗留给事件按节奏浮出
    } catch (err) {
      console.warn('[同步] 响应快照面板同步失败', err);
    }
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
    D.btnRead.disabled = true;
    D.btnGotcha.disabled = true;
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

/**
 * Boss 心理状态横幅（v5 三态：CALM → SHAKEN → EXPOSED，只有向右推进）。
 * 色板由「目标状态」决定（causeName/hint 只做副标）；`down` 字段已废弃但容忍。
 */
function showMental(from, to, causeName, hint = null) {
  const fromT = STATE_LABEL[from] ?? String(from ?? '');
  const toT = STATE_LABEL[to] ?? String(to ?? '');

  if (STATE_LABEL[to]) D.bossZone.dataset.state = to;
  const finalBoss = S.view?.boss;
  if (finalBoss && finalBoss.state === to) {
    D.bossFace.textContent = str(finalBoss.face, STATE_FACE[to] ?? '😏');
    D.bossMood.textContent = str(finalBoss.mood, toT);
  } else {
    D.bossFace.textContent = STATE_FACE[to] ?? D.bossFace.textContent;
    D.bossMood.textContent = toT;
  }

  sfx.mental();

  appendCapped(D.battlelog, logNode({
    kind: 'mental',
    text: `${fromT} → ${toT}${causeName ? ` · ${causeName}` : ''}${hint ? ` · ${hint}` : ''}`,
  }));
  return fx.mentalBanner(fromT, toT, hint || causeName || '', { tone: to });
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
    S.pinnedId = null;          // PIN 槽按窗口/手牌重置
    S.fragWindow = null;
    S.tellId = null;
    boardRow.render([]);
    setHandname(D.playerHandname, 0);
    setHandname(D.bossHandname, 1);
    fx.tableZoom(false);
    setBetFlag(D.playerBet, 0);
    setBetFlag(D.bossBet, 0);
    clear(D.cracks);
    updateCrackPill(S.view);
    renderPin({ pin: null });   // 新一手：Known 卡清空（S.view 里的 pin 也应为 null）
    renderFragments(S.view);    // 重建行：清掉上一手的 PIN 高亮
    syncTellToast(S.view ?? {}); // 新一手没有窗口 → 提示即灭（以 view 为准）

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
      const to = from - put; // 负债阶段允许为负
      fx.animateNumber(chipsEl, from, to, 420);
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
    // 全下演出（NORMAL 语义；负债阶段不产生 all-in）
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
   * READ 批量碎片（manual：绑 tellWindowId/actionId，仅当前窗口有效；
   * gotcha：负债阶段心理泄漏 id=null 不可 PIN）——成组 stacked 闪现、逐行错开、
   * flashMs 后自行淡出 —— fire-and-forget，只让出一拍，绝不阻塞事件队列。
   * 面板本身以 view.readFragments 整体重渲染为准：玩家行动后服务端清空即全灭。
   */
  async read_batch(ev) {
    const source = str(ev.source) === 'gotcha' ? 'gotcha' : 'manual';
    const flashMs = clamp(Math.round(Number(ev.flashMs) || 1200), 300, 4000);
    const depth = Math.max(0, Math.round(Number(ev.depth) || 0));
    const frags = arr(ev.fragments).filter((f) => f && typeof f === 'object');

    sfx.fragment();
    showFragmentBatch(frags, flashMs, source, depth);
    // 面板以 view.readFragments 整体重渲染为准（当前窗口批次在最上；与闪现顺序一致）
    try {
      syncFragmentWindow(S.view ?? {});
      renderFragments(S.view ?? {});
    } catch (err) {
      console.warn('[渲染] read_batch 面板同步失败', err);
    }
    if (source === 'gotcha' && depth > 0) fx.popup(D.bossFace, `心理泄漏 d${depth}`, 'crit');
    await fx.sleep(110); // 不等 flashMs —— 队列继续走
  },

  /** CRACK：白闪 + 震屏 + 大字（副标 = evidence × action）+ 面板点亮 + PIN 打勾。 */
  async crack(ev) {
    const kind = str(ev.kind, 'WEAKNESS');
    const evidence = arr(ev.evidence);
    const action = str(ev.action);
    const strength = clamp(Math.round(Number(ev.strength) || 0), 0, 9);
    const entry = {
      id: ev.id,
      kind,
      evidence,
      action,
      strength,
      critical: ev.critical === true,
      handNo: Number(ev.handNo) || S.playHand,
    };
    if (entry.id != null) S.crackEntries[entry.id] = entry;
    prependCapped(D.cracks, crackNode(entry));
    updateCrackPill(S.view);
    renderPin(S.view);       // verified 已在响应快照里 → Known 卡打勾
    markPinnedRow();         // 被 PIN 的行高亮 + ✓

    sfx.crack();
    fx.flash();
    fx.screenShake(460, 9);
    const evLabel = evidence.map((t) => String(t)).join('+');
    const sub = action ? `${evLabel || kind} × ${action.toUpperCase()}` : (CRACK_KIND_LABEL[kind] ?? kind);
    await fx.bigText('CRACK!', sub, { tone: entry.critical ? 'red' : 'gold', holdMs: 1400 });
  },

  /**
   * 进入 GOTCHA：全屏宣告 → 红金警戒边（data-mode="GOTCHA"）→
   * 行动栏切到 FOLD / CALL / RAISE 阶梯。
   */
  async mode(ev) {
    const mode = str(ev.mode) === 'GOTCHA' ? 'GOTCHA' : 'NORMAL';
    appendCapped(D.battlelog, logNode({
      kind: 'mode',
      text: mode === 'GOTCHA' ? '进入 GOTCHA · 负债决胜' : '模式 → NORMAL',
    }));
    D.hudMode.dataset.mode = mode;
    D.hudMode.textContent = MODE_LABEL[mode];
    D.hudMode.title = `${MODE_LABEL[mode]} · ${MODE_HINT[mode]}`;
    D.app.dataset.mode = mode;
    if (mode === 'GOTCHA') {
      sfx.gotcha();
      fx.flash('red');
      fx.screenShake(420, 7);
      await fx.bigText('GOTCHA!', '负债决胜 · 无上限下注', { tone: 'red', holdMs: 1500 });
    } else {
      fx.popup(D.hudMode, '回到 NORMAL', 'miss');
      await fx.sleep(200);
    }
  },

  async mental(ev) {
    // v5：cause ∈ CRACK | GOTCHA_HIT；三态只有向右推进（down 仅展示兼容，忽略）
    const causeName = str(ev.causeName) || CAUSE_LABEL[str(ev.cause)] || str(ev.cause);
    await showMental(ev.from, ev.to, causeName, str(ev.hint) || null);
  },

  /**
   * Tell Window 开启（READ 唯一时机）：轻提示「🧠 心理窗口 · 他刚 X」——
   * 只让出一拍，绝不阻塞队列；窗口关闭一律以 view.tellWindow === null 为准（render 同步）。
   */
  async tell_window_open(ev) {
    syncTellToast(S.view ?? {});
    sfx.tell();
    await fx.sleep(TELL_LIGHT_MS);
    if (ev && ev.id === undefined) console.warn('[事件] tell_window_open 缺少 id 字段', ev);
  },

  /**
   * Boss 反读命中：红色「PLAYER CRACKED」大字 + 0.8–1.2s 停顿 +
   * Battle Log（feed kind "model"）「他在利用你：{why}」—— 让你知道 Boss 也在观察你。
   */
  async player_cracked(ev) {
    const why = str(ev.why, '他也看穿了你的习惯');
    sfx.counter();
    fx.flash('red');
    fx.screenShake(560, 10);
    fx.avatarShake(560, 14);
    appendCapped(D.battlelog, logNode({ kind: 'model', text: `他在利用你：${why}` }));
    fx.popup(D.bossAvatar, 'PLAYER CRACKED', 'crit');
    await fx.bigText('PLAYER CRACKED', `他在利用你：${why}`, {
      tone: 'red',
      holdMs: 1000 + Math.random() * 200,   // 停顿 0.8–1.2s 区间内（含大字时长）
    });
  },

  /** 玩家心理推进（三态对称展示）：HUD 状态格变色 + 日志 + 轻演出。 */
  async player_mental(ev) {
    const from = str(ev.from, 'CALM');
    const to = STATE_LABEL[ev.to] ? str(ev.to) : 'CALM';
    D.playerZone.dataset.state = to;
    const finalP = S.view?.player;
    if (D.playerMood) {
      const face = finalP && finalP.state === to
        ? str(finalP.face, STATE_FACE[to] ?? '😏')
        : (STATE_FACE[to] ?? '😏');
      const mood = finalP && finalP.state === to
        ? str(finalP.mood, STATE_LABEL[to] ?? '')
        : (STATE_LABEL[to] ?? '');
      D.playerMood.textContent = `${face} ${mood}`;
      D.playerMood.dataset.state = to;
    }
    sfx.mental();
    appendCapped(D.battlelog, logNode({
      kind: 'mental',
      text: `你：${STATE_LABEL[from] ?? from} → ${STATE_LABEL[to] ?? to} · 被反读命中`,
    }));
    fx.popup(D.playerMood ?? D.playerZone, STATE_LABEL[to] ?? to, 'crit');
    await fx.sleep(420);
  },

  /** BUSTED!：立绘震动 + 大字（Boss 获得本手攻击增益，但不切换模式）。 */
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
    const amount = Math.round(Number(ev.amount) || 0); // 结算金额（正常恒为正）
    const abs = Math.abs(amount);
    const seat = ev.to === 1 ? 1 : 0;
    const target = seat === 1 ? D.bossChips : D.playerChips;
    sfx.chip();
    await fx.flyChip(D.pot, target, fmt(abs));
    const from = parseNum(target.textContent);
    const to = amount >= 0 ? from + abs : from - abs;
    fx.animateNumber(target, from, to, 480); // 赢家筹码累加（可把负数债务覆盖掉）
    setStackFill(seat, to);
    D.potValue.textContent = fmt(0);
    await fx.sleep(160);
  },

  /** 结算：筹码堆迁移（数字滚动 + 分段条宽度过渡，负数显示红色欠额）≈2s。 */
  async hand_end(ev) {
    fx.tableZoom(false);
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

/** CRACK 后：把 Known 卡的 verified 同步到被 PIN 的面板行。 */
function markPinnedRow() {
  const host = D.fragments;
  const pin = S.view?.pin;
  if (!host || !pin || typeof pin.text !== 'string' || !pin.text) return;
  const verified = pin.verified === true;
  for (const row of host.children) {
    const pinned = (S.pinnedId !== null && row.dataset.id && row.dataset.id === String(S.pinnedId))
      || (row.dataset.text && row.dataset.text === pin.text);
    if (!pinned) continue;
    row.classList.add('is-pinned');
    row.classList.toggle('is-verified', verified);
    const btn = row.querySelector('.frow__pin');
    if (btn) {
      btn.classList.add('is-on');
      btn.textContent = verified ? '📌✓' : '📌';
    }
  }
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

/** 引导看过之后的一次性情境提示：首手先 READ/PIN；首次解锁提醒 GOTCHA。 */
function maybeContextHints() {
  if (!S.guideClosedOnce || S.guideOpen) return;
  const v = S.view;
  if (!v || v.phase !== 'playing' || isBusy()) return;

  if (!S.hintReadDone && !S.hintGotchaShown && Number(v.handNo) <= 1 && v.toAct === 0) {
    S.hintReadDone = true;
    setTimeout(() => {
      if (!S.guideOpen) fx.toast('提示：他行动后会开「心理窗口」—— 窗口内 READ 一组碎片，钉住最像真话的一条', 'info');
    }, 700);
    return;
  }
  if (!S.hintGotchaShown && v.gotcha) {
    S.hintGotchaShown = true;
    S.hintReadDone = true;
    setTimeout(() => {
      if (!S.guideOpen) fx.toast('GOTCHA 窗口亮起 —— 按 GOTCHA! 进入负债决胜', 'info');
    }, 500);
  }
}

/* ============================================================ 新手引导 */

const GUIDE_KEY = 'allin.guide.v5'; // v5 Tell Window 大改 → 重新弹一次

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

/* ========================================================= PIN / GOTCHA */

async function firePin(fragmentId) {
  if (fragmentId === null || fragmentId === undefined) return;
  if (S.pinPosting || isBusy()) return;   // 串行守卫：避免并发响应覆盖 view
  if (!pinnable({ id: fragmentId })) return;
  unlockAudio();
  S.polls = 0;
  clearPoll();

  const prevId = S.pinnedId;
  S.pinPosting = true;
  S.pinnedId = fragmentId;   // 乐观置位：pump 里的 render 就能高亮正确的行
  const resp = await request(() => api.pin(fragmentId));
  S.pinPosting = false;
  if (!resp) S.pinnedId = prevId; // 失败：回滚高亮
}

/** 进入 GOTCHA（无任何二选一，直接 POST {}）。 */
async function enterGotcha() {
  if (S.gotchaPosting) return;
  if (isBusy()) return;                 // 其它请求在途：避免并发响应覆盖 view
  const v = S.view;
  if (!v || v.phase !== 'playing' || v.toAct !== 0) return;
  if (!v.gotcha || modeOf(v) !== 'NORMAL') return;
  unlockAudio();
  S.polls = 0;
  clearPoll();

  S.gotchaPosting = true;
  D.btnGotcha.disabled = true;
  await request(() => api.gotcha());
  S.gotchaPosting = false;
  // 解锁交给 pump → render → renderActionbar（按最新 view.mode 恢复）
}

/* ================================================================ 交互 */

async function doAction(action, amount) {
  unlockAudio();
  S.polls = 0;
  clearPoll();
  return request(() => api.action(action, amount));
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

  // GOTCHA 阶梯 RAISE：金额完全由服务端按阶梯给出（不带 amount）
  D.btnRaise.addEventListener('click', () => {
    if (modeOf(S.view) !== 'GOTCHA') return;
    doAction('raise');
  });

  D.btnRead.addEventListener('click', async () => {
    unlockAudio();
    S.polls = 0;
    clearPoll();
    await request(() => api.read());
  });

  D.btnGotcha.addEventListener('click', () => enterGotcha());

  D.btnAgain.addEventListener('click', async () => {
    unlockAudio();
    S.polls = 0;
    clearPoll();
    S.chipsRef = 0; // 新一局：筹码堆分母重新观测
    await request(() => api.newgame());
  });

  // 对局中随时重开（v5 补：原先只有结局画面有「再来一局」）
  D.btnNewgame.addEventListener('click', async () => {
    if (!window.confirm('重新开始？当前牌局进度会丢弃。')) return;
    unlockAudio();
    S.polls = 0;
    clearPoll();
    S.chipsRef = 0;
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
      if (!D.btnPressure.hidden && !D.btnPressure.disabled) D.btnPressure.click();
    } else if (key === 'h') {
      if (!D.btnHeavy.hidden && !D.btnHeavy.disabled) D.btnHeavy.click();
    } else if (key === 'a') {
      if (!D.btnAllin.hidden && !D.btnAllin.disabled) D.btnAllin.click();
    } else if (key === 'r') {
      if (!D.btnRead.disabled) D.btnRead.click();
    } else if (key === 'g') {
      if (!D.btnGotcha.disabled) {
        e.preventDefault();
        enterGotcha();
      }
    } else if (e.key === 'Enter') {
      if (!D.btnRaise.hidden && !D.btnRaise.disabled) {
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
  D.playerMood = $('#player-mood');

  D.handPill = $('#hand-pill');
  D.history = $('#history');
  D.fragPill = $('#frag-pill');
  D.fragments = $('#fragments');
  D.knownCard = $('#known-card');
  D.knownText = $('#known-text');
  D.knownCheck = $('#known-check');
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
  D.btnRaise = $('#btn-raise');
  D.raiseTo = $('#raise-to');

  D.mentalHint = $('#mental-hint');
  D.btnRead = $('#btn-read');
  D.readRing = $('#read-ring');
  D.readCd = $('#read-cd');
  D.tellToast = $('#tell-toast');
  D.tellToastText = $('#tell-toast-text');
  D.btnGotcha = $('#btn-gotcha');
  D.gotchaLabel = $('#gotcha-label');

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
  D.btnNewgame = $('#btn-newgame');
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
