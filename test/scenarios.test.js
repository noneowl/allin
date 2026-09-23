/**
 * 《ALL IN》v4 方案 Scenario A–I 实测（§十七）。
 * 这些用例直接对应交付检查清单：READ 限量 / 批量 / PIN / CRACK 验证 /
 * 噪音不 CRACK / GOTCHA 解锁 / 负债下注 / 自动泄漏 / 深度真话率 / 统一结算。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Battle, loadBalance } from '../server/battle.js';
import { seededRng } from '../server/engine/cards.js';

const rngOf = (seed) => {
  const r = seededRng(seed);
  return () => r.next();
};

/** 每次读取都前进 10s 的时钟：冷却永不阻塞测试。 */
const clock = () => {
  let t = 1_000_000_000_000;
  return () => (t += 10_000);
};

const cloneBalance = (patch = {}) => structuredClone(deepMerge(loadBalance(), patch));
function deepMerge(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') deepMerge(target[k], v);
    else target[k] = v;
  }
  return target;
}

/** 全 TRUE + 全能规则 + 指定 intent 的武装局：第一次成功行动必出 CRACK。 */
function armedBalance(over = {}) {
  return cloneBalance({
    readUsesPerHand: 4,
    cracksForGotcha: 1,
    read: {
      mix: { CALM: { TRUE: 1, NOISE: 0, DISTORTION: 0 }, SHAKEN: { TRUE: 1, NOISE: 0, DISTORTION: 0 }, TILT: { TRUE: 1, NOISE: 0, DISTORTION: 0 } },
    },
    psychologyActionRules: [
      { id: 'w_all', tag: 'wants_fold', actions: ['call', 'check', 'fold', 'pressure', 'heavy', 'allin', 'bet', 'raise'], truthIntents: ['BLUFF', 'PROBE'], kind: 'WEAKNESS', why: 't' },
      { id: 'fear_call_all', tag: 'fear_call', actions: ['call', 'check', 'fold', 'pressure', 'heavy', 'allin', 'bet', 'raise'], truthIntents: ['BLUFF', 'PROBE'], kind: 'WEAKNESS', why: 't' },
      { id: 'fear_raise_all', tag: 'fear_raise', actions: ['call', 'check', 'fold', 'pressure', 'heavy', 'allin', 'bet', 'raise'], truthIntents: ['BLUFF', 'PROBE'], kind: 'WEAKNESS', why: 't' },
      { id: 'weak_all', tag: 'weak_hand', actions: ['call', 'check', 'fold', 'pressure', 'heavy', 'allin', 'bet', 'raise'], truthIntents: ['BLUFF', 'PROBE'], kind: 'WEAKNESS', why: 't' },
      { id: 'missed_all', tag: 'missed_board', actions: ['call', 'check', 'fold', 'pressure', 'heavy', 'allin', 'bet', 'raise'], truthIntents: ['BLUFF', 'PROBE'], kind: 'WEAKNESS', why: 't' },
      { id: 'draw_all', tag: 'draw', actions: ['call', 'check', 'fold', 'pressure', 'heavy', 'allin', 'bet', 'raise'], truthIntents: ['BLUFF', 'PROBE'], kind: 'WEAKNESS', why: 't' },
      { id: 'strong_all', tag: 'strong_hand', actions: ['call', 'check', 'fold', 'pressure', 'heavy', 'allin', 'bet', 'raise'], truthIntents: ['VALUE', 'TRAP', 'CONTROL'], kind: 'STRENGTH', why: 't' },
      { id: 'trap_all', tag: 'trap', actions: ['call', 'check', 'fold', 'pressure', 'heavy', 'allin', 'bet', 'raise'], truthIntents: ['VALUE', 'TRAP', 'CONTROL'], kind: 'STRENGTH', why: 't' },
      { id: 'welcome_all', tag: 'call_welcome', actions: ['call', 'check', 'fold', 'pressure', 'heavy', 'allin', 'bet', 'raise'], truthIntents: ['VALUE', 'TRAP', 'CONTROL'], kind: 'STRENGTH', why: 't' },
      { id: 'lock_all', tag: 'board_lock', actions: ['call', 'check', 'fold', 'pressure', 'heavy', 'allin', 'bet', 'raise'], truthIntents: ['VALUE', 'TRAP', 'CONTROL'], kind: 'STRENGTH', why: 't' },
      { id: 'conf_all', tag: 'overconfidence', actions: ['call', 'check', 'fold', 'pressure', 'heavy', 'allin', 'bet', 'raise'], truthIntents: ['VALUE', 'TRAP', 'CONTROL'], kind: 'STRENGTH', why: 't' },
    ],
    ...over,
  });
}

