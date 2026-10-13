/**
 * Turns a clip of pose frames into per-point arrays (x, y, z, visibility over time) and builds the
 * derived points a metric spec can name: mid_hip, mid_shoulder, head, center_of_mass and ground.
 * Coordinates stay normalized to the frame (x, y in [0,1], top-left origin). Geometry that needs
 * true proportions multiplies x by the aspect ratio (width / height), so one unit = one frame height.
 */
import { DERIVED_POINTS, FACE_LANDMARKS, HAND_LANDMARKS, HAND_PREFIXES, OBJECT_CLASSES, OBJECT_PREFIX, POSE_GROUPS, POSE_LANDMARKS, isKnownPoint } from "@las/schema";
import type { Point, PoseFrame } from "../types.js";

export interface Track {
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
  /** visibility / detection confidence in [0,1]; 0 when the point is missing or out of frame */
  conf: Float64Array;
}

/** Below this visibility a landmark is treated as not seen. */
export const VISIBLE = 0.5;
/** Landmarks this far outside the frame are treated as not seen. */
const FRAME_MARGIN = 0.02;

/** Relative mass of body segments (after Dempster/Winter), used for the centre of mass. */
const COM_SEGMENTS: [string, string, number][] = [
  ["head", "head", 0.081],
  ["mid_shoulder", "mid_hip", 0.497],
  ["left_shoulder", "left_elbow", 0.028],
  ["right_shoulder", "right_elbow", 0.028],
  ["left_elbow", "left_wrist", 0.022],
  ["right_elbow", "right_wrist", 0.022],
  ["left_hip", "left_knee", 0.1],
  ["right_hip", "right_knee", 0.1],
  ["left_knee", "left_ankle", 0.061],
  ["right_knee", "right_ankle", 0.061]
];
const HEAD_POINTS = ["nose", "left_eye", "right_eye", "left_ear", "right_ear"];
const FOOT_POINTS = ["left_ankle", "right_ankle", "left_heel", "right_heel", "left_foot_index", "right_foot_index"];

/** Look a raw (tracked, not derived) point up in one frame. */
export function rawPoint(f: PoseFrame, name: string): Point | undefined {
  const dot = name.indexOf(".");
  if (dot > 0) {
    const prefix = name.slice(0, dot);
    const rest = name.slice(dot + 1);
    if (prefix === "left_hand") return f.hands?.left?.[rest];
    if (prefix === "right_hand") return f.hands?.right?.[rest];
    if (prefix === OBJECT_PREFIX) {
      const o = f.objects?.[rest.replace(/_/g, " ")] ?? f.objects?.[rest];
      return o?.center;
    }
    return undefined;
  }
  if (name in FACE_LANDMARKS) return f.face?.[name];
  return f.pose?.[name];
}

/** Is this point seen in the frame: visible enough and inside it? */
export function seen(p: Point | undefined, minVisibility = VISIBLE): boolean {
  if (!p) return false;
  const [x, y, , c] = p;
  return c >= minVisibility && x >= -FRAME_MARGIN && x <= 1 + FRAME_MARGIN && y >= -FRAME_MARGIN && y <= 1 + FRAME_MARGIN;
}

/** The tracked points a derived point is built from (itself when it isn't derived). */
export function constituents(name: string): string[] {
  switch (name) {
    case "mid_hip":
      return ["left_hip", "right_hip"];
    case "mid_shoulder":
      return ["left_shoulder", "right_shoulder"];
    case "head":
      return HEAD_POINTS;
    case "center_of_mass":
      return ["left_shoulder", "right_shoulder", "left_hip", "right_hip", "left_knee", "right_knee", "left_ankle", "right_ankle", "nose"];
    case "ground":
      return FOOT_POINTS;
    case "vertical":
    case "horizontal":
      return [];
  }
  return [name];
}

/** Expand body groups (`legs`, `hips`, ...) and derived points into tracked point names. */
export function expandPointNames(names: string[]): string[] {
  const out = new Set<string>();
  for (const n of names) {
    if (n in POSE_GROUPS) POSE_GROUPS[n].forEach((p) => out.add(p));
    else for (const c of constituents(n)) out.add(c);
  }
  return [...out];
}

export function isDirection(name: string): boolean {
  return name === "vertical" || name === "horizontal";
}

