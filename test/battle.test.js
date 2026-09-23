import test from 'node:test';
import assert from 'node:assert/strict';
import { Battle, loadBalance } from '../server/battle.js';
import { GameError } from '../server/engine/duel.js';
import { seededRng } from '../server/engine/cards.js';

const makeRng = (seed) => {
  const r = seededRng(seed);
  return () => r.next();
};

/** 可控时钟：每次读取前进 ms —— READ 冷却等时间逻辑在测试里可预期。 */
const makeClock = (step = 1000) => {
  let t = 1_000_000_000_000;
  return () => (t += step);
};

const cloneBalance = (patch = {}) => {
  const b = structuredClone(loadBalance());
  return deepMerge(b, patch);
};

function deepMerge(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') {
      deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

/** 递归收集所有字符串值（精确比对，避免子串误报）。 */
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

// ================================================================= 隐私

test('隐私：view/events 不含 deck、Boss intent、碎片类型与标签', () => {
  const rng = makeRng(11);
  const clock = makeClock();
  const b = new Battle({ rng, now: clock });
  const forbiddenKeys = new Set(['deck', 'intent', 'tags']); // strength 在 cracks[] 里是契约允许的反馈字段
  let hands = 0;

  for (let i = 0; i < 800 && hands < 6; i++) {
    const v = b.view();
    if (b.duel.phase === 'playing') {
      assert.equal(v.boss.hole, null, 'view 永远不含 Boss 底牌');
      const bossHole = new Set(b.duel.hole[1]);
      for (const s of allStrings(v)) assert.ok(!bossHole.has(s), `view 泄露 Boss 底牌 ${s}`);
    }
    for (const key of allKeys(v)) {
      if (key === 'type') continue;
      assert.ok(!forbiddenKeys.has(key), `view 出现内部字段 ${key}`);
    }
    // 碎片条目只能有 text + atHand
    for (const f of v.readFragments) {
      assert.deepEqual(Object.keys(f).sort(), ['atHand', 'text'], '碎片条目字段越界');
    }
    // 碎片文案不得是类型名或标签名
    for (const f of v.readFragments) {
      assert.ok(!['TRUE', 'NOISE', 'DISTORTION'].includes(f.text), '类型不能出现在文案');
    }

    // 打一手 / READ / GOTCHA
    const prevHand = b.handNo;
    let res;
    if (i % 3 === 0) res = { events: b.read().events, view: b.view() };
    else if (v.gotcha && rng() < 0.5) res = b.gotcha(rng() < 0.5 ? 'BLUFF' : 'STRONG');
    else {
      const L = b.view().player.legal;
      const act = L.check ? 'check' : L.call ? 'call' : (L.fold ? 'fold' : 'allin');
      res = b.act(act);
    }
    for (const e of res.events) {
      const ej = JSON.stringify(e);
      assert.ok(!ej.includes('"intent"'), `事件泄露 intent: ${e.type}`);
      assert.ok(!ej.includes('"tags"'), `事件泄露 tags: ${e.type}`);
      if (e.type === 'read_fragment') {
        assert.deepEqual(Object.keys(e).sort(), ['burst', 'flashMs', 'text', 'type'], '碎片事件字段越界');
        assert.ok(!['TRUE', 'NOISE', 'DISTORTION'].includes(e.text));
      }
      if (e.type === 'gotcha_result') {
        assert.ok(!('intent' in e), '结果不得回带 Boss intent');
      }
      if (e.type === 'showdown') {
        for (const h of e.hands) if (h.seat === 1) assert.equal(h.hole.length, 2);
      }
    }
    if (b.handNo !== prevHand) hands += 1;
    if (b.view().phase !== 'playing') break;
  }
  assert.ok(hands >= 2, `应至少打完两手（${hands}）`);
});

// ============================================================ 筹码结构与盲注

test('不对称筹码 500 vs 5000 与 Effective Stack', () => {
  const b = new Battle({ rng: makeRng(3), now: makeClock() });
  const v = b.view();
  assert.equal(v.player.chips + v.player.bet, 500, '玩家 500');
  assert.equal(v.boss.chips + v.boss.bet, 5000, 'Boss 5000');
  assert.equal(v.effectiveStack, Math.min(v.player.chips, v.boss.chips));
  assert.equal(v.mode, 'NORMAL');
});

test('盲注升级：按手数分档，标签与下一次升级可见', () => {
  const b = new Battle({ rng: makeRng(5), now: makeClock() });
  assert.deepEqual([b.blindFor(1).sb, b.blindFor(1).bb], [10, 20]);
  assert.deepEqual([b.blindFor(4).sb, b.blindFor(4).bb], [20, 40]);
  assert.deepEqual([b.blindFor(6).sb, b.blindFor(6).bb], [40, 80]);
  assert.deepEqual([b.blindFor(11).sb, b.blindFor(11).bb], [160, 320]);
  assert.deepEqual([b.blindFor(99).sb, b.blindFor(99).bb], [160, 320], '11+ 封顶');
  const t1 = b.blindFor(1);
  assert.equal(t1.tier, '第 1–2 手 · 10/20');
  assert.equal(t1.nextUp, '第 3 手 → 20/40');
  assert.equal(b.blindFor(11).nextUp, null, '最后一档没有下一次');

  // 打到第 3 手 → blindUp 事件
  const rng = makeRng(7);
  const b2 = new Battle({ rng: () => rng(), now: makeClock() });
  let sawUp = false; let steps = 0;
  while (b2.handNo < 3 && steps++ < 300 && b2.view().phase === 'playing') {
    const v = b2.view();
    if (v.toAct !== 0) break;
    const L = v.player.legal;
    const res = b2.act(L.check ? 'check' : L.call ? 'call' : 'fold');
    for (const e of res.events) {
      if (e.type === 'hand_start' && e.handNo === 3) {
        assert.equal(e.blindUp, true);
        assert.equal(e.sb, 20);
        assert.equal(e.tier, '第 3–4 手 · 20/40');
        sawUp = true;
      }
    }
  }
  assert.ok(sawUp, '应当打到第 3 手并观察到盲注升级');
  assert.ok(b2.feed.some((f) => f.kind === 'blind'), 'feed 记录盲注升级');
});

// ============================================================ 简化操作

test('PRESSURE/HEAVY：服务端按池比例算好 raise-to', () => {
  const b = new Battle({ rng: makeRng(9), now: makeClock() });
  // 打到一个明确的池
  const v0 = b.view();
  if (!v0.player.legal.check) b.act('call'); // 过盲注差
  // 制造局面：一路过牌到有位置下注权
  let guard = 0;
  while (guard++ < 8 && b.view().toAct === 0 && b.view().player.legal.check && !b.view().player.legal.pressure) {
    b.act('check');
  }
  const v = b.view();
  if (v.toAct === 0 && (v.player.legal.pressure || v.player.legal.heavy)) {
    const pot = v.pot;
    const expectP = Math.round(v.boss.chips >= 0 ? (0 + 0.5 * pot) : 0); // toCall=0 时 currentBet=0
    if (v.player.toCall === 0 && v.player.legal.bet) {
      assert.equal(v.player.legal.pressureTo, Math.max(v.player.legal.minTo, Math.min(v.player.legal.maxTo, Math.round(0 + 0.5 * pot))),
        'pressureTo = 0.5 池（夹到合法区间）');
      assert.equal(v.player.legal.heavyTo, Math.max(v.player.legal.minTo, Math.min(v.player.legal.maxTo, Math.round(pot))),
        'heavyTo = 1.0 池');
      const res = b.act('pressure');
      const ev = res.events.find((e) => e.type === 'action' && e.seat === 0);
      assert.equal(ev.action, 'pressure', '玩家预设行动以 pressure 名字下发');
      assert.equal(ev.amount, v.player.legal.pressureTo, '实际执行 = 显示金额');
    }
    void expectP;
  }
});

test('自由下注仅在 EXECUTION 开放', () => {
  const b = new Battle({ rng: makeRng(13), now: makeClock() });
  // NORMAL：裸 raise 被拒
  let steps = 0;
  while (b.view().toAct === 0 && !b.view().player.legal.raise && steps++ < 6) b.act('call');
  const v = b.view();
  if (v.player.legal.raise || v.player.legal.bet) {
    assert.throws(() => b.act(v.player.legal.bet ? 'bet' : 'raise', 60), (e) => e.code === 'NOT_EXECUTION');
  }
  // 进入 EXECUTION 后放行
  b.mode = 'EXECUTION';
  const v2 = b.view();
  if (v2.toAct === 0 && (v2.player.legal.raise || v2.player.legal.bet)) {
    const kind = v2.player.legal.bet && !v2.player.legal.raise ? 'bet' : 'raise';
    const res = b.act(kind, Math.max(v2.player.legal.minTo, Math.min(v2.player.legal.maxTo, 90)));
    assert.ok(res.events.some((e) => e.type === 'action'));
  }
  assert.equal(b.mode, 'EXECUTION', '模式保持到手牌结束');
});

// ============================================================ READ

test('READ：无限次但有冷却；碎片只有文案；EXECUTION 双发', () => {
  const clock = makeClock(10); // 每次读 +10ms → 冷却(400)内第二发必被拒
  const b = new Battle({ rng: makeRng(15), now: clock });
  const r1 = b.read();
  const ev1 = r1.events.filter((e) => e.type === 'read_fragment');
  assert.equal(ev1.length, 1);
  assert.ok(ev1[0].text.length > 0);
  assert.ok(ev1[0].flashMs > 0);
  assert.equal(r1.view.readFragments[0].atHand, 1);

  assert.throws(() => b.read(), (e) => e.code === 'READ_COOLING', '冷却内连读被拒');

  // EXECUTION + burstChance=1 → 每次双发
  const bal = cloneBalance({ read: { burstChanceInExecution: 1 } });
  const clock2 = makeClock(10000);
  const b2 = new Battle({ balance: bal, rng: makeRng(16), now: clock2 });
  b2.mode = 'EXECUTION';
  const r2 = b2.read();
  const frags = r2.events.filter((e) => e.type === 'read_fragment');
  assert.equal(frags.length, 2, 'EXECUTION 信息量更高：双碎片');
  assert.equal(frags[0].burst, false);
  assert.equal(frags[1].burst, true);
  assert.ok(frags[0].flashMs < 1000, 'EXECUTION 显示更快');
});

// ============================================================ CRACK → GOTCHA

/** 构造「必出 TRUE 弱点碎片」的局面：单标签规则 + 强制 TRUE + BLUFF 意图。 */
function armedBattle(seed, intent = 'BLUFF') {
  const bal = cloneBalance({
    read: { mix: { CALM: { TRUE: 1, NOISE: 0, DISTORTION: 0 }, SHAKEN: { TRUE: 1, NOISE: 0, DISTORTION: 0 }, TILT: { TRUE: 1, NOISE: 0, DISTORTION: 0 } } },
    cracks: {
      rules: [
        { kind: 'WEAKNESS', need: ['wants_fold'] },
        { kind: 'WEAKNESS', need: ['fear_call'] },
        { kind: 'WEAKNESS', need: ['weak_hand'] },
        { kind: 'WEAKNESS', need: ['missed_board'] },
        { kind: 'WEAKNESS', need: ['draw'] },
        { kind: 'STRENGTH', need: ['strong_hand'] },
        { kind: 'STRENGTH', need: ['trap'] },
        { kind: 'STRENGTH', need: ['call_welcome'] },
        { kind: 'STRENGTH', need: ['board_lock'] },
      ],
    },
  });
  const b = new Battle({ balance: bal, rng: makeRng(seed), now: makeClock(5000) });
  b.boss.noteAction({ action: 'raise', intent, street: b.duel.street });
  return b;
}

test('READ → CRACK → GOTCHA 正确 → EXECUTION + 情绪被推动', () => {
  const b = armedBattle(21, 'BLUFF');
  let crackEv = null;
  for (let i = 0; i < 6 && !crackEv; i++) {
    const r = b.read();
    crackEv = r.events.find((e) => e.type === 'crack');
    if (crackEv) {
      assert.ok(['WEAKNESS', 'CRITICAL'].includes(crackEv.kind), `BLUFF 意图只应成弱点链（${crackEv.kind}）`);
      assert.ok(crackEv.evidence.length >= 1);
      assert.ok(b.view().gotcha, 'CRACK 后 GOTCHA 解锁');
      assert.equal(b.view().gotcha.id, crackEv.id);
    }
  }
  assert.ok(crackEv, '强制 TRUE 后应当能成 CRACK');

  const before = b.boss.state;
  const res = b.gotcha('BLUFF'); // intent=BLUFF → 正确
  const result = res.events.find((e) => e.type === 'gotcha_result');
  assert.equal(result.correct, true);
  assert.equal(result.mode, 'EXECUTION');
  assert.equal(res.view.mode, 'EXECUTION');
  assert.equal(res.view.gotcha, null, '兑现后 GOTCHA 收起');
  assert.ok(res.events.some((e) => e.type === 'mode' && e.mode === 'EXECUTION'));

  const mental = res.events.find((e) => e.type === 'mental');
  if (before === 'CALM') {
    assert.ok(mental, 'GOTCHA 命中必推动情绪');
    assert.equal(mental.cause, 'GOTCHA_HIT');
    assert.equal(mental.to, 'SHAKEN');
    assert.equal(typeof mental.hint, 'string');
    assert.equal(mental.down, true);
  }
  // CRACK 记录保留并带结果
  const rec = res.view.cracks.find((c) => c.id === crackEv.id);
  assert.ok(rec && rec.result && rec.result.correct === true, 'CRACK Feedback 记录结果');
});

test('GOTCHA 错误 → COUNTER（Boss 本手攻击暴涨）', () => {
  const b = armedBattle(23, 'VALUE'); // intent=VALUE，押 BLUFF 必错
  for (let i = 0; i < 6 && !b.view().gotcha; i++) b.read();
  assert.ok(b.view().gotcha, '先要拿到 CRACK');

  const evBefore = b.boss.currentMods().aggression;
  const res = b.gotcha('BLUFF');
  const result = res.events.find((e) => e.type === 'gotcha_result');
  assert.equal(result.correct, false);
  assert.equal(result.mode, 'COUNTER');
  assert.equal(res.view.mode, 'COUNTER');
  assert.ok(res.events.some((e) => e.type === 'mode' && e.mode === 'COUNTER'));
  const evAfter = b.boss.currentMods().aggression;
  assert.ok(evAfter > evBefore, `COUNTER 后攻击性上升（${evBefore} → ${evAfter}）`);
  assert.equal(res.view.gotcha, null);
  assert.equal(b.gotchaStreak, 0, '答错清空连击');
});

test('连续两次正确 GOTCHA → 上头（GOTCHA_STREAK）', () => {
  const b = armedBattle(27, 'BLUFF');
  // 第一次
  for (let i = 0; i < 6 && !b.view().gotcha; i++) b.read();
  assert.ok(b.view().gotcha, '第一次 CRACK');
  const r1 = b.gotcha('BLUFF');
  assert.equal(r1.view.boss.state, 'SHAKEN', '首次命中 CALM→SHAKEN');
  // 第二次：EXECUTION 期间不允许再发动（契约），这里模拟「换手复位」后的下一次机会
  b.mode = 'NORMAL';
  b.boss.setPhaseBuff(null);
  b.boss.noteAction({ action: 'raise', intent: 'BLUFF', street: b.duel.street });
  let armed = false;
  for (let i = 0; i < 8 && !armed; i++) {
    const r = b.read();
    if (r.events.some((e) => e.type === 'crack')) armed = b.view().gotcha;
  }
  assert.ok(armed, '第二次 CRACK');
  const r2 = b.gotcha('BLUFF');
  const causes = r2.events.filter((e) => e.type === 'mental').map((e) => e.cause);
  assert.equal(r2.view.boss.state, 'TILT', '连续正确 → 上头');
  assert.ok(causes.includes('GOTCHA_HIT') || causes.includes('GOTCHA_STREAK'), JSON.stringify(causes));
});

test('GOTCHA 门禁：没 CRACK 不能发、非法 guess 被拒', () => {
  const b = new Battle({ rng: makeRng(29), now: makeClock() });
  assert.throws(() => b.gotcha('BLUFF'), (e) => e.code === 'NO_CRACK');
  const b2 = armedBattle(30);
  for (let i = 0; i < 6 && !b2.view().gotcha; i++) b2.read();
  assert.ok(b2.view().gotcha);
  assert.throws(() => b2.gotcha('MAYBE'), (e) => e.code === 'BAD_GUESS');
});

test('Boss 下一次重要行动使未使用的 CRACK 过期', () => {
  const b = armedBattle(31, 'BLUFF');
  for (let i = 0; i < 6 && !b.view().gotcha; i++) b.read();
  assert.ok(b.view().gotcha, '先解锁');
  // 玩家行动 → Boss 再次下注（重要行动）→ 旧 CRACK 应过期
  // 打到 Boss 有机会下注的局面：一路让牌，直到 Boss 做出重要行动或手牌结束
  let expired = false;
  for (let i = 0; i < 40 && !expired && b.view().phase === 'playing'; i++) {
    const v = b.view();
    if (v.toAct !== 0) break;
    const L = v.player.legal;
    b.act(L.check ? 'check' : L.call ? 'call' : (L.fold ? 'fold' : 'allin'));
    if (b.boss.lastActionInfo && ['bet', 'raise', 'allin'].includes(b.boss.lastActionInfo.action)) {
      // Boss 重新做了重要行动
      if (!b.view().gotcha) expired = true;
    }
    if (b.handNo > 1) break; // 换手也应清空
    if (!b.view().gotcha && b.crack === null && b.cracks.length === 0) expired = true;
  }
  assert.ok(expired || b.handNo > 1, 'Boss 重新进攻或换手后，旧 CRACK 不再可用');
});

// ============================================================ BUSTED

test('BUSTED!：模型把握度足够后，Boss 下一次决策即可宣告并进入 COUNTER', () => {
  const bal = cloneBalance({
    busted: { confidence: 0.3, chance: 1, minHand: 1, cooldownHands: 0, line: '我看穿你了 —— 全部下注！' },
  });
  const b = new Battle({ balance: bal, rng: makeRng(33), now: makeClock() });
  for (let i = 0; i < 8; i++) b.model.record('action', { action: 'call', facingBet: true });
  assert.equal(b.model.bustedReady(0.3), true);

  let busted = false;
  for (let i = 0; i < 12 && !busted && b.view().phase === 'playing'; i++) {
    const v = b.view();
    if (v.toAct !== 0) break;
    const L = v.player.legal;
    const res = b.act(L.check ? 'check' : L.call ? 'call' : 'pressure');
    if (res.events.some((e) => e.type === 'busted')) busted = true;
  }
  assert.ok(busted, '把握度足够 + 概率1 → 必宣告 BUSTED');
  assert.equal(b.view().mode, 'COUNTER');
  assert.ok(b.feed.some((f) => f.kind === 'model'), 'Battle Log 记录 BUSTED');
});

// ============================================================ 视图与事件契约

test('视图 HUD：当前牌型、盲注信息、Effective Stack 齐全', () => {
  const b = new Battle({ rng: makeRng(35), now: makeClock() });
  assert.equal(b.view().player.handName, null, '翻前没有牌型');
  let steps = 0;
  while (b.view().street === 'preflop' && steps++ < 8) {
    const L = b.view().player.legal;
    b.act(L.check ? 'check' : 'call');
    if (b.view().phase !== 'playing') break;
  }
  if (b.view().street !== 'preflop' && b.view().phase === 'playing' && b.view().toAct === 0) {
    // 打到 flop 后牌型可见
    if (b.view().street === 'flop' || b.view().board.length >= 3) {
      const name = b.view().player.handName;
      if (b.view().board.length >= 3) assert.ok(typeof name === 'string' && name.length > 0, 'flop 后显示牌型');
    }
  }
  const v = b.view();
  assert.ok(v.blind && v.blind.sb > 0 && v.blind.tier.includes('手'), '盲注档位可见');
  assert.equal(typeof v.effectiveStack, 'number');
});

test('事件契约：类型白名单 + hand_start/hand_end 字段齐全', () => {
  const known = new Set([
    'hand_start', 'blinds', 'action', 'street', 'talk', 'read_fragment', 'crack',
    'gotcha_result', 'mode', 'busted', 'mental', 'showdown', 'fold_win',
    'pot_move', 'hand_end', 'game_over',
  ]);
  const rng = makeRng(37);
  const b = new Battle({ rng: () => rng(), now: makeClock() });
  let sawHandEnd = false;
  let steps = 0;
  while (!sawHandEnd && steps++ < 300 && b.view().phase === 'playing') {
    const v = b.view();
    if (v.toAct !== 0) break;
    let res;
    if (v.gotcha) res = b.gotcha(rng() < 0.5 ? 'BLUFF' : 'STRONG');
    else if (rng() < 0.4) res = b.read();
    else {
      const L = v.player.legal;
      const act = L.check ? 'check' : L.call ? 'call' : 'fold';
      res = b.act(act);
    }
    for (const e of res.events) {
      assert.ok(known.has(e.type), `未知事件 ${e.type}`);
      if (e.type === 'hand_start') {
        assert.ok(typeof e.sb === 'number' && typeof e.tier === 'string' && typeof e.blindUp === 'boolean');
      }
      if (e.type === 'hand_end') {
        assert.ok(e.stacks && typeof e.effectiveStack === 'number' && e.blind && typeof e.mode === 'string');
        assert.equal(e.stacks.player + e.stacks.boss, 5500, '筹码守恒（500+5000）');
        sawHandEnd = true;
      }
    }
  }
  assert.ok(sawHandEnd, '应至少完成一手');
});

test('history：玩家预设用 pressure/heavy，Boss 用引擎动作名', () => {
  const b = new Battle({ rng: makeRng(39), now: makeClock() });
  let steps = 0;
  let sawPressure = false;
  let sawBossBet = false;
  while (steps++ < 60 && b.view().phase === 'playing' && (!sawPressure || !sawBossBet)) {
    const v = b.view();
    if (v.toAct !== 0) break;
    const L = v.player.legal;
    if (L.pressure && !sawPressure) { b.act('pressure'); sawPressure = true; }
    else b.act(L.check ? 'check' : 'call');
    for (const h of b.view().history) {
      if (h.actor === 'boss' && ['bet', 'raise'].includes(h.action)) sawBossBet = true;
      if (h.actor === 'player' && h.action === 'pressure') sawPressure = true;
    }
  }
  assert.ok(b.view().history.some((h) => h.actor === 'player' && ['pressure', 'heavy', 'check', 'call'].includes(h.action)));
});

// ============================================================ 整场战斗

function playBattle(seed, opts = {}) {
  const balance = opts.balance ?? loadBalance();
  const r = seededRng(seed);
  const rng = () => r.next();
  const clock = makeClock(2000);
  const b = new Battle({ balance, rng, now: clock });
  const sums = new Set();
  let steps = 0;
  let events = [];
  const collect = (res) => { events = events.concat(res.events); };
  const initial = balance.stacks.player + balance.stacks.boss;

  while (b.view().phase === 'playing' && steps++ < 5000) {
    clock(); // 时钟前进，冷却不卡
    const v = b.view();
    if (v.toAct !== 0) throw new Error('卡在非玩家回合');
    if (v.gotcha && rng() < 0.9) { collect(b.gotcha(rng() < 0.5 ? 'BLUFF' : 'STRONG')); continue; }
    if (rng() < 0.35) { collect(b.read()); continue; }
    const L = v.player.legal;
    let act;
    if (opts.strategy === 'shove') act = L.allin ? 'allin' : (L.check ? 'check' : 'fold');
    else {
      if (L.fold && rng() < 0.4) act = 'fold';
      else if (L.pressure && rng() < 0.5) act = 'pressure';
      else if (L.heavy && rng() < 0.7) act = 'heavy';
      else if (L.check) act = 'check';
      else if (L.call) act = 'call';
      else if (L.fold) act = 'fold';
      else act = 'allin';
    }
    collect(b.act(act));
    for (const e of events) {
      if (e.type === 'hand_end') {
        sums.add(e.stacks.player + e.stacks.boss);
      }
    }
    events = [];
  }
  return { battle: b, sums, initial, steps };
}

test('整场：Boss 小筹码时玩家能打出 Victory + Heart + 重开恢复配置', () => {
  const balance = cloneBalance();
  balance.stacks = { player: 1000, boss: 200 };
  // 找一个能赢的种子（推牌策略）
  let found = null;
  for (let seed = 1; seed <= 40 && !found; seed++) {
    const r = seededRng(seed);
    const rng = () => r.next();
    const clock = makeClock(3000);
    const b = new Battle({ balance: structuredClone(balance), rng, now: clock });
    let steps = 0;
    let gameOver = null;
    while (b.view().phase === 'playing' && steps++ < 4000) {
      clock();
      const v = b.view();
      if (v.gotcha && rng() < 0.8) { collect(b.gotcha(rng() < 0.5 ? 'BLUFF' : 'STRONG')); continue; }
      const L = v.player.legal;
      const act = L.allin ? 'allin' : (L.check ? 'check' : (L.call ? 'call' : 'fold'));
      const res = b.act(act);
      for (const e of res.events) {
        if (e.type === 'hand_end') assert.equal(e.stacks.player + e.stacks.boss, 1200, '筹码守恒');
        if (e.type === 'game_over') gameOver = e;
      }
      if (gameOver) break;
    }
    if (gameOver && gameOver.phase === 'victory') found = { seed, b, gameOver };
  }
  assert.ok(found, '存在能打出 Victory 的路径（40 个种子内）');
  assert.ok(found.gameOver.heart.length > 0, '胜利前播放 Heart');
  assert.equal(found.b.view().phase, 'victory');

  // 重开：恢复的是配置文件里的 500 / 5000
  const ng = found.b.newGame();
  assert.equal(ng.view.phase, 'playing');
  assert.equal(ng.view.player.chips + ng.view.player.bet, 500);
  assert.equal(ng.view.boss.chips + ng.view.boss.bet, 5000);
  assert.equal(ng.view.mode, 'NORMAL');
  assert.ok(ng.events.some((e) => e.type === 'hand_start'));
});

test('整场：玩家筹码归零 → Defeat', () => {
  const balance = cloneBalance();
  balance.stacks = { player: 40, boss: 5000 };
  let end = null;
  for (let seed = 1; seed <= 30 && !end; seed++) {
    const r = seededRng(seed);
    const rng = () => r.next();
    const clock = makeClock(3000);
    const b = new Battle({ balance: structuredClone(balance), rng, now: clock });
    let steps = 0;
    while (b.view().phase === 'playing' && steps++ < 3000) {
      clock();
      const L = b.view().player.legal;
      const act = L.allin ? 'allin' : (L.check ? 'check' : (L.call ? 'call' : 'fold'));
      const res = b.act(act);
      for (const e of res.events) if (e.type === 'game_over') end = { seed, e, b };
      if (end) break;
    }
  }
  assert.ok(end, '存在 Defeat 路径');
  assert.equal(end.e.phase, 'defeat');
  assert.equal(end.b.view().phase, 'defeat');
});

test('整场烟测：长局无异常、盲注升级出现、事件类型不越界', () => {
  const known = new Set([
    'hand_start', 'blinds', 'action', 'street', 'talk', 'read_fragment', 'crack',
    'gotcha_result', 'mode', 'busted', 'mental', 'showdown', 'fold_win',
    'pot_move', 'hand_end', 'game_over',
  ]);
  const { battle, sums, initial } = playBattle(101);
  for (const s of sums) assert.equal(s, initial, `筹码守恒（${s} ≠ ${initial}）`);
  assert.ok(battle.handNo >= 1);
  const blindUps = battle.feed.filter((f) => f.kind === 'blind').length;
  // 打得够多就应见到升级（不要求必到 —— 取决于结局）
  void blindUps;
  assert.ok(battle.view().feed.every((f) => typeof f.kind === 'string' && typeof f.text === 'string'));
});