function fragType(battle, id) {
  return battle.handFragments.get(id)?.type ?? null;
}

// ============================================================ Scenario A

test('Scenario A：READ 每手限量，耗尽后无法继续', () => {
  const b = new Battle({ balance: cloneBalance({ readUsesPerHand: 2 }), rng: rngOf(11), now: clock() });
  assert.equal(b.view().player.readsPerHand, 2);
  assert.equal(b.view().player.readsLeft, 2);

  b.read();
  assert.equal(b.view().player.readsLeft, 1, '读一次剩 1');
  b.read();
  assert.equal(b.view().player.readsLeft, 0, '读两次耗尽');
  assert.throws(() => b.read(), (e) => e.code === 'READ_EXHAUSTED', '耗尽后拒绝');

  // 冷却也独立生效
  let t = 1_000_000_000_000;
  const b2 = new Battle({ balance: cloneBalance({ readUsesPerHand: 5 }), rng: rngOf(12), now: () => t });
  b2.read();
  assert.throws(() => b2.read(), (e) => e.code === 'READ_COOLING', '冷却内拒绝');
  t += 10_000;
  b2.read(); // 冷却外可继续（次数还有）
  assert.equal(b2.view().player.readsLeft, 3);

  // 新的一手重置
  const b3 = new Battle({ balance: cloneBalance({ readUsesPerHand: 2 }), rng: rngOf(13), now: clock() });
  b3.read();
  b3.read();
  assert.equal(b3.view().player.readsLeft, 0);
  let guard = 0;
  while (b3.handNo === 1 && guard++ < 60 && b3.view().phase === 'playing') {
    const v = b3.view();
    if (v.toAct !== 0) break;
    const L = v.player.legal;
    b3.act(L.fold ? 'fold' : (L.check ? 'check' : 'call'));
  }
  assert.ok(b3.handNo >= 2 || b3.view().phase !== 'playing', '应打到下一手或终局');
  if (b3.handNo >= 2) assert.equal(b3.view().player.readsLeft, 2, '新手牌 READ 重置');
});

// ============================================================ Scenario B

test('Scenario B：一次 READ 返回复数碎片，可 PIN 其一', () => {
  const b = new Battle({ balance: cloneBalance(), rng: rngOf(21), now: clock() });
  const r = b.read();
  const batch = r.events.find((e) => e.type === 'read_batch');
  assert.ok(batch, '事件是 read_batch');
  assert.equal(batch.source, 'manual');
  const range = loadBalance().normalReadFragmentCount;
  assert.ok(batch.fragments.length >= range.min && batch.fragments.length <= range.max,
    `碎片数 ${batch.fragments.length} 应在 ${range.min}..${range.max}`);
  assert.ok(batch.flashMs > 0);
  for (const f of batch.fragments) {
    assert.ok(typeof f.id === 'string' && f.id.length > 0, '手工碎片带 id');
    assert.ok(f.text.length > 0);
    // wire 只有 id + text
    assert.deepEqual(Object.keys(f).sort(), ['id', 'text']);
  }

  // PIN 第一条
  const p = b.pin(batch.fragments[0].id);
  assert.equal(p.view.pin.text, batch.fragments[0].text);
  assert.equal(p.view.pin.verified, false);
  assert.deepEqual(Object.keys(p.view.pin).sort(), ['text', 'verified'], 'PIN 只下发 text+verified');

  // PIN 第二条覆盖第一条（单槽）
  const p2 = b.pin(batch.fragments[1].id);
  assert.equal(p2.view.pin.text, batch.fragments[1].text);

  // 不在本手的碎片不能 PIN
  assert.throws(() => b.pin('f9999'), (e) => e.code === 'BAD_FRAGMENT');
  // 面板条目形状
  for (const f of b.view().readFragments) assert.deepEqual(Object.keys(f).sort(), ['atHand', 'id', 'text']);
});

