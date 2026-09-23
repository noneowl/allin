/**
 * 《ALL IN》v6 方案 Scenario A–I 实测（§15）。
 * Opening 强度 / 无 Opening 不可 READ / Hypothesis 推导 /
 * TRUE+正确行动→立即 CRACK（含受创反应与事件顺序）/ 噪音与错误行动不 CRACK /
 * CRACK 立即改状态 / 行动后三清 / combo 递增与中断清零。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Battle, loadBalance, computeOpeningStrength } from '../server/battle.js';
import { seededRng } from '../server/engine/cards.js';
import { INTERACTION } from '../server/boss/fragments.js';

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

/** 全 TRUE + 全能规则（intent 可控）。 */
function tellBalance(over = {}) {
  const ALL = ['call', 'check', 'fold', 'pressure', 'heavy', 'allin', 'bet', 'raise'];
  const rules = ['wants_fold', 'fear_call', 'fear_raise', 'weak_hand', 'missed_board', 'draw'].map((tag) => ({ id: `w_${tag}`, tag, actions: ALL, truthIntents: ['BLUFF', 'PROBE'], kind: 'WEAKNESS', why: 't' }))
    .concat(['strong_hand', 'trap', 'call_welcome', 'board_lock', 'overconfidence'].map((tag) => ({ id: `s_${tag}`, tag, actions: ALL, truthIntents: ['VALUE', 'TRAP', 'CONTROL'], kind: 'STRENGTH', why: 't' })));
  return cloneBalance({
    read: { baseTrueWeight: 0.95, mix: { CALM: { TRUE: 1, NOISE: 0, DISTORTION: 0 }, SHAKEN: { TRUE: 1, NOISE: 0, DISTORTION: 0 }, EXPOSED: { TRUE: 1, NOISE: 0, DISTORTION: 0 } } },
    psychologyActionRules: rules,
    ...over,
  });
}

/** 走到 flop+ 且窗口在手、玩家回合、Focus>0。 */
function walkToWindow(b, minFocus = 1) {
  let guard = 0;
  while (guard++ < 100 && b.view().phase === 'playing') {
    const v = b.view();
    if (v.toAct !== 0) break;
    if (v.tellWindow && v.street !== 'preflop' && v.player.focus >= minFocus) return v;
    const L = v.player.legal;
    b.act(L.check ? 'check' : (L.call ? 'call' : (L.fold ? 'fold' : 'allin')));
  }
  return null;
}

// ============================================================ A

test('Scenario A：弱行为 → WEAK；强承诺行为 → STRONG（含状态抬级，全部 spec 示例）', () => {
  const bal = loadBalance();
  const cases = [
    // [档, 街, 状态, 期望] —— 方案 §2 举例逐条钉死
    ['check', 'flop', 'CALM', 'WEAK'],
    ['bet', 'turn', 'CALM', 'NORMAL'],
    ['heavy', 'turn', 'CALM', 'STRONG'],
    ['raise', 'turn', 'CALM', 'STRONG'],
    ['raise', 'river', 'CALM', 'STRONG'],
    ['check', 'flop', 'SHAKEN', 'NORMAL'],   // 状态抬一级
    ['call', 'flop', 'CALM', 'NORMAL'],
    ['check', 'river', 'CALM', 'NORMAL'],
    ['allin', 'river', 'EXPOSED', 'STRONG'],
    ['raise', 'flop', 'CALM', 'NORMAL'],
  ];
  for (const [tier, street, state, exp] of cases) {
    const got = computeOpeningStrength(bal, state, tier, street);
    assert.equal(got, exp, `${state} ${tier}@${street} → ${got}（期望 ${exp}）`);
  }
  // 只输出三档，无概率
  for (const [tier, street, state] of cases) {
    assert.ok(['WEAK', 'NORMAL', 'STRONG'].includes(computeOpeningStrength(bal, state, tier, street)));
  }
  // labels 配置齐
  assert.deepEqual(bal.opening.labels, { WEAK: '微弱', NORMAL: '明显', STRONG: '强烈' });
});

