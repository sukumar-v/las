/**
 * Feature extraction from raw samples: a pitch track (McLeod pitch method via pitchy), onsets
 * (spectral flux with an adaptive threshold, refined on the amplitude envelope), notes (stable
 * pitch runs split at onsets) and loudness. These know nothing about instruments; they measure
 * frequency, energy and change over time.
 */
import { PitchDetector } from "pitchy";
import { fftInPlace, frameLength, hann, percentile, rmsOf, toDb } from "./dsp.js";
import { hzToMidi, midiName } from "./pitch.js";

export interface PitchFrame {
  /** centre of the analysis window, seconds */
  t: number;
  /** 0 when no clear pitch */
  hz: number;
  /** pitchy's clarity (normalized autocorrelation peak), 0..1 */
  clarity: number;
  /** frame level, dBFS */
  db: number;
}

export interface PitchTrackOptions {
  /** analysis window in samples (power of two); default ~46 ms */
  window?: number;
  /** clarity below this is "no pitch"; default 0.9 */
  minClarity?: number;
  minHz?: number;
  maxHz?: number;
  /** frames quieter than this are unvoiced; default -60 dBFS */
  minDb?: number;
}

/**
 * Pitch per frame. A window of about 46 ms slides by `hop` samples (default a quarter window,
 * ~12 ms at 44.1 kHz); pitchy finds the strongest period with the McLeod normalized square
 * difference function and reports how clear it is. Unclear, quiet or out-of-range frames get hz 0.
 */
export function detectPitchTrack(samples: Float32Array, sampleRate: number, hop?: number, opts: PitchTrackOptions = {}): PitchFrame[] {
  const win = opts.window ?? frameLength(0.046, sampleRate, 1024);
  const h = Math.max(1, hop ?? win >> 2);
  const det = PitchDetector.forFloat32Array(win);
  det.minVolumeDecibels = -100;
  const minClarity = opts.minClarity ?? 0.9;
  const minHz = opts.minHz ?? 40;
  const maxHz = opts.maxHz ?? Math.min(4200, sampleRate / 4);
  const minDb = opts.minDb ?? -60;
  const out: PitchFrame[] = [];
  for (let start = 0; start + win <= samples.length; start += h) {
    const frame = samples.subarray(start, start + win);
    const db = toDb(rmsOf(frame));
    let hz = 0;
    let clarity = 0;
    if (db > minDb) {
      const [p, c] = det.findPitch(frame, sampleRate);
      clarity = Number.isFinite(c) ? c : 0;
      if (clarity >= minClarity && p >= minHz && p <= maxHz) hz = p;
    }
    out.push({ t: (start + win / 2) / sampleRate, hz, clarity, db });
  }
  return out;
}

/** Short-time level envelope in dBFS at `stepS` resolution, from centred windows of `winS`. */
export function levelEnvelope(samples: Float32Array, sampleRate: number, stepS = 0.001, winS = 0.008): Float32Array {
  const half = Math.max(1, Math.round((winS * sampleRate) / 2));
  const n = Math.ceil(samples.length / (stepS * sampleRate));
  const out = new Float32Array(n);
  // running sum of squares for O(n) windows
  const cum = new Float64Array(samples.length + 1);
  for (let i = 0; i < samples.length; i++) cum[i + 1] = cum[i] + samples[i] * samples[i];
  for (let k = 0; k < n; k++) {
    const c = Math.round(k * stepS * sampleRate);
    const a = Math.max(0, c - half);
    const b = Math.min(samples.length, c + half);
    out[k] = b > a ? Math.sqrt((cum[b] - cum[a]) / (b - a)) : 0;
  }
  return out;
}

export interface OnsetOptions {
  /** minimum time between onsets; default 50 ms (a strum or flam counts once) */
  minGapS?: number;
  /** extra threshold above the local mean, as a share of the strongest flux; default 0.06 */
  delta?: number;
}

