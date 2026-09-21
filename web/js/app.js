import { $ } from './dom.js';
import { api, connectEvents, restoreAuth, setAuth, clearAuth, clearInviteParams, getAuth } from './api.js';
import { TableView } from './tableView.js';
import { Hud } from './hud.js';
import { SettingsDialog } from './settings.js';
import { Lobby } from './lobby.js';
import { sfx, unlockAudio } from './sound.js';

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
  lobbyRoot: $('#lobby-root'),
};

const state = {
  config: null,
  runtime: null,
  view: null,
  providers: [],
  roster: [],
  room: null,
  invites: [],
  limits: null,
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
    onRestart: () => restartSameRoom(),
    onNewTable: () => openLobby(),
    onSettings: () => openSettings(),
    onForce: (seat) => forceSeat(seat),
  },
});

const settings = new SettingsDialog({
  root: refs.modalRoot,
  providers: [],
  roster: [],
  onToast: (t) => hud.toast(t),
  onSaved: async (config) => {
    state.config = config;
    hud.renderModelPill({ ...(state.runtime ?? {}), ...config });
    if (lobby.isOpen) lobby.open({ config, roster: state.roster, limits: state.limits });
  },
});

const lobby = new Lobby({
  root: refs.lobbyRoot,
  onStart: (payload) => createRoom(payload),
  onOpenSettings: () => openSettings(),
});

// ------------------------------------------------------------------- sound

let soundState = { board: 0, chips: 0, phase: null, toAct: null };

function directSound(table) {
  if (!table?.seats) {
    soundState = { board: 0, chips: 0, phase: null, toAct: null };
    return;
  }
  const chips = table.seats.reduce((sum, s) => sum + s.totalCommitted, 0);
  if (table.board.length > soundState.board) sfx.deal();
  if (chips > soundState.chips) sfx.chip();
  if (table.phase === 'handover' && soundState.phase !== 'handover') {
    const won = (table.handResult?.awards ?? []).some((a) => a.seat === table.viewerSeat);
    if (won) sfx.win();
    else sfx.lose();
  }
  if (table.toAct === table.viewerSeat && soundState.toAct !== table.viewerSeat && table.phase === 'playing') {
    sfx.turn();
  }
  soundState = { board: table.board.length, chips, phase: table.phase, toAct: table.toAct };
}

// ------------------------------------------------------------------ render

function apply(view) {
  state.view = view;
  const table = view && Array.isArray(view.seats) ? view : null;
  if (view?.config) state.runtime = view.config;
  const runtime = state.runtime ?? state.config ?? {};

  hud.renderTopbar(table);
  hud.renderModelPill(runtime);
  tableView.render(table);
  hud.renderFeed(table);
  hud.renderActionBar(table);

  if (table) {
    if (table.phase === 'gameover') hud.showGameOver(table);
    else if (table.phase === 'handover') hud.showHandResult(table);
    else hud.clearOverlay();
  }
  directSound(table);
}

// ------------------------------------------------------------------ actions

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
      apply(await api.nextHand());
    } catch (err) {
      hud.toast({ level: 'error', message: err.message });
    }
  });
}

async function forceSeat(seat) {
  await runIfIdle(async () => {
    try {
      apply(await api.force(seat));
    } catch (err) {
      hud.toast({ level: 'error', message: err.message });
    }
  });
}

/** Restart the SAME room: same seats, same invite links, fresh stacks. */
async function restartSameRoom() {
  await runIfIdle(async () => {
    try {
      apply(await api.restart());
      hud.toast({ level: 'success', message: '已重新开始' });
    } catch (err) {
      hud.toast({ level: 'error', message: err.message });
    }
  });
}

// -------------------------------------------------------------------- rooms

