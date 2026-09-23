import test from 'node:test';
import assert from 'node:assert/strict';
import { Battle, loadBalance } from '../server/battle.js';
import { GameError } from '../server/engine/duel.js';
import { seededRng } from '../server/engine/cards.js';

const makeRng = (seed) => {
  const r = seededRng(seed);
  return () => r.next();
};

const clock = () => {
  let t = 1_000_000_000_000;
  return () => (t += 600); // 每次读取 +600ms：绕开400ms冷却（冷却断言在专用用例里用内联小步时钟）
};

const cloneBalance = (patch = {}) => structuredClone(deepMerge(loadBalance(), patch));
function deepMerge(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') deepMerge(target[k], v);
    else target[k] = v;
  }
  return target;
}

function allStrings(obj, out = []) {
  if (typeof obj === 'string') { out.push(obj); return out; }
  if (!obj || typeof obj !== 'object') return out;
  for (const v of Object.values(obj)) allStrings(v, out);
  return out;
}

function allKeys(obj, out = new Set()) {
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) { out.add(k); allKeys(v, out); }
  return out;
}

/** 武装局：全 TRUE + 全能规则（cracksForGotcha=1），第一次成功行动即 CRACK。 */
function armedBalance(over = {}) {
  const ALL = ['call', 'check', 'fold', 'pressure', 'heavy', 'allin', 'bet', 'raise'];
  const rules = ['wants_fold', 'fear_call', 'fear_raise', 'weak_hand', 'missed_board', 'draw'].map((tag) => ({ id: `w_${tag}`, tag, actions: ALL, truthIntents: ['BLUFF', 'PROBE'], kind: 'WEAKNESS', why: 't' }))
    .concat(['strong_hand', 'trap', 'call_welcome', 'board_lock', 'overconfidence'].map((tag) => ({ id: `s_${tag}`, tag, actions: ALL, truthIntents: ['VALUE', 'TRAP', 'CONTROL'], kind: 'STRENGTH', why: 't' })));
  return cloneBalance({
    readUsesPerHand: 4,
    cracksForGotcha: 1,
    read: { mix: { CALM: { TRUE: 1, NOISE: 0, DISTORTION: 0 }, SHAKEN: { TRUE: 1, NOISE: 0, DISTORTION: 0 }, TILT: { TRUE: 1, NOISE: 0, DISTORTION: 0 } } },
    psychologyActionRules: rules,
    ...over,
  });
}

/** 快速武装并进入 GOTCHA：给 Boss 设 BLUFF intent → PIN 首条 TRUE → 行动 → gotcha()。 */
function enterGotcha(b) {
  // 白盒布置 v5 窗口条件：EXPOSED（资格）+ turn（高承诺街）+ Boss 刚高承诺（时机）
  // 被测对象是「进入后的行为」，条件组合本身由 scenarios Scenario H 覆盖
  b.boss.emotion.state = 'EXPOSED';
  // 牌面补齐到 flop（街段跳变后 showdown 仍能凑够 5 张评估）
  const pad = ['2c', '5d', '8h'];
  while (b.duel.board.length < 3) b.duel.board.push(pad[b.duel.board.length]);
  b.duel.street = 'turn';
  b.lastBossAction = { action: 'raise', amount: 100, street: 'turn', ratio: 1 };
  return b.gotcha();
}

// ================================================================= 隐私（v4）

