/**
 * Deterministic test-signal synthesis: tones, melodies with injected pitch and timing errors,
 * click tracks and noise. Engine tests and the drift fixture are built from these, so every
 * known error in a fixture is put there on purpose and can be measured back out.
 */
import { isRestName, noteToHz } from "./pitch.js";
import { parsePattern } from "./reference/pattern.js";

export interface ToneOptions {
  hz: number;
  seconds: number;
  sampleRate?: number;
  /** peak amplitude, 0..1 */
  amp?: number;
  /** linear attack time */
  attackS?: number;
  /** exponential decay time constant; omit for a sustained tone */
  decayS?: number;
  /** relative amplitude of harmonics 1, 2, 3...; default a plain sine */
  harmonics?: number[];
  /** release ramp at the end, to avoid a click */
  releaseS?: number;
}

/** One tone with an attack, optional exponential decay, harmonics and a short release. */
export function synthTone(o: ToneOptions): Float32Array {
  const sr = o.sampleRate ?? 44100;
  const n = Math.max(0, Math.round(o.seconds * sr));
  const out = new Float32Array(n);
  const amp = o.amp ?? 0.5;
  const harm = o.harmonics?.length ? o.harmonics : [1];
  const norm = harm.reduce((s, h) => s + Math.abs(h), 0) || 1;
  const attack = Math.max(1, Math.round((o.attackS ?? 0.01) * sr));
  const release = Math.max(1, Math.round((o.releaseS ?? 0.01) * sr));
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let env = i < attack ? i / attack : 1;
    if (o.decayS) env *= Math.exp(-Math.max(0, i - attack) / sr / o.decayS);
    if (i > n - release) env *= (n - i) / release;
    let v = 0;
    for (let h = 0; h < harm.length; h++) if (harm[h]) v += harm[h] * Math.sin(2 * Math.PI * o.hz * (h + 1) * t);
    out[i] = (amp * env * v) / norm;
  }
  return out;
}

/** Adds `src` into `dst` starting at sample `at` (clipped to dst). */
export function mixInto(dst: Float32Array, src: Float32Array, at: number): void {
  const start = Math.round(at);
  for (let i = 0; i < src.length; i++) {
    const j = start + i;
    if (j >= 0 && j < dst.length) dst[j] += src[i];
  }
}

export function silence(seconds: number, sampleRate = 44100): Float32Array {
  return new Float32Array(Math.max(0, Math.round(seconds * sampleRate)));
}

/** Small seeded PRNG (mulberry32) so noise fixtures are reproducible. */
export function seededRandom(seed = 1): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform white noise with peak amplitude `amp`. */
export function synthNoise(seconds: number, sampleRate = 44100, amp = 0.1, seed = 1): Float32Array {
  const rnd = seededRandom(seed);
  const out = silence(seconds, sampleRate);
  for (let i = 0; i < out.length; i++) out[i] = amp * (2 * rnd() - 1);
  return out;
}

/** Per-note error: a list by note index, a map index -> value, or a function. Indices count sounding notes from 0. */
export type PerNote = number[] | Record<number, number> | ((index: number) => number);
function perNote(p: PerNote | undefined, i: number, fallback = 0): number {
  if (p === undefined) return fallback;
  if (typeof p === "function") return p(i);
  return (p as Record<number, number>)[i] ?? fallback;
}

export interface MelodyOptions {
  tuning?: number;
  /** peak amplitude, for every note or per note (notes not listed get 0.4) */
  amp?: number | PerNote;
  harmonics?: number[];
  attackS?: number;
  decayS?: number;
  /** share of each note's length that sounds (the rest is a gap), default 0.85 */
  articulation?: number;
  /** silence before the first beat */
  leadInS?: number;
  /** silence after the last note */
  tailS?: number;
  /** pitch error per sounding note, in cents */
  pitchErrorCents?: PerNote;
  /** onset error per sounding note, in ms (negative = early) */
  onsetErrorMs?: PerNote;
}

export interface SynthResult {
  samples: Float32Array;
  sampleRate: number;
  /** when each sounding note/click actually starts, seconds */
  onsets: number[];
  /** when it should have started */
  expectedOnsets: number[];
  /** the beat grid's first beat, for AudioEvidence.click */
  firstBeatS: number;
  bpm: number;
}

