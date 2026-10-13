/**
 * Synthetic pose clips with known ground truth, for testing the movement engine.
 *
 * These are general kinematic generators parameterized by numbers (angles, tempos, beat offsets),
 * not content for any skill: a stick figure built from standard body proportions, moved by simple
 * joint-angle or point trajectories. Every generator is deterministic (seeded noise).
 */
import { HAND_LANDMARKS } from "@las/schema";
import type { Point, PoseFrame } from "../types.js";

/** Small seeded generator (mulberry32) so fixtures are identical on every run. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number): number {
  const u = Math.max(1e-12, rand());
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const rad = (deg: number) => (deg * Math.PI) / 180;
const smoothstep = (u: number) => {
  const x = Math.max(0, Math.min(1, u));
  return x * x * (3 - 2 * x);
};
/** cosine ease from 0 to 1 */
const ease = (u: number) => (1 - Math.cos(Math.PI * Math.max(0, Math.min(1, u)))) / 2;

type V2 = [number, number];
const add = (a: V2, b: V2): V2 => [a[0] + b[0], a[1] + b[1]];
const scale = (a: V2, k: number): V2 => [a[0] * k, a[1] * k];
const lerp = (a: V2, b: V2, u: number): V2 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
/** unit vector at `deg` from straight down, positive toward +x */
const fromDown = (deg: number): V2 => [Math.sin(rad(deg)), Math.cos(rad(deg))];

/** Segment lengths as fractions of stature (after common anthropometric tables). */
export const PROPORTIONS = {
  ankleHeight: 0.039,
  shank: 0.246,
  thigh: 0.245,
  torso: 0.288,
  upperArm: 0.186,
  forearm: 0.146,
  hand: 0.08,
  shoulderHalf: 0.13,
  hipHalf: 0.09,
  neckToHead: 0.09
};

export interface ClipOptions {
  fps?: number;
  width?: number;
  height?: number;
  /** body height in frame heights; default 0.7 */
  stature?: number;
  /** Gaussian landmark noise in frame heights; default 0 */
  noise?: number;
  seed?: number;
  /** also generate the 21 hand landmarks per hand */
  withHands?: boolean;
}

export interface SyntheticClip {
  frames: PoseFrame[];
  fps: number;
  width: number;
  height: number;
}

/** Key joints in physical units (frame heights, x scaled by the aspect ratio, y down). */
interface Joints {
  head: V2;
  shoulder: { left: V2; right: V2 };
  elbow: { left: V2; right: V2 };
  wrist: { left: V2; right: V2 };
  hip: { left: V2; right: V2 };
  knee: { left: V2; right: V2 };
  ankle: { left: V2; right: V2 };
  /** "front": facing the camera (the person's left is on the image's right); "side": left side to the camera, facing +x */
  view: "front" | "side";
}

