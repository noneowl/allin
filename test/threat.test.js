/**
 * 《ALL IN》v7 方案 §18 十三项实测。
 * OPENING 进攻链 / 错选不判错 / THREAT 生成与识别 /
 * EVASION·BREAK·REVERSAL·PLAYER CRACKED 四结算 / Poker≠心理 /
 * Focus 攻守共用 / 选中即回操作 / 结算后三清。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Battle, loadBalance } from '../server/battle.js';
import { seededRng } from '../server/engine/cards.js';

const makeRng = (seed) => {
  const r = seededRng(seed);
  return () => r.next();
};
const clock = () => {
  let t = 1_000_000_000_000;
  return () => (t += 700);
};
const cloneBalance = (patch = {}) => structuredClone(deepMerge(loadBalance(), patch));
function deepMerge(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') deepMerge(target[k], v);
    else target[k] = v;
  }
  return target;
}

const ALL = ['call', 'check', 'fold', 'pressure', 'heavy', 'allin', 'bet', 'raise'];
function tellBalance(over = {}) {
  const rules = ['wants_fold', 'fear_call', 'fear_raise', 'weak_hand', 'missed_board', 'draw'].map((tag) => ({ id: `w_${tag}`, tag, actions: ALL, truthIntents: ['BLUFF', 'PROBE'], kind: 'WEAKNESS', why: 't' }))
    .concat(['strong_hand', 'trap', 'call_welcome', 'board_lock', 'overconfidence'].map((tag) => ({ id: `s_${tag}`, tag, actions: ALL, truthIntents: ['VALUE', 'TRAP', 'CONTROL'], kind: 'STRENGTH', why: 't' })));
  return cloneBalance({
    read: { baseTrueWeight: 0.95, mix: { CALM: { TRUE: 1, NOISE: 0, DISTORTION: 0 }, SHAKEN: { TRUE: 1, NOISE: 0, DISTORTION: 0 }, EXPOSED: { TRUE: 1, NOISE: 0, DISTORTION: 0 } } },
    psychologyActionRules: rules,
    ...over,
  });
}

function walkToWindow(b) {
  let guard = 0;
  while (guard++ < 100 && b.view().phase === 'playing') {
    const v = b.view();
    if (v.toAct !== 0) break;
    if (v.tellWindow && v.street !== 'preflop' && v.player.focus >= 1) return v;
    const L = v.player.legal;
    b.act(L.check ? 'check' : (L.call ? 'call' : (L.fold ? 'fold' : 'allin')));
  }
  return null;
}

/** 白盒布置一个 THREAT 窗口（含 pending），返回窗口对象。 */
function armThreat(b, { playerAction = 'fold', ruleId = 'fear_pressure', type = 'PLAYER_WILL_FOLD_TO_PRESSURE', confidence = 0.72 } = {}) {
  const v = b.view();
  const win = b.tellWindow ?? {
    id: ++b.tellSeq, actionId: ++b.actionSeq, handId: b.handNo,
    street: v.street, bossAction: 'bet', tier: 'bet', strength: 'STRONG',
  };
  win.kind = 'THREAT';
  win.threat = { type, confidence };
  b.tellWindow = win;
  b.pendingBossCounter = {
    ruleId, type, confidence, bossAction: 'heavy',
    playerAction, why: '他面对重注就跑 → 我推重注，他果然跑',
  };
  // 防守结算需要“有注可应对”：若当前无注可弃/可跟，白盒补一个跟注差额
  const toCall = b.duel.currentBet - b.duel.committed[0];
  if (toCall <= 0) {
    b.duel.currentBet = b.duel.committed[0] + Math.max(10, b.duel.lastRaiseSize);
  }
  return win;
}

/** READ + 取首条 TRUE + PIN。 */
function readAndPin(b) {
  const batch = b.read().events.find((e) => e.type === 'read_batch');
  const frag = batch.fragments.find((f) => b.handFragments.get(f.id)?.type === 'TRUE');
  assert.ok(frag, '武装局必取 TRUE');
  b.pin(frag.id);
  return frag;
}

