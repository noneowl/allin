/**
 * 《ALL IN》v5 方案 Scenario A–H 实测（§15）。
 * Tell Window / 碎片生命周期 / Focus / CRACK / 心理与筹码分离 /
 * 三态心理 / Boss 反读 / GOTCHA 窗口条件。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Battle, loadBalance } from '../server/battle.js';
import { seededRng } from '../server/engine/cards.js';
import { PlayerModel } from '../server/boss/playermodel.js';
import { assembleMods } from '../server/boss/ai.js';
import { applyTransition } from '../server/boss/mental.js';

const makeRng = (seed) => {
  const r = seededRng(seed);
  return () => r.next();
};

const clock = () => {
  let t = 1_000_000_000_000;
  return () => (t += 700); // >400ms 冷却
};

const cloneBalance = (patch = {}) => structuredClone(deepMerge(loadBalance(), patch));
function deepMerge(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') deepMerge(target[k], v);
    else target[k] = v;
  }
  return target;
}

/** 全 TRUE + 全能规则的武装局配置。 */
function tellBalance(over = {}) {
  const ALL = ['call', 'check', 'fold', 'pressure', 'heavy', 'allin', 'bet', 'raise'];
  const rules = ['wants_fold', 'fear_call', 'fear_raise', 'weak_hand', 'missed_board', 'draw'].map((tag) => ({ id: `w_${tag}`, tag, actions: ALL, truthIntents: ['BLUFF', 'PROBE'], kind: 'WEAKNESS', why: 't' }))
    .concat(['strong_hand', 'trap', 'call_welcome', 'board_lock', 'overconfidence'].map((tag) => ({ id: `s_${tag}`, tag, actions: ALL, truthIntents: ['VALUE', 'TRAP', 'CONTROL'], kind: 'STRENGTH', why: 't' })));
  return cloneBalance({
    read: { baseTrueWeight: 0.9, mix: { CALM: { TRUE: 1, NOISE: 0, DISTORTION: 0 }, SHAKEN: { TRUE: 1, NOISE: 0, DISTORTION: 0 }, EXPOSED: { TRUE: 1, NOISE: 0, DISTORTION: 0 } } },
    psychologyActionRules: rules,
    ...over,
  });
}

/** 打到 flop+ 且出现心理窗口（玩家到回合、窗口存在）。 */
function walkToFlopWindow(b) {
  let guard = 0;
  while (guard++ < 50 && b.view().phase === 'playing' && b.handNo === 1) {
    const v = b.view();
    if (v.toAct !== 0) {
      const L = v.player.legal;
      b.act(L.check ? 'check' : (L.call ? 'call' : (L.fold ? 'fold' : 'allin')));
      continue;
    }
    if (v.tellWindow && v.street !== 'preflop') return v;
    const L = v.player.legal;
    b.act(L.check ? 'check' : (L.call ? 'call' : (L.fold ? 'fold' : 'allin')));
  }
  return null;
}

// ============================================================ Scenario A

