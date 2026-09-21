/**
 * Return the uncalled portion of the final bet to its owner.
 *
 * If exactly one player has put in strictly more than everybody else, the
 * excess was never matched and must come back before pots are built.
 * Mutates `totalCommitted` on the affected player.
 *
 * @param {{seat:number, totalCommitted:number}[]} seats
 * @returns {{seat:number, amount:number}|null}
 */
export function returnUncalled(seats) {
  const inHand = seats.filter((s) => s.totalCommitted > 0);
  if (inHand.length < 2) return null;
  const sorted = inHand.slice().sort((a, b) => b.totalCommitted - a.totalCommitted);
  const top = sorted[0];
  const second = sorted[1];
  if (top.totalCommitted <= second.totalCommitted) return null;
  const amount = top.totalCommitted - second.totalCommitted;
  top.totalCommitted -= amount;
  return { seat: top.seat, amount };
}

const sameSet = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Split the money committed to the pot into main + side pots.
 *
 * A commitment level that no live player reached is money nobody can win —
 * only possible when every player who put it in then folded. Instead of
 * dropping it, the slice is handed back to its contributors so the table
 * always conserves chips.
 *
 * @param {{seat:number, totalCommitted:number, folded:boolean}[]} seats
 * @returns {{ pots: {amount:number, eligible:number[]}[], refunds: {seat:number, amount:number}[] }}
 */
export function buildPots(seats) {
  const levels = [...new Set(seats.map((s) => s.totalCommitted).filter((v) => v > 0))].sort((a, b) => a - b);
  const pots = [];
  const refundMap = new Map();
  let prev = 0;

  for (const level of levels) {
    let amount = 0;
    const contributors = [];
    for (const s of seats) {
      const slice = Math.max(0, Math.min(s.totalCommitted, level) - Math.min(s.totalCommitted, prev));
      amount += slice;
      if (slice > 0) contributors.push({ seat: s.seat, slice });
    }
    const eligible = seats
      .filter((s) => !s.folded && s.totalCommitted >= level)
      .map((s) => s.seat)
      .sort((a, b) => a - b);

    if (amount > 0) {
      if (eligible.length === 0) {
        for (const c of contributors) refundMap.set(c.seat, (refundMap.get(c.seat) ?? 0) + c.slice);
      } else {
        const last = pots[pots.length - 1];
        if (last && sameSet(last.eligible, eligible)) last.amount += amount;
        else pots.push({ amount, eligible });
      }
    }
    prev = level;
  }

  return {
    pots,
    refunds: [...refundMap].map(([seat, amount]) => ({ seat, amount })),
  };
}

export const totalPot = (pots) => pots.reduce((sum, p) => sum + p.amount, 0);