/** Build all 33 pose landmarks (plus hands) from key joints. */
function landmarks(j: Joints, S: number, aspect: number, opts: { rightConf?: number; withHands?: boolean }): Pick<PoseFrame, "pose" | "hands"> {
  const pose: Record<string, Point> = {};
  const side = j.view === "side";
  const conf = (name: string) => (side && name.startsWith("right") ? (opts.rightConf ?? 0.6) : 0.95);
  const zOf = (name: string) => (side ? (name.startsWith("left") ? -0.1 : name.startsWith("right") ? 0.1 : 0) : 0);
  const put = (name: string, p: V2) => (pose[name] = [p[0] / aspect, p[1], zOf(name), conf(name)]);
  const lr = ["left", "right"] as const;
  // in the front view the person's left appears on the image's right
  const out = (s: "left" | "right") => (side ? 0 : s === "left" ? 1 : -1);
  const fwd = side ? 1 : 0;

  // face
  const nose: V2 = add(j.head, [0.05 * S * fwd, 0.01 * S]);
  put("nose", nose);
  for (const s of lr) {
    const o = out(s);
    const eye: V2 = add(nose, [side ? -0.015 * S : 0.03 * S * o, -0.02 * S]);
    put(`${s}_eye`, eye);
    put(`${s}_eye_inner`, add(eye, [side ? 0.005 * S : -0.012 * S * o, 0]));
    put(`${s}_eye_outer`, add(eye, [side ? -0.008 * S : 0.012 * S * o, 0]));
    put(`${s}_ear`, add(j.head, [side ? -0.04 * S : 0.07 * S * o, -0.005 * S]));
    put(`mouth_${s}`, add(nose, [side ? -0.01 * S : 0.025 * S * o, 0.03 * S]));
  }
  // limbs
  for (const s of lr) {
    put(`${s}_shoulder`, j.shoulder[s]);
    put(`${s}_elbow`, j.elbow[s]);
    put(`${s}_wrist`, j.wrist[s]);
    put(`${s}_hip`, j.hip[s]);
    put(`${s}_knee`, j.knee[s]);
    put(`${s}_ankle`, j.ankle[s]);
    // hand: index, pinky and thumb fan out along the forearm
    const d = sub(j.wrist[s], j.elbow[s]);
    const len = Math.hypot(...d) || 1;
    const u: V2 = [d[0] / len, d[1] / len];
    const perp: V2 = [-u[1], u[0]];
    put(`${s}_index`, add(j.wrist[s], add(scale(u, 0.08 * S), scale(perp, 0.012 * S))));
    put(`${s}_pinky`, add(j.wrist[s], add(scale(u, 0.07 * S), scale(perp, -0.012 * S))));
    put(`${s}_thumb`, add(j.wrist[s], add(scale(u, 0.05 * S), scale(perp, 0.025 * S))));
    // feet: heel behind the ankle, toes ahead (toward the camera in the front view), both on the ground
    const groundDrop = PROPORTIONS.ankleHeight * S;
    put(`${s}_heel`, add(j.ankle[s], side ? [-0.04 * S, groundDrop] : [0, groundDrop * 0.6]));
    put(`${s}_foot_index`, add(j.ankle[s], side ? [0.12 * S, groundDrop] : [0.02 * S * out(s), groundDrop]));
  }
  const frame: Pick<PoseFrame, "pose" | "hands"> = { pose };
  if (opts.withHands) {
    frame.hands = {};
    for (const s of lr) {
      const d = sub(j.wrist[s], j.elbow[s]);
      const base = Math.atan2(d[1], d[0]);
      const hand: Record<string, Point> = {};
      hand.wrist = [j.wrist[s][0] / aspect, j.wrist[s][1], 0, 0.9];
      // five fingers fanned over 60 degrees, four joints each, 2.2% of stature apart
      HAND_LANDMARKS.slice(1).forEach((name, k) => {
        const finger = Math.floor(k / 4);
        const joint = (k % 4) + 1;
        const a = base + rad(-30 + finger * 15);
        const r = (0.025 + joint * 0.018) * S;
        hand[name] = [(j.wrist[s][0] + Math.cos(a) * r) / aspect, j.wrist[s][1] + Math.sin(a) * r, 0, 0.9];
      });
      frame.hands[s] = hand;
    }
  }
  return frame;
}

function sub(a: V2, b: V2): V2 {
  return [a[0] - b[0], a[1] - b[1]];
}

function finishClip(poses: { t: number; frame: Pick<PoseFrame, "pose" | "hands"> }[], o: Required<Pick<ClipOptions, "fps" | "width" | "height">> & ClipOptions): SyntheticClip {
  const rand = seededRandom(o.seed ?? 1);
  const noise = o.noise ?? 0;
  const frames = poses.map(({ t, frame }) => {
    const f: PoseFrame = { t, ...frame };
    if (noise > 0) {
      const jitter = (p: Point): Point => [p[0] + (gaussian(rand) * noise) / (o.width / o.height), p[1] + gaussian(rand) * noise, p[2], p[3]];
      f.pose = Object.fromEntries(Object.entries(f.pose ?? {}).map(([k, p]) => [k, jitter(p)]));
      if (f.hands) {
        if (f.hands.left) f.hands.left = Object.fromEntries(Object.entries(f.hands.left).map(([k, p]) => [k, jitter(p)]));
        if (f.hands.right) f.hands.right = Object.fromEntries(Object.entries(f.hands.right).map(([k, p]) => [k, jitter(p)]));
      }
    }
    return f;
  });
  return { frames, fps: o.fps, width: o.width, height: o.height };
}