/** Every point name a clip might use: body, face, both hands and the objects present. */
export function allPointNames(frames: PoseFrame[]): string[] {
  const names = new Set<string>([...POSE_LANDMARKS, ...Object.keys(FACE_LANDMARKS)]);
  for (const p of HAND_PREFIXES) for (const h of HAND_LANDMARKS) names.add(`${p}.${h}`);
  for (const o of OBJECT_CLASSES) names.add(`${OBJECT_PREFIX}.${o.replace(/ /g, "_")}`);
  for (const f of frames) for (const k of Object.keys(f.objects ?? {})) names.add(`${OBJECT_PREFIX}.${k.replace(/ /g, "_")}`);
  return [...names];
}

function percentile(values: number[], q: number): number {
  const s = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const i = Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))));
  return s[i];
}

/** All point tracks of one clip, built on demand and cached. */
export class Tracks {
  readonly n: number;
  readonly t: Float64Array;
  readonly aspect: number;
  readonly fps: number;
  private cache = new Map<string, Track | null>();

  constructor(readonly frames: PoseFrame[], fps: number, width = 1, height = 1) {
    this.n = frames.length;
    this.fps = fps > 0 ? fps : 30;
    this.t = Float64Array.from(frames, (f, i) => (Number.isFinite(f.t) ? f.t : i / this.fps));
    this.aspect = width > 0 && height > 0 ? width / height : 1;
  }

  /** Median time step in seconds. */
  get dt(): number {
    if (this.n < 2) return 1 / this.fps;
    const d: number[] = [];
    for (let i = 1; i < this.n; i++) d.push(this.t[i] - this.t[i - 1]);
    const m = percentile(d, 0.5);
    return m > 0 ? m : 1 / this.fps;
  }

  /** A track for any known point name, or null when it isn't known or never seen. */
  get(name: string): Track | null {
    if (this.cache.has(name)) return this.cache.get(name)!;
    const tr = this.build(name);
    this.cache.set(name, tr);
    return tr;
  }

  private empty(): Track {
    const n = this.n;
    return { x: new Float64Array(n).fill(NaN), y: new Float64Array(n).fill(NaN), z: new Float64Array(n).fill(NaN), conf: new Float64Array(n) };
  }

  private build(name: string): Track | null {
    if ((DERIVED_POINTS as readonly string[]).includes(name)) return isDirection(name) ? null : this.derived(name);
    if (!isKnownPoint(name)) return null;
    const tr = this.empty();
    let any = false;
    this.frames.forEach((f, i) => {
      const p = rawPoint(f, name);
      if (!p) return;
      any = true;
      tr.x[i] = p[0];
      tr.y[i] = p[1];
      tr.z[i] = Number.isFinite(p[2]) ? p[2] : 0;
      tr.conf[i] = seen(p, 0) ? Math.max(0, Math.min(1, p[3])) : 0;
    });
    return any ? tr : null;
  }

  /** Weighted average of tracks per frame, skipping points seen with visibility < 0.3. */
  private blend(parts: [Track | null, number][]): Track {
    const tr = this.empty();
    for (let i = 0; i < this.n; i++) {
      let w = 0;
      let x = 0;
      let y = 0;
      let z = 0;
      let c = 0;
      for (const [p, weight] of parts) {
        if (!p || !(p.conf[i] >= 0.3) || !Number.isFinite(p.x[i])) continue;
        w += weight;
        x += weight * p.x[i];
        y += weight * p.y[i];
        z += weight * p.z[i];
        c += weight * p.conf[i];
      }
      const total = parts.reduce((s, [, wt]) => s + wt, 0);
      if (w > 0) {
        tr.x[i] = x / w;
        tr.y[i] = y / w;
        tr.z[i] = z / w;
        // confidence drops when parts are missing
        tr.conf[i] = (c / w) * (w / total);
      }
    }
    return tr;
  }

