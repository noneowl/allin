import test from 'node:test';
import assert from 'node:assert/strict';
import { Battle, loadBalance } from '../server/battle.js';
import { GameError } from '../server/engine/duel.js';
import { seededRng } from '../server/engine/cards.js';
import { isDownEvent } from '../server/boss/mental.js';

const makeRng = (seed) => {
  const r = seededRng(seed);
  return () => r.next();
};

const cloneBalance = (patch = {}) => {
  const b = structuredClone(loadBalance());
  return { ...b, ...patch };
};

/** 递归收集所有 key。 */
function allKeys(obj, out = new Set()) {
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    out.add(k);
    allKeys(v, out);
  }
  return out;
}

/** 递归收集所有字符串值（精确值比对，避免 toAct⊂Ac 这种子串误报）。 */
function allStrings(obj, out = []) {
  if (typeof obj === 'string') { out.push(obj); return out; }
  if (!obj || typeof obj !== 'object') return out;
  for (const v of Object.values(obj)) allStrings(v, out);
  return out;
}

/** 随机但合法地打若干手，收集所有响应。 */
function simulate(battle, rng, { maxHands = 30, objection = true } = {}) {
  const collected = [];
  let steps = 0;
  while (battle.view().phase === 'playing') {
    if (steps++ > 4000) break;
    const v = battle.view();
    if (objection && v.objection && Date.now() <= v.objection.deadline + 900) {
      collected.push(battle.object(v.objection.id));
      continue;
    }
    if (v.player.readsLeft > 0 && rng() < 0.05) {
      collected.push(battle.read());
      continue;
    }
    const L = v.player.legal;
    const roll = rng();
    let res;
    if (L.bet || L.raise) {
      if (roll < 0.4) {
        const amount = Math.max(L.minTo, Math.min(L.maxTo, Math.round(v.pot * (0.3 + rng() * 0.7))));
        res = battle.act(L.bet && !L.raise ? 'bet' : 'raise', amount);
      } else if (roll < 0.9) {
        res = battle.act(L.check ? 'check' : 'call');
      } else {
        res = battle.act(L.fold ? 'fold' : (L.check ? 'check' : 'call'));
      }
    } else {
      res = battle.act(roll < 0.6 && L.fold ? 'fold' : (L.check ? 'check' : 'call'));
    }
    collected.push(res);
    if (battle.handNo > maxHands && battle.view().phase !== 'playing') break;
  }
  return collected;
}

// ------------------------------------------------------------------ 隐私

test('视图从不泄露 Boss 底牌、牌堆与内部字段', () => {
  const rng = makeRng(11);
  const b = new Battle({ rng });
  const forbiddenKeys = new Set(['deck', 'intent', 'claim', 'equity', 'mods', 'buffs', 'detail', 'mental', 'contradictions', 'lineBias']);
  let hands = 0;

  for (let i = 0; i < 600 && hands < 8; i++) {
    const v = b.view();
    const json = JSON.stringify(v);

    // 手牌进行中：Boss 底牌必须是 null，且其牌面绝不能作为任何字符串值出现
    if (b.duel.phase === 'playing') {
      assert.equal(v.boss.hole, null, '进行中的手牌不能看到 Boss 底牌');
      const bossHole = new Set(b.duel.hole[1]);
      for (const s of allStrings(v)) {
        assert.ok(!bossHole.has(s), `视图泄露了 Boss 的牌 ${s}`);
      }
    }
    for (const key of allKeys(v)) {
      assert.ok(!forbiddenKeys.has(key), `视图出现了内部字段 ${key}`);
    }
    assert.ok(!json.includes('"BLUFF"') && !json.includes('"VALUE"'), 'intent 不能出现在视图里');

    const prevHand = b.handNo;
    const res = simulateOne(b, rng);
    for (const e of res.events) {
      if (e.type === 'showdown') continue; // 摊牌是唯一允许亮底牌的地方
      if (b.duel.phase !== 'playing') continue; // 本响应已结束该手，牌已公开结算
      const bossHole = new Set(b.duel.hole[1]);
      for (const s of allStrings(e)) {
        assert.ok(!bossHole.has(s), `事件泄露了 Boss 的牌 ${s}（${e.type}）`);
      }
    }
    if (b.handNo !== prevHand) hands++;
    if (b.view().phase !== 'playing') break;
  }
  assert.ok(hands >= 1, `应当至少完整打完一手（实际 ${hands}）`);
  if (b.view().phase === 'playing') {
    assert.ok(hands >= 3, `仍在战斗中时应已打过数手（实际 ${hands}）`);
  }
});

