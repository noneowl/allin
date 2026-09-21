import { el, clear } from './dom.js';
import { CardRow, cardText } from './cards.js';
import { fmt, clamp, lastActionText, STREET_TEXT, ACTION_TEXT } from './format.js';

export class Hud {
  constructor({ refs, actions }) {
    this.refs = refs;
    this.actions = actions;
    this.feedIds = new Set();
    this.lastFeedId = 0;
    this.feedSealState = null;
    this.raiseValue = 0;
    this.decisionKey = null;
    this.liveNodes = new Map();
    this.overlayKind = null;
    this.autoAdvanceTimer = null;
    this.countdownTimer = null;
    this.#buildRaisePanel();
  }

  // ------------------------------------------------------------- topbar

  renderTopbar(table) {
    const host = this.refs.topbarStats;
    clear(host);
    const roomId = table?.roomId;
    if (roomId) host.appendChild(stat('牌局', roomId));
    if (!table) {
      host.appendChild(stat('状态', '未开局'));
      return;
    }
    host.appendChild(stat('盲注', `${table.smallBlind} / ${table.bigBlind}`));
    host.appendChild(stat('手数', `#${table.handId}`));
    host.appendChild(stat('阶段', table.phase === 'gameover' ? '已结束' : STREET_TEXT[table.street] ?? '—'));
    host.appendChild(stat('底池', fmt(table.potTotal), 'stat--pot'));

    const me = table.seats.find((s) => s.seat === table.viewerSeat);
    if (me) host.appendChild(stat('你的筹码', fmt(me.stack)));
  }

  renderModelPill(cfg) {
    const pill = this.refs.modelPill;
    if (!cfg) {
      pill.textContent = '—';
      return;
    }
    pill.textContent = cfg.ready ? cfg.model : '未配置';
    pill.className = `pill ${cfg.ready ? 'pill--gold' : 'pill--red'}`;
    pill.title = cfg.ready ? `${cfg.provider} · ${cfg.model}` : '尚未配置 AI 供应商，请打开设置';
  }

  // --------------------------------------------------------- action bar

  #buildRaisePanel() {
    const host = this.refs.actionbar;
    clear(host);

    const heroCards = el('div', { class: 'card-row' });
    const heroHand = el('strong', { text: '—' });
    const heroHint = el('span', { text: '—' });
    const handBlock = el('div', { class: 'actionbar__hand' }, [
      heroCards,
      el('div', { class: 'hand-meta' }, [heroHand, heroHint]),
    ]);
    this.refs.heroCards = heroCards;
    this.heroCards = new CardRow(heroCards, { stagger: 60 });
    this.heroHandEl = heroHand;
    this.heroHintEl = heroHint;

    this.mainEl = el('div', { class: 'actionbar__main' });

    this.raiseLabel = el('span', { class: 'raise-head__label', text: '加注到' });
    this.raiseValueEl = el('span', { class: 'raise-head__value num', text: '0' });
    this.raiseHintEl = el('span', { class: 'raise-head__hint', text: '' });

    this.slider = el('input', { class: 'slider', type: 'range', min: '0', max: '100', value: '0' });
    this.slider.addEventListener('input', () => {
      this.raiseValue = Number(this.slider.value);
      this.#syncRaiseDisplay();
    });

    this.quickButtons = [
      ['1/2 池', 0.5],
      ['3/4 池', 0.75],
      ['1 池', 1],
      ['全下', Infinity],
    ].map(([label, fraction]) =>
      el('button', {
        type: 'button',
        text: label,
        on: { click: () => this.#applyQuickRaise(fraction) },
      }),
    );

    this.raiseQuickEl = el('div', { class: 'raise-quick' }, this.quickButtons);
    this.raisePanel = el('div', { class: 'actionbar__raise' }, [
      el('div', { class: 'raise-head' }, [this.raiseLabel, this.raiseValueEl, this.raiseHintEl]),
      this.slider,
      this.raiseQuickEl,
    ]);

    host.append(handBlock, this.mainEl, this.raisePanel);
  }

