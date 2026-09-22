/**
 * READ 读心台词池。
 *
 * READ 只给「情绪和倾向」，永远不宣布牌力。输出结构：
 *   { text, lean, leanLabel }
 * - text：模糊的心理信息（spec 原味台词）
 * - lean：他当前的期望方向（他希望你出什么牌）——判断轴，不是答案。
 *   玩家拿 lean × 自己的牌 × 他的注码三方对照，决定信还是不信。
 *   神了(FLOW)雾化、状态线、势头线不带 lean（读不出 = READ 的合法输出）。
 *
 * 信息清晰度由 mental state 决定：崩坏藏不住事；神了读不出来。
 */

/** 期望方向 → 玩家看到的标签。 */
export const LEANS = {
  fold: '他想让你弃牌',
  call: '他欢迎你跟',
  trap: '他在等你犯错',
  unsure: '他自己也没底',
};

/** intent → 他希望你干什么。 */
const LEAN_OF_INTENT = {
  BLUFF: 'fold',
  VALUE: 'call',
  TRAP: 'trap',
  PROBE: 'unsure',
  POT_CONTROL: null,
};

/** 神了(FLOW)：READ 起雾 —— 读到的只有自信。 */
export const FOG_LINES = [
  '他现在像换了个人——读不出来。',
  '顺得离谱，你在他眼里是透明的。',
  '你读到的只有自信，没有犹豫。',
  '他不需要演，所以什么都读不到。',
];

/** 顺风（最近在赢）时能读到的势头线。 */
export const MOMENTUM_POS_LINES = [
  '他刚赢一把，正在兴头上。',
  '手风顺的时候，人话都变多了。',
  '他看你的眼神都轻松了 —— 他觉得自己赢定了。',
];

/** 逆风（被碾压）时能读到的势头线。 */
export const MOMENTUM_NEG_LINES = [
  '他连输几手，已经在咬牙了。',
  '他推筹码的手比开局时重了。',
  '他一直在盯着你的筹码堆看。',
];

/** 按意图分组；tier: 0=模糊 1=较清晰（clarity 越高越可能抽到 1） */
export const INTENT_LINES = {
  BLUFF: {
    0: [
      '他似乎非常期待你弃牌。',
      '他把气氛绷得很紧，像是不想让这一注被接住。',
      '他嘴上很强硬，但一直在观察你的反应。',
    ],
    1: [
      '这次下注之后，他反而更加紧张了——他希望你盖牌。',
      '他强硬得很用力，像是排练过的。',
      '他真正在意的不是底池，是你会不会跟。',
    ],
  },
  VALUE: {
    0: [
      '他说完这句话之后反而放松了下来。',
      '他不介意你跟注，甚至有点希望你跟。',
      '他的下注没有犹豫。',
    ],
    1: [
      '他希望你接这一注——越快越好。',
      '他现在的姿态是「来吧」，不是「走开」。',
    ],
  },
  TRAP: {
    0: [
      '他把整条路让给了你，注意力却一直停在你身上。',
      '他不急，他在等你先动手。',
      '他的放松不像是真的。',
    ],
    1: [
      '他在等你犯错，等得很有耐心。',
      '他不怕你下注——这本身就很可疑。',
    ],
  },
  POT_CONTROL: {
    0: [
      '他现在的动作很小心，像是不想把事情闹大。',
      '他更在意别失去什么，而不是赢得什么。',
      '他收着打，像是手里没有底气。',
    ],
    1: [
      '他在按住底池，也在按住自己的表情。',
    ],
  },
  PROBE: {
    0: [
      '这更像是一次试探，他在等你的反应。',
      '他没把这一注当真，他在看你。',
      '他先出了一张牌，像是在问问题。',
    ],
    1: [
      '他自己也没想清楚，所以先推一点来看看。',
    ],
  },
};

/** 没有 live intent 时按状态抽。 */
export const STATE_LINES = {
  FLOW: [
    '他的状态好得反常 —— 别读了，读不出来。',
    '他打牌像是在散步，一点破绽都不给。',
  ],
  HOT: [
    '他现在满脑子都是「我今天赢定了」。',
    '他整个人都是松的 —— 赢钱的人不设防。',
  ],
  CALM: [
    '他看上去和开局时没什么两样。',
    '他很安静，安静得像是什么都没想。',
    '他正按自己的节奏打，没有被你打乱。',
  ],
  SHAKEN: [
    '他明显比刚才更加急躁。',
    '他正在努力维持镇定。',
    '他的视线比之前频繁地往你这边飘。',
    '他嘴上在硬撑，节奏已经乱了。',
  ],
  TILT: [
    '他的注意力一直停留在你的反应上。',
    '比起赢钱，他现在更想赢你。',
    '他下注前的停顿变短了——他在赌气。',
    '他几乎不再看自己的牌，只在看你。',
  ],
  BREAKING: [
    '他快把自己的答案写在脸上了。',
    '他一边说话一边推筹码——手比脑子快。',
    '他已经分不清自己是想赢还是想被看穿。',
  ],
};

const pick = (arr, rng) => arr[Math.floor(rng() * arr.length)];

/**
 * 抽一条 READ。
 * @param {{state, clarity, situation, intent, momentum?, rng}} ctx
 * @returns {{text: string, lean: string|null, leanLabel: string|null}}
 */
export function pickRead(ctx) {
  const {
    state = 'CALM', clarity = 0, situation = 'neutral',
    intent = null, momentum = 0, rng = Math.random,
  } = ctx;

  // 神了：READ 雾化（合法输出 = 读不出来）
  if (state === 'FLOW') {
    return { text: pick(FOG_LINES, rng), lean: null, leanLabel: null };
  }

  // 势头线：顺风/逆风是公开信息（筹码流向）的合理读法
  if (momentum > 0 && rng() < 0.3) {
    return { text: pick(MOMENTUM_POS_LINES, rng), lean: null, leanLabel: null };
  }
  if (momentum < 0 && rng() < 0.35) {
    return { text: pick(MOMENTUM_NEG_LINES, rng), lean: null, leanLabel: null };
  }

  // 有 live intent：优先给倾向信息（带 lean），清晰度越高越可能给到清晰档
  if (intent && INTENT_LINES[intent] && situation === 'bet') {
    const pool = INTENT_LINES[intent];
    const tier = rng() < 0.35 + Math.max(0, clarity) * 0.3 ? 1 : 0;
    const pickFrom = pool[tier].length ? pool[tier] : pool[0];
    if (rng() > 0.25) {
      const lean = LEAN_OF_INTENT[intent] ?? null;
      return { text: pick(pickFrom, rng), lean, leanLabel: lean ? LEANS[lean] : null };
    }
    // 25% 概率改给情绪信息，避免 READ 变成答案机
  } else if (intent && INTENT_LINES[intent] && situation === 'checked') {
    const pool = INTENT_LINES[intent];
    const tier = rng() < 0.3 + Math.max(0, clarity) * 0.3 ? 1 : 0;
    const pickFrom = pool[tier].length ? pool[tier] : pool[0];
    if (rng() > 0.3) {
      const lean = LEAN_OF_INTENT[intent] ?? null;
      return { text: pick(pickFrom, rng), lean, leanLabel: lean ? LEANS[lean] : null };
    }
  }

  const statePool = STATE_LINES[state] ?? STATE_LINES.CALM;
  return { text: pick(statePool, rng), lean: null, leanLabel: null };
}