export interface OnsetStrength {
  /** spectral flux per frame */
  flux: Float32Array;
  /** frame level, dBFS */
  db: Float32Array;
  hopS: number;
  windowS: number;
}

/**
 * Onset strength: the half-wave rectified spectral flux. Each ~23 ms frame (hop ~6 ms) is
 * windowed, transformed with an FFT and log-compressed; the flux is the sum over frequency bins
 * of how much each bin got louder since the previous frame. Notes starting, hits and pick
 * attacks all make many bins louder at once; steady or decaying sound does not.
 */
export function onsetStrength(samples: Float32Array, sampleRate: number): OnsetStrength {
  const W = frameLength(0.023, sampleRate, 256);
  const hop = W >> 2;
  const w = hann(W);
  const half = W >> 1;
  const frames = Math.max(0, Math.ceil(samples.length / hop));
  const flux = new Float32Array(frames);
  const db = new Float32Array(frames);
  const re = new Float64Array(W);
  const im = new Float64Array(W);
  // the last two log spectra, max-filtered across 3 bins (SuperFlux, Böck & Widmer 2013): comparing
  // with the frame two hops back through a small frequency max filter ignores the slow wobble of
  // steady tones and vibrato, while a real attack still lights up many bins at once
  const hist = [new Float64Array(half), new Float64Array(half)];
  const cur = new Float64Array(half);
  const norm = 2 / W;
  for (let n = 0; n < frames; n++) {
    // frame n is centred on n*hop (zero padded at the edges)
    const start = n * hop - half;
    let e = 0;
    for (let i = 0; i < W; i++) {
      const j = start + i;
      const v = j >= 0 && j < samples.length ? samples[j] : 0;
      e += v * v;
      re[i] = v * w[i];
      im[i] = 0;
    }
    db[n] = toDb(Math.sqrt(e / W));
    fftInPlace(re, im);
    let f = 0;
    for (let k = 0; k < half; k++) cur[k] = Math.log1p(1000 * norm * Math.hypot(re[k], im[k]));
    const ref = hist[n % 2]; // the frame two hops back
    if (n >= 2) for (let k = 0; k < half; k++) {
      const m = Math.max(ref[k], k > 0 ? ref[k - 1] : 0, k + 1 < half ? ref[k + 1] : 0);
      if (cur[k] > m) f += cur[k] - m;
    }
    flux[n] = f;
    ref.set(cur);
  }
  return { flux, db, hopS: hop / sampleRate, windowS: W / sampleRate };
}

/**
 * Onset times in seconds. Peak picking on the flux (after Böck et al.): a frame is an onset
 * when it is the local maximum (±3 frames), clears the local mean (±60 ms) by `delta` of the
 * strongest flux, stands well above the recording's typical flux (so steady noise gives
 * nothing), and comes at least `minGapS` after the previous onset. Each peak is then moved to
 * where the amplitude envelope actually starts rising, which is sharper than the frame grid.
 */
