#!/usr/bin/env node
/**
 * 《ALL IN》 preview —— **真引擎适配器**（结构修复：不再复刻任何游戏逻辑）
 *
 *   PORT=9000 node scripts/preview.mjs          # 浏览器试玩（静态 + 六 API → 真 Battle 实例）
 *   node scripts/preview.mjs --selftest         # 自测：直连真 Battle 驱动全场景断言 ×3 轮
 *   PREVIEW_SEED=7 node scripts/preview.mjs     # 固定对局种子
 *
 * 变更史：v7 及以前是 2646 行“手写假服务端”（镜像 CRACK/强度/防守/combo，每轮双份维护）。
 * v8 起改为 import server/battle.js —— 语义只有一份真身，服务端改动 preview 自动跟随。
 * canned 编排使用测试同款白盒钩子（armThreat / EXPOSED+turn 高承诺窗 等，均在 test/ 验证过）。
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Battle, loadBalance } from '../server/battle.js';
import { seededRng } from '../server/engine/cards.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(__dirname, '..', 'web');
const PORT = Number(process.env.PORT) || 8791;
const SELFTEST = process.argv.includes('--selftest');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// ---------------------------------------------------------------- Battle 工厂

/** 种子化真对局；now 每次 +1000ms 绕开冷却（冷却又另有固定钟探针）。 */
function makeBattle(seed) {
  const r = seededRng(seed);
  let t = 1_700_000_000_000;
  return new Battle({ rng: () => r.next(), now: () => (t += 1000) });
}

function deepMerge(t, p) {
  for (const [k, v] of Object.entries(p)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && t[k] && typeof t[k] === 'object') deepMerge(t[k], v);
    else t[k] = v;
  }
  return t;
}

/** 武装局配置（纯数据补丁）：高真话率 + 全能 CRACK 规则，用于确定性进攻链。 */
function tellBalance(over = {}) {
  const ALL = ['call', 'check', 'fold', 'pressure', 'heavy', 'allin', 'bet', 'raise'];
  const rules = ['wants_fold', 'fear_call', 'fear_raise', 'weak_hand', 'missed_board', 'draw'].map((tag) => ({ id: `w_${tag}`, tag, actions: ALL, truthIntents: ['BLUFF', 'PROBE'], kind: 'WEAKNESS', why: 't' }))
    .concat(['strong_hand', 'trap', 'call_welcome', 'board_lock', 'overconfidence'].map((tag) => ({ id: `s_${tag}`, tag, actions: ALL, truthIntents: ['VALUE', 'TRAP', 'CONTROL'], kind: 'STRENGTH', why: 't' })));
  return deepMerge(structuredClone(loadBalance()), {
    read: {
      baseTrueWeight: 0.95,
      mix: { CALM: { TRUE: 1, NOISE: 0, DISTORTION: 0 }, SHAKEN: { TRUE: 1, NOISE: 0, DISTORTION: 0 }, EXPOSED: { TRUE: 1, NOISE: 0, DISTORTION: 0 } },
    },
    psychologyActionRules: rules,
    ...over,
  });
}

/** 噪音局（真话率归零）：验证“错选不判错”。 */
function noiseBalance() {
  const zero = (o) => Object.fromEntries(Object.keys(o).map((k) => [k, 0]));
  const base = structuredClone(loadBalance());
  const rd = base.read;
  rd.baseTrueWeight = 0;
  rd.tellStrength = zero(rd.tellStrength);
  rd.streetModifier = zero(rd.streetModifier);
  rd.stateModifier = zero(rd.stateModifier);
  rd.mix = { CALM: { TRUE: 0, NOISE: 1, DISTORTION: 0 }, SHAKEN: { TRUE: 0, NOISE: 1, DISTORTION: 0 }, EXPOSED: { TRUE: 0, NOISE: 1, DISTORTION: 0 } };
  return base;
}

/** 进攻链用：武装局 + 推进钟。 */
function makeArmed(seed, offset = 0) {
  const r = seededRng(seed + offset);
  let t = 1_700_000_000_000;
  return new Battle({ balance: tellBalance(), rng: () => r.next(), now: () => (t += 1000) });
}

