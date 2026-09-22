/**
 * Boss 台词池与选词逻辑。
 *
 * 每条台词都标注 claim（0=示弱 / 1=中性 / 2=放狠话）。选词时先算出这次下注
 * 的实际大小档位，再按 mental state 的 lineBias 概率故意挑一条「和注码对不上」
 * 的话 —— 矛盾就是这样被制造出来的（见 battle.js 的 spoken_vs_bet 检测）。
 */

export const INTENTS = ['VALUE', 'BLUFF', 'PROBE', 'TRAP', 'POT_CONTROL'];

const L = (t, c) => ({ t, c });

/** state -> intent -> 台词池。intent 缺失时回落到 any。 */
export const TALK = {
  CALM: {
    VALUE: [
      L('继续也可以。', 1),
      L('这注不重，你跟得起。', 2),
      L('该拿的，我一分不让。', 2),
      L('按你的水平，这注应该接得住。', 1),
    ],
    BLUFF: [
      L('这一手，你最好别碰。', 2),
      L('你猜我有什么？猜错了就盖牌。', 2),
      L('别接，接了你会后悔。', 2),
      L('我不太想解释这一注。', 1),
    ],
    PROBE: [
      L('我先看看你怎么想。', 1),
      L('小注，买你一个答案。', 1),
      L('试探一下，别紧张。', 1),
      L('随便推一点，看牌面说话。', 0),
    ],
    TRAP: [
      L('我不急，你先。', 1),
      L('这牌我拿着挺舒服的。', 2),
      L('你请，我就看看。', 1),
    ],
    POT_CONTROL: [
      L('这一手我不想惹事。', 1),
      L('先看看下一张。', 1),
      L('到此为止，稳一点。', 1),
    ],
    any: [L('嗯。', 1), L('过。', 1), L('跟上。', 1)],
  },

  SHAKEN: {
    VALUE: [
      L('别误会，我只是不想把事情搞大。', 1),
      L('这注是给你机会。', 2),
      L('……跟上，别磨蹭。', 1),
      L('我算过了，你不行。', 2),
    ],
    BLUFF: [
      L('怎么，不敢跟？', 2),
      L('你要是有牌，早就加回来了。', 2),
      L('这一注你接不住。', 2),
      L('你现在的表情，和被偷鸡时一模一样。', 2),
    ],
    PROBE: [
      L('我就随便推一点。', 0),
      L('别想太多，一注而已。', 1),
      L('先给你点压力，不多。', 2),
    ],
    TRAP: [
      L('来啊，你不是挺会看吗。', 2),
      L('我等着呢。', 1),
      L('这牌我没什么好急的。', 1),
    ],
    POT_CONTROL: [
      L('这一手我不想冒险。', 1),
      L('先稳住。', 1),
      L('……别在这个时候逼我。', 1),
    ],
    any: [L('……过。', 1), L('你到底跟不跟？', 2), L('哼。', 1)],
  },

  TILT: {
    VALUE: [
      L('你不是很会看吗？继续。', 2),
      L('这次我让你看个够。', 2),
      L('跟啊，别让我失望。', 2),
      L('我今天就要在这里解决你。', 2),
    ],
    BLUFF: [
      L('你凭什么觉得你能赢我？', 2),
      L('这一注，你不敢接。', 2),
      L('全推给你，敢不敢？', 2),
      L('我就知道你到这就怂了。', 2),
    ],
    PROBE: [
      L('别急，大的还在后面。', 2),
      L('先给你尝尝味道。', 2),
      L('这一注只是开胃菜。', 2),
    ],
    TRAP: [
      L('来啊！我就等你进来。', 2),
      L('你敢打，我就敢收。', 2),
    ],
    POT_CONTROL: [
      L('我没上头，你少来这套。', 1),
      L('这注不代表什么。', 0),
      L('……我只是不想把底池交给你。', 1),
    ],
    any: [L('说话啊，怎么不说话了？', 2), L('继续。', 2), L('……闭嘴打牌。', 1)],
  },

  BREAKING: {
    VALUE: [
      L('……这一次我是真的有牌，你信不信都一样。', 2),
      L('为什么你每次都在这儿跟？', 2),
      L('我受不了你那副什么都算到了的样子。', 2),
    ],
    BLUFF: [
      L('你到底为什么每次都知道？！', 2),
    L('别再看了，你看得我发毛。', 2),
      L('求你了，盖一次牌行不行？', 0),
      L('我又在演了——你看出来了吗？', 0),
    ],
    PROBE: [
      L('我需要确认一下你还在不在怕我。', 1),
      L('别让我问第二次。', 2),
    ],
    TRAP: [
      L('……你进来啊。我在等你。', 1),
      L('我剩下的筹码，就在这里。', 1),
    ],
    POT_CONTROL: [
      L('我只是……不想再输一次。', 0),
      L('这局开始之前我不是这样的。', 0),
      L('我的手在抖，但我不承认。', 0),
    ],
    any: [L('……随便。', 0), L('你满意了？', 1), L('发牌。', 1)],
  },
};

