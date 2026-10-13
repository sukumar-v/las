/**
 * Synthetic motion-sensor recordings with known ground truth, for testing the sensor engine.
 * General signal generators parameterized by numbers (step rate, phase durations, sway), seeded.
 */
import type { SensorEvidence } from "../types.js";

export type SensorSample = SensorEvidence["samples"][number];

const G = 9.80665;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r: () => number): number {
  return Math.sqrt(-2 * Math.log(Math.max(1e-12, r()))) * Math.cos(2 * Math.PI * r());
}

export interface SteppingOptions {
  /** steps per minute */
  spm?: number;
  durationS?: number;
  /** samples per second */
  rate?: number;
  /** extra acceleration at each footfall, in g */
  impactG?: number;
  /** sensor noise, m/s² */
  noise?: number;
  /** still time before the first step */
  leadS?: number;
  seed?: number;
}

/**
 * Rhythmic stepping: gravity along y, a short impact pulse (60 ms) at each footfall, a gentle
 * bounce at the step rate and a sideways sway at half of it (one per stride).
 */
export function steppingSamples(opts: SteppingOptions = {}): { samples: SensorSample[]; truth: { steps: number; cadenceSpm: number; stepTimes: number[] } } {
  const spm = opts.spm ?? 170;
  const dur = opts.durationS ?? 20;
  const rate = opts.rate ?? 100;
  const impact = (opts.impactG ?? 1.2) * G;
  const noise = opts.noise ?? 0.1;
  const lead = opts.leadS ?? 1;
  const r = rng(opts.seed ?? 1);
  const period = 60 / spm;
  const stepTimes: number[] = [];
  for (let t = lead; t < dur - 0.2; t += period) stepTimes.push(t);
  const samples: SensorSample[] = [];
  const n = Math.round(dur * rate);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const stepping = t >= lead - period / 2 && t <= stepTimes[stepTimes.length - 1] + period / 2;
    let pulse = 0;
    for (const s of stepTimes) {
      const d = t - s;
      if (Math.abs(d) < 0.15) pulse += Math.exp(-0.5 * (d / 0.02) ** 2);
    }
    const bounce = stepping ? 0.25 * G * Math.cos((2 * Math.PI * (t - lead)) / period) : 0;
    const sway = stepping ? 0.1 * G * Math.sin((Math.PI * (t - lead)) / period) : 0;
    samples.push({ t, ax: sway + noise * gauss(r), ay: G + impact * pulse + bounce + noise * gauss(r), az: noise * gauss(r) });
  }
  return { samples, truth: { steps: stepTimes.length, cadenceSpm: spm, stepTimes } };
}

export interface SwingSampleOptions {
  addressS?: number;
  backswingMs?: number;
  downswingMs?: number;
  /** follow-through duration; by default it keeps the speed continuous at the fastest point */
  followS?: number;
  tailS?: number;
  /** how far back the rotation goes, degrees */
  topDeg?: number;
  /** how far through it goes after the fastest point, degrees */
  finishDeg?: number;
  /** distance of the phone from the pivot, metres */
  radiusM?: number;
  rate?: number;
  /** include gyroscope samples (default true) */
  gyro?: boolean;
  noise?: number;
  seed?: number;
}

/**
 * A rotation around a pivot in a vertical plane: still, a slow eased turn back to the top, an
 * accelerating turn down to the fastest point, then a slowing follow-through. Accelerations are
 * physical: tangential (r·α), centripetal (r·ω²) and gravity seen from the rotating phone.
 */
export function swingSamples(opts: SwingSampleOptions = {}): { samples: SensorSample[]; truth: { backswingMs: number; downswingMs: number; tempoRatio: number; topTime: number; peakTime: number } } {
  const address = opts.addressS ?? 1;
  const back = (opts.backswingMs ?? 900) / 1000;
  const down = (opts.downswingMs ?? 300) / 1000;
  const tail = opts.tailS ?? 1;
  const top = ((opts.topDeg ?? 150) * Math.PI) / 180;
  const finish = ((opts.finishDeg ?? 120) * Math.PI) / 180;
  // by default the follow-through leaves the fastest point at the downswing's final speed (2·top/down)
  const follow = opts.followS ?? (finish * Math.PI * down) / (4 * top);
  const radius = opts.radiusM ?? 0.8;
  const rate = opts.rate ?? 200;
  const noise = opts.noise ?? 0.05;
  const r = rng(opts.seed ?? 3);
  const theta = (t: number) => {
    if (t < address) return 0;
    if (t < address + back) return (top * (1 - Math.cos((Math.PI * (t - address)) / back))) / 2;
    if (t < address + back + down) {
      const u = (t - address - back) / down;
      return top * (1 - u * u);
    }
    if (t < address + back + down + follow) return -finish * Math.sin((Math.PI / 2) * ((t - address - back - down) / follow));
    return -finish;
  };
  const total = address + back + down + follow + tail;
  const h = 1 / rate;
  const samples: SensorSample[] = [];
  for (let i = 0; i < Math.round(total * rate); i++) {
    const t = i / rate;
    const th = theta(t);
    const om = (theta(t + h / 2) - theta(t - h / 2)) / h;
    const al = (theta(t + h) - 2 * th + theta(t - h)) / (h * h);
    // in the phone's frame: x along the direction of motion, y toward the pivot, z out of the plane
    const ax = radius * al + G * Math.sin(th) + noise * gauss(r);
    const ay = radius * om * om + G * Math.cos(th) + noise * gauss(r);
    const s: SensorSample = { t, ax, ay, az: noise * gauss(r) };
    if (opts.gyro !== false) {
      s.gx = 0.02 * gauss(r);
      s.gy = 0.02 * gauss(r);
      s.gz = om + 0.02 * gauss(r);
    }
    samples.push(s);
  }
  return { samples, truth: { backswingMs: back * 1000, downswingMs: down * 1000, tempoRatio: back / down, topTime: address + back, peakTime: address + back + down } };
}

export interface StillOptions {
  durationS?: number;
  rate?: number;
  /** standard deviation of the wobble, m/s² */
  sway?: number;
  /** gyroscope wobble, rad/s (omit for no gyroscope) */
  gyroSway?: number;
  seed?: number;
}

/** Holding still: gravity plus a slow wobble of the given size. */
export function stillSamples(opts: StillOptions = {}): { samples: SensorSample[] } {
  const dur = opts.durationS ?? 10;
  const rate = opts.rate ?? 100;
  const sway = opts.sway ?? 0.05;
  const r = rng(opts.seed ?? 5);
  const samples: SensorSample[] = [];
  let wx = 0;
  let wy = 0;
  for (let i = 0; i < Math.round(dur * rate); i++) {
    // a slowly wandering wobble (first-order low-pass of noise), scaled to the requested size
    wx = 0.95 * wx + 0.3122 * sway * gauss(r);
    wy = 0.95 * wy + 0.3122 * sway * gauss(r);
    const s: SensorSample = { t: i / rate, ax: wx, ay: wy, az: G + 0.3 * sway * gauss(r) };
    if (opts.gyroSway !== undefined) {
      s.gx = opts.gyroSway * gauss(r);
      s.gy = opts.gyroSway * gauss(r);
      s.gz = opts.gyroSway * gauss(r);
    }
    samples.push(s);
  }
  return { samples };
}

export const syntheticSensor = { steppingSamples, swingSamples, stillSamples };