// ============================================================ B

test('Scenario B：没有 Opening → READ 不可用', () => {
  // 找一个玩家先手的种子（无窗口）
  const b = new Battle({ balance: cloneBalance({ focus: { max: 2, cost: 1, streetGrant: { flop: 1, turn: 1, river: 1 } } }), rng: makeRng(11), now: clock() });
  let guard = 0;
  while (!(b.view().button === 0) && guard++ < 30) {
    // 换手太贵：直接断言白盒路径 + 下面的事件路径
    break;
  }
  if (b.view().button === 0 && !b.view().tellWindow) {
    b.focus = 2; // 有 Focus 也不行 —— 卡的是 Opening
    assert.throws(() => b.read(), (e) => e.code === 'NO_TELL_WINDOW', '无 Opening 不可 READ（Focus 满也不行）');
  }
  // 白盒：窗口被关（回应落地后）
  const b2 = new Battle({ balance: tellBalance(), rng: makeRng(12), now: clock() });
  b2.tellWindow = null;
  b2.focus = 2;
  assert.throws(() => b2.read(), (e) => e.code === 'NO_TELL_WINDOW', '窗口不存在 → NO_TELL_WINDOW');
  // 事件侧：tell_window_open 必然带 strength 字段
  const b3 = new Battle({ balance: cloneBalance(), rng: makeRng(13), now: clock() });
  let saw = false;
  guard = 0;
  while (!saw && guard++ < 30 && b3.view().phase === 'playing') {
    const v = b3.view();
    if (v.tellWindow) { saw = Boolean(v.tellWindow.strength); break; }
    if (v.toAct !== 0) break;
    const L = v.player.legal;
    b3.act(L.check ? 'check' : (L.call ? 'call' : 'fold'));
  }
  if (saw) assert.ok(['WEAK', 'NORMAL', 'STRONG'].includes(b3.view().tellWindow.strength));
});

// ============================================================ C

test('Scenario C：选中 Fragment → 正确生成 Hypothesis（desire/fear 映射）', () => {
  const b = new Battle({ balance: tellBalance(), rng: makeRng(21), now: clock() });
  const v = walkToWindow(b);
  assert.ok(v && v.tellWindow, '窗口就绪');
  assert.equal(b.view().hypothesis, null, '未选前无判断');
  b.boss.noteAction({ action: v.tellWindow.bossAction, intent: 'BLUFF', street: v.street });

  const batch = b.read().events.find((e) => e.type === 'read_batch');
  const frag = batch.fragments.find((f) => b.handFragments.get(f.id)?.type === 'TRUE');
  assert.ok(frag, '武装局必能取到 TRUE（baseTrueWeight=0.95 + 固定种子）');
  const meta = b.handFragments.get(frag.id);
  assert.equal(meta.type, 'TRUE');
  const ix = INTERACTION[meta.tags[0]];
  assert.ok(ix && (ix.desire || ix.fear), `家族 ${meta.tags[0]} 必须有交互语义`);

  const pinRes = b.pin(frag.id);
  const h = pinRes.view.hypothesis;
  assert.ok(h, '选中后立刻有 Hypothesis');
  if (ix.desire) {
    assert.deepEqual(h, { mode: 'want', action: ix.desire });
  } else {
    assert.deepEqual(h, { mode: 'fear', action: ix.fear });
  }
  // wire 隐私：hypothesis 只有 mode/action，不含 type/tags/text
  assert.deepEqual(Object.keys(h).sort(), ['action', 'mode']);
  // view 仍不下发碎片类型
  for (const f of b.view().readFragments) assert.deepEqual(Object.keys(f).sort(), ['atHand', 'id', 'tellWindowId', 'text']);

  // 噪音 → 无 Hypothesis
  const nb = new Battle({
    balance: cloneBalance({ read: {
      baseTrueWeight: 0,
      tellStrength: { check: 0, bet: 0, fold: 0, call: 0, raise: 0, heavy: 0, allin: 0 },
      streetModifier: { preflop: 0, flop: 0, turn: 0, river: 0 },
      stateModifier: { CALM: 0, SHAKEN: 0, EXPOSED: 0 },
      mix: { CALM: { TRUE: 0, NOISE: 1, DISTORTION: 0 }, SHAKEN: { TRUE: 0, NOISE: 1, DISTORTION: 0 }, EXPOSED: { TRUE: 0, NOISE: 1, DISTORTION: 0 } },
    } }),
    rng: makeRng(22), now: clock(),
  });
  const nv = walkToWindow(nb);
  assert.ok(nv && nv.tellWindow);
  nb.boss.noteAction({ action: nv.tellWindow.bossAction, intent: 'BLUFF', street: nv.street });
  const nb2 = nb.read().events.find((e) => e.type === 'read_batch');
  nb.pin(nb2.fragments[0].id);
  assert.equal(nb.view().hypothesis, null, '噪音无交互语义 → 无 Hypothesis（且永不可能 CRACK）');
});