/** 被言语技能命中/抵抗时的回应。result: hit=效果强 resist=嘴硬 whiff=质疑落空 */
export const SPEECH_REACT = {
  taunt: {
    CALM: { resist: '我的注，不用你教。', hit: '注小，是因为你不配看大的。' },
    SHAKEN: { hit: '你说我只敢下小注？……那你看着。', resist: '激将法对我没用。' },
    TILT: { hit: '再来一次？我加死你。', resist: '你尽管说，筹码不会陪你演。' },
    BREAKING: { hit: '你闭嘴——看牌！', resist: '……我不在乎你说什么。' },
  },
  pressure: {
    CALM: { resist: '你确定要来问我？', hit: '压力这东西，你留着自己用。' },
    SHAKEN: { hit: '……我不退。', resist: '这句话该我送给你。' },
    TILT: { hit: '……行，这一手让你。', resist: '你以为你是谁。' },
    BREAKING: { hit: '别逼我……这手你拿去。', resist: '……我没事，我没事。' },
  },
  challenge: {
    // 质疑命中（确实存在矛盾）
    CALM: { hit: '……你看错了。', resist: '证据呢？没有就打牌。' },
    SHAKEN: { hit: '你——！……下一把。', resist: '我爱说什么就说什么。' },
    TILT: { hit: '闭嘴！这把不算！', resist: '你想多了，我一直这样。' },
    BREAKING: { hit: '……是，我就是在演。', resist: '你到底想怎样？！' },
    // 落空
    whiff: '就这？我还以为你抓到了什么。',
  },
};

/** 质疑落空 / 言语被抵抗时的统一回落词。 */
export function fallbackReact(skill, state) {
  if (skill === 'challenge') return SPEECH_REACT.challenge.whiff;
  const pool = SPEECH_REACT[skill]?.[state] ?? {};
  return pool.resist ?? '……随你。';
}

/**
 * 下注大小分档：相对「下注前底池」的比例。
 * @returns {number} 0..4（levels 见 balance.json contradiction.sizeLevels）
 */
export function sizeLevel(potBefore, put, sizeLevels) {
  if (!(put > 0)) return 0;
  const ratio = put / Math.max(1, potBefore);
  let level = 0;
  while (level < sizeLevels.length && ratio >= sizeLevels[level]) level++;
  return level;
}

/** 这句话和这个注码对得上吗？对不上就是 spoken_vs_bet 矛盾。 */
export function claimMatches(claim, level) {
  if (claim === 2) return level >= 2; // 放狠话必须配 ≥0.55 池的注
  if (claim === 0) return level <= 1; // 示弱只能配 <0.55 池的注
  return level <= 3; // 中性话：只有超池才算不符
}

/**
 * 挑一句台词。
 * @param {{state, intent, action, potBefore, put, lineBias, rng}} ctx
 * @returns {{text: string, claim: number}}
 */
export function pickLine(ctx) {
  const { state, intent, action, potBefore = 0, put = 0, lineBias = 0.2, rng = Math.random, sizeLevels } = ctx;
  const byState = TALK[state] ?? TALK.CALM;
  let pool = byState[intent] && byState[intent].length ? byState[intent] : byState.any;
  pool = pool.filter(Boolean);
  if (pool.length === 0) return { text: '……', claim: 1 };

  // 没有实际下注（过牌/跟注的顺带台词）不参与矛盾制造，直接挑
  if (!(put > 0)) {
    const pick = pool[Math.floor(rng() * pool.length)];
    return { text: pick.t, claim: pick.c };
  }

  const level = sizeLevel(potBefore, put, sizeLevels);
  const matching = pool.filter((l) => claimMatches(l.c, level));
  const mismatching = pool.filter((l) => !claimMatches(l.c, level));

  if (mismatching.length > 0 && (matching.length === 0 || rng() < lineBias)) {
    const pick = mismatching[Math.floor(rng() * mismatching.length)];
    return { text: pick.t, claim: pick.c };
  }
  const from = matching.length > 0 ? matching : pool;
  const pick = from[Math.floor(rng() * from.length)];
  return { text: pick.t, claim: pick.c };
}

/** 言语技能的回应台词。 */
export function pickSpeechReact(skill, state, result, rng = Math.random) {
  if (skill === 'challenge') {
    if (result === 'whiff') return SPEECH_REACT.challenge.whiff;
    const pool = SPEECH_REACT.challenge[state] ?? {};
    return result === 'hit' ? (pool.hit ?? '……') : (pool.resist ?? SPEECH_REACT.challenge.whiff);
  }
  const pool = SPEECH_REACT[skill]?.[state] ?? {};
  return pool[result] ?? fallbackReact(skill, state);
}

/** 最终 Heart：Boss 筹码归零时播放。 */
export const FINAL_HEART = '我只是……不想承认你真的看穿我了。';
/** 玩家筹码归零时 Boss 的收场白。 */
export const DEFEAT_LINE = '……你终于也空了。筹码和自信，一样都不能少。';
