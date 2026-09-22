/**
 * 战斗编排：牌桌（Duel）× Boss 心理层 × 玩家的心理操作。
 *
 * 职责：
 *   1. 驱动每一手牌（盲注 → 行动循环 → 结算 → 立即下一手）
 *   2. Boss 每次行动后选台词、检测矛盾、开异议窗口
 *   3. READ / 挑衅 / 质疑 / 施压 的门禁、次数、效果
 *   4. 心理事件 → 状态转移 → 台词池/行为参数变化
 *   5. 产出 view（玩家视角）+ events（按顺序播放的动画队列）
 *
 * 安全边界：view 里永远没有 Boss 底牌（摊牌事件除外）、deck、intent、
 * 矛盾判定结果。异议窗口只给 id/deadline/line，真假由服务端点击时判定。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Duel, GameError } from './engine/duel.js';
import { Boss } from './boss/boss.js';
import { sizeLevel, claimMatches, FINAL_HEART, DEFEAT_LINE, pickWinQuip } from './boss/talk.js';
import { MOODS, isDownEvent } from './boss/mental.js';
import { makeDeck, shuffle } from './engine/cards.js';

export const PLAYER = 0;
export const BOSS = 1;

const HERE = dirname(fileURLToPath(import.meta.url));
export const BALANCE_PATH = join(HERE, 'balance.json');

/** 读取全部可调数值（每次调用都重新读盘，改配置不用重启）。 */
export function loadBalance(path = BALANCE_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const SPEECH_LABELS = { taunt: '挑衅', challenge: '质疑', pressure: '施压' };
const STREET_ORDER = ['preflop', 'flop', 'turn', 'river'];

function emptyLegal() {
  return { check: false, call: null, fold: false, bet: false, raise: false, minTo: 0, maxTo: 0, allin: 0 };
}

function mapLegal(list) {
  const out = emptyLegal();
  for (const o of list) {
    if (o.type === 'check') out.check = true;
    else if (o.type === 'call') out.call = o.amount;
    else if (o.type === 'fold') out.fold = true;
    else if (o.type === 'bet') { out.bet = true; out.minTo = o.minTo; out.maxTo = o.maxTo; }
    else if (o.type === 'raise') { out.raise = true; out.minTo = o.minTo; out.maxTo = o.maxTo; }
    else if (o.type === 'allin') out.allin = o.to;
  }
  return out;
}

export class Battle {
  constructor({ balance = loadBalance(), rng = Math.random, now = () => Date.now() } = {}) {
    this.balance = balance;
    this.rng = rng;
    this.now = now;
    this.duel = new Duel({
      stacks: [balance.stacks.player, balance.stacks.boss],
      smallBlind: balance.blinds.small,
      bigBlind: balance.blinds.big,
    });
    this.boss = new Boss({ balance, rng });
    this._freshFields();
    this.#feed('system', `战斗开始 · ${balance.personality.name}（欺骗型）· 双方 ${balance.stacks.player} 筹码`);
    this.#beginHand([]);
  }

  // ------------------------------------------------------------ 手牌级状态

  _freshFields() {
    this.phase = 'playing'; // playing | victory | defeat
    this.handNo = 0;
    this.history = [];
    this.feed = [];
    this.reads = [];
    this.readsLeft = 0;
    this.speechLeft = { taunt: 0, challenge: 0, pressure: 0 };
    this.readUsedHand = false;
    this.exposeHand = false;
    this.readStreak = 0;
    this.streetAgg = {}; // Boss 本手逐街的攻防倾向
    this.handAggressiveIntents = []; // Boss 本手的攻击性行动 {action, intent}
    this.playerAggressive = false; // 玩家本手是否主动下过注
    this.openWindow = null; // 破绽窗口 {id, deadline, line, windowMs}
    this.lastBossAction = null;
    this.lastLine = null;
    this.lastPlayerAction = null;
    this.firstHandDone = false;
    this.bossStreak = 0; // Boss 连胜手数（爬正向轴用）
    this.recentHands = []; // 最近几手 Boss 的筹码净流向（势头）
  }

  #feed(kind, text) {
    this.feed.push({ kind, text });
    if (this.feed.length > 100) this.feed.shift();
  }

  /** 势头：最近几手 Boss 的净筹码流向（正=顺风）。 */
  momentum() {
    return this.recentHands.reduce((sum, n) => sum + n, 0);
  }

  /** 当前状态对某个心理事件的抗性（0..1，乘在转移概率上）。 */
  #armor(name) {
    const armor = this.boss.stateDef?.armor;
    const v = armor?.[name];
    return Number.isFinite(v) ? v : 1;
  }

  /** 心理事件统一出口：转移成功 → 事件（带行为提示与方向）+ feed。 */
  #fire(events, name) {
    const t = this.boss.mentalEvent(name, this.#armor(name));
    if (!t) return null;
    events.push({
      type: 'mental',
      from: t.from,
      to: t.to,
      cause: name,
      causeName: t.causeName,
      hint: t.hint,
      down: isDownEvent(t.from, t.to),
    });
    const arrow = isDownEvent(t.from, t.to) ? '▼' : '▲';
    this.#feed('mental', `${arrow} ${MOODS[t.from]} → ${MOODS[t.to]} · ${t.causeName}`);
    return t;
  }

  /** 给玩家看的「倾向贴纸」：言语 Buff 还在生效的可见提示。 */
  #effects() {
    const out = [];
    for (const b of this.boss.buffs) {
      if (b.skill === 'taunt' && !out.some((e) => e.kind === 'taunt')) {
        out.push({ kind: 'taunt', icon: '🔥', label: '被激怒', desc: '他更想加注、注更大' });
      } else if (b.skill === 'pressure' && !out.some((e) => e.kind === 'pressure')) {
        out.push({ kind: 'pressure', icon: '⛓', label: '被压制', desc: '他更想退缩' });
      }
    }
    return out;
  }

  #recordHistory(actor, normalized, street) {
    this.history.push({
      handNo: this.duel.handNo,
      street,
      actor, // 'player' | 'boss'
      action: normalized.type,
      amount: normalized.to ?? 0,
    });
    if (this.history.length > 60) this.history.shift();
  }

  // ------------------------------------------------------------ 开一手

  #beginHand(events) {
    this.handNo += 1;
    this.duel.handNo = this.handNo;
    this.boss.resetHand();
    this.streetAgg = {};
    this.handAggressiveIntents = [];
    this.playerAggressive = false;
    this.readUsedHand = false;
    this.exposeHand = false;
    this.lastBossAction = null;
    this.lastLine = null;
    this.readsLeft = this.balance.read.perHand;
    this.speechLeft = { ...this.balance.speech.perHand };

    const button = this.firstHandDone ? 1 - this.duel.button : (this.rng() < 0.5 ? 0 : 1);
    this.firstHandDone = true;

    events.push({ type: 'hand_start', handNo: this.handNo, button });
    // 牌堆也走注入的 rng —— 整场战斗完全可复现（测试的关键）
    const deck = shuffle(makeDeck(), { next: this.rng });
    const blinds = this.duel.startHand({ button, deck });
    events.push(...blinds);
    this.#drive(events);
  }

  // ------------------------------------------------------------ Boss 驱动

  #drive(events) {
    let guard = 0;
    while (this.duel.phase === 'playing' && this.duel.toAct === BOSS && guard++ < 80) {
      const d = this.duel;
      const preStreet = d.street;
      const potBefore = d.pot;

      const decision = this.boss.decide({
        hole: d.hole[BOSS],
        board: d.board,
        street: preStreet,
        potBefore,
        toCall: d.currentBet - d.committed[BOSS],
        myCommitted: d.committed[BOSS],
        myStack: d.stacks[BOSS],
        legal: d.legal(BOSS),
        bigBlind: d.bigBlind,
        playerAllIn: Boolean(this.lastPlayerAction?.allIn && this.lastPlayerAction.street === preStreet),
      });

      const { normalized, events: engineEvents } = d.act(BOSS, {
        action: decision.action,
        amount: decision.amount,
      });
      events.push(...engineEvents);
      this.#recordHistory('boss', normalized, preStreet);
      this.lastBossAction = { action: normalized.type, amount: normalized.to ?? 0, street: preStreet };

      this.boss.noteAction({ action: normalized.type, intent: decision.intent, street: preStreet });
      if (normalized.put > 0) {
        this.streetAgg[preStreet] = 'active';
        this.handAggressiveIntents.push({ action: normalized.type, intent: decision.intent, street: preStreet });
      } else if (!this.streetAgg[preStreet]) {
        this.streetAgg[preStreet] = 'passive';
      }

      this.#talkAndDetect({
        events,
        action: normalized,
        intent: decision.intent,
        potBefore,
        street: preStreet,
      });

      if (d.phase !== 'playing') {
        this.#onHandEnd(events);
        break;
      }
    }
  }

  /** 台词 → 矛盾检测 → 异议窗口。 */
  #talkAndDetect({ events, action, intent, potBefore, street }) {
    const talk = this.boss.talkFor({
      action: action.type,
      intent,
      potBefore,
      put: action.put,
      street,
    });
    if (talk) {
      this.lastLine = talk.text;
      events.push({ type: 'talk', line: talk.text });
      this.#feed('talk', talk.text);
    }

    const put = action.put ?? 0;
    // 矛盾只对真正的攻击动作成立：跟注/溜入不算「下注」
    const isAggressive = action.type === 'bet' || action.type === 'raise' || action.type === 'allin';
    if (!isAggressive || !(put > 0) || !talk) return;

    const conf = this.balance.contradiction;
    const level = sizeLevel(potBefore, put, conf.sizeLevels);
    const ratio = put / Math.max(1, potBefore);
    let kind = null;

    if (!claimMatches(talk.claim, level)) {
      kind = 'spoken_vs_bet';
    } else if (
      (street === 'turn' || street === 'river')
      && this.#allPriorPassive(street)
      && ratio >= conf.behaviorOverbet
    ) {
      kind = 'behavior';
    }
    if (!kind) return;

    const item = this.boss.addContradiction({
      kind,
      handNo: this.duel.handNo,
      detail: { claim: talk.claim, level, ratio, street, line: talk.text },
    });
    const windowMs = conf.windowBaseMs + conf.windowPerCharMs * talk.text.length;
    // deadline 含客户端播放排队时间（思考停顿 + 打字机），点击校验另有 grace
    const deadline = this.now() + windowMs + 3200;
    this.openWindow = { id: item.id, deadline, line: talk.text, windowMs };

    events.push({ type: 'contradiction', id: item.id, kind });
    events.push({ type: 'objection_open', id: item.id, deadline, line: talk.text, windowMs });
    this.#feed(
      'contradiction',
      kind === 'spoken_vs_bet'
        ? '破绽出现：他的话和注码对不上 —— 抓住它！'
        : '破绽出现：他的打法前后矛盾 —— 抓住它！',
    );
  }

  /** 本街之前，Boss 是否每一街都在示弱（前后矛盾的前半句）。 */
  #allPriorPassive(street) {
    const idx = STREET_ORDER.indexOf(street);
    if (idx <= 0) return false;
    for (let i = 0; i < idx; i++) {
      const s = STREET_ORDER[i];
      if (this.streetAgg[s] !== 'passive') return false;
    }
    return true;
  }

  // ------------------------------------------------------------ 手牌结算

  #onHandEnd(events) {
    const d = this.duel;
    const r = d.result;
    if (!r) return;
    const pot = r.pot;
    const winner = r.winner;

    // 底池飞向赢家
    if (winner === 'split') {
      events.push({ type: 'pot_move', to: PLAYER, amount: Math.floor(pot / 2) });
      events.push({ type: 'pot_move', to: BOSS, amount: pot - Math.floor(pot / 2) });
    } else {
      events.push({ type: 'pot_move', to: winner, amount: pot });
    }

    const bossWon = winner === BOSS;
    const bossLost = winner === PLAYER;
    const isSplit = winner === 'split';
    const bossFolded = r.type === 'fold' && r.winner === PLAYER;
    const bluffCaught = r.type === 'showdown' && bossLost
      && this.handAggressiveIntents.some((a) => a.intent === 'BLUFF');
    const playerBluffSuccess = bossFolded && this.playerAggressive;
    const startStack = this.balance.stacks.boss;
    const bigPot = pot >= this.balance.bigPotLostRatio * startStack;
    const allInLost = bossLost && (d.allIn[BOSS] || this.handAggressiveIntents.some((a) => a.action === 'allin' && d.stacks[BOSS] === 0));
    const allInWon = bossWon && (d.allIn[PLAYER] || d.allIn[BOSS]);

    // 连胜与势头：正向轴（得意/神了）的入口材料
    if (!isSplit) {
      this.bossStreak = bossWon ? this.bossStreak + 1 : 0;
      this.recentHands.push(bossWon ? pot : -pot);
      while (this.recentHands.length > 5) this.recentHands.shift();
    }

    // 本手 READ 是否“应验”：读了 + （抓到诈唬 或 点破矛盾）
    if (this.readUsedHand) {
      const success = bluffCaught || this.exposeHand;
      this.readStreak = success ? this.readStreak + 1 : 0;
    }

    if (bossWon) {
      // —— 赢：回血 / 爬正向轴 ——
      if (allInWon) this.#fire(events, 'ALL_IN_WON');
      else if (bigPot) this.#fire(events, 'BIG_POT_WON');
      if (this.bossStreak === (this.balance.winStreakHands ?? 3)) this.#fire(events, 'WIN_STREAK');
    } else if (bossLost) {
      // —— 输：顺风被打断 + 输钱打击（吃 HOT/FLOW 护甲） ——
      this.#fire(events, 'HAND_LOST');
      if (allInLost) this.#fire(events, 'ALL_IN_LOST');
      else if (bigPot) this.#fire(events, 'BIG_POT_LOST');
      // —— 心理打击：不吃护甲，被看穿永远疼 ——
      if (bluffCaught) this.#fire(events, 'BLUFF_CAUGHT');
      else if (playerBluffSuccess) this.#fire(events, 'PLAYER_BLUFF_SUCCESS');
    }

    if (this.readStreak >= 2) {
      this.#fire(events, 'CONSECUTIVE_READ_SUCCESS');
      this.readStreak = 0;
    }

    // 害怕被认为胆小：弃牌之后，接下来两手会更想打回来
    if (bossFolded && this.playerAggressive) {
      this.boss.buffs.push({ skill: 'shame', decisions: 2 });
    }

    // 赢牌后的得意台词（赌徒赢了不会闭嘴）
    if (bossWon && !isSplit) {
      const quip = pickWinQuip(this.boss.state, this.balance.winQuipChance ?? 0.5, this.rng);
      if (quip) {
        events.push({ type: 'talk', line: quip });
        this.#feed('talk', quip);
      }
    }

    const winnerLabel = winner === 'split' ? '平分底池'
      : winner === PLAYER ? `你赢得 ${pot}`
      : `千面赢得 ${pot}`;
    this.#feed('hand', `第 ${this.handNo} 手 · 底池 ${pot} · ${winnerLabel}`);

    events.push({
      type: 'hand_end',
      handNo: this.handNo,
      winner,
      pot,
      stacks: { player: d.stacks[PLAYER], boss: d.stacks[BOSS] },
      bluffCaught,
    });

    // ------------------------------------------------------------ 终局
    if (d.stacks[BOSS] <= 0) {
      this.phase = 'victory';
      events.push({ type: 'game_over', phase: 'victory', heart: FINAL_HEART });
      this.#feed('system', 'BREAK —— 你击败了千面');
      return;
    }
    if (d.stacks[PLAYER] <= 0) {
      this.phase = 'defeat';
      events.push({ type: 'game_over', phase: 'defeat', heart: DEFEAT_LINE });
      this.#feed('system', '你输掉了全部筹码');
      return;
    }

    // 每手结束后立即开始下一手（演出节奏由客户端掌握）
    this.#beginHand(events);
  }

  // ------------------------------------------------------------ 玩家操作

  #requirePlaying() {
    if (this.phase !== 'playing') throw new GameError('战斗已经结束', 'BATTLE_OVER');
    if (this.duel.phase !== 'playing') throw new GameError('本手已经结束', 'HAND_OVER');
  }

  #requirePlayerTurn() {
    this.#requirePlaying();
    if (this.duel.toAct !== PLAYER) throw new GameError('还没轮到你行动', 'NOT_YOUR_TURN');
  }

  act(action, amount) {
    this.#requirePlayerTurn();
    const events = [];
    const d = this.duel;
    const preStreet = d.street;

    const { normalized, events: engineEvents } = d.act(PLAYER, { action, amount });
    events.push(...engineEvents);
    this.#recordHistory('player', normalized, preStreet);
    if (normalized.put > 0) this.playerAggressive = true;
    const actionEvent = engineEvents.find((e) => e.type === 'action');
    this.lastPlayerAction = { action: normalized.type, allIn: Boolean(actionEvent?.allIn), street: preStreet };

    if (d.phase !== 'playing') {
      this.#onHandEnd(events);
    } else {
      this.#drive(events);
    }
    return { view: this.view(), events };
  }

  /** READ：模糊信息 + 期望方向。每手有限次数。 */
  read() {
    this.#requirePlayerTurn();
    if (this.readsLeft <= 0) throw new GameError('这一手的 READ 已经用完', 'NO_READS');
    const events = [];
    this.readsLeft -= 1;
    this.readUsedHand = true;
    const r = this.boss.read({ street: this.duel.street, momentum: this.momentum() });
    // 最新的在最前（view.reads[0]）
    this.reads.unshift({ text: r.text, lean: r.lean, leanLabel: r.leanLabel });
    if (this.reads.length > 3) this.reads.pop();
    events.push({ type: 'read', text: r.text, lean: r.lean, leanLabel: r.leanLabel });
    this.#feed('read', r.text);
    return { view: this.view(), events };
  }

  /**
   * 言语技能：先改变 Boss 的心理/决策权重，再通过他的牌技结算。
   * 神了(FLOW)免疫全部言语；得意(HOT)效果减半。
   * @param {'taunt'|'challenge'|'pressure'} skill
   */
  speak(skill) {
    this.#requirePlayerTurn();
    if (!SPEECH_LABELS[skill]) throw new GameError('没有这个言语技能', 'BAD_SKILL');
    if ((this.speechLeft[skill] ?? 0) <= 0) throw new GameError('这一手已经用过了', 'NO_CHARGES');
    const events = [];
    this.speechLeft[skill] -= 1;
    const immune = this.boss.speechImmune;

    let result;
    if (skill === 'challenge') {
      const c = this.boss.unresolvedContradiction();
      if (!c) {
        result = 'whiff';
      } else if (immune) {
        // 神了：根本听不进去 —— 矛盾保留，等他凉下来还能追问
        result = 'resist';
        this.#feed('speech', '质疑被无视——他根本听不进去（破绽还留着）');
      } else {
        const t = this.#fire(events, 'LANGUAGE_WEAKNESS_HIT');
        result = t ? 'hit' : 'resist';
        c.resolved = true;
        if (this.openWindow?.id === c.id) this.openWindow = null;
        if (t) {
          this.boss.markExposed();
          this.exposeHand = true;
          this.#feed('objection', '追问命中！他的防线裂开了');
        } else {
          this.#feed('speech', '追问命中了矛盾，但他硬扛住了');
        }
      }
    } else {
      const eff = (this.balance.speechEffects[skill].stateScale?.[this.boss.state] ?? 1)
        * this.boss.speechScale;
      if (eff <= 0) {
        result = 'resist'; // 免疫：不挂 Buff
        this.#feed('speech', `你${SPEECH_LABELS[skill]}了他——他根本没在听`);
      } else {
        result = eff >= 1 ? 'hit' : 'resist';
        this.boss.applySpeechBuff(skill);
        this.#feed('speech', `你${SPEECH_LABELS[skill]}了他——${result === 'hit' ? '他吃到了这一击' : '他表面不为所动'}`);
      }
    }

    const line = this.boss.react(skill, result);
    events.push({ type: 'speech', skill, result, line });
    this.#feed('talk', line);
    return { view: this.view(), events };
  }

  /**
   * 看穿！窗口内点击成功即命中（窗口只在检测到真实矛盾时开启）。
   */
  object(id) {
    const events = [];
    const w = this.openWindow;
    const numId = Number(id);
    const fail = (reason) => {
      // 窗口指向的矛盾已经没了/过期被替换 —— 窗口本身作废，避免客户端死等
      if (reason === 'stale' || reason === 'resolved') this.openWindow = null;
      return { view: this.view(), events, ok: false, reason };
    };

    if (!w || w.id !== numId) return fail('stale');
    const c = this.boss.findContradiction(numId);
    if (!c || c.resolved) return fail('resolved');
    const grace = this.balance.contradiction.graceMs;
    if (this.now() > w.deadline + grace) return fail('late');

    c.resolved = true;
    this.openWindow = null;
    this.boss.markExposed();
    this.exposeHand = true;

    const t = this.#fire(events, 'CONTRADICTION_EXPOSED');
    events.unshift({
      type: 'objection_result',
      id: c.id,
      success: true,
      kind: c.kind,
      transition: t ? { from: t.from, to: t.to } : null,
      hint: t?.hint ?? null,
    });
    this.#feed('objection', t
      ? `看穿了！${MOODS[t.from]} → ${MOODS[t.to]}`
      : '看穿了！他嘴硬了一句，但防线松了');
    return { view: this.view(), events, ok: true };
  }

  /** 重开一场 Boss 战。 */
  newGame() {
    const events = [];
    this.balance = loadBalance(); // 顺便热加载配置
    this.duel = new Duel({
      stacks: [this.balance.stacks.player, this.balance.stacks.boss],
      smallBlind: this.balance.blinds.small,
      bigBlind: this.balance.blinds.big,
    });
    this.boss = new Boss({ balance: this.balance, rng: this.rng });
    this._freshFields();
    this.#feed('system', `战斗重新开始 · ${this.balance.personality.name}`);
    this.#beginHand(events);
    return { view: this.view(), events };
  }

  // ------------------------------------------------------------ 视图

  view() {
    const d = this.duel;
    const playing = this.phase === 'playing' && d.phase === 'playing';
    const playerTurn = playing && d.toAct === PLAYER;
    const win = this.openWindow && this.now() <= this.openWindow.deadline + this.balance.contradiction.graceMs
      ? this.openWindow
      : null;

    return {
      phase: this.phase,
      handNo: d.handNo,
      street: d.street,
      pot: d.pot,
      board: d.board.slice(),
      button: d.button,
      toAct: playing ? d.toAct : null,
      player: {
        chips: d.stacks[PLAYER],
        bet: d.committed[PLAYER],
        hole: d.hole[PLAYER].slice(),
        toCall: Math.max(0, d.currentBet - d.committed[PLAYER]),
        legal: playerTurn ? mapLegal(d.legal(PLAYER)) : emptyLegal(),
        readsLeft: this.readsLeft,
        speech: { ...this.speechLeft },
        // 手里有可追打的破绽（质疑按钮的点亮依据；不泄露任何矛盾细节）
        canChallenge: Boolean(this.boss.unresolvedContradiction()),
      },
      boss: {
        chips: d.stacks[BOSS],
        bet: d.committed[BOSS],
        hole: d.phase === 'handover' && d.result?.type === 'showdown' ? d.hole[BOSS].slice() : null,
        state: this.boss.state,
        face: this.boss.face,
        mood: this.boss.mood,
        stateHint: this.boss.stateHint, // 当前状态的打法含义（横幅/刻度用）
        effects: this.#effects(),       // 言语命中的倾向贴纸
        lastAction: this.lastBossAction, // 含 street：READ 时机高亮的依据
        lastLine: this.lastLine,
      },
      // 破绽窗口（原异议）：只有 id/deadline/line，真假由服务端点击时判定
      objection: win ? { id: win.id, deadline: win.deadline, line: win.line } : null,
      reads: this.reads.slice(),
      history: this.history.slice(),
      feed: this.feed.slice(),
    };
  }
}
