/**
 * Zero-asset sound effects synthesised with the Web Audio API, so the game
 * ships without a single binary file.
 */

let ctx = null;
let master = null;
let enabled = true;

function ensure() {
  if (ctx) return ctx;
  const AudioCtx = window.AudioContext ?? window.webkitAudioContext;
  if (!AudioCtx) return null;
  ctx = new AudioCtx();
  master = ctx.createGain();
  master.gain.value = 0.5;
  master.connect(ctx.destination);
  return ctx;
}

export function unlockAudio() {
  const c = ensure();
  if (c && c.state === 'suspended') c.resume();
}

export function setSoundEnabled(on) {
  enabled = Boolean(on);
  if (master) master.gain.value = enabled ? 0.5 : 0;
}

export function isSoundEnabled() {
  return enabled;
}

function tone({ freq = 440, dur = 0.08, type = 'sine', gain = 0.14, sweep = 0, delay = 0 }) {
  if (!enabled) return;
  const c = ensure();
  if (!c || c.state === 'suspended') return;
  const t0 = c.currentTime + delay;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (sweep) osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq + sweep), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function noise({ dur = 0.06, gain = 0.1, band = 2600, delay = 0 }) {
  if (!enabled) return;
  const c = ensure();
  if (!c || c.state === 'suspended') return;
  const frames = Math.floor(c.sampleRate * dur);
  const buffer = c.createBuffer(1, frames, c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames) ** 2;
  const src = c.createBufferSource();
  src.buffer = buffer;
  const filter = c.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = band;
  filter.Q.value = 0.9;
  const g = c.createGain();
  g.gain.value = gain;
  src.connect(filter).connect(g).connect(master);
  src.start(c.currentTime + delay);
}

export const sfx = {
  deal() {
    noise({ dur: 0.07, gain: 0.09, band: 3200 });
    tone({ freq: 620, dur: 0.05, type: 'triangle', gain: 0.05, sweep: -180 });
  },
  chip() {
    noise({ dur: 0.045, gain: 0.07, band: 5200 });
    tone({ freq: 1180, dur: 0.05, type: 'triangle', gain: 0.06, sweep: -260 });
  },
  check() {
    tone({ freq: 320, dur: 0.07, type: 'sine', gain: 0.1 });
    tone({ freq: 480, dur: 0.06, type: 'sine', gain: 0.07, delay: 0.04 });
  },
  fold() {
    noise({ dur: 0.11, gain: 0.06, band: 1500 });
  },
  raise() {
    tone({ freq: 300, dur: 0.1, type: 'triangle', gain: 0.09, sweep: 260 });
  },
  turn() {
    tone({ freq: 880, dur: 0.09, type: 'sine', gain: 0.12 });
    tone({ freq: 1320, dur: 0.12, type: 'sine', gain: 0.09, delay: 0.07 });
  },
  win() {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
      tone({ freq: f, dur: 0.28, type: 'triangle', gain: 0.11, delay: i * 0.09 }),
    );
  },
  lose() {
    [392, 329.63, 261.63].forEach((f, i) => tone({ freq: f, dur: 0.26, type: 'sine', gain: 0.08, delay: i * 0.1 }));
  },
  error() {
    tone({ freq: 200, dur: 0.18, type: 'square', gain: 0.07, sweep: -80 });
  },
  notify() {
    tone({ freq: 740, dur: 0.1, type: 'sine', gain: 0.09 });
    tone({ freq: 988, dur: 0.14, type: 'sine', gain: 0.07, delay: 0.08 });
  },

  /* ---------------------------------------------------- 战斗新增音效 */
  /** Boss 台词出现（打字机起手的一声轻响）。 */
  testimony() {
    tone({ freq: 520, dur: 0.05, type: 'sine', gain: 0.06 });
    tone({ freq: 784, dur: 0.07, type: 'sine', gain: 0.045, delay: 0.05 });
    noise({ dur: 0.03, gain: 0.035, band: 4200 });
  },

  /** 「异议！」喊声。 */
  objection() {
    tone({ freq: 170, dur: 0.18, type: 'sawtooth', gain: 0.14, sweep: 320 });
    noise({ dur: 0.2, gain: 0.12, band: 1300 });
    tone({ freq: 880, dur: 0.1, type: 'square', gain: 0.07, delay: 0.06 });
    tone({ freq: 1240, dur: 0.12, type: 'square', gain: 0.05, delay: 0.13 });
  },

  /** 打击命中（重拳 + 低音爆点）。 */
  hit() {
    noise({ dur: 0.16, gain: 0.2, band: 700 });
    tone({ freq: 140, dur: 0.18, type: 'square', gain: 0.15, sweep: -90 });
    tone({ freq: 58, dur: 0.26, type: 'sine', gain: 0.18, sweep: -22 });
  },

  /** 落空 / 异议被驳回。 */
  miss() {
    noise({ dur: 0.14, gain: 0.09, band: 3400 });
    tone({ freq: 660, dur: 0.16, type: 'sine', gain: 0.07, sweep: -380 });
    tone({ freq: 330, dur: 0.12, type: 'triangle', gain: 0.05, delay: 0.07 });
  },

  /** 言语技能（挑衅 / 质疑 / 施压）出手。 */
  speech() {
    [440, 554.4, 659.3].forEach((f, i) =>
      tone({ freq: f, dur: 0.09, type: 'triangle', gain: 0.09, delay: i * 0.05 }),
    );
    noise({ dur: 0.07, gain: 0.05, band: 2400 });
  },

  /** 心理状态变化（下沉的嗡鸣）。 */
  mental() {
    tone({ freq: 220, dur: 0.3, type: 'sawtooth', gain: 0.07, sweep: 120 });
    tone({ freq: 330, dur: 0.34, type: 'sine', gain: 0.07, delay: 0.06 });
    tone({ freq: 165, dur: 0.42, type: 'triangle', gain: 0.06, delay: 0.1 });
  },

  /** 全下：低频紧张感。 */
  allin() {
    [110, 138.6, 164.8].forEach((f) => tone({ freq: f, dur: 0.9, type: 'sawtooth', gain: 0.055 }));
    tone({ freq: 110, dur: 1.1, type: 'sine', gain: 0.1, sweep: -40 });
    noise({ dur: 0.5, gain: 0.05, band: 900, delay: 0.22 });
  },

  /** 结局心跳。 */
  heart() {
    tone({ freq: 60, dur: 0.22, type: 'sine', gain: 0.2 });
    tone({ freq: 56, dur: 0.2, type: 'sine', gain: 0.16, delay: 0.3 });
    [523.25, 659.25, 783.99].forEach((f, i) =>
      tone({ freq: f, dur: 0.6, type: 'sine', gain: 0.07, delay: 0.7 + i * 0.22 }),
    );
    tone({ freq: 261.6, dur: 1.2, type: 'triangle', gain: 0.05, delay: 1.36 });
  },
};
