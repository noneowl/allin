/**
 * READ 读心台词池。
 *
 * READ 只给「情绪和倾向」，永远不直接宣布牌力。信息清晰度由 mental state
 * 决定：BREAKING 的 Boss 藏不住事，READ 出来的句子会更接近真相。
 *
 * 选词输入：
 *   state       心理状态
 *   clarity     0..2，状态带来的清晰度（CALM=0 TILT=1 BREAKING=2）
 *   situation   'bet'（他刚下注/加注）| 'checked'（他刚过牌/跟注）| 'neutral'（他本街还没动作）
 *   intent      有 live intent 时传入，否则 null
 */

const L = (t) => t;

/** 按意图分组；tier: 0=模糊 1=较清晰（clarity 越高越可能抽到 1） */
export const INTENT_LINES = {
  BLUFF: {
    0: [
      L('他似乎非常期待你弃牌。'),
      L('他把气氛绷得很紧，像是不想让这一注被接住。'),
      L('他嘴上很强硬，但一直在观察你的反应。'),
    ],
    1: [
      L('这次下注之后，他反而更加紧张了——他希望你盖牌。'),
      L('他强硬得很用力，像是排练过的。'),
      L('他真正在意的不是底池，是你会不会跟。'),
    ],
  },
  VALUE: {
    0: [
      L('他说完这句话之后反而放松了下来。'),
      L('他不介意你跟注，甚至有点希望你跟。'),
      L('他的下注没有犹豫。'),
    ],
    1: [
      L('他希望你接这一注——越快越好。'),
      L('他现在的姿态是「来吧」，不是「走开」。'),
    ],
  },
  TRAP: {
    0: [
      L('他把整条路让给了你，注意力却一直停在你身上。'),
      L('他不急，他在等你先动手。'),
      L('他的放松不像是真的。'),
    ],
    1: [
      L('他在等你犯错，等得很有耐心。'),
      L('他不怕你下注——这本身就很可疑。'),
    ],
  },
  POT_CONTROL: {
    0: [
      L('他现在的动作很小心，像是不想把事情闹大。'),
      L('他更在意别失去什么，而不是赢得什么。'),
      L('他收着打，像是手里没有底气。'),
    ],
    1: [
      L('他在按住底池，也在按住自己的表情。'),
    ],
  },
  PROBE: {
    0: [
      L('这更像是一次试探，他在等你的反应。'),
      L('他没把这一注当真，他在看你。'),
      L('他先出了一张牌，像是在问问题。'),
    ],
    1: [
      L('他自己也没想清楚，所以先推一点来看看。'),
    ],
  },
};

/** 没有 live intent 时按状态抽。 */
export const STATE_LINES = {
  CALM: [
    L('他看上去和开局时没什么两样。'),
    L('他正在按自己的节奏打，没有被你打乱。'),
    L('他很安静，安静得像是什么都没想。'),
  ],
  SHAKEN: [
    L('他明显比刚才更加急躁。'),
    L('他正在努力维持镇定。'),
    L('他的视线比之前频繁地往你这边飘。'),
    L('他嘴上在硬撑，节奏已经乱了。'),
  ],
  TILT: [
    L('他的注意力一直停留在你的反应上。'),
    L('比起赢钱，他现在更想赢你。'),
    L('他下注前的停顿变短了——他在赌气。'),
    L('他几乎不再看自己的牌，只在看你。'),
  ],
  BREAKING: [
    L('他快把自己的答案写在脸上了。'),
    L('他一边说话一边推筹码——手比脑子快。'),
    L('他已经分不清自己是想赢还是想被看穿。'),
  ],
};

/**
 * 抽一条 READ。
 * @param {{state, clarity, situation, intent, rng}} ctx
 * @returns {string}
 */
export function pickRead(ctx) {
  const { state, clarity = 0, situation = 'neutral', intent = null, rng = Math.random } = ctx;

  // 有 live intent 时优先给倾向信息；清晰度越高，越可能给到「清晰档」
  if (intent && INTENT_LINES[intent] && situation === 'bet') {
    const pool = INTENT_LINES[intent];
    const tier = rng() < 0.35 + clarity * 0.3 ? 1 : 0;
    const pickFrom = pool[tier].length ? pool[tier] : pool[0];
    if (rng() > 0.25) {
      return pickFrom[Math.floor(rng() * pickFrom.length)];
    }
    // 25% 概率改给情绪信息，避免 READ 变成答案机
  } else if (intent && INTENT_LINES[intent] && situation === 'checked') {
    const pool = INTENT_LINES[intent];
    const tier = rng() < 0.3 + clarity * 0.3 ? 1 : 0;
    const pickFrom = pool[tier].length ? pool[tier] : pool[0];
    if (rng() > 0.3) return pickFrom[Math.floor(rng() * pickFrom.length)];
  }

  const statePool = STATE_LINES[state] ?? STATE_LINES.CALM;
  return statePool[Math.floor(rng() * statePool.length)];
}
