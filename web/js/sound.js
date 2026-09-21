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
};