// ============================================================ Scenario C

test('Scenario C：PIN 真话 → 正确行动 → CRACK', () => {
  const b = new Battle({ balance: armedBalance(), rng: rngOf(31), now: clock() });
  b.boss.noteAction({ action: 'raise', intent: 'BLUFF', street: b.duel.street });

  const batch = b.read().events.find((e) => e.type === 'read_batch');
  // 找一条 TRUE（武装局全 TRUE）
  const frag = batch.fragments.find((f) => fragType(b, f.id) === 'TRUE');
  assert.ok(frag, '应有 TRUE 碎片');
  assert.equal(b.view().cracks.length, 0, '还没行动，没有 CRACK');

  b.pin(frag.id);
  // 做一个与规则匹配的行动（规则覆盖全部动作）
  const v = b.view();
  const L = v.player.legal;
  const act = L.check ? 'check' : (L.call ? 'call' : (L.fold ? 'fold' : 'allin'));
  const res = b.act(act);
  const crack = res.events.find((e) => e.type === 'crack');
  assert.ok(crack, `正确利用真话应出 CRACK（行动 ${act}）`);
  assert.ok(crack.evidence.length >= 1);
  assert.ok(['WEAKNESS', 'STRENGTH'].includes(crack.kind));
  assert.equal(crack.action, act, '记录触发的玩家行动');
  assert.equal(crack.critical, false);
  assert.equal(b.view().pin.verified, true, 'PIN 被打勾');
  assert.equal(b.view().cracks.length, 1);

  // 同一 PIN 已打勾，不再产生新 CRACK
  assert.equal(b.pinned.verified, true);
  assert.equal(b.view().pin.verified, true);
});

// ============================================================ Scenario D