export function detectOnsets(samples: Float32Array, sampleRate: number, opts: OnsetOptions = {}): number[] {
  const { flux, db, hopS, windowS } = onsetStrength(samples, sampleRate);
  if (!flux.length) return [];
  let max = 0;
  for (const f of flux) max = Math.max(max, f);
  if (max <= 0) return [];
  const loudest = Math.max(...db);
  const gate = Math.max(-65, loudest - 45);
  // typical flux over the sounding part: the floor that steady noise or sustained tone produces
  const sounding = Array.from(flux).filter((_, i) => db[i] > gate);
  const floor = percentile(sounding, 50);
  const delta = (opts.delta ?? 0.06) * max;
  const minGap = opts.minGapS ?? 0.05;
  const pre = Math.round(0.06 / hopS);
  const post = Math.round(0.06 / hopS);
  const peaks: number[] = [];
  let last = -Infinity;
  for (let n = 1; n < flux.length - 1; n++) {
    const f = flux[n];
    if (f <= 0) continue;
    let isMax = true;
    for (let k = Math.max(0, n - 3); k <= Math.min(flux.length - 1, n + 3); k++) if (flux[k] > f) isMax = false;
    if (!isMax) continue;
    let s = 0;
    let c = 0;
    for (let k = Math.max(0, n - pre); k <= Math.min(flux.length - 1, n + post); k++) {
      s += flux[k];
      c++;
    }
    if (f < s / c + delta) continue;
    if (f < 3 * floor) continue;
    // the sound after the peak must be audible and not fading: the end of a note splatters
    // energy across many bins too, but there the level drops
    const span = Math.ceil(windowS / hopS);
    const after = Math.max(...Array.from(db.subarray(n, Math.min(db.length, n + span + 1))));
    const later = db[Math.min(db.length - 1, n + span)];
    const earlier = db[Math.max(0, n - span)];
    if (after < gate || later < earlier - 3) continue;
    const t = n * hopS;
    if (t - last < minGap) continue;
    peaks.push(t);
    last = t;
  }
  return refineOnsets(samples, sampleRate, peaks, windowS);
}

/**
 * Moves each flux peak to the start of the attack: within the window around the peak, find the
 * quietest point before the loudest point, and take the first moment the 1 ms envelope climbs
 * 20% of the way from that low to that high. Where the level hardly changes (a legato change of
 * pitch) the flux peak time is kept.
 */
function refineOnsets(samples: Float32Array, sampleRate: number, peaks: number[], windowS: number): number[] {
  if (!peaks.length) return peaks;
  const env = levelEnvelope(samples, sampleRate, 0.001, 0.008);
  const out: number[] = [];
  for (let i = 0; i < peaks.length; i++) {
    const tp = peaks[i];
    const lo = Math.max(0, Math.round((tp - 0.03) * 1000), out.length ? Math.round(out[out.length - 1] * 1000) + 15 : 0);
    const hi = Math.min(env.length - 1, Math.round((tp + windowS + 0.02) * 1000), i + 1 < peaks.length ? Math.round(peaks[i + 1] * 1000) - 5 : Infinity);
    if (hi <= lo + 2) {
      out.push(tp);
      continue;
    }
    let iMax = lo;
    for (let k = lo; k <= hi; k++) if (env[k] > env[iMax]) iMax = k;
    let iMin = lo;
    for (let k = lo; k <= iMax; k++) if (env[k] < env[iMin]) iMin = k;
    const a = env[iMin];
    const b = env[iMax];
    if (b < 1.4 * a + 1e-5) {
      out.push(tp);
      continue;
    }
    const thr = a + 0.2 * (b - a);
    let k = iMin;
    while (k < iMax && env[k] < thr) k++;
    out.push(k / 1000);
  }
  return out;
}

export interface DetectedNote {
  /** onset, seconds */
  t: number;
  end: number;
  hz: number;
  /** fractional MIDI number at the tuning used */
  midi: number;
  name: string;
  /** distance from the nearest equal-tempered note */
  cents: number;
  clarity: number;
  /** loudest frame, dBFS */
  db: number;
}

export interface NoteOptions {
  tuning?: number;
  track?: PitchFrame[];
  onsets?: number[];
  /** shortest note kept, default 35 ms */
  minDurS?: number;
}

/**
 * Notes from the pitch track: consecutive voiced frames whose pitch stays within half a
 * semitone of the run's recent median form one note. A run ends at an unvoiced frame, at a pitch
 * change that lasts two frames (a one-frame jump is ignored as a glitch), or at an onset (a
 * repeated note). Each note's start is moved to the onset just before its first voiced frame;
 * its pitch is the median of its inner frames.
 */