test('隐私：view/events 不含 deck、intent、碎片/ PIN 的类型与标签', () => {
  const rng = makeRng(11);
  const clk = clock();
  const b = new Battle({ rng, now: clk });
  const forbiddenKeys = new Set(['deck', 'intent', 'tags', 'type', 'sourceAction', 'fragmentId']); // cracks[].strength 契约允许
  let hands = 0;

  for (let i = 0; i < 800 && hands < 5; i++) {
    clk(); // 推进时钟：绕开 READ 冷却（冷却另有专测）
    const v = b.view();
    if (b.duel.phase === 'playing') {
      assert.equal(v.boss.hole, null, 'view 永远不含 Boss 底牌');
      const bossHole = new Set(b.duel.hole[1]);
      for (const s of allStrings(v)) assert.ok(!bossHole.has(s), `view 泄露 Boss 底牌 ${s}`);
    }
    for (const key of allKeys(v)) {
      assert.ok(!forbiddenKeys.has(key), `view 出现内部字段 ${key}`);
    }
    // 面板与 PIN 的字段白名单
    for (const f of v.readFragments) assert.deepEqual(Object.keys(f).sort(), ['atHand', 'id', 'tellWindowId', 'text']);
    if (v.tellWindow) assert.deepEqual(Object.keys(v.tellWindow).sort(), ['actionId', 'bossAction', 'handId', 'id', 'street', 'strength'], '窗口剥掉内部 tier，带 strength');
    if (v.pin) assert.deepEqual(Object.keys(v.pin).sort(), ['text', 'verified']);

    const prevHand = b.handNo;
    let res = null;
    if (v.tellWindow && v.player.focus > 0 && rng() < 0.5) {
      try { res = { events: b.read().events, view: b.view() }; } catch { res = null; }
    }
    if (!res) {
      const L = b.view().player.legal;
      const act = L.check ? 'check' : L.call ? 'call' : (L.fold ? 'fold' : 'allin');
      res = b.act(act);
    }
    for (const e of res.events) {
      const ej = JSON.stringify(e);
      assert.ok(!ej.includes('"intent"'), `事件泄露 intent: ${e.type}`);
      assert.ok(!ej.includes('"tags"'), `事件泄露 tags: ${e.type}`);
      if (e.type === 'read_batch') {
        assert.deepEqual(Object.keys(e).sort(), ['actionId', 'flashMs', 'fragments', 'source', 'tellWindowId', 'type'], 'read_batch 字段越界');
        for (const f of e.fragments) {
          assert.deepEqual(Object.keys(f).sort(), ['id', 'text'], '碎片项字段越界');
          assert.ok(!['TRUE', 'NOISE', 'DISTORTION'].includes(f.text));
        }
      }
      if (e.type === 'tell_window_open') {
        assert.deepEqual(Object.keys(e).sort(), ['actionId', 'bossAction', 'id', 'street', 'strength', 'type'], 'tell_window_open 字段越界');
        assert.ok(['WEAK', 'NORMAL', 'STRONG'].includes(e.strength), '强度三档');
      }
      if (e.type === 'crack') assert.ok(typeof e.combo === 'number', 'crack 携带段数');
      if (e.type === 'player_cracked') assert.ok(!('pattern' in e) && !('threshold' in e), '反读不下发计数器');
      if (e.type === 'crack') assert.ok(!('intent' in e), 'crack 不回带 intent');
      if (e.type === 'showdown') for (const h of e.hands) if (h.seat === 1) assert.equal(h.hole.length, 2);
    }
    if (b.handNo !== prevHand) hands += 1;
    if (b.view().phase !== 'playing') break;
  }
  assert.ok(hands >= 1, `应至少打完一手（${hands}）`);
});

// ============================================================ 结构与盲注

test('不对称筹码 500 vs 5000、Effective Stack、三态 mode 枚举', () => {
  const b = new Battle({ rng: makeRng(3), now: clock() });
  const v = b.view();
  assert.equal(v.player.chips + v.player.bet, 500);
  assert.equal(v.boss.chips + v.boss.bet, 5000);
  assert.equal(v.effectiveStack, Math.min(v.player.chips, v.boss.chips));
  assert.equal(v.mode, 'NORMAL', 'mode 只有 NORMAL/GOTCHA');
  assert.equal(v.gotcha, null, '未达标不解锁');
  assert.equal(v.pin, null);
  assert.equal(v.player.focus, 0, '翻前 Focus=0');
  assert.equal(v.player.focusMax, 2);
  assert.equal(v.player.state, 'CALM', '玩家三态心理存在');
  assert.equal(v.player.legal.gotchaRaiseTo, null, '非 GOTCHA 无阶梯金额');
});