/** A melody of [note name or Hz, beats] pairs at `bpm`, with optional per-note pitch and timing errors. */
export function synthMelody(notes: [string | number, number][], bpm: number, sampleRate = 44100, opts: MelodyOptions = {}): SynthResult {
  const spb = 60 / bpm;
  const lead = opts.leadInS ?? 0.5;
  const tail = opts.tailS ?? 0.5;
  const totalBeats = notes.reduce((s, [, b]) => s + b, 0);
  const out = silence(lead + totalBeats * spb + tail + 0.2, sampleRate);
  const onsets: number[] = [];
  const expected: number[] = [];
  let beat = 0;
  let k = 0;
  for (const [note, beats] of notes) {
    if (typeof note === "string" && isRestName(note)) {
      beat += beats;
      continue;
    }
    const hz = noteToHz(note, opts.tuning ?? 440) * 2 ** (perNote(opts.pitchErrorCents, k) / 1200);
    const want = lead + beat * spb;
    const at = want + perNote(opts.onsetErrorMs, k) / 1000;
    const amp = typeof opts.amp === "number" ? opts.amp : perNote(opts.amp, k, 0.4);
    const tone = synthTone({ hz, seconds: beats * spb * (opts.articulation ?? 0.85), sampleRate, amp, attackS: opts.attackS ?? 0.008, decayS: opts.decayS, harmonics: opts.harmonics ?? [1, 0.5, 0.25] });
    mixInto(out, tone, at * sampleRate);
    onsets.push(at);
    expected.push(want);
    beat += beats;
    k++;
  }
  return { samples: out, sampleRate, onsets, expectedOnsets: expected, firstBeatS: lead, bpm };
}

export interface ClickOptions {
  sampleRate?: number;
  /** total length; default last click + 1 s */
  seconds?: number;
  amp?: number;
  /** click length */
  clickS?: number;
  /** pitched click (Hz) mixed with a noise burst */
  hz?: number;
  seed?: number;
}

export interface PatternClicks {
  pattern: string;
  bpm: number;
  beatsPerBar?: number;
  bars?: number;
  /** time of the first beat */
  startS?: number;
  /** timing error per onset in ms, given its index and the pattern symbol (e.g. "U") */
  offsetMs?: (index: number, symbol: string) => number;
}

/** A click per onset time, or per onset of an onset pattern ("x.x.xx.x", "D_DU_UDU"). */
export function synthClicks(input: number[] | PatternClicks, opts: ClickOptions = {}): SynthResult & { symbols: string[] } {
  const sr = opts.sampleRate ?? 44100;
  let times: number[];
  let expected: number[];
  let symbols: string[];
  let firstBeatS = 0;
  let bpm = 0;
  if (Array.isArray(input)) {
    times = input.slice();
    expected = input.slice();
    symbols = input.map(() => "x");
  } else {
    const p = parsePattern(input.pattern, input.beatsPerBar ?? 4, input.bars ?? 4);
    const spb = 60 / input.bpm;
    firstBeatS = input.startS ?? 0.5;
    bpm = input.bpm;
    expected = p.map((e) => firstBeatS + e.beat * spb);
    symbols = p.map((e) => e.symbol ?? "x");
    times = expected.map((t, i) => t + (input.offsetMs?.(i, symbols[i]) ?? 0) / 1000);
  }
  const len = opts.seconds ?? Math.max(0, ...times) + 1;
  const out = silence(len, sr);
  const rnd = seededRandom(opts.seed ?? 7);
  const n = Math.round((opts.clickS ?? 0.06) * sr);
  const amp = opts.amp ?? 0.5;
  const hz = opts.hz ?? 1000;
  for (const t of times) {
    const c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const env = Math.min(1, i / (0.001 * sr)) * Math.exp(-i / (0.015 * sr));
      c[i] = amp * env * (0.6 * Math.sin((2 * Math.PI * hz * i) / sr) + 0.4 * (2 * rnd() - 1));
    }
    mixInto(out, c, t * sr);
  }
  return { samples: out, sampleRate: sr, onsets: times, expectedOnsets: expected, firstBeatS, bpm, symbols };
}