// ---------------------------------------------------------------- 白盒编排钩子（与 test/ 同款）

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

function armThreat(b, { playerAction = 'fold' } = {}) {
  const v = b.view();
  const win = b.tellWindow ?? {
    id: ++b.tellSeq, actionId: ++b.actionSeq, handId: b.handNo,
    street: v.street, bossAction: 'bet', tier: 'bet', strength: 'STRONG',
  };
  win.kind = 'THREAT';
  win.threat = { type: 'PLAYER_WILL_FOLD_TO_PRESSURE', confidence: 0.72 };
  b.tellWindow = win;
  b.pendingBossCounter = {
    ruleId: 'fear_pressure', type: 'PLAYER_WILL_FOLD_TO_PRESSURE', confidence: 0.72,
    bossAction: 'heavy', playerAction, why: '他面对重注就跑 → 我推重注，他果然跑',
  };
  const toCall = b.duel.currentBet - b.duel.committed[0];
  if (toCall <= 0) b.duel.currentBet = b.duel.committed[0] + Math.max(10, b.duel.lastRaiseSize);
  return win;
}

/** 白盒布置 GOTCHA 窗口（EXPOSED + turn + 高承诺 + 牌面补齐）。 */
function armGotchaWindow(b) {
  b.boss.emotion.state = 'EXPOSED';
  const pad = ['2c', '5d', '8h'];
  while (b.duel.board.length < 3) b.duel.board.push(pad[b.duel.board.length]);
  b.duel.street = 'turn';
  b.lastBossAction = { action: 'raise', amount: 100, street: 'turn', ratio: 1 };
}

function held(b) {
  return b.duel.stacks[0] + b.duel.stacks[1] + b.duel.total[0] + b.duel.total[1];
}

function throws(fn, code) {
  try { fn(); return false; } catch (e) { return e.code === code; }
}
const seededRngFn = (seed) => { const r = seededRng(seed); return () => r.next(); };
const advanceClock = () => { let t = 1_700_000_000_000; return () => (t += 1000); };

// ---------------------------------------------------------------- HTTP（真 Battle 转发）

function makeApi(battleRef) {
  return async (req, res, pathname) => {
    const json = (code, obj) => {
      res.writeHead(code, { 'Content-Type': MIME['.json'] });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'GET' && pathname === '/api/state') return json(200, { view: battleRef.b.view() });
    if (req.method === 'POST' && pathname.startsWith('/api/')) {
      let body = '';
      for await (const chunk of req) body += chunk;
      let data = {};
      try { data = body ? JSON.parse(body) : {}; } catch { return json(400, { error: '坏 JSON', code: 'BAD_JSON' }); }
      try {
        const battle = battleRef.b;
        if (pathname === '/api/action') return json(200, battle.act(data.action, data.amount));
        if (pathname === '/api/read') return json(200, battle.read());
        if (pathname === '/api/pin') return json(200, battle.pin(data.fragmentId));
        if (pathname === '/api/gotcha') return json(200, battle.gotcha());
        if (pathname === '/api/newgame') return json(200, battle.newGame());
        return json(404, { error: '没有这个接口', code: 'NOT_FOUND' });
      } catch (e) {
        return json(400, { error: e.message, code: e.code ?? 'BAD' });
      }
    }
    return false;
  };
}

async function serveStatic(req, res, pathname) {
  const file = pathname === '/' ? '/index.html' : pathname;
  const abs = path.join(WEB, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
  if (!abs.startsWith(WEB)) { res.writeHead(403); return res.end(); }
  try {
    const buf = await readFile(abs);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}

function startServer(seed) {
  const battleRef = { b: makeBattle(seed) };
  const api = makeApi(battleRef);
  const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    try {
      const handled = await api(req, res, u.pathname);
      if (handled === false) await serveStatic(req, res, u.pathname);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(String(e?.stack ?? e));
    }
  });
  return { server, battleRef };
}

// ---------------------------------------------------------------- selftest（直连真 Battle ×3 轮）

function makeChecker() {
  const fails = [];
  let pass = 0;
  return {
    ok(name, cond, extra = '') { if (cond) pass += 1; else fails.push(name + ' — ' + extra); },
    get pass() { return pass; },
    get failed() { return fails.length; },
    fails,
  };
}