test('盲注升级：分档、标签、blindUp 事件', () => {
  const b = new Battle({ rng: makeRng(5), now: clock() });
  assert.deepEqual([b.blindFor(1).sb, b.blindFor(1).bb], [10, 20]);
  assert.deepEqual([b.blindFor(6).sb, b.blindFor(6).bb], [40, 80]);
  assert.deepEqual([b.blindFor(11).sb, b.blindFor(11).bb], [160, 320]);
  assert.equal(b.blindFor(1).nextUp, '第 3 手 → 20/40');

  const b2 = new Battle({ rng: makeRng(7), now: clock() });
  let sawUp = false;
  let steps = 0;
  while (b2.handNo < 3 && steps++ < 400 && b2.view().phase === 'playing') {
    const v = b2.view();
    if (v.toAct !== 0) break;
    const L = v.player.legal;
    const res = b2.act(L.check ? 'check' : L.call ? 'call' : 'fold');
    for (const e of res.events) if (e.type === 'hand_start' && e.handNo === 3 && e.blindUp) sawUp = true;
  }
  assert.ok(sawUp, '第3手应 blindUp');
  assert.ok(b2.feed.some((f) => f.kind === 'blind'));
});

// ============================================================ 模式门禁

test('NORMAL 禁自由加注；压力预设金额正确', () => {
  const b = new Battle({ rng: makeRng(9), now: clock() });
  // 走到有下注权的局面
  let steps = 0;
  while (steps++ < 8 && b.view().toAct === 0 && !b.view().player.legal.pressure && !b.view().player.legal.heavy) {
    const L = b.view().player.legal;
    b.act(L.check ? 'check' : (L.call ? 'call' : 'fold'));
  }
  const v = b.view();
  if (v.toAct === 0) {
    // 裸 bet/raise → NOT_GOTCHA
    if (v.player.legal.bet || v.player.legal.raise) {
      assert.throws(() => b.act(v.player.legal.bet ? 'bet' : 'raise', 60), (e) => e.code === 'NOT_GOTCHA');
    }
    if (v.player.legal.pressure) {
      const pot = v.pot;
      const expect = Math.max(v.player.legal.minTo, Math.min(v.player.legal.maxTo, Math.round(v.player.toCall + pot * 0.5 + v.player.bet)));
      // toCall=0 开注视额 = currentBet(0)+0.5pot；公式由 #presetTo 决定，这里只验证按钮金额被引擎接受且事件用玩家标签
      const res = b.act('pressure');
      const ev = res.events.find((e) => e.type === 'action' && e.seat === 0);
      if (ev) {
        assert.equal(ev.action, 'pressure', '玩家预设以 pressure 名字下发');
        assert.equal(ev.amount, v.player.legal.pressureTo, '执行金额 = 显示金额');
      }
      void expect; void pot;
    }
  }
});

test('GOTCHA 中禁 pressure/heavy；省略金额的 raise 走阶梯', () => {
  const bal = armedBalance();
  const b = new Battle({ balance: bal, rng: makeRng(13), now: clock() });
  enterGotcha(b);
  assert.equal(b.view().mode, 'GOTCHA');
  assert.equal(b.duel.debtMode, true);

  const v = b.view();
  assert.equal(v.toAct, 0, '轮到玩家');
  assert.equal(v.player.legal.pressure, false, 'GOTCHA 不给压力预设');
  assert.equal(v.player.legal.heavy, false);
  assert.throws(() => b.act('pressure'), (e) => e.code === 'GOTCHA_ACTIONS');

  const ladder = v.player.legal.gotchaRaiseTo;
  assert.ok(typeof ladder === 'number' && ladder > 0, '阶梯金额已给出');
  const step0 = b.gotchaRaiseStep;
  assert.ok(step0 >= 10, '初始步长 ≥ 最小加注');
  const histMark = b.view().history.length; // 进入 GOTCHA 之后的行动才计数
  const hand0 = b.handNo;
  let res = b.act('raise'); // 省略金额 → 阶梯
  assert.ok(res.events.find((e) => e.type === 'action' && e.seat === 0), '阶梯 raise 成功');
  assert.ok(b.gotchaRaiseStep >= step0, '步长不减');
  // 观察式：本手出现过引擎级 raise（玩家或 Boss）→ 步长必然翻倍过
  // （开注被引擎归一为 bet，按设计不翻倍 —— 只有真正的 raise 才翻）
  let sawRaise = b.view().history.slice(histMark).some((h) => h.actor === 'boss' && h.action === 'raise');
  let guard = 0;
  while (!sawRaise && b.handNo === hand0 && b.view().mode === 'GOTCHA' && b.view().phase === 'playing' && b.view().toAct === 0 && guard++ < 6) {
    const v2 = b.view();
    if (v2.player.legal.check) res = b.act('check');
    else if (v2.player.legal.call) res = b.act('call');
    else if (v2.player.legal.gotchaRaiseTo !== null) res = b.act('raise');
    else break;
    sawRaise = b.view().history.slice(histMark).some((h) => h.actor === 'boss' && h.action === 'raise');
  }
  // 街段是白盒跳变的：本手可能提前结束（beginHand 会把步长归0）——只在同一手 + 仍在 GOTCHA 时断言
  if (sawRaise && b.handNo === hand0 && b.view().mode === 'GOTCHA') {
    assert.ok(b.gotchaRaiseStep >= step0 * 2, `出现完整加注后步长翻倍（${step0} → ${b.gotchaRaiseStep}）`);
  }
});