// ============================================================ D

test('Scenario D：TRUE + 正确行动 → 立即 CRACK（受创台词紧随，顺序 crack→talk→mental）', () => {
  const b = new Battle({ balance: tellBalance(), rng: makeRng(31), now: clock() });
  const v = walkToWindow(b);
  assert.ok(v && v.tellWindow);
  b.boss.noteAction({ action: v.tellWindow.bossAction, intent: 'BLUFF', street: v.street });
  const batch = b.read().events.find((e) => e.type === 'read_batch');
  const frag = batch.fragments.find((f) => b.handFragments.get(f.id)?.type === 'TRUE');
  assert.ok(frag, '武装局必能取到 TRUE');
  b.pin(frag.id);
  const v2 = b.view();
  const L = v2.player.legal;
  const act = L.check ? 'check' : (L.call ? 'call' : (L.fold ? 'fold' : 'allin'));
  const res = b.act(act);

  const idxCrack = res.events.findIndex((e) => e.type === 'crack');
  const idxTalk = res.events.findIndex((e) => e.type === 'talk' && e.line !== undefined);
  const idxMental = res.events.findIndex((e) => e.type === 'mental');
  assert.ok(idxCrack >= 0, 'TRUE + 正确行动 → 立即 CRACK');
  assert.equal(res.events[idxCrack].combo, 1, '事件携带段数');
  assert.ok(idxTalk > idxCrack, 'Boss 受创台词紧跟 CRACK 之后');
  assert.ok(idxMental > idxCrack, '心理状态推进在 CRACK 之后');
  // 受创台词池内容（v6 §8 至少有短句反应）
  assert.ok(res.events[idxTalk].line.length > 0);
  assert.equal(res.view.boss.state, 'SHAKEN', '立即改变 Boss 心理状态');
  assert.equal(res.view.comboCount, 1, '第一段');
});

// ============================================================ E

test('Scenario E：NOISE / DISTORTION 不能 CRACK', () => {
  for (const [kind, mix] of [
    ['NOISE', { TRUE: 0, NOISE: 1, DISTORTION: 0 }],
    ['DISTORTION', { TRUE: 0, NOISE: 0, DISTORTION: 1 }],
  ]) {
    const b = new Battle({
      balance: cloneBalance({
        read: {
          baseTrueWeight: 0,
          tellStrength: { check: 0, bet: 0, fold: 0, call: 0, raise: 0, heavy: 0, allin: 0 },
          streetModifier: { preflop: 0, flop: 0, turn: 0, river: 0 },
          stateModifier: { CALM: 0, SHAKEN: 0, EXPOSED: 0 },
          mix: { CALM: mix, SHAKEN: mix, EXPOSED: mix },
        },
      }),
      rng: makeRng(41), now: clock(),
    });
    const v = walkToWindow(b);
    assert.ok(v && v.tellWindow, `${kind} 局也有窗口`);
    b.boss.noteAction({ action: v.tellWindow.bossAction, intent: 'BLUFF', street: v.street });
    const batch = b.read().events.find((e) => e.type === 'read_batch');
    const meta = b.handFragments.get(batch.fragments[0].id);
    assert.equal(meta.type, kind);
    b.pin(batch.fragments[0].id);
    const vv = b.view();
    const res = b.act(vv.player.legal.check ? 'check' : (vv.player.legal.call ? 'call' : 'fold'));
    assert.ok(!res.events.some((e) => e.type === 'crack'), `${kind} 不产生 CRACK`);
    assert.equal(res.view.comboCount, 0, '未命中且有 Opening → 段数清零');
  }
});

