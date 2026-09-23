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
import { FINAL_HEART, DEFEAT_LINE, pickCrackReact } from './boss/talk.js';
import { MOODS, FACES, isDownEvent, applyTransition } from './boss/mental.js';

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
/** 街段顺序（Focus 授予用）。 */
const STREET_ORDER = ['preflop', 'flop', 'turn', 'river'];
const clamp01 = (v) => Math.max(0, Math.min(0.95, v));

/**
 * Boss 行动的 Tell 强度档（方案 §4）：check < bet < fold < call < raise < heavy ≤ allin。
 * heavy = 注码 ≥ heavyFrac×行动前池。
 */
function tellTier(action, put, potBefore, heavyFrac) {
  if (action === 'allin') return 'allin';
  if (action === 'check') return 'check';
  if (action === 'call') return 'call';
  if (action === 'fold') return 'fold';
  const ratio = put / Math.max(1, potBefore);
  if (ratio >= heavyFrac) return 'heavy';
  return action === 'raise' ? 'raise' : 'bet';
}

/**
 * v6 §2：Opening 强度（纯函数，供测试穷举）。
 * score = tellStrength[档] + streetMod[街]（状态不进分数，只走抬级，避免双重叠加）
 * → 阈值分 WEAK/NORMAL/STRONG → SHAKEN/EXPOSED 各抬一级（封顶 STRONG）。
 */
export function computeOpeningStrength(balance, state, tier, street) {
  const cfg = balance?.opening ?? {};
  const rd = balance?.read ?? {};
  const score = (rd.tellStrength?.[tier] ?? 0) + (rd.streetModifier?.[street] ?? 0);
  const th = cfg.thresholds ?? { weak: 0.06, normal: 0.18 };
  let idx = score < th.weak ? 0 : (score < th.normal ? 1 : 2);
  idx = Math.min(2, idx + (cfg.stateTierBonus?.[state] ?? 0));
  return ['WEAK', 'NORMAL', 'STRONG'][idx];
}