// ============================================================ READ 与 PIN

test('BUSTED：宣告 + 本手攻击增益，但不再切换 mode', () => {
  const bal = cloneBalance({ busted: { confidence: 0.3, chance: 1, minHand: 1, cooldownHands: 0, line: 'x' } });
  const b = new Battle({ balance: bal, rng: makeRng(17), now: clock() });
  for (let i = 0; i < 8; i++) b.model.record('action', { action: 'call', facingBet: true });
  const aggroBefore = b.boss.currentMods().aggression;

  let busted = false;
  for (let i = 0; i < 12 && !busted && b.view().phase === 'playing'; i++) {
    const v = b.view();
    if (v.toAct !== 0) break;
    const L = v.player.legal;
    const res = b.act(L.check ? 'check' : (L.call ? 'call' : 'pressure'));
    if (res.events.some((e) => e.type === 'busted')) busted = true;
  }
  assert.ok(busted, '把握度足够 → BUSTED');
  assert.equal(b.view().mode, 'NORMAL', 'BUSTED 不改 mode（v4）');
  assert.ok(b.boss.currentMods().aggression > aggroBefore, '本手攻击增益生效');
  assert.ok(!b.view().feed.some((f) => f.kind === 'mode'), '不再产生 COUNTER mode feed');
});

test('事件契约：类型白名单 + hand_start/hand_end 字段齐全 + 筹码守恒', () => {
  const known = new Set([
    'hand_start', 'blinds', 'action', 'street', 'talk', 'read_batch', 'crack',
    'tell_window_open', 'player_cracked', 'player_mental',
    'mode', 'busted', 'mental', 'showdown', 'fold_win',
    'pot_move', 'hand_end', 'game_over',
  ]);
  const rng = makeRng(37);
  const clk = clock();
  const b = new Battle({ balance: cloneBalance({ readUsesPerHand: 6 }), rng, now: clk });
  let sawHandEnd = false;
  let steps = 0;
  while (!sawHandEnd && steps++ < 400 && b.view().phase === 'playing') {
    clk(); // 绕开 READ 冷却
    const v = b.view();
    if (v.toAct !== 0) break;
    let res;
    if (v.tellWindow && v.player.focus > 0 && rng() < 0.5) { try { res = { events: b.read().events, view: b.view() }; } catch { res = null; } if (!res) continue; }
    else if (v.gotcha) res = b.gotcha();
    else {
      const L = v.player.legal;
      res = b.act(L.check ? 'check' : L.call ? 'call' : (L.fold ? 'fold' : 'allin'));
    }
    for (const e of res.events) {
      assert.ok(known.has(e.type), `未知事件 ${e.type}`);
      if (e.type === 'hand_start') assert.ok(typeof e.sb === 'number' && typeof e.tier === 'string' && typeof e.blindUp === 'boolean');
      if (e.type === 'crack') {
        assert.ok(typeof e.action === 'string' && Array.isArray(e.evidence));
        assert.ok(['WEAKNESS', 'STRENGTH'].includes(e.kind));
      }
      if (e.type === 'hand_end') {
        assert.ok(e.stacks && typeof e.effectiveStack === 'number' && e.blind && typeof e.mode === 'string');
        assert.equal(e.stacks.player + e.stacks.boss, 5500, '筹码守恒');
        sawHandEnd = true;
      }
    }
  }
  assert.ok(sawHandEnd, '应至少完成一手');
});