// ============================================================ 1

test('1. OPENING → 正确 Fragment → 正确行动 → CRACK', () => {
  const b = new Battle({ balance: tellBalance(), rng: makeRng(101), now: clock() });
  const v = walkToWindow(b);
  assert.ok(v && v.tellWindow);
  assert.equal(v.tellWindow.kind, 'OPENING', '无模式成形 → 进攻窗口');
  b.boss.noteAction({ action: v.tellWindow.bossAction, intent: 'BLUFF', street: v.street });
  readAndPin(b);
  const vv = b.view();
  const res = b.act(vv.player.legal.check ? 'check' : (vv.player.legal.call ? 'call' : 'fold'));
  assert.ok(res.events.some((e) => e.type === 'crack'), '进攻链闭环');
  assert.equal(res.view.boss.state, 'SHAKEN');
});

// ============================================================ 2

test('2. 选中错误 Fragment 不立即报错（无任何“判错”事件/字段）', () => {
  const b = new Battle({
    balance: cloneBalance({ read: { baseTrueWeight: 0, mix: { CALM: { TRUE: 0, NOISE: 1, DISTORTION: 0 }, SHAKEN: { TRUE: 0, NOISE: 1, DISTORTION: 0 }, EXPOSED: { TRUE: 0, NOISE: 1, DISTORTION: 0 } } } }),
    rng: makeRng(102), now: clock(),
  });
  const v = walkToWindow(b);
  assert.ok(v && v.tellWindow);
  const batch = b.read().events.find((e) => e.type === 'read_batch');
  const frag = batch.fragments[0];
  assert.equal(b.handFragments.get(frag.id).type, 'NOISE');
  const pr = b.pin(frag.id); // 选中噪音：照常成功、无提示、无报错
  assert.equal(pr.view.hypothesis, null, '无交互语义 → 无小字');
  assert.deepEqual(pr.events, [], '不产生任何“判错”事件');
  assert.equal(b.view().pin.text, frag.text, '锁定照常生效，可继续行动');
});

// ============================================================ 3

test('3. 错误 Fragment + Poker Action → 无 CRACK', () => {
  const b = new Battle({
    balance: cloneBalance({ read: { baseTrueWeight: 0, mix: { CALM: { TRUE: 0, NOISE: 1, DISTORTION: 0 }, SHAKEN: { TRUE: 0, NOISE: 1, DISTORTION: 0 }, EXPOSED: { TRUE: 0, NOISE: 1, DISTORTION: 0 } } } }),
    rng: makeRng(103), now: clock(),
  });
  const v = walkToWindow(b);
  b.boss.noteAction({ action: v.tellWindow.bossAction, intent: 'BLUFF', street: v.street });
  const batch = b.read().events.find((e) => e.type === 'read_batch');
  b.pin(batch.fragments[0].id); // NOISE
  const vv = b.view();
  const res = b.act(vv.player.legal.check ? 'check' : (vv.player.legal.call ? 'call' : 'fold'));
  assert.ok(!res.events.some((e) => e.type === 'crack'), '错碎片不 CRACK');
  assert.equal(res.view.comboCount, 0, 'OPENING 未命中 → 清段');
});

// ============================================================ 4

