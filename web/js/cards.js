import { el, clear } from './dom.js';

export const SUIT_SYMBOL = { s: '♠', h: '♥', d: '♦', c: '♣' };
export const RED_SUITS = new Set(['h', 'd']);

const rankDisplay = (card) => (card[0] === 'T' ? '10' : card[0]);
const isCourt = (card) => card[0] === 'J' || card[0] === 'Q' || card[0] === 'K';

/**
 * Standard pip positions as [xPercent, yPercent, inverted] on the card face.
 * Bottom-half pips are rotated 180°, exactly like a real deck.
 */
const PIP_LAYOUT = {
  A: [[50, 50, 0]],
  2: [[50, 20, 0], [50, 80, 1]],
  3: [[50, 20, 0], [50, 50, 0], [50, 80, 1]],
  4: [[27, 20, 0], [73, 20, 0], [27, 80, 1], [73, 80, 1]],
  5: [[27, 20, 0], [73, 20, 0], [50, 50, 0], [27, 80, 1], [73, 80, 1]],
  6: [[27, 20, 0], [73, 20, 0], [27, 50, 0], [73, 50, 0], [27, 80, 1], [73, 80, 1]],
  7: [[27, 20, 0], [73, 20, 0], [50, 35, 0], [27, 50, 0], [73, 50, 0], [27, 80, 1], [73, 80, 1]],
  8: [
    [27, 20, 0], [73, 20, 0], [50, 35, 0], [27, 50, 0], [73, 50, 0],
    [50, 65, 1], [27, 80, 1], [73, 80, 1],
  ],
  9: [
    [27, 19, 0], [73, 19, 0], [27, 39.5, 0], [73, 39.5, 0],
    [27, 60.5, 1], [73, 60.5, 1], [27, 81, 1], [73, 81, 1],
  ],
  T: [
    [27, 19, 0], [73, 19, 0], [50, 29, 0], [27, 39.5, 0], [73, 39.5, 0],
    [27, 60.5, 1], [73, 60.5, 1], [50, 71, 1], [27, 81, 1], [73, 81, 1],
  ],
};

export const cardText = (card) => (card ? `${rankDisplay(card)}${SUIT_SYMBOL[card[1]]}` : '');

function corner(rank, suit, position) {
  return el('span', { class: `card__corner card__corner--${position}` }, [
    el('span', { class: 'r', text: rank }),
    el('span', { class: 's', text: suit }),
  ]);
}

/** Create the flip skeleton once; the faces are (re)painted in place. */
export function buildCardShell() {
  const front = el('div', { class: 'card__face card__front' });
  const back = el('div', { class: 'card__face card__back' });
  const inner = el('div', { class: 'card__inner' }, [front, back]);
  const root = el('div', { class: 'card' }, [inner]);
  root._front = front;
  return root;
}

/** Paint a card face, or an empty placeholder when `card` is falsy. */
export function paintCard(root, card) {
  const front = root._front;
  clear(front);
  root.dataset.card = card ?? '';

  if (!card) {
    root.classList.add('card--empty');
    root.classList.remove('card--red');
    return;
  }

  root.classList.remove('card--empty');
  root.classList.toggle('card--red', RED_SUITS.has(card[1]));

  const rank = rankDisplay(card);
  const suit = SUIT_SYMBOL[card[1]];

  front.appendChild(corner(rank, suit, 'tl'));

  if (isCourt(card)) {
    front.appendChild(
      el('div', { class: 'card__court' }, [
        el('span', { class: 'letter', text: card[0] }),
        el('span', { class: 'suit', text: suit }),
      ]),
    );
  } else {
    const pips = el('div', { class: 'card__pips' });
    for (const [x, y, flip] of PIP_LAYOUT[card[0]] ?? []) {
      pips.appendChild(
        el('span', {
          class: 'pip',
          style: { '--x': `${x}%`, '--y': `${y}%`, '--flip': String(flip) },
          text: suit,
        }),
      );
    }
    front.appendChild(pips);
  }

  front.appendChild(corner(rank, suit, 'br'));
}

/**
 * A keyed list of cards that reuses DOM nodes, so a card flipping from back
 * to front animates instead of being replaced.
 */
export class CardRow {
  constructor(container, { stagger = 70 } = {}) {
    this.container = container;
    this.stagger = stagger;
    this.slots = [];
  }

  clear() {
    for (const slot of this.slots) slot.remove();
    this.slots = [];
  }

  /**
   * @param {{card: string|null, down?: boolean, dim?: boolean, winner?: boolean}[]} specs
   */
  render(specs) {
    const container = this.container;
    const created = [];

    while (this.slots.length < specs.length) {
      const root = buildCardShell();
      root.classList.add('card--enter');
      // Establish the empty state immediately so freshly created slots render
      // as dashed placeholders rather than blank white faces.
      paintCard(root, null);
      container.appendChild(root);
      created.push(this.slots.length);
      this.slots.push(root);
    }

    while (this.slots.length > specs.length) {
      this.slots.pop().remove();
    }

    specs.forEach((spec, index) => {
      const root = this.slots[index];
      const card = spec.card ?? null;
      const previous = root.dataset.card || '';
      const next = card || '';
      if (previous !== next) {
        paintCard(root, card);
        if (!previous && next) {
          // A slot filling in gets the deal animation.
          root.classList.remove('card--enter');
          void root.offsetWidth;
          root.classList.add('card--enter');
          root.style.animationDelay = '0ms';
        }
      }
      root.classList.toggle('is-down', Boolean(spec.down));
      root.classList.toggle('card--dim', Boolean(spec.dim));
      root.classList.toggle('card--winner', Boolean(spec.winner));
      if (created.includes(index)) {
        root.style.animationDelay = `${created.indexOf(index) * this.stagger}ms`;
      }
    });
  }
}
