/**
 * 打字机：把文本逐字写入 node，返回的 Promise 一定会 resolve（事件队列不卡死）。
 * 同一 node 上重复调用会先终结上一次打字（旧 Promise 立即 resolve）。
 */

const DEFAULT_MS = 28; // docs/PROTOCOL.md：台词打字机 ≈28ms/字

/**
 * @param {HTMLElement|null} node
 * @param {string} text
 * @param {{ms?: number, caret?: HTMLElement|null}} [opts]
 * @returns {Promise<void>}
 */
export function typewrite(node, text, opts = {}) {
  const ms = Number.isFinite(opts.ms) ? opts.ms : DEFAULT_MS;
  const caret = opts.caret ?? null;

  return new Promise((resolve) => {
    if (!node) {
      resolve();
      return;
    }

    // 终结该 node 上未完成的打字，保证旧 Promise 也 resolve。
    if (typeof node._twFinish === 'function') {
      node._twFinish();
    }

    const str = String(text ?? '');
    let timer = null;
    let index = 0;
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
      node._twFinish = null;
      if (caret) caret.classList.remove('is-on');
      node.textContent = str;
      resolve();
    };

    node._twFinish = finish;

    if (!str) {
      finish();
      return;
    }

    node.textContent = '';
    if (caret) caret.classList.add('is-on');

    timer = setInterval(() => {
      index += 1;
      node.textContent = str.slice(0, index);
      if (index >= str.length) finish();
    }, ms);

    // document 不可见时 interval 可能被节流：兜底按时长直接补完。
    const totalMs = str.length * ms + 200;
    setTimeout(() => {
      if (!done) finish();
    }, totalMs);
  });
}

/** 立即终结 node 上的打字（若有）。 */
export function cancelTypewrite(node) {
  if (node && typeof node._twFinish === 'function') node._twFinish();
}