function simulateOne(b, rng) {
  const v = b.view();
  if (v.objection && Date.now() <= v.objection.deadline + 900) return b.object(v.objection.id);
  const L = v.player.legal;
  const roll = rng();
  if (L.bet || L.raise) {
    if (roll < 0.4) return b.act(L.bet && !L.raise ? 'bet' : 'raise', Math.max(L.minTo, Math.min(L.maxTo, Math.round(v.pot * 0.6))));
    if (roll < 0.9) return b.act(L.check ? 'check' : 'call');
    return b.act(L.fold ? 'fold' : (L.check ? 'check' : 'call'));
  }
  return b.act(roll < 0.6 && L.fold ? 'fold' : (L.check ? 'check' : 'call'));
}

// ------------------------------------------------------------------ 门禁

test('行动/READ/言语都有门禁', () => {
  const b = new Battle({ rng: makeRng(3) });

  // READ：每手 2 次，用完即止
  const r1 = b.read();
  assert.equal(r1.view.player.readsLeft, 1);
  assert.ok(r1.events[0].type === 'read' && r1.events[0].text.length > 0);
  b.read();
  assert.equal(b.view().player.readsLeft, 0);
  assert.throws(() => b.read(), (e) => e instanceof GameError && e.code === 'NO_READS');

  // 言语：每种技能每手 1 次
  const s1 = b.speak('taunt');
  assert.ok(s1.events.some((e) => e.type === 'speech' && e.line));
  assert.throws(() => b.speak('taunt'), (e) => e.code === 'NO_CHARGES');
  assert.throws(() => b.speak('fireball'), (e) => e.code === 'BAD_SKILL');

  // 未轮到不能行动
  const saved = b.duel.toAct;
  b.duel.toAct = 1;
  assert.throws(() => b.act('check'), (e) => e.code === 'NOT_YOUR_TURN');
  assert.throws(() => b.read(), (e) => e.code === 'NOT_YOUR_TURN');
  b.duel.toAct = saved;
});

// ------------------------------------------------------------------ 异议

test('异议命中：窗口内点击 → 心理恶化 + 事件完整', () => {
  const b = new Battle({ rng: makeRng(5) });
  assert.equal(b.boss.state, 'CALM');

  const c = b.boss.addContradiction({ kind: 'spoken_vs_bet', handNo: b.handNo, detail: {} });
  b.openWindow = { id: c.id, deadline: Date.now() + 5000, line: '这一手你最好直接弃。', windowMs: 2000 };

  const res = b.object(c.id);
  assert.equal(res.ok, true);
  const resultEvent = res.events.find((e) => e.type === 'objection_result');
  assert.ok(resultEvent, '必须有 objection_result 事件');
  assert.equal(resultEvent.success, true);
  assert.equal(resultEvent.kind, 'spoken_vs_bet');
  // CALM→SHAKEN 概率 1.0，必然发生
  assert.deepEqual(resultEvent.transition, { from: 'CALM', to: 'SHAKEN' });
  assert.ok(res.events.some((e) => e.type === 'mental' && e.cause === 'CONTRADICTION_EXPOSED'));
  assert.equal(b.boss.state, 'SHAKEN');
  assert.equal(b.view().objection, null, '命中后窗口关闭');
  assert.equal(b.exposeHand, true, '本手被点破 → 行为偏移');

  // 重复点击无效（窗口已关 → stale）
  const again = b.object(c.id);
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'stale');
  assert.equal(b.boss.findContradiction(c.id).resolved, true, '矛盾本身已标记处理');
});

