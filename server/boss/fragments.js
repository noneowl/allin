/**
 * READ 心理碎片（方案 §13-15）。
 *
 * 玩家在 Boss 重要行动后连续发动 READ，每次闪现一条 0.5–1.5s 的碎片。
 * 类型与标签**只在服务端**，玩家只能看到 text：
 *   TRUE        —— 真实心理泄漏，携带语义标签，构成证据链 → CRACK
 *   NOISE       —— 真实但与判断无关的念头（CALM 时的主体）
 *   DISTORTION  —— 他自己的错误判断/自我安慰/过度自信（内容来自真实意识，但可能是错的）
 *
 * 取比例按情绪状态（balance.json `read.mix`）；EXECUTION 模式 TRUE 权重上调、显示更快。
 */

/** TRUE 碎片家族：tag → 文案池。只有 TRUE 带标签。 */
export const TRUE_FAMILIES = {
  wants_fold: [
    '最好现在结束。',
    '最好别跟。',
    '这注你接不住。',
    '我真希望他直接盖牌。',
  ],
  fear_call: [
    '千万别接。',
    '接了就糟了。',
    '我最怕他这时候跟。',
  ],
  fear_raise: [
    '他可别再加了。',
    '千万别加注。',
    '他一动手我就难受。',
  ],
  weak_hand: [
    '这一手没什么底气。',
    '撑不了几条街。',
    '手里是空的。',
  ],
  missed_board: [
    '这张没帮到我。',
    '牌面没理我。',
    '又没中。',
  ],
  draw: [
    '还差一张。',
    '再来一张就有。',
    '就差那一张。',
  ],
  strong_hand: [
    '这一手已经足够。',
    '牌会替我说话。',
    '来吧，我不介意。',
  ],
  call_welcome: [
    '他跟进来最好。',
    '我希望他付出代价。',
    '接吧，求之不得。',
  ],
  trap: [
    '不急，让他先动。',
    '让他先犯错。',
    '网已经撒好了。',
  ],
  board_lock: [
    '这牌面听我的。',
    '谁也改不了这个牌面。',
  ],
  overconfidence: [
    '没人读得懂我。',
    '今天我每一手都对。',
  ],
};

/** NOISE：真实但无关的念头。 */
export const NOISE_POOL = [
  '这个灯太亮了。',
  '他又在看我。',
  '上一手不该这么打。',
  '盲注又涨了。',
  '袖口有点紧。',
  '手指有点干。',
  '外面在下雨吗？',
  '这首曲子听过。',
  '水太凉了。',
];