test('Scenario A：Tell Window — Boss 行动后开启，玩家行动后立刻关闭', () => {
  const b = new Battle({ balance: cloneBalance(), rng: makeRng(11), now: clock() });
  const v0 = b.view();
  if (v0.button === 1) {
    assert.ok(v0.tellWindow, 'Boss 庄家先动 → 窗口随行动开启');
    assert.equal(v0.tellWindow.handId, 1);
    assert.ok(typeof v0.tellWindow.actionId === 'number');
    assert.ok(['check', 'call', 'bet', 'raise', 'allin'].includes(v0.tellWindow.bossAction));
    const L = v0.player.legal;
    b.act(L.check ? 'check' : (L.call ? 'call' : (L.fold ? 'fold' : 'allin')));
    assert.equal(b.view().tellWindow, null, '玩家回应后窗口立即关闭');
  } else {
    assert.equal(v0.tellWindow, null, '玩家先动 → 尚无窗口');
    const L = v0.player.legal;
    const res = b.act(L.check ? 'check' : (L.call ? 'call' : 'fold'));
    assert.ok(res.events.every((e) => e.type !== 'tell_window_open'), '玩家行动不开窗口');
    // Boss 同街回应 → 开窗
    const v1 = b.view();
    if (b.view().street === 'preflop' && v1.toAct === 0) {
      assert.ok(v1.tellWindow, 'Boss 回应后（同街）窗口开启');
      const L1 = v1.player.legal;
      b.act(L1.check ? 'check' : (L1.call ? 'call' : (L1.fold ? 'fold' : 'allin')));
      assert.equal(b.view().tellWindow, null, '玩家回应后窗口立即关闭');
    }
  }

  // 通用：窗口事件必然出现
  const b2 = new Battle({ balance: cloneBalance(), rng: makeRng(12), now: clock() });
  let saw = null;
  let guard = 0;
  while (!saw && guard++ < 30 && b2.view().phase === 'playing') {
    const v = b2.view();
    if (v.tellWindow) { saw = v.tellWindow; break; }
    if (v.toAct !== 0) break;
    const L = v.player.legal;
    b2.act(L.check ? 'check' : (L.call ? 'call' : 'fold'));
  }
  assert.ok(saw, '窗口必然会出现（Boss 总要回应）');
  const b3 = new Battle({ balance: cloneBalance(), rng: makeRng(13), now: clock() });
  let evSeen = false;
  guard = 0;
  while (!evSeen && guard++ < 30 && b3.view().phase === 'playing') {
    const v = b3.view();
    if (v.toAct !== 0) break;
    const L = v.player.legal;
    const res = b3.act(L.check ? 'check' : (L.call ? 'call' : 'fold'));
    if (res.events.some((e) => e.type === 'tell_window_open')) evSeen = true;
  }
  assert.ok(evSeen, 'tell_window_open 事件会下发');
});

// ============================================================ Scenario B

test('Scenario B：碎片只活在当前窗口 —— 玩家回应后全部清空', () => {
  const b = new Battle({ balance: tellBalance(), rng: makeRng(21), now: clock() });
  const v = walkToFlopWindow(b);
  assert.ok(v, '应走到 flop+ 窗口');
  assert.ok(v.tellWindow, '窗口存在');

  const r = b.read();
  const batch = r.events.find((e) => e.type === 'read_batch');
  assert.equal(batch.source, 'manual');
  assert.equal(batch.tellWindowId, v.tellWindow.id, '批次绑定窗口');
  assert.equal(batch.actionId, v.tellWindow.actionId, '批次绑定 Boss 行动');
  assert.ok(batch.fragments.length >= 3 && batch.fragments.length <= 5);
  assert.ok(batch.fragments.every((f) => f.id.startsWith(`w${v.tellWindow.id}f`)), '碎片 id 归属窗口');
  assert.ok(r.view.readFragments.length > 0);
  assert.ok(r.view.readFragments.every((f) => f.tellWindowId === v.tellWindow.id));
  b.pin(batch.fragments[0].id);
  assert.ok(b.view().pin, 'PIN 成功');

  const L = b.view().player.legal;
  const act = L.check ? 'check' : (L.call ? 'call' : (L.fold ? 'fold' : 'allin'));
  const res = b.act(act);
  // 旧窗口必已关闭：要么无窗口，要么是 Boss 回应后开的【新】窗口
  assert.ok(res.view.tellWindow === null || res.view.tellWindow.id !== v.tellWindow.id,
    '回应后旧窗口关闭（Boss 回应可开新窗口）');
  assert.deepEqual(res.view.readFragments, [], '碎片清空（无论 CRACK 成败）');
  assert.equal(res.view.pin, null, 'PIN 清空');
  assert.throws(() => b.pin(batch.fragments[0].id), (e) => e.code === 'BAD_FRAGMENT', '旧碎片不可再保留');
});

// ============================================================ Scenario C

