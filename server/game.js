import { Table, GameError } from './engine/table.js';
import { PokerAgent, AIError, fallbackAction } from './ai/agent.js';
import { personalityById } from './ai/personalities.js';

/**
 * Owns one room's table plus the async loop that asks the LLM for every AI
 * decision.
 *
 * All mutations run through a promise chain so a click from any browser can
 * never interleave with an in-flight AI turn.
 */
export class GameController {
  constructor({ roomId, getConfig, seatConfig }) {
    this.roomId = roomId;
    this.getConfig = getConfig;
    this.seatConfig = seatConfig;
    this.table = null;
    this.listeners = new Set();
    this.queue = Promise.resolve();
    this.ai = new Map(); // seat -> { status, startedAt, ... }
    this.controllers = new Map(); // seat -> AbortController
    this.connectionCounts = new Map(); // seat -> number of live event streams
    this.lastError = null;
    this.rules = null;
  }

  // -------------------------------------------------------------- plumbing

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(event, payload) {
    for (const fn of [...this.listeners]) {
      try {
        fn(event, payload);
      } catch (err) {
        console.warn('[sse] listener failed:', err.message);
      }
    }
  }

  /** Serialise every state mutation behind the previous one. */
  enqueue(task) {
    const result = this.queue.then(task, task);
    this.queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  requireTable() {
    if (!this.table) throw new Error('牌桌还没有创建');
    return this.table;
  }

  get connectedCount() {
    return this.connectionCounts.size;
  }

  /** Ref-counted so several tabs on the same seat behave correctly. */
  addConnection(seatIndex) {
    if (seatIndex === null || seatIndex === undefined) return;
    this.connectionCounts.set(seatIndex, (this.connectionCounts.get(seatIndex) ?? 0) + 1);
    this.#syncPresence();
  }

  removeConnection(seatIndex) {
    if (seatIndex === null || seatIndex === undefined) return;
    const next = (this.connectionCounts.get(seatIndex) ?? 0) - 1;
    if (next <= 0) this.connectionCounts.delete(seatIndex);
    else this.connectionCounts.set(seatIndex, next);
    this.#syncPresence();
  }

  #syncPresence() {
    for (const seat of this.seatConfig) {
      const connected = this.connectionCounts.has(seat.index);
      seat.connected = connected;
      if (connected) seat.lastSeen = Date.now();
    }
    this.broadcast();
  }

  // ------------------------------------------------------------- lifecycle