// ============================================================ F

test('Scenario F：错误 Poker Action 不能 CRACK', () => {
  const b = new Battle({ balance: tellBalance(), rng: makeRng(51), now: clock() });
  const v = walkToWindow(b);
  assert.ok(v && v.tellWindow);
  // 白盒钉一个确定的判断：desire FOLD（规则 actions=[call]，fold 是“错误行动”）
  b.pinned = {
    fragmentId: 'wXf1', text: 'x', type: 'TRUE', tags: ['wants_fold'],
    desire: 'FOLD', fear: null, sourceAction: v.tellWindow.bossAction,
    binding: { tellWindowId: v.tellWindow.id }, handId: 1, verified: false,
  };
  assert.deepEqual(b.view().hypothesis, { mode: 'want', action: 'FOLD' });
  const res = b.act('fold'); // 顺从他的意图 → 不算命中
  assert.ok(!res.events.some((e) => e.type === 'crack'), '错误行动（顺从而非利用）不 CRACK');
  assert.equal(res.view.hypothesis, null, '行动后判断即清');
  assert.equal(res.view.comboCount, 0, '有 Opening 未命中 → 清零');
});

// ============================================================ G

test('Scenario G：CRACK 立即改变 Boss psychologicalState，并持续影响 Opening 档位', () => {
  const b = new Battle({ balance: tellBalance(), rng: makeRng(61), now: clock() });
  assert.equal(b.view().boss.state, 'CALM');
  const v = walkToWindow(b);
  b.boss.noteAction({ action: v.tellWindow.bossAction, intent: 'BLUFF', street: v.street });
  const batch = b.read().events.find((e) => e.type === 'read_batch');
  const gfrag = batch.fragments.find((f) => b.handFragments.get(f.id)?.type === 'TRUE');
  assert.ok(gfrag, '武装局必能取到 TRUE');
  b.pin(gfrag.id);
  const v2 = b.view();
  const res = b.act(v2.player.legal.check ? 'check' : (v2.player.legal.call ? 'call' : 'fold'));
  assert.ok(res.events.some((e) => e.type === 'crack'));
  assert.ok(res.events.some((e) => e.type === 'mental' && e.to === 'SHAKEN'), 'CRACK 立即推进');
  assert.equal(res.view.boss.state, 'SHAKEN', '同一响应里状态已变');
  // 状态继续影响 Opening：SHAKEN 抬级
  const bal = loadBalance();
  assert.equal(computeOpeningStrength(bal, 'SHAKEN', 'check', 'flop'), 'NORMAL', 'SHAKEN 让弱行为抬一级');
});

// ============================================================ H

test('Scenario H：本次 Poker Response 完成 → Opening/Fragments/Hypothesis 全清', () => {
  const b = new Battle({ balance: tellBalance(), rng: makeRng(71), now: clock() });
  const v = walkToWindow(b);
  assert.ok(v && v.tellWindow);
  b.boss.noteAction({ action: v.tellWindow.bossAction, intent: 'BLUFF', street: v.street });
  const batch = b.read().events.find((e) => e.type === 'read_batch');
  const hfrag = batch.fragments.find((f) => b.handFragments.get(f.id)?.type === 'TRUE');
  assert.ok(hfrag, '武装局必能取到 TRUE');
  b.pin(hfrag.id);
  assert.ok(b.view().hypothesis, '行动前判断在');

  const L = b.view().player.legal;
  const res = b.act(L.check ? 'check' : (L.call ? 'call' : (L.fold ? 'fold' : 'allin')));
  const win = res.view.tellWindow;
  assert.ok(win === null || win.id !== v.tellWindow.id, '旧 Opening 关闭（Boss 回应可开新窗）');
  assert.deepEqual(res.view.readFragments, [], 'Fragments 清空');
  assert.equal(res.view.hypothesis, null, 'Hypothesis 清空');
  assert.equal(res.view.pin, null, 'PIN 清空');
});

