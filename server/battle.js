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
import { matchCrackRule, buildCrack } from './boss/crack-rules.js';
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
/** GOTCHA 里的阶梯加注 / 自动泄漏相关动作集合。 */
const GOTCHA_OK = new Set(['fold', 'call', 'check', 'raise', 'bet']);
const NORMAL_OK = new Set(['fold', 'call', 'check', 'pressure', 'heavy', 'allin']);
/** 自动泄漏触发：任意一方完成 CALL / RAISE（v4 契约 §十）。 */
const LEAK_TRIGGERS = new Set(['call', 'raise']);
void IMPORTANT;

function emptyLegal() {
  return {
    check: false, call: null, fold: false,
    pressure: false, heavy: false, pressureTo: 0, heavyTo: 0,
    bet: false, raise: false, minTo: 0, maxTo: 0, allin: 0,
    gotchaRaiseTo: null,
  };
}

function mapLegal(list) {
  const out = emptyLegal();
  for (const o of list) {
    if (o.type === 'check') out.check = true;
    else if (o.type === 'call') out.call = o.amount;
    else if (o.type === 'fold') out.fold = true;
    else if (o.type === 'bet') { out.bet = true; out.minTo = o.minTo; out.maxTo = Number.isFinite(o.maxTo) ? o.maxTo : Number.MAX_SAFE_INTEGER; }
    else if (o.type === 'raise') { out.raise = true; out.minTo = o.minTo; out.maxTo = Number.isFinite(o.maxTo) ? o.maxTo : Number.MAX_SAFE_INTEGER; }
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
    this.mode = 'NORMAL'; // NORMAL | GOTCHA（每手重置；EXECUTION/COUNTER 已废弃）
    this.history = [];
    this.feed = [];
    this.readFragments = []; // [{ id|null, text, atHand }] 最新在前
    this.cracks = [];        // 本手已验证成功的「情报×行动」CRACK
    this.crackSeq = 0;
    // ---- READ 资源与 PIN（v4）----
    this.readsLeft = this.balance.readUsesPerHand ?? 2;
    this.readCooldownUntil = 0;
    this.fragmentSeq = 0;
    this.handFragments = new Map(); // 本手手工 READ 的碎片元数据（id → meta，服务端私有）
    this.pinned = null;             // 唯一保留位（字段不叫 pin：会遮蔽方法 pin()）：{ fragmentId, text, type, tags, sourceAction, handId, verified }
    // ---- GOTCHA 负债状态 ----
    this.gotchaDepth = 0;           // 自动泄漏深度（TRUE 比例随深度上升）
    this.gotchaRaiseStep = 0;       // 玩家阶梯加注步长
    this.enteredGotchaThisHand = false;
    this.enteredGotchaPrevHand = false;
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

    // 手牌级重置：模式、负债、PIN、碎片、CRACK、READ 资源、本手增益
    // ★ 负债绝不跨手：mode/debtMode 双重复位（startHand 内部也会关 debtMode）
    this.mode = 'NORMAL';
    this.duel.debtMode = false;
    this.boss.resetHand();
    this.cracks = [];
    this.crackSeq = 0;
    this.readsLeft = this.balance.readUsesPerHand ?? 2;
    this.readCooldownUntil = 0;
    this.fragmentSeq = 0;
    this.handFragments.clear();
    this.pinned = null;
    this.gotchaDepth = 0;
    this.gotchaRaiseStep = 0;
    this.enteredGotchaPrevHand = this.enteredGotchaThisHand;
    this.enteredGotchaThisHand = false;
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

  /** BUSTED!：模型把握度足够 + 冷却完毕 + 运气 → Boss 专属技（本手攻击增益；v4 不再切 mode）。 */
  #maybeBusted(events) {
    if (this.mode !== 'NORMAL') return false;
    const conf = this.balance.busted;
    if (this.handNo < (conf.minHand ?? 3)) return false;
    if (this.handNo - this.lastBustedHand < (conf.cooldownHands ?? 4)) return false;
    if (!this.model.bustedReady(conf.confidence ?? 0.7)) return false;
    if (this.rng() >= (conf.chance ?? 0.12)) return false;

    this.lastBustedHand = this.handNo;
    this.model.lastBustedAtHand = this.handNo;
    this.boss.setPhaseBuff({ ...this.balance.counter });
    events.push({ type: 'busted', line: conf.line });
    this.#feed('model', `BUSTED! · ${conf.line}（本手他全面提高攻击性）`);
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

      // GOTCHA：完整加注 → 玩家阶梯翻倍；CALL/RAISE → 自动心理泄漏
      if (this.mode === 'GOTCHA') {
        if (normalized.type === 'raise') this.#bumpRaiseStep();
        this.#maybeAutoLeak(events, normalized.type);
      }

      // 台词（v3/v4：只承担人格与情绪的表达）
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

  // ------------------------------------------------------------ GOTCHA 阶梯与自动泄漏（v4）

  /** GOTCHA 阶梯：玩家 RAISE 的 raise-to（currentBet=0 时即开注视额）。 */
  #gotchaRaiseTo() {
    const d = this.duel;
    const list = d.legal(PLAYER);
    const aggro = list.find((o) => o.type === 'bet') ?? list.find((o) => o.type === 'raise');
    if (!aggro) return null;
    const step = Math.max(this.gotchaRaiseStep, d.lastRaiseSize);
    const target = d.currentBet + step;
    return Math.max(aggro.minTo, Math.min(aggro.maxTo === Infinity ? Number.MAX_SAFE_INTEGER : aggro.maxTo, Math.round(target)));
  }

  #bumpRaiseStep() {
    // 任意一方完整加注后步长翻倍：100 → 200 → 400 → 800 …（每一次继续风险肉眼翻倍）
    this.gotchaRaiseStep = Math.min(Math.max(this.gotchaRaiseStep, 1) * 2, 1e15);
  }

  /** GOTCHA：任意一方 CALL/RAISE 自动触发心理泄漏；深度越高 TRUE 越多（§十/§十一）。 */
  #maybeAutoLeak(events, actionType) {
    if (this.mode !== 'GOTCHA' || !LEAK_TRIGGERS.has(actionType)) return;
    this.gotchaDepth += 1;
    const cfg = this.balance.gotcha ?? {};
    const table = cfg.trueRateByDepth ?? [0.45, 0.55, 0.65, 0.75];
    const trueRate = table[Math.min(this.gotchaDepth, table.length) - 1] ?? table[table.length - 1];
    const range = this.balance.gotchaReadFragmentCount ?? { min: 3, max: 5 };
    const hi = Math.max(range.min, range.max);
    const count = range.min + Math.floor(this.rng() * (hi - range.min + 1));
    const state = this.boss.state;
    const fragments = [];
    for (let i = 0; i < count; i++) {
      const frag = makeFragment({
        state,
        intent: this.boss.currentIntent(),
        equity: this.boss.lastEquity,
        street: this.duel.street,
        trueRate,
        balance: this.balance,
        rng: this.rng,
      });
      fragments.push({ id: null, text: frag.text }); // 自动泄漏不可 PIN
      // type 仅供服务端/测试查验；view 侧显式映射会剥掉它
      this.readFragments.unshift({ id: null, text: frag.text, atHand: this.handNo, type: frag.type });
    }
    if (this.readFragments.length > 30) this.readFragments.length = 30;
    events.push({
      type: 'read_batch',
      source: 'gotcha',
      depth: this.gotchaDepth,
      flashMs: Math.max(420, Math.round(flashMs(state, this.balance) * (cfg.flashScale ?? 0.6))),
      fragments,
    });
  }

  /**
   * ★ 新 CRACK（方案 §四-六）：PIN 的真实情报 × 玩家行动 × Boss 当前 intent。
   * NOISE / DISTORTION 没有标签 → 天然不产生 CRACK；Boss 再次进攻换 intent → 旧情报失效。
   */
  #validatePinCrack(events, actionLabel) {
    const pin = this.pinned;
    if (!pin || pin.verified || pin.type !== 'TRUE') return;
    const intent = this.boss.currentIntent();
    if (!intent) return;
    const rule = matchCrackRule(this.balance, pin, actionLabel, intent);
    if (!rule) return;

    pin.verified = true;
    const crack = buildCrack(rule, pin, actionLabel, this.handNo, ++this.crackSeq);
    this.cracks.push({ ...crack, result: null });
    events.push({
      type: 'crack',
      id: crack.id,
      kind: crack.kind,
      evidence: crack.evidence,
      action: crack.action,
      strength: crack.strength,
      critical: crack.critical,
      handNo: crack.handNo,
    });
    this.#feed('crack', `CRACK! [${crack.kind}] ${crack.evidence.join(' + ')} × ${actionLabel} —— ${crack.why}`);
    const need = this.balance.cracksForGotcha ?? 2;
    if (this.cracks.length === need) {
      this.#feed('gotcha', `GOTCHA 解锁！（${this.cracks.length}/${need} 个 CRACK）`);
    }
  }

  act(action, amount) {
    this.#requirePlayerTurn();
    const events = [];
    const d = this.duel;
    const preStreet = d.street;
    const label = String(action ?? '').toLowerCase();

    // ---- 模式门禁（v4）----
    let engineCmd;
    let displayAction = label;
    if (this.mode === 'GOTCHA') {
      if (!GOTCHA_OK.has(label)) {
        throw new GameError('GOTCHA 中只有 FOLD / CALL / CHECK / RAISE', 'GOTCHA_ACTIONS');
      }
      if (label === 'raise' || label === 'bet') {
        const ladder = this.#gotchaRaiseTo();
        if (ladder === null) throw new GameError('当前无法加注', 'CANNOT_RAISE');
        engineCmd = { action: label, amount: Number.isFinite(Number(amount)) ? Number(amount) : ladder };
      } else {
        engineCmd = { action: label, amount };
      }
    } else {
      if (label === 'pressure' || label === 'heavy') {
        const frac = label === 'pressure'
          ? (this.balance.sizing.pressureFrac ?? 0.5)
          : (this.balance.sizing.heavyFrac ?? 1);
        const preset = this.#presetTo(frac);
        if (!preset) throw new GameError('当前无法施压（没有下注/加注选项）', 'CANNOT_PRESSURE');
        engineCmd = { action: preset.type, amount: preset.to };
      } else if (label === 'bet' || label === 'raise') {
        throw new GameError('自由加注仅在 GOTCHA 阶段开放', 'NOT_GOTCHA');
      } else if (!NORMAL_OK.has(label)) {
        throw new GameError(`不支持的动作：${label}`, 'BAD_ACTION');
      } else {
        engineCmd = { action: label, amount };
      }
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

    // ---- GOTCHA：阶梯翻倍 + 自动泄漏 ----
    if (this.mode === 'GOTCHA') {
      if (normalized.type === 'raise') this.#bumpRaiseStep();
      this.#maybeAutoLeak(events, normalized.type);
    }

    // ---- ★ 每次成功行动后验证 PIN → 可能形成 CRACK ----
    this.#validatePinCrack(events, displayAction);

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

  // ------------------------------------------------------------ READ（v4 批量 + 限量）

  /**
   * READ：每手限量（readUsesPerHand），一次返回一组心理碎片（3–5 条）。
   * 只有手工 READ 的碎片带 id（可 PIN）；类型与标签只在服务端。
   */
  read() {
    this.#requirePlayerTurn();
    if (this.mode === 'GOTCHA') {
      throw new GameError('GOTCHA 中自动泄漏，无需手动 READ', 'GOTCHA_AUTO_READ');
    }
    if (this.readsLeft <= 0) throw new GameError('这一手的 READ 次数已用完', 'READ_EXHAUSTED');
    const t = this.now();
    if (t < this.readCooldownUntil) throw new GameError('READ 正在冷却', 'READ_COOLING');

    const events = [];
    const balance = this.balance;
    const state = this.boss.state;
    const intent = this.boss.currentIntent();
    const range = balance.normalReadFragmentCount ?? { min: 3, max: 5 };
    const hi = Math.max(range.min, range.max);
    const count = range.min + Math.floor(this.rng() * (hi - range.min + 1));

    const fragments = [];
    for (let i = 0; i < count; i++) {
      const frag = makeFragment({
        state,
        intent,
        equity: this.boss.lastEquity,
        street: this.duel.street,
        balance,
        rng: this.rng,
      });
      const id = `f${++this.fragmentSeq}`;
      this.handFragments.set(id, {
        id,
        text: frag.text,
        type: frag.type,          // ★ 服务端私有
        tags: frag.tags.slice(),  // ★ 服务端私有
        strength: frag.strength,
        sourceAction: this.boss.lastActionInfo?.action ?? null,
        handId: this.handNo,
      });
      fragments.push({ id, text: frag.text });
      this.readFragments.unshift({ id, text: frag.text, atHand: this.handNo });
      this.#feed('read', frag.text);
    }
    if (this.readFragments.length > 30) this.readFragments.length = 30;

    this.readsLeft -= 1;
    this.readCooldownUntil = t + (balance.read.cooldownMs ?? 400);
    this.model.record('read');
    events.push({ type: 'read_batch', source: 'manual', flashMs: flashMs(state, balance), fragments });
    return { view: this.view(), events };
  }

  /** PIN：保留一条本手手工 READ 的碎片（单槽，新覆盖旧）。玩家只见 text。 */
  pin(fragmentId) {
    this.#requirePlayerTurn();
    const meta = this.handFragments.get(String(fragmentId));
    if (!meta) throw new GameError('这条碎片已不可保留（仅限本手 READ）', 'BAD_FRAGMENT');
    this.pinned = {
      fragmentId: meta.id,
      text: meta.text,
      type: meta.type,
      tags: meta.tags.slice(),
      sourceAction: meta.sourceAction,
      handId: meta.handId,
      verified: false,
    };
    return { view: this.view(), events: [] };
  }

  // ------------------------------------------------------------ GOTCHA（v4 进入负债状态）

  /**
   * 进入 GOTCHA：解除双方 Stack 安全上限，允许负债下注（方案 §八/§十二）。
   * 结束条件只有 FOLD / SHOWDOWN，由引擎结算统一处理。
   */
  gotcha() {
    this.#requirePlayerTurn();
    const events = [];
    const d = this.duel;
    const need = this.balance.cracksForGotcha ?? 2;
    if (this.mode !== 'NORMAL') throw new GameError('已经处于 GOTCHA 中', 'ALREADY_GOTCHA');
    if (this.cracks.length < need) {
      throw new GameError(`CRACK 还不够（${this.cracks.length}/${need}）`, 'GOTCHA_NOT_ARMED');
    }
    if (d.allIn[0] || d.allIn[1]) throw new GameError('已有人全下，无法进入负债状态', 'GOTCHA_LOCKED');

    this.mode = 'GOTCHA';
    d.debtMode = true;
    this.gotchaDepth = 0;
    this.gotchaRaiseStep = Math.max(d.lastRaiseSize, d.bigBlind);
    this.enteredGotchaThisHand = true;

    events.push({ type: 'mode', mode: 'GOTCHA' });
    this.#feed('gotcha', `GOTCHA！双方解除筹码上限 —— 负债下注开始（${this.cracks.length} 个 CRACK 触发）`);
    this.#feed('mode', 'GOTCHA · 临时余额可以为负，FOLD/SHOWDOWN 统一结算');
    // 被看穿到敢押上全部 → 情绪；连续两手上头
    this.#fire(events, 'GOTCHA_HIT');
    if (this.enteredGotchaPrevHand) this.#fire(events, 'GOTCHA_STREAK');
    return { view: this.view(), events };
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
    const inGotcha = this.mode === 'GOTCHA';
    // PRESSURE / HEAVY 预设：仅 NORMAL（GOTCHA 用阶梯 RAISE）
    const pressure = inGotcha ? null : this.#presetTo(this.balance.sizing.pressureFrac ?? 0.5);
    const heavy = inGotcha ? null : this.#presetTo(this.balance.sizing.heavyFrac ?? 1);
    base.pressure = Boolean(pressure);
    base.heavy = Boolean(heavy);
    base.pressureTo = pressure ? pressure.to : 0;
    base.heavyTo = heavy ? heavy.to : 0;
    // GOTCHA：阶梯加注金额（唯一允许的自由 Raise）
    base.gotchaRaiseTo = inGotcha ? this.#gotchaRaiseTo() : null;
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

    // GOTCHA 解锁提示（仅 NORMAL 且 CRACK 达标）
    const need = this.balance.cracksForGotcha ?? 2;
    const gotchaArmed = this.mode === 'NORMAL' && this.cracks.length >= need
      ? { cracks: this.cracks.length, need }
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
        chips: d.stacks[PLAYER],            // GOTCHA 结算前可为负（负债）
        bet: d.committed[PLAYER],
        hole: d.hole[PLAYER].slice(),
        toCall: Math.max(0, d.currentBet - d.committed[PLAYER]),
        handName,
        legal: playerTurn ? this.#viewLegal() : emptyLegal(),
        readsLeft: this.readsLeft,           // ★ 本手剩余 READ（UI: READ 2/2）
        readsPerHand: this.balance.readUsesPerHand ?? 2,
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
      // ★ PIN：唯一保留位（玩家只见 text + verified）
      pin: this.pinned ? { text: this.pinned.text, verified: this.pinned.verified } : null,
      gotcha: gotchaArmed,
      cracks: this.cracks.map((c) => ({
        id: c.id,
        kind: c.kind,
        evidence: c.evidence.slice(),
        action: c.action,
        strength: c.strength,
        critical: c.critical,
        handNo: c.handNo,
        result: c.result ?? null,
      })),
      history: this.history.slice(),
      readFragments: this.readFragments.map((f) => ({ id: f.id ?? null, text: f.text, atHand: f.atHand })),
      feed: this.feed.slice(),
    };
  }
}