  #players() {
    return this.seatConfig.map((seat, index) => ({
      name: seat.name,
      avatar: seat.avatar,
      isHuman: seat.type === 'human',
      personality:
        seat.type === 'ai'
          ? personalityById(seat.personalityId)
          : { id: `human-${index}`, name: seat.name, title: '', avatar: seat.avatar, tagline: '', style: '' },
    }));
  }

  /**
   * Run the AI loop as a queued follow-up task.
   *
   * HTTP handlers must not wait for this: with a real model a full AI-vs-AI
   * hand takes minutes, and the browser would sit on a pending request the
   * whole time. Going through `enqueue` still keeps it serialised with respect
   * to player actions.
   */
  #scheduleDrive() {
    this.enqueue(() => this.driveAI()).catch((err) => {
      this.lastError = String(err?.message ?? err);
      this.emit('toast', { level: 'error', message: `AI 回合循环异常：${this.lastError}` });
    });
  }

  newGame({ waitForAI = true } = {}) {
    return this.enqueue(async () => {
      this.abortAll();
      const cfg = this.getConfig();
      this.rules = {
        seats: this.seatConfig.length,
        smallBlind: cfg.table.smallBlind,
        bigBlind: cfg.table.bigBlind,
        startingStack: cfg.table.startingStack,
      };

      this.ai.clear();
      this.lastError = null;
      this.table = new Table({
        players: this.#players(),
        smallBlind: this.rules.smallBlind,
        bigBlind: this.rules.bigBlind,
        startingStack: this.rules.startingStack,
      });

      this.emit('game_new', { rules: this.rules });
      this.table.startHand();
      this.broadcast();
      if (waitForAI) await this.driveAI();
      else this.#scheduleDrive();
    });
  }

  nextHand({ waitForAI = true } = {}) {
    return this.enqueue(async () => {
      const table = this.requireTable();
      if (table.phase === 'playing') return;
      if (table.isGameOver()) return;
      table.startHand();
      this.lastError = null;
      this.broadcast();
      if (waitForAI) await this.driveAI();
      else this.#scheduleDrive();
    });
  }

  humanAction(seatIndex, action) {
    return this.enqueue(async () => {
      const table = this.requireTable();
      if (table.phase !== 'playing') throw new GameError('当前不在下注阶段', 'NOT_PLAYING');
      if (table.toAct !== seatIndex) throw new GameError('还没轮到你行动', 'NOT_YOUR_TURN');
      const seat = table.seats[seatIndex];
      if (!seat || !seat.isHuman) throw new GameError('该座位不是人类玩家', 'NOT_HUMAN');
      table.applyAction(seatIndex, action);
      this.broadcast();
      await this.driveAI();
    });
  }

  /**
   * Host-only rescue for a human who left the table: take the free option, or
   * fold if there is a price to call. Never used while their stream is live.
   */
  forceAction(seatIndex) {
    return this.enqueue(async () => {
      const table = this.requireTable();
      if (table.phase !== 'playing' || table.toAct !== seatIndex) return;
      const seat = table.seats[seatIndex];
      if (!seat || !seat.isHuman) return;
      const action = fallbackAction(table, seatIndex);
      table.applyAction(seatIndex, action);
      table.addLog({
        seat: seatIndex,
        name: seat.name,
        kind: 'system',
        text: `${seat.name} 已离线，代其${action.type === 'check' ? '过牌' : '弃牌'}`,
      });
      this.broadcast();
      await this.driveAI();
    });
  }

  abortAll() {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    this.ai.clear();
  }

  // ------------------------------------------------------------------- AI

  #personalityFor(seat) {
    if (seat.personality && seat.personality.style) return seat.personality;
    if (seat.personality && seat.personality.id) return personalityById(seat.personality.id);
    return personalityById('wei');
  }

  /**
   * Fire a short in-character remark from every AI that was in the hand.
   *
   * Runs in PARALLEL and detached: the models are independent, nothing depends
   * on order, and the player should not wait on colour commentary. Failures are
   * swallowed — a missing remark is not a broken game.
   */
  #scheduleReactions() {
    const table = this.table;
    const cfg = this.getConfig();
    if (!table || table.phase === 'playing' || !cfg.postHandTalk) return;
    if (this.reacting) return;

    const handId = table.handId;
    const reactors = table.seats.filter((s) => !s.isHuman && !s.out && s.hole.length > 0);
    if (!reactors.length) return;

    this.reacting = true;
    Promise.all(
      reactors.map(async (seat) => {
        const personality = this.#personalityFor(seat);
        const agent = new PokerAgent({
          config: cfg,
          personality,
          sessionId: `${this.roomId}-seat${seat.seat}`,
        });
        const line = await agent.react(table, seat.seat);
        if (!line?.text) return;
        // Tagged with the hand it is about, so it still reads correctly if the
        // next hand has already been dealt.
        table.addLog({
          seat: seat.seat,
          name: seat.name,
          kind: 'talk',
          handId,
          text: line.text,
          postHand: true,
        });
        this.broadcast();
      }),
    )
      .catch(() => {})
      .finally(() => {
        this.reacting = false;
      });
  }

  /** A line typed by a human at the table. Public by definition. */
  say(seatIndex, text, { handId = null } = {}) {
    return this.enqueue(async () => {
      const table = this.requireTable();
      const seat = table.seats[seatIndex];
      if (!seat || !seat.isHuman) throw new GameError('只有人类座位可以发言', 'NOT_HUMAN');
      const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 140);
      if (!clean) return null;
      const entry = table.addLog({
        seat: seatIndex,
        name: seat.name,
        kind: 'talk',
        text: clean,
        ...(handId ? { handId } : {}),
      });
      this.broadcast();
      return entry;
    });
  }

  /**
   * Play out every consecutive AI turn. Returns when it is a human's turn,
   * the hand is over, or no one has chips left to act.
   */
  async driveAI() {
    const table = this.table;
    if (!table) return;

    let guard = 0;
    while (table.phase === 'playing' && guard++ < 500) {
      const seatIdx = table.toAct;
      if (seatIdx === null) break;
      const seat = table.seats[seatIdx];
      if (!seat || seat.isHuman) break;

      // Rules-derived shortcut: with nothing to call and no ability to raise
      // there is literally one non-folding option, so no decision to make.
      const forced = table.forcedAction(seatIdx);
      if (forced) {
        table.applyAction(seatIdx, forced);
        this.broadcast();
        continue;
      }

      const cfg = this.getConfig();
      if (!cfg.ready) {
        this.lastError = '尚未配置 AI 供应商（Base URL / 模型 / API Key），无法继续。';
        this.emit('ai_error', { seat: seatIdx, name: seat.name, fatal: true, message: this.lastError });
        break;
      }

      const personality = this.#personalityFor(seat);
      const startedAt = Date.now();
      this.ai.set(seatIdx, { status: 'thinking', startedAt, name: seat.name, avatar: seat.avatar });
      this.emit('ai_start', {
        seat: seatIdx,
        name: seat.name,
        avatar: seat.avatar,
        title: personality.title ?? null,
        model: cfg.model,
        provider: cfg.provider,
        startedAt,
      });
      this.broadcast();

      const controller = new AbortController();
      this.controllers.set(seatIdx, controller);

      let decision = null;
      let failure = null;
      try {
        const agent = new PokerAgent({
          config: cfg,
          personality,
          // Every AI seat gets its own provider-side session, so no two
          // opponents ever share conversation state or prompt cache lineage.
          sessionId: `${this.roomId}-seat${seatIdx}`,
          tableTalk: cfg.tableTalk,
          reasoning: cfg.reasoning,
        });
        decision = await agent.decide(table, seatIdx, { signal: controller.signal });
      } catch (err) {
        failure = err;
      } finally {
        this.controllers.delete(seatIdx);
        this.ai.delete(seatIdx);
      }

      if (controller.signal.aborted) {
        this.emit('toast', { level: 'warn', message: '已取消当前 AI 决策。' });
        break;
      }

      if (failure) {
        const message = failure instanceof AIError ? failure.message : String(failure?.message ?? failure);
        this.lastError = message;
        this.emit('ai_error', { seat: seatIdx, name: seat.name, message, details: failure?.attempts ?? null });

        // Emergency only: the provider is unreachable, so take the free option.
        const fb = fallbackAction(table, seatIdx);
        try {
          table.applyAction(seatIdx, fb);
          table.addLog({
            seat: seatIdx,
            name: seat.name,
            kind: 'error',
            text: `⚠ ${seat.name} 的 AI 决策失败，已自动${fb.type === 'check' ? '过牌' : '弃牌'}（${message}）`,
          });
        } catch {
          break;
        }
      } else {
        table.applyAction(seatIdx, decision.normalized);
        if (cfg.reasoning && decision.reasoning) {
          // `secret: true` keeps this out of every client view until the hand ends.
          table.addLog({
            seat: seatIdx,
            name: seat.name,
            avatar: seat.avatar,
            kind: 'reason',
            secret: true,
            text: decision.reasoning,
            action: decision.action,
            amount: decision.amount,
            latencyMs: decision.latencyMs,
            model: decision.model,
          });
        }
        this.emit('ai_done', {
          seat: seatIdx,
          name: seat.name,
          avatar: seat.avatar,
          action: decision.action,
          amount: decision.amount,
          reasoning: cfg.reasoning ? decision.reasoning : '',
          tableTalk: cfg.tableTalk ? decision.tableTalk : '',
          latencyMs: decision.latencyMs,
          attempts: decision.attempts,
          model: decision.model,
          wire: decision.wire,
        });
        if (cfg.tableTalk && decision.tableTalk) {
          table.addLog({
            seat: seatIdx,
            name: seat.name,
            kind: 'talk',
            // Raw line only: the feed adds the speaker, the seat renders a
            // speech bubble from the same entry.
            text: decision.tableTalk,
          });
        }
      }
      this.broadcast();
    }

    // The hand just finished: let the table react to the result.
    if (table.phase !== 'playing') this.#scheduleReactions();
  }

  retryCurrentAI() {
    return this.enqueue(async () => {
      const table = this.table;
      if (!table || table.phase !== 'playing') return;
      const seatIdx = table.toAct;
      if (seatIdx === null) return;
      const seat = table.seats[seatIdx];
      if (!seat || seat.isHuman) return;
      this.lastError = null;
      await this.driveAI();
    });
  }

  cancelAI() {
    this.abortAll();
    this.ai.clear();
  }

  // ---------------------------------------------------------------- views

  /** State shaped for one specific viewer. Never serialise another seat's view. */
  view(viewerSeat = null) {
    const cfg = this.getConfig();
    const config = {
      ready: cfg.ready,
      provider: cfg.provider,
      model: cfg.model,
      hasApiKey: Boolean(cfg.apiKey),
      tableTalk: cfg.tableTalk,
      reasoning: cfg.reasoning,
    };

    if (!this.table) {
      return {
        table: null,
        ai: {},
        rules: this.rules,
        roomId: this.roomId,
        seats: this.seatConfig.map((s) => ({
          index: s.index,
          type: s.type,
          name: s.name,
          avatar: s.avatar,
          personalityId: s.personalityId,
          connected: s.connected,
        })),
        viewerSeat,
        config,
        error: this.lastError,
      };
    }

    const view = this.table.view(viewerSeat);
    const presence = new Map(this.seatConfig.map((s) => [s.index, s.connected]));
    for (const seatView of view.seats) {
      seatView.connected = view.seats.length === 0 ? false : (presence.get(seatView.seat) ?? false);
    }
    if (cfg.showAiCards && viewerSeat !== null) {
      for (const seatView of view.seats) {
        const seat = this.table.seats[seatView.seat];
        if (!seat.isHuman && !seat.folded && seat.hole.length) {
          seatView.hole = seat.hole.slice();
          seatView.hidden = false;
        }
      }
    }
    view.ai = Object.fromEntries(this.ai);
    view.error = this.lastError;
    view.config = config;
    view.rules = this.rules;
    view.viewerSeat = viewerSeat;
    view.roomId = this.roomId;
    view.players = this.seatConfig.map((s) => ({
      index: s.index,
      type: s.type,
      name: s.name,
      avatar: s.avatar,
      personalityId: s.personalityId,
      connected: s.connected,
    }));
    return view;
  }

  /** Signals subscribers to re-serialise; each one does so for its own seat. */
  broadcast() {
    this.emit('state');
  }
}