  #applyQuickRaise(fraction) {
    const range = this.raiseRange;
    if (!range) return;
    const { minTo, maxTo, toCall, pot } = range;
    const target = fraction === Infinity ? maxTo : toCall + fraction * (pot + toCall);
    this.raiseValue = clamp(Math.round(target), minTo, maxTo);
    this.slider.value = String(this.raiseValue);
    this.#syncRaiseDisplay();
  }

  #syncRaiseDisplay() {
    const range = this.raiseRange;
    if (!range) return;
    this.raiseValueEl.textContent = fmt(this.raiseValue);
    const span = range.maxTo - range.minTo;
    const fill = span > 0 ? ((this.raiseValue - range.minTo) / span) * 100 : 100;
    this.slider.style.setProperty('--fill', `${fill}%`);
    const isAllIn = this.raiseValue >= range.maxTo;
    this.raiseLabel.textContent = range.isOpen ? '下注' : '加注到';
    this.raiseHintEl.textContent = isAllIn ? '全下' : `范围 ${fmt(range.minTo)} – ${fmt(range.maxTo)}`;
  }

  renderActionBar(state) {
    const table = state && Array.isArray(state.seats) ? state : null;
    const main = this.mainEl;

    if (!table) {
      clear(main);
      main.appendChild(el('div', { class: 'actionbar__wait', text: '等待开局…' }));
      this.raisePanel.style.display = 'none';
      this.heroCards.render([]);
      this.heroHandEl.textContent = '—';
      this.heroHintEl.textContent = '在右上角「设置」里配置 AI 供应商后即可开局';
      return;
    }

    const me = table.seats.find((s) => s.seat === table.viewerSeat);
    this.heroCards.render(me?.hole?.length ? me.hole.map((card) => ({ card })) : []);
    if (me) {
      this.heroHandEl.textContent = me.handNameZh ?? '—';
      const toCall = Math.max(0, table.currentBet - me.committed);
      this.heroHintEl.textContent =
        toCall > 0 ? `需跟注 ${fmt(toCall)}` : `底池 ${fmt(table.potTotal)} · 免费看牌`;
    }

    clear(main);

    if (table.phase === 'gameover') {
      main.appendChild(el('div', { class: 'actionbar__wait', text: '牌局已结束' }));
      this.raisePanel.style.display = 'none';
      return;
    }

    if (table.phase === 'handover' || table.phase === 'showdown') {
      main.appendChild(
        el('button', {
          class: 'btn btn--lg btn--primary',
          text: '开始下一手',
          on: { click: () => this.actions.onNextHand() },
        }),
      );
      this.raisePanel.style.display = 'none';
      return;
    }

    const legal = table.legalActions ?? [];
    const isMyTurn = table.toAct === table.viewerSeat && legal.length > 0;

    if (!isMyTurn) {
      const actor = table.seats.find((s) => s.seat === table.toAct);
      const thinking = actor && table.ai?.[actor.seat];
      const offline = actor?.isHuman && !actor.connected;
      main.appendChild(
        el('div', { class: 'actionbar__wait' }, [
          thinking ? el('span', { class: 'thinking__dots' }, [el('i'), el('i'), el('i')]) : el('span', { text: offline ? '🔌' : '⏳' }),
          el('span', { text: actor ? `等待 ${actor.name} 行动…${offline ? '（已离线）' : ''}` : '等待中…' }),
        ]),
      );
      if (offline) {
        main.appendChild(
          el('button', {
            class: 'btn btn--lg',
            text: '代为过牌/弃牌',
            title: '这位玩家已经断开连接，房主可以帮他行动，避免牌局卡住',
            on: { click: () => this.actions.onForce(actor.seat) },
          }),
        );
      }
      this.raisePanel.style.display = 'none';
      return;
    }

    const byType = new Map(legal.map((a) => [a.type, a]));
    const toCall = Math.max(0, table.currentBet - me.committed);

    const foldBtn = el('button', {
      class: 'btn btn--lg btn--fold',
      text: '弃牌',
      on: { click: () => this.actions.onAction({ action: 'fold' }) },
    });

    let passiveBtn = null;
    if (byType.has('check')) {
      passiveBtn = el('button', {
        class: 'btn btn--lg btn--call',
        text: '过牌',
        on: { click: () => this.actions.onAction({ action: 'check' }) },
      });
    } else if (byType.has('call')) {
      const spec = byType.get('call');
      const allIn = spec.amount >= me.stack;
      passiveBtn = el('button', {
        class: 'btn btn--lg btn--call',
        text: allIn ? `全下跟注 ${fmt(spec.amount)}` : `跟注 ${fmt(spec.amount)}`,
        on: { click: () => this.actions.onAction({ action: 'call' }) },
      });
    }

    // Conventional layout: fold on the left, the passive option next, raise last.
    main.appendChild(foldBtn);
    if (passiveBtn) main.appendChild(passiveBtn);

    const raiseSpec = byType.get('raise') ?? byType.get('bet');
    const allInSpec = byType.get('all_in');
    if (raiseSpec) {
      const decisionKey = [
        table.handId,
        table.street,
        table.toAct,
        table.currentBet,
        table.potTotal,
        raiseSpec.minTo,
        raiseSpec.maxTo,
      ].join(':');

      this.raiseRange = {
        minTo: raiseSpec.minTo,
        maxTo: raiseSpec.maxTo,
        toCall,
        pot: table.potTotal,
        isOpen: raiseSpec.type === 'bet',
      };

      if (this.decisionKey !== decisionKey) {
        this.decisionKey = decisionKey;
        this.raiseValue = clamp(raiseSpec.minTo, raiseSpec.minTo, raiseSpec.maxTo);
        this.slider.min = String(raiseSpec.minTo);
        this.slider.max = String(raiseSpec.maxTo);
        this.slider.step = '1';
        this.slider.value = String(this.raiseValue);
      }
      this.slider.disabled = false;
      this.quickButtons.forEach((b) => (b.disabled = false));
      this.#syncRaiseDisplay();

      const raiseBtn = el('button', {
        class: 'btn btn--lg btn--raise',
        text: raiseSpec.type === 'bet' ? '下注' : '加注',
        on: {
          click: () =>
            this.actions.onAction({
              action: raiseSpec.type,
              amount: this.raiseValue,
            }),
        },
      });
      main.appendChild(raiseBtn);
      this.raisePanel.style.display = '';
    } else {
      this.raiseRange = null;
      this.decisionKey = null;
      this.raisePanel.style.display = 'none';
    }

    if (allInSpec && !raiseSpec) {
      main.appendChild(
        el('button', {
          class: 'btn btn--lg btn--raise',
          text: `全下 ${fmt(allInSpec.to)}`,
          on: { click: () => this.actions.onAction({ action: 'all_in' }) },
        }),
      );
    }
  }

  // --------------------------------------------------------------- feed

  renderFeed(table) {
    const host = this.refs.feed;
    const log = table?.log ?? [];

    // When a hand ends the server unseals the reasoning, which rewrites
    // entries we already rendered — so rebuild from scratch at that moment.
    const sealState = Boolean(table?.secretsRevealed);
    if (sealState !== this.feedSealState) {
      this.feedSealState = sealState;
      clear(host);
      this.feedIds.clear();
      this.lastFeedId = 0;
      for (const [, node] of this.liveNodes) node.remove();
      this.liveNodes.clear();
    }

    if (!log.length) {
      if (this.lastFeedId !== 0) {
        clear(host);
        this.feedIds.clear();
        this.lastFeedId = 0;
      }
      this.#renderLive(table);
      return;
    }

    const firstId = log[0].id;
    if (firstId > this.lastFeedId) {
      // The server trimmed or replaced the log: start over.
      clear(host);
      this.feedIds.clear();
      this.lastFeedId = 0;
    }

    for (const entry of log) {
      if (this.feedIds.has(entry.id)) continue;
      this.feedIds.add(entry.id);
      this.lastFeedId = Math.max(this.lastFeedId, entry.id);
      host.appendChild(this.#feedNode(entry));
    }

    if (this.feedIds.size > 400) {
      // Keep the client-side set from growing without bound.
      const keep = new Set(log.map((e) => e.id));
      this.feedIds = keep;
    }

    this.#renderLive(table);
    // Only follow the tail when the reader is already near the bottom.
    const nearBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 90;
    if (nearBottom) host.scrollTop = host.scrollHeight;
  }

  #feedNode(entry) {
    if (entry.kind === 'reason') {
      // The server withholds the text while the hand is live, so there is
      // nothing here to leak even via devtools.
      if (entry.sealed || !entry.text) {
        return el('div', { class: 'ai-card ai-card--sealed' }, [
          el('div', { class: 'ai-card__head' }, [
            el('span', { class: 'ai-card__avatar', text: '🔒' }),
            el('span', { text: `${entry.name ?? 'AI'} 正在思考` }),
            el('span', { class: 'ai-card__meta', text: '本手结束后揭晓' }),
          ]),
        ]);
      }
      const card = el('div', { class: 'ai-card' }, [
        el('div', { class: 'ai-card__head' }, [
          el('span', { class: 'ai-card__avatar', text: entry.avatar ?? '🤖' }),
          el('span', { text: entry.name ?? 'AI' }),
          el('span', { class: 'ai-card__meta', text: entry.latencyMs ? `${(entry.latencyMs / 1000).toFixed(1)}s` : '' }),
        ]),
        entry.text ? el('div', { class: 'ai-card__body', text: entry.text }) : null,
        entry.action
          ? el('span', {
              class: `ai-card__action ${entry.action === 'fold' ? 'ai-card__action--fold' : ''} ${
                entry.action === 'check' || entry.action === 'call' ? 'ai-card__action--passive' : ''
              }`,
              text: describeAction(entry.action, entry.amount),
            })
          : null,
      ]);
      return card;
    }

    if (entry.kind === 'talk') {
      return el('div', { class: 'feed__item feed__talk', text: `${entry.name ?? ''}：「${entry.text}」` });
    }

    const cls = `feed__item feed__item--${entry.kind ?? 'action'}`;
    if (entry.kind === 'action' && entry.name) {
      return el('div', { class: cls }, [el('strong', { text: `${entry.name} ` }), entry.text.replace(`${entry.name} `, '')]);
    }
    return el('div', { class: cls, text: entry.text });
  }

  #renderLive(table) {
    const host = this.refs.feed;
    const active = new Set();

    for (const [seatKey, info] of Object.entries(table?.ai ?? {})) {
      active.add(seatKey);
      let node = this.liveNodes.get(seatKey);
      if (!node) {
        node = el('div', { class: 'ai-card ai-card--live' }, [
          el('div', { class: 'ai-card__head' }, [
            el('span', { class: 'ai-card__avatar', text: info.avatar ?? '🤖' }),
            el('span', { text: `${info.name} 正在思考` }),
            el('span', { class: 'ai-card__meta live-timer', text: '0.0s' }),
          ]),
          el('div', { class: 'ai-card__shimmer' }),
        ]);
        node.dataset.started = String(info.startedAt ?? Date.now());
        this.liveNodes.set(seatKey, node);
        host.appendChild(node);
      }
      node.querySelector('.live-timer').textContent = `${((Date.now() - (info.startedAt ?? Date.now())) / 1000).toFixed(1)}s`;
    }

    for (const [seatKey, node] of this.liveNodes) {
      if (!active.has(seatKey)) {
        node.remove();
        this.liveNodes.delete(seatKey);
      }
    }
    for (const [seatKey, node] of this.liveNodes) {
      node.querySelector('.live-timer').textContent = `${(
        (Date.now() - (Number(node.dataset.started) || Date.now())) /
        1000
      ).toFixed(1)}s`;
    }
  }

  // ------------------------------------------------------------- toasts

  toast({ level = 'info', message, ttl = 4200 }) {
    const node = el('div', { class: `toast toast--${level}` }, [
      el('span', { text: level === 'error' ? '⚠' : level === 'success' ? '✓' : 'ℹ' }),
      el('span', { text: message }),
    ]);
    this.refs.toasts.appendChild(node);
    setTimeout(() => {
      node.classList.add('is-leaving');
      setTimeout(() => node.remove(), 240);
    }, ttl);
  }

  // ----------------------------------------------------------- overlays

  clearOverlay() {
    if (this.autoAdvanceTimer) clearTimeout(this.autoAdvanceTimer);
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    this.autoAdvanceTimer = null;
    this.countdownTimer = null;
    this.overlayKind = null;
    if (this.overlayNode) {
      this.overlayNode.remove();
      this.overlayNode = null;
    }
  }

  #mountOverlay(content) {
    if (!this.overlayNode) {
      this.overlayNode = el('div', { class: 'overlay' }, [content]);
      this.refs.tableArea.appendChild(this.overlayNode);
    } else {
      clear(this.overlayNode);
      this.overlayNode.appendChild(content);
    }
  }

  showLocked(reason) {
    if (this.overlayKind === 'locked') return;
    this.clearOverlay();
    this.overlayKind = 'locked';
    this.#mountOverlay(
      el('div', { class: 'locked' }, [
        el('div', { class: 'locked__icon', text: '🔑' }),
        el('div', { class: 'locked__title', text: '需要配置 AI 供应商' }),
        el('div', {
          class: 'locked__text',
          text: reason || '对手的每一个决定都由 LLM 做出，所以必须先接入一个供应商。推荐 OpenCode Go（订阅后复制 API Key 即可）。',
        }),
        el('button', {
          class: 'btn btn--primary btn--lg',
          text: '打开设置',
          on: { click: () => this.actions.onSettings() },
        }),
      ]),
    );
  }

  closeInvites() {
    this.inviteBackdrop?.remove();
    this.inviteBackdrop = null;
  }

  /** Invite links for the other human seats, plus AI seats you could hand over. */
  showInvites(payload) {
    if (this.inviteBackdrop) {
      const sameRoom = this.inviteRoomId === payload?.roomId;
      this.closeInvites();
      // A second click on the toolbar button closes the panel; an explicit
      // refresh (after converting a seat) reopens it with fresh data.
      if (sameRoom && !payload?.refresh) return;
    }
    this.#openInvites(payload ?? {});
  }

  #openInvites({ roomId, invites, players, openSeats }) {
    this.inviteRoomId = roomId;
    const rows = (invites ?? []).map((invite) => {
      const player = players?.find((p) => p.index === invite.seat);
      const url = el('div', { class: 'invite-row__url', text: invite.url });
      const copy = el('button', {
        class: 'btn',
        type: 'button',
        text: '复制',
        on: {
          click: async () => {
            try {
              await navigator.clipboard.writeText(invite.url);
              this.toast({ level: 'success', message: `已复制 ${invite.name} 的邀请链接` });
            } catch {
              const range = document.createRange();
              range.selectNodeContents(url);
              const selection = window.getSelection();
              selection.removeAllRanges();
              selection.addRange(range);
              this.toast({ level: 'warn', message: '浏览器不允许自动复制，链接已选中，请按 ⌘C' });
            }
          },
        },
      });
      return el('div', { class: `invite-row ${player && !player.connected ? 'invite-seat--offline' : ''}` }, [
        el('div', { class: 'invite-row__who' }, [
          el('span', { text: player?.avatar ?? '🙂' }),
          el('span', { text: invite.name }),
          player?.connected
            ? el('span', { class: 'pill pill--green', text: '已入座' })
            : el('span', { class: 'pill', text: '未入座' }),
        ]),
        url,
        copy,
      ]);
    });

    // AI seats the host can hand to a person — this is what makes "邀请"
    // work on a table created with the quick-start defaults.
    const claimable = (openSeats ?? []).map((seat) =>
      el('div', { class: 'invite-row invite-row--claim' }, [
        el('div', { class: 'invite-row__who' }, [
          el('span', { text: seat.avatar }),
          el('span', { text: seat.name }),
          el('span', { class: 'pill', text: 'AI' }),
        ]),
        el('div', { class: 'invite-row__url invite-row__muted', text: '改成真人后会生成专属链接' }),
        el('button', {
          class: 'btn btn--primary',
          type: 'button',
          text: '邀请人坐这里',
          on: { click: () => this.actions.onClaimSeat?.(seat.index) },
        }),
      ]),
    );

    const modal = el('div', { class: 'modal' }, [
      el('div', { class: 'modal__head' }, [
        el('div', {}, [
          el('div', { class: 'modal__title', text: '邀请入座' }),
          el('div', { class: 'modal__sub', text: `牌局 ${roomId} · 同一个 WiFi 下的人打开链接即可入座` }),
        ]),
        el('button', {
          class: 'modal__close',
          type: 'button',
          text: '✕',
          on: { click: () => this.closeInvites() },
        }),
      ]),
      el('div', { class: 'modal__body' }, [
        rows.length
          ? el('div', { class: 'invite-list' }, rows)
          : el('div', { class: 'invite-empty' }, [
              el('div', { class: 'invite-empty__icon', text: '🪑' }),
              el('div', { class: 'invite-empty__title', text: '还没有留给真人的座位' }),
              el('div', {
                class: 'invite-empty__text',
                text: claimable.length
                  ? '下面这些座位现在是 AI 在打。挑一个改成真人，就会生成属于他的邀请链接。'
                  : '这一桌已经坐满了真人。',
              }),
            ]),
        claimable.length
          ? el('div', {}, [
              el('div', { class: 'section-title', text: '把 AI 座位让给真人' }),
              el('div', { class: 'invite-list' }, claimable),
            ])
          : null,
        el('div', {
          class: 'hint',
          text: '改座位会重新发一手牌。每个人的链接只能给他自己用，链接里带着专属凭证 —— 对方只能看到自己的底牌，也只能操作自己的座位。',
        }),
      ]),
    ]);

    this.inviteBackdrop = el(
      'div',
      {
        class: 'modal-backdrop',
        on: {
          click: (event) => {
            if (event.target === this.inviteBackdrop) this.closeInvites();
          },
        },
      },
      [modal],
    );
    this.refs.modalRoot.appendChild(this.inviteBackdrop);
  }

  showHandResult(table) {
    if (this.overlayKind === 'result') return;
    this.clearOverlay();
    this.overlayKind = 'result';
    const result = table.handResult;
    if (!result) return;

    const winners = (result.awards ?? []).reduce((map, award) => {
      map.set(award.seat, (map.get(award.seat) ?? 0) + award.amount);
      return map;
    }, new Map());

    const heroWon = winners.has(table.viewerSeat);
    const winnerNames = [...winners.keys()]
      .map((seat) => table.seats.find((s) => s.seat === seat)?.name ?? `座位 ${seat}`)
      .join('、');

    const rows = (result.showdown ?? [])
      .slice()
      .sort((a, b) => (winners.has(b.seat) ? 1 : 0) - (winners.has(a.seat) ? 1 : 0))
      .map((entry) => {
        const seat = table.seats.find((s) => s.seat === entry.seat);
        const won = winners.get(entry.seat);
        return el('div', { class: `result-row ${won ? 'result-row--win' : ''}` }, [
          el('span', { text: seat?.avatar ?? '🙂' }),
          el('span', { class: 'result-row__name', text: entry.name }),
          el('span', { class: 'result-row__hand num', text: entry.hole.map(cardText).join(' ') }),
          el('span', { class: 'result-row__hand', text: entry.nameZh ?? '' }),
          won ? el('span', { class: 'result-row__amount', text: `+${fmt(won)}` }) : null,
        ]);
      });

    const foldRows =
      result.uncontested && result.winnerSeat !== null
        ? [
            el('div', { class: 'result-row result-row--win' }, [
              el('span', { text: table.seats.find((s) => s.seat === result.winnerSeat)?.avatar ?? '🙂' }),
              el('span', { class: 'result-row__name', text: table.seats.find((s) => s.seat === result.winnerSeat)?.name ?? '' }),
              el('span', { class: 'result-row__hand', text: '其他人都弃牌' }),
              el('span', { class: 'result-row__amount', text: `+${fmt(result.amount ?? 0)}` }),
            ]),
          ]
        : [];

    const countdown = el('div', { class: 'hint', text: '' });

    const banner = el('div', { class: 'result-banner' }, [
      el('div', { class: 'result-banner__kicker', text: `第 ${result.handId} 手 · ${STREET_TEXT[result.street] ?? ''}` }),
      el('div', {
        class: 'result-banner__title',
        text: heroWon ? `你赢得 ${fmt(winners.get(table.viewerSeat))}` : `${winnerNames} 赢得 ${fmt(result.amount ?? 0)}`,
      }),
      el('div', {
        class: 'result-banner__sub',
        text: result.uncontested ? '其他人都弃牌，无需摊牌。' : '摊牌结果如下。',
      }),
      el('div', { class: 'result-banner__rows' }, [...foldRows, ...rows]),
      countdown,
      el('div', { class: 'result-banner__actions' }, [
        el('button', {
          class: 'btn btn--primary btn--lg',
          text: '下一手',
          on: { click: () => this.actions.onNextHand() },
        }),
        el('button', {
          class: 'btn btn--lg',
          text: '停一下',
          on: { click: () => this.#pauseAutoAdvance(countdown) },
        }),
      ]),
    ]);

    this.#mountOverlay(banner);

    let remaining = 8;
    countdown.textContent = `${remaining} 秒后自动开始下一手`;
    this.countdownTimer = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(this.countdownTimer);
        countdown.textContent = '正在开始下一手…';
        return;
      }
      countdown.textContent = `${remaining} 秒后自动开始下一手`;
    }, 1000);
    this.autoAdvanceTimer = setTimeout(() => {
      if (this.overlayKind === 'result') this.actions.onNextHand();
    }, remaining * 1000);
  }

  #pauseAutoAdvance(countdown) {
    if (this.autoAdvanceTimer) clearTimeout(this.autoAdvanceTimer);
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    this.autoAdvanceTimer = null;
    this.countdownTimer = null;
    countdown.textContent = '自动开始已暂停 — 点击「下一手」继续';
  }

  showGameOver(table) {
    if (this.overlayKind === 'gameover') return;
    this.clearOverlay();
    this.overlayKind = 'gameover';

    const standings = table.seats
      .slice()
      .sort((a, b) => b.stack - a.stack)
      .map((seat, index) =>
        el('div', { class: `standing ${seat.seat === table.viewerSeat ? 'standing--hero' : ''}` }, [
          el('span', { class: 'standing__rank', text: `${index + 1}` }),
          el('span', { class: 'standing__avatar', text: seat.avatar }),
          el('span', { class: 'standing__name', text: seat.name }),
          el('span', { class: 'standing__stack', text: fmt(seat.stack) }),
        ]),
      );

    const hero = table.seats.find((s) => s.seat === table.viewerSeat);
    const best = Math.max(...table.seats.map((s) => s.stack));

    this.#mountOverlay(
      el('div', { class: 'result-banner' }, [
        el('div', { class: 'result-banner__kicker', text: '牌局结束' }),
        el('div', {
          class: 'result-banner__title',
          text: hero && hero.stack === best ? '🏆 你是最后的赢家' : '筹码输光了',
        }),
        el('div', { class: 'result-banner__sub', text: `共进行了 ${table.handId} 手牌。` }),
        el('div', { class: 'standings' }, standings),
        el('div', { class: 'result-banner__actions' }, [
          el('button', {
            class: 'btn btn--primary btn--lg',
            text: '重开一局',
            on: { click: () => this.actions.onRestart() },
          }),
          el('button', {
            class: 'btn btn--lg',
            text: '改人数 / 换配置',
            on: { click: () => this.actions.onNewTable() },
          }),
          el('button', {
            class: 'btn btn--lg',
            text: '设置',
            on: { click: () => this.actions.onSettings() },
          }),
        ]),
      ]),
    );
  }
}

function stat(label, value, modifier = '') {
  return el('div', { class: `stat ${modifier}` }, [
    el('span', { class: 'stat__label', text: label }),
    el('span', { class: 'stat__value num', text: value }),
  ]);
}

function describeAction(action, amount) {
  const text = ACTION_TEXT[action] ?? action;
  if (amount === null || amount === undefined) return text;
  if (action === 'raise' || action === 'bet') return `${text} ${fmt(amount)}`;
  if (action === 'call' || action === 'all_in') return `${text} ${fmt(amount)}`;
  return text;
}