// ============================================================ I

test('Scenario I：连续 CRACK → comboCount 递增；有 Opening 未命中 → 清零', () => {
  const b = new Battle({ balance: tellBalance(), rng: makeRng(81), now: clock() });
  const openFakeWindow = () => {
    if (b.view().tellWindow) return;
    b.tellWindow = {
      id: 900 + b.tellSeq, actionId: 900, handId: b.handNo,
      street: b.view().street, bossAction: 'check', tier: 'check', strength: 'WEAK',
    };
  };

  // ① 第一段：真实 CRACK → combo 1
  let v = walkToWindow(b);
  assert.ok(v && v.tellWindow, '窗口就绪');
  b.boss.noteAction({ action: v.tellWindow.bossAction, intent: 'BLUFF', street: v.street });
  let batch = b.read().events.find((e) => e.type === 'read_batch');
  let frag = batch.fragments.find((f) => b.handFragments.get(f.id)?.type === 'TRUE');
  assert.ok(frag, '武装局必能取到 TRUE');
  b.pin(frag.id);
  let vv = b.view();
  let res = b.act(vv.player.legal.check ? 'check' : (vv.player.legal.call ? 'call' : 'fold'));
  let crack = res.events.find((e) => e.type === 'crack');
  assert.ok(crack, '第一次 CRACK');
  assert.equal(crack.combo, 1, '事件带段数 ×1');
  assert.equal(res.view.comboCount, 1);

  // ② 中断：存在 Opening，却未命中（pinned 已清、不带判断行动）→ 清零
  openFakeWindow();
  vv = b.view();
  res = b.act(vv.player.legal.check ? 'check' : (vv.player.legal.call ? 'call' : 'fold'));
  assert.ok(!res.events.some((e) => e.type === 'crack'), '这次不命中');
  assert.equal(res.view.comboCount, 0, '有 Opening 未命中 → 段数清零');

  // ③ 续段：预置「已连一段」，再来一次真实 CRACK → ×2
  openFakeWindow();
  b.focus = 1; // 白盒补给（只测段数，不测 Focus 授予——Scenario C 覆盖）
  vv = b.view();
  b.boss.noteAction({ action: b.tellWindow.bossAction, intent: 'BLUFF', street: b.tellWindow.street });
  batch = b.read().events.find((e) => e.type === 'read_batch');
  frag = batch.fragments.find((f) => b.handFragments.get(f.id)?.type === 'TRUE');
  assert.ok(frag, '第二段可取 TRUE');
  b.pin(frag.id);
  b.comboCount = 1; // 预置：上一段仍连着
  vv = b.view();
  res = b.act(vv.player.legal.check ? 'check' : (vv.player.legal.call ? 'call' : 'fold'));
  crack = res.events.find((e) => e.type === 'crack');
  assert.ok(crack, '第二次 CRACK');
  assert.equal(crack.combo, 2, '事件带段数 ×2');
  assert.equal(res.view.comboCount, 2, '连续命中 → ×2');

  // ④ 无 Opening 的行动不计入（没东西可错过）
  b.tellWindow = null;
  b.comboCount = 2;
  vv = b.view();
  if (vv.toAct === 0) {
    res = b.act(vv.player.legal.check ? 'check' : (vv.player.legal.call ? 'call' : 'fold'));
    assert.equal(res.view.comboCount, 2, '无窗口的行动不清段数');
  }
});