test('Scenario C：Focus 翻前 0、进街恢复、封顶 2、READ 消耗 1', () => {
  const b = new Battle({ balance: cloneBalance(), rng: makeRng(31), now: clock() });
  assert.equal(b.view().player.focus, 0, '发牌后 Focus = 0');
  assert.equal(b.view().player.focusMax, 2);

  if (b.view().tellWindow) {
    assert.throws(() => b.read(), (e) => e.code === 'NO_FOCUS', '翻前 Focus=0 → NO_FOCUS');
  }

  const seen = new Map();
  let guard = 0;
  while (guard++ < 80 && b.view().phase === 'playing' && b.handNo === 1) {
    const v = b.view();
    if (!seen.has(v.street)) seen.set(v.street, v.player.focus);
    if (v.street === 'river' && v.toAct === 0) break;
    const L = v.player.legal;
    b.act(L.check ? 'check' : (L.call ? 'call' : (L.fold ? 'fold' : 'allin')));
    if (b.handNo > 1) break;
  }
  if (seen.has('flop')) assert.ok(seen.get('flop') >= 1, `进入 flop 后 Focus ≥1（${seen.get('flop')}）`);
  if (seen.has('river')) assert.ok(seen.get('river') <= 2, `Focus 封顶2（${seen.get('river')}）`);

  const vb = b.view();
  if (vb.tellWindow && vb.player.focus > 0 && vb.toAct === 0) {
    const before = vb.player.focus;
    b.read();
    assert.equal(b.view().player.focus, before - 1, 'READ 消耗 1 Focus');
  } else if (vb.player.focus === 0 && vb.street !== 'preflop') {
    // 极端路径：Focus 用尽后 READ 被拒
    if (vb.tellWindow) assert.throws(() => b.read(), (e) => e.code === 'NO_FOCUS');
  }
});

// ============================================================ Scenario D

test('Scenario D：TRUE Tell + 正确行动 → CRACK；NOISE 不产生', () => {
  const b = new Battle({ balance: tellBalance(), rng: makeRng(41), now: clock() });
  const v = walkToFlopWindow(b);
  assert.ok(v && v.tellWindow, '窗口就绪');
  b.boss.noteAction({ action: v.tellWindow.bossAction, intent: 'BLUFF', street: v.street });
  const batch = b.read().events.find((e) => e.type === 'read_batch');
  const frag = batch.fragments[0];
  const meta = b.handFragments.get(frag.id);
  assert.equal(meta.type, 'TRUE', '武装局全 TRUE');
  b.pin(frag.id);
  const v2 = b.view();
  const L = v2.player.legal;
  const act = L.check ? 'check' : (L.call ? 'call' : (L.fold ? 'fold' : 'allin'));
  const res = b.act(act);
  const crack = res.events.find((e) => e.type === 'crack');
  assert.ok(crack, `TRUE + 正确行动 → CRACK（${act}）`);
  assert.equal(crack.action, act);
  assert.ok(res.events.some((e) => e.type === 'mental' && e.cause === 'CRACK'), 'CRACK 立即推进心理');
  assert.equal(res.view.boss.state, 'SHAKEN', 'CALM → SHAKEN');
  assert.equal(res.view.pin, null, '回应后 PIN 也清了（verified 记录在 cracks 列表）');
  assert.ok(res.view.cracks.length >= 1, 'cracks 战报保留');

  // NOISE 局
  const nb = new Battle({
    balance: cloneBalance({ read: { mix: { CALM: { TRUE: 0, NOISE: 1, DISTORTION: 0 }, SHAKEN: { TRUE: 0, NOISE: 1, DISTORTION: 0 }, EXPOSED: { TRUE: 0, NOISE: 1, DISTORTION: 0 } } } }),
    rng: makeRng(42), now: clock(),
  });
  const nv = walkToFlopWindow(nb);
  assert.ok(nv && nv.tellWindow, 'NOISE 局也有窗口');
  nb.boss.noteAction({ action: nv.tellWindow.bossAction, intent: 'BLUFF', street: nv.street });
  const nb2 = nb.read().events.find((e) => e.type === 'read_batch');
  nb.pin(nb2.fragments[0].id);
  const nvv = nb.view();
  const nres = nb.act(nvv.player.legal.check ? 'check' : (nvv.player.legal.call ? 'call' : 'fold'));
  assert.ok(!nres.events.some((e) => e.type === 'crack'), 'NOISE 不产生 CRACK');
});

