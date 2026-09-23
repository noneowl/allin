/**
 * effects.js — 打击演出与数字/筹码动画（docs/PROTOCOL.md §演出要求）。
 * 全部基于 Web Animations API + CSS class，播完自行清理，不残留 DOM。
 */
import { el } from './dom.js';
import { sfx } from './sound.js';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fxRoot = () => document.getElementById('fx-root');

/** WAAPI 封装：自动吞掉取消异常，返回 anim 或 null。 */
export function animate(node, keyframes, options) {
  if (typeof node.animate !== 'function') return null;
  try {
    const anim = node.animate(keyframes, options);
    anim.finished?.catch(() => {});
    return anim;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------- 基础反馈 */

/** 顶部 toast。kind: 'info' | 'error' | '' */
export function toast(message, kind = '', holdMs = 2600) {
  const host = document.getElementById('toasts');
  if (!host || !message) return;
  const node = el('div', { class: `toast${kind ? ` toast--${kind}` : ''}`, text: String(message) });
  host.appendChild(node);
  while (host.children.length > 4) host.firstChild.remove();
  setTimeout(() => {
    animate(node, [{ opacity: 1 }, { opacity: 0 }], { duration: 260, fill: 'forwards' });
    setTimeout(() => node.remove(), 280);
  }, holdMs);
}

/** 全屏动画短暂冻结（hitstop）：CSS animation + Web Animations API 一起停。 */
export async function hitstop(ms = 150) {
  document.body.classList.add('hitstop');
  let animations = [];
  try {
    animations = typeof document.getAnimations === 'function' ? document.getAnimations() : [];
    for (const a of animations) {
      try { a.pause(); } catch { /* 已结束的动画忽略 */ }
    }
  } catch {
    animations = [];
  }
  await sleep(ms);
  for (const a of animations) {
    try { a.play(); } catch { /* 忽略 */ }
  }
  document.body.classList.remove('hitstop');
}

/** 闪屏。tone: 'white'（默认，CRACK/打击）| 'red'（COUNTER / BUSTED）。 */
export function flash(tone = 'white') {
  const node = el('div', { class: `fx-flash${tone === 'red' ? ' fx-flash--red' : ''}` });
  document.body.appendChild(node);
  const anim = animate(
    node,
    [
      { opacity: 0 },
      { opacity: 0.9, offset: 0.18 },
      { opacity: 0.25, offset: 0.55 },
      { opacity: 0 },
    ],
    { duration: 340, easing: 'ease-out' },
  );
  const cleanup = () => node.remove();
  if (anim) anim.finished.then(cleanup).catch(cleanup);
  else setTimeout(cleanup, 340);
}

/** 屏幕轻震（作用在 .app 上，避免动 fixed 浮层的定位上下文）。 */
export function screenShake(ms = 460, amp = 10) {
  const target = document.getElementById('app') ?? document.body;
  animate(target, shakeFrames(amp), { duration: ms, easing: 'ease-out' });
}

/** Boss 头像震动。 */
export function avatarShake(ms = 520, amp = 14) {
  const target = document.getElementById('boss-avatar');
  if (target) animate(target, shakeFrames(amp), { duration: ms, easing: 'ease-out' });
}

function shakeFrames(amp) {
  const frames = [];
  const steps = 8;
  for (let i = 0; i < steps; i += 1) {
    const k = 1 - i / steps;
    const x = (i % 2 === 0 ? -1 : 1) * amp * k;
    const y = ((i % 3) - 1) * amp * 0.45 * k;
    const r = (i % 2 === 0 ? -1 : 1) * 2.2 * k;
    frames.push({ transform: `translate(${x}px, ${y}px) rotate(${r}deg)` });
  }
  frames.push({ transform: 'translate(0, 0) rotate(0deg)' });
  return frames;
}

/** 冲击波圆环（从头像处扩散）。 */
function shockwave(centerEl) {
  const host = fxRoot();
  if (!host || !centerEl) return;
  const rect = centerEl.getBoundingClientRect();
  const node = el('div', { class: 'fx-shockwave' });
  const size = 60;
  node.style.left = `${rect.left + rect.width / 2 - size / 2}px`;
  node.style.top = `${rect.top + rect.height / 2 - size / 2}px`;
  node.style.width = `${size}px`;
  node.style.height = `${size}px`;
  host.appendChild(node);
  const anim = animate(
    node,
    [
      { transform: 'scale(0.4)', opacity: 0.95, borderWidth: '6px' },
      { transform: 'scale(6)', opacity: 0, borderWidth: '1px' },
    ],
    { duration: 520, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
  );
  const cleanup = () => node.remove();
  if (anim) anim.finished.then(cleanup).catch(cleanup);
  else setTimeout(cleanup, 540);
}

/** 大字弹出：「异议命中！CONTRADICTION」等。 */
export function bigText(title, sub = '', { tone = 'red', holdMs = 760 } = {}) {
  const host = fxRoot();
  if (!host) return Promise.resolve();
  const node = el('div', { class: `fx-bigtext${tone === 'gold' ? ' fx-bigtext--gold' : ''}` }, [
    el('span', { class: 'fx-bigtext__title', text: title }),
    sub ? el('span', { class: 'fx-bigtext__sub', text: sub }) : null,
  ]);
  host.appendChild(node);
  const anim = animate(
    node,
    [
      { opacity: 0, transform: 'translate(-50%, -50%) scale(0.5) rotate(-4deg)' },
      { opacity: 1, transform: 'translate(-50%, -50%) scale(1.08) rotate(1deg)', offset: 0.22 },
      { opacity: 1, transform: 'translate(-50%, -50%) scale(1) rotate(0deg)', offset: 0.34 },
      { opacity: 1, transform: 'translate(-50%, -50%) scale(1) rotate(0deg)', offset: 0.78 },
      { opacity: 0, transform: 'translate(-50%, -50%) scale(1.14) rotate(0deg)' },
    ],
    { duration: holdMs + 340, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
  );
  const cleanup = () => node.remove();
  if (anim) anim.finished.then(cleanup).catch(cleanup);
  else setTimeout(cleanup, holdMs + 400);
  return sleep(holdMs);
}

/** 飘字：小打击反馈（言语命中、READ 等），锚定到某个元素附近。 */
export function popup(anchor, text, tone = 'hit') {
  const host = fxRoot();
  if (!host || !anchor) return;
  const rect = anchor.getBoundingClientRect();
  const node = el('div', { class: `fx-popup fx-popup--${tone}`, text: String(text) });
  node.style.left = `${rect.left + rect.width / 2}px`;
  node.style.top = `${Math.max(10, rect.top - 8)}px`;
  node.style.transform = 'translateX(-50%)';
  host.appendChild(node);
  const anim = animate(
    node,
    [
      { opacity: 0, transform: 'translateX(-50%) translateY(14px) scale(0.7)' },
      { opacity: 1, transform: 'translateX(-50%) translateY(-14px) scale(1.06)', offset: 0.25 },
      { opacity: 1, transform: 'translateX(-50%) translateY(-30px) scale(1)', offset: 0.7 },
      { opacity: 0, transform: 'translateX(-50%) translateY(-56px) scale(0.96)' },
    ],
    { duration: 1150, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
  );
  const cleanup = () => node.remove();
  if (anim) anim.finished.then(cleanup).catch(cleanup);
  else setTimeout(cleanup, 1200);
}

/**
 * 居中横幅（mental 状态变化 / hand_end 结算）。
 * @returns {Promise<void>} hold 结束 + 淡出后 resolve
 */
export function banner({ text, sub = '', cls = '', holdMs = 1300, html = null } = {}) {
  const host = fxRoot();
  if (!host) return Promise.resolve();
  const body = html ? el('span', { class: 'fx-banner__text', html }) : el('span', { class: 'fx-banner__text', text });
  const node = el('div', { class: `fx-banner ${cls}` }, [body, sub ? el('span', { class: 'fx-banner__sub', text: sub }) : null]);
  host.appendChild(node);
  animate(
    node,
    [
      { opacity: 0, transform: 'translateX(-50%) scale(0.86)' },
      { opacity: 1, transform: 'translateX(-50%) scale(1.03)', offset: 0.2 },
      { opacity: 1, transform: 'translateX(-50%) scale(1)', offset: 0.85 },
      { opacity: 0, transform: 'translateX(-50%) scale(1.05)' },
    ],
    { duration: holdMs + 320, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
  );
  return sleep(holdMs + 300).then(() => node.remove());
}

/* --------------------------------------------------------------- 打击链 */

/**
 * 完整打击演出：Hitstop → 头像震动 → 屏幕轻震 → 白闪 → 冲击波 → 大字 → 音效。
 * @param {{title: string, sub?: string, tone?: 'red'|'gold', sfxName?: string}} opts
 */
export async function impact({ title, sub = '', tone = 'red', sfxName = 'hit' } = {}) {
  await hitstop(150);
  try {
    if (sfxName && typeof sfx[sfxName] === 'function') sfx[sfxName]();
  } catch {
    /* 音频不可用时忽略 */
  }
  avatarShake();
  screenShake();
  flash(); // 打击主链保持白闪（COUNTER/BUSTED 的红闪由 app 直接调用 flash('red')）
  shockwave(document.getElementById('boss-avatar'));
  setTimeout(() => bigText(title, sub, { tone: tone === 'gold' ? 'gold' : 'red' }), 90);
  await sleep(880);
}

/* ------------------------------------------------------- 筹码 / 数字动画 */

const fmt = (n) => {
  const v = Math.round(Number(n) || 0);
  return v.toLocaleString('en-US');
};

/** 数字滚动（倒数 / 累加）。 */
export function animateNumber(node, from, to, ms = 520) {
  if (!node) return Promise.resolve();
  const a = Math.round(Number(from) || 0);
  const b = Math.round(Number(to) || 0);
  if (a === b || ms <= 0) {
    node.textContent = fmt(b);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const t0 = performance.now();
    const tick = (now) => {
      const k = Math.min(1, (now - t0) / ms);
      const eased = 1 - (1 - k) ** 3;
      node.textContent = fmt(a + (b - a) * eased);
      if (k < 1) requestAnimationFrame(tick);
      else {
        node.textContent = fmt(b);
        resolve();
      }
    };
    requestAnimationFrame(tick);
  });
}

/** 底池数字飞向赢家筹码。返回的 Promise 在飞行结束时 resolve。 */
export function flyChip(fromEl, toEl, label) {
  if (!fromEl || !toEl) return sleep(200);
  const a = fromEl.getBoundingClientRect();
  const b = toEl.getBoundingClientRect();
  const host = fxRoot() ?? document.body;
  const node = el('div', { class: 'flychip', text: label == null ? '' : String(label) });
  node.style.left = `${a.left + a.width / 2}px`;
  node.style.top = `${a.top + a.height / 2}px`;
  host.appendChild(node);
  const dx = b.left + b.width / 2 - (a.left + a.width / 2);
  const dy = b.top + b.height / 2 - (a.top + a.height / 2);
  const anim = animate(
    node,
    [
      { transform: 'translate(-50%, -50%) scale(1)', opacity: 1 },
      { transform: `translate(calc(-50% + ${dx * 0.5}px), calc(-50% + ${dy * 0.5 - 46}px)) scale(1.15)`, opacity: 1, offset: 0.5 },
      { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.5)`, opacity: 0.85 },
    ],
    { duration: 640, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' },
  );
  const cleanup = () => node.remove();
  if (anim) anim.finished.then(cleanup).catch(cleanup);
  else setTimeout(cleanup, 660);
  return sleep(640);
}

/** allin 时牌桌轻微 zoom（class 由 app 管理，这里做纯开关）。 */
export function tableZoom(on) {
  const felt = document.getElementById('felt');
  if (felt) felt.classList.toggle('is-allin', Boolean(on));
}

/** 状态横幅：CALM → SHAKEN（客户端只做展示映射，权威仍是 view）。recover=回血（向好）。 */
export function mentalBanner(fromText, toText, causeText = '', { recover = false } = {}) {
  return banner({
    html: `<span class="fx-banner__from">${escapeHtml(fromText)}</span> → <span class="fx-banner__to">${escapeHtml(toText)}</span>`,
    sub: causeText,
    cls: recover ? 'fx-banner--mental fx-banner--recover' : 'fx-banner--mental',
    holdMs: recover ? 1500 : 1350,
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