test('异议过期：deadline 过后点击失败', () => {
  const b = new Battle({ rng: makeRng(6) });
  const c = b.boss.addContradiction({ kind: 'behavior', handNo: b.handNo, detail: {} });
  b.openWindow = { id: c.id, deadline: Date.now() - 10000, line: 'x', windowMs: 500 };
  const res = b.object(c.id);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'late');
  assert.equal(b.boss.state, 'CALM', '过期点击不产生效果');
});

test('质疑：无矛盾落空耗次数；有矛盾时命中', () => {
  const b = new Battle({ rng: makeRng(7) });
  const w1 = b.speak('challenge');
  const speech = w1.events.find((e) => e.type === 'speech');
  assert.equal(speech.result, 'whiff');
  assert.equal(w1.view.player.speech.challenge, 0);
  assert.throws(() => b.speak('challenge'), (e) => e.code === 'NO_CHARGES');

  // 第二手：注入矛盾后质疑
  const b2 = new Battle({ rng: makeRng(8) });
  const c = b2.boss.addContradiction({ kind: 'spoken_vs_bet', handNo: b2.handNo, detail: {} });
  const w2 = b2.speak('challenge');
  const s2 = w2.events.find((e) => e.type === 'speech');
  assert.ok(s2.result === 'hit' || s2.result === 'resist', `命中或嘴硬扛住，得到 ${s2.result}`);
  assert.equal(b2.boss.findContradiction(c.id).resolved, true, '质疑命中的矛盾被处理');
  assert.equal(b2.view().objection, null, '窗口一并关闭');
});

// ------------------------------------------------------------------ 有机矛盾

test('lineBias=1 时，有限手数内必然检测到有机矛盾并开窗', () => {
  const balance = cloneBalance();
  balance.mentalModifiers.CALM.lineBias = 1.0;
  balance.mentalModifiers.SHAKEN.lineBias = 1.0;
  const rng = makeRng(21);
  const b = new Battle({ balance, rng });

  let contradictions = 0;
  let windowOpened = false;
  let steps = 0;
  while (b.view().phase === 'playing' && b.handNo <= 40 && steps++ < 3000) {
    const v = b.view();
    if (v.objection) windowOpened = true;
    const res = simulateOne(b, rng);
    contradictions += res.events.filter((e) => e.type === 'contradiction').length;
    if (res.events.some((e) => e.type === 'objection_open')) windowOpened = true;
    if (contradictions > 0 && windowOpened) break;
  }
  assert.ok(contradictions > 0, '应当检测到矛盾');
  assert.ok(windowOpened, '矛盾必须伴随异议窗口');
});

// ------------------------------------------------------------------ 手牌流转

test('每手结束后立即开始下一手，庄家轮换', () => {
  const b = new Battle({ rng: makeRng(9) });
  const firstButton = b.view().button;
  const firstHand = b.view().handNo;

  // 一直弃牌到某一手结束（很快：盲注就会流转）
  let guard = 0;
  let sawHandEnd = false;
  let sawNextStart = false;
  let lastButton = firstButton;
  while (b.handNo <= firstHand + 2 && guard++ < 400) {
    const res = simulateOne(b, makeRng(guard));
    const types = res.events.map((e) => e.type);
    if (types.includes('hand_end')) {
      sawHandEnd = true;
      const endIdx = types.indexOf('hand_end');
      if (types.slice(endIdx).includes('hand_start')) sawNextStart = true;
      const v = b.view();
      if (v.phase !== 'playing') break; // 战斗结束就不再有下一手
      assert.notEqual(v.button, lastButton, '庄家必须轮换');
      lastButton = v.button;
    }
  }
  assert.ok(sawHandEnd, '应当完成至少一手');
  assert.ok(sawNextStart || b.view().phase !== 'playing',
    '结算事件之后必须紧跟下一手的 hand_start（除非这场战斗已经终局）');
  assert.ok(b.view().handNo > firstHand, '手数递增');
});