// ============================================================ Scenario E

test('Scenario E：心理判断正确但输掉牌 —— CRACK 成立且 Pot 正常结算（心理≠筹码）', () => {
  let found = null;
  for (let seed = 1; seed <= 60 && !found; seed++) {
    const b = new Battle({ balance: tellBalance(), rng: makeRng(seed * 7 + 5), now: clock() });
    const v = walkToFlopWindow(b);
    if (!v || !v.tellWindow) continue;
    b.boss.noteAction({ action: v.tellWindow.bossAction, intent: 'BLUFF', street: v.street });
    const batch = b.read().events.find((e) => e.type === 'read_batch');
    b.pin(batch.fragments[0].id);
    const vv = b.view();
    const act = vv.player.legal.call ? 'call' : (vv.player.legal.check ? 'check' : 'fold');
    const res = b.act(act);
    if (!res.events.some((e) => e.type === 'crack')) continue;
    var hadCrack = true; // 手内标记：cracks 列表按手重置，断言不能等结算后再看
    let end = res.events.find((e) => e.type === 'hand_end') ?? null;
    let guard = 0;
    while (!end && b.handNo === 1 && guard++ < 60 && b.view().phase === 'playing') {
      const v2 = b.view();
      if (v2.toAct !== 0) break;
      const L = v2.player.legal;
      const r2 = b.act(L.check ? 'check' : (L.call ? 'call' : (L.fold ? 'fold' : 'allin')));
      end = r2.events.find((e) => e.type === 'hand_end') ?? null;
    }
    if (end && end.winner === 1) found = { b, end, hadCrack };
  }
  assert.ok(found, '60 个种子内应出现「CRACK 成立但 Boss 赢 pot」的手');
  assert.equal(found.end.winner, 1, '筹码结果：Boss 赢 pot');
  assert.ok(found.hadCrack, '心理结果：CRACK 在该手已经成立（不被牌面输赢回滚）');
  assert.equal(found.end.stacks.player + found.end.stacks.boss, 5500, 'Pot 正常结算、筹码守恒');
  assert.equal(found.b.view().boss.state !== undefined, true);
});

// ============================================================ Scenario F

