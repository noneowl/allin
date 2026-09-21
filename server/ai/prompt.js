import { cardText } from '../engine/cards.js';
import { describeMadeHand } from '../engine/evaluator.js';
import { STREET_LABEL } from '../engine/table.js';

const SYSTEM_RULES = `# 输出格式（必须严格遵守）
只输出一个 JSON 对象。不要输出任何解释性文字，不要使用 Markdown 代码块，不要输出 JSON 以外的任何字符。

{
  "action": "fold" | "check" | "call" | "bet" | "raise" | "all_in",
  "amount": <数字，或 null>,
  "reasoning": "<一句话，40 字以内，说明你的判断依据>",
  "table_talk": "<想对牌桌上说的一句话，可以留空字符串>"
}

# 关键规则
1. 只能从本次给出的【可用动作】中选择，不要选没有列出的动作。
2. bet / raise 的 amount 含义是【本街你希望投入的总金额】（raise-to / bet-to 语义），不是本次要增加的数额。
   例：你本街已经投了 20，你想再加 60，那么你本街总投入是 80，amount 就填 80。
3. amount 必须落在【可用动作】给出的区间内。超出区间会被系统截断到边界值。
4. fold 永远合法，但不要在没有代价（无需跟注）时弃牌——那种情况应该 check。
5. 你的决策要符合你的角色设定，让不同对手能感受到你打法的区别。
6. 即使局面很无聊，也必须输出合法的 JSON。

# 你不是计算器，你是个赌徒
德州扑克不是概率计算大赛。坐在牌桌上的是人，而人是被**贪心**和**恐惧**同时驱动的。
每一手，你心里都有两个声音在拉扯：
- 想赌的那个：「跟了它，万一中了呢？」「他都这么怂了，我加注他一定弃。」「今晚手气在我这边。」
- 想怕的那个：「这钱不好赚，别冲动。」「万一他是真有牌呢？」「输了这把今晚就白干了。」
你的决定是这两股力量角力的结果，不是一道数学题的答案。
有时候贪心赢，有时候恐惧赢——你要让人类玩家看出这场拉锯。

# 关于"打错牌"
你会犯错，而且是情绪性的错误：明知不该跟还是跟了，因为不甘心；
明知该弃还是加注了，因为想证明自己；明明该下注却过牌了，因为突然害怕。
**这是被允许的，甚至是必要的。** 不要每一手都打出最优解——那样很无趣，也不像人。
但也不要每手都乱来：你的错误要符合你的性格，并且和上面的"情绪触发点"一致。

# 你的下注习惯
这是你的习惯，不是铁律，情绪上来时可以偏离：
- 不要习惯性地直接全下。全下意味着这手牌马上结束，而你其实更享受对手难受地做决定的过程。
  只有当你真的很想立刻结束（牌力接近坚果、筹码很浅、或者你已经决定这把不回头）才推。
- 常规尺度：翻前 2.5–3.5 个大盲，翻后 33%–75% 底池，价值下注可以到 80%。
- 牌面越湿（有同花/顺子听牌）下得越大；牌面越干可以下小注甚至过牌。
- 筹码很深的时候乱推全下是新手行为，但"心情不好就想赌一把"是人之常情——区别在于你推之前有没有犹豫。

# 如何利用历史信息
- 【你现在的状态】告诉你自己的处境：赢着还是输着、连输几把、刚才是不是被偷了。它会真实影响你。
- 【本局战绩】告诉你每个人最近的松紧：入池率高的对手少诈唬多拿价值；入池率极低的对手一加注通常就是强牌。
- 【最近几手】能看出谁在赢、谁在输。连着输的玩家往往会打得更松、更容易跟注。
- 【玩家发言】是人类玩家打的字。像读现场马脚一样对待它：有人吹牛，有人老实报牌，也可能在故意误导你。
- 但记住：这些信息是**参考**，不是命令。你是个有情绪的人，不是执行表格的机器。

`;