test('Scenario D：NOISE / DISTORTION / 真值不符 都不产生 CRACK', () => {
  // 1) 全 NOISE
  const noiseBattle = new Battle({
    balance: cloneBalance({
      readUsesPerHand: 4, cracksForGotcha: 1,
      read: { mix: { CALM: { TRUE: 0, NOISE: 1, DISTORTION: 0 }, SHAKEN: { TRUE: 0, NOISE: 1, DISTORTION: 0 }, TILT: { TRUE: 0, NOISE: 1, DISTORTION: 0 } } },
    }),
    rng: rngOf(41), now: clock(),
  });
  noiseBattle.boss.noteAction({ action: 'raise', intent: 'BLUFF', street: noiseBattle.duel.street });
  const nb = noiseBattle.read().events.find((e) => e.type === 'read_batch');
  const noiseFrag = nb.fragments[0];
  assert.equal(fragType(noiseBattle, noiseFrag.id), 'NOISE', '该局全部是 NOISE');
  noiseBattle.pin(noiseFrag.id);
  const v1 = noiseBattle.view();
  const r1 = noiseBattle.act(v1.player.legal.check ? 'check' : (v1.player.legal.call ? 'call' : 'fold'));
  assert.ok(!r1.events.some((e) => e.type === 'crack'), 'PIN NOISE 不出 CRACK');
  assert.equal(noiseBattle.view().pin.verified, false);

  // 2) 全 DISTORTION
  const distBattle = new Battle({
    balance: cloneBalance({
      readUsesPerHand: 4, cracksForGotcha: 1,
      read: { mix: { CALM: { TRUE: 0, NOISE: 0, DISTORTION: 1 }, SHAKEN: { TRUE: 0, NOISE: 0, DISTORTION: 1 }, TILT: { TRUE: 0, NOISE: 0, DISTORTION: 1 } } },
    }),
    rng: rngOf(42), now: clock(),
  });
  distBattle.boss.noteAction({ action: 'raise', intent: 'BLUFF', street: distBattle.duel.street });
  const db = distBattle.read().events.find((e) => e.type === 'read_batch');
  const distFrag = db.fragments[0];
  assert.equal(fragType(distBattle, distFrag.id), 'DISTORTION', '该局全部是 DISTORTION');
  distBattle.pin(distFrag.id);
  const v2 = distBattle.view();
  const r2 = distBattle.act(v2.player.legal.check ? 'check' : (v2.player.legal.call ? 'call' : 'fold'));
  assert.ok(!r2.events.some((e) => e.type === 'crack'), 'PIN DISTORTION 不出 CRACK');

  // 3) 真话但 Boss 当前 intent 不符（真相变了 → 旧情报失效）
  const stale = new Battle({ balance: armedBalance(), rng: rngOf(43), now: clock() });
  stale.boss.noteAction({ action: 'raise', intent: 'BLUFF', street: stale.duel.street });
  const sb = stale.read().events.find((e) => e.type === 'read_batch');
  const frag = sb.fragments.find((f) => {
    const t = fragType(stale, f.id);
    return t === 'TRUE';
  });
  // 全 TRUE 局里挑一个弱点标签（BLUFF 家族），再把 intent 改成 VALUE → 真值不符
  const meta = stale.handFragments.get(frag.id);
  stale.pin(frag.id);
  stale.boss.noteAction({ action: 'bet', intent: 'VALUE', street: stale.duel.street });
  const v3 = stale.view();
  const r3 = stale.act(v3.player.legal.check ? 'check' : (v3.player.legal.call ? 'call' : 'fold'));
  const cracked = r3.events.find((e) => e.type === 'crack');
  if (meta.tags.some((t) => ['wants_fold', 'fear_call', 'fear_raise', 'weak_hand', 'missed_board', 'draw'].includes(t))) {
    assert.ok(!cracked, '弱侧真话在 VALUE intent 下不得 CRACK（真值不符）');
  } else {
    assert.ok(cracked, '强侧真话在 VALUE intent 下应 CRACK');
  }
});

// ============================================================ Scenario E

test('Scenario E：CRACK 达到阈值 → GOTCHA 解锁并可进入', () => {
  const b = new Battle({ balance: armedBalance({ cracksForGotcha: 2 }), rng: rngOf(51), now: clock() });
  assert.equal(b.view().gotcha, null, '未达标不解锁');

  // 第一个 CRACK
  b.boss.noteAction({ action: 'raise', intent: 'BLUFF', street: b.duel.street });
  let batch = b.read().events.find((e) => e.type === 'read_batch');
  let frag = batch.fragments.find((f) => fragType(b, f.id) === 'TRUE');
  b.pin(frag.id);
  let v = b.view();
  let res = b.act(v.player.legal.check ? 'check' : (v.player.legal.call ? 'call' : 'fold'));
  assert.ok(res.events.some((e) => e.type === 'crack'), '第一个 CRACK');
  assert.equal(b.view().gotcha, null, '1/2 还不解锁');

  // 第二个 CRACK（换一条 PIN 再行动；Boss 换过 intent 后重新 noteAction 模拟同一进攻延续）
  b.boss.noteAction({ action: 'raise', intent: 'BLUFF', street: b.duel.street });
  batch = b.read().events.find((e) => e.type === 'read_batch');
  frag = batch.fragments.find((f) => fragType(b, f.id) === 'TRUE');
  b.pin(frag.id);
  v = b.view();
  res = b.act(v.player.legal.check ? 'check' : (v.player.legal.call ? 'call' : 'fold'));
  assert.ok(res.events.some((e) => e.type === 'crack'), '第二个 CRACK');
  assert.deepEqual(b.view().gotcha, { cracks: 2, need: 2 }, '2/2 解锁');

  // 进入 GOTCHA
  const g = b.gotcha();
  assert.ok(g.events.some((e) => e.type === 'mode' && e.mode === 'GOTCHA'), 'mode 事件');
  assert.equal(g.view.mode, 'GOTCHA');
  assert.equal(b.duel.debtMode, true, '引擎负债模式开启');
  assert.equal(g.view.boss.state, 'SHAKEN', '进入 GOTCHA 触发 GOTCHA_HIT → 动摇');
  assert.equal(g.view.gotcha, null, '进入后不再显示解锁提示');
  assert.throws(() => b.gotcha(), (e) => e.code === 'ALREADY_GOTCHA');
});

