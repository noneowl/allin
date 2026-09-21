import { el, clear, toggleClass } from './dom.js';
import { CardRow } from './cards.js';
import { fmt, lastActionText, STREET_TEXT } from './format.js';

/** How long a spoken line stays visible above the speaker's avatar. */
const TALK_TTL_MS = 11000;

/** Newest table talk for a seat, if it is still fresh enough to show. */
function latestTalkFor(log, seatIndex, now = Date.now()) {
  if (!log) return null;
  let best = null;
  for (const entry of log) {
    if (entry.kind !== 'talk' || entry.seat !== seatIndex) continue;
    if (!best || entry.ts > best.ts) best = entry;
  }
  return best && now - best.ts < TALK_TTL_MS ? best : null;
}

/** Seat ring position on the rail. Angle 90° is the bottom (the human). */
function seatPoint(displayIndex, total) {
  const theta = ((90 + (displayIndex * 360) / total) * Math.PI) / 180;
  return {
    x: 50 + 44 * Math.cos(theta),
    y: 50 + 39 * Math.sin(theta),
  };
}

function betPoint(displayIndex, total) {
  const theta = ((90 + (displayIndex * 360) / total) * Math.PI) / 180;
  return {
    x: 50 + 25 * Math.cos(theta),
    y: 50 + 22 * Math.sin(theta),
  };
}

function chipPlan(amount) {
  const value = Math.max(1, Math.round(amount));
  const tiers = [
    [1000, 1000],
    [500, 500],
    [100, 100],
    [25, 25],
    [5, 5],
  ];
  for (const [threshold, denom] of tiers) {
    if (value >= threshold) {
      // Never stack more chips than the amount actually represents.
      return { denom, count: Math.min(4, Math.max(1, Math.floor(value / denom))) };
    }
  }
  return { denom: 5, count: 1 };
}

/**
 * Render a small decorative chip stack. Denominations are only printed when the
 * stack represents the amount exactly, so the graphic can never contradict the
 * numeric label next to it.
 */
function chipStack(amount) {
  const { denom, count } = chipPlan(amount);
  const exact = denom * count === Math.round(amount);
  const wrap = el('div', { class: 'chip-stack' });
  for (let i = 0; i < count; i++) {
    wrap.appendChild(
      el('div', { class: 'chip', dataset: { denom: String(denom) } }, exact
        ? [el('span', { class: 'chip__value', text: String(denom) })]
        : []),
    );
  }
  return wrap;
}

export class TableView {
  constructor({ seatsEl, betsEl, boardEl, potEl, streetEl }) {
    this.seatsEl = seatsEl;
    this.betsEl = betsEl;
    this.potEl = potEl;
    this.streetEl = streetEl;
    this.board = new CardRow(boardEl, { stagger: 95 });
    this.seatNodes = new Map();
    this.betNodes = new Map();
    this.lastLog = [];
  }

  // ------------------------------------------------------------- seat DOM

  #ensureSeat(seat) {
    let entry = this.seatNodes.get(seat.seat);
    if (entry) return entry;

    const dealer = el('span', { class: 'seat__dealer', text: 'D' });
    const avatarText = document.createTextNode('🙂');
    const avatar = el('div', { class: 'seat__avatar' }, [avatarText, dealer]);
    const nameEl = el('div', { class: 'seat__name' });
    const stackEl = el('div', { class: 'seat__stack' }, [
      el('span', { class: 'seat__chips' }),
      el('span', { class: 'seat__stack-value num' }),
    ]);
    const panel = el('div', { class: 'seat__panel' }, [
      avatar,
      el('div', { class: 'seat__info' }, [nameEl, stackEl]),
    ]);
    const cardsEl = el('div', { class: 'seat__cards' });
    const tagsEl = el('div', { class: 'seat__tags' });
    const bubble = el('div', { class: 'seat__bubble', hidden: true });
    const root = el('div', { class: 'seat' }, [cardsEl, panel, tagsEl, bubble]);