/** DISTORTION：他自己的错误判断与自我安慰（无标签 —— 谎言不成链）。 */
export const DISTORTION_POOL = {
  CALM: [
    '他一定会 Fold。',
    '没什么好担心的。',
    '局面在我手里。',
  ],
  SHAKEN: [
    '我已经完全掌控局面了。',
    '他拿着空气。',
    '这注足够吓他了。',
    '他不敢动了。',
  ],
  EXPOSED: [
    '他每一手都在虚张声势。',
    '我今天的读牌准得可怕。',
    '他绝对接不住。',
    '运气迟早回到我这边。',
    '他在等我犯错？做梦。',
  ],
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * TRUE 碎片的家族选择：由 Boss 真实处境（intent + 胜率）决定 —— TRUE 必须是真的。
 * @returns {string|null} tag，null 表示没有可用的真实泄漏（回落 NOISE）
 */
function pickTrueFamily(ctx, rng) {
  const { intent, equity = 0.5, street = 'flop' } = ctx;
  if (!intent) return null;
  const mid = equity >= 0.32 && equity <= 0.58 && (street === 'flop' || street === 'turn');
  if (mid && rng() < 0.35) return 'draw';

  let weights;
  if (intent === 'BLUFF' || intent === 'PROBE') {
    weights = [
      ['wants_fold', 0.32],
      ['fear_call', 0.24],
      ['fear_raise', 0.24],
      ['missed_board', 0.1],
      ['weak_hand', 0.1],
    ];
  } else if (intent === 'VALUE') {
    weights = [
      ['strong_hand', 0.42],
      ['call_welcome', 0.33],
      ['board_lock', 0.15],
      ...(equity >= 0.72 ? [['overconfidence', 0.1]] : []),
    ];
  } else if (intent === 'TRAP') {
    weights = [['trap', 0.5], ['strong_hand', 0.3], ['call_welcome', 0.2]];
  } else {
    // CONTROL：手里有货但收着打
    weights = [['board_lock', 0.35], ['strong_hand', 0.3], ['trap', 0.2], ['call_welcome', 0.15]];
  }
  const total = weights.reduce((s, [, w]) => s + w, 0);
  let roll = rng() * total;
  for (const [tag, w] of weights) {
    roll -= w;
    if (roll <= 0) return tag;
  }
  return weights[0][0];
}

/**
 * 生成一条碎片。
 * @param {object} ctx { state, intent, equity, street, trueRate?, balance, rng }
 *   - trueRate（可选）：直接指定 TRUE 概率（GOTCHA 自动泄漏按深度传入），
 *     剩余概率按状态表在 NOISE / DISTORTION 之间分配；不传则用状态 mix 表。
 * @returns {{ text, type, tags: string[], strength }}
 */
export function makeFragment(ctx) {
  const { state = 'CALM', intent, equity = 0.5, street = 'flop', trueRate, balance, rng = Math.random } = ctx;
  const read = balance.read;

  let type;
  if (typeof trueRate === 'number' && trueRate >= 0) {
    const mix = read.mix[state] ?? read.mix.CALM;
    const rest = 1 - trueRate;
    const noiseShare = (mix.NOISE ?? 0.2) / Math.max(0.001, (mix.NOISE ?? 0.2) + (mix.DISTORTION ?? 0.2));
    if (rng() < trueRate) type = 'TRUE';
    else type = rng() < noiseShare ? 'NOISE' : 'DISTORTION';
    void rest;
  } else {
    const mix = { ...(read.mix[state] ?? read.mix.CALM) };
    const total = Object.values(mix).reduce((s, w) => s + w, 0);
    let roll = rng() * total;
    type = 'NOISE';
    for (const [t, w] of Object.entries(mix)) {
      roll -= w;
      if (roll <= 0) { type = t; break; }
    }
  }

  // Boss 还没做过重要行动 → 没有 intent 可泄漏，绝不产出 TRUE
  if (type === 'TRUE' && !intent) type = rng() < 0.5 ? 'NOISE' : 'DISTORTION';

  if (type === 'NOISE') {
    return {
      text: NOISE_POOL[Math.floor(rng() * NOISE_POOL.length)],
      type, tags: [], strength: 0.2,
    };
  }

  if (type === 'DISTORTION') {
    const pool = DISTORTION_POOL[state] ?? DISTORTION_POOL.CALM;
    return {
      text: pool[Math.floor(rng() * pool.length)],
      type, tags: [], strength: 0.35,
    };
  }

  // TRUE
  const family = pickTrueFamily(ctx, rng);
  if (!family) {
    return {
      text: NOISE_POOL[Math.floor(rng() * NOISE_POOL.length)],
      type: 'NOISE', tags: [], strength: 0.2,
    };
  }
  const pool = TRUE_FAMILIES[family];
  const base = 0.55 + rng() * 0.3 + (state === 'EXPOSED' ? 0.1 : 0);
  return {
    text: pool[Math.floor(rng() * pool.length)],
    type: 'TRUE',
    tags: [family],
    strength: clamp(base, 0, 0.95),
  };
}

/** 碎片闪现时长（毫秒）。GOTCHA 自动泄漏由调用方乘 `gotcha.flashScale`。 */
export function flashMs(state, balance) {
  return balance.read.flashMs?.[state] ?? 1000;
}
