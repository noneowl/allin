import { rankOf, RANK_NAME_ZH } from './cards.js';

export const CATEGORY_EN = [
  'High Card',
  'One Pair',
  'Two Pair',
  'Three of a Kind',
  'Straight',
  'Flush',
  'Full House',
  'Four of a Kind',
  'Straight Flush',
];

export const CATEGORY_ZH = [
  '高牌',
  '一对',
  '两对',
  '三条',
  '顺子',
  '同花',
  '葫芦',
  '四条',
  '同花顺',
];

// Base-15 positional encoding: category then up to five tiebreak kickers.
const BASE = 15;
const WEIGHT = [BASE ** 5, BASE ** 4, BASE ** 3, BASE ** 2, BASE, 1];

const encode = (category, kickers) => {
  let score = category * WEIGHT[0];
  for (let i = 0; i < kickers.length && i < 5; i++) score += kickers[i] * WEIGHT[i + 1];
  return score;
};

/**
 * Rank exactly five cards.
 * @returns {{ score: number, category: number, tiebreak: number[] }}
 */
export function rank5(cards) {
  if (!Array.isArray(cards) || cards.length !== 5) {
    throw new Error(`rank5 expects exactly 5 cards, received ${cards && cards.length}`);
  }
  const ranks = cards.map(rankOf).sort((a, b) => b - a);
  const flush = cards.every((c) => c[1] === cards[0][1]);

  const counts = new Map();
  for (const r of ranks) counts.set(r, (counts.get(r) || 0) + 1);
  // Group first by multiplicity, then by rank — both descending.
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);

  const distinct = [...new Set(ranks)];
  let straightHigh = 0;
  if (distinct.length === 5) {
    if (distinct[0] - distinct[4] === 4) straightHigh = distinct[0];
    // Wheel: A-5-4-3-2 plays as a five-high straight.
    else if (distinct[0] === 14 && distinct[1] === 5) straightHigh = 5;
  }

  const mk = (category, kickers) => ({ score: encode(category, kickers), category, tiebreak: kickers });

  if (straightHigh && flush) return mk(8, [straightHigh]);
  if (groups[0][1] === 4) return mk(7, [groups[0][0], groups[1][0]]);
  if (groups[0][1] === 3 && groups[1][1] === 2) return mk(6, [groups[0][0], groups[1][0]]);
  if (flush) return mk(5, ranks);
  if (straightHigh) return mk(4, [straightHigh]);
  if (groups[0][1] === 3) return mk(3, [groups[0][0], groups[1][0], groups[2][0]]);
  if (groups[0][1] === 2 && groups[1][1] === 2) return mk(2, [groups[0][0], groups[1][0], groups[2][0]]);
  if (groups[0][1] === 2) return mk(1, [groups[0][0], groups[1][0], groups[2][0], groups[3][0]]);
  return mk(0, ranks);
}

function combinations(n, k) {
  const out = [];
  const idx = Array.from({ length: k }, (_, i) => i);
  while (true) {
    out.push(idx.slice());
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i--;
    if (i < 0) break;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
  return out;
}

const COMBO_CACHE = new Map();
function combosFor(n) {
  if (!COMBO_CACHE.has(n)) COMBO_CACHE.set(n, combinations(n, 5));
  return COMBO_CACHE.get(n);
}

/**
 * Evaluate the best five-card hand from 5, 6 or 7 cards.
 * @returns {{ score:number, category:number, tiebreak:number[], name:string, nameZh:string, best5:string[] } | null}
 */
export function evaluate(cards) {
  if (!Array.isArray(cards) || cards.length < 5) return null;
  const combos = cards.length === 5 ? [null] : combosFor(cards.length);
  let best = null;
  let bestCards = null;
  for (const combo of combos) {
    const five = combo ? combo.map((i) => cards[i]) : cards;
    const r = rank5(five);
    if (!best || r.score > best.score) {
      best = r;
      bestCards = five.slice();
    }
  }
  return {
    ...best,
    name: CATEGORY_EN[best.category],
    nameZh: CATEGORY_ZH[best.category],
    best5: bestCards,
  };
}

export function compareHands(a, b) {
  return a.score - b.score;
}

/** Short Chinese description of the current made hand, used in AI prompts and the HUD. */
export function describeMadeHand(hole, board = []) {
  const all = [...(hole || []), ...(board || [])];
  if (hole && hole.length === 2 && board.length === 0) return describeHole(hole);
  if (all.length < 5) return null;
  const ev = evaluate(all);
  if (!ev) return null;
  // Report the full board only when it is actually complete.
  const suffix = board.length === 5 ? '' : '（当前成型）';
  return `${ev.nameZh}${suffix}`;
}

/** Preflop hole-card description, e.g. "口袋对子 A" / "AK 同花". */
export function describeHole(hole) {
  if (!hole || hole.length < 2) return '';
  const [a, b] = hole;
  const ra = rankOf(a);
  const rb = rankOf(b);
  const hi = Math.max(ra, rb);
  const lo = Math.min(ra, rb);
  const suited = a[1] === b[1];
  if (ra === rb) return `口袋对子 ${RANK_NAME_ZH[hi]}`;
  return `${RANK_NAME_ZH[hi]}${RANK_NAME_ZH[lo]} ${suited ? '同花' : '不同花'}`;
}
