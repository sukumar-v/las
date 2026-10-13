/**
 * Comparing a learner's clip with a reference clip.
 *
 * Each frame becomes a body shape: the chosen joints relative to the hip centre, divided by the
 * clip's torso length, so where someone stands in the frame and how big they appear don't matter.
 * Dynamic time warping (DTW) then lines the two sequences up so a slower or later learner is
 * compared with the matching moment of the reference, not the same clock time. Similarity is
 * exp(-d / 0.35), where d is the mean distance between matched joints in torso lengths: identical
 * shapes give 1, a joint off by a third of a torso gives about 0.37.
 */
import { POSE_GROUPS } from "@las/schema";
import type { PoseFrame } from "../types.js";
import { expandPointNames, rawPoint } from "./tracks.js";

export interface ReferenceComparison {
  /** 0..1, 1 = the same shapes in the same order */
  similarity: number;
  /** matched [learner frame, reference frame] pairs, both indices non-decreasing (every k-th frame for very long clips) */
  path: [number, number][];
  /** similarity per joint along the path */
  perJoint: Record<string, number>;
  /** similarity at each learner frame, for drawing a timeline */
  aligned: { t: number; similarity: number }[];
}

export interface CompareOptions {
  /** `dtw` (default) lines up by shape; `linear` stretches the reference to the learner's length; `none` compares the same clock time */
  align?: "dtw" | "linear" | "none";
  /** the learner clip may match any stretch of the reference (open start and end); used per segment */
  subsequence?: boolean;
  /** width / height of both clips, to undo the stretch of normalized coordinates; default 1 */
  aspect?: number;
}

export const SIMILARITY_SCALE = 0.35;
/** Largest DTW grid computed at full frame rate (about 2000 × 2000 frames). */
const MAX_DTW_CELLS = 4e6;
const DEFAULT_JOINTS = [...POSE_GROUPS.torso, ...POSE_GROUPS.arms, ...POSE_GROUPS.legs];

/** Joint names for comparison: body groups expand (`legs`, and `head` as the head group), derived points expand to what they're built from. */
export function resolveJoints(joints?: string[]): string[] {
  if (!joints || !joints.length) return DEFAULT_JOINTS;
  const out = expandPointNames(joints);
  return out.length ? out : DEFAULT_JOINTS;
}

type Shape = Float64Array; // [x0, y0, x1, y1, ...] with NaN for unseen joints

function median(a: number[]): number {
  const s = a.filter(Number.isFinite).sort((x, y) => x - y);
  return s.length ? s[s.length >> 1] : NaN;
}

/** Body-centred, scale-normalized shapes for a clip. */
export function shapes(frames: PoseFrame[], joints: string[], aspect = 1): Shape[] {
  const pt = (f: PoseFrame, n: string) => {
    const p = rawPoint(f, n);
    return p && p[3] >= 0.3 ? p : undefined;
  };
  const mid = (f: PoseFrame, a: string, b: string): [number, number] | undefined => {
    const pa = pt(f, a);
    const pb = pt(f, b);
    if (pa && pb) return [((pa[0] + pb[0]) / 2) * aspect, (pa[1] + pb[1]) / 2];
    const p = pa ?? pb;
    return p ? [p[0] * aspect, p[1]] : undefined;
  };
  const torsoLens: number[] = [];
  for (const f of frames) {
    const s = mid(f, "left_shoulder", "right_shoulder");
    const h = mid(f, "left_hip", "right_hip");
    if (s && h) torsoLens.push(Math.hypot(s[0] - h[0], s[1] - h[1]));
  }
  let scale = median(torsoLens);
  return frames.map((f) => {
    const out = new Float64Array(joints.length * 2).fill(NaN);
    let c = mid(f, "left_hip", "right_hip");
    const seen: [number, number][] = [];
    joints.forEach((j) => {
      const p = pt(f, j);
      if (p) seen.push([p[0] * aspect, p[1]]);
    });
    if (!c && seen.length) c = [seen.reduce((s, p) => s + p[0], 0) / seen.length, seen.reduce((s, p) => s + p[1], 0) / seen.length];
    if (!c) return out;
    if (!(scale > 0)) {
      // no torso: use the spread of the joints instead
      const r = Math.sqrt(seen.reduce((s, p) => s + (p[0] - c![0]) ** 2 + (p[1] - c![1]) ** 2, 0) / Math.max(1, seen.length));
      scale = r > 0 ? r : 1;
    }
    joints.forEach((j, k) => {
      const p = pt(f, j);
      if (!p) return;
      out[2 * k] = (p[0] * aspect - c![0]) / scale;
      out[2 * k + 1] = (p[1] - c![1]) / scale;
    });
    return out;
  });
}

