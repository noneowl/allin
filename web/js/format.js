const NUMBER = new Intl.NumberFormat('en-US');

export const fmt = (n) => NUMBER.format(Math.round(Number(n) || 0));

export const fmtShort = (n) => {
  const v = Math.round(Number(n) || 0);
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 1)}M`;
  if (Math.abs(v) >= 10_000) return `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}k`;
  return NUMBER.format(v);
};

export const ACTION_TEXT = {
  fold: '弃牌',
  check: '过牌',
  call: '跟注',
  bet: '下注',
  raise: '加注',
  all_in: '全下',
  post_sb: '小盲',
  post_bb: '大盲',
};

export const STREET_TEXT = {
  preflop: '翻牌前',
  flop: '翻牌圈',
  turn: '转牌圈',
  river: '河牌圈',
  showdown: '摊牌',
};

/** Describe a seat's last action for the badge under its nameplate. */
export function lastActionText(action) {
  if (!action) return null;
  switch (action.type) {
    case 'fold':
      return { text: '弃牌', cls: 'tag--action' };
    case 'check':
      return { text: '过牌', cls: 'tag--action' };
    case 'call':
      return { text: action.allIn ? `全下跟注 ${fmt(action.amount)}` : `跟注 ${fmt(action.amount)}`, cls: action.allIn ? 'tag--allin' : 'tag--action' };
    case 'bet':
      return { text: `下注 ${fmt(action.amount)}`, cls: 'tag--bet' };
    case 'raise':
      return { text: `加注到 ${fmt(action.amount)}`, cls: 'tag--bet' };
    case 'all_in':
      return { text: `全下 ${fmt(action.amount)}`, cls: 'tag--allin' };
    case 'post_sb':
      return { text: `小盲 ${fmt(action.amount)}`, cls: 'tag--action' };
    case 'post_bb':
      return { text: `大盲 ${fmt(action.amount)}`, cls: 'tag--action' };
    default:
      return null;
  }
}

export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

export function timeAgo(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m`;
}
