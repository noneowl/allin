/**
 * Heads-Up No-Limit Texas Hold'em —— 单挑无限注德州状态机。
 *
 * 纯规则层：盲注、四条街、最小加注、BB 选项、短筹码全下不重开加注、
 * 未跟注部分退还、全下自动发完公共牌、摊牌/分池、按钮轮换。
 *
 * 心理层（台词 / READ / 矛盾 / 异议）不在这里，全部在上层 battle.js。
 * 座位约定：0 = 玩家，1 = Boss。
 *
 * 事件是普通对象数组，由本层产出、上层补充后按顺序下发给客户端：
 *   { type: 'blinds' | 'action' | 'street' | 'fold_win' | 'showdown', ... }
 */
import { evaluate } from './evaluator.js';

export class GameError extends Error {
  constructor(message, code = 'ILLEGAL_ACTION') {
    super(message);
    this.name = 'GameError';
    this.code = code;
  }
}

const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v))));

export class Duel {
  constructor({ stacks = [1000, 1000], smallBlind = 10, bigBlind = 20, button = 0, handNo = 1 } = {}) {
    this.stacks = stacks.slice();
    this.smallBlind = smallBlind;
    this.bigBlind = bigBlind;
    this.button = button & 1;
    this.handNo = handNo;
    this.phase = 'idle'; // idle | playing | handover
    this.street = 'preflop';
    this.deck = [];
    this.hole = [[], []];
    this.board = [];
    this.committed = [0, 0]; // 本街投入
    this.total = [0, 0]; // 本手累计投入（已含退还修正）
    this.folded = [false, false];
    this.allIn = [false, false];
    this.acted = [false, false];
    this.mayRaise = [true, true];
    this.currentBet = 0;
    this.lastRaiseSize = bigBlind;
    this.toAct = null;
    this.result = null;
    this.lastPut = [0, 0]; // 每次行动投入了多少（筹码动画用）
  }

  get pot() {
    return this.total[0] + this.total[1];
  }

  // ------------------------------------------------------------------ 开局

  /**
   * 发一手牌。
   * @param {{deck?: string[], button?: number}} [opts] 测试可注入整副牌序
   * @returns {object[]} 事件
   */
  startHand(opts = {}) {
    if (opts.button !== undefined) this.button = opts.button & 1;
    const deck = opts.deck ? opts.deck.slice() : null;
    if (deck && deck.length !== 52) throw new GameError('注入的牌堆必须是 52 张', 'BAD_DECK');

    this.phase = 'playing';
    this.street = 'preflop';
    this.deck = deck ?? freshDeck();
    this.board = [];
    this.hole = [[], []];
    this.committed = [0, 0];
    this.total = [0, 0];
    this.folded = [false, false];
    this.allIn = [false, false];
    this.acted = [false, false];
    this.mayRaise = [true, true];
    this.currentBet = 0;
    this.lastRaiseSize = this.bigBlind;
    this.result = null;
    this.lastPut = [0, 0];

    // 单挑：庄家下小盲，翻前先行动；非庄家下大盲。
    const sbSeat = this.button;
    const bbSeat = 1 - this.button;
    this.hole[0] = [this._draw(), this._draw()];
    this.hole[1] = [this._draw(), this._draw()];

    const events = [];
    events.push(this._postBlind(sbSeat, this.smallBlind));
    events.push(this._postBlind(bbSeat, this.bigBlind));
    this.currentBet = Math.max(this.committed[0], this.committed[1]);
    this.lastRaiseSize = this.bigBlind;
    this.toAct = this.button;
    return events;
  }

  _draw() {
    if (this.deck.length === 0) throw new GameError('牌堆已空', 'DECK_EMPTY');
    return this.deck.pop();
  }

  _postBlind(seat, amount) {
    const put = Math.min(amount, this.stacks[seat]);
    this.stacks[seat] -= put;
    this.committed[seat] += put;
    this.total[seat] += put;
    this.lastPut[seat] = put;
    if (this.stacks[seat] === 0) this.allIn[seat] = true;
    return { type: 'blinds', seat, amount: put, potAfter: this.pot };
  }

  // ------------------------------------------------------------------ 合法动作

  legal(seat) {
    const out = [];
    if (this.phase !== 'playing' || this.folded[seat]) return out;
    const stack = this.stacks[seat];
    const toCall = this.currentBet - this.committed[seat];

    if (toCall > 0) {
      out.push({ type: 'fold' });
      out.push({ type: 'call', amount: Math.min(stack, toCall) });
    } else {
      out.push({ type: 'check' });
    }

    if (stack > 0) {
      const maxTo = this.committed[seat] + stack;
      if (this.mayRaise[seat]) {
        if (this.currentBet === 0) {
          out.push({ type: 'bet', minTo: Math.min(this.bigBlind, maxTo), maxTo });
        } else if (maxTo > this.currentBet) {
          const minTo = Math.min(this.currentBet + this.lastRaiseSize, maxTo);
          out.push({ type: 'raise', minTo, maxTo });
        }
      }
      out.push({ type: 'allin', to: maxTo });
    }
    return out;
  }

