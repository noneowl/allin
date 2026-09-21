import { randomInt } from 'node:crypto';

/** Rank characters, low to high. */
export const RANKS = '23456789TJQKA';
/** Suit characters: spades, hearts, diamonds, clubs. */
export const SUITS = ['s', 'h', 'd', 'c'];

export const SUIT_SYMBOL = { s: '♠', h: '♥', d: '♦', c: '♣' };
export const SUIT_NAME_ZH = { s: '黑桃', h: '红桃', d: '方块', c: '梅花' };
export const RANK_NAME_ZH = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9',
  10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A',
};

/** A card is a 2-char string: rank char + suit char, e.g. "As", "Th", "2c". */
export const isCard = (c) => typeof c === 'string' && c.length === 2 && RANKS.includes(c[0]) && SUITS.includes(c[1]);
export const rankOf = (card) => RANKS.indexOf(card[0]) + 2;
export const suitOf = (card) => card[1];
export const isRed = (card) => card[1] === 'h' || card[1] === 'd';
export const rankDisplay = (card) => (card[0] === 'T' ? '10' : card[0]);
export const cardText = (card) => rankDisplay(card) + SUIT_SYMBOL[card[1]];
export const cardNameZh = (card) => RANK_NAME_ZH[rankOf(card)] + SUIT_NAME_ZH[card[1]];
export const rankNameZh = (value) => RANK_NAME_ZH[value];

/** Build a fresh, ordered 52 card deck. */
export function makeDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(r + s);
  return deck;
}

/**
 * Unbiased Fisher-Yates shuffle (crypto-backed by default).
 * @param {string[]} deck
 * @param {{ next: () => number }} [rng] optional RNG returning [0,1)
 */
export function shuffle(deck, rng) {
  if (rng) {
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/** Deterministic seeded RNG, used by tests. */
export function seededRng(seed = 1) {
  let a = seed >>> 0;
  return {
    next() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

/** "As Kd" -> "A♠ K♦" */
export function cardsText(cards) {
  return (cards || []).map(cardText).join(' ');
}
