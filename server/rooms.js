import { randomBytes } from 'node:crypto';
import { GameController } from './game.js';
import { personalityById, PERSONALITIES } from './ai/personalities.js';

// Ambiguous characters removed so a room code can be read aloud or typed.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const AVATARS = ['🦊', '🐼', '🐯', '🐸', '🐙', '🦉', '🐺', '🐨'];

export function newRoomCode(length = 5) {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

export const newSeatToken = () => randomBytes(18).toString('base64url');

const MAX_SEATS = 9;
const clamp = (v, lo, hi, fallback) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
};

/** A sensible default line-up: one human host plus a spread of AI characters. */
export function defaultSeatConfig(seatCount, hostName = '玩家') {
  const order = PERSONALITIES.map((p) => p.id);
  return Array.from({ length: seatCount }, (_, index) => {
    if (index === 0) {
      return { index, type: 'human', name: hostName, avatar: '🧑', personalityId: null };
    }
    const id = order[(index - 1) % order.length];
    const personality = personalityById(id);
    return { index, type: 'ai', name: personality.name, avatar: personality.avatar, personalityId: id };
  });
}

/**
 * Validate and normalise a seat list coming from the lobby.
 * Every seat ends up with its own access token, so a seat can be handed to a
 * different person (or device) without exposing anyone else's view.
 */
export function normalizeSeatConfig(raw, seatCount) {
  const count = clamp(seatCount ?? raw?.length ?? 4, 2, MAX_SEATS, 4);
  const fallback = defaultSeatConfig(count);
  const seats = [];

  for (let index = 0; index < count; index++) {
    const input = Array.isArray(raw) ? raw[index] ?? {} : {};
    const type = input.type === 'human' ? 'human' : 'ai';
    let name = typeof input.name === 'string' ? input.name.trim().slice(0, 16) : '';
    let avatar = typeof input.avatar === 'string' && input.avatar.trim() ? input.avatar.trim().slice(0, 4) : '';
    let personalityId = null;

    if (type === 'ai') {
      const personality = personalityById(input.personalityId);
      personalityId = personality.id;
      if (!name) name = personality.name;
      if (!avatar) avatar = personality.avatar;
    } else if (!name) {
      name = index === 0 ? '玩家' : `玩家 ${index + 1}`;
      if (!avatar) avatar = AVATARS[index % AVATARS.length];
    }

    seats.push({
      index,
      type,
      name,
      avatar: avatar || fallback[index].avatar,
      personalityId,
      token: newSeatToken(),
      connected: false,
      lastSeen: null,
    });
  }
  return seats;
}

export class Room {
  constructor({ id, rules, seatConfig, getConfig }) {
    this.id = id;
    this.createdAt = Date.now();
    this.touchedAt = Date.now();
    this.rules = rules;
    this.seatConfig = seatConfig;
    // The host is whoever owns the first human seat (the creator).
    const host = seatConfig.find((s) => s.type === 'human') ?? seatConfig[0];
    this.hostSeat = host.index;
    this.hostToken = host.token;

    this.controller = new GameController({
      roomId: id,
      getConfig,
      seatConfig,
    });
  }

  seatForToken(token) {
    if (!token) return null;
    return this.seatConfig.find((s) => s.token === token) ?? null;
  }

  isHost(token) {
    return Boolean(token) && token === this.hostToken;
  }

  get humanSeats() {
    return this.seatConfig.filter((s) => s.type === 'human');
  }

  get aiSeats() {
    return this.seatConfig.filter((s) => s.type === 'ai');
  }

  touch() {
    this.touchedAt = Date.now();
  }

  /** Public descriptor, safe to hand to any participant. */
  describe() {
    return {
      id: this.id,
      rules: this.rules,
      hostSeat: this.hostSeat,
      seats: this.seatConfig.map((s) => ({
        index: s.index,
        type: s.type,
        name: s.name,
        avatar: s.avatar,
        personalityId: s.personalityId,
        connected: s.connected,
      })),
    };
  }
}

export class RoomStore {
  constructor({ getConfig, maxRooms = 40, ttlMs = 8 * 60 * 60 * 1000 }) {
    this.getConfig = getConfig;
    this.maxRooms = maxRooms;
    this.ttlMs = ttlMs;
    this.rooms = new Map();
  }

  create({ seatCount, seats, rules }) {
    const cfg = this.getConfig();
    const count = clamp(seatCount ?? seats?.length ?? cfg.table.seats, 2, MAX_SEATS, 4);
    const seatConfig = normalizeSeatConfig(seats, count);

    const normalizedRules = {
      seats: count,
      smallBlind: clamp(rules?.smallBlind ?? cfg.table.smallBlind, 1, 1_000_000, 10),
      bigBlind: clamp(rules?.bigBlind ?? cfg.table.bigBlind, 2, 2_000_000, 20),
      startingStack: clamp(rules?.startingStack ?? cfg.table.startingStack, 100, 100_000_000, 2000),
    };
    if (normalizedRules.bigBlind <= normalizedRules.smallBlind) {
      normalizedRules.bigBlind = normalizedRules.smallBlind * 2;
    }

    this.#evictIfNeeded();

    let id = newRoomCode();
    while (this.rooms.has(id)) id = newRoomCode();

    const room = new Room({ id, rules: normalizedRules, seatConfig, getConfig: this.getConfig });
    this.rooms.set(id, room);
    return room;
  }

  get(id) {
    const room = id ? this.rooms.get(String(id).toUpperCase()) : undefined;
    if (room) room.touch();
    return room;
  }

  /** Resolve a room from a seat token alone, so token-only links still work. */
  findByToken(token) {
    if (!token) return null;
    for (const room of this.rooms.values()) {
      if (room.seatForToken(token)) {
        room.touch();
        return room;
      }
    }
    return null;
  }

  delete(id) {
    const room = this.rooms.get(id);
    if (room) room.controller.abortAll();
    this.rooms.delete(id);
  }

  sweep() {
    const now = Date.now();
    for (const [id, room] of this.rooms) {
      if (now - room.touchedAt > this.ttlMs && room.controller.connectedCount === 0) {
        room.controller.abortAll();
        this.rooms.delete(id);
      }
    }
  }

  #evictIfNeeded() {
    if (this.rooms.size < this.maxRooms) return;
    const oldest = [...this.rooms.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt)[0];
    if (oldest) {
      oldest[1].controller.abortAll();
      this.rooms.delete(oldest[0]);
    }
  }
}

export const ROOM_LIMITS = { MAX_SEATS, MIN_SEATS: 2 };