function defaults<T extends ClipOptions>(o: T, fps = 30): T & { fps: number; width: number; height: number; stature: number } {
  return { ...o, fps: o.fps ?? fps, width: o.width ?? 1280, height: o.height ?? 720, stature: o.stature ?? 0.7 };
}

// ---------------------------------------------------------------------------------------------

export interface SquatOptions extends ClipOptions {
  reps?: number;
  /** knee angle at the bottom of each repetition, degrees (one value, or one per repetition) */
  bottomKneeAngle?: number | number[];
  standingKneeAngle?: number;
  tempoDownS?: number;
  tempoUpS?: number;
  bottomHoldS?: number;
  restS?: number;
  leadS?: number;
  /** forward lean of the torso from vertical at the bottom, degrees */
  torsoLeanDeg?: number;
  /** visibility of the far (right) side, filmed side-on */
  rightConf?: number;
}

export interface SquatTruth {
  reps: number;
  bottomKneeAngles: number[];
  /** times of the deepest point of each repetition */
  bottomTimes: number[];
  /** start and end of each repetition's movement */
  repWindows: [number, number][];
  tempoDownS: number;
  torsoLeanDeg: number;
}

/**
 * A knee-and-hip bend filmed side-on (left side to the camera): standing, bending to a knee angle,
 * pausing, standing back up, resting, repeated. Ankles stay put; the hips move straight down (on a
 * cosine ease lasting `tempoDownS`) so the knee angle is exact. The torso leans forward in
 * proportion to the depth.
 */
export function squatSequence(opts: SquatOptions = {}): SyntheticClip & { truth: SquatTruth } {
  const o = defaults(opts);
  const reps = o.reps ?? 5;
  const bottoms = Array.from({ length: reps }, (_, k) => (Array.isArray(o.bottomKneeAngle) ? (o.bottomKneeAngle[k] ?? o.bottomKneeAngle[o.bottomKneeAngle.length - 1]) : (o.bottomKneeAngle ?? 90)));
  const stand = o.standingKneeAngle ?? 175;
  const down = o.tempoDownS ?? 1.5;
  const up = o.tempoUpS ?? 1.0;
  const hold = o.bottomHoldS ?? 0;
  const rest = o.restS ?? 1.0;
  const lead = o.leadS ?? 1.0;
  const lean = o.torsoLeanDeg ?? 30;
  const S = o.stature;
  const aspect = o.width / o.height;
  const groundY = 0.92;
  const ankle: V2 = [0.5 * aspect, groundY - PROPORTIONS.ankleHeight * S];
  const repLen = down + hold + up;
  const total = lead + reps * repLen + (reps - 1) * rest + lead;
  const truth: SquatTruth = { reps, bottomKneeAngles: bottoms, bottomTimes: [], repWindows: [], tempoDownS: down, torsoLeanDeg: lean };
  for (let k = 0; k < reps; k++) {
    const t0 = lead + k * (repLen + rest);
    truth.bottomTimes.push(t0 + down + hold / 2);
    truth.repWindows.push([t0, t0 + repLen]);
  }
  // the hips move on a cosine ease between standing height and the height that gives the bottom
  // knee angle; the knee angle follows from the leg geometry (hip height = leg length × cos φ)
  const legLen = (PROPORTIONS.shank + PROPORTIONS.thigh) * S;
  const hipHeight = (knee: number) => legLen * Math.cos(rad((180 - knee) / 2));
  /** knee angle and depth fraction at time t */
  const state = (t: number): { knee: number; depth: number } => {
    for (let k = 0; k < reps; k++) {
      const t0 = lead + k * (repLen + rest);
      if (t < t0 || t > t0 + repLen) continue;
      const u = t - t0;
      const depth = u < down ? ease(u / down) : u < down + hold ? 1 : 1 - ease((u - down - hold) / up);
      const h = hipHeight(stand) + (hipHeight(bottoms[k]) - hipHeight(stand)) * depth;
      return { knee: 180 - 2 * ((Math.acos(Math.min(1, h / legLen)) * 180) / Math.PI), depth };
    }
    return { knee: stand, depth: 0 };
  };
  const poses: { t: number; frame: Pick<PoseFrame, "pose" | "hands"> }[] = [];
  const nFrames = Math.round(total * o.fps);
  for (let i = 0; i < nFrames; i++) {
    const t = i / o.fps;
    const { knee, depth } = state(t);
    const phi = (180 - knee) / 2;
    const kneeP = add(ankle, scale([Math.sin(rad(phi)), -Math.cos(rad(phi))], PROPORTIONS.shank * S));
    const hip = add(kneeP, scale([-Math.sin(rad(phi)), -Math.cos(rad(phi))], PROPORTIONS.thigh * S));
    const lam = lean * depth;
    const torsoDir: V2 = [Math.sin(rad(lam)), -Math.cos(rad(lam))];
    const shoulder = add(hip, scale(torsoDir, PROPORTIONS.torso * S));
    const head = add(shoulder, scale(torsoDir, PROPORTIONS.neckToHead * S));
    const armAngle = 60 * depth;
    const elbow = add(shoulder, scale(fromDown(armAngle), PROPORTIONS.upperArm * S));
    const wrist = add(elbow, scale(fromDown(armAngle + 10), PROPORTIONS.forearm * S));
    const far: V2 = [0.004 * S, 0];
    const j: Joints = {
      view: "side",
      head,
      shoulder: { left: shoulder, right: add(shoulder, far) },
      elbow: { left: elbow, right: add(elbow, far) },
      wrist: { left: wrist, right: add(wrist, far) },
      hip: { left: hip, right: add(hip, far) },
      knee: { left: kneeP, right: add(kneeP, far) },
      ankle: { left: ankle, right: add(ankle, far) }
    };
    poses.push({ t, frame: landmarks(j, S, aspect, { rightConf: o.rightConf, withHands: o.withHands }) });
  }
  return { ...finishClip(poses, o), truth };
}

