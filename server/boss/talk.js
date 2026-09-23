/**
 * Boss 台词池与选词（v3）。
 *
 * 情绪三状态 × 意图五桶。没有矛盾检测 —— 台词只承担「人格与情绪的表达」，
 * 真正的心理攻防交给 READ 碎片与 GOTCHA。
 * intent ∈ VALUE | BLUFF | PROBE | TRAP | CONTROL
 */

const L = (t) => t;

/** state -> intent -> 台词池；intent 缺失回落 any。 */
export const TALK = {
  CALM: {
    VALUE: [
      L('继续也可以。'),
      L('这注不重，你跟得起。'),
      L('该拿的，我一分不让。'),
      L('按你的水平，这注应该接得住。'),
    ],
    BLUFF: [
      L('这一手，你最好别碰。'),
      L('你猜我有什么？猜错了就盖牌。'),
      L('别接，接了你会后悔。'),
      L('我不太想解释这一注。'),
    ],
    PROBE: [
      L('我先看看你怎么想。'),
      L('小注，买你一个答案。'),
      L('试探一下，别紧张。'),
      L('随便推一点，看牌面说话。'),
    ],
    TRAP: [
      L('我不急，你先。'),
      L('这牌我拿着挺舒服的。'),
      L('你请，我就看看。'),
    ],
    CONTROL: [
      L('这一手我不想惹事。'),
      L('先看看下一张。'),
      L('到此为止，稳一点。'),
    ],
    any: [L('嗯。'), L('过。'), L('跟上。')],
  },

  SHAKEN: {
    VALUE: [
      L('别误会，我只是不想把事情搞大。'),
      L('这注是给你机会。'),
      L('……跟上，别磨蹭。'),
      L('我算过了，你不行。'),
    ],
    BLUFF: [
      L('怎么，不敢跟？'),
      L('你要是有牌，早就加回来了。'),
      L('这一注你接不住。'),
      L('你现在的表情，和被偷鸡时一模一样。'),
    ],
    PROBE: [
      L('我就随便推一点。'),
      L('别想太多，一注而已。'),
      L('先给你点压力，不多。'),
    ],
    TRAP: [
      L('来啊，你不是挺会看吗。'),
      L('我等着呢。'),
      L('这牌我没什么好急的。'),
    ],
    CONTROL: [
      L('这一手我不想冒险。'),
      L('先稳住。'),
      L('……别在这个时候逼我。'),
    ],
    any: [L('……过。'), L('你到底跟不跟？'), L('哼。')],
  },

  EXPOSED: {
    VALUE: [
      L('你不是很会看吗？继续。'),
      L('这次我让你看个够。'),
      L('跟啊，别让我失望。'),
      L('我今天就要在这里解决你。'),
    ],
    BLUFF: [
      L('你凭什么觉得你能赢我？'),
      L('这一注，你不敢接。'),
      L('全推给你，敢不敢？'),
      L('我就知道你到这就怂了。'),
    ],
    PROBE: [
      L('别急，大的还在后面。'),
      L('先给你尝尝味道。'),
      L('这一注只是开胃菜。'),
    ],
    TRAP: [
      L('来啊！我就等你进来。'),
      L('你敢打，我就敢收。'),
    ],
    CONTROL: [
      L('我没上头，你少来这套。'),
      L('这注不代表什么。'),
      L('……我只是不想把底池交给你。'),
    ],
    any: [L('说话啊，怎么不说话了？'), L('继续。'), L('……闭嘴打牌。')],
  },
};

/**
 * v6 §8：CRACK 即时受创反应（短、愣、真实）。
 * battle 在 crack 事件后立刻抽一条 → Player 脑中立即建立「READ + 行动 = 打中他」。
 */
export const CRACK_REACT = [
  '……',
  '他真的跟了？',
  '……你读到了。',
  '这下疼了。',
  '等等——你怎么敢的。',
];
export const pickCrackReact = (rng = Math.random) =>
  CRACK_REACT[Math.floor(rng() * CRACK_REACT.length)];

/** 赢下一手之后的台词（按情绪抽）。 */
export const WIN_QUIP = {
  CALM: [L('收了。'), L('这手该我赢。')],
  SHAKEN: [L('总算赢一把。'), L('……我就说没问题。')],
  EXPOSED: [L('早该如此！'), L('看清楚，这才是我。')],
};

/** 抽一句赢牌台词；返回 null 表示沉默。 */
export function pickWinQuip(state, chance, rng = Math.random) {
  if (rng() > chance) return null;
  const pool = WIN_QUIP[state] ?? WIN_QUIP.CALM;
  const pick = pool[Math.floor(rng() * pool.length)];
  return pick ?? null;
}

/** 选一句台词。 */
export function pickLine({ state, intent, rng = Math.random }) {
  const byState = TALK[state] ?? TALK.CALM;
  const pool = (intent && byState[intent]?.length ? byState[intent] : byState.any) ?? byState.any;
  const text = pool[Math.floor(rng() * pool.length)];
  return text ?? '……';
}

/** Boss 最终的 Heart：筹码归零时播放。 */
export const FINAL_HEART = '我只是……不想承认你真的看穿我了。';
/** 玩家筹码归零时的收场白。 */
export const DEFEAT_LINE = '……你终于也空了。筹码和自信，一样都不能少。';