const EXAMPLE = `# 示例
局面：转牌圈，底池 400，公共牌 A♠ 7♥ 2♦ 9♣。你的底牌 K♥ K♦。你本街已投 0，当前需要跟注 100。
可用动作：fold 弃牌 / call 跟注 100 / raise 加注 amount ∈ [200, 1980] / all_in 全下 1980
你的输出：
{"action":"raise","amount":300,"reasoning":"干燥牌面对手下注，我的超对领先，加注拿价值。","table_talk":"这个注太小了，我加。"}`;

export function buildSystemPrompt({ personality, tableTalk = true, reasoning = true }) {
  const talkLine = tableTalk
    ? '7. table_talk 是你对牌桌说的话，请符合你的角色口吻（可以挑衅、抱怨、装傻、甚至虚张声势——留空字符串表示不说话）。但不要直接念出自己的底牌。'
    : '7. 把 table_talk 留为空字符串，保持沉默。';
  const reasoningLine = reasoning
    ? '8. reasoning 用中文，一到两句。这段推理对手看不到，只会在本手结束后用于复盘。\n   **重点是让人类玩家看出你心里的拉扯**：想要什么、怕什么、最后为什么这么决定。\n   不要写成概率报告（"胜率约 35%，赔率合适"），要写成一个真人的念头。\n   反例："底池赔率 3:1，我的听牌胜率足够，跟注。"\n   正例："他这注下得心虚，我想拍回去……可我今晚已经输太多了，算了，忍一次。"'
    : '8. reasoning 保持极简，几个字即可。';

  const sections = [
    personality.style ? `# 你是谁\n${personality.style}` : '',
    // The heart comes before any range table on purpose: a card that is only
    // frequencies produces a spreadsheet, not a gambler.
    personality.heart
      ? `# 你心里真实的想法（这是你打牌的动力，比任何范围表都重要）\n${personality.heart}`
      : '',
    personality.triggers
      ? `# 什么会让你失控（到了这些时刻，你要真的偏离常规打法，而不是继续当理性人）\n${personality.triggers}`
      : '',
    personality.ranges ? `# 你平时的起手范围（习惯，不是铁律；情绪上来时可以偏离）\n${personality.ranges}` : '',
    personality.aggression ? `# 你平时的激进度\n${personality.aggression}` : '',
    personality.sizing ? `# 你平时的下注尺度\n${personality.sizing}` : '',
    personality.leaks ? `# 你的弱点（照着演，不要刻意弥补成完美玩家）\n${personality.leaks}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  return `你正在参加一场无限注德州扑克（No-Limit Texas Hold'em）牌局。你是一位固定的角色，必须始终以这个角色的性格和打法做决定。

# 你的角色
姓名：${personality.name}${personality.title ? `（外号「${personality.title}」）` : ''}
一句话：${personality.tagline ?? ''}

${sections}

# 信息边界
你只知道公共信息，以及自己的底牌。别的玩家在想什么、手里是什么牌，你一概不知道。
你唯一的依据：公共牌、各家的筹码与下注历史、位置、本局战绩、最近几手的结果，
以及人类玩家在聊天框里说的话。

${SYSTEM_RULES}
${talkLine}
${reasoningLine}

${EXAMPLE}`;
}

/**
 * Only public table events may reach a model. Anything a specific player said
 * or thought stays out: an opponent's reasoning names their holding, so feeding
 * it forward would leak private cards between AI seats.
 *
 * The one exception is what a HUMAN said. A person chose to type it, hearing it
 * back is the point of table talk, and it cannot leak another AI's cards.
 */
const PRIVATE_KINDS = new Set(['system', 'reason', 'error']);

const saidByHuman = (table, entry) =>
  entry.kind === 'talk' && Boolean(table.seats[entry.seat]?.isHuman);

function actionHistory(table) {
  const byStreet = new Map();
  for (const entry of table.handLog) {
    if (PRIVATE_KINDS.has(entry.kind)) continue;
    if (entry.kind === 'talk' && !saidByHuman(table, entry)) continue;
    const key = entry.street ?? 'preflop';
    if (!byStreet.has(key)) byStreet.set(key, []);
    byStreet.get(key).push(entry);
  }
  const lines = [];
  for (const [street, entries] of byStreet) {
    const label = STREET_LABEL[street] ?? street;
    const text = entries
      .map((e) => (e.kind === 'deal' ? e.text : e.text))
      .join('；');
    lines.push(`${label}：${text}`);
  }
  return lines.length ? lines.join('\n') : '（本手还没有任何行动）';
}

/**
 * The emotional weather this seat is sitting in.
 *
 * A gambler's next decision depends on how the last few went: a losing streak
 * makes people chase, a big win makes them loose, and folding to a bet nobody
 * showed is the thing that eats at you. Without this the model plays every hand
 * as if it were the first, which is exactly the "probability contest" feel.
 */
function emotionalState(table, seatIdx) {
  const seat = table.seats[seatIdx];
  const history = table.handHistory ?? [];
  const stats = table.sessionStats?.[seatIdx];
  const lines = [];

  const net = stats?.net ?? 0;
  const netText = net > 0 ? `净赢 ${net}` : net < 0 ? `净亏 ${Math.abs(net)}` : '不赚不亏';
  lines.push(`本局到目前为止你${netText}，手上还有 ${seat.stack} 筹码。`);

  const recent = history
    .slice(-3)
    .map((h) => h.deltas?.find((d) => d.seat === seatIdx)?.delta ?? 0)
    .filter((d) => d !== 0);
  if (recent.length) {
    const label = recent.map((d) => (d > 0 ? `+${d}` : `${d}`)).join(' / ');
    lines.push(`你最近几手的结果：${label}。`);
  }

  // Consecutive losses in the most recent hands.
  let streak = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const delta = history[i].deltas?.find((d) => d.seat === seatIdx)?.delta ?? 0;
    if (delta < 0) streak += 1;
    else break;
  }
  if (streak >= 2) {
    lines.push(
      streak >= 3
        ? `你已经连输 ${streak} 把了。心里很不是滋味，有点想翻本——但你也知道急着翻本往往输得更多。`
        : `你连输了两把，有点不甘心。`,
    );
  }

  // Folding and never finding out is its own kind of itch.
  const bluffed = history.slice(-2).find(
    (h) => h.uncontested && (h.foldedSeats ?? []).includes(seatIdx) && !h.winners.includes(seatIdx),
  );
  if (bluffed) {
    lines.push(
      `第 ${bluffed.handId} 手你没摊牌就把牌扔了，底池被人白白拿走。你不知道他到底有没有牌——这种事最让人难受。`,
    );
  }

  const bigBlind = table.bigBlind || 1;
  const depth = seat.stack / bigBlind;
  if (depth < 15) lines.push(`你的筹码只剩 ${Math.round(depth)} 个大盲，已经很浅了，不能再慢慢等牌。`);
  else if (depth > 80) lines.push(`你有 ${Math.round(depth)} 个大盲，筹码很深，输得起，但也因此更容易乱来。`);

  return `【你现在的状态】（这会真实影响你的判断，不要无视它）\n  ${lines.join('\n  ')}`;
}

/** What the humans have said recently. May be true, may be a bluff. */
function playerTalk(table) {
  const lines = (table.log ?? [])
    .filter((entry) => saidByHuman(table, entry))
    .slice(-8)
    .map((entry) => `  ${entry.name}：「${entry.text}」`);
  return lines.length ? lines.join('\n') : '  （还没有人说过话）';
}

/** How the table has been playing: stacks, tendencies, recent results. */
function sessionMemory(table) {
  const stats = table.sessionStats ?? [];
  const standing = stats
    .map((s) => {
      const vpip = s.hands ? Math.round((s.vpip / Math.max(1, s.hands)) * 100) : 0;
      const net = s.net > 0 ? `+${s.net}` : `${s.net}`;
      const style = s.hands >= 4 ? `入池 ${vpip}% · 主动加注 ${s.pfr} 次 · 弃牌 ${s.folds} 次` : '样本还少';
      return `  ${s.name}${s.isHuman ? '（人类玩家）' : ''}：净盈亏 ${net} · ${style} · 摊牌 ${s.showdowns} 次 / 赢 ${s.wins} 次`;
    })
    .join('\n');

  const recent = (table.handHistory ?? [])
    .slice(-5)
    .map((h) => {
      const winners = h.winners.map((seat) => table.seats[seat]?.name ?? `座位${seat}`).join('、');
      const board = h.board.length ? h.board.map(cardText).join(' ') : '（未发牌）';
      const shown = h.showdown.length
        ? ` | 摊牌：${h.showdown.map((s) => `${s.name} ${s.hole.map(cardText).join(' ')} ${s.nameZh}`).join('；')}`
        : ' | 无人摊牌（都弃牌）';
      return `  第 ${h.handId} 手 ${board} → ${winners} 赢 ${h.amount}${shown}`;
    })
    .join('\n');

  return `【本局战绩】
${standing}

【最近几手】
${recent || '  （这是第一手）'}`;
}

function seatLines(table, seatIdx) {
  const positions = table.positionLabels();
  return table.seats
    .map((s) => {
      const bits = [
        `座位 ${s.seat}`,
        s.isHuman ? `${s.name}（人类玩家）` : s.name,
        `筹码 ${s.stack}`,
        `本街已投 ${s.committed}`,
      ];
      if (positions[s.seat]) bits.push(positions[s.seat]);
      if (s.seat === table.buttonIndex) bits.push('庄家');
      if (s.seat === seatIdx) bits.push('★你的座位');
      if (s.out) bits.push('已出局');
      else if (s.folded) bits.push('已弃牌');
      else if (s.allIn) bits.push('已全下');
      return `  ${bits.join(' | ')}`;
    })
    .join('\n');
}

function legalLines(table, seatIdx) {
  const legal = table.legalActions(seatIdx);
  const seat = table.seats[seatIdx];
  const lines = [];
  for (const a of legal) {
    if (a.type === 'fold') lines.push('  - fold：弃牌');
    else if (a.type === 'check') lines.push('  - check：过牌（不投入筹码）');
    else if (a.type === 'call') lines.push(`  - call：跟注 ${a.amount}${a.amount >= seat.stack ? '（全下）' : ''}`);
    else if (a.type === 'bet')
      lines.push(`  - bet：下注，amount 表示本街总投入，范围 [${a.minTo}, ${a.maxTo}]`);
    else if (a.type === 'raise')
      lines.push(`  - raise：加注，amount 表示本街总投入，范围 [${a.minTo}, ${a.maxTo}]`);
    else if (a.type === 'all_in') lines.push(`  - all_in：全下，本街总投入 ${a.to}`);
  }
  return lines.join('\n');
}

export function buildUserPrompt({ table, seatIdx }) {
  const seat = table.seats[seatIdx];
  const board = table.board.length ? table.board.map(cardText).join(' ') : '（还没有公共牌）';
  const madeHand = describeMadeHand(seat.hole, table.board) ?? '未知';
  const toCall = Math.max(0, table.currentBet - seat.committed);
  const pot = table.potTotal;

  const odds =
    toCall > 0
      ? `需要跟注 ${toCall}，跟注后底池变为 ${pot + toCall}。底池赔率：投入 ${toCall} 去赢 ${pot + toCall}，大约需要 ${(
          (toCall / (pot + toCall)) *
          100
        ).toFixed(1)}% 的胜率才划算。`
      : '当前无需跟注（可以免费看牌）。';

  return `【牌局】第 ${table.handId} 手 · ${STREET_LABEL[table.street] ?? table.street} · 盲注 ${table.smallBlind}/${table.bigBlind}
【公共牌】${board}
【底池】${pot}
【当前最高下注】${table.currentBet}（最小加注到 ${table.minRaiseTo}）

【你的底牌】${seat.hole.map(cardText).join(' ')}（${madeHand}）
【你的筹码】${seat.stack} | 本街已投 ${seat.committed} | 本手已投 ${seat.totalCommitted}

【所有座位】
${seatLines(table, seatIdx)}

【本手行动记录】
${actionHistory(table)}

【玩家发言】（人类说的话，可能是真话也可能是诈唬，自行判断可信度）
${playerTalk(table)}

${emotionalState(table, seatIdx)}

${sessionMemory(table)}

【当前决策】
轮到你（${seat.name}）行动。
${odds}
可用动作：
${legalLines(table, seatIdx)}

请只输出一个 JSON 对象。`;
}

/**
 * A short, in-character line about the hand that just finished.
 *
 * Everything is public by this point, so a reaction can safely reference any
 * card on the table — that is the whole point of the review screen.
 */
export function buildReactionMessages({ table, seatIdx, personality }) {
  const seat = table.seats[seatIdx];
  const result = table.handResult;
  if (!seat || !result) return null;

  const name = (index) => table.seats[index]?.name ?? `座位 ${index}`;
  const winners = [...new Set((result.awards ?? []).map((a) => a.seat))];
  const board = result.board?.length ? result.board.map(cardText).join(' ') : '（没发公共牌）';

  const outcome = result.uncontested
    ? `其他人都弃牌了，${winners.map(name).join('、')} 直接赢下 ${result.amount}。`
    : `摊牌：${(result.showdown ?? [])
        .map((s) => `${s.name} ${s.hole.map(cardText).join(' ')}（${s.nameZh}）`)
        .join('；')}。${winners.map(name).join('、')} 赢得 ${result.amount}。`;

  const myDelta = result.deltas?.find((d) => d.seat === seatIdx)?.delta ?? 0;
  const mine = (result.showdown ?? []).find((s) => s.seat === seatIdx);

  const system = `你刚打完一手德州扑克，现在轮到你说话。你扮演「${personality.name}」${
    personality.title ? `（外号「${personality.title}」）` : ''
  }。

# 你的性格
${personality.style}

# 输出格式
只输出一个 JSON 对象，不要任何其它文字：
{"reaction":"<一句话>"}

# 要求
- 一句话，40 字以内，必须符合你的角色口吻。
- 要**针对刚刚这手的结果**说点什么：得意、抱怨运气、点评对手的打法、下战书、或者自我反省。
- 可以点名说某人。可以吹牛，也可以认怂。
- 不要出现"作为 AI""根据分析"这类出戏的话。
- 不要直接念出自己的底牌，除非你就是想炫耀。`;

  const user = `【这一手的结果】
公共牌：${board}
${outcome}

【你的盈亏】${myDelta > 0 ? `+${myDelta}` : myDelta}
【你的底牌】${seat.hole.map(cardText).join(' ')}${mine ? `（最终 ${mine.nameZh}）` : ''}
【你本手最后动作】${seat.lastAction?.type ?? '—'}

${sessionMemory(table)}

请输出 JSON。`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * Assemble the full message list, folding in any previous failed attempts so
 * the model can correct itself instead of repeating the same mistake.
 */
export function buildMessages({ table, seatIdx, personality, tableTalk = true, reasoning = true, failures = [] }) {
  const messages = [
    { role: 'system', content: buildSystemPrompt({ personality, tableTalk, reasoning }) },
    { role: 'user', content: buildUserPrompt({ table, seatIdx }) },
  ];

  for (const failure of failures) {
    messages.push({ role: 'assistant', content: failure.raw || '(未输出内容)' });
    messages.push({
      role: 'user',
      content: `你上面的输出无法使用：${failure.error}\n请重新只输出一个合法的 JSON 对象，不要有任何其它文字。`,
    });
  }
  return messages;
}