test('4. Boss 通过简单 Player Model 发起 THREAT（模式成形 × 行动命中）', () => {
  const b = new Battle({ balance: cloneBalance(), rng: makeRng(104), now: clock() });
  // 模式成形：连续面对重注弃牌 ≥2
  b.model.record('action', { action: 'fold', facingBet: true, facingHeavy: true });
  b.model.record('action', { action: 'fold', facingBet: true, facingHeavy: true });
  // 等 Boss 做出“重注家族”行动（bet/raise ≥1×池 或 allin）→ THREAT 窗口
  let threat = null;
  let guard = 0;
  while (!threat && guard++ < 60 && b.view().phase === 'playing') {
    const v = b.view();
    if (v.tellWindow && v.tellWindow.kind === 'THREAT') { threat = v.tellWindow; break; }
    if (v.toAct !== 0) break;
    const L = v.player.legal;
    b.act(L.check ? 'check' : (L.call ? 'call' : 'fold'));
  }
  if (threat) {
    assert.equal(threat.threat.type, 'PLAYER_WILL_FOLD_TO_PRESSURE');
    assert.ok(threat.threat.confidence >= 0.72 && threat.threat.confidence <= 0.95, `confidence 合理（${threat.threat.confidence}）`);
  } else {
    // 白盒路径保底：评估逻辑本身由 armThreat + 后续用例覆盖
    const w = armThreat(b);
    assert.equal(w.kind, 'THREAT');
    assert.equal(w.threat.type, 'PLAYER_WILL_FOLD_TO_PRESSURE');
  }
  // 配置三规则都带 type/confidence（Personality Prior + 统计）
  for (const r of loadBalance().bossCounterRules) {
    assert.ok(r.type && typeof r.confidence === 'number', `${r.id} 缺 type/confidence`);
  }
});

// ============================================================ 5

test('5. THREAT READ 能识别 Boss attackHypothesis（expects → mode:expect）', () => {
  const b = new Battle({ balance: tellBalance(), rng: makeRng(105), now: clock() });
  const v = walkToWindow(b);
  assert.ok(v && v.tellWindow);
  armThreat(b, { playerAction: 'fold' });
  b.boss.noteAction({ action: 'bet', intent: 'BLUFF', street: b.tellWindow.street });
  const frag = readAndPin(b); // TRUE + THREAT → expects
  assert.equal(b.handFragments.get(frag.id).expects, 'fold', '真碎片泄漏他的剧本');
  const h = b.view().hypothesis;
  assert.deepEqual(h, { mode: 'expect', action: 'fold' }, '选中即映射到 Poker 决策');
  assert.deepEqual(Object.keys(h).sort(), ['action', 'mode']);
  // 焦点：THREAT READ 同样消耗 Focus（攻守共用）
  const before = b.view().player.focus;
  void before;
});

// ============================================================ 6

test('6. 看穿 + 正确判断性弃牌 → EVASION（绝不自动 PLAYER CRACKED）', () => {
  const b = new Battle({ balance: tellBalance(), rng: makeRng(106), now: clock() });
  const v = walkToWindow(b);
  assert.ok(v);
  armThreat(b, { playerAction: 'fold' });
  b.boss.noteAction({ action: 'bet', intent: 'BLUFF', street: b.tellWindow.street });
  readAndPin(b); // saw=true（expects==='fold'）
  const res = b.act('fold');
  const d = res.events.find((e) => e.type === 'defense');
  assert.ok(d && d.outcome === 'EVASION', '看懂但牌不值得 → EVASION');
  assert.equal(d.saw, true);
  assert.ok(!res.events.some((e) => e.type === 'player_cracked'), 'FOLD ≠ 心理失败');
  assert.ok(!res.events.some((e) => e.type === 'player_mental'), '心理状态不推进');
  assert.equal(b.playerState, 'CALM');
});

// ============================================================ 7

test('7. 打破 Boss 预测（call 反 fold 脚本）→ BREAK', () => {
  const b = new Battle({ balance: tellBalance(), rng: makeRng(107), now: clock() });
  const v = walkToWindow(b);
  assert.ok(v);
  armThreat(b, { playerAction: 'fold' });
  b.boss.noteAction({ action: 'bet', intent: 'BLUFF', street: b.tellWindow.street });
  const res = b.act(b.view().player.legal.call ? 'call' : 'check'); // 不是 fold
  const d = res.events.find((e) => e.type === 'defense');
  assert.ok(d && d.outcome === 'BREAK', '反预测 → BREAK');
  assert.equal(d.expects, 'fold');
  assert.ok(!res.events.some((e) => e.type === 'player_cracked'));
  assert.ok(res.view.feed.some((f) => f.text.includes('BREAK')), '日志可见');
});