// ---------------------------------------------------------------------------------------------

export interface StepsOptions extends ClipOptions {
  bpm?: number;
  /** number of beats in the clip */
  beats?: number;
  /** which beats get a step (0-based); default every beat */
  stepOn?: number[];
  /** each step's landing relative to its beat, ms (negative = early); one value or one per step */
  offsetsMs?: number | number[];
  /** time of the first beat */
  leadS?: number;
  /** how long a foot is in the air per step */
  swingS?: number;
  /** how high a foot lifts, in frame heights */
  lift?: number;
  /** sideways travel per step, in frame heights */
  stepWidth?: number;
}

export interface StepsTruth {
  beats: number[];
  /** true landing time of every step */
  contacts: number[];
  feet: ("left" | "right")[];
  offsetsMs: number[];
}

/**
 * Stepping in place facing the camera, alternating feet, each step landing at its beat plus an
 * offset. Feet rise on a half-sine arc and land at the given time; hips sway over the standing foot.
 */
export function stepsOnBeats(opts: StepsOptions = {}): SyntheticClip & { beats: number[]; truth: StepsTruth } {
  const o = defaults(opts);
  const bpm = o.bpm ?? 120;
  const nBeats = o.beats ?? 16;
  const lead = o.leadS ?? 1.0;
  const swing = o.swingS ?? 0.25;
  const lift = o.lift ?? 0.05;
  const width = o.stepWidth ?? 0.04;
  const S = o.stature;
  const aspect = o.width / o.height;
  const groundY = 0.92;
  const interval = 60 / bpm;
  const beats = Array.from({ length: nBeats }, (_, k) => lead + k * interval);
  const stepOn = o.stepOn ?? beats.map((_, k) => k);
  const offsets = stepOn.map((_, k) => (Array.isArray(o.offsetsMs) ? (o.offsetsMs[k] ?? 0) : (o.offsetsMs ?? 0)));
  const contacts = stepOn.map((b, k) => beats[b] + offsets[k] / 1000);
  const feet = stepOn.map((_, k) => (k % 2 === 0 ? "left" : "right") as "left" | "right");
  const cx = 0.5 * aspect;
  const home = { left: cx + PROPORTIONS.hipHalf * S, right: cx - PROPORTIONS.hipHalf * S };
  const ankleY = groundY - PROPORTIONS.ankleHeight * S;
  // each foot alternates between its home position and a step outward
  const footAt = (side: "left" | "right", t: number): { pos: V2; up: number } => {
    const mine = contacts.map((c, k) => ({ c, k })).filter((s) => feet[s.k] === side);
    const dir = side === "left" ? 1 : -1;
    let x = home[side];
    for (let n = 0; n < mine.length; n++) {
      const target = home[side] + (n % 2 === 0 ? dir * width * S : 0);
      const { c } = mine[n];
      if (t >= c) {
        x = target;
        continue;
      }
      if (t > c - swing) {
        const u = (t - (c - swing)) / swing;
        return { pos: [x + (target - x) * smoothstep(u), ankleY - lift * Math.sin(Math.PI * u)], up: Math.sin(Math.PI * u) };
      }
      break;
    }
    return { pos: [x, ankleY], up: 0 };
  };
  const total = beats[nBeats - 1] + lead;
  const poses: { t: number; frame: Pick<PoseFrame, "pose" | "hands"> }[] = [];
  const nFrames = Math.round(total * o.fps);
  for (let i = 0; i < nFrames; i++) {
    const t = i / o.fps;
    const L = footAt("left", t);
    const R = footAt("right", t);
    // hips shift toward the standing foot
    const sway = (R.up - L.up) * 0.02 * S;
    const hipC: V2 = [cx + sway, ankleY - (PROPORTIONS.shank + PROPORTIONS.thigh) * S + 0.005 * S * (L.up + R.up)];
    const hip = { left: add(hipC, [PROPORTIONS.hipHalf * S, 0]), right: add(hipC, [-PROPORTIONS.hipHalf * S, 0]) };
    const knee = {
      left: add(lerp(hip.left, L.pos, 0.5), [0.02 * S * L.up, -0.02 * S * L.up]),
      right: add(lerp(hip.right, R.pos, 0.5), [-0.02 * S * R.up, -0.02 * S * R.up])
    };
    const shC = add(hipC, [sway * 0.3, -PROPORTIONS.torso * S]);
    const shoulder = { left: add(shC, [PROPORTIONS.shoulderHalf * S, 0]), right: add(shC, [-PROPORTIONS.shoulderHalf * S, 0]) };
    const elbow = { left: add(shoulder.left, scale(fromDown(15), PROPORTIONS.upperArm * S)), right: add(shoulder.right, scale(fromDown(-15), PROPORTIONS.upperArm * S)) };
    const wrist = { left: add(elbow.left, scale(fromDown(-20), PROPORTIONS.forearm * S)), right: add(elbow.right, scale(fromDown(20), PROPORTIONS.forearm * S)) };
    const j: Joints = { view: "front", head: add(shC, [0, -PROPORTIONS.neckToHead * S]), shoulder, elbow, wrist, hip, knee, ankle: { left: L.pos, right: R.pos } };
    poses.push({ t, frame: landmarks(j, S, aspect, { withHands: o.withHands }) });
  }
  const order = contacts.map((c, k) => ({ c, k })).sort((a, b) => a.c - b.c);
  return { ...finishClip(poses, o), beats, truth: { beats, contacts: order.map((x) => x.c), feet: order.map((x) => feet[x.k]), offsetsMs: order.map((x) => offsets[x.k]) } };
}

