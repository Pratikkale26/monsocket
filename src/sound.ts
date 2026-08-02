/** Tiny WebAudio synth — every sound is generated, no asset files.
 *  The AudioContext is created lazily on the first user gesture. */

let ctx: AudioContext | null = null;
let muted = localStorage.getItem("solsocket-escape:muted") === "1";

function ac(): AudioContext | null {
  if (muted) return null;
  if (!ctx) {
    try {
      ctx = new AudioContext();
    } catch {
      return null;
    }
  }
  if (ctx.state === "suspended") void ctx.resume().catch(() => {});
  return ctx;
}

export function setMuted(m: boolean) {
  muted = m;
  localStorage.setItem("solsocket-escape:muted", m ? "1" : "0");
  if (m) stopAmbient();
}

let ambient: { osc: OscillatorNode; lfo: OscillatorNode } | null = null;

/** Low vault hum with a slow swell — starts on go-live, dies on mute. */
export function startAmbient() {
  const a = ac();
  if (!a || ambient) return;
  const osc = a.createOscillator();
  const lfo = a.createOscillator();
  const lfoGain = a.createGain();
  const gain = a.createGain();
  osc.type = "sine";
  osc.frequency.value = 52;
  lfo.frequency.value = 0.13;
  lfoGain.gain.value = 4;
  lfo.connect(lfoGain);
  lfoGain.connect(osc.frequency);
  gain.gain.value = 0.016;
  osc.connect(gain);
  gain.connect(a.destination);
  osc.start();
  lfo.start();
  ambient = { osc, lfo };
}

export function stopAmbient() {
  if (!ambient) return;
  try {
    ambient.osc.stop();
    ambient.lfo.stop();
  } catch {
    /* already stopped */
  }
  ambient = null;
}
export const isMuted = () => muted;

function tone(
  freq: number,
  durMs: number,
  opts: {
    type?: OscillatorType;
    gain?: number;
    sweepTo?: number;
    delayMs?: number;
  } = {},
) {
  const a = ac();
  if (!a) return;
  const { type = "square", gain = 0.035, sweepTo, delayMs = 0 } = opts;
  const t0 = a.currentTime + delayMs / 1000;
  const t1 = t0 + durMs / 1000;
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (sweepTo) osc.frequency.exponentialRampToValueAtTime(sweepTo, t1);
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t1);
  osc.connect(g).connect(a.destination);
  osc.start(t0);
  osc.stop(t1);
}

export const sfx = {
  /** keypad digit press */
  key: () => tone(880, 60, { type: "square", gain: 0.03 }),
  /** wrong code */
  wrong: () => tone(220, 260, { type: "sawtooth", sweepTo: 90, gain: 0.05 }),
  /** pressure plate engages */
  plate: () => tone(440, 90, { type: "triangle", gain: 0.05 }),
  /** a door / lock opens */
  door: () => {
    tone(140, 120, { type: "square", gain: 0.06 });
    tone(520, 180, { type: "triangle", gain: 0.04, delayMs: 90 });
  },
  /** gate latch locked open */
  latch: () => {
    tone(200, 80, { type: "square", gain: 0.06 });
    tone(300, 80, { type: "square", gain: 0.05, delayMs: 80 });
  },
  /** a key station turns */
  turn: () => tone(1320, 140, { type: "triangle", gain: 0.05 }),
  /** the shrinking-window countdown tick */
  tick: () => tone(1000, 40, { type: "square", gain: 0.025 }),
  /** heartbeat — your key is turned, the window is closing */
  heart: () => {
    tone(50, 100, { type: "sine", gain: 0.16 });
    tone(46, 80, { type: "sine", gain: 0.11, delayMs: 150 });
  },
  /** stepped in coolant — back to spawn */
  hazard: () => tone(160, 300, { type: "sawtooth", sweepTo: 40, gain: 0.07 }),
  /** chat message */
  chat: () => tone(660, 70, { type: "sine", gain: 0.03 }),
  /** level cleared */
  clear: () => {
    [523, 659, 784].forEach((f, i) =>
      tone(f, 160, { type: "triangle", gain: 0.05, delayMs: i * 110 }),
    );
  },
  /** escaped — the full run */
  escape: () => {
    [523, 659, 784, 1046, 1318].forEach((f, i) =>
      tone(f, 220, { type: "triangle", gain: 0.05, delayMs: i * 130 }),
    );
  },
};