/** 每批碎片条数（min..max 均匀取整）。 */
function randomCount(range, rng) {
  const lo = range?.min ?? 3;
  const hi = Math.max(lo, range?.max ?? lo);
  return lo + Math.floor(rng() * (hi - lo + 1));
}
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
    // ---- Tell Window / Focus / PIN（v5）----
    this.readCooldownUntil = 0;
    this.focus = this.balance.focus?.max ?? 0; // 首手由 beginHand 归 0；字段先建
    this.focusMax = this.balance.focus?.max ?? 2;
    this.tellSeq = 0;
    this.actionSeq = 0;
    this.tellWindow = null;         // 当前心理窗口 {id,actionId,handId,street,bossAction,tier}
    this.pendingBossCounter = null; // Boss 反读陷阱（随窗口生死）
    this.playerState = 'CALM';      // 玩家心理状态（跨手持续，newgame 复位）
    this.comboCount = 0;            // v6 §9：连续 CRACK 段数（仅 UI/GOTCHA 参考，无 Buff）
    this.handFragments = new Map(); // 窗口内碎片元数据（id → meta，服务端私有）
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
    this.focus = 0; // ★ Focus 每手从 0 开始（翻前不开放 READ）
    this.readCooldownUntil = 0;
    this.tellWindow = null;
    this.pendingBossCounter = null;
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

  // ------------------------------------------------- v5：Tell/Focus/反读/窗口

  /**
   * v6 §2：Opening 强度。
   * score = tellStrength[档] + streetMod[街]（状态不进分数，只走抬级，避免双重叠加）
   * → 阈值分 WEAK/NORMAL/STRONG → SHAKEN/EXPOSED 各抬一级（封顶 STRONG）。
   * 只用于「心理波动：微弱/明显/强烈」——绝不下发概率。
   */
  #openingStrength(tier, street) {
    return computeOpeningStrength(this.balance, this.boss.state, tier, street);
  }

  /** 跨街授予 Focus（flop/turn/river 各 +1，封顶 focusMax；翻前0）。 */
  #grantFocus(fromStreet, toStreet) {
    const grant = this.balance.focus?.streetGrant ?? {};
    const fromIdx = STREET_ORDER.indexOf(fromStreet);
    const toIdx = STREET_ORDER.indexOf(toStreet);
    if (fromIdx < 0 || toIdx <= fromIdx) return;
    for (let i = fromIdx + 1; i <= toIdx; i++) {
      this.focus = Math.min(this.focusMax, this.focus + (grant[STREET_ORDER[i]] ?? 0));
    }
  }

  /**
   * 关闭当前窗口并清空即时心理信息（方案 §2）：
   * 无论 CRACK 成败，碎片与 PIN 都不得跨越下一次 Poker 决策。
   */
  #closeTellWindow() {
    this.tellWindow = null;
    this.pendingBossCounter = null;
    this.pinned = null;
    this.readFragments = [];
    this.handFragments.clear();
  }

  /** Boss 反读（§9）：玩家行为模式成形 + Boss 本次行动语义命中 → 布下陷阱。 */
  #evaluateBossCounter(normalized, putRatio) {
    for (const rule of this.balance.bossCounterRules ?? []) {
      if (!this.model.patternArmed(rule.pattern, rule.threshold)) continue;
      if (this.#bossActionMatches(rule.bossAction, normalized, putRatio)) {
        return {
          ruleId: rule.ruleId ?? rule.id,
          bossAction: rule.bossAction,
          playerAction: rule.playerAction,
          why: rule.why ?? '',
        };
      }
    }
    return null;
  }

  #bossActionMatches(need, normalized, putRatio) {
    if (need === 'check') return normalized.type === 'check';
    if (need === 'raise') return normalized.type === 'raise';
    if (need === 'bet') return normalized.type === 'bet';
    if (need === 'heavy') {
      return normalized.type === 'allin'
        || ((normalized.type === 'bet' || normalized.type === 'raise')
          && putRatio >= (this.balance.sizing?.heavyFrac ?? 1));
    }
    return false;
  }

  /** 玩家的回应落地：命中陷阱 → Boss CRACK 玩家 + 玩家心理推进（一窗一次）。 */
  #resolveBossCounter(events, actionLabel) {
    const trap = this.pendingBossCounter;
    if (!trap) return;
    this.pendingBossCounter = null;
    if (trap.playerAction !== actionLabel) return; // 没上钩：静默失败
    events.push({
      type: 'player_cracked',
      ruleId: trap.ruleId,
      action: actionLabel,
      bossAction: trap.bossAction,
      why: trap.why,
    });
    this.#feed('model', `PLAYER CRACKED · ${trap.why}`);
    this.#advancePlayerState(events);
  }

  /** Boss CRACK 玩家 → 玩家心理 CALM→SHAKEN→EXPOSED（同一张转移表）。 */
  #advancePlayerState(events) {
    const t = applyTransition(this.balance.transitions, this.playerState, 'CRACK', this.rng);
    if (!t) return;
    this.playerState = t.to;
    events.push({ type: 'player_mental', from: t.from, to: t.to });
    this.#feed('mental', `你被看穿了：${MOODS[t.from]} → ${MOODS[t.to]}`);
  }

  /**
   * GOTCHA 窗口（§11）：心理状态创造资格 × Poker 行为创造时机。
   * EXPOSED + TURN/RIVER + Boss 刚做出高承诺行动（本街）+ 玩家回合。
   */
  #gotchaWindowOpen(d = this.duel) {
    if (this.mode !== 'NORMAL') return false;
    if (this.boss.state !== 'EXPOSED') return false;
    if (d.street !== 'turn' && d.street !== 'river') return false;
    if (d.toAct !== PLAYER) return false;
    const la = this.lastBossAction;
    if (!la || la.street !== d.street) return false;
    if (la.action !== 'bet' && la.action !== 'raise' && la.action !== 'allin') return false;
    return true;
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
      const bossPutRatio = (normalized.put ?? 0) / Math.max(1, potBefore);
      this.lastBossAction = { action: normalized.type, amount: normalized.to ?? 0, street: preStreet, ratio: bossPutRatio };
      // Focus：跨街授予（进 flop/turn/river 各 +1，封顶）
      this.#grantFocus(preStreet, d.street);

      this.boss.noteAction({ action: normalized.type, intent: decision.intent, street: preStreet });
      if (normalized.put > 0) {
        this.handAggressiveIntents.push({ action: normalized.type, intent: decision.intent, street: preStreet });
      }

      // GOTCHA：完整加注 → 玩家阶梯翻倍；CALL/RAISE → 自动心理泄漏
      if (this.mode === 'GOTCHA') {
        if (normalized.type === 'raise') this.#bumpRaiseStep();
        this.#maybeAutoLeak(events, normalized.type);
      }

      // 台词（只承担人格与情绪的表达）
      const talk = this.boss.talkFor({ action: normalized.type, street: preStreet });
      if (talk) {
        this.lastLine = talk.text;
        events.push({ type: 'talk', line: talk.text });
        this.#feed('talk', talk.text);
      }

      // ★ Tell Window（方案 §1）：Boss 行动后玩家仍需在同街回应 → 开心理窗口；
      //   同时按玩家行为模式评估 Boss 反读陷阱（§9），随窗口生死
      this.#closeTellWindow();
      if (d.phase === 'playing' && d.toAct === PLAYER && preStreet === d.street) {
        const tier = tellTier(normalized.type, normalized.put ?? 0, potBefore, this.balance.sizing?.heavyFrac ?? 1);
        const strength = this.#openingStrength(tier, d.street); // v6 §2：WEAK/NORMAL/STRONG
        this.actionSeq += 1;
        this.tellSeq += 1;
        this.tellWindow = {
          id: this.tellSeq,
          actionId: this.actionSeq,
          handId: this.handNo,
          street: d.street,
          bossAction: normalized.type,
          tier,
          strength,
        };
        events.push({
          type: 'tell_window_open',
          id: this.tellWindow.id,
          actionId: this.tellWindow.actionId,
          street: this.tellWindow.street,
          bossAction: normalized.type,
          strength,
        });
        this.pendingBossCounter = this.#evaluateBossCounter(normalized, bossPutRatio);
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

    // ⚠ v5（方案 §8）：心理与筹码分离 —— 输赢 pot 不再触发任何情绪事件。
    //    bluffCaught 仅用于 hand_end 的打击演出标记。
    const bluffCaught = r.type === 'showdown' && bossLost
      && this.handAggressiveIntents.some((a) => a.intent === 'BLUFF');

    // 摊牌记录进 Player Model
    if (r.type === 'showdown') {
      this.model.record('showdown', {
        playerWon: winner === PLAYER,
        playerAggressive: this.playerAggressive,
      });
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
    const entries = [];
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
      entries.push({ id: null, text: frag.text, atHand: this.handNo, type: frag.type });
    }
    // 整批保序插到最前
    this.readFragments.unshift(...entries);
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
    if (!pin || pin.verified || pin.type !== 'TRUE') return false;
    const intent = this.boss.currentIntent();
    if (!intent) return false;
    const rule = matchCrackRule(this.balance, pin, actionLabel, intent);
    if (!rule) return false;

    pin.verified = true;
    const crack = buildCrack(rule, pin, actionLabel, this.handNo, ++this.crackSeq);
    this.cracks.push({ ...crack, result: null });
    // v6 §9：CRACK 先入段（事件携带当前段数，供 CRACK ×N 大字）
    this.comboCount += 1;
    events.push({
      type: 'crack',
      id: crack.id,
      kind: crack.kind,
      evidence: crack.evidence,
      action: crack.action,
      strength: crack.strength,
      critical: crack.critical,
      handNo: crack.handNo,
      combo: this.comboCount,
    });
    this.#feed('crack', `CRACK${this.comboCount > 1 ? ` ×${this.comboCount}` : ''}! [${crack.kind}] ${crack.evidence.join(' + ')} × ${actionLabel} —— ${crack.why}`);
    // v6 §8：即时反馈链 = CRACK → Boss 受创台词 → 心理状态推进
    const react = pickCrackReact(this.rng);
    events.push({ type: 'talk', line: react });
    this.#feed('talk', react);
    this.#fire(events, 'CRACK');
    return true;
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

    // ---- ★ v5/v6 心理结算（顺序关键：必须在窗口清理之前）----
    // v6 §9 combo：命中 +1；有 Opening 却没命中（错过/判断失败）清零；无窗口的行动不计
    const openingWasOpen = Boolean(this.tellWindow);
    // 1) PIN 的真话 × 本次行动 × Boss 当前 intent → 可能 CRACK 并推进其心理
    const cracked = this.#validatePinCrack(events, displayAction); // 内部已 comboCount+1（并随事件下发）
    if (!cracked && openingWasOpen) this.comboCount = 0;           // 有 Opening 却未命中 = 清零
    // 2) Boss 反读陷阱：玩家命中被诱导的行为 → PLAYER CRACKED + 玩家心理推进
    this.#resolveBossCounter(events, displayAction);
    // 3) 回应落地 → 窗口关闭、碎片/PIN 全部清空（无论成败，方案 §2）
    this.#closeTellWindow();
    // 4) Focus 跨街授予（本行动可能推进了街）
    this.#grantFocus(preStreet, d.street);

    // ---- GOTCHA：阶梯翻倍 + 自动泄漏 ----
    if (this.mode === 'GOTCHA') {
      if (normalized.type === 'raise') this.#bumpRaiseStep();
      this.#maybeAutoLeak(events, normalized.type);
    }

    // ---- Player Model 记账（READ→HEAVY 等习惯；先置窗口再消费）----
    if (displayAction === 'pressure') this.model.record('pressure');
    const bossLast = this.lastBossAction;
    this.model.record('action', {
      action: displayAction,
      facingBet: (d.currentBet - d.committed[PLAYER]) > 0 || normalized.type === 'call' || normalized.type === 'raise',
      // §9 反读模式：面对重注家族（≥heavyFrac 或全下）的弃牌计数
      facingHeavy: Boolean(bossLast
        && bossLast.street === preStreet
        && (bossLast.action === 'allin' || (bossLast.ratio ?? 0) >= (this.balance.sizing?.heavyFrac ?? 1))),
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
   * READ（v5）：只在 Tell Window 内可用，消耗 Focus，一次返回一批碎片（一窗一批）。
   * TRUE 概率由「基础权重 + Boss行动Tell强度 + 街段 + 心理状态」公式决定（方案 §4）。
   * 类型与标签只在服务端；碎片 id 绑定窗口（w{windowId}f{n}）。
   */
  read() {
    if (this.mode === 'GOTCHA') {
      throw new GameError('GOTCHA 中自动泄漏，无需手动 READ', 'GOTCHA_AUTO_READ');
    }
    this.#requirePlayerTurn();
    const win = this.tellWindow;
    if (!win) {
      throw new GameError('当前没有心理窗口（等他先行动）', 'NO_TELL_WINDOW');
    }
    const focusCost = this.balance.focus?.cost ?? 1;
    if (this.focus < focusCost) throw new GameError('Focus 不足', 'NO_FOCUS');
    const t = this.now();
    if (t < this.readCooldownUntil) throw new GameError('READ 正在冷却', 'READ_COOLING');

    const events = [];
    const balance = this.balance;
    const rd = balance.read ?? {};
    const state = this.boss.state;
    // ★ 信息质量公式（§4）：真话浓度来自“他刚做了什么 + 第几条街 + 他什么状态”
    const trueRate = clamp01(
      (rd.baseTrueWeight ?? 0.2)
      + (rd.tellStrength?.[win.tier] ?? 0)
      + (rd.streetModifier?.[win.street] ?? 0)
      + (rd.stateModifier?.[state] ?? 0),
    );
    const intent = this.boss.currentIntent();
    const count = randomCount(balance.normalReadFragmentCount, this.rng);

    const fragments = [];
    const entries = [];
    for (let i = 0; i < count; i++) {
      const frag = makeFragment({
        state,
        intent,
        equity: this.boss.lastEquity,
        street: win.street,
        trueRate,
        balance,
        rng: this.rng,
      });
      const id = `w${win.id}f${i + 1}`;
      this.handFragments.set(id, {
        id,
        text: frag.text,
        type: frag.type,          // ★ 服务端私有
        tags: frag.tags.slice(),  // ★ 服务端私有
        desire: frag.desire ?? null, // ★ 服务端私有（选中后推导 HYPOTHESIS）
        fear: frag.fear ?? null,     // ★ 服务端私有
        strength: frag.strength,
        sourceAction: win.bossAction,
        binding: { handId: win.handId, street: win.street, actionId: win.actionId, tellWindowId: win.id },
      });
      fragments.push({ id, text: frag.text });
      entries.push({ id, text: frag.text, atHand: this.handNo, tellWindowId: win.id });
      this.#feed('read', frag.text);
    }
    // 整批按序插到面板最前（f0 在最上）：与闪现堆叠顺序一致
    this.readFragments.unshift(...entries);
    if (this.readFragments.length > 30) this.readFragments.length = 30;

    this.focus -= focusCost;
    this.readCooldownUntil = t + (rd.cooldownMs ?? 400);
    this.model.record('read');
    events.push({
      type: 'read_batch',
      source: 'manual',
      tellWindowId: win.id,
      actionId: win.actionId,
      flashMs: flashMs(state, balance),
      fragments,
    });
    return { view: this.view(), events };
  }

  /** PIN（v5）：保留当前心理窗口产出的一条碎片（单槽，新覆盖旧）。玩家只见 text。 */
  pin(fragmentId) {
    this.#requirePlayerTurn();
    const meta = this.handFragments.get(String(fragmentId));
    // 生命周期（方案 §2）：跨窗口/手牌的旧碎片一律不可保留
    if (!meta || !this.tellWindow || meta.binding?.tellWindowId !== this.tellWindow.id) {
      throw new GameError('这条碎片不属于当前心理窗口', 'BAD_FRAGMENT');
    }
    this.pinned = {
      fragmentId: meta.id,
      text: meta.text,
      type: meta.type,
      tags: meta.tags.slice(),
      desire: meta.desire ?? null,   // v6 §5：他希望你…（服务端私有）
      fear: meta.fear ?? null,       // v6 §5：他害怕你…
      sourceAction: meta.sourceAction,
      binding: meta.binding,
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
    if (this.mode !== 'NORMAL') throw new GameError('已经处于 GOTCHA 中', 'ALREADY_GOTCHA');
    // ★ v5（§11）：资格 = EXPOSED；时机 = TURN/RIVER × Boss 高承诺行动（本街）× 玩家回合
    if (!this.#gotchaWindowOpen(d)) {
      throw new GameError('GOTCHA 窗口未开启（需 EXPOSED + 转牌/河牌 + 他刚高承诺下注）', 'GOTCHA_WINDOW_CLOSED');
    }
    if (d.allIn[0] || d.allIn[1]) throw new GameError('已有人全下，无法进入负债状态', 'GOTCHA_LOCKED');

    this.mode = 'GOTCHA';
    d.debtMode = true;
    this.gotchaDepth = 0;
    this.gotchaRaiseStep = Math.max(d.lastRaiseSize, d.bigBlind);
    this.enteredGotchaThisHand = true;

    events.push({ type: 'mode', mode: 'GOTCHA' });
    this.#feed('gotcha', 'GOTCHA！双方解除筹码上限 —— 负债下注开始（资格：EXPOSED × 时机：本街高承诺行动）');
    this.#feed('mode', 'GOTCHA · 临时余额可以为负，FOLD/SHOWDOWN 统一结算');
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

    // ★ GOTCHA 窗口（§11）：资格（EXPOSED）× 时机（TURN/RIVER × 高承诺行动 × 玩家回合）
    const gotchaArmed = this.#gotchaWindowOpen(d)
      ? { street: d.street, bossAction: this.lastBossAction.action }
      : null;

    return {
      phase: this.phase,
      handNo: d.handNo,
      street: d.street,
      pot: d.pot,
      board: d.board.slice(),
      button: d.button,
      toAct: playing ? d.toAct : null,
      // 心理窗口（READ 的唯一可用时机；tier 是内部信息，剥掉）
      tellWindow: this.tellWindow
        ? {
            id: this.tellWindow.id,
            actionId: this.tellWindow.actionId,
            handId: this.tellWindow.handId,
            street: this.tellWindow.street,
            bossAction: this.tellWindow.bossAction,
            strength: this.tellWindow.strength,   // v6：WEAK/NORMAL/STRONG
          }
        : null,
      // v6 §3：HYPOTHESIS —— 选中碎片推导出的「他希望/害怕你做什么」
      hypothesis: (() => {
        if (!this.pinned) return null;
        if (this.pinned.desire) return { mode: 'want', action: this.pinned.desire };
        if (this.pinned.fear) return { mode: 'fear', action: this.pinned.fear };
        return null; // 噪音/无可利用语义 → 无判断（CRACK 也不可能成立）
      })(),
      // v6 §9：连续 CRACK 段数（仅 UI/GOTCHA 前置参考）
      comboCount: this.comboCount,
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
        // ★ Focus（§3）：翻前0，进街+1，上限 focusMax；READ 消耗 cost
        focus: this.focus,
        focusMax: this.focusMax,
        readCooldownUntil: this.readCooldownUntil,
        // ★ 玩家心理状态（§10，与 Boss 对称的三态；当前只展示）
        state: this.playerState,
        face: FACES[this.playerState] ?? FACES.CALM,
        mood: MOODS[this.playerState] ?? MOODS.CALM,
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
      readFragments: this.readFragments.map((f) => ({ id: f.id ?? null, text: f.text, atHand: f.atHand, tellWindowId: f.tellWindowId ?? null })),
      feed: this.feed.slice(),
    };
  }
}
