import { $ } from './dom.js';
import { api, connectEvents } from './api.js';
import { TableView } from './tableView.js';
import { Hud } from './hud.js';
import { SettingsDialog } from './settings.js';
import { sfx, unlockAudio } from './sound.js';
import { fmt } from './format.js';

const refs = {
  topbarStats: $('#topbar-stats'),
  tableArea: $('#table-area'),
  seats: $('#seats'),
  bets: $('#bets'),
  board: $('#board'),
  pot: $('#pot-display'),
  street: $('#street-badge'),
  feed: $('#feed'),
  actionbar: $('#actionbar'),
  toasts: $('#toasts'),
  modelPill: $('#model-pill'),
  modalRoot: $('#modal-root'),
};

const state = {
  config: null,
  runtime: null,
  view: null,
  providers: [],
  roster: [],
};

const tableView = new TableView({
  seatsEl: refs.seats,
  betsEl: refs.bets,
  boardEl: refs.board,
  potEl: refs.pot,
  streetEl: refs.street,
});

const hud = new Hud({
  refs,
  actions: {
    onAction: (action) => submitAction(action),
    onNextHand: () => nextHand(),
    onRestart: () => restart(),
    onSettings: () => openSettings(),
  },
});

const settings = new SettingsDialog({
  root: refs.modalRoot,
  providers: [],
  roster: [],
  onToast: (t) => hud.toast(t),
  onSaved: async (config, { restart: shouldRestart }) => {
    state.config = config;
    hud.renderModelPill(config);
    if (shouldRestart || !state.view?.table) await restart();
  },
});

// ------------------------------------------------------------------ sound

let soundState = { board: 0, pot: 0, phase: null, toAct: null, chips: 0 };

function directSound(table) {
  if (!table) {
    soundState = { board: 0, pot: 0, phase: null, toAct: null, chips: 0 };
    return;
  }
  const chips = table.seats.reduce((sum, s) => sum + s.totalCommitted, 0);
  if (table.board.length > soundState.board) sfx.deal();
  if (chips > soundState.chips) sfx.chip();
  if (table.phase === 'handover' && soundState.phase !== 'handover') {
    const me = table.seats.find((s) => s.seat === table.viewerSeat);
    const won = (table.handResult?.awards ?? []).some((a) => a.seat === table.viewerSeat);
    if (won) sfx.win();
    else if (me && !me.folded) sfx.lose();
  }
  if (table.toAct === table.viewerSeat && soundState.toAct !== table.viewerSeat && table.phase === 'playing') {
    sfx.turn();
  }
  soundState = { board: table.board.length, pot: table.potTotal, phase: table.phase, toAct: table.toAct, chips };
}

// ------------------------------------------------------------------ render

function apply(view) {
  state.view = view;
  const table = view?.table ?? null;
  // `view.config` is the runtime view (provider/model/ready); the full config
  // lives in state.config and keeps fields the server never sends back.
  if (view?.config) state.runtime = view.config;
  const runtime = state.runtime ?? state.config ?? {};

  hud.renderTopbar(table);
  hud.renderModelPill(runtime);
  tableView.render(view);
  hud.renderFeed(table);
  hud.renderActionBar(view);

  if (table) {
    if (table.phase === 'gameover') hud.showGameOver(table);
    else if (table.phase === 'handover') hud.showHandResult(table);
    else hud.clearOverlay();
  } else if (!runtime.ready) {
    hud.showLocked(view?.error);
  } else {
    hud.clearOverlay();
  }

  if (view?.error) hud.toast({ level: 'error', message: view.error, ttl: 8000 });
  directSound(table);
}

// ------------------------------------------------------------------ actions

/**
 * Serialise every server round-trip. This keeps a click from interleaving with
 * an in-flight request, and guarantees that "save and restart" is never
 * silently dropped just because an AI turn or an auto-advance was running.
 */
let chain = Promise.resolve();
let busy = false;

function queue(task) {
  const run = chain.then(task, task);
  chain = run.then(
    () => {},
    () => {},
  );
  return run;
}

