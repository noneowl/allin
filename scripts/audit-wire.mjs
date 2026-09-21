import { RoomStore } from '../server/rooms.js';
import { loadConfig, publicConfig } from '../server/config.js';
import { cardText } from '../server/engine/cards.js';

/**
 * Intercept the REAL outbound requests to OpenCode Go and check, byte for byte,
 * that a seat only ever receives its own hole cards plus the public board.
 */
const cfg = { ...loadConfig(), ready: publicConfig().ready };
console.log(`provider=${cfg.provider} model=${cfg.model}\n`);

const GLYPH = /(?:10|[2-9TJQKA])[♠♥♦♣]/g;
const cardsIn = (t) => new Set(String(t).match(GLYPH) ?? []);

const store = new RoomStore({ getConfig: () => cfg });
const room = store.create({
  seatCount: 3,
  seats: [
    { type: 'human', name: '我' },
    { type: 'ai', personalityId: 'ivan' },
    { type: 'ai', personalityId: 'biao' },
  ],
  rules: { smallBlind: 10, bigBlind: 20, startingStack: 2000 },
});

const captured = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes('opencode.ai')) {
    const table = room.controller.table;
    captured.push({
      url: u,
      session: init?.headers?.['x-opencode-session'] ?? '(none)',
      body: init?.body ? JSON.parse(init.body) : null,
      at: {
        street: table.street,
        board: table.board.map(cardText),
        holes: table.seats.map((s) => s.hole.map(cardText)),
        deck: table.deck.map(cardText),
      },
    });
  }
  return originalFetch(url, init);
};

await room.controller.newGame();
// Drive the human seat so the AI seats have to act again.
let guard = 0;
while (room.controller.table.phase === 'playing' && guard++ < 6) {
  const seat = room.controller.table.toAct;
  if (seat === null) break;
  if (room.controller.table.seats[seat].isHuman) {
    const legal = room.controller.table.legalActions(seat);
    const pick = legal.find((a) => a.type === 'check') || legal.find((a) => a.type === 'call') || legal[0];
    await room.controller.humanAction(seat, { type: pick.type, amount: pick.to ?? pick.amount });
  } else break;
}

console.log(`捕获到 ${captured.length} 个真实请求\n`);

let violations = 0;
let checkedSeats = new Set();
for (const req of captured) {
  const seatMatch = /-seat(\d+)$/.exec(req.session);
  const seatIdx = seatMatch ? Number(seatMatch[1]) : null;
  if (seatIdx === null) {
    console.log(`  ⚠ 无法从会话头判断座位: ${req.session}`);
    continue;
  }
  checkedSeats.add(seatIdx);

  // The system prompt carries a static worked example that names cards, so the
  // state-bearing surface is the non-system messages.
  const stateText = (req.body?.messages ?? [])
    .filter((m) => m.role !== 'system')
    .map((m) => m.content)
    .join('\n');
  const seen = cardsIn(stateText);

  const allowed = new Set([...req.at.holes[seatIdx], ...req.at.board]);
  const leaked = [...seen].filter((g) => !allowed.has(g));
  const undealtSeen = [...new Set(req.at.deck)].filter(
    (g) => seen.has(g) && !allowed.has(g),
  );

  const ok = leaked.length === 0;
  if (!ok) violations += 1;
  console.log(
    `[${ok ? '✓' : '✗'}] ${req.at.street.padEnd(7)} 座位${seatIdx}  自己的牌=${req.at.holes[seatIdx].join(' ')}  公共牌=[${req.at.board.join(' ') || '无'}]`,
  );
  console.log(`      提示词里出现的牌: [${[...seen].join(' ') || '无'}]`);
  if (!ok) {
    console.log(`      !! 越界: ${leaked.join(', ')}`);
    console.log(`      !! 其中未发出的牌: ${undealtSeen.join(', ') || '无'}`);
  }
}

console.log('\n=== 结论 ===');
console.log(`检查了 ${captured.length} 个真实请求，覆盖座位 ${[...checkedSeats].join(', ')}`);
console.log(`越界次数: ${violations}`);
console.log(
  violations === 0
    ? '✓ 没有任何一个请求包含：你的底牌、其他 AI 的底牌、或牌堆里还没发的牌'
    : '✗ 发现泄漏，见上',
);
globalThis.fetch = originalFetch;
