import { randomUUID } from 'node:crypto';
import { GameController } from './game.js';

/** One table per browser session, kept in memory. */
export class SessionStore {
  constructor({ getConfig, maxSessions = 40 }) {
    this.getConfig = getConfig;
    this.maxSessions = maxSessions;
    this.sessions = new Map();
  }

  get(id) {
    return id ? this.sessions.get(id) : undefined;
  }

  getOrCreate(id) {
    if (id && this.sessions.has(id)) {
      const existing = this.sessions.get(id);
      existing.touchedAt = Date.now();
      return { id, controller: existing.controller };
    }

    if (this.sessions.size >= this.maxSessions) {
      // Evict the least recently used session.
      const oldest = [...this.sessions.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt)[0];
      if (oldest) {
        oldest[1].controller.abortAll();
        this.sessions.delete(oldest[0]);
      }
    }

    const sessionId = id || randomUUID();
    const controller = new GameController({ sessionId, getConfig: this.getConfig });
    this.sessions.set(sessionId, { controller, touchedAt: Date.now() });
    return { id: sessionId, controller };
  }

  delete(id) {
    const entry = this.sessions.get(id);
    if (entry) entry.controller.abortAll();
    this.sessions.delete(id);
  }
}