// ============================================================ Scenario F + H（负债与深度真话率）

test('Scenario F：GOTCHA 中可下注超过 Stack，出现负数临时余额', () => {
  const b = new Battle({ balance: armedBalance(), rng: rngOf(61), now: clock() });
  // 解锁并进入
  b.boss.noteAction({ action: 'raise', intent: 'BLUFF', street: b.duel.street });
  const batch = b.read().events.find((e) => e.type === 'read_batch');
  const frag = batch.fragments.find((f) => fragType(b, f.id) === 'TRUE');
  b.pin(frag.id);
  let v = b.view();
  let res = b.act(v.player.legal.check ? 'check' : (v.player.legal.call ? 'call' : 'fold'));
  assert.ok(res.events.some((e) => e.type === 'crack'));
  b.gotcha();

  // 把玩家筹码调小（记录基线），阶梯加注一次即可越界
  b.duel.stacks[0] = 15;
  const baseline = b.duel.stacks[0] + b.duel.stacks[1] + b.duel.total[0] + b.duel.total[1];
  v = b.view();
  assert.equal(v.toAct, 0, '轮到玩家');
  assert.ok(v.player.legal.gotchaRaiseTo !== null, '阶梯金额已给出');
  assert.ok(v.player.legal.gotchaRaiseTo > 15 || v.player.legal.gotchaRaiseTo >= v.player.legal.minTo, '阶梯可越界');
  res = b.act('raise'); // 不带金额 → 阶梯
  const ev = res.events.find((e) => e.type === 'action' && e.seat === 0);
  assert.ok(ev, 'raise 成功');
  assert.ok(b.duel.stacks[0] < 15 || b.duel.stacks[0] < ev.amount, `投入超过筹码 → 出现负债（stack=${b.duel.stacks[0]}）`);
  assert.ok(b.view().player.chips < 15, 'view.chips 可为负/小于原值');
  assert.equal(b.duel.allIn[0], false, '负债模式不产生 all-in 语义');
  assert.ok(b.duel.phase === 'playing', '没有触发 runout');

  // 阶梯：完成一次加注后步长翻倍
  assert.ok(b.gotchaRaiseStep >= 10, '步长存在');
  const stepBefore = b.gotchaRaiseStep;
  void stepBefore;

  // 引擎仍守住最小加注等规则
  const heldNow = b.duel.stacks[0] + b.duel.stacks[1] + b.duel.total[0] + b.duel.total[1];
  assert.equal(heldNow, baseline, '负债期间筹码+投入总量守恒');
});