// ---------------------------------------------------------------------------------------------

export interface HoldOptions extends ClipOptions {
  leadS?: number;
  raiseS?: number;
  holdS?: number;
  lowerS?: number;
  tailS?: number;
  /** arm angle from the body (abduction) during the hold, degrees */
  armAngleDeg?: number;
  /** extra slow sway during the hold, frame heights */
  jitter?: number;
}

export interface HoldTruth {
  holdStart: number;
  holdEnd: number;
  holdS: number;
  /** the measured angle(left_elbow, left_shoulder, left_hip) during the hold */
  shoulderAngleDeg: number;
}

/** Standing facing the camera, raising both arms sideways, holding them still, lowering them. */
export function holdSequence(opts: HoldOptions = {}): SyntheticClip & { truth: HoldTruth } {
  const o = defaults(opts);
  const lead = o.leadS ?? 1;
  const raise = o.raiseS ?? 1;
  const hold = o.holdS ?? 3;
  const lower = o.lowerS ?? 1;
  const tail = o.tailS ?? 1;
  const target = o.armAngleDeg ?? 90;
  const S = o.stature;
  const aspect = o.width / o.height;
  const cx = 0.5 * aspect;
  const ankleY = 0.92 - PROPORTIONS.ankleHeight * S;
  const total = lead + raise + hold + lower + tail;
  const rand = seededRandom((o.seed ?? 1) + 7);
  const armAt = (t: number) => {
    if (t < lead) return 10;
    if (t < lead + raise) return 10 + (target - 10) * ease((t - lead) / raise);
    if (t < lead + raise + hold) return target;
    if (t < lead + raise + hold + lower) return target - (target - 10) * ease((t - lead - raise - hold) / lower);
    return 10;
  };
  const poses: { t: number; frame: Pick<PoseFrame, "pose" | "hands"> }[] = [];
  let measured = NaN;
  const nFrames = Math.round(total * o.fps);
  for (let i = 0; i < nFrames; i++) {
    const t = i / o.fps;
    const a = armAt(t);
    const drift = (o.jitter ?? 0) * gaussian(rand);
    const hipC: V2 = [cx, ankleY - (PROPORTIONS.shank + PROPORTIONS.thigh) * S];
    const shC = add(hipC, [0, -PROPORTIONS.torso * S]);
    const hip = { left: add(hipC, [PROPORTIONS.hipHalf * S, 0]), right: add(hipC, [-PROPORTIONS.hipHalf * S, 0]) };
    const shoulder = { left: add(shC, [PROPORTIONS.shoulderHalf * S, 0]), right: add(shC, [-PROPORTIONS.shoulderHalf * S, 0]) };
    const elbow = { left: add(shoulder.left, scale(fromDown(a), PROPORTIONS.upperArm * S)), right: add(shoulder.right, scale(fromDown(-a), PROPORTIONS.upperArm * S)) };
    elbow.left[1] += drift;
    elbow.right[1] += drift;
    const wrist = { left: add(elbow.left, scale(fromDown(a), PROPORTIONS.forearm * S)), right: add(elbow.right, scale(fromDown(-a), PROPORTIONS.forearm * S)) };
    const knee = { left: lerp(hip.left, [hip.left[0], ankleY], 0.5), right: lerp(hip.right, [hip.right[0], ankleY], 0.5) };
    const ankle = { left: [hip.left[0], ankleY] as V2, right: [hip.right[0], ankleY] as V2 };
    const j: Joints = { view: "front", head: add(shC, [0, -PROPORTIONS.neckToHead * S]), shoulder, elbow, wrist, hip, knee, ankle };
    if (t >= lead + raise && t < lead + raise + hold && !Number.isFinite(measured)) {
      const u = sub(elbow.left, shoulder.left);
      const w = sub(hip.left, shoulder.left);
      measured = (Math.acos((u[0] * w[0] + u[1] * w[1]) / (Math.hypot(...u) * Math.hypot(...w))) * 180) / Math.PI;
    }
    poses.push({ t, frame: landmarks(j, S, aspect, { withHands: o.withHands }) });
  }
  return { ...finishClip(poses, o), truth: { holdStart: lead + raise, holdEnd: lead + raise + hold, holdS: hold, shoulderAngleDeg: measured } };
}

