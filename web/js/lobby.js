import { el, clear } from './dom.js';
import { fmt } from './format.js';

const MIN_SEATS = 2;
const MAX_SEATS = 9;
const DEFAULT_AVATARS = ['🧑', '🦊', '🐼', '🐯', '🐸', '🐙', '🦉', '🐺', '🐨'];

/**
 * Full-screen setup: how many seats, and who occupies each one.
 *
 * Seat 1 is always the person creating the room; every other seat can be an
 * AI character or a human who will get an invite link.
 */
export class Lobby {
  constructor({ root, onStart, onOpenSettings }) {
    this.root = root;
    this.onStart = onStart;
    this.onOpenSettings = onOpenSettings;
    this.roster = [];
    this.seatCount = 4;
    this.seats = [];
    this.rules = { smallBlind: 10, bigBlind: 20, startingStack: 2000 };
    this.busy = false;
    this.config = null;
  }

  get isOpen() {
    return Boolean(this.root.firstChild);
  }

  open({ config, roster, limits }) {
    this.config = config;
    this.roster = (roster ?? []).filter((r) => r.id !== 'you' && r.id !== 'human');
    this.limits = limits ?? { MIN_SEATS, MAX_SEATS };
    this.seatCount = Math.min(Math.max(config?.table?.seats ?? 4, this.limits.MIN_SEATS), this.limits.MAX_SEATS);
    this.rules = {
      smallBlind: config?.table?.smallBlind ?? 10,
      bigBlind: config?.table?.bigBlind ?? 20,
      startingStack: config?.table?.startingStack ?? 2000,
    };
    this.#syncSeats();
    this.#render();
  }

  close() {
    clear(this.root);
  }

