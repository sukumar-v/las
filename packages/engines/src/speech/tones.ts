/**
 * Tone contours for tonal languages, from pitch alone. Each syllable's pitch (Hz) becomes
 * semitones relative to its own median, is median-smoothed, and is described by where it
 * starts, ends, dips and peaks. That gives a shape: level, rising, falling, falling-rising
 * (dipping) or rising-falling (peaking); too little voiced pitch is "neutral". Which tone
 * number means which shape is language data (see DEFAULT_TONE_SHAPES), never code.
 */

export type ToneShape = "level" | "rising" | "falling" | "falling-rising" | "rising-falling" | "neutral";

/**
 * The common tone numbering for contour tones (as in pinyin: 1 level, 2 rising, 3 dipping,
 * 4 falling, 0 or 5 neutral). Languages with other numberings pass their own map through the
 * analyze context (`toneShapes`). A neutral tone accepts any shape.
 */
export const DEFAULT_TONE_SHAPES: Record<number, ToneShape[]> = {
  0: ["neutral", "level", "rising", "falling", "falling-rising", "rising-falling"],
  1: ["level"],
  2: ["rising"],
  3: ["falling-rising"],
  4: ["falling"],
  5: ["neutral", "level", "rising", "falling", "falling-rising", "rising-falling"]
};

/** semitones a contour must move to count as moving */
const MOVE_ST = 1.5;
/** semitones a dip or peak must stand out from both ends */
const TURN_ST = 1.0;

export interface ToneContour {
  shape: ToneShape;
  /** fitted change across the syllable, semitones (positive = rising) */
  slope: number;
  /** the voiced contour in semitones relative to its median */
  st: number[];
}

/** Classifies one syllable's pitch series (Hz; 0 or NaN = unvoiced frames, which are skipped). */
export function classifyToneContour(hzSeries: ArrayLike<number>): ToneContour {
  const hz = Array.from(hzSeries).filter((x) => Number.isFinite(x) && x > 0);
  if (hz.length < 4) return { shape: "neutral", slope: 0, st: [] };
  const sorted = hz.slice().sort((a, b) => a - b);
  const med = sorted[sorted.length >> 1];
  const raw = hz.map((x) => 12 * Math.log2(x / med));
  // 3-point median smoothing removes single-frame octave slips
  const st = raw.map((_, i) => {
    const w = raw.slice(Math.max(0, i - 1), i + 2).sort((a, b) => a - b);
    return w[w.length >> 1];
  });
  const n = st.length;
  const k = Math.max(1, Math.round(n * 0.2));
  const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
  const start = avg(st.slice(0, k));
  const end = avg(st.slice(n - k));
  const mid = st.slice(Math.max(1, Math.floor(n * 0.2)), Math.max(2, Math.ceil(n * 0.8)));
  const lo = Math.min(...mid);
  const hi = Math.max(...mid);
  // least-squares slope over the syllable, scaled to its length
  const xm = (n - 1) / 2;
  const ym = avg(st);
  let sxy = 0;
  let sxx = 0;
  st.forEach((y, i) => {
    sxy += (i - xm) * (y - ym);
    sxx += (i - xm) ** 2;
  });
  const slope = sxx ? (sxy / sxx) * (n - 1) : 0;
  let shape: ToneShape;
  if (start - lo >= TURN_ST && end - lo >= MOVE_ST) shape = "falling-rising";
  else if (hi - start >= MOVE_ST && hi - end >= MOVE_ST) shape = "rising-falling";
  else if (end - start >= MOVE_ST) shape = "rising";
  else if (start - end >= MOVE_ST) shape = "falling";
  else shape = "level";
  return { shape, slope, st };
}

export interface Syllable {
  start: number;
  end: number;
  word: string;
}

export interface SyllableInput {
  /** how many syllables to find (the tone pattern's length) */
  count: number;
  words?: { word: string; start: number; end: number }[];
  /** pitch frames, to split by voicing when the words don't give syllables */
  pitchTrack?: { t: number; hz: number }[];
}

const NO_SPACE_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Tibetan}]/u;

/**
 * Finds syllable time spans. In order of preference: one word per syllable (languages that
 * write syllables apart); words split evenly by their characters when each character is a
 * syllable (Han script); voiced stretches of the pitch track, merged across the smallest gaps or
 * split at the longest stretch until the count matches; or the speech span cut into equal parts.
 */
export function segmentSyllables(input: SyllableInput): Syllable[] {
  const { count } = input;
  const words = (input.words ?? []).filter((w) => w.end > w.start || Number.isFinite(w.start));
  if (count <= 0) return [];
  if (words.length === count) return words.map((w) => ({ start: w.start, end: w.end, word: w.word }));

  const units = words.map((w) => Math.max(1, Array.from(w.word.trim()).filter((c) => NO_SPACE_CHAR.test(c)).length));
  if (words.length && units.reduce((s, u) => s + u, 0) === count) {
    const out: Syllable[] = [];
    words.forEach((w, i) => {
      const chars = Array.from(w.word.trim()).filter((c) => NO_SPACE_CHAR.test(c));
      const d = (w.end - w.start) / units[i];
      for (let k = 0; k < units[i]; k++) out.push({ start: w.start + k * d, end: w.start + (k + 1) * d, word: chars[k] ?? w.word });
    });
    return out;
  }

  const track = input.pitchTrack ?? [];
  if (track.length > 2) {
    const hop = track[1].t - track[0].t;
    let runs: [number, number][] = [];
    let s = -1;
    track.forEach((f, i) => {
      if (f.hz > 0 && s < 0) s = i;
      if ((f.hz <= 0 || i === track.length - 1) && s >= 0) {
        const e = f.hz > 0 ? i : i - 1;
        if (e - s >= 2) runs.push([track[s].t - hop / 2, track[e].t + hop / 2]);
        s = -1;
      }
    });
    if (words.length) {
      const a = words[0].start - 0.1;
      const b = words[words.length - 1].end + 0.1;
      runs = runs.filter(([x, y]) => y > a && x < b);
    }
    if (runs.length) {
      while (runs.length > count) {
        let gi = 0;
        for (let i = 1; i < runs.length - 1; i++) if (runs[i + 1][0] - runs[i][1] < runs[gi + 1][0] - runs[gi][1]) gi = i;
        runs.splice(gi, 2, [runs[gi][0], runs[gi + 1][1]]);
      }
      while (runs.length < count) {
        let li = 0;
        for (let i = 1; i < runs.length; i++) if (runs[i][1] - runs[i][0] > runs[li][1] - runs[li][0]) li = i;
        const [x, y] = runs[li];
        runs.splice(li, 1, [x, (x + y) / 2], [(x + y) / 2, y]);
      }
      return runs.map(([x, y]) => ({ start: x, end: y, word: "" }));
    }
  }

  const a = words.length ? words[0].start : (track[0]?.t ?? 0);
  const b = words.length ? words[words.length - 1].end : (track[track.length - 1]?.t ?? 1);
  const d = (b - a) / count;
  return Array.from({ length: count }, (_, i) => ({ start: a + i * d, end: a + (i + 1) * d, word: "" }));
}