// ---------------------------------------------------------------------------------------------

export interface SwingOptions extends ClipOptions {
  addressS?: number;
  backswingS?: number;
  downswingS?: number;
  followS?: number;
  tailS?: number;
  /** how far back the hands rotate around the shoulders, degrees from hanging straight down */
  topDeg?: number;
  /** how far through they go after the low point, degrees */
  finishDeg?: number;
}

export interface SwingTruth {
  topTime: number;
  /** the low point on the way through (fastest moment) */
  impactTime: number;
  backswingS: number;
  downswingS: number;
}

/**
 * A pendulum-like swing filmed from the front: the hands, joined, rotate around the shoulders from
 * hanging, slowly back to the top, then accelerate down through the low point and on to a finish.
 */
export function swingSequence(opts: SwingOptions = {}): SyntheticClip & { truth: SwingTruth } {
  const o = defaults(opts, 60);
  const address = o.addressS ?? 1;
  const back = o.backswingS ?? 0.9;
  const downS = o.downswingS ?? 0.3;
  const follow = o.followS ?? 0.4;
  const tail = o.tailS ?? 1;
  const top = o.topDeg ?? 150;
  const finishDeg = o.finishDeg ?? 120;
  const S = o.stature;
  const aspect = o.width / o.height;
  const cx = 0.5 * aspect;
  const ankleY = 0.92 - PROPORTIONS.ankleHeight * S;
  const total = address + back + downS + follow + tail;
  const angleAt = (t: number) => {
    if (t < address) return 0;
    if (t < address + back) return top * ease((t - address) / back);
    if (t < address + back + downS) {
      const u = (t - address - back) / downS;
      return top * (1 - u * u);
    }
    if (t < address + back + downS + follow) {
      // leave the low point at the downswing's final speed, slowing to a stop at the finish
      const u = (t - address - back - downS) / follow;
      return -finishDeg * Math.sin((Math.PI / 2) * u);
    }
    return -finishDeg;
  };
  const poses: { t: number; frame: Pick<PoseFrame, "pose" | "hands"> }[] = [];
  const nFrames = Math.round(total * o.fps);
  const R = (PROPORTIONS.upperArm + PROPORTIONS.forearm) * S * 0.95;
  for (let i = 0; i < nFrames; i++) {
    const t = i / o.fps;
    const b = angleAt(t);
    const hipC: V2 = [cx, ankleY - (PROPORTIONS.shank + PROPORTIONS.thigh) * S];
    const shC = add(hipC, [0, -PROPORTIONS.torso * S]);
    const hands = add(shC, scale(fromDown(b), R));
    const shoulder = { left: add(shC, [PROPORTIONS.shoulderHalf * S, 0]), right: add(shC, [-PROPORTIONS.shoulderHalf * S, 0]) };
    const elbow = { left: lerp(shoulder.left, hands, 0.55), right: lerp(shoulder.right, hands, 0.55) };
    const wrist = { left: add(hands, [0.01 * S, 0]), right: add(hands, [-0.01 * S, 0]) };
    const hip = { left: add(hipC, [PROPORTIONS.hipHalf * S, 0]), right: add(hipC, [-PROPORTIONS.hipHalf * S, 0]) };
    const ankle = { left: [hip.left[0] + 0.03 * S, ankleY] as V2, right: [hip.right[0] - 0.03 * S, ankleY] as V2 };
    const knee = { left: lerp(hip.left, ankle.left, 0.5), right: lerp(hip.right, ankle.right, 0.5) };
    const j: Joints = { view: "front", head: add(shC, [0, -PROPORTIONS.neckToHead * S]), shoulder, elbow, wrist, hip, knee, ankle };
    poses.push({ t, frame: landmarks(j, S, aspect, { withHands: o.withHands }) });
  }
  return { ...finishClip(poses, o), truth: { topTime: address + back, impactTime: address + back + downS, backswingS: back, downswingS: downS } };
}