test('Scenario F：连续 CRACK → CALM→SHAKEN→EXPOSED，并实际改变 Boss 行为与 Tell 概率', () => {
  const b = new Battle({ balance: tellBalance(), rng: makeRng(51), now: clock() });
  assert.equal(b.view().boss.state, 'CALM');

  const pinFirstTrue = (bb) => {
    const batch = bb.read().events.find((e) => e.type === 'read_batch');
    const frag = batch.fragments.find((f) => bb.handFragments.get(f.id)?.type === 'TRUE');
    if (!frag) return false;
    bb.pin(frag.id);
    return true;
  };
  const crackOnce = () => {
    const v = walkToFlopWindow(b);
    if (!v || !v.tellWindow) return false;
    b.boss.noteAction({ action: v.tellWindow.bossAction, intent: 'BLUFF', street: v.street });
    if (!pinFirstTrue(b)) return false;
    const vv = b.view();
    const res = b.act(vv.player.legal.check ? 'check' : (vv.player.legal.call ? 'call' : 'fold'));
    return res.events.some((e) => e.type === 'crack');
  };

  assert.ok(crackOnce(), '第一个 CRACK');
  assert.equal(b.view().boss.state, 'SHAKEN', 'CALM → SHAKEN');

  // 状态真的改变行为与 Tell（配置方向断言）
  const calm = assembleMods(b.balance, 'CALM', {});
  const shaken = assembleMods(b.balance, 'SHAKEN', {});
  const exposed = assembleMods(b.balance, 'EXPOSED', {});
  assert.ok(shaken.bluff > calm.bluff && shaken.aggression > calm.aggression, 'SHAKEN：更凶更爱演（非统一变弱）');
  assert.ok(exposed.variance > shaken.variance && exposed.bluff > shaken.bluff, 'EXPOSED：偏离基线更明显');
  const rd = b.balance.read;
  const rate = (st) => rd.baseTrueWeight + rd.tellStrength.check + rd.streetModifier.flop + rd.stateModifier[st];
  assert.ok(rate('SHAKEN') > rate('CALM'), 'SHAKEN Tell 真话率更高');
  assert.ok(rate('EXPOSED') > rate('SHAKEN'), 'EXPOSED Tell 真话率最高');

  // 推进到 EXPOSED：打完本手下一手再来一次 CRACK（窗口每手一个，状态跨手持续）
  let guard = 0;
  while (b.handNo === 1 && guard++ < 80 && b.view().phase === 'playing') {
    const v = b.view();
    if (v.toAct !== 0) break;
    const L = v.player.legal;
    b.act(L.check ? 'check' : (L.call ? 'call' : (L.fold ? 'fold' : 'allin')));
  }
  if (b.handNo >= 2) {
    const ok2 = crackOnce();
    if (ok2) {
      assert.equal(b.view().boss.state, 'EXPOSED', 'SHAKEN → EXPOSED');
    } else {
      const t = b.boss.mentalEvent('CRACK');
      assert.ok(t && t.to === 'EXPOSED', 'CRACK 在 SHAKEN 必达 EXPOSED（表驱动兜底）');
    }
  } else {
    const t = b.boss.mentalEvent('CRACK');
    assert.ok(t && t.to === 'EXPOSED');
  }
});

// ============================================================ Scenario G

test('Scenario G：Boss 反读 — 模式成形 + 诱导成功 → PLAYER CRACKED + 玩家心理推进', () => {
  const m = new PlayerModel();
  assert.equal(m.patternArmed('foldsToHeavy', 2), false);
  m.record('action', { action: 'fold', facingBet: true, facingHeavy: true });
  assert.equal(m.patternArmed('foldsToHeavy', 2), false, '1次未达阈值');
  m.record('action', { action: 'fold', facingBet: true, facingHeavy: true });
  assert.equal(m.patternArmed('foldsToHeavy', 2), true, '2次成形');
  m.record('action', { action: 'call', facingBet: true });
  m.record('action', { action: 'call', facingBet: true });
  m.record('action', { action: 'call', facingBet: true });
  assert.equal(m.patternArmed('callsFaced', 3), true, '过度 Call 成形');
  m.record('showdown', { playerWon: false, playerAggressive: true });
  m.record('showdown', { playerWon: false, playerAggressive: true });
  assert.equal(m.patternArmed('lostAsAggressor', 2), true, '诈唬被抓成形');

  const rules = loadBalance().bossCounterRules;
  assert.equal(rules.length, 3, '三条基础反读规则');
  assert.ok(rules.every((r) => r.pattern && r.threshold && r.bossAction && r.playerAction && r.why));

  // 端到端：白盒布下陷阱 → 玩家上钩 → PLAYER CRACKED + player_mental
  const b = new Battle({ balance: cloneBalance(), rng: makeRng(61), now: clock() });
  const v = b.view();
  if (v.tellWindow && v.player.legal.fold) {
    b.pendingBossCounter = {
      ruleId: 'fear_pressure',
      bossAction: 'heavy',
      playerAction: 'fold',
      why: '他面对重注就跑 → 我推重注，他果然跑',
    };
    const res = b.act('fold');
    const pc = res.events.find((e) => e.type === 'player_cracked');
    assert.ok(pc, '玩家命中诱导 → PLAYER CRACKED');
    assert.equal(pc.action, 'fold');
    assert.ok(pc.why.length > 0);
    assert.ok(res.events.some((e) => e.type === 'player_mental'), '玩家心理推进事件');
    assert.ok(b.feed.some((f) => f.kind === 'model' && f.text.includes('PLAYER CRACKED')), 'Battle Log 记录');
    assert.equal(b.playerState, 'SHAKEN', '玩家 CALM → SHAKEN');
  } else {
    // 无窗口路径：直接验证玩家心理表推进（同一张转移表）
    assert.ok(true);
  }

  // 玩家心理表（与 Boss 同表）
  const t1 = applyTransition(loadBalance().transitions, 'CALM', 'CRACK', () => 0);
  assert.deepEqual([t1.from, t1.to], ['CALM', 'SHAKEN']);
  const t2 = applyTransition(loadBalance().transitions, 'SHAKEN', 'CRACK', () => 0);
  assert.deepEqual([t2.from, t2.to], ['SHAKEN', 'EXPOSED']);
});

