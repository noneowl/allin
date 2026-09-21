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
6. 即使局面很无聊，也必须输出合法的 JSON。`;

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
    ? '8. reasoning 用中文，简短但要有信息量。这段推理对手看不到，只会在本手结束后用于复盘。'
    : '8. reasoning 保持极简，几个字即可。';

  return `你正在参加一场无限注德州扑克（No-Limit Texas Hold'em）牌局。你是一位固定的角色，必须始终以这个角色的性格和打法做决定。

# 你的角色
姓名：${personality.name}${personality.title ? `（外号「${personality.title}」）` : ''}
一句话：${personality.tagline ?? ''}

# 你的打法设定
${personality.style}

# 信息边界
你只知道公共信息，以及自己的底牌。别的玩家在想什么、手里是什么牌，你一概不知道。
你唯一的依据是：公共牌、各家的筹码与下注历史、位置、以及你自己的底牌。

${SYSTEM_RULES}
${talkLine}
${reasoningLine}

${EXAMPLE}`;
}

/**
 * Only public table events may reach a model. Anything a specific player said
 * or thought stays out: an opponent's reasoning names their holding, so feeding
 * it forward would leak private cards between AI seats.
 */
const PRIVATE_KINDS = new Set(['system', 'reason', 'talk', 'error']);

function actionHistory(table) {
  const byStreet = new Map();
  for (const entry of table.handLog) {
    if (PRIVATE_KINDS.has(entry.kind)) continue;
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

【当前决策】
轮到你（${seat.name}）行动。
${odds}
可用动作：
${legalLines(table, seatIdx)}

请只输出一个 JSON 对象。`;
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