// ---------------------------------------------------------------------------------------------

/** Copy frames with some points' visibility set (e.g. 0 to hide them). */
export function hidePosePoints(frames: PoseFrame[], names: string[], visibility = 0): PoseFrame[] {
  return frames.map((f) => ({
    ...f,
    pose: Object.fromEntries(Object.entries(f.pose ?? {}).map(([k, p]) => [k, names.includes(k) ? ([p[0], p[1], p[2], visibility] as Point) : p]))
  }));
}

/** Copy frames with Gaussian noise (frame heights) added to every pose landmark. */
export function addPoseNoise(frames: PoseFrame[], sigma: number, seed = 1, aspect = 1): PoseFrame[] {
  const rand = seededRandom(seed);
  return frames.map((f) => ({
    ...f,
    pose: Object.fromEntries(Object.entries(f.pose ?? {}).map(([k, p]) => [k, [p[0] + (gaussian(rand) * sigma) / aspect, p[1] + gaussian(rand) * sigma, p[2], p[3]] as Point]))
  }));
}

/** Copy frames with the movement delayed by `seconds` (timestamps unchanged; the first pose repeats). */
export function delayPoseFrames(frames: PoseFrame[], seconds: number, fps: number): PoseFrame[] {
  const k = Math.round(seconds * fps);
  return frames.map((f, i) => ({ ...frames[Math.max(0, Math.min(frames.length - 1, i - k))], t: f.t }));
}

/** The generators as one object. */
export const syntheticPose = { squatSequence, stepsOnBeats, holdSequence, swingSequence, hidePosePoints, addPoseNoise, delayPoseFrames, seededRandom };
