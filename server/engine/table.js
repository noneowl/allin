import { makeDeck, shuffle, cardText } from './cards.js';
import { evaluate, describeMadeHand } from './evaluator.js';
import { buildPots, returnUncalled, totalPot } from './pots.js';

export const STREETS = ['preflop', 'flop', 'turn', 'river'];

export const STREET_LABEL = {
  preflop: '翻牌前',
  flop: '翻牌圈',
  turn: '转牌圈',
  river: '河牌圈',
  showdown: '摊牌',
};

export class GameError extends Error {
  constructor(message, code = 'GAME_ERROR') {
    super(message);
    this.name = 'GameError';
    this.code = code;
  }
}

const POSITION_NAMES_BY_COUNT = {
  2: ['BTN/SB', 'BB'],
  3: ['BTN', 'SB', 'BB'],
  4: ['BTN', 'SB', 'BB', 'UTG'],
  5: ['BTN', 'SB', 'BB', 'UTG', 'CO'],
  6: ['BTN', 'SB', 'BB', 'UTG', 'HJ', 'CO'],
  7: ['BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'HJ', 'CO'],
  8: ['BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'MP', 'HJ', 'CO'],
  9: ['BTN', 'SB', 'BB', 'UTG', 'UTG+1', 'MP', 'MP+1', 'HJ', 'CO'],
};

/**
 * No-limit Texas Hold'em table.
 *
 * The table owns all authoritative state. It is fully synchronous: the async
 * AI orchestration lives in the game controller, never here.
 */
export class Table {
  constructor(options = {}) {
    const players = options.players ?? [];
    if (players.length < 2 || players.length > 9) {
      throw new GameError('需要 2 到 9 名玩家', 'BAD_TABLE');
    }

    this.smallBlind = options.smallBlind ?? 10;
    this.bigBlind = options.bigBlind ?? 20;
    this.startingStack = options.startingStack ?? 2000;
    this.rng = options.rng ?? null;
    this.maxLog = options.maxLog ?? 300;

    this.seats = players.map((p, i) => ({
      seat: i,
      name: p.name || `Player ${i + 1}`,
      avatar: p.avatar || '🙂',
      isHuman: Boolean(p.isHuman),
      personality: p.personality || null,
      provider: p.provider || null,
      model: p.model || null,
      stack: p.stack ?? this.startingStack,
      committed: 0,
      totalCommitted: 0,
      folded: false,
      allIn: false,
      out: false,
      hole: [],
      acted: false,
      mayRaise: true,
      lastAction: null,
      revealed: false,
      result: null,
    }));

    this.handId = 0;
    this.buttonIndex = -1;
    this.phase = 'idle'; // idle | playing | showdown | handover | gameover
    this.street = null;
    this.board = [];
    this.deck = [];
    this.pots = [];
    this.currentBet = 0;
    this.minRaiseTo = 0;
    this.lastRaiseSize = 0;
    this.lastFullRaiseTo = 0;
    this.toAct = null;
    this.lastAggressor = null;
    this.sbSeat = null;
    this.bbSeat = null;
    this.handResult = null;
    this.handLog = [];
    this.log = [];
    this._logId = 0;
  }

  // ---------------------------------------------------------------- helpers

  get seatCount() {
    return this.seats.length;
  }

  get liveSeats() {
    return this.seats.filter((s) => !s.out && !s.folded);
  }

  get inHandSeats() {
    return this.seats.filter((s) => !s.out && s.hole.length > 0);
  }

  /** Total chips currently in the middle (including this street's commitments). */
  get potTotal() {
    return this.seats.reduce((sum, s) => sum + s.totalCommitted, 0);
  }

  seatAt(index) {
    return this.seats[((index % this.seatCount) + this.seatCount) % this.seatCount];
  }

  #nextOccupied(from, predicate) {
    for (let i = 1; i <= this.seatCount; i++) {
      const idx = (((from + i) % this.seatCount) + this.seatCount) % this.seatCount;
      if (predicate(this.seats[idx])) return idx;
    }
    return null;
  }

  #nextWithChips = (from) => this.#nextOccupied(from, (s) => !s.out && s.stack > 0);

  #nextPendingSeat(from) {
    for (let i = 1; i <= this.seatCount; i++) {
      const idx = (((from + i) % this.seatCount) + this.seatCount) % this.seatCount;
      const s = this.seats[idx];
      if (s.out || s.folded || s.allIn) continue;
      if (!s.acted || s.committed < this.currentBet) return idx;
    }
    return null;
  }

  #orderFromButton(seatIndexes) {
    const n = this.seatCount;
    return seatIndexes.slice().sort((a, b) => ((a - this.buttonIndex + n) % n) - ((b - this.buttonIndex + n) % n));
  }

  #log(text, kind = 'action', seat = null, extra = {}) {
    const entry = {
      id: ++this._logId,
      handId: this.handId,
      street: this.street,
      seat,
      name: seat === null ? null : this.seats[seat]?.name ?? null,
      text,
      kind,
      ts: Date.now(),
      ...extra,
    };
    this.log.push(entry);
    if (this.log.length > this.maxLog) this.log.splice(0, this.log.length - this.maxLog);
    this.handLog.push(entry);
    return entry;
  }

  /**
   * Append a client-facing feed entry from outside the engine (AI reasoning,
   * table talk, provider failures). Keeps a single monotonic id space so the
   * browser can append incrementally.
   */
  addLog(entry) {
    const item = {
      id: ++this._logId,
      handId: this.handId,
      street: this.street,
      ts: Date.now(),
      ...entry,
    };
    this.log.push(item);
    if (this.log.length > this.maxLog) this.log.splice(0, this.log.length - this.maxLog);
    return item;
  }

  #draw(n) {    const cards = [];
    for (let i = 0; i < n; i++) {
      const c = this.deck.pop();
      if (!c) throw new GameError('牌堆已空', 'DECK_EMPTY');
      cards.push(c);
    }
    return cards;
  }

  // ------------------------------------------------------------- hand setup

  /** Positions for the current street, keyed by seat, e.g. "BTN", "CO", "BB". */
  positionLabels() {
    const contenders = this.seats.filter((s) => !s.out);
    const n = contenders.length;
    const names = POSITION_NAMES_BY_COUNT[n] || POSITION_NAMES_BY_COUNT[9];
    const labels = {};
    if (this.buttonIndex < 0 || !names) return labels;
    for (let i = 0; i < n; i++) {
      const seat = this.#nextOccupiedRaw(this.buttonIndex, i, (s) => !s.out);
      if (seat === null) break;
      labels[seat] = names[i];
    }
    return labels;
  }

  #nextOccupiedRaw(from, offset, predicate) {
    if (offset === 0) return predicate(this.seats[from]) ? from : null;
    for (let i = 1; i <= this.seatCount; i++) {
      const idx = (((from + i) % this.seatCount) + this.seatCount) % this.seatCount;
      if (!predicate(this.seats[idx])) continue;
      if (--offset === 0) return idx;
    }
    return null;
  }

  /** True when the table can no longer deal a hand. */
  isGameOver() {
    return this.seats.filter((s) => !s.out && s.stack > 0).length < 2;
  }

  /** Deal a new hand. Returns false when the game is over. */
  startHand() {
    if (this.phase === 'playing') throw new GameError('当前手牌尚未结束', 'HAND_IN_PROGRESS');

    for (const s of this.seats) if (s.stack <= 0) s.out = true;

    if (this.isGameOver()) {
      this.phase = 'gameover';
      this.street = null;
      this.toAct = null;
      this.#log('牌局结束', 'system');
      return false;
    }

    this.handId += 1;
    this.handLog = [];
    this.board = [];
    this.deck = shuffle(makeDeck(), this.rng);
    this.phase = 'playing';
    this.street = 'preflop';
    this.pots = [];
    this.handResult = null;
    this.currentBet = 0;
    this.minRaiseTo = 0;
    this.lastRaiseSize = this.bigBlind;
    this.lastFullRaiseTo = 0;
    this.lastAggressor = null;

    for (const s of this.seats) {
      s.committed = 0;
      s.totalCommitted = 0;
      s.folded = s.out;
      s.allIn = false;
      s.hole = [];
      s.acted = false;
      s.mayRaise = true;
      s.lastAction = null;
      s.revealed = false;
      s.result = null;
    }

    this.buttonIndex = this.#nextWithChips(this.buttonIndex < 0 ? this.seatCount - 1 : this.buttonIndex - 1);
    const contenders = this.seats.filter((s) => !s.out).length;

    if (contenders === 2) {
      this.sbSeat = this.buttonIndex;
      this.bbSeat = this.#nextOccupied(this.buttonIndex, (s) => !s.out);
    } else {
      this.sbSeat = this.#nextOccupied(this.buttonIndex, (s) => !s.out);
      this.bbSeat = this.#nextOccupied(this.sbSeat, (s) => !s.out);
    }

    // Deal two cards each, starting left of the button.
    let cursor = this.buttonIndex;
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < contenders; i++) {
        cursor = this.#nextOccupied(cursor, (s) => !s.out);
        this.seats[cursor].hole.push(this.#draw(1)[0]);
      }
    }

    this.#log(`—— 第 ${this.handId} 手 —— 盲注 ${this.smallBlind}/${this.bigBlind}`, 'system');
    this.#postBlind(this.sbSeat, this.smallBlind, 'sb');
    this.#postBlind(this.bbSeat, this.bigBlind, 'bb');

    // The big blind is a full bet even when the poster was too short to cover it.
    this.currentBet = this.bigBlind;
    this.lastRaiseSize = this.bigBlind;
    this.lastFullRaiseTo = this.bigBlind;
    this.minRaiseTo = this.bigBlind * 2;
    this.lastAggressor = this.bbSeat;

    for (const s of this.seats) s.acted = false;

    const firstToAct = contenders === 2 ? this.sbSeat : this.#nextOccupied(this.bbSeat, (s) => !s.out);
    const start = this.#nextPendingSeat(firstToAct - 1);

    if (start === null) {
      // Everyone is already all-in from the blinds.
      this.toAct = null;
      this.#endStreet(0);
    } else {
      this.toAct = start;
    }
    return true;
  }

  #postBlind(seatIndex, amount, kind) {
    const s = this.seats[seatIndex];
    const pay = Math.min(amount, s.stack);
    s.stack -= pay;
    s.committed += pay;
    s.totalCommitted += pay;
    if (s.stack === 0) s.allIn = true;
    s.lastAction = { type: kind === 'sb' ? 'post_sb' : 'post_bb', amount: pay };
    this.#log(`${s.name} 下${kind === 'sb' ? '小' : '大'}盲 ${pay}`, 'blind', s.seat, { amount: pay });
  }

  // ----------------------------------------------------------- action logic

  currentSeat() {
    return this.toAct === null ? null : this.seats[this.toAct];
  }

  /** Legal action menu for a seat. Always includes fold when it is their turn. */
  legalActions(seatIndex) {
    const s = this.seats[seatIndex];
    const out = [];
    if (!s || this.phase !== 'playing' || this.toAct !== seatIndex) return out;
    if (s.folded || s.allIn || s.out) return out;

    const toCall = Math.max(0, this.currentBet - s.committed);
    const maxTo = s.committed + s.stack;

    out.push({ type: 'fold' });
    if (toCall === 0) out.push({ type: 'check' });
    else out.push({ type: 'call', amount: Math.min(toCall, s.stack), toCall });

    if (s.mayRaise) {
      const isOpen = this.currentBet === 0;
      const minTo = isOpen ? this.bigBlind : this.minRaiseTo;
      if (maxTo > this.currentBet && maxTo >= minTo) {
        out.push({
          type: isOpen ? 'bet' : 'raise',
          minTo,
          maxTo,
          toCall,
        });
      }
    }
    if (s.stack > 0 && maxTo > this.currentBet) {
      out.push({ type: 'all_in', to: maxTo, toCall });
    }
    return out;
  }

  /**
   * A single forced action, when the rules leave exactly one sensible choice.
   * This is rules-derived bookkeeping, not a strategic decision: with nothing
   * to call and no ability to bet, checking is the only legal non-folding play.
   */
  forcedAction(seatIndex) {
    const legal = this.legalActions(seatIndex);
    if (!legal.length) return null;
    const toCall = Math.max(0, this.currentBet - this.seats[seatIndex].committed);
    const canBet = legal.some((a) => a.type === 'bet' || a.type === 'raise' || a.type === 'all_in');
    if (toCall === 0 && !canBet && legal.some((a) => a.type === 'check')) return { type: 'check' };
    return null;
  }

  /**
   * Apply an action for the seat on turn.
   * @throws {GameError} when the action is illegal for the current state.
   */
  applyAction(seatIndex, action) {
    if (this.phase !== 'playing') throw new GameError('当前不在下注阶段', 'NOT_PLAYING');
    if (this.toAct !== seatIndex) throw new GameError('还没轮到该玩家行动', 'NOT_YOUR_TURN');
    const s = this.seats[seatIndex];
    const legal = this.legalActions(seatIndex);
    if (!legal.length) throw new GameError('该玩家当前无法行动', 'NO_ACTIONS');

    const normalized = this.normalizeAction(seatIndex, action, legal);
    const toCallBefore = Math.max(0, this.currentBet - s.committed);

    switch (normalized.type) {
      case 'fold': {
        s.folded = true;
        s.acted = true;
        s.lastAction = { type: 'fold' };
        this.#log(`${s.name} 弃牌`, 'action', s.seat, { action: 'fold' });
        break;
      }
      case 'check': {
        s.acted = true;
        s.lastAction = { type: 'check' };
        this.#log(`${s.name} 过牌`, 'action', s.seat, { action: 'check' });
        break;
      }
      case 'call': {
        const pay = Math.min(toCallBefore, s.stack);
        this.#commitTo(s, s.committed + pay);
        s.acted = true;
        s.lastAction = { type: 'call', amount: pay };
        this.#log(
          pay === 0 ? `${s.name} 过牌` : `${s.name} 跟注 ${pay}${s.allIn ? '（全下）' : ''}`,
          'action',
          s.seat,
          { action: 'call', amount: pay },
        );
        break;
      }
      case 'bet':
      case 'raise': {
        const to = normalized.to;
        const wasOpen = this.currentBet === 0;
        const raiseSize = to - this.currentBet;
        const isFullRaise = wasOpen || raiseSize >= this.lastRaiseSize;
        // Players who already acted cannot re-raise over a short all-in.
        const previouslyActed = this.seats.filter(
          (o) => o.seat !== s.seat && o.acted && !o.folded && !o.allIn,
        );

        this.#commitTo(s, to);
        this.currentBet = to;
        this.lastAggressor = s.seat;
        if (isFullRaise) {
          this.lastRaiseSize = wasOpen ? to : raiseSize;
          this.lastFullRaiseTo = to;
          this.minRaiseTo = to + this.lastRaiseSize;
          for (const o of this.seats) o.mayRaise = true;
        } else {
          for (const o of previouslyActed) o.mayRaise = false;
        }
        for (const o of this.seats) if (o.seat !== s.seat) o.acted = false;
        s.acted = true;
        s.lastAction = { type: wasOpen ? 'bet' : 'raise', amount: to };
        this.#log(
          `${s.name} ${wasOpen ? '下注' : '加注到'} ${to}${s.allIn ? '（全下）' : ''}`,
          'action',
          s.seat,
          { action: wasOpen ? 'bet' : 'raise', amount: to },
        );
        break;
      }
      case 'all_in': {
        const to = s.committed + s.stack;
        const wasOpen = this.currentBet === 0;
        if (to <= this.currentBet) {
          // All-in for less than the current bet: it is simply a call.
          const pay = Math.min(toCallBefore, s.stack);
          this.#commitTo(s, s.committed + pay);
          s.acted = true;
          s.lastAction = { type: 'call', amount: pay, allIn: true };
          this.#log(`${s.name} 全下跟注 ${pay}`, 'action', s.seat, { action: 'call', amount: pay, allIn: true });
          break;
        }
        const raiseSize = to - this.currentBet;
        const isFullRaise = wasOpen || raiseSize >= this.lastRaiseSize;
        const previouslyActed = this.seats.filter(
          (o) => o.seat !== s.seat && o.acted && !o.folded && !o.allIn,
        );
        this.#commitTo(s, to);
        this.currentBet = to;
        this.lastAggressor = s.seat;
        if (isFullRaise) {
          this.lastRaiseSize = wasOpen ? to : raiseSize;
          this.lastFullRaiseTo = to;
          this.minRaiseTo = to + this.lastRaiseSize;
          for (const o of this.seats) o.mayRaise = true;
        } else {
          for (const o of previouslyActed) o.mayRaise = false;
        }
        for (const o of this.seats) if (o.seat !== s.seat) o.acted = false;
        s.acted = true;
        s.lastAction = { type: 'all_in', amount: to };
        this.#log(`${s.name} 全下 ${to}`, 'action', s.seat, { action: 'all_in', amount: to });
        break;
      }
      default:
        throw new GameError(`未知动作：${normalized.type}`, 'UNKNOWN_ACTION');
    }

    this.#progress();
    return normalized;
  }

  /**
   * Coerce a requested action into a legal one, clamping amounts into range.
   * Amounts are "raise-to" (total committed on this street), not "raise-by".
   */
  normalizeAction(seatIndex, action, legal = this.legalActions(seatIndex)) {
    const s = this.seats[seatIndex];
    const raw = action && typeof action === 'object' ? action : { action };
    const byType = new Map(legal.map((a) => [a.type, a]));

    const alias = {
      allin: 'all_in',
      all_in: 'all_in',
      shove: 'all_in',
      jam: 'all_in',
      push: 'all_in',
      bet: 'bet',
      raise: 'raise',
      call: 'call',
      check: 'check',
      fold: 'fold',
    };
    let type = String(raw.action ?? raw.type ?? '')
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '_');
    type = alias[type] ?? type;

    // A model may say "raise" when opening the betting, or "bet" when facing one.
    if (type === 'raise' && !byType.has('raise') && byType.has('bet')) type = 'bet';
    if (type === 'bet' && !byType.has('bet') && byType.has('raise')) type = 'raise';

    // Shoving for less than the current bet is just an all-in call.
    if (type === 'all_in' && !byType.has('all_in') && byType.has('call')) type = 'call';

    if (!byType.has(type)) {
      const allowed = legal.map((a) => a.type).join(', ');
      throw new GameError(`动作 "${raw.action}" 不合法，当前可用：${allowed}`, 'ILLEGAL_ACTION');
    }

    if (type === 'fold' || type === 'check' || type === 'call') return { type };
    if (type === 'all_in') return { type: 'all_in', to: byType.get('all_in').to };

    const spec = byType.get(type);
    let to = Number(raw.amount ?? raw.to ?? raw.raiseTo ?? raw.raise_to ?? raw.total);
    if (!Number.isFinite(to)) {
      throw new GameError(`${type} 需要一个数字 amount（本街总投入额），实际收到：${JSON.stringify(raw.amount)}`, 'BAD_AMOUNT');
    }
    to = Math.round(to);
    const clamped = Math.max(spec.minTo, Math.min(spec.maxTo, to));
    return { type, to: clamped, clamped: clamped !== to, requested: to };
  }

  #commitTo(seat, to) {
    const pay = to - seat.committed;
    if (pay < 0) throw new GameError('投入额不能减少', 'BAD_COMMIT');
    seat.stack -= pay;
    seat.committed = to;
    seat.totalCommitted += pay;
    if (seat.stack === 0) seat.allIn = true;
  }

  // ------------------------------------------------------------ progression

  #progress() {
    const live = this.liveSeats;
    if (live.length <= 1) {
      this.#endHandUncontested(live[0] ?? null);
      return;
    }
    const next = this.#nextPendingSeat(this.toAct);
    if (next === null) {
      this.#endStreet(0);
      return;
    }
    this.toAct = next;
  }

  #endStreet(depth) {
    if (depth > 4) throw new GameError('街道推进异常', 'STREET_LOOP');

    const live = this.liveSeats;
    if (live.length <= 1) {
      this.#endHandUncontested(live[0] ?? null);
      return;
    }

    if (this.street === 'river') {
      this.#showdown();
      return;
    }

    for (const s of this.seats) {
      s.committed = 0;
      s.acted = false;
      s.mayRaise = true;
      s.lastAction = null;
    }
    this.currentBet = 0;
    this.lastRaiseSize = this.bigBlind;
    this.lastFullRaiseTo = 0;
    this.minRaiseTo = this.bigBlind;
    this.lastAggressor = null;

    const idx = STREETS.indexOf(this.street);
    this.street = STREETS[idx + 1];
    const dealt = this.street === 'flop' ? this.#draw(3) : this.#draw(1);
    this.board.push(...dealt);
    this.#log(
      `${STREET_LABEL[this.street]} ${this.board.map(cardText).join(' ')}`,
      'deal',
      null,
      { board: this.board.slice() },
    );

    const canAct = this.seats.filter((s) => !s.out && !s.folded && !s.allIn);
    if (canAct.length <= 1) {
      // No further betting is possible — run the remaining board out.
      this.toAct = null;
      this.#endStreet(depth + 1);
      return;
    }

    const first = this.#nextPendingSeat(this.buttonIndex);
    if (first === null) {
      this.#endStreet(depth + 1);
      return;
    }
    this.toAct = first;
  }

  #endHandUncontested(winner) {
    const refund = returnUncalled(this.seats);
    if (refund) {
      const s = this.seats[refund.seat];
      s.stack += refund.amount;
      this.#log(`${s.name} 收回未被跟注的 ${refund.amount}`, 'system', s.seat, { amount: refund.amount });
    }
    const amount = this.potTotal;
    if (winner) {
      winner.stack += amount;
      winner.result = 'win';
      this.#log(`${winner.name} 赢得底池 ${amount}（其他人都弃牌）`, 'result', winner.seat, { amount });
    }
    this.pots = amount > 0 ? [{ amount, eligible: winner ? [winner.seat] : [] }] : [];
    this.#finishHand({
      uncontested: true,
      winnerSeat: winner ? winner.seat : null,
      amount,
      showdown: [],
      awards: winner ? [{ seat: winner.seat, amount, potIndex: 0, handNameZh: null }] : [],
    });
  }

  #showdown() {
    this.street = 'showdown';
    const refund = returnUncalled(this.seats);
    if (refund) {
      const s = this.seats[refund.seat];
      s.stack += refund.amount;
      this.#log(`${s.name} 收回未被跟注的 ${refund.amount}`, 'system', s.seat, { amount: refund.amount });
    }

    const contenders = this.liveSeats;
    const showdownInfo = [];
    const evaluated = new Map();

    for (const s of contenders) {
      s.revealed = true;
      const ev = evaluate([...s.hole, ...this.board]);
      evaluated.set(s.seat, ev);
      showdownInfo.push({
        seat: s.seat,
        name: s.name,
        hole: s.hole.slice(),
        nameZh: ev?.nameZh ?? null,
        nameEn: ev?.name ?? null,
        best5: ev?.best5 ?? [],
        score: ev?.score ?? -1,
      });
    }
    this.#log(`摊牌：${contenders.map((s) => `${s.name} ${s.hole.map(cardText).join(' ')}`).join('；')}`, 'deal');

    const { pots, refunds } = buildPots(this.seats);
    for (const r of refunds) {
      this.seats[r.seat].stack += r.amount;
      this.#log(
        `${this.seats[r.seat].name} 收回未被跟注的 ${r.amount}`,
        'system',
        r.seat,
        { amount: r.amount },
      );
    }
    const awards = [];
    const potBreakdown = [];

    for (let i = 0; i < pots.length; i++) {
      const pot = pots[i];
      const eligible = pot.eligible.filter((seat) => evaluated.has(seat));
      if (!eligible.length) continue;
      const best = Math.max(...eligible.map((seat) => evaluated.get(seat).score));
      const winners = eligible.filter((seat) => evaluated.get(seat).score === best);
      const ordered = this.#orderFromButton(winners);

      const share = Math.floor(pot.amount / ordered.length);
      let remainder = pot.amount - share * ordered.length;
      const potAwards = [];
      for (const seat of ordered) {
        let amt = share;
        if (remainder > 0) {
          amt += 1;
          remainder -= 1;
        }
        this.seats[seat].stack += amt;
        this.seats[seat].result = 'win';
        awards.push({ seat, amount: amt, potIndex: i, handNameZh: evaluated.get(seat).nameZh });
        potAwards.push({ seat, amount: amt });
      }
      const label = pots.length > 1 ? (i === 0 ? '主池' : `边池 ${i}`) : '底池';
      this.#log(
        `${label} ${pot.amount}：${ordered.map((s) => this.seats[s].name).join('、')} 赢得 ${ordered
          .map((s) => potAwards.find((a) => a.seat === s).amount)
          .join('、')}（${evaluated.get(ordered[0]).nameZh}）`,
        'result',
        ordered[0],
        { amount: pot.amount, potIndex: i },
      );
      potBreakdown.push({ index: i, label, amount: pot.amount, winners: potAwards });
    }

    this.pots = pots;
    this.#finishHand({
      uncontested: false,
      winnerSeat: awards.length ? awards[0].seat : null,
      amount: totalPot(pots),
      showdown: showdownInfo,
      awards,
      potBreakdown,
    });
  }

  #finishHand(result) {
    for (const s of this.seats) {
      if (s.stack <= 0 && !s.out) {
        s.out = true;
        s.lastAction = s.lastAction ?? null;
      }
    }
    this.phase = 'handover';
    this.toAct = null;
    this.handResult = {
      handId: this.handId,
      street: this.street,
      board: this.board.slice(),
      ...result,
    };
    this.#log(`第 ${this.handId} 手结束`, 'system');
    if (this.isGameOver()) {
      this.phase = 'gameover';
      this.#log('牌局结束', 'system');
    }
  }

  // ------------------------------------------------------------------ views

  /** Seat list shaped for the client, hiding hole cards the viewer may not see. */
  seatViews(viewerSeat = null) {
    const positions = this.positionLabels();
    const revealAll = this.phase === 'showdown' || this.phase === 'handover' || this.phase === 'gameover';
    const showdownBySeat = new Map((this.handResult?.showdown ?? []).map((s) => [s.seat, s]));

    return this.seats.map((s) => {
      // Only the viewer's own seat is visible while a hand is live. Being human
      // does NOT make a seat public: with several people at one table that
      // would hand every player a look at everyone else's hole cards.
      const canSee =
        s.seat === viewerSeat ||
        s.revealed ||
        (revealAll && !s.folded && s.hole.length > 0);
      const show = showdownBySeat.get(s.seat);
      // Live hand name is only derived for cards this viewer is allowed to see,
      // so it can never leak a hidden opponent's holding.
      const liveHand = canSee && s.hole.length === 2 && !s.folded ? describeMadeHand(s.hole, this.board) : null;
      return {
        seat: s.seat,
        name: s.name,
        avatar: s.avatar,
        isHuman: s.isHuman,
        personality: s.personality,
        model: s.model,
        position: positions[s.seat] ?? null,
        stack: s.stack,
        committed: s.committed,
        totalCommitted: s.totalCommitted,
        folded: s.folded,
        allIn: s.allIn,
        out: s.out,
        acted: s.acted,
        lastAction: s.lastAction,
        holeCount: s.hole.length,
        hole: canSee ? s.hole.slice() : [],
        hidden: !canSee,
        handNameZh: show ? show.nameZh : liveHand,
        result: s.result,
        isDealer: s.seat === this.buttonIndex,
        isSmallBlind: s.seat === this.sbSeat,
        isBigBlind: s.seat === this.bbSeat,
      };
    });
  }

  view(viewerSeat = null) {
    const legal = viewerSeat !== null && this.toAct === viewerSeat ? this.legalActions(viewerSeat) : [];
    // Reasoning is sealed while the hand is live: the text never leaves the
    // server, so it cannot leak an opponent's holding through devtools either.
    const revealSecrets = this.phase !== 'playing';
    return {
      handId: this.handId,
      phase: this.phase,
      street: this.street,
      streetLabel: this.street ? STREET_LABEL[this.street] : null,
      board: this.board.slice(),
      buttonIndex: this.buttonIndex,
      sbSeat: this.sbSeat,
      bbSeat: this.bbSeat,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      currentBet: this.currentBet,
      minRaiseTo: this.minRaiseTo,
      potTotal: this.potTotal,
      pots: this.pots.map((p) => ({ amount: p.amount, eligible: p.eligible.slice() })),
      toAct: this.toAct,
      lastAggressor: this.lastAggressor,
      seats: this.seatViews(viewerSeat),
      legalActions: legal,
      viewerSeat,
      handResult: this.handResult,
      log: this.log
        .slice(-60)
        .map((entry) => (entry.secret && !revealSecrets ? { ...entry, text: null, sealed: true } : entry)),
      secretsRevealed: revealSecrets,
      running: this.phase === 'playing',
    };
  }
}