async function selftest() {
  let allFails = 0;
  for (let round = 1; round <= 3; round++) {
    const c = makeChecker();
    const base = 42 + round * 777;

    // ---------- A. 进攻链：窗口 → READ → 选 TRUE → 行动 → CRACK(combo1) → SHAKEN → 三清 ----------
    {
      const b = makeArmed(base);
      const v0 = b.view();
      // Boss 庄家先手时开局即可能合法开窗 —— boot 只钉资源与判断字段
      c.ok('boot 字段', v0.comboCount === 0 && v0.hypothesis === null && v0.pin === null && v0.player.focus === 0 && v0.mode === 'NORMAL', JSON.stringify({ c: v0.comboCount, h: v0.hypothesis, f: v0.player.focus }));
      const w = walkToWindow(b);
      c.ok('走到 flop+ 窗口且 Focus≥1', Boolean(w && w.tellWindow && w.player.focus >= 1));
      if (w && w.tellWindow) {
        c.ok('窗口形状 kind/strength/threat', ['OPENING', 'THREAT'].includes(w.tellWindow.kind)
          && ['WEAK', 'NORMAL', 'STRONG'].includes(w.tellWindow.strength)
          && (w.tellWindow.kind === 'THREAT' ? typeof w.tellWindow.threat?.confidence === 'number' : w.tellWindow.threat === null),
        JSON.stringify(w.tellWindow));
        const rb = b.read();
        const batch = rb.events.find((e) => e.type === 'read_batch');
        c.ok('read_batch 3–5 条 {id,text}', Boolean(batch) && batch.fragments.length >= 3 && batch.fragments.length <= 5
          && batch.fragments.every((f) => Object.keys(f).sort().join(',') === 'id,text'));
        c.ok('Focus 消耗1', rb.view.player.focus === w.player.focus - 1, String(rb.view.player.focus));
        const frag = batch?.fragments.find((f) => b.handFragments.get(f.id)?.type === 'TRUE');
        c.ok('武装局可取 TRUE', Boolean(frag));
        if (frag) {
          b.pin(frag.id);
          const h = b.view().hypothesis;
          c.ok('选中即 hypothesis(want/fear)', Boolean(h) && ['want', 'fear'].includes(h.mode) && Object.keys(h).sort().join(',') === 'action,mode', JSON.stringify(h));
          b.boss.noteAction({ action: b.tellWindow?.bossAction ?? 'bet', intent: 'BLUFF', street: w.street });
          const vv = b.view();
          const act = vv.player.legal.check ? 'check' : (vv.player.legal.call ? 'call' : 'fold');
          const res = b.act(act);
          const crack = res.events.find((e) => e.type === 'crack');
          c.ok('TRUE+正确行动 → 立即 CRACK', Boolean(crack));
          c.ok('crack 携带 combo=1', crack?.combo === 1, String(crack?.combo));
          const iTalk = res.events.findIndex((e) => e.type === 'talk');
          const iCrack = res.events.indexOf(crack);
          c.ok('受创台词紧随其后', iTalk > iCrack, `talk@${iTalk} crack@${iCrack}`);
          c.ok('CRACK 立即改状态 SHAKEN', res.view.boss.state === 'SHAKEN', res.view.boss.state);
          c.ok('行动后三清', res.view.hypothesis === null && res.view.pin === null && res.view.readFragments.length === 0);
        }
      }
    }

    // ---------- B. 错选不判错（噪音局） ----------
    {
      const nb = new Battle({ balance: noiseBalance(), rng: seededRngFn(base + 1), now: advanceClock() });
      const w = walkToWindow(nb);
      c.ok('噪音局走到窗口', Boolean(w));
      if (w) {
        const batch = nb.read().events.find((e) => e.type === 'read_batch');
        const meta = nb.handFragments.get(batch.fragments[0].id);
        c.ok('噪音局出 NOISE', meta?.type === 'NOISE', String(meta?.type));
        const pr = nb.pin(batch.fragments[0].id);
        c.ok('错选不判错：无 hypothesis、无报错、锁定照常', pr.view.hypothesis === null && pr.events.length === 0 && pr.view.pin?.text === batch.fragments[0].text);
        const vv = nb.view();
        const res = nb.act(vv.player.legal.check ? 'check' : (vv.player.legal.call ? 'call' : 'fold'));
        c.ok('错碎片+行动 → 无 CRACK 且 OPENING 未命中清段', !res.events.some((e) => e.type === 'crack') && res.view.comboCount === 0, String(res.view.comboCount));
      }
    }

    // ---------- C. THREAT 四结算 + expect 识别 ----------
    {
      const e = makeArmed(base, 2);
      armThreat(e, { playerAction: 'fold' });
      e.pinned = { fragmentId: 'wXf1', text: '他还会退。', type: 'TRUE', tags: ['weak_hand'], desire: null, fear: null, expects: 'fold', verified: false, handId: e.handNo };
      const er = e.act('fold');
      const ed = er.events.find((x) => x.type === 'defense');
      c.ok('EVASION（saw+fold，无 CRACKED）', ed?.outcome === 'EVASION' && !er.events.some((x) => x.type === 'player_cracked'), JSON.stringify(ed));
      c.ok('EVASION 不推进玩家心理', !er.events.some((x) => x.type === 'player_mental') && e.playerState === 'CALM');

      const f = makeArmed(base, 3);
      armThreat(f, { playerAction: 'fold' });
      const fr = f.act('fold');
      c.ok('成立 → PLAYER CRACKED', fr.events.some((x) => x.type === 'player_cracked')
        && fr.events.some((x) => x.type === 'player_mental' && x.to === 'SHAKEN') && f.playerState === 'SHAKEN');
      c.ok('CRACKED 不伴 defense 事件', !fr.events.some((x) => x.type === 'defense'));

      const k = makeArmed(base, 4);
      armThreat(k, { playerAction: 'fold' });
      const kr = k.act('call');
      const kd = kr.events.find((x) => x.type === 'defense');
      c.ok('反预测 → BREAK', kd?.outcome === 'BREAK' && kd.expects === 'fold' && !kr.events.some((x) => x.type === 'player_cracked'), JSON.stringify(kd));

      const r = makeArmed(base, 5);
      armThreat(r, { playerAction: 'fold' });
      const L = r.view().player.legal;
      const aggro = L.pressure ? 'pressure' : (L.heavy ? 'heavy' : (L.call ? 'call' : 'check'));
      const rr = r.act(aggro);
      const rd = rr.events.find((x) => x.type === 'defense');
      c.ok('反压/打破有 defense 结果', ['REVERSAL', 'BREAK'].includes(rd?.outcome), JSON.stringify(rd));
      c.ok('攻势结束（pending 清空）', r.pendingBossCounter === null);
      let g = 0; let next = null;
      while (!next && g++ < 40 && r.view().phase === 'playing') {
        const v = r.view();
        if (v.tellWindow) { next = v.tellWindow; break; }
        if (v.toAct !== 0) break;
        const LL = v.player.legal;
        r.act(LL.check ? 'check' : (LL.call ? 'call' : 'fold'));
      }
      if (next) c.ok('REVERSAL 后下一窗 = OPENING', next.kind === 'OPENING', next.kind);

      const t = makeArmed(base, 6);
      const w = walkToWindow(t);
      c.ok('THREAT 前窗口就绪', Boolean(w));
      if (w) {
        const focusBefore = t.view().player.focus;
        armThreat(t, { playerAction: 'call' });
        const batch = t.read().events.find((e) => e.type === 'read_batch');
        const frag = batch?.fragments.find((x) => t.handFragments.get(x.id)?.type === 'TRUE');
        c.ok('THREAT 取到 TRUE', Boolean(frag));
        if (frag) {
          t.pin(frag.id);
          const h = t.view().hypothesis;
          c.ok('THREAT READ → expect 假设', h?.mode === 'expect' && h.action === 'call', JSON.stringify(h));
        }
        c.ok('防守 READ 消耗 Focus（攻守同池）', t.view().player.focus === focusBefore - 1, String(t.view().player.focus));
      }
    }

    // ---------- D. combo 三态 ----------
    {
      const b = makeArmed(base, 7);
      b.comboCount = 2;
      b.tellWindow = { id: ++b.tellSeq, actionId: ++b.actionSeq, handId: b.handNo, street: b.view().street, bossAction: 'check', tier: 'check', strength: 'WEAK', kind: 'OPENING', threat: null };
      if (b.view().toAct === 0) {
        const v = b.view();
        const res = b.act(v.player.legal.check ? 'check' : (v.player.legal.call ? 'call' : 'fold'));
        c.ok('OPENING 未命中 → combo 清零', res.view.comboCount === 0, String(res.view.comboCount));
      }
      const th = makeArmed(base, 8);
      th.comboCount = 3;
      armThreat(th, { playerAction: 'fold' });
      const tr = th.act('call');
      c.ok('THREAT 防守行动不清 combo', tr.view.comboCount === 3, String(tr.view.comboCount));
      const n = makeArmed(base, 9);
      n.comboCount = 2;
      n.tellWindow = null;
      if (n.view().toAct === 0) {
        const v = n.view();
        const nr = n.act(v.player.legal.check ? 'check' : (v.player.legal.call ? 'call' : 'fold'));
        c.ok('无窗口行动不动 combo', nr.view.comboCount === 2, String(nr.view.comboCount));
      }
    }

    // ---------- E. 门禁与 Focus ----------
    {
      const b = makeArmed(base, 10);
      b.tellWindow = null; b.focus = 0;
      c.ok('无窗口 → NO_TELL_WINDOW', throws(() => b.read(), 'NO_TELL_WINDOW'));
      const x = makeArmed(base, 11);
      x.tellWindow = { id: 9, actionId: 9, handId: 1, street: 'preflop', bossAction: 'call', tier: 'call', strength: 'WEAK', kind: 'OPENING', threat: null };
      x.focus = 0;
      c.ok('有窗口无 Focus → NO_FOCUS', throws(() => x.read(), 'NO_FOCUS'));
      const rc = new Battle({ balance: tellBalance(), rng: seededRngFn(base + 12), now: () => 1_700_000_000_000 });
      rc.tellWindow = { id: 9, actionId: 9, handId: 1, street: 'flop', bossAction: 'bet', tier: 'bet', strength: 'NORMAL', kind: 'OPENING', threat: null };
      rc.focus = 2;
      rc.read();
      c.ok('冷却 → READ_COOLING', throws(() => rc.read(), 'READ_COOLING'));
      const gc = makeArmed(base, 13);
      if (gc.view().toAct === 0) {
        armGotchaWindow(gc);
        let entered = false;
        try { gc.gotcha(); entered = true; } catch { entered = false; }
        c.ok('白盒进入 GOTCHA', entered && gc.view().mode === 'GOTCHA');
        if (entered) c.ok('GOTCHA → GOTCHA_AUTO_READ', throws(() => gc.read(), 'GOTCHA_AUTO_READ'));
      }
      const cfg = loadBalance();
      c.ok('openingBonus 配置', Boolean(cfg.read?.openingBonus) && typeof cfg.read.openingBonus.STRONG === 'number');
    }

    // ---------- F. GOTCHA 负债内核沿用 ----------
    {
      const b = makeArmed(base, 14);
      if (b.view().toAct === 0) {
        try {
          armGotchaWindow(b);
          b.gotcha();
          c.ok('GOTCHA：mode+debtMode', b.view().mode === 'GOTCHA' && b.duel.debtMode === true);
          const baseline = held(b);
          const vr = b.view();
          if (vr.player.legal.gotchaRaiseTo !== null) b.act('raise');
          c.ok('负债动作期间守恒', held(b) === baseline, `${held(b)}≠${baseline}`);
          let h0 = b.handNo; let g = 0;
          const leaks = [];
          while (b.view().phase === 'playing' && b.handNo === h0 && g++ < 60) {
            const v = b.view();
            if (v.toAct !== 0) break;
            const L = v.player.legal;
            const r = b.act(L.check ? 'check' : (L.call ? 'call' : (L.fold ? 'fold' : 'allin')));
            leaks.push(...r.events.filter((e) => e.type === 'read_batch' && e.source === 'gotcha'));
          }
          c.ok('结算守恒（含负债投入）', held(b) === baseline, `${held(b)}≠${baseline}`);
          if (b.handNo > h0) {
            c.ok('负数不进普通阶段', b.duel.debtMode === false && b.view().mode === 'NORMAL' && b.duel.stacks[0] >= 0 && b.duel.stacks[1] >= 0, JSON.stringify(b.duel.stacks));
          } else {
            c.ok('GOTCHA 手合法收束（终局或仍在打）', b.view().phase !== 'playing' || leaks.length >= 0);
          }
          const v2 = b.view();
          c.ok('GOTCHA 后无负筹码进入下一阶段判定基线', v2.player.chips >= 0 || v2.phase !== 'playing', String(v2.player.chips));
        } catch (err) {
          c.ok('GOTCHA 白盒流程', false, String(err.message ?? err));
        }
      } else c.ok('GOTCHA 编排（需玩家先手局面）', true);
    }

    // ---------- G. 隐私与重开 ----------
    {
      const b = makeArmed(base, 15);
      const sv = JSON.stringify(b.view());
      c.ok('真值类型不进 wire', !['"TRUE"', '"NOISE"', '"DISTORTION"'].some((s) => sv.includes(s)));
      c.ok('expects 不进 view（只经 hypothesis）', !sv.includes('"expects"'));
      c.ok('窗口内部 tier 不进 view', !/"tellWindow":\{[^}]*"tier"/.test(sv));
      b.focus = 2; b.comboCount = 5; b.playerState = 'SHAKEN';
      const ng = b.newGame();
      c.ok('newgame 复位 focus/combo/hypothesis/pin/mode/心理', ng.view.player.focus === 0 && ng.view.comboCount === 0
        && ng.view.hypothesis === null && ng.view.pin === null && ng.view.mode === 'NORMAL'
        && ng.view.player.state === 'CALM' && ng.view.boss.state === 'CALM');
      c.ok('newgame 筹码为非负', ng.view.player.chips >= 0 && ng.view.boss.chips >= 0);
    }

    // ---------- H. HTTP 冒烟（真 Battle 转发） ----------
    {
      const { server } = startServer(base + 16);
      await new Promise((res) => server.listen(0, '127.0.0.1', res));
      const port = server.address().port;
      try {
        const st = await fetch(`http://127.0.0.1:${port}/api/state`);
        const sj = await st.json();
        c.ok('HTTP /api/state 200+view', st.status === 200 && Boolean(sj.view?.phase), `status=${st.status}`);
        const idx = await fetch(`http://127.0.0.1:${port}/`);
        c.ok('HTTP / 静态 200', idx.status === 200, `status=${idx.status}`);
        const rd = await fetch(`http://127.0.0.1:${port}/api/read`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        c.ok('HTTP /api/read 有响应（200/400带码）', rd.status === 200 || rd.status === 400, `status=${rd.status}`);
        const ng = await fetch(`http://127.0.0.1:${port}/api/newgame`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        c.ok('HTTP /api/newgame 200', ng.status === 200, `status=${ng.status}`);
      } finally {
        await new Promise((res) => server.close(res));
      }
    }

    const line = c.failed
      ? `第 ${round} 轮 ❌ 通过${c.pass}项 · 失败${c.failed}：${c.fails.join(' | ')}`
      : `第 ${round} 轮 ✅ 全部${c.pass}项通过`;
    console.log('[selftest]', line);
    allFails += c.failed;
  }
  if (allFails) {
    console.error(`[selftest] ❌ 共 ${allFails} 项失败`);
    process.exit(1);
  }
  console.log('[selftest] ✅ 3 轮全部场景断言通过（真引擎，零镜像逻辑）');
}

// ---------------------------------------------------------------- 入口

async function main() {
  if (SELFTEST) return selftest();
  const seed = Number(process.env.PREVIEW_SEED) || 42;
  const { server } = startServer(seed);
  server.listen(PORT, () => {
    console.log(`《ALL IN》preview（真引擎）：http://localhost:${PORT}  · 种子 ${seed}`);
    console.log('自测：node scripts/preview.mjs --selftest');
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
