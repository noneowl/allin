import { Table } from './engine/table.js';
import { PokerAgent, AIError, fallbackAction } from './ai/agent.js';
import { lineupFor, HUMAN, personalityById } from './ai/personalities.js';
import { providerPreset } from './providers/catalog.js';

/**
 * Owns one player's table plus the async loop that asks the LLM for every
 * opponent decision.
 *
 * All mutations run through a promise chain so a click from the browser can
 * never interleave with an in-flight AI turn.
 */
export class GameController {
  constructor({ sessionId, getConfig }) {
    this.sessionId = sessionId;
    this.getConfig = getConfig;
    this.table = null;
    this.listeners = new Set();
    this.queue = Promise.resolve();
    this.ai = new Map(); // seat -> { status, startedAt, ... }
    this.controllers = new Map(); // seat -> AbortController
    this.lastError = null;
    this.rules = null;
    this.busy = false;
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

  // ------------------------------------------------------------- lifecycle

  newGame(overrides = {}) {
    return this.enqueue(async () => {
      this.abortAll();
      const cfg = this.getConfig();
      const rules = {
        seats: clampInt(overrides.seats ?? cfg.table.seats, 2, 6),
        smallBlind: clampInt(overrides.smallBlind ?? cfg.table.smallBlind, 1, 1_000_000),
        bigBlind: clampInt(overrides.bigBlind ?? cfg.table.bigBlind, 2, 2_000_000),
        startingStack: clampInt(overrides.startingStack ?? cfg.table.startingStack, 100, 100_000_000),
      };
      if (rules.bigBlind <= rules.smallBlind) rules.bigBlind = rules.smallBlind * 2;
      this.rules = rules;

      const opponents = lineupFor(rules.seats);
      const players = [
        { name: HUMAN.name, avatar: HUMAN.avatar, isHuman: true, personality: HUMAN },
        ...opponents.map((p) => ({
          name: p.name,
          avatar: p.avatar,
          isHuman: false,
          personality: p,
        })),
      ];

      this.ai.clear();
      this.lastError = null;
      this.table = new Table({
        players,
        smallBlind: rules.smallBlind,
        bigBlind: rules.bigBlind,
        startingStack: rules.startingStack,
      });

      this.emit('game_new', { rules, players: players.map((p) => p.name) });
      this.table.startHand();
      this.broadcast();
      await this.driveAI();
    });
  }

  startHand() {
    return this.enqueue(async () => {
      const table = this.requireTable();
      if (table.phase === 'playing') throw new Error('当前手牌还没有结束');
      if (table.isGameOver()) {
        this.emit('toast', { level: 'warn', message: '牌局已结束，请开一局新的。' });
        return;
      }
      table.startHand();
      this.lastError = null;
      this.broadcast();
      await this.driveAI();
    });
  }

  /** Auto-start the next hand after a short pause so the player can read results. */
  nextHand(delayMs = 0) {
    return this.enqueue(async () => {
      const table = this.requireTable();
      if (table.phase === 'playing') return;
      if (table.isGameOver()) return;
      if (delayMs > 0) await sleep(delayMs);
      table.startHand();
      this.lastError = null;
      this.broadcast();
      await this.driveAI();
    });
  }

  humanAction(action) {
    return this.enqueue(async () => {
      const table = this.requireTable();
      if (table.phase !== 'playing') throw new Error('当前不在下注阶段');
      const seatIdx = table.toAct;
      if (seatIdx === null) throw new Error('当前没有玩家需要行动');
      const seat = table.seats[seatIdx];
      if (!seat.isHuman) throw new Error('还没轮到你行动');
      table.applyAction(seatIdx, action);
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
    if (typeof seat.personality === 'object' && seat.personality.id) {
      return personalityById(seat.personality.id);
    }
    return personalityById('wei');
  }

  /**
   * Play out every consecutive AI turn. Returns when it is the human's turn,
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
        this.emit('ai_error', {
          seat: seatIdx,
          name: seat.name,
          fatal: true,
          message: this.lastError,
        });
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
          sessionId: this.sessionId,
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
          table.addLog({
            seat: seatIdx,
            name: seat.name,
            avatar: seat.avatar,
            kind: 'reason',
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
            text: `${seat.name}：「${decision.tableTalk}」`,
          });
        }
      }
      this.broadcast();
    }
  }

  /** Re-ask the LLM for the seat currently on turn (used by the retry button). */
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

  view() {
    const cfg = this.getConfig();
    if (!this.table) {
      return {
        table: null,
        ai: {},
        rules: this.rules ?? cfg.table,
        config: {
          ready: cfg.ready,
          provider: cfg.provider,
          model: cfg.model,
          hasApiKey: Boolean(cfg.apiKey),
          tableTalk: cfg.tableTalk,
          reasoning: cfg.reasoning,
        },
        error: this.lastError,
      };
    }
    const view = this.table.view(0);
    if (cfg.showAiCards) {
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
    view.config = {
      ready: cfg.ready,
      provider: cfg.provider,
      model: cfg.model,
      hasApiKey: Boolean(cfg.apiKey),
      tableTalk: cfg.tableTalk,
      reasoning: cfg.reasoning,
    };
    view.rules = this.rules;
    return { table: view, ai: view.ai };
  }

  broadcast() {
    this.emit('state', this.view());
  }
}

function clampInt(value, min, max) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export { providerPreset };