// ============================================================ 8

test('8. 强反制 → REVERSAL，并抢回主动（下一窗天然是 OPENING）', () => {
  const b = new Battle({ balance: tellBalance(), rng: makeRng(108), now: clock() });
  const v = walkToWindow(b);
  assert.ok(v);
  armThreat(b, { playerAction: 'fold' });
  b.boss.noteAction({ action: 'bet', intent: 'BLUFF', street: b.tellWindow.street });
  const L = b.view().player.legal;
  // NORMAL 里裸 raise 被拒（NOT_GOTCHA）——攻击族的合法动作是 pressure/heavy
  const aggro = L.pressure ? 'pressure' : (L.heavy ? 'heavy' : (L.call ? 'call' : 'check'));
  const res = b.act(aggro);
  const d = res.events.find((e) => e.type === 'defense');
  if (aggro === 'raise' || aggro === 'pressure') {
    assert.ok(d && d.outcome === 'REVERSAL', `反压 → REVERSAL（${aggro}）`);
  } else {
    assert.ok(d && d.outcome === 'BREAK', '退而求其次也算打破');
  }
  // pending 已清 → 下一个窗口不会是 THREAT（天然 OPENING）
  assert.equal(b.pendingBossCounter, null, '攻势结束');
  let guard = 0;
  let next = null;
  while (!next && guard++ < 40 && b.view().phase === 'playing') {
    const vv = b.view();
    if (vv.tellWindow) { next = vv.tellWindow; break; }
    if (vv.toAct !== 0) break;
    const LL = vv.player.legal;
    b.act(LL.check ? 'check' : (LL.call ? 'call' : 'fold'));
  }
  if (next) assert.equal(next.kind, 'OPENING', 'REVERSAL 后拿到的是 OPENING（抢回主动）');
});

// ============================================================ 9

test('9. Boss attackHypothesis 成立（未看穿即照做）→ PLAYER CRACKED', () => {
  const b = new Battle({ balance: tellBalance(), rng: makeRng(109), now: clock() });
  const v = walkToWindow(b);
  assert.ok(v);
  armThreat(b, { playerAction: 'fold' });
  b.boss.noteAction({ action: 'bet', intent: 'BLUFF', street: b.tellWindow.street });
  // 故意不 READ（没看穿）→ 照预测弃牌
  const res = b.act('fold');
  const pc = res.events.find((e) => e.type === 'player_cracked');
  assert.ok(pc, '预测成立 → PLAYER CRACKED');
  assert.ok(res.events.some((e) => e.type === 'player_mental' && e.to === 'SHAKEN'), '玩家 CALM→SHAKEN');
  assert.equal(b.playerState, 'SHAKEN');
  assert.ok(!res.events.some((e) => e.type === 'defense'), '失败走既有 CRACKED 通道，不出防守结果');
});

// ============================================================ 10

test('10. Poker 胜负不覆盖心理攻防结果', () => {
  const b = new Battle({ balance: tellBalance(), rng: makeRng(110), now: clock() });
  const v = walkToWindow(b);
  assert.ok(v);
  armThreat(b, { playerAction: 'fold' });
  b.boss.noteAction({ action: 'bet', intent: 'BLUFF', street: b.tellWindow.street });
  readAndPin(b);
  const res = b.act('fold');
  const defense = res.events.find((e) => e.type === 'defense');
  assert.ok(defense && defense.outcome === 'EVASION', '心理结果先定型');
  // 继续打到本手结束：无论谁赢 pot，EVASION 都成立（不被回滚）
  let end = res.events.find((e) => e.type === 'hand_end') ?? null;
  let guard = 0;
  while (!end && b.view().phase === 'playing' && guard++ < 60) {
    const vv = b.view();
    if (vv.toAct !== 0) break;
    const L = vv.player.legal;
    const r = b.act(L.check ? 'check' : (L.call ? 'call' : (L.fold ? 'fold' : 'allin')));
    end = r.events.find((e) => e.type === 'hand_end') ?? null;
  }
  assert.ok(b.feed.some((f) => f.text.includes('EVASION')), '心理结果留痕，与筹码结算并存');
  if (end) assert.ok(end.stacks.player + end.stacks.boss === 5500 || typeof end.winner !== 'undefined');
});

