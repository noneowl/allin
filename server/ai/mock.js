import { evaluate } from '../engine/evaluator.js';
import { rankOf, seededRng } from '../engine/cards.js';

/**
 * Offline demo opponent.
 *
 * This is NOT an LLM and it is NOT used during normal play: the real decision
 * path always goes through the configured provider. It exists purely so the
 * table can be previewed end to end without an API key, and it speaks the same
 * JSON protocol an LLM does so every downstream validation path is identical.
 */

const BASE_AGGRESSION = {
  ivan: 0.62,
  biao: 0.88,
  jiu: 0.5,
  lisa: 0.74,
  kongming: 0.3,
  nana: 0.2,
  wei: 0.56,
};

const BASE_BLUFF = {
  ivan: 0.06,
  biao: 0.3,
  jiu: 0.04,
  lisa: 0.34,
  kongming: 0.02,
  nana: 0.05,
  wei: 0.16,
};

const TALK = {
  ivan: ['这牌不错。', '我跟。', '别乱来。'],
  biao: ['加！', '就这？', '压死你。', '来啊！'],
  jiu: ['这个价格我算过了。', '赔率合适。', '数学上必须跟。'],
  lisa: ['我猜你没有 A 吧？', '你紧张了。', '别怕，我只是玩玩。'],
  kongming: ['……', '我加注。', '这一切都是虚妄。'],
  nana: ['跟一下看看嘛。', '万一下一张就来了呢。', '我跟。'],
  wei: ['我看看。', '这个尺度你舒服吗？'],
};

/** Rough 0..1 hand strength, used only by the demo brain. */
function preflopStrength(hole) {
  const [a, b] = hole;
  const ra = rankOf(a);
  const rb = rankOf(b);
  const hi = Math.max(ra, rb);
  const lo = Math.min(ra, rb);
  if (ra === rb) return Math.min(1, 0.5 + (hi - 2) / 24);
  const suited = a[1] === b[1] ? 0.06 : 0;
  const gap = hi - lo;
  const connected = gap === 1 ? 0.07 : gap === 2 ? 0.03 : 0;
  const high = ((hi - 2) / 12) * 0.4 + ((lo - 2) / 12) * 0.2;
  return Math.min(1, high + suited + connected);
}

function postflopStrength(hole, board) {
  const all = [...hole, ...board];
  if (all.length < 5) return 0.3;
  const result = evaluate(all);
  if (!result) return 0.3;
  const base = result.category / 8;
  const tiebreakBonus = result.tiebreak[0] ? (result.tiebreak[0] - 2) / 12 / 8 : 0;
  return Math.min(1, base * 0.92 + tiebreakBonus + 0.06);
}

export function mockDecision(table, seatIdx, personality) {
  const seat = table.seats[seatIdx];
  const legal = table.legalActions(seatIdx);
  const byType = new Map(legal.map((a) => [a.type, a]));
  const id = personality?.id ?? 'wei';

  const rng = seededRng(((table.handId * 7919 + seatIdx * 104729 + table.board.length * 31) >>> 0) || 1);
  const roll = rng.next();
  const roll2 = rng.next();

  const aggression = BASE_AGGRESSION[id] ?? 0.5;
  const bluff = BASE_BLUFF[id] ?? 0.1;
  const strength = table.board.length === 0 ? preflopStrength(seat.hole) : postflopStrength(seat.hole, table.board);

  const toCall = Math.max(0, table.currentBet - seat.committed);
  const potOdds = toCall > 0 ? toCall / (table.potTotal + toCall) : 0;

  let action = 'check';
  let amount = null;
  let reasoning = '';

  const raiseSpec = byType.get('raise') ?? byType.get('bet');
  const pot = Math.max(table.bigBlind, table.potTotal);
  const sizing = () => {
    const fraction = aggression > 0.7 ? 0.7 + roll2 * 0.5 : 0.4 + roll2 * 0.35;
    const target = Math.round(toCall + fraction * (pot + toCall));
    return target;
  };

  if (toCall === 0) {
    const wantsValue = strength > 0.45 && roll < aggression;
    const wantsBluff = strength <= 0.45 && roll < bluff;
    if (raiseSpec && (wantsValue || wantsBluff)) {
      action = raiseSpec.type;
      amount = sizing();
      reasoning = wantsValue ? '我的牌力领先，主动下注拿价值。' : '牌面适合施压，代表强牌下注。';
    } else {
      action = 'check';
      reasoning = '先过牌控制底池，看看后面的动作。';
    }
  } else {
    const canRaise = Boolean(raiseSpec);
    const strong = strength > 0.55;
    const bluffRaise = canRaise && strength < 0.35 && roll < bluff * 0.9;

    if (strong && canRaise && roll < aggression + 0.15) {
      action = raiseSpec.type;
      amount = sizing();
      reasoning = '牌力足够强，加注做大底池。';
    } else if (bluffRaise) {
      action = raiseSpec.type;
      amount = sizing();
      reasoning = '对手示弱，我用加注代表强牌。';
    } else if (strength > potOdds + 0.12) {
      action = byType.has('call') ? 'call' : 'fold';
      reasoning = '赔率合适，跟注继续。';
    } else if (byType.has('all_in') && strength > 0.85 && roll < 0.4) {
      action = 'all_in';
      reasoning = '牌力极强，直接全下。';
    } else {
      action = 'fold';
      reasoning = '赔率不够，弃牌等下一手。';
    }
  }

  if (!byType.has(action)) {
    if (byType.has('check')) action = 'check';
    else if (byType.has('call')) action = 'call';
    else if (byType.has('fold')) action = 'fold';
    else action = legal[0]?.type ?? 'fold';
    amount = null;
  }
  if (action !== 'bet' && action !== 'raise') amount = null;

  const talks = TALK[id] ?? [];
  const tableTalk = roll2 > 0.62 && talks.length ? talks[Math.floor(roll * talks.length) % talks.length] : '';

  return JSON.stringify({
    action,
    amount,
    reasoning,
    table_talk: tableTalk,
  });
}