    entry = {
      root,
      avatar,
      avatarText,
      dealer,
      nameEl,
      stackEl,
      stackValue: stackEl.querySelector('.seat__stack-value'),
      tagsEl,
      bubble,
      cards: new CardRow(cardsEl, { stagger: 80 }),
      thinking: null,
    };
    this.seatNodes.set(seat.seat, entry);
    this.seatsEl.appendChild(root);
    return entry;
  }

  #paintSeat(entry, seat, table, { isHero, half }) {
    const thinking = table.ai?.[seat.seat];
    const isTurn = table.toAct === seat.seat;
    const winnerSeats = new Set((table.handResult?.awards ?? []).map((a) => a.seat));

    // Built from scratch each pass, so the caller must supply every state class.
    entry.root.className = 'seat';
    entry.root.dataset.seat = String(seat.seat);
    entry.root.dataset.half = half;
    if (isHero) entry.root.classList.add('seat--hero');
    toggleClass(entry.root, 'is-turn', isTurn);
    toggleClass(entry.root, 'is-folded', seat.folded && !seat.out);
    toggleClass(entry.root, 'is-out', seat.out);
    toggleClass(entry.root, 'is-winner', winnerSeats.has(seat.seat));

    entry.avatarText.nodeValue = seat.avatar ?? '🙂';
    entry.dealer.hidden = !seat.isDealer;

    // name + position tag
    clear(entry.nameEl);
    entry.nameEl.appendChild(el('span', { text: seat.name }));
    if (seat.position) {
      entry.nameEl.appendChild(el('span', { class: 'tag', text: seat.position }));
    }

    entry.stackValue.textContent = fmt(seat.stack);
    toggleClass(entry.stackEl, 'is-short', seat.stack > 0 && seat.stack <= table.bigBlind * 5);

    // hole cards
    const showdown = (table.handResult?.showdown ?? []).find((s) => s.seat === seat.seat);
    const best5 = new Set(showdown?.best5 ?? []);
    let specs;
    if (seat.hole && seat.hole.length) {
      specs = seat.hole.map((card) => ({
        card,
        dim: seat.folded,
        winner: best5.has(card),
      }));
    } else if (seat.holeCount > 0 && !seat.out) {
      specs = Array.from({ length: seat.holeCount }, () => ({ card: null, down: true, dim: seat.folded }));
    } else {
      specs = [];
    }
    entry.cards.render(specs);

    // spoken line, shown as a bubble hanging off the avatar
    const talk = latestTalkFor(table.log, seat.seat);
    if (talk) {
      entry.bubble.textContent = talk.text;
      entry.bubble.hidden = false;
    } else {
      entry.bubble.hidden = true;
    }

    // status tags / thinking indicator
    clear(entry.tagsEl);
    if (thinking) {
      const badge = el('div', { class: 'thinking' }, [
        el('span', { class: 'thinking__dots' }, [el('i'), el('i'), el('i')]),
        el('span', { class: 'thinking-label', text: '思考中 0s' }),
      ]);
      badge.dataset.started = String(thinking.startedAt ?? Date.now());
      entry.tagsEl.appendChild(badge);
      entry.thinking = badge;
    } else {
      entry.thinking = null;
      if (seat.out) {
        entry.tagsEl.appendChild(el('span', { class: 'tag', text: '出局' }));
      } else if (seat.folded) {
        entry.tagsEl.appendChild(el('span', { class: 'tag', text: '已弃牌' }));
      } else if (seat.allIn) {
        entry.tagsEl.appendChild(el('span', { class: 'tag tag--allin', text: '全下' }));
      }
      const badge = lastActionText(seat.lastAction);
      if (badge && !seat.folded && !seat.allIn) {
        entry.tagsEl.appendChild(el('span', { class: `tag ${badge.cls}`, text: badge.text }));
      }
      if (seat.handNameZh && !seat.folded) {
        entry.tagsEl.appendChild(el('span', { class: 'tag tag--hand', text: seat.handNameZh }));
      }
      if (seat.isHuman && seat.connected === false && !seat.out && !seat.folded) {
        entry.tagsEl.appendChild(el('span', { class: 'tag tag--offline', text: '离线' }));
      }
      if (winnerSeats.has(seat.seat)) {
        const award = (table.handResult?.awards ?? []).find((a) => a.seat === seat.seat);
        entry.tagsEl.appendChild(el('span', { class: 'tag tag--win', text: `+${fmt(award?.amount ?? 0)}` }));
      }
    }
  }

  // --------------------------------------------------------------- bets

  #paintBets(table, displayIndex) {
    const show = table.phase === 'playing';
    const seen = new Set();

    for (const seat of table.seats) {
      const amount = seat.committed;
      if (!show || amount <= 0 || seat.out) continue;
      seen.add(seat.seat);
      let node = this.betNodes.get(seat.seat);
      if (!node) {
        node = el('div', { class: 'bet' }, [chipStack(amount), el('div', { class: 'bet__amount num' })]);
        this.betNodes.set(seat.seat, node);
        this.betsEl.appendChild(node);
      }
      const point = betPoint(displayIndex(seat.seat), table.seats.length);
      node.style.setProperty('--x', `${point.x}%`);
      node.style.setProperty('--y', `${point.y}%`);
      node.querySelector('.bet__amount').textContent = fmt(amount);
      // rebuild the chips only when the denomination bucket changes
      const plan = chipPlan(amount);
      if (node.dataset.plan !== `${plan.denom}x${plan.count}`) {
        node.dataset.plan = `${plan.denom}x${plan.count}`;
        node.replaceChild(chipStack(amount), node.firstChild);
      }
    }

    for (const [seat, node] of this.betNodes) {
      if (!seen.has(seat)) {
        node.remove();
        this.betNodes.delete(seat);
      }
    }
  }

  // ------------------------------------------------------------- center

  #paintCenter(table) {
    const specs = Array.from({ length: 5 }, (_, i) => (table.board[i] ? { card: table.board[i] } : { card: null }));
    this.board.render(specs);

    const label = table.phase === 'showdown' || table.phase === 'handover' ? '摊牌' : STREET_TEXT[table.street] ?? '';
    this.streetEl.textContent = table.phase === 'gameover' ? '牌局结束' : label;

    clear(this.potEl);
    if (table.potTotal <= 0) return;
    this.potEl.appendChild(chipStack(table.potTotal));
    this.potEl.appendChild(el('span', { class: 'pot__label', text: '底池' }));
    this.potEl.appendChild(el('span', { class: 'pot__amount num', text: fmt(table.potTotal) }));
    if (table.pots && table.pots.length > 1) {
      const parts = table.pots.map((p, i) => `${i === 0 ? '主池' : `边池${i}`} ${fmt(p.amount)}`);
      this.potEl.appendChild(el('span', { class: 'pot__side', text: parts.join(' · ') }));
    }
  }

  // --------------------------------------------------------------- render

  render(table) {
    if (!table || !Array.isArray(table.seats)) {
      for (const [, entry] of this.seatNodes) entry.root.remove();
      this.seatNodes.clear();
      for (const [, node] of this.betNodes) node.remove();
      this.betNodes.clear();
      this.board.render([]);
      clear(this.potEl);
      this.streetEl.textContent = '';
      return;
    }

    this.lastLog = table.log ?? [];
    const total = table.seats.length;
    // Every player sees themselves at the bottom, so seats rotate per viewer.
    const viewerSeat = table.viewerSeat ?? 0;
    const displayIndex = (seat) => (((seat - viewerSeat) % total) + total) % total;
    const liveSeats = new Set(table.seats.map((s) => s.seat));

    for (const [seatIndex, entry] of this.seatNodes) {
      if (!liveSeats.has(seatIndex)) {
        entry.root.remove();
        this.seatNodes.delete(seatIndex);
      }
    }

    for (const seat of table.seats) {
      const entry = this.#ensureSeat(seat);
      const point = seatPoint(displayIndex(seat.seat), total);
      entry.root.style.setProperty('--x', `${point.x}%`);
      entry.root.style.setProperty('--y', `${point.y}%`);
      this.#paintSeat(entry, seat, table, {
        isHero: seat.seat === viewerSeat,
        half: point.y > 46 ? 'bottom' : 'top',
      });
    }

    this.#paintBets(table, displayIndex);

    for (const seat of table.seats) {
      const node = this.betNodes.get(seat.seat);
      if (!node) continue;
      const point = betPoint(displayIndex(seat.seat), total);
      node.style.setProperty('--x', `${point.x}%`);
      node.style.setProperty('--y', `${point.y}%`);
    }

    this.#paintCenter(table);
  }

  /** Cheap periodic update: thinking timers and expiring speech bubbles. */
  tick() {
    const now = Date.now();
    for (const [seatIndex, entry] of this.seatNodes) {
      if (entry.thinking) {
        const started = Number(entry.thinking.dataset.started) || now;
        const seconds = Math.max(0, Math.round((now - started) / 1000));
        const label = entry.thinking.querySelector('.thinking-label');
        if (label) label.textContent = `思考中 ${seconds}s`;
      }
      // Bubbles are driven by wall-clock age, so they must be re-checked even
      // when no new state arrives.
      if (!entry.bubble.hidden) {
        const talk = latestTalkFor(this.lastLog, seatIndex, now);
        if (!talk) entry.bubble.hidden = true;
      }
    }
  }
}