export function detectNotes(samples: Float32Array, sampleRate: number, opts: NoteOptions = {}): DetectedNote[] {
  const tuning = opts.tuning ?? 440;
  const track = opts.track ?? detectPitchTrack(samples, sampleRate);
  const onsets = (opts.onsets ?? detectOnsets(samples, sampleRate)).slice().sort((a, b) => a - b);
  if (track.length < 2) return [];
  const hopS = track[1].t - track[0].t;
  const winS = 2 * track[0].t;
  const minFrames = Math.max(2, Math.round((opts.minDurS ?? 0.035) / hopS));
  const runs: PitchFrame[][] = [];
  let run: PitchFrame[] = [];
  let oi = 0;
  const close = () => {
    if (run.length) runs.push(run);
    run = [];
  };
  const recentMedian = (r: PitchFrame[]) => {
    const m = r.slice(-5).map((f) => hzToMidi(f.hz, tuning)).sort((a, b) => a - b);
    return m[m.length >> 1];
  };
  for (let i = 0; i < track.length; i++) {
    const f = track[i];
    if (!f.hz) {
      close();
      continue;
    }
    // an onset between the previous frame and this one (shifted by a quarter window) splits a run
    let split = false;
    while (oi < onsets.length && onsets[oi] + winS / 4 <= f.t) {
      // the run's own onset sits within half a window of its first frame; later ones re-strike it
      if (run.length && onsets[oi] > run[0].t + winS / 2 + hopS) split = true;
      oi++;
    }
    if (split) close();
    if (run.length) {
      const m = hzToMidi(f.hz, tuning);
      const ref = recentMedian(run);
      if (Math.abs(m - ref) > 0.5) {
        const next = track[i + 1];
        const persists = next && next.hz && Math.abs(hzToMidi(next.hz, tuning) - m) <= 0.5;
        if (!persists) continue; // a one-frame glitch
        close();
      }
    }
    run.push(f);
  }
  close();

  const used = new Set<number>();
  const notes: DetectedNote[] = [];
  for (const r of runs) {
    if (r.length < minFrames) continue;
    const inner = r.length >= 5 ? r.slice(1, -1) : r;
    const hzs = inner.map((f) => f.hz).sort((a, b) => a - b);
    const hz = hzs[hzs.length >> 1];
    const midi = hzToMidi(hz, tuning);
    const first = r[0].t;
    // A window gets a clear pitch once a fraction of it holds the new note, so the first voiced
    // frame's centre sits up to half a window before the note's onset. The onset that starts this
    // note is the unused one nearest to a quarter window after that frame.
    const guess = first + winS / 4;
    let t = guess;
    let bestK = -1;
    for (let k = 0; k < onsets.length; k++) {
      const o = onsets[k];
      if (used.has(k) || o < first - winS / 2 - 0.03 || o > first + winS / 2 + 0.01) continue;
      if (bestK < 0 || Math.abs(o - guess) < Math.abs(onsets[bestK] - guess)) bestK = k;
    }
    if (bestK >= 0) {
      t = onsets[bestK];
      used.add(bestK);
    }
    notes.push({
      t,
      end: r[r.length - 1].t + hopS / 2,
      hz,
      midi,
      name: midiName(midi),
      cents: (midi - Math.round(midi)) * 100,
      clarity: inner.reduce((s, f) => s + f.clarity, 0) / inner.length,
      db: Math.max(...r.map((f) => f.db))
    });
  }
  return notes;
}

/** Peak level (dBFS) in the `winS` after time t, from 10 ms windows. */
export function levelAt(samples: Float32Array, sampleRate: number, t: number, winS = 0.08): number {
  const a = Math.max(0, Math.round(t * sampleRate));
  const b = Math.min(samples.length, Math.round((t + winS) * sampleRate));
  const step = Math.max(1, Math.round(0.01 * sampleRate));
  let best = 0;
  for (let i = a; i < b; i += step) best = Math.max(best, rmsOf(samples, i, i + step));
  return toDb(best);
}