/** Run only if nothing else is in flight — used for repeat-clickable controls. */
async function runIfIdle(task) {
  if (busy) return false;
  busy = true;
  try {
    await queue(task);
    return true;
  } finally {
    busy = false;
  }
}

async function submitAction(action) {
  await runIfIdle(async () => {
    try {
      apply(await api.action(action));
    } catch (err) {
      sfx.error();
      hud.toast({ level: 'error', message: err.message });
    }
  });
}

async function nextHand() {
  await runIfIdle(async () => {
    hud.clearOverlay();
    try {
      apply(await api.nextHand(0));
    } catch (err) {
      hud.toast({ level: 'error', message: err.message });
    }
  });
}

/** Always queued, never dropped: waits for whatever is in flight, then rebuilds. */
async function restart() {
  hud.clearOverlay();
  await queue(async () => {
    try {
      const cfg = state.config ?? (await api.bootstrap()).config;
      apply(await api.newGame(cfg.table));
    } catch (err) {
      hud.toast({ level: 'error', message: `开局失败：${err.message}` });
    }
  });
}

function openSettings() {
  settings.open(state.config);
}

// -------------------------------------------------------------------- boot

let connBanner = null;

function showConnBanner() {
  if (connBanner) return;
  connBanner = document.createElement('div');
  connBanner.className = 'conn-banner';
  connBanner.textContent = '与服务器的连接中断，正在重连…';
  document.body.appendChild(connBanner);
}

function hideConnBanner() {
  connBanner?.remove();
  connBanner = null;
}

async function boot() {
  try {
    const data = await api.bootstrap();
    state.config = data.config;
    state.providers = data.providers;
    state.roster = data.roster;
    settings.providers = data.providers;
    settings.roster = data.roster;

    apply(data.state);

    connectEvents({
      onState: (view) => apply(view),
      onOpen: hideConnBanner,
      onError: showConnBanner,
      onAiError: (payload) => {
        sfx.error();
        hud.toast({
          level: 'error',
          message: `${payload.name} 决策失败：${payload.message}`,
          ttl: 9000,
        });
      },
      onToast: (payload) => hud.toast({ level: payload.level ?? 'info', message: payload.message }),
    });

    if (!data.state?.table) {
      if (data.config.ready) await restart();
      else hud.showLocked();
    }
  } catch (err) {
    hud.toast({ level: 'error', message: `初始化失败：${err.message}`, ttl: 0 });
    showConnBanner();
  }
}

// --------------------------------------------------------------- bindings

$('#btn-settings').addEventListener('click', () => {
  unlockAudio();
  openSettings();
});

$('#btn-restart').addEventListener('click', () => {
  unlockAudio();
  restart();
});

$('#btn-new-hand').addEventListener('click', () => {
  unlockAudio();
  nextHand();
});

document.addEventListener(
  'pointerdown',
  () => {
    unlockAudio();
  },
  { once: true },
);

document.addEventListener('keydown', (event) => {
  if (settings.isOpen) return;
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
  const table = state.view?.table;
  if (!table || table.phase !== 'playing' || table.toAct !== table.viewerSeat) {
    if (event.code === 'Space' && table && table.phase === 'handover') {
      event.preventDefault();
      nextHand();
    }
    return;
  }
  const legal = new Map((table.legalActions ?? []).map((a) => [a.type, a]));
  const key = event.key.toLowerCase();
  if (key === 'f' && legal.has('fold')) submitAction({ action: 'fold' });
  else if (key === 'c' && (legal.has('check') || legal.has('call'))) {
    submitAction({ action: legal.has('check') ? 'check' : 'call' });
  } else if (key === 'r' && (legal.has('raise') || legal.has('bet'))) {
    const spec = legal.get('raise') ?? legal.get('bet');
    submitAction({ action: spec.type, amount: spec.minTo });
  } else if (key === 'a' && legal.has('all_in')) {
    submitAction({ action: 'all_in' });
  }
});

setInterval(() => {
  tableView.tick();
  hud.renderFeed(state.view?.table);
}, 700);

boot();