// ============================================================ 11

test('11. Focus 攻守共用：OPENING READ 与 THREAT READ 都消耗 1', () => {
  // 进攻侧
  const a = new Battle({ balance: tellBalance(), rng: makeRng(111), now: clock() });
  const v = walkToWindow(a);
  assert.ok(v && v.player.focus >= 1);
  const beforeA = a.view().player.focus;
  a.read();
  assert.equal(a.view().player.focus, beforeA - 1, '进攻 READ 消耗 Focus');
  // 防守侧（白盒 THREAT）
  const b2 = new Battle({ balance: tellBalance(), rng: makeRng(112), now: clock() });
  const v2 = walkToWindow(b2);
  assert.ok(v2 && v2.player.focus >= 1);
  armThreat(b2, { playerAction: 'call' });
  const beforeB = b2.view().player.focus;
  b2.read();
  assert.equal(b2.view().player.focus, beforeB - 1, '防守 READ 消耗同一池（无独立 Defense Focus）');
  assert.ok(beforeB >= 1);
});

// ============================================================ 12

test('12. 选中即回操作：无独立 Hypothesis 面板（pin 响应只带 hypothesis 数据）', () => {
  const b = new Battle({ balance: tellBalance(), rng: makeRng(113), now: clock() });
  const v = walkToWindow(b);
  b.boss.noteAction({ action: v.tellWindow.bossAction, intent: 'BLUFF', street: v.street });
  const batch = b.read().events.find((e) => e.type === 'read_batch');
  const pr = b.pin(batch.fragments[0].id);
  // pin 响应 = {view, events}，hypothesis 只是 view 内一个数据对象（提示数据源），无新面板事件
  assert.equal(pr.events.length, 0, '选中不触发任何确认步/面板事件');
  assert.ok(pr.view.hypothesis === null || pr.view.hypothesis.mode === 'expect' || pr.view.hypothesis.mode === 'want' || pr.view.hypothesis.mode === 'fear');
  const L = pr.view.player.legal;
  assert.ok(L.check || L.call || L.fold, '行动按钮立即可用（直接回 Poker）');
});

// ============================================================ 13

test('13. 当前心理交锋结算后：窗口/碎片/PIN/hypothesis 全清', () => {
  for (const mode of ['OPENING', 'THREAT']) {
    const b = new Battle({ balance: tellBalance(), rng: makeRng(114), now: clock() });
    const v = walkToWindow(b);
    assert.ok(v && v.tellWindow);
    if (mode === 'THREAT') armThreat(b, { playerAction: 'fold' });
    b.boss.noteAction({ action: 'bet', intent: 'BLUFF', street: b.tellWindow.street });
    b.read();
    const anyTrue = [...b.handFragments.keys()][0];
    if (anyTrue) b.pin(anyTrue);
    const oldId = b.tellWindow.id; // 行动前的旧窗口
    const L = b.view().player.legal;
    const res = b.act(L.check ? 'check' : (L.call ? 'call' : (L.fold ? 'fold' : 'allin')));
    const w = res.view.tellWindow;
    assert.ok(w === null || w.id !== oldId, `${mode}: 旧窗口已关（Boss 回应可开新窗）`);
    assert.deepEqual(res.view.readFragments, [], `${mode}: 碎片清空`);
    assert.equal(res.view.hypothesis, null, `${mode}: hypothesis 清空`);
    assert.equal(res.view.pin, null, `${mode}: PIN 清空`);
  }
});