  // ------------------------------------------------------------------ 行动

  /**
   * 执行一个动作。
   * @param {number} seat 0=玩家 1=Boss
   * @param {{action:string, amount?:number}} cmd bet/raise 的 amount 语义为 raise-to
   * @returns {{ normalized: object, events: object[] }}
   */
  act(seat, cmd) {
    if (this.phase !== 'playing') throw new GameError('本手已经结束', 'NOT_PLAYING');
    if (this.toAct !== seat) throw new GameError('还没轮到你行动', 'NOT_YOUR_TURN');

    const options = this.legal(seat);
    const byType = new Map(options.map((o) => [o.type, o]));
    const raw0 = String(cmd?.action ?? '').toLowerCase();
    const raw = raw0 === 'all_in' ? 'allin' : raw0; // 兼容两种写法
    // bet/raise 是同一件事，按当前有没有价自动归一
    const action = raw === 'raise' && !byType.has('raise') && byType.has('bet') ? 'bet'
      : raw === 'bet' && !byType.has('bet') && byType.has('raise') ? 'raise'
      : raw;

    const events = [];

    if (action === 'fold') {
      if (!byType.has('fold')) throw new GameError('没有注可以弃', 'CANNOT_FOLD');
      this.folded[seat] = true;
      this.acted[seat] = true;
      this.toAct = null;
      const winner = 1 - seat;
      this._settleRefund();
      this._awardUncontested(winner);
      events.push({ type: 'fold_win', winner });
      return { normalized: { type: 'fold', seat, put: 0 }, events };
    }

    if (action === 'check') {
      if (!byType.has('check')) throw new GameError('面对下注不能过牌', 'MUST_RESPOND');
      this.acted[seat] = true;
      this.mayRaise[seat] = false;
      this.lastPut[seat] = 0;
      events.push({ type: 'action', seat, action: 'check', amount: this.committed[seat], put: 0, potAfter: this.pot, allIn: false });
      this._advanceOrClose(seat, { raises: false, fullRaise: false }, events);
      return { normalized: { type: 'check', seat, put: 0 }, events };
    }

    let to;
    if (action === 'call') {
      const opt = byType.get('call');
      if (!opt) throw new GameError('没有注需要跟', 'NOTHING_TO_CALL');
      to = this.committed[seat] + opt.amount;
    } else if (action === 'bet' || action === 'raise') {
      const opt = byType.get(action);
      if (!opt) throw new GameError(action === 'bet' ? '当前不能下注' : '当前不能加注', 'CANNOT_RAISE');
      const want = Number(cmd?.amount);
      to = clampInt(Number.isFinite(want) ? want : opt.minTo, opt.minTo, opt.maxTo);
    } else if (action === 'allin') {
      const opt = byType.get('allin');
      if (!opt) throw new GameError('没有筹码可全下', 'NO_CHIPS');
      to = opt.to;
    } else {
      throw new GameError(`不合法的动作：${raw}`, 'ILLEGAL_ACTION');
    }

    const prevCommitted = this.committed[seat];
    const prevBet = this.currentBet;
    const put = to - prevCommitted;
    if (put > this.stacks[seat]) throw new GameError('筹码不足', 'SHORT_STACK');

    this.stacks[seat] -= put;
    this.total[seat] += put;
    this.committed[seat] = to;
    this.lastPut[seat] = put;
    if (this.stacks[seat] === 0) this.allIn[seat] = true;
    this.acted[seat] = true;

    // 是否抬价（开注 / 加注）
    const raises = to > prevBet;
    let fullRaise = false;
    let type = 'call';
    if (raises) {
      fullRaise = prevBet === 0 ? true : to - prevBet >= this.lastRaiseSize;
      if (fullRaise) this.lastRaiseSize = prevBet === 0 ? to : to - prevBet;
      this.currentBet = to;
      if (fullRaise) this.mayRaise[1 - seat] = true;
      this.mayRaise[seat] = false;
      type = prevBet === 0 ? 'bet' : 'raise';
      if (this.allIn[seat] && !fullRaise) type = 'allin'; // 短筹码抬价（不重开加注）
    } else if (this.allIn[seat]) {
      type = 'allin';
    }

    const event = { type: 'action', seat, action: type, amount: to, put, potAfter: 0, allIn: this.allIn[seat] };
    events.push(event);
    this._settleRefund();
    event.potAfter = this.pot;
    this._advanceOrClose(seat, { raises, fullRaise }, events);
    return { normalized: { type, seat, to, put }, events };
  }

  // ------------------------------------------------------------------ 推进

