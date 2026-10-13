/**
 * Small signal-processing helpers shared by the audio and speech engines: an in-place FFT,
 * windows, levels in dBFS and robust statistics. Everything here is plain arithmetic over
 * Float32Arrays so it runs the same in the browser and in Node.
 */

/** Smallest power of two >= n. */
export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** Power-of-two frame length closest to `seconds` at this sample rate, at least `min`. */
export function frameLength(seconds: number, sampleRate: number, min = 256): number {
  const target = Math.max(min, seconds * sampleRate);
  const up = nextPow2(target);
  const down = up >> 1;
  return Math.max(min, target - down < up - target ? down : up);
}

const hannCache = new Map<number, Float32Array>();
/** Hann window of length n (cached). */
export function hann(n: number): Float32Array {
  let w = hannCache.get(n);
  if (!w) {
    w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    hannCache.set(n, w);
  }
  return w;
}

/**
 * Iterative radix-2 Cooley-Tukey FFT, in place. `re` and `im` must have the same
 * power-of-two length. Used for the onset detector's short-time spectra.
 */
export function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  // bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  // butterflies
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/** Root mean square of samples[start, end). */
export function rmsOf(samples: ArrayLike<number>, start = 0, end = samples.length): number {
  let s = 0;
  const a = Math.max(0, start);
  const b = Math.min(samples.length, end);
  for (let i = a; i < b; i++) s += samples[i] * samples[i];
  return b > a ? Math.sqrt(s / (b - a)) : 0;
}

/** Amplitude to dBFS, floored at -120. */
export function toDb(amp: number): number {
  return amp > 1e-6 ? 20 * Math.log10(amp) : -120;
}

/** p-th percentile (0..100) by linear interpolation; NaN for empty input. */
export function percentile(values: ArrayLike<number>, p: number): number {
  const s = Array.from(values).filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const pos = (p / 100) * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/** Least-squares line y = a + b*x. Returns NaN slope for fewer than 2 distinct x. */
export function linearFit(x: ArrayLike<number>, y: ArrayLike<number>): { a: number; b: number } {
  const n = Math.min(x.length, y.length);
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += x[i];
    sy += y[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (x[i] - mx) ** 2;
    sxy += (x[i] - mx) * (y[i] - my);
  }
  const b = sxx > 1e-12 ? sxy / sxx : NaN;
  return { a: my - (Number.isFinite(b) ? b : 0) * mx, b };
}

/** Linear-interpolation resampling (used to hand 16 kHz audio to speech models). */
export function resampleLinear(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return samples;
  const n = Math.max(1, Math.round((samples.length * to) / from));
  const out = new Float32Array(n);
  const r = from / to;
  for (let i = 0; i < n; i++) {
    const x = i * r;
    const i0 = Math.floor(x);
    const f = x - i0;
    const a = samples[i0] ?? 0;
    const b = samples[i0 + 1] ?? a;
    out[i] = a + (b - a) * f;
  }
  return out;
}