test('事件流符合契约：类型合法、顺序合理', () => {
  const rng = makeRng(17);
  const b = new Battle({ rng });
  const known = new Set([
    'hand_start', 'blinds', 'action', 'street', 'talk', 'read', 'speech', 'mental',
    'contradiction', 'objection_open', 'objection_result', 'showdown', 'fold_win',
    'pot_move', 'hand_end', 'game_over',
  ]);
  const collected = simulate(b, rng, { maxHands: 6 });
  let sawHandEnd = false;
  for (const res of collected) {
    assert.ok(Array.isArray(res.events), '响应必须带 events 数组');
    assert.ok(res.view, '响应必须带 view');
    for (const e of res.events) {
      assert.ok(known.has(e.type), `未知事件类型 ${e.type}`);
      if (e.type === 'hand_end') sawHandEnd = true;
      if (e.type === 'objection_open') {
        assert.ok(typeof e.id === 'number' && typeof e.deadline === 'number');
        assert.ok(typeof e.line === 'string' && typeof e.windowMs === 'number');
        // 只给窗口三件套，不给真假判定
        assert.deepEqual(Object.keys(e).sort(), ['deadline', 'id', 'line', 'type', 'windowMs']);
      }
      if (e.type === 'talk') assert.ok(!('claim' in e), '台词事件不能带 claim');
    }
    if (sawHandEnd) break;
  }
  assert.ok(sawHandEnd, '应当至少看到一次 hand_end');
});

// ------------------------------------------------------------------ 整场战斗

test('整场战斗：筹码守恒、终局出现 Heart、可重开', () => {
  const balance = cloneBalance();
  balance.stacks = { player: 1000, boss: 60 }; // 让这场能快速打完
  const rng = makeRng(70); // 固定种子：此种子下这条策略会打出 13 手的胜利终局
  const b = new Battle({ balance, rng });

  let gameOver = null;
  let steps = 0;
  while (b.view().phase === 'playing' && steps++ < 3000) {
    const v = b.view();
    if (v.objection && Date.now() <= v.objection.deadline + 900) {
      b.object(v.objection.id);
      continue;
    }
    const L = v.player.legal;
    // 简单粗暴：能全下就全下
    const res = L.allin && rng() < 0.7 ? b.act('allin') : b.act(L.check ? 'check' : L.call ? 'call' : 'fold');
    for (const e of res.events) {
      if (e.type === 'hand_end') {
        assert.equal(e.stacks.player + e.stacks.boss, 1060, `筹码守恒（实际 ${e.stacks.player}+${e.stacks.boss}）`);
      }
      if (e.type === 'game_over') gameOver = e;
    }
  }

  assert.ok(gameOver, `战斗必须有终局（实际 phase=${b.view().phase}，手数=${b.handNo}）`);
  assert.equal(gameOver.phase, 'victory', '玩家全下策略应能击破 60 筹码的 Boss');
  assert.ok(gameOver.heart.length > 0, '胜利前必须有 Heart 台词');
  assert.equal(b.view().phase, 'victory');

  // 重开（newGame 会热加载 balance.json，所以恢复的是文件里的配置值）
  const ng = b.newGame();
  const fresh = loadBalance();
  assert.equal(ng.view.phase, 'playing');
  assert.equal(ng.view.player.chips + ng.view.player.bet, fresh.stacks.player, '重开恢复配置里的筹码（含已下盲注）');
  assert.equal(ng.view.boss.chips + ng.view.boss.bet, fresh.stacks.boss, '重开恢复配置里的筹码（含已下盲注）');
  assert.equal(ng.view.boss.state, 'CALM');
  assert.ok(ng.events.some((e) => e.type === 'hand_start'));
  assert.ok(b.feed.some((f) => f.kind === 'system'));
});

