/**
 * 战斗编排（v3）：不对称筹码 Boss 战。
 *
 * 德州层（Duel）+ Boss 三层决策（ai.js）+ 心理攻防（READ 碎片 → CRACK → GOTCHA →
 * EXECUTION / COUNTER）+ 盲注升级 + Player Model / BUSTED。
 *
 * 核心循环：
 *   打牌 → READ 碎片 → 证据链成 CRACK → GOTCHA 押注 BLUFF/STRONG
 *     ├─ 对 → EXECUTION（自由下注 + 高速 READ）
 *     └─ 错 → COUNTER（Boss 本手攻击暴涨）
 *   → 真实筹码结算 → Effective Stack 成长 → 盲注升级逼向高潮
 *
 * 安全边界：view/events 永远不含 deck、Boss intent、碎片 type/tags、Player Model、
 * 判定中间量。协议见 docs/PROTOCOL.md。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Duel, GameError } from './engine/duel.js';
import { makeDeck, shuffle } from './engine/cards.js';
import { evaluate } from './engine/evaluator.js';
import { Boss } from './boss/boss.js';
import { EvidenceTracker } from './boss/crack.js';
import { makeFragment, flashMs } from './boss/fragments.js';
import { PlayerModel } from './boss/playermodel.js';
import { FINAL_HEART, DEFEAT_LINE } from './boss/talk.js';
import { MOODS, isDownEvent } from './boss/mental.js';

export const PLAYER = 0;
export const BOSS = 1;

const HERE = dirname(fileURLToPath(import.meta.url));
export const BALANCE_PATH = join(HERE, 'balance.json');

/** 读取全部可调数值（newgame 时重新读盘 → 改配置不用重启）。 */
export function loadBalance(path = BALANCE_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const IMPORTANT = new Set(['bet', 'raise', 'allin', 'pressure', 'heavy']);

function emptyLegal() {
  return {
    check: false, call: null, fold: false,
    pressure: false, heavy: false, pressureTo: 0, heavyTo: 0,
    bet: false, raise: false, minTo: 0, maxTo: 0, allin: 0,
  };
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
      smallBlind: 10,
      bigBlind: 20,
    });
    this.boss = new Boss({ balance, rng });
    this.model = new PlayerModel();
    this._freshFields();
    this.#feed('system', `战斗开始 · ${balance.personality.name} DECEIVER · ${balance.stacks.player} vs ${balance.stacks.boss}`);
    this.#beginHand([]);
  }

  // ------------------------------------------------------------ 手牌级状态

  _freshFields() {
    this.phase = 'playing'; // playing | victory | defeat
    this.handNo = 0;
    this.mode = 'NORMAL'; // NORMAL | EXECUTION | COUNTER（每手重置）
    this.history = [];
    this.feed = [];
    this.readFragments = []; // [{ text, atHand }] 最新在前
    this.cracks = [];        // 本手已形成的证据链
    this.crack = null;       // 最近一个未使用的 CRACK（GOTCHA 的对象）
    this.gotchaStreak = 0;   // 连续正确 GOTCHA（跨手累计，答错清零）
    this.evidence = new EvidenceTracker(this.balance.cracks);
    this.readCooldownUntil = 0;
    this.lastBossAction = null;
    this.lastLine = null;
    this.lastPlayerAction = null;
    this.handAggressiveIntents = []; // Boss 本手的攻击性行动（抓诈唬判定）
    this.playerAggressive = false;
    this.prevBlind = null; // 上一手盲注（blindUp 判定）
    this.firstHandDone = false;
    this.lastBustedHand = -999;
  }

  #feed(kind, text) {
    this.feed.push({ kind, text });
    if (this.feed.length > 100) this.feed.shift();
  }

  #recordHistory(actor, action, street, amount) {
    this.history.push({ handNo: this.duel.handNo, street, actor, action, amount });
    if (this.history.length > 60) this.history.shift();
  }

  // ------------------------------------------------------------ 盲注升级

  /** 当前手数所在的盲注档（含档位标签与下一次升级提示）。 */
  blindFor(handNo) {
    const sched = this.balance.blindSchedule ?? [{ firstHand: 1, lastHand: 9999, sb: 10, bb: 20 }];
    const tier = sched.find((t) => handNo >= t.firstHand && handNo <= t.lastHand) ?? sched[sched.length - 1];
    const idx = sched.indexOf(tier);
    const next = sched[idx + 1] ?? null;
    const lastLabel = tier.lastHand >= 9999 ? `${tier.firstHand}+` : `${tier.firstHand}–${tier.lastHand}`;
    return {
      sb: tier.sb,
      bb: tier.bb,
      tier: `第 ${lastLabel} 手 · ${tier.sb}/${tier.bb}`,
      nextUp: next ? `第 ${next.firstHand} 手 → ${next.sb}/${next.bb}` : null,
    };
  }

  // ------------------------------------------------------------ 开一手

  #beginHand(events) {
    this.handNo += 1;
    this.duel.handNo = this.handNo;

    const blind = this.blindFor(this.handNo);
    const blindUp = Boolean(this.prevBlind && (this.prevBlind.sb !== blind.sb || this.prevBlind.bb !== blind.bb));
    this.prevBlind = { sb: blind.sb, bb: blind.bb };
    this.duel.smallBlind = blind.sb;
    this.duel.bigBlind = blind.bb;

    // 手牌级重置：模式、证据、CRACK、GOTCHA、本手增益
    this.mode = 'NORMAL';
    this.boss.resetHand();
    this.evidence.reset();
    this.cracks = [];
    this.crack = null;
    this.handAggressiveIntents = [];
    this.playerAggressive = false;
    this.lastBossAction = null;
    this.lastLine = null;
    this.model.s.readWindow = false;
    this.model.s.pressureWindow = false;

    const button = this.firstHandDone ? 1 - this.duel.button : (this.rng() < 0.5 ? 0 : 1);
    this.firstHandDone = true;

    if (blindUp) this.#feed('blind', `BLIND UP → ${blind.sb}/${blind.bb}（${blind.tier}）`);
    events.push({
      type: 'hand_start',
      handNo: this.handNo,
      button,
      sb: blind.sb,
      bb: blind.bb,
      tier: blind.tier,
      blindUp,
    });
    const blinds = this.duel.startHand({ button, deck: shuffle(makeDeck(), { next: this.rng }) });
    events.push(...blinds);
    this.#drive(events);
  }

  // ------------------------------------------------------------ Boss 驱动

  #fire(events, name) {
    const t = this.boss.mentalEvent(name);
    if (!t) return null;
    events.push({
      type: 'mental',
      from: t.from,
      to: t.to,
      cause: name,
      causeName: t.causeName,
      hint: t.hint,
      down: t.down,
    });
    const arrow = isDownEvent(t.from, t.to) ? '▼' : '▲';
    this.#feed('mental', `${arrow} ${MOODS[t.from]} → ${MOODS[t.to]} · ${t.causeName}`);
    return t;
  }

  /** BUSTED!：模型把握度足够 + 冷却完毕 + 运气 → Boss 专属技（进入 COUNTER）。 */
  #maybeBusted(events) {
    if (this.mode !== 'NORMAL') return false;
    const conf = this.balance.busted;
    if (this.handNo < (conf.minHand ?? 3)) return false;
    if (this.handNo - this.lastBustedHand < (conf.cooldownHands ?? 4)) return false;
    if (!this.model.bustedReady(conf.confidence ?? 0.7)) return false;
    if (this.rng() >= (conf.chance ?? 0.12)) return false;

    this.lastBustedHand = this.handNo;
    this.model.lastBustedAtHand = this.handNo;
    this.mode = 'COUNTER';
    this.boss.setPhaseBuff({ ...this.balance.counter });
    events.push({ type: 'busted', line: conf.line });
    events.push({ type: 'mode', mode: 'COUNTER' });
    this.#feed('model', `BUSTED! · ${conf.line}`);
    this.#feed('mode', 'Boss 主导的高压阶段开始（COUNTER）');
    return true;
  }

  #drive(events) {
    let guard = 0;
    while (this.duel.phase === 'playing' && this.duel.toAct === BOSS && guard++ < 80) {
      const d = this.duel;
      this.#maybeBusted(events);

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
        model: this.model,
      });

      const { normalized, events: engineEvents } = d.act(BOSS, {
        action: decision.action,
        amount: decision.amount,
      });
      events.push(...engineEvents);
      this.#recordHistory('boss', normalized.type, preStreet, normalized.to ?? 0);
      this.lastBossAction = { action: normalized.type, amount: normalized.to ?? 0, street: preStreet };

      this.boss.noteAction({ action: normalized.type, intent: decision.intent, street: preStreet });
      if (normalized.put > 0) {
        this.handAggressiveIntents.push({ action: normalized.type, intent: decision.intent, street: preStreet });
      }

      // 重要行动 → 旧证据与待兑现的 CRACK 过期（意图已经换了）
      // 面板历史（view.cracks）保留：未兑现的 result 为 null 即表示已过期
      if (IMPORTANT.has(normalized.type)) {
        this.evidence.reset();
        this.crack = null;
      }

      // 台词（v3：只承担人格与情绪的表达）
      const talk = this.boss.talkFor({ action: normalized.type, street: preStreet });
      if (talk) {
        this.lastLine = talk.text;
        events.push({ type: 'talk', line: talk.text });
        this.#feed('talk', talk.text);
      }

      if (d.phase !== 'playing') {
        this.#onHandEnd(events);
        break;
      }
    }
  }

  // ------------------------------------------------------------ 手牌结算

  #onHandEnd(events) {
    const d = this.duel;
    const r = d.result;
    if (!r) return;
    const pot = r.pot;
    const winner = r.winner;
    const bossWon = winner === BOSS;
    const bossLost = winner === PLAYER;
    const isSplit = winner === 'split';

    if (isSplit) {
      events.push({ type: 'pot_move', to: PLAYER, amount: Math.floor(pot / 2) });
      events.push({ type: 'pot_move', to: BOSS, amount: pot - Math.floor(pot / 2) });
    } else {
      events.push({ type: 'pot_move', to: winner, amount: pot });
    }

    const bluffCaught = r.type === 'showdown' && bossLost
      && this.handAggressiveIntents.some((a) => a.intent === 'BLUFF');
    const bigPotLost = bossLost && pot >= (this.balance.bigPotLostRatio ?? 0.2) * this.balance.stacks.boss;
    const allInLost = bossLost && (d.allIn[BOSS] || d.allIn[PLAYER]);

    // 摊牌记录进 Player Model
    if (r.type === 'showdown') {
      this.model.record('showdown', {
        playerWon: winner === PLAYER,
        playerAggressive: this.playerAggressive,
      });
    }

    if (bossLost) {
      if (allInLost) this.#fire(events, 'ALL_IN_LOST');
      else if (bigPotLost) this.#fire(events, 'BIG_POT_LOST');
      if (bluffCaught) this.#fire(events, 'BLUFF_CAUGHT');
    }

    // 赢牌后的台词
    if (bossWon && !isSplit) {
      const quip = this.boss.winQuip();
      if (quip) {
        events.push({ type: 'talk', line: quip });
        this.#feed('talk', quip);
      }
    }

    const winnerLabel = isSplit ? '平分底池'
      : winner === PLAYER ? `你赢得 ${pot}`
      : `千面赢得 ${pot}`;
    this.#feed('hand', `第 ${this.handNo} 手 · 底池 ${pot} · ${winnerLabel}`);

    const blind = this.blindFor(this.handNo);
    events.push({
      type: 'hand_end',
      handNo: this.handNo,
      winner,
      pot,
      stacks: { player: d.stacks[PLAYER], boss: d.stacks[BOSS] },
      effectiveStack: Math.min(d.stacks[PLAYER], d.stacks[BOSS]),
      blind: { sb: blind.sb, bb: blind.bb },
      mode: this.mode,
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

  /** PRESSURE(0.5池) / HEAVY(1.0池) 的 raise-to 金额（服务端算，客户端只负责显示）。 */
  #presetTo(frac) {
    const d = this.duel;
    const list = d.legal(PLAYER);
    const aggro = list.find((o) => o.type === 'bet') ?? list.find((o) => o.type === 'raise');
    if (!aggro) return null;
    const target = d.currentBet + frac * d.pot;
    const to = Math.max(aggro.minTo, Math.min(aggro.maxTo, Math.round(target)));
    return { type: aggro.type, to };
  }

  act(action, amount) {
    this.#requirePlayerTurn();
    const events = [];
    const d = this.duel;
    const preStreet = d.street;
    const label = String(action ?? '').toLowerCase();

    // ---- 预设行动 / 自由尺寸 / 引擎原生行动 ----
    let engineCmd;
    let displayAction = label;
    if (label === 'pressure' || label === 'heavy') {
      const frac = label === 'pressure'
        ? (this.balance.sizing.pressureFrac ?? 0.5)
        : (this.balance.sizing.heavyFrac ?? 1);
      const preset = this.#presetTo(frac);
      if (!preset) throw new GameError('当前无法施压（没有下注/加注选项）', 'CANNOT_PRESSURE');
      engineCmd = { action: preset.type, amount: preset.to };
    } else if (label === 'bet' || label === 'raise') {
      if (this.mode !== 'EXECUTION') {
        throw new GameError('自由下注仅在 EXECUTION 阶段开放', 'NOT_EXECUTION');
      }
      engineCmd = { action: label, amount };
    } else {
      engineCmd = { action: label, amount };
    }

    const { normalized, events: engineEvents } = d.act(PLAYER, engineCmd);

    // 行动事件与 history 用玩家视角的动作名（pressure/heavy），Boss 用引擎名
    const outEvents = engineEvents.map((e) => (
      e.type === 'action' && displayAction !== normalized.type
        ? { ...e, action: displayAction }
        : e
    ));
    events.push(...outEvents);
    this.#recordHistory('player', displayAction, preStreet, normalized.to ?? 0);

    // ---- Player Model 记账（READ→HEAVY 等习惯；先置窗口再消费）----
    if (displayAction === 'pressure') this.model.record('pressure');
    this.model.record('action', {
      action: displayAction,
      facingBet: (d.currentBet - d.committed[PLAYER]) > 0 || normalized.type === 'call' || normalized.type === 'raise',
    });

    if (normalized.put > 0) this.playerAggressive = true;
    const actionEvent = outEvents.find((e) => e.type === 'action');
    this.lastPlayerAction = { action: displayAction, allIn: Boolean(actionEvent?.allIn), street: preStreet };

    if (d.phase !== 'playing') {
      this.#onHandEnd(events);
    } else {
      this.#drive(events);
    }
    return { view: this.view(), events };
  }

  // ------------------------------------------------------------ READ

  /**
   * READ：闪现一条心理碎片（无限次，短冷却）。
   * 类型（TRUE/NOISE/DISTORTION）与语义标签只在服务端 —— 客户端只拿到 text。
   */
  read() {
    this.#requirePlayerTurn();
    const t = this.now();
    if (t < this.readCooldownUntil) throw new GameError('READ 正在冷却', 'READ_COOLING');
    const events = [];
    const balance = this.balance;
    const execution = this.mode === 'EXECUTION';
    const state = this.boss.state;
    const intent = this.boss.currentIntent();

    const makeOne = (burst) => {
      const frag = makeFragment({
        state,
        intent,
        equity: this.boss.lastEquity,
        street: this.duel.street,
        execution,
        balance,
        rng: this.rng,
      });
      const ev = {
        type: 'read_fragment',
        text: frag.text,
        flashMs: flashMs(state, balance, execution),
        burst,
      };
      // 碎片流水（只有 text + atHand 下发）
      this.readFragments.unshift({ text: frag.text, atHand: this.handNo });
      if (this.readFragments.length > 30) this.readFragments.pop();
      this.#feed('read', frag.text);

      // 证据链：只有 TRUE 带标签可能成链
      const crack = this.evidence.add(frag, this.handNo);
      return { ev, crack };
    };

    const first = makeOne(false);
    events.push(first.ev);
    let crack = first.crack;

    // EXECUTION：信息量更高（25% 双发）
    if (execution && this.rng() < (balance.read.burstChanceInExecution ?? 0.25)) {
      const second = makeOne(true);
      events.push(second.ev);
      if (!crack) crack = second.crack;
    }

    this.readCooldownUntil = t + (balance.read.cooldownMs ?? 400);
    this.model.record('read');

    if (crack) this.#emitCrack(events, crack);
    return { view: this.view(), events };
  }

  #emitCrack(events, crack) {
    this.cracks.push({ ...crack, result: null });
    this.crack = crack;
    events.push({
      type: 'crack',
      id: crack.id,
      kind: crack.kind,
      evidence: crack.evidence,
      strength: crack.strength,
      critical: crack.critical,
    });
    this.#feed('crack', `CRACK! [${crack.kind}] ${crack.evidence.join(' + ')}${crack.critical ? ' · CRITICAL TELL' : ''}`);
  }

  // ------------------------------------------------------------ GOTCHA

  /**
   * GOTCHA：押上你的判断。
   * BLUFF ↔ intent∈{BLUFF,PROBE}；STRONG ↔ intent∈{VALUE,TRAP,CONTROL}。
   * 正确 → EXECUTION；错误 → COUNTER（Boss 本手攻击暴涨）。
   */
  gotcha(guess) {
    this.#requirePlayerTurn();
    const events = [];
    const g = String(guess ?? '').toUpperCase();
    if (g !== 'BLUFF' && g !== 'STRONG') throw new GameError('只能押 BLUFF 或 STRONG', 'BAD_GUESS');
    if (!this.crack || !this.crackOpen()) throw new GameError('还没有可用的 CRACK', 'NO_CRACK');
    const intent = this.boss.currentIntent();
    if (!intent) throw new GameError('Boss 还没有可判定的行动', 'NO_INTENT');

    const bossSide = intent === 'BLUFF' || intent === 'PROBE' ? 'BLUFF' : 'STRONG';
    const correct = g === bossSide;

    // 兑现：CRACK 被使用（保留记录）
    const entry = this.cracks.find((c) => c.id === this.crack.id);
    if (entry) entry.result = { guess: g, correct };
    this.crack = null;
    this.model.record('gotcha', { correct });

    events.push({ type: 'gotcha_result', guess: g, correct, mode: correct ? 'EXECUTION' : 'COUNTER' });

    if (correct) {
      this.mode = 'EXECUTION';
      this.gotchaStreak += 1;
      this.#fire(events, 'GOTCHA_HIT');
      if (this.gotchaStreak >= (this.balance.gotcha?.streakForTilt ?? 2)) {
        this.#fire(events, 'GOTCHA_STREAK');
        this.gotchaStreak = 0;
      }
      this.#feed('gotcha', `GOTCHA! 判断正确（${g}）→ EXECUTION 自由下注开启`);
    } else {
      this.mode = 'COUNTER';
      this.gotchaStreak = 0;
      this.boss.setPhaseBuff({ ...this.balance.counter });
      this.#feed('gotcha', `GOTCHA 判断错误（${g}）→ COUNTER，他反扑了`);
    }
    events.push({ type: 'mode', mode: this.mode });
    this.#feed('mode', this.mode === 'EXECUTION' ? 'EXECUTION · 自由下注阶段' : 'COUNTER · Boss 高压阶段');
    return { view: this.view(), events };
  }

  /** 未使用的 CRACK 且 Boss 有可判定的 intent → GOTCHA 可发动。 */
  crackOpen() {
    return Boolean(this.crack) && Boolean(this.boss.currentIntent());
  }

  // ------------------------------------------------------------ 重开

  newGame() {
    const events = [];
    this.balance = loadBalance(); // 热加载配置
    this.duel = new Duel({
      stacks: [this.balance.stacks.player, this.balance.stacks.boss],
      smallBlind: 10,
      bigBlind: 20,
    });
    this.boss = new Boss({ balance: this.balance, rng: this.rng });
    this.model = new PlayerModel();
    this._freshFields();
    this.#feed('system', `战斗重新开始 · ${this.balance.personality.name} · ${this.balance.stacks.player} vs ${this.balance.stacks.boss}`);
    this.#beginHand(events);
    return { view: this.view(), events };
  }

  // ------------------------------------------------------------ 视图

  #viewLegal() {
    const d = this.duel;
    const base = mapLegal(d.legal(PLAYER));
    // PRESSURE / HEAVY 预设：服务端算好 raise-to
    const pressure = this.#presetTo(this.balance.sizing.pressureFrac ?? 0.5);
    const heavy = this.#presetTo(this.balance.sizing.heavyFrac ?? 1);
    base.pressure = Boolean(pressure);
    base.heavy = Boolean(heavy);
    base.pressureTo = pressure ? pressure.to : 0;
    base.heavyTo = heavy ? heavy.to : 0;
    // 自由尺寸字段照常给出；客户端必须用 mode==='EXECUTION' 门禁
    return base;
  }

  view() {
    const d = this.duel;
    const playing = this.phase === 'playing' && d.phase === 'playing';
    const playerTurn = playing && d.toAct === PLAYER;
    const blind = this.blindFor(this.handNo || 1);

    // 当前牌型（flop 起才有 5 张可评）
    let handName = null;
    if (d.hole[PLAYER].length === 2 && d.board.length >= 3) {
      handName = evaluate([...d.hole[PLAYER], ...d.board]).nameZh;
    }

    const openCrack = this.crack && this.crackOpen() && this.mode === 'NORMAL'
      ? this.crack
      : null;

    return {
      phase: this.phase,
      handNo: d.handNo,
      street: d.street,
      pot: d.pot,
      board: d.board.slice(),
      button: d.button,
      toAct: playing ? d.toAct : null,
      blind: { sb: blind.sb, bb: blind.bb, tier: blind.tier, nextUp: blind.nextUp },
      effectiveStack: Math.min(d.stacks[PLAYER], d.stacks[BOSS]),
      mode: this.mode,
      player: {
        chips: d.stacks[PLAYER],
        bet: d.committed[PLAYER],
        hole: d.hole[PLAYER].slice(),
        toCall: Math.max(0, d.currentBet - d.committed[PLAYER]),
        handName,
        legal: playerTurn ? this.#viewLegal() : emptyLegal(),
        readCooldownUntil: this.readCooldownUntil,
      },
      boss: {
        chips: d.stacks[BOSS],
        bet: d.committed[BOSS],
        hole: null, // 摊牌信息只在 showdown 事件里
        state: this.boss.state,
        face: this.boss.face,
        mood: this.boss.mood,
        stateHint: this.boss.stateHint,
        lastAction: this.lastBossAction,
        lastLine: this.lastLine,
      },
      gotcha: openCrack
        ? { id: openCrack.id, kind: openCrack.kind, evidence: openCrack.evidence.slice() }
        : null,
      cracks: this.cracks.map((c) => ({
        id: c.id,
        kind: c.kind,
        evidence: c.evidence.slice(),
        strength: c.strength,
        critical: c.critical,
        handNo: c.handNo,
        result: c.result ?? null,
      })),
      history: this.history.slice(),
      readFragments: this.readFragments.slice(),
      feed: this.feed.slice(),
    };
  }
}