async function createRoom(payload) {
  try {
    const result = await api.createRoom(payload);
    setAuth(result.roomId, result.token);
    clearInviteParams();
    state.room = result.room;
    state.invites = result.invites ?? [];
    lobby.close();
    connect();
    apply(result.state ?? (await api.room()).state);
    hud.toast({ level: 'success', message: `牌局 ${result.roomId} 已创建` });
    if ((result.invites ?? []).length > 1) {
      hud.toast({ level: 'info', message: '点右上角「邀请」把链接发给朋友', ttl: 7000 });
    }
  } catch (err) {
    hud.toast({ level: 'error', message: `建桌失败：${err.message}` });
    throw err;
  }
}

async function joinExisting() {
  try {
    const info = await api.room();
    state.room = info.room;
    state.invites = info.invites ?? [];
    lobby.close();
    connect();
    apply(info.state);
    if (!info.isHost) hud.toast({ level: 'success', message: `已入座：${info.room.seats[info.seat]?.name ?? ''}` });
  } catch (err) {
    clearAuth();
    hud.toast({ level: 'error', message: err.message, ttl: 8000 });
    openLobby();
  }
}

function openLobby() {
  closeStream();
  state.room = null;
  state.view = null;
  tableView.render(null);
  hud.renderTopbar(null);
  hud.renderActionBar(null);
  hud.renderFeed(null);
  hud.clearOverlay();
  lobby.open({ config: state.config, roster: state.roster, limits: state.limits });
}

function openSettings() {
  settings.open(state.config);
}

// --------------------------------------------------------------------- SSE

let disposeStream = null;
let connBanner = null;

function connect() {
  closeStream();
  disposeStream = connectEvents({
    onState: (view) => apply(view),
    onOpen: hideConnBanner,
    onError: showConnBanner,
    onAiError: (payload) => {
      sfx.error();
      hud.toast({ level: 'error', message: `${payload.name} 决策失败：${payload.message}`, ttl: 9000 });
    },
    onToast: (payload) => hud.toast({ level: payload.level ?? 'info', message: payload.message }),
  });
}

function closeStream() {
  disposeStream?.();
  disposeStream = null;
}

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

// -------------------------------------------------------------------- boot

async function boot() {
  try {
    const data = await api.bootstrap();
    state.config = data.config;
    state.providers = data.providers;
    state.roster = data.roster;
    state.limits = data.limits;
    settings.providers = data.providers;
    settings.roster = data.roster;
    hud.renderModelPill(data.config);

    const restored = restoreAuth();
    if (restored.token) {
      await joinExisting();
    } else {
      openLobby();
    }
  } catch (err) {
    hud.toast({ level: 'error', message: `初始化失败：${err.message}`, ttl: 0 });
    openLobby();
  }
}

// --------------------------------------------------------------- bindings

$('#btn-settings').addEventListener('click', () => {
  unlockAudio();
  openSettings();
});

$('#btn-invite').addEventListener('click', async () => {
  unlockAudio();
  try {
    const result = await api.invites();
    state.invites = result.invites ?? [];
    hud.showInvites({ roomId: state.room?.id ?? getAuth().room, invites: state.invites, players: state.room?.seats });
  } catch (err) {
    hud.toast({ level: 'error', message: err.message });
  }
});

$('#btn-restart').addEventListener('click', () => {
  unlockAudio();
  // Changing the number of seats means a new table (and new invite links),
  // so this opens the setup screen rather than silently reusing the room.
  openLobby();
});

$('#btn-new-hand').addEventListener('click', () => {
  unlockAudio();
  nextHand();
});

document.addEventListener('pointerdown', () => unlockAudio(), { once: true });

document.addEventListener('keydown', (event) => {
  if (settings.isOpen || lobby.isOpen) return;
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
  const table = state.view && Array.isArray(state.view.seats) ? state.view : null;
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
  if (state.view && !lobby.isOpen) hud.renderFeed(state.view);
}, 700);

setInterval(() => {
  if (!state.room) return;
  api
    .room()
    .then((info) => {
      state.room = info.room;
    })
    .catch(() => {});
}, 5000);

boot();