/** Mean distance between joints seen in both shapes; NaN when none is shared. */
function shapeDistance(a: Shape, b: Shape, perJoint?: Float64Array, counts?: Float64Array): number {
  let s = 0;
  let k = 0;
  for (let j = 0; j < a.length; j += 2) {
    const dx = a[j] - b[j];
    const dy = a[j + 1] - b[j + 1];
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) continue;
    const d = Math.hypot(dx, dy);
    s += d;
    k++;
    if (perJoint && counts) {
      perJoint[j >> 1] += d;
      counts[j >> 1]++;
    }
  }
  return k ? s / k : NaN;
}

/**
 * Dynamic time warping: the cheapest monotonic path through the frame-to-frame distance grid,
 * stepping right, down or diagonally. With `subsequence`, the path may start and end anywhere along
 * the reference (the learner's clip is matched to the best stretch of it).
 */
export function dtwPath(a: Shape[], b: Shape[], subsequence = false): [number, number][] {
  const n = a.length;
  const m = b.length;
  if (!n || !m) return [];
  const cost = (i: number, j: number) => {
    const d = shapeDistance(a[i], b[j]);
    return Number.isFinite(d) ? d : 10;
  };
  const D = new Float64Array(n * m);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      const c = cost(i, j);
      let best: number;
      if (i === 0 && j === 0) best = 0;
      else if (i === 0) best = subsequence ? 0 : D[j - 1];
      else if (j === 0) best = D[(i - 1) * m];
      else best = Math.min(D[(i - 1) * m + j], D[i * m + j - 1], D[(i - 1) * m + j - 1]);
      D[i * m + j] = c + best;
    }
  }
  let j = m - 1;
  if (subsequence) {
    for (let k = 0; k < m; k++) if (D[(n - 1) * m + k] < D[(n - 1) * m + j]) j = k;
  }
  let i = n - 1;
  const path: [number, number][] = [[i, j]];
  while (i > 0 || j > 0) {
    if (i === 0) {
      if (subsequence) break;
      j--;
    } else if (j === 0) i--;
    else {
      const diag = D[(i - 1) * m + j - 1];
      const up = D[(i - 1) * m + j];
      const left = D[i * m + j - 1];
      if (diag <= up && diag <= left) {
        i--;
        j--;
      } else if (up <= left) i--;
      else j--;
    }
    path.push([i, j]);
  }
  return path.reverse();
}

function similarityOf(d: number): number {
  return Number.isFinite(d) ? Math.exp(-d / SIMILARITY_SCALE) : 0;
}

/** Compare a learner clip with a reference clip over the chosen joints (default: torso, arms and legs). */
export function compareToReference(learner: PoseFrame[], reference: PoseFrame[], joints?: string[], opts: CompareOptions = {}): ReferenceComparison {
  const names = resolveJoints(joints);
  const aspect = opts.aspect ?? 1;
  const a = shapes(learner, names, aspect);
  const b = shapes(reference, names, aspect);
  let path: [number, number][];
  const align = opts.align ?? "dtw";
  if (!a.length || !b.length) path = [];
  else if (align === "dtw") {
    // long clips: warp every k-th frame so the grid stays under MAX_DTW_CELLS, then map back
    const k = Math.max(1, Math.ceil(Math.sqrt((a.length * b.length) / MAX_DTW_CELLS)));
    if (k === 1) path = dtwPath(a, b, opts.subsequence);
    else {
      const every = (s: Shape[]) => s.filter((_, i) => i % k === 0);
      path = dtwPath(every(a), every(b), opts.subsequence).map(([i, j]) => [i * k, j * k]);
    }
  }
  else if (align === "linear") path = a.map((_, i) => [i, a.length > 1 ? Math.round((i * (b.length - 1)) / (a.length - 1)) : 0]);
  else path = a.map((_, i) => [i, Math.min(i, b.length - 1)] as [number, number]);
  const perJ = new Float64Array(names.length);
  const counts = new Float64Array(names.length);
  let total = 0;
  let k = 0;
  const byFrame = new Map<number, number[]>();
  for (const [i, j] of path) {
    const d = shapeDistance(a[i], b[j], perJ, counts);
    if (!Number.isFinite(d)) continue;
    total += d;
    k++;
    const list = byFrame.get(i) ?? [];
    list.push(d);
    byFrame.set(i, list);
  }
  const perJoint: Record<string, number> = {};
  names.forEach((nm, j) => {
    if (counts[j]) perJoint[nm] = similarityOf(perJ[j] / counts[j]);
  });
  const aligned = [...byFrame.entries()].sort((x, y) => x[0] - y[0]).map(([i, ds]) => ({ t: learner[i].t, similarity: similarityOf(ds.reduce((s, d) => s + d, 0) / ds.length) }));
  return { similarity: k ? similarityOf(total / k) : 0, path, perJoint, aligned };
}