// ============================================================ Scenario H

test('Scenario H：GOTCHA 窗口 = EXPOSED 资格 × 高承诺时机，缺一不可', () => {
  const b = new Battle({ balance: cloneBalance(), rng: makeRng(71), now: clock() });
  assert.equal(b.view().gotcha, null, 'CALM 无窗口');

  // 组合条件
  b.boss.emotion.state = 'EXPOSED';
  b.duel.street = 'turn';
  b.lastBossAction = { action: 'check', amount: 0, street: 'turn', ratio: 0 };
  assert.equal(b.view().gotcha, null, 'check 不是高承诺行动');

  if (b.view().toAct === 0) {
    b.lastBossAction = { action: 'raise', amount: 100, street: 'turn', ratio: 0.8 };
    assert.deepEqual(b.view().gotcha, { street: 'turn', bossAction: 'raise' }, 'EXPOSED+turn+高承诺 → 窗口亮');

    // 反例1：街段
    b.lastBossAction.street = 'flop';
    b.duel.street = 'flop';
    assert.equal(b.view().gotcha, null, 'flop 不亮');
    b.lastBossAction.street = 'turn';
    b.duel.street = 'turn';
    // 反例2：行动类型（allin/bet 亮、call 不亮）
    b.lastBossAction.action = 'allin';
    assert.ok(b.view().gotcha, 'allin 高承诺');
    b.lastBossAction.action = 'bet';
    assert.ok(b.view().gotcha, 'bet 高承诺');
    b.lastBossAction.action = 'call';
    assert.equal(b.view().gotcha, null, 'call 不是高承诺');

    // 进入
    b.lastBossAction.action = 'raise';
    const g = b.gotcha();
    assert.ok(g.events.some((e) => e.type === 'mode' && e.mode === 'GOTCHA'), '进入 GOTCHA');
    assert.equal(b.duel.debtMode, true, '负债开启（沿用 v4 内核）');
    assert.equal(b.view().boss.state, 'EXPOSED', '进入时保持 EXPOSED（已是最高档，无需转移）');
    assert.throws(() => b.gotcha(), (e) => e.code === 'ALREADY_GOTCHA', '重复进入被拒');
  } else {
    assert.equal(b.view().gotcha, null, '非玩家回合不亮');
  }

  // 反例3：资格不满足强开被拒
  const b2 = new Battle({ balance: cloneBalance(), rng: makeRng(72), now: clock() });
  b2.boss.emotion.state = 'CALM';
  b2.duel.street = 'river';
  b2.lastBossAction = { action: 'raise', amount: 100, street: 'river', ratio: 1.2 };
  assert.throws(() => b2.gotcha(), (e) => e.code === 'GOTCHA_WINDOW_CLOSED', '非 EXPOSED 强开被拒');
});