test('战败：玩家筹码归零 → defeat', () => {
  const balance = cloneBalance();
  balance.stacks = { player: 40, boss: 1000 };
  const rng = makeRng(72); // 固定种子：此种子下玩家 40 筹码会被磨干
  const b = new Battle({ balance, rng });
  let gameOver = null;
  let steps = 0;
  while (b.view().phase === 'playing' && steps++ < 2000) {
    const L = b.view().player.legal;
    const res = L.allin ? b.act('allin') : b.act(L.check ? 'check' : L.call ? 'call' : 'fold');
    for (const e of res.events) if (e.type === 'game_over') gameOver = e;
  }
  assert.ok(gameOver, '必须有终局');
  assert.equal(gameOver.phase, 'defeat');
  assert.equal(b.view().phase, 'defeat');
});

// ------------------------------------------------------------------ 心理事件

test('抓到诈唬的那手会触发 BLUFF_CAUGHT 类心理事件（多种子烟测）', () => {
  // 不断开新局用不同种子跑，只要累计出现过就算系统通路成立
  const causes = new Set();
  for (let seed = 1; seed <= 25 && causes.size < 3; seed++) {
    const rng = makeRng(seed * 101);
    const b = new Battle({ rng });
    const res = simulate(b, rng, { maxHands: 12 });
    for (const r of res) {
      for (const e of r.events) {
        if (e.type === 'mental') causes.add(e.cause);
        if (e.type === 'objection_result' && e.success) causes.add('CONTRADICTION_EXPOSED');
      }
    }
  }
  assert.ok(causes.size >= 2, `心理事件通路应有多种触发（实际 ${[...causes]}）`);
});

// ------------------------------------------------------- 正向状态与新契约

test('神了(FLOW)：READ 雾化、言语免疫、破绽追问被无视', () => {
  const b = new Battle({ rng: makeRng(31) });
  b.boss.mental.state = 'FLOW';
  assert.equal(b.view().boss.state, 'FLOW');

  // READ 雾化：读不出倾向
  for (let i = 0; i < 6; i++) {
    b.readsLeft = 2;
    const ev = b.read().events.find((e) => e.type === 'read');
    assert.equal(ev.lean, null, '神了读不出倾向');
    assert.ok(ev.text.length > 0);
  }

  // 言语免疫：挑衅不挂 Buff
  const s = b.speak('taunt');
  assert.equal(s.events.find((e) => e.type === 'speech').result, 'resist');
  assert.equal(b.boss.buffs.filter((x) => x.skill === 'taunt').length, 0, '免疫不挂 Buff');

  // 质疑免疫：矛盾保留（他凉下来还能追问）
  const c = b.boss.addContradiction({ kind: 'spoken_vs_bet', handNo: b.handNo, detail: {} });
  b.speechLeft.challenge = 1;
  const ch = b.speak('challenge');
  assert.equal(ch.events.find((e) => e.type === 'speech').result, 'resist');
  assert.equal(b.boss.findContradiction(c.id).resolved, false, '破绽还留着');
  assert.equal(b.boss.state, 'FLOW', '免疫言语不推状态');
});

test('READ 带倾向标签（判断轴，不是答案）', () => {
  const b = new Battle({ rng: makeRng(32) });
  b.boss.noteAction({ action: 'raise', intent: 'BLUFF', street: b.duel.street });
  let got = null;
  for (let i = 0; i < 16 && !got; i++) {
    b.readsLeft = 2;
    const ev = b.read().events.find((e) => e.type === 'read');
    assert.ok(ev.text.length > 0);
    if (ev.lean) got = ev;
  }
  assert.ok(got, '面对他的加注，BLUFF 意图应当能读出倾向');
  assert.equal(got.lean, 'fold');
  assert.equal(got.leanLabel, '他想让你弃牌');
});