  private derived(name: string): Track | null {
    switch (name) {
      case "mid_hip":
        return this.blend([
          [this.get("left_hip"), 1],
          [this.get("right_hip"), 1]
        ]);
      case "mid_shoulder":
        return this.blend([
          [this.get("left_shoulder"), 1],
          [this.get("right_shoulder"), 1]
        ]);
      case "head": {
        const tr = this.blend(HEAD_POINTS.map((p) => [this.get(p), 1] as [Track | null, number]));
        // the head is seen when any of its points is: use the best visibility, not the share
        for (let i = 0; i < this.n; i++) tr.conf[i] = Math.max(0, ...HEAD_POINTS.map((p) => this.get(p)?.conf[i] ?? 0));
        return tr;
      }
      case "center_of_mass": {
        const parts: [Track | null, number][] = COM_SEGMENTS.map(([a, b, w]) => [this.mid(a, b), w]);
        return this.blend(parts);
      }
      case "ground": {
        // the floor: where the lowest foot point usually is (95th percentile of its y over the clip)
        const feet = FOOT_POINTS.map((p) => this.get(p));
        const lows: number[] = [];
        for (let i = 0; i < this.n; i++) {
          let m = -Infinity;
          for (const f of feet) if (f && f.conf[i] >= VISIBLE) m = Math.max(m, f.y[i]);
          if (m > -Infinity) lows.push(m);
        }
        const g = percentile(lows, 0.95);
        const tr = this.blend([
          [this.get("left_ankle"), 1],
          [this.get("right_ankle"), 1]
        ]);
        if (!Number.isFinite(g)) return null;
        tr.y.fill(g);
        tr.z.fill(0);
        return tr;
      }
    }
    return null;
  }

  /** Midpoint of two points (for a segment's centre of mass); the head counts as one point. */
  private mid(a: string, b: string): Track | null {
    if (a === b) return this.get(a);
    return this.blend([
      [this.get(a), 1],
      [this.get(b), 1]
    ]);
  }

  /** Share of frames in which a point is seen (visibility ≥ minVisibility and inside the frame). */
  visibleShare(name: string, minVisibility = VISIBLE, idx?: ArrayLike<number>): number {
    if (isDirection(name)) return 1;
    const tr = this.get(name);
    if (!tr) return 0;
    const ids = idx ?? Array.from({ length: this.n }, (_, i) => i);
    if (!ids.length) return 0;
    let k = 0;
    for (let j = 0; j < ids.length; j++) if (tr.conf[ids[j]] >= minVisibility) k++;
    return k / ids.length;
  }

  /** Mean confidence of a point over frames. */
  meanConf(name: string, idx?: ArrayLike<number>): number {
    if (isDirection(name)) return 1;
    const tr = this.get(name);
    if (!tr) return 0;
    const ids = idx ?? Array.from({ length: this.n }, (_, i) => i);
    if (!ids.length) return 0;
    let s = 0;
    for (let j = 0; j < ids.length; j++) s += tr.conf[ids[j]];
    return s / ids.length;
  }

  /**
   * Body height in frame-height units, estimated from nose-to-ankle distance when standing tall
   * (90th percentile over the clip). The nose sits at about 89% of stature above the ankles.
   */
  stature(): number {
    const nose = this.get("nose");
    const la = this.get("left_ankle");
    const ra = this.get("right_ankle");
    if (!nose || (!la && !ra)) return NaN;
    const d: number[] = [];
    for (let i = 0; i < this.n; i++) {
      const ankles = [la, ra].filter((a): a is Track => !!a && a.conf[i] >= VISIBLE);
      if (nose.conf[i] < VISIBLE || !ankles.length) continue;
      const ax = ankles.reduce((s, a) => s + a.x[i], 0) / ankles.length;
      const ay = ankles.reduce((s, a) => s + a.y[i], 0) / ankles.length;
      d.push(Math.hypot((ax - nose.x[i]) * this.aspect, ay - nose.y[i]));
    }
    return percentile(d, 0.9) / 0.89;
  }

  /** Median torso length (mid_shoulder to mid_hip) in frame-height units. */
  torso(): number {
    const s = this.get("mid_shoulder");
    const h = this.get("mid_hip");
    if (!s || !h) return NaN;
    const d: number[] = [];
    for (let i = 0; i < this.n; i++) if (s.conf[i] >= 0.3 && h.conf[i] >= 0.3) d.push(Math.hypot((s.x[i] - h.x[i]) * this.aspect, s.y[i] - h.y[i]));
    return percentile(d, 0.5);
  }
}

export { percentile };