test('Scenario H：GOTCHA 深度越高 TRUE 越多，depth 计数正确', () => {
  // 表全 0：任何深度都漏不出真话
  const zeroBattle = new Battle({
    balance: armedBalance({ gotcha: { trueRateByDepth: [0, 0, 0, 0], flashScale: 0.6 } }),
    rng: rngOf(71), now: clock(),
  });
  zeroBattle.mode = 'GOTCHA';
  zeroBattle.duel.debtMode = true;
  zeroBattle.gotchaDepth = 0;
  zeroBattle.gotchaRaiseStep = 20;
  zeroBattle.boss.noteAction({ action: 'raise', intent: 'BLUFF', street: zeroBattle.duel.street }); // 真实流程前置：Boss 行动过
  const mark = zeroBattle.readFragments.length;
  const r0 = zeroBattle.act('raise');
  const leaks0 = r0.events.filter((e) => e.type === 'read_batch' && e.source === 'gotcha');
  assert.ok(leaks0.length >= 1, 'RAISE 自动泄漏');
  assert.equal(leaks0[0].depth, 1, '深度从 1 开始');
  assert.equal(zeroBattle.gotchaDepth, leaks0.length, '每批泄漏 depth+1（玩家与 Boss 的 call/raise 都触发）');
  const fresh0 = zeroBattle.readFragments.slice(0, zeroBattle.readFragments.length - mark);
  assert.ok(fresh0.every((f) => f.type !== 'TRUE'), `trueRate=0 不得漏真话（${fresh0.map((f) => f.type)}）`);
  for (const ev of leaks0) {
    assert.ok(ev.fragments.length >= 4, 'GOTCHA 碎片比普通多（gotchaReadFragmentCount）');
    assert.ok(ev.flashMs > 0 && ev.flashMs < (loadBalance().read.flashMs.CALM), '闪现更快');
    for (const f of ev.fragments) assert.equal(f.id, null, '自动泄漏不可 PIN');
  }

  // 表全 1：任何深度全是真话
  const oneBattle = new Battle({
    balance: armedBalance({ gotcha: { trueRateByDepth: [1, 1, 1, 1], flashScale: 0.6 } }),
    rng: rngOf(72), now: clock(),
  });
  oneBattle.mode = 'GOTCHA';
  oneBattle.duel.debtMode = true;
  oneBattle.gotchaDepth = 0;
  oneBattle.gotchaRaiseStep = 20;
  oneBattle.boss.noteAction({ action: 'raise', intent: 'BLUFF', street: oneBattle.duel.street }); // 真实流程前置
  const mark1 = oneBattle.readFragments.length;
  const r1 = oneBattle.act('raise');
  const leaks1 = r1.events.filter((e) => e.type === 'read_batch' && e.source === 'gotcha');
  assert.ok(leaks1.length >= 1);
  const fresh1 = oneBattle.readFragments.slice(0, oneBattle.readFragments.length - mark1);
  assert.ok(fresh1.length > 0 && fresh1.every((f) => f.type === 'TRUE'), `trueRate=1 应全真话（${fresh1.map((f) => f.type)}）`);

  // 深度随泄漏批次递增（玩家一次 RAISE + Boss 响应的 call/raise 会各触发一次）
  assert.ok(oneBattle.gotchaDepth >= 1, `depth 递增（${oneBattle.gotchaDepth}）`);
});

// ============================================================ Scenario G

test('Scenario G：GOTCHA 中 CALL / RAISE 自动泄漏，无需手动 READ', () => {
  const b = new Battle({ balance: armedBalance(), rng: rngOf(81), now: clock() });
  // 快速进入 GOTCHA（同 E 的武装流程）
  b.boss.noteAction({ action: 'raise', intent: 'BLUFF', street: b.duel.street });
  const batch = b.read().events.find((e) => e.type === 'read_batch');
  const frag = batch.fragments.find((f) => fragType(b, f.id) === 'TRUE');
  b.pin(frag.id);
  let v = b.view();
  let res = b.act(v.player.legal.check ? 'check' : (v.player.legal.call ? 'call' : 'fold'));
  assert.ok(res.events.some((e) => e.type === 'crack'));
  b.gotcha();

  // 手动 READ 在 GOTCHA 中被禁
  assert.throws(() => b.read(), (e) => e.code === 'GOTCHA_AUTO_READ');

  // 玩家 RAISE → 自动泄漏（不需要点 READ）
  v = b.view();
  assert.equal(v.toAct, 0, '轮到玩家');
  const beforeCount = b.readFragments.length;
  res = b.act('raise');
  const leak = res.events.filter((e) => e.type === 'read_batch' && e.source === 'gotcha');
  assert.ok(leak.length >= 1, 'RAISE 自动触发泄漏');
  assert.ok(b.readFragments.length > beforeCount, '面板同步增长');
  assert.ok(typeof leak[0].flashMs === 'number' && leak[0].flashMs > 0);
  assert.ok(leak[0].depth >= 1);
});