  /** Grow/shrink the seat list, keeping whatever the user already chose. */
  #syncSeats() {
    const next = [];
    for (let i = 0; i < this.seatCount; i++) {
      const existing = this.seats[i];
      if (existing) {
        next.push(existing);
        continue;
      }
      if (i === 0) {
        next.push({ type: 'human', name: '你', avatar: '🧑', personalityId: null });
      } else {
        const personality = this.roster[(i - 1) % Math.max(1, this.roster.length)];
        next.push({
          type: 'ai',
          name: personality?.name ?? `AI ${i}`,
          avatar: personality?.avatar ?? '🤖',
          personalityId: personality?.id ?? null,
        });
      }
    }
    this.seats = next;
  }

  #patch(index, patch) {
    this.seats[index] = { ...this.seats[index], ...patch };
    this.#render();
  }

  // ------------------------------------------------------------- rendering

  #render() {
    const seatRows = this.seats.map((seat, index) => {
      const isHost = index === 0;
      const typeToggle = el('div', { class: 'seg' }, [
        el('button', {
          class: `seg__btn ${seat.type === 'human' ? 'is-on' : ''}`,
          type: 'button',
          text: '人类',
          disabled: isHost,
          on: {
            click: () => {
              if (isHost) return;
              const personality = this.roster.find((r) => r.id === seat.personalityId);
              this.#patch(index, {
                type: 'human',
                name: personality ? `玩家 ${index + 1}` : seat.name,
                avatar: DEFAULT_AVATARS[index % DEFAULT_AVATARS.length],
                personalityId: null,
              });
            },
          },
        }),
        el('button', {
          class: `seg__btn ${seat.type === 'ai' ? 'is-on' : ''}`,
          type: 'button',
          text: 'AI',
          on: {
            click: () => {
              if (seat.type === 'ai') return;
              const personality = this.roster[(index - 1 + this.roster.length) % Math.max(1, this.roster.length)];
              this.#patch(index, {
                type: 'ai',
                personalityId: personality?.id ?? null,
                name: personality?.name ?? 'AI',
                avatar: personality?.avatar ?? '🤖',
              });
            },
          },
        }),
      ]);

      let detail;
      if (seat.type === 'ai') {
        const select = el(
          'select',
          { class: 'select select--sm' },
          this.roster.map((p) =>
            el('option', {
              value: p.id,
              text: `${p.avatar} ${p.name}${p.title ? ` · ${p.title}` : ''}`,
              selected: p.id === seat.personalityId,
            }),
          ),
        );
        select.addEventListener('change', () => {
          const personality = this.roster.find((p) => p.id === select.value);
          this.#patch(index, {
            personalityId: select.value,
            name: personality?.name ?? seat.name,
            avatar: personality?.avatar ?? seat.avatar,
          });
        });
        detail = select;
      } else {
        const input = el('input', {
          class: 'input input--sm',
          value: seat.name,
          maxlength: '16',
          placeholder: '玩家名字',
          on: {
            input: (event) => {
              this.seats[index].name = event.target.value;
            },
          },
        });
        detail = input;
      }

      const tagline =
        seat.type === 'ai' && this.roster.find((p) => p.id === seat.personalityId)?.tagline
          ? el('div', { class: 'seat-row__hint', text: this.roster.find((p) => p.id === seat.personalityId).tagline })
          : el('div', { class: 'seat-row__hint', text: isHost ? '你自己 —— 这个座位由你操作' : '会生成一条邀请链接，发给他就能入座' });

      return el('div', { class: 'seat-row' }, [
        el('div', { class: 'seat-row__no' }, [
          el('span', { text: String(index + 1) }),
          isHost ? el('span', { class: 'seat-row__host', text: '房主' }) : null,
        ]),
        el('div', { class: 'seat-row__avatar', text: seat.avatar }),
        el('div', { class: 'seat-row__main' }, [detail, tagline]),
        typeToggle,
      ]);
    });

    const countButtons = [];
    for (let n = this.limits.MIN_SEATS; n <= this.limits.MAX_SEATS; n++) {
      countButtons.push(
        el('button', {
          class: `seg__btn ${n === this.seatCount ? 'is-on' : ''}`,
          type: 'button',
          text: String(n),
          on: {
            click: () => {
              this.seatCount = n;
              this.#syncSeats();
              this.#render();
            },
          },
        }),
      );
    }

    const numberInput = (key, label) => {
      const input = el('input', {
        class: 'input',
        type: 'number',
        value: String(this.rules[key]),
        on: { input: (e) => (this.rules[key] = Number(e.target.value)) },
      });
      return el('label', { class: 'field' }, [el('span', { class: 'field__label', text: label }), input]);
    };

    const ready = this.config?.ready;

    const card = el('div', { class: 'lobby__card' }, [
      el('div', { class: 'lobby__head' }, [
        el('span', { class: 'brand__mark', text: '♠' }),
        el('div', {}, [
          el('h1', { class: 'lobby__title', text: 'allin' }),
          el('p', { class: 'lobby__sub', text: '德州扑克 · 每个对手都由 LLM 扮演' }),
        ]),
        el('button', {
          class: 'btn btn--ghost lobby__settings',
          type: 'button',
          text: '⚙ 模型设置',
          on: { click: () => this.onOpenSettings?.() },
        }),
      ]),

      el('div', { class: 'lobby__body' }, [
        el('div', { class: 'lobby__section' }, [
          el('div', { class: 'lobby__row' }, [
            el('span', { class: 'field__label', text: '座位数' }),
            el('div', { class: 'seg' }, countButtons),
          ]),
          el('div', { class: 'lobby__seats' }, seatRows),
        ]),

        el('div', { class: 'lobby__section' }, [
          el('div', { class: 'grid-3' }, [
            numberInput('smallBlind', '小盲'),
            numberInput('bigBlind', '大盲'),
            numberInput('startingStack', '起始筹码'),
          ]),
        ]),

        !ready
          ? el('div', { class: 'lobby__warn' }, [
              el('span', { text: '⚠' }),
              el('span', {
                text: 'AI 供应商还没配好，开局后 AI 无法行动。可以先去「模型设置」填 OpenCode Go 的 Key，或选「离线演示」先试玩。',
              }),
            ])
          : el('div', { class: 'lobby__ok' }, [
              el('span', { text: '✓' }),
              el('span', { text: `AI 已就绪：${this.config.provider} · ${this.config.model}` }),
            ]),
      ]),

      el('div', { class: 'lobby__foot' }, [
        el('button', {
          class: 'btn btn--lg',
          type: 'button',
          text: '快速开始（4 人 · 全 AI）',
          on: { click: () => this.#submit(true) },
        }),
        el('span', { class: 'spacer' }),
        el('button', {
          class: 'btn btn--primary btn--lg',
          type: 'button',
          text: this.busy ? '正在建桌…' : '创建牌局并开局',
          disabled: this.busy,
          on: { click: () => this.#submit(false) },
        }),
      ]),
    ]);

    clear(this.root);
    this.root.appendChild(
      el('div', { class: 'lobby' }, [
        card,
        el('p', { class: 'lobby__hint', text: '同一个 WiFi 下的朋友打开邀请链接就能入座，不需要装任何东西。' }),
      ]),
    );
  }

  async #submit(quick) {
    if (this.busy) return;
    this.busy = true;
    const payload = quick
      ? {
          seats: 4,
          rules: this.rules,
        }
      : {
          seats: this.seatCount,
          players: this.seats.map((s, index) => ({
            type: index === 0 ? 'human' : s.type,
            name: s.name,
            avatar: s.avatar,
            personalityId: s.personalityId,
          })),
          rules: this.rules,
        };
    this.#render();
    try {
      await this.onStart(payload);
    } finally {
      this.busy = false;
    }
  }
}