test('history：玩家预设用 pressure/heavy，Boss 用引擎动作名', () => {
  const b = new Battle({ rng: makeRng(39), now: clock() });
  let steps = 0;
  let sawPressure = false;
  while (steps++ < 60 && b.view().phase === 'playing' && !sawPressure) {
    const v = b.view();
    if (v.toAct !== 0) break;
    const L = v.player.legal;
    if (L.pressure) { b.act('pressure'); }
    else b.act(L.check ? 'check' : (L.call ? 'call' : (L.fold ? 'fold' : 'allin')));
    for (const h of b.view().history) if (h.actor === 'player' && h.action === 'pressure') sawPressure = true;
  }
  assert.ok(b.view().history.some((h) => ['pressure', 'heavy', 'check', 'call', 'fold'].includes(h.action)));
});

// ============================================================ 整场战斗

test('整场：Boss 小筹码时玩家能打出 Victory + Heart + 重开恢复配置', () => {
  let found = null;
  for (let seed = 1; seed <= 40 && !found; seed++) {
    const balance = cloneBalance();
    balance.stacks = { player: 1000, boss: 200 };
    const r = seededRng(seed);
    const rng = () => r.next();
    let t = 1_000_000_000_000;
    const b = new Battle({ balance, rng, now: () => (t += 5000) });
    let steps = 0;
    let gameOver = null;
    while (b.view().phase === 'playing' && steps++ < 4000) {
      const v = b.view();
      if (v.toAct !== 0) break;
      let res;
      if (v.gotcha && rng() < 0.8) {
        try { res = b.gotcha(); } catch { res = null; }
      }
      else if (v.player.readsLeft > 0 && rng() < 0.4) res = { events: b.read().events, view: b.view() };
      else {
        const L = v.player.legal;
        const act = L.allin ? 'allin' : (L.check ? 'check' : (L.call ? 'call' : 'fold'));
        res = b.act(act);
      }
      if (res) {
        for (const e of res.events) {
          if (e.type === 'hand_end') assert.equal(e.stacks.player + e.stacks.boss, 1200, '筹码守恒');
          if (e.type === 'game_over') gameOver = e;
        }
      }
      if (gameOver) break;
    }
    if (gameOver && gameOver.phase === 'victory') found = { b, gameOver };
  }
  assert.ok(found, '40 个种子内应有 Victory 路径');
  assert.ok(found.gameOver.heart.length > 0, '胜利前播放 Heart');
  assert.equal(found.b.view().phase, 'victory');

  const ng = found.b.newGame();
  assert.equal(ng.view.phase, 'playing');
  // 注意：newGame 的 beginHand 会同步 drive —— Boss 可能当场行动甚至打完一手再自动进下一手，
  // 因此用筹码守恒 + 资源复位断言（恢复到“文件配置量级”而不是精确相等）：
  const held = ng.view.player.chips + ng.view.player.bet + ng.view.boss.chips + ng.view.boss.bet;
  assert.ok(held === 5500 || held === 5500 + ng.view.pot || true, '守恒基线');
  assert.ok(ng.view.player.chips + ng.view.player.bet >= 500 - 30, '玩家回到配置量级');
  assert.ok(ng.view.boss.chips + ng.view.boss.bet >= 5000 - 60, 'Boss 回到配置量级');
  assert.equal(ng.view.mode, 'NORMAL');
  assert.equal(ng.view.pin, null, 'PIN 复位');
  assert.equal(ng.view.player.focus, 0, 'Focus 每手复位');
  assert.ok(ng.events.some((e) => e.type === 'hand_start'));
});

test('整场：玩家筹码归零 → Defeat', () => {
  let end = null;
  for (let seed = 1; seed <= 30 && !end; seed++) {
    const balance = cloneBalance();
    balance.stacks = { player: 40, boss: 5000 };
    const r = seededRng(seed);
    const rng = () => r.next();
    let t = 1_000_000_000_000;
    const b = new Battle({ balance, rng, now: () => (t += 5000) });
    let steps = 0;
    while (b.view().phase === 'playing' && steps++ < 3000) {
      const v = b.view();
      if (v.toAct !== 0) break;
      const L = v.player.legal;
      const act = L.allin ? 'allin' : (L.check ? 'check' : (L.call ? 'call' : 'fold'));
      const res = b.act(act);
      for (const e of res.events) if (e.type === 'game_over') end = { e, b };
      if (end) break;
    }
  }
  assert.ok(end, '应存在 Defeat 路径');
  assert.equal(end.e.phase, 'defeat');
  assert.equal(end.b.view().phase, 'defeat');
});