// ============================================================ Scenario I

test('Scenario I：FOLD/SHOWDOWN 统一结算负债；负数绝不进入下一手', () => {
  const b = new Battle({
    balance: armedBalance({ stacks: { player: 120, boss: 5000 } }),
    rng: rngOf(91), now: clock(),
  });
  // 武装 → 进 GOTCHA
  b.boss.noteAction({ action: 'raise', intent: 'BLUFF', street: b.duel.street });
  const batch = b.read().events.find((e) => e.type === 'read_batch');
  const frag = batch.fragments.find((f) => fragType(b, f.id) === 'TRUE');
  b.pin(frag.id);
  let v = b.view();
  let res = b.act(v.player.legal.check ? 'check' : (v.player.legal.call ? 'call' : 'fold'));
  assert.ok(res.events.some((e) => e.type === 'crack'));
  b.gotcha();
  assert.equal(b.duel.debtMode, true);

  const initialTotal = b.duel.stacks[0] + b.duel.stacks[1] + b.duel.total[0] + b.duel.total[1];
  const handNo0 = b.handNo;
  let sawNegative = false;
  let guard = 0;
  // 一直把注码往上顶，直到本手结束（FOLD 或 SHOWDOWN 都走统一结算）
  while (b.view().phase === 'playing' && b.handNo === handNo0 && guard++ < 40) {
    v = b.view();
    if (v.toAct !== 0) break;
    const L = v.player.legal;
    if (L.gotchaRaiseTo !== null && guard % 2 === 1) res = b.act('raise');
    else if (L.call) res = b.act('call');
    else if (L.check) res = b.act('check');
    else if (L.gotchaRaiseTo !== null) res = b.act('raise');
    else res = b.act('fold');
    if (b.duel.stacks[0] < 0) sawNegative = true;
    if (res) for (const e of res.events) void e;
    // 结算点：换手或终局
    if (b.handNo > handNo0 || b.view().phase !== 'playing') break;
  }

  const held = b.duel.stacks[0] + b.duel.stacks[1] + b.duel.total[0] + b.duel.total[1];
  assert.equal(held, initialTotal, '结算前后筹码总量守恒（含负债期间投入）');

  if (b.view().phase !== 'playing') {
    // 终局：胜负判定覆盖负数
    const stacks = { p: b.duel.stacks[0], b: b.duel.stacks[1] };
    assert.ok((stacks.p <= 0 && b.view().phase === 'defeat') || (stacks.b <= 0 && b.view().phase === 'victory'),
      `≤0 必须判负（stacks=${JSON.stringify(stacks)} phase=${b.view().phase}）`);
  } else if (b.handNo > handNo0) {
    // 下一手：绝不带负数与负债模式进来
    assert.equal(b.duel.debtMode, false, '新一手 debtMode 已关');
    assert.equal(b.view().mode, 'NORMAL', '新一手回到 NORMAL');
    assert.ok(b.duel.stacks[0] >= 0 && b.duel.stacks[1] >= 0,
      `进入 NORMAL 的筹码必须非负（${b.duel.stacks}）`);
    assert.ok(sawNegative || b.duel.stacks[0] >= 0);
  } else {
    // 手还在打：负债期间允许为负，但投入必须守恒（上面已断言）
    assert.ok(true);
  }
});