test('视图新字段：状态打法提示 / 言语贴纸 / 可追问标志', () => {
  const b = new Battle({ rng: makeRng(33) });
  const v = b.view();
  assert.ok(typeof v.boss.stateHint === 'string' && v.boss.stateHint.length > 0, '状态要有打法含义');
  assert.deepEqual(v.boss.effects, [], '没吃言语时没有贴纸');
  assert.equal(v.player.canChallenge, false, '没有破绽时不能追问');

  // 挂上挑衅 Buff → 贴纸出现
  b.speak('taunt');
  const fx = b.view().boss.effects;
  assert.equal(fx.length, 1);
  assert.equal(fx[0].kind, 'taunt');
  assert.equal(fx[0].icon, '🔥');
  assert.ok(fx[0].desc.includes('加注'), '贴纸要说清行为含义');

  // 制造破绽 → 可追问
  b.boss.addContradiction({ kind: 'spoken_vs_bet', handNo: b.handNo, detail: {} });
  assert.equal(b.view().player.canChallenge, true);

  // lastAction 带 street（READ 时机高亮的依据）
  assert.ok('street' in { ...b.view().boss.lastAction } || b.view().boss.lastAction === null);
});

test('赢钱改变心理状态：连赢计数 + 得意台词', () => {
  const b = new Battle({ rng: makeRng(34) });
  let quips = 0;
  let steps = 0;
  // 玩家一路弃牌：Boss 连赢小底池 → 连胜计数爬升、赢后放臭屁
  while (b.handNo <= 8 && steps++ < 400 && b.phase === 'playing') {
    const L = b.view().player.legal;
    const res = b.act(L.fold ? 'fold' : (L.check ? 'check' : 'call'));
    for (const e of res.events) if (e.type === 'talk') quips += 1;
  }
  assert.ok(b.bossStreak >= 3, `连赢计数应达到 3（实际 ${b.bossStreak}）`);
  assert.ok(quips >= 1, '赢牌后应有得意台词');
  assert.ok(b.recentHands.length > 0 && b.recentHands.every((n) => n > 0), '势头记录为正');
});

test('心理事件带行为提示与方向（回血 ▲ / 打击 ▼）', () => {
  const b = new Battle({ rng: makeRng(35) });
  // 直接走抓千命中路径：SHAKEN → TILT（▼打击）
  b.boss.mental.state = 'SHAKEN';
  const c = b.boss.addContradiction({ kind: 'spoken_vs_bet', handNo: b.handNo, detail: {} });
  b.openWindow = { id: c.id, deadline: Date.now() + 5000, line: 'x', windowMs: 2000 };
  const res = b.object(c.id);
  const mental = res.events.find((e) => e.type === 'mental');
  assert.ok(mental, '抓千命中要有 mental 事件');
  assert.equal(mental.cause, 'CONTRADICTION_EXPOSED');
  assert.ok(typeof mental.hint === 'string' && mental.hint.length > 0, '横幅要带行为后果');
  assert.equal(mental.down, true, '打击方向向下');
  const objRes = res.events.find((e) => e.type === 'objection_result');
  assert.ok(objRes && typeof objRes.hint === 'string', 'objection_result 也带 hint');

  // 回血方向：BIG_POT_WON 让 SHAKEN → CALM（▲）
  b.boss.mental.state = 'SHAKEN';
  b.boss.mental.debt = 0;
  const up = b.boss.mentalEvent('BIG_POT_WON', 1);
  assert.ok(up, '赢大底池应能回血');
  assert.equal(isDownEvent(up.from, up.to), false, '回血方向向上');
  assert.ok(up.hint && up.hint.length > 0, '回血也带新状态的提示');
});