  /** 未被跟注的筹码退还：弃牌结算时无条件；仍在手时仅当落后方已全下。 */
  _settleRefund() {
    const diff = this.total[0] - this.total[1];
    if (diff === 0) return;
    const hi = diff > 0 ? 0 : 1;
    const lo = 1 - hi;
    const settledByFold = this.folded[0] || this.folded[1];
    if (!settledByFold && this.stacks[lo] !== 0) return;
    const excess = this.total[hi] - this.total[lo];
    if (excess > 0) {
      this.total[hi] -= excess;
      this.committed[hi] -= excess;
      this.stacks[hi] += excess;
    }
  }

  _advanceOrClose(actor, { raises, fullRaise }, events) {
    const other = 1 - actor;
    if (this.folded[other] || this.folded[actor]) return; // 已在 act() 里结算完毕

    // 注码不齐：落后方还有筹码就必须回应
    if (this.committed[other] !== this.committed[actor] && this.stacks[other] > 0) {
      this.toAct = other;
      return;
    }

    // 注码相齐
    if (this.allIn[0] || this.allIn[1]) {
      this.toAct = null;
      this._runout(events);
      return;
    }
    if (!this.acted[other]) {
      this.toAct = other; // 含 BB 选项、翻后首个行动者
      return;
    }
    if (raises && fullRaise) {
      this.toAct = other; // 完整加注重开行动
      return;
    }
    this.toAct = null;
    this._nextStreet(events);
  }

  _nextStreet(events) {
    if (this.street === 'river') {
      this._showdown(events);
      return;
    }
    const next = this.street === 'preflop' ? 'flop' : this.street === 'flop' ? 'turn' : 'river';
    this.street = next;
    const count = next === 'flop' ? 3 : 1;
    const cards = [];
    this._draw(); // burn
    for (let i = 0; i < count; i++) cards.push(this._draw());
    this.board.push(...cards);
    this.committed = [0, 0];
    this.acted = [false, false];
    this.mayRaise = [true, true];
    this.currentBet = 0;
    this.lastRaiseSize = this.bigBlind;
    this.lastPut = [0, 0];
    events.push({ type: 'street', street: next, cards });
    this.toAct = 1 - this.button; // 翻后非庄家先行动
  }

  /** 全下后把剩余街发完再摊牌。 */
  _runout(events) {
    while (this.street !== 'river') {
      const next = this.street === 'preflop' ? 'flop' : this.street === 'flop' ? 'turn' : 'river';
      this.street = next;
      const count = next === 'flop' ? 3 : 1;
      const cards = [];
      this._draw();
      for (let i = 0; i < count; i++) cards.push(this._draw());
      this.board.push(...cards);
      events.push({ type: 'street', street: next, cards });
    }
    this.committed = [0, 0];
    this._showdown(events);
  }

  _awardUncontested(winner) {
    const pot = this.pot;
    this.stacks[winner] += pot;
    this.total = [0, 0];
    this.committed = [0, 0];
    this.phase = 'handover';
    this.result = { type: 'fold', winner, pot, uncontested: true };
    this.toAct = null;
  }

  _showdown(events) {
    if (this.result) return;
    this._settleRefund();
    const pot = this.pot;
    const live = [0, 1].filter((s) => !this.folded[s]);
    const scored = live
      .map((seat) => {
        const ev = evaluate([...this.hole[seat], ...this.board]);
        return { seat, handName: ev.nameZh, best5: ev.best5, score: ev.score };
      })
      .sort((a, b) => b.score - a.score);

    let winner;
    let split = false;
    if (scored.length === 1) winner = scored[0].seat;
    else if (scored[0].score === scored[1].score) {
      winner = 'split';
      split = true;
    } else winner = scored[0].seat;

    const hands = live.map((seat) => {
      const s = scored.find((x) => x.seat === seat);
      return {
        seat,
        hole: this.hole[seat].slice(),
        handName: s.handName,
        best5: s.best5,
        winner: split ? true : s.seat === winner,
      };
    });

    if (split) {
      const half = Math.floor(pot / 2);
      this.stacks[0] += half;
      this.stacks[1] += pot - half;
    } else {
      this.stacks[winner] += pot;
    }
    this.total = [0, 0];
    this.committed = [0, 0];
    this.phase = 'handover';
    this.result = { type: 'showdown', winner, pot, split, hands };
    this.toAct = null;
    events.push({ type: 'showdown', hands, split });
  }

  /** 本手合法性快照，供上层做视图。 */
  snapshot() {
    return {
      handNo: this.handNo,
      phase: this.phase,
      street: this.street,
      pot: this.pot,
      board: this.board.slice(),
      button: this.button,
      toAct: this.toAct,
      stacks: this.stacks.slice(),
      committed: this.committed.slice(),
      result: this.result,
    };
  }
}

/** 构造并洗好一副 52 张牌。 */
function freshDeck() {
  const RANKS = '23456789TJQKA';
  const SUITS = ['s', 'h', 'd', 'c'];
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(r + s);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
