/**
 * Movement engine regression tests: synthetic pose clips with known angles, repetitions, timings and
 * beat offsets. Tests are per engine, not per skill; the two specs from the design doc
 * (docs/design/any-skill.md §3.1) run end to end as examples of what an agent writes.
 */
import { describe, expect, it } from "vitest";
import { CONFIDENCE_FLOOR, type MetricSpecInput } from "@las/schema";
import { SALSA_SPEC, SQUAT_SPEC } from "./fixtures/movement/specs.js";
import {
  addPoseNoise,
  alignToBeats,
  analyzeMovement,
  compareToReference,
  delayPoseFrames,
  framingCheck,
  hidePosePoints,
  holdSequence,
  oneEuro,
  OneEuroFilter,
  smoothFrames,
  squatSequence,
  stepsOnBeats,
  swingSequence
} from "../src/movement/index.js";

const W = 1280;
const H = 720;

function squat(opts: Parameters<typeof squatSequence>[0] = {}) {
  const clip = squatSequence(opts);
  return { clip, evidence: { frames: clip.frames, fps: clip.fps, width: clip.width, height: clip.height } };
}

describe("One Euro filter", () => {
  it("removes jitter from a still point", () => {
    const t = Array.from({ length: 300 }, (_, i) => i / 30);
    let s = 7;
    const noisy = t.map(() => {
      s = (s * 16807) % 2147483647;
      return 0.5 + ((s / 2147483647) - 0.5) * 0.01;
    });
    const out = oneEuro(noisy, t);
    const sd = (a: ArrayLike<number>) => {
      const m = Array.from(a).reduce((x, y) => x + y, 0) / a.length;
      return Math.sqrt(Array.from(a).reduce((x, y) => x + (y - m) ** 2, 0) / a.length);
    };
    expect(sd(out)).toBeLessThan(sd(noisy) * 0.5);
  });
  it("adds no lag on a moving point when run both ways, and some lag when causal", () => {
    const t = Array.from({ length: 120 }, (_, i) => i / 30);
    const ramp = t.map((x) => 0.2 + 0.1 * x);
    const both = oneEuro(ramp, t);
    const causal = oneEuro(ramp, t, { zeroLag: false });
    expect(Math.abs(both[60] - ramp[60])).toBeLessThan(1e-3);
    expect(ramp[60] - causal[60]).toBeGreaterThan(0);
    const f = new OneEuroFilter();
    expect(f.filter(1, 0)).toBe(1);
    expect(f.filter(NaN, 0.1)).toBeNaN();
  });
  it("smooths every landmark and keeps visibility", () => {
    const { clip } = squat({ reps: 1, noise: 0.004 });
    const sm = smoothFrames(clip.frames, 30);
    expect(sm).toHaveLength(clip.frames.length);
    expect(sm[10].pose!.left_knee[3]).toBe(clip.frames[10].pose!.left_knee[3]);
    expect(clip.frames[10].pose!.left_knee).not.toEqual(sm[10].pose!.left_knee);
  });
});

describe("repetitions, per rep, at phase and phase durations (squat spec)", () => {
  const bottoms = [85, 92, 100, 110, 88];
  const { clip, evidence } = squat({ reps: 5, bottomKneeAngle: bottoms, tempoDownS: 1.5, torsoLeanDeg: 30 });
  const a = analyzeMovement(SQUAT_SPEC, evidence, { specId: "squat-spec", modelVersion: 3 });

  it("passes the quality check and stamps the version", () => {
    expect(a.quality.ok).toBe(true);
    expect(a.engine).toBe("movement");
    expect(a.precision).toBe("full");
    expect(a.version).toBe("movement@0.1.0/squat-spec@v3");
  });
  it("counts repetitions exactly and finds their windows", () => {
    expect(a.segments).toHaveLength(5);
    a.segments!.forEach(([s, e], k) => {
      expect(Math.abs(s - clip.truth.repWindows[k][0])).toBeLessThan(0.15);
      expect(Math.abs(e - clip.truth.repWindows[k][1])).toBeLessThan(0.15);
    });
  });
  it("measures the minimum knee angle of each repetition within 3°", () => {
    const per = a.metrics.knee_bottom.per!;
    expect(per).toHaveLength(5);
    per.forEach((v, k) => expect(Math.abs(v - bottoms[k])).toBeLessThan(3));
    expect(a.metrics.knee_bottom.unit).toBe("deg");
    expect(a.metrics.knee_bottom.confidence).toBeGreaterThanOrEqual(CONFIDENCE_FLOOR);
  });
  it("derives a per-rep yes/no metric from a per-rep metric", () => {
    expect(a.metrics.depth_ok.per).toEqual([1, 1, 0, 0, 1]);
    expect(a.metrics.depth_ok.value).toBeCloseTo(0.6);
  });
  it("measures at the bottom phase", () => {
    expect(Math.abs(a.metrics.torso_lean.value - 30)).toBeLessThan(3);
  });
  it("times the down phase within 10%", () => {
    expect(Math.abs(a.metrics.tempo_down_s.value - 1.5) / 1.5).toBeLessThan(0.1);
    expect(a.metrics.tempo_down_s.unit).toBe("s");
  });
  it("finds the shallow-depth mistake at the shallow repetitions", () => {
    const m = a.mistakes.find((x) => x.id === "shallow")!;
    expect(m).toBeDefined();
    expect(m.share).toBeCloseTo(0.4);
    expect(m.at).toHaveLength(2);
    expect(Math.abs(m.at[0] - clip.truth.bottomTimes[2])).toBeLessThan(0.15);
    expect(Math.abs(m.at[1] - clip.truth.bottomTimes[3])).toBeLessThan(0.15);
    expect(m.evidence).toEqual({ kind: "time", t: m.at[0] });
    expect(m.confidence).toBeGreaterThanOrEqual(CONFIDENCE_FLOOR);
    expect(a.markers.filter((x) => x.role === "attention").map((x) => x.label)).toEqual(["shallow", "shallow"]);
    expect(a.keyFrames[0].label).toBe("shallow");
  });
  it("draws the angle arc for the mistake in normalized coordinates", () => {
    const o = a.overlay as { marks: { draw: string; points: string[]; coords: [number, number][]; value: number; t: number }[]; frames: unknown[]; edges: unknown[] };
    const mark = o.marks.find((m) => m.draw === "arc")!;
    expect(mark.points).toEqual(["left_hip", "left_knee", "left_ankle"]);
    expect(mark.coords).toHaveLength(3);
    for (const c of mark.coords.flat()) {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
    }
    expect(Math.abs(mark.value - 100)).toBeLessThan(3);
    expect(o.frames.length).toBeGreaterThanOrEqual(5);
    expect(o.edges.length).toBeGreaterThan(10);
  });
  it("has no mistake when every repetition is deep, and praises depth", () => {
    const deep = analyzeMovement(SQUAT_SPEC, squat({ reps: 4, bottomKneeAngle: 85 }).evidence);
    expect(deep.mistakes).toEqual([]);
    expect(deep.metrics.depth_ok.value).toBe(1);
    expect(deep.praise?.metric).toBe("depth_ok");
    expect(deep.praise!.label.length).toBeLessThanOrEqual(60);
  });
  it("counts repetitions exactly for other counts and with noisy landmarks", () => {
    for (const reps of [1, 3, 8]) {
      const r = analyzeMovement({ ...SQUAT_SPEC, metrics: { n: "reps()" } }, squat({ reps, bottomKneeAngle: 95, noise: 0.003, seed: reps }).evidence);
      expect(r.metrics.n.value).toBe(reps);
    }
    const noisy = analyzeMovement(SQUAT_SPEC, squat({ reps: 5, bottomKneeAngle: 90, noise: 0.003, seed: 11 }).evidence);
    noisy.metrics.knee_bottom.per!.forEach((v) => expect(Math.abs(v - 90)).toBeLessThan(3));
    expect(Math.abs(noisy.metrics.tempo_down_s.value - 1.5) / 1.5).toBeLessThan(0.1);
  });
  it("uses phases declared in the spec, evaluated inside each repetition", () => {
    const r = analyzeMovement(
      { ...SQUAT_SPEC, phases: { lowest: "left_hip.y == max(left_hip.y)" }, metrics: { lean: "angle(left_shoulder, left_hip, vertical) at lowest", lean_each: "angle(left_shoulder, left_hip, vertical) per rep at lowest", down_each: "phase_duration(down) per rep", down_share: "share(phase.down)" } },
      squat({ reps: 3, bottomKneeAngle: 90, torsoLeanDeg: 20 }).evidence
    );
    expect(Math.abs(r.metrics.lean.value - 20)).toBeLessThan(3);
    expect(r.metrics.lean_each.per).toHaveLength(3);
    r.metrics.lean_each.per!.forEach((v) => expect(Math.abs(v - 20)).toBeLessThan(3));
    r.metrics.down_each.per!.forEach((v) => expect(Math.abs(v - 1.5) / 1.5).toBeLessThan(0.1));
    expect(r.metrics.down_share.value).toBeGreaterThan(0.2);
  });
  it("evaluates proof criteria passed in the context", () => {
    const r = analyzeMovement(SQUAT_SPEC, evidence, { criteria: { most_deep: "share(depth_ok) >= 0.6", all_deep: "depth_ok", enough: "reps() >= 5", bad: "nonsense(" } });
    expect(r.criteria).toEqual({ most_deep: true, all_deep: false, enough: true, bad: false });
  });
});

describe("holds, moves and the rest of the function library", () => {
  it("measures how long a position is held and the angle while holding", () => {
    const clip = holdSequence({ holdS: 3, armAngleDeg: 90, jitter: 0.001, withHands: true });
    const r = analyzeMovement(
      {
        capture: { angle: "front", fps: 30 },
        segment: { by: "holds" },
        metrics: {
          held_s: "hold_time(angle(left_elbow, left_shoulder, left_hip) >= max(angle(left_elbow, left_shoulder, left_hip)) - 2)",
          arm: "max(angle(left_elbow, left_shoulder, left_hip)) per hold",
          level: "symmetry(angle(left_elbow, left_shoulder, left_hip), angle(right_elbow, right_shoulder, right_hip))",
          finger: "max(distance(left_hand.index_tip, left_wrist))",
          seen: "share(visible(left_wrist))",
          up_s: "duration(height(left_wrist) > height(left_shoulder) - 0.05)"
        }
      },
      { frames: clip.frames, fps: clip.fps, width: clip.width, height: clip.height }
    );
    expect(r.quality.ok).toBe(true);
    expect(Math.abs(r.metrics.held_s.value - 3) / 3).toBeLessThan(0.1);
    expect(r.metrics.held_s.unit).toBe("s");
    const longest = r.segments!.reduce((b, s) => (s[1] - s[0] > b[1] - b[0] ? s : b));
    expect(Math.abs(longest[1] - longest[0] - 3) / 3).toBeLessThan(0.1);
    expect(Math.max(...r.metrics.arm.per!)).toBeGreaterThan(clip.truth.shoulderAngleDeg - 3);
    expect(r.metrics.level.value).toBeGreaterThan(0.95);
    expect(r.metrics.finger.value).toBeGreaterThan(0);
    expect(r.metrics.seen.value).toBe(1);
    expect(r.metrics.up_s.value).toBeGreaterThan(2.5);
  });
  it("tracks objects by class name, next to body points", () => {
    const clip = holdSequence({ holdS: 1 });
    const frames = clip.frames.map((f) => ({ ...f, objects: { "sports ball": { center: [...f.pose!.left_wrist] as [number, number, number, number], w: 0.05, h: 0.05 } } }));
    const r = analyzeMovement({ metrics: { gap: "max(distance(left_wrist, object.sports_ball))", lift: "range(height(object.sports_ball))" } }, { frames, fps: 30, width: W, height: H });
    expect(r.metrics.gap.value).toBeLessThan(0.005);
    expect(r.metrics.lift.value).toBeGreaterThan(0.1);
  });
  it("aligns long clips on a reduced grid without running out of memory", () => {
    const long = stepsOnBeats({ beats: 140 }).frames;
    expect(long.length).toBeGreaterThan(2100);
    const c = compareToReference(long, long, ["legs"]);
    expect(c.similarity).toBeGreaterThan(0.99);
    for (let k = 1; k < c.path.length; k++) expect(c.path[k][0]).toBeGreaterThanOrEqual(c.path[k - 1][0]);
  });
  it("splits a swing into moves at the velocity minimum at the top", () => {
    const clip = swingSequence({ backswingS: 0.9, downswingS: 0.3 });
    const r = analyzeMovement(
      { capture: { angle: "front", fps: 60 }, segment: { by: "moves" }, metrics: { fastest: "max(speed(left_wrist)) per move", smooth: "mean(jerk(left_wrist))", path: "max(distance(left_wrist, mid_shoulder, unit: \"torso\"))" } },
      { frames: clip.frames, fps: clip.fps, width: clip.width, height: clip.height }
    );
    expect(r.segments).toHaveLength(2);
    expect(Math.abs(r.segments![0][1] - clip.truth.topTime)).toBeLessThan(0.05);
    const [back, down] = r.metrics.fastest.per!;
    expect(down).toBeGreaterThan(back * 2);
    expect(r.metrics.smooth.value).toBeGreaterThan(0);
    expect(r.metrics.path.value).toBeGreaterThan(0.9);
  });
  it("supports derived points, directions and geometry helpers", () => {
    const { evidence } = squat({ reps: 2, bottomKneeAngle: 90 });
    const r = analyzeMovement(
      {
        segment: { by: "reps" },
        metrics: {
          upright_standing: "min(angle(left_shoulder, left_hip, vertical))",
          hip_drop: "max(left_hip.y) - min(left_hip.y)",
          com_over_feet: "share(between(x(center_of_mass), x(left_heel) - 0.05, x(left_foot_index) + 0.05))",
          head_high: "mean(height(head)) > mean(height(mid_hip))",
          mid: "mean(y(midpoint(left_hip, left_knee)))",
          proj: "mean(distance(left_knee, projection(left_knee, left_hip, left_ankle)))",
          vy: "max(velocity(left_hip).y)",
          sm: "mean(smooth(angle(left_hip, left_knee, left_ankle), 9))",
          tilt: "max(angle(left_hip, left_knee, horizontal))",
          ground_gap: "min(ground.y - left_ankle.y)",
          fps_known: "fps",
          clip_s: "duration()"
        }
      },
      evidence
    );
    expect(r.metrics.upright_standing.value).toBeLessThan(2);
    expect(r.metrics.hip_drop.value).toBeGreaterThan(0.05);
    expect(r.metrics.com_over_feet.value).toBeGreaterThan(0.9);
    expect(r.metrics.head_high.value).toBe(1);
    expect(r.metrics.mid.value).toBeGreaterThan(0.5);
    expect(r.metrics.proj.value).toBeGreaterThan(0);
    expect(r.metrics.vy.value).toBeGreaterThan(0);
    expect(r.metrics.sm.value).toBeGreaterThan(90);
    expect(r.metrics.tilt.value).toBeLessThanOrEqual(90);
    expect(r.metrics.ground_gap.value).toBeGreaterThan(0);
    expect(r.metrics.fps_known.value).toBe(30);
    expect(Math.abs(r.metrics.clip_s.value - evidence.frames.length / 30)).toBeLessThan(0.05);
  });
  it("converts distances to centimetres through the learner's height", () => {
    const { evidence } = squat({ reps: 1, bottomKneeAngle: 90 });
    const spec: MetricSpecInput = { metrics: { shank_cm: "median(distance(left_knee, left_ankle, unit: \"cm\"))" } };
    const r = analyzeMovement(spec, { ...evidence, baseline: { height_cm: 180 } });
    // shank length is 24.6% of stature in the generator: 44 cm for a 180 cm learner
    expect(Math.abs(r.metrics.shank_cm.value - 44.3)).toBeLessThan(3);
    expect(r.metrics.shank_cm.unit).toBe("cm");
    const missing = analyzeMovement({ metrics: { shank_cm: "median(distance(left_knee, left_ankle, unit: \"cm\"))", n: "fps" } }, evidence);
    expect(missing.metrics.shank_cm).toBeUndefined();
    expect(missing.quality.issues.join()).toMatch(/height_cm/);
  });
  it("uses baseline and learner values in thresholds", () => {
    const { evidence } = squat({ reps: 3, bottomKneeAngle: 100 });
    const spec: MetricSpecInput = {
      segment: { by: "reps" },
      metrics: { knee: "min(angle(left_hip, left_knee, left_ankle)) per rep", deeper: "knee <= baseline.knee_bottom - learner.margin" },
      mistakes: [{ id: "not-deeper", when: "share(not deeper) > 0.5" }]
    };
    const r = analyzeMovement(spec, evidence, { baseline: { knee_bottom: 110 }, learner: { margin: 5 } });
    expect(r.metrics.deeper.value).toBe(1);
    expect(r.mistakes).toEqual([]);
  });
});

describe("timing against the beat (salsa spec with a synthetic reference)", () => {
  const reference = stepsOnBeats({ bpm: 120, beats: 16 });
  const run = (offsetsMs: number | number[], extra: Partial<Parameters<typeof stepsOnBeats>[0]> = {}) => {
    const clip = stepsOnBeats({ bpm: 120, beats: 16, offsetsMs, ...extra });
    const a = analyzeMovement(SALSA_SPEC, { frames: clip.frames, fps: clip.fps, width: W, height: H, beats: clip.beats, reference: reference.frames });
    return { clip, a };
  };

  it("is on the beat with no offset, close to the reference", () => {
    const { a } = run(0);
    expect(a.quality.ok).toBe(true);
    expect(a.metrics.timing.value).toBe(1);
    expect(a.metrics.shape.value).toBeGreaterThan(0.95);
    expect(a.metrics.step_offset_ms.per).toHaveLength(16);
    a.metrics.step_offset_ms.per!.forEach((o) => expect(Math.abs(o)).toBeLessThan(15));
    expect(a.segments).toHaveLength(2);
    expect(a.mistakes).toEqual([]);
  });
  it("measures each step's offset within 15 ms and the on-beat share", () => {
    const offsets = [-80, 40, 0, 120, -30, 60, -150, 10, 90, -60, 20, -110, 0, 75, -45, 130];
    const { a, clip } = run(offsets);
    const per = a.metrics.step_offset_ms.per!;
    expect(per).toHaveLength(16);
    per.forEach((o, k) => expect(Math.abs(o - clip.truth.offsetsMs[k])).toBeLessThan(15));
    const expected = offsets.filter((o) => Math.abs(o) <= 100).length / offsets.length;
    expect(a.metrics.timing.value).toBeCloseTo(expected, 5);
  });
  it("detects rushing when every step is early, with evidence on the beat timeline", () => {
    const { a } = run(-120);
    const m = a.mistakes.find((x) => x.id === "rushing")!;
    expect(m).toBeDefined();
    expect(m.at.length).toBeGreaterThan(10);
    expect(a.metrics.timing.value).toBe(0);
    expect(Math.abs(a.metrics.step_offset_ms.value + 120)).toBeLessThan(15);
    const o = a.overlay as { beats: number[]; events: { t: number; offsetMs: number }[]; marks: { draw: string }[] };
    expect(o.beats).toHaveLength(16);
    expect(o.events.length).toBe(16);
    expect(o.marks[0].draw).toBe("beat_timeline");
    // a time-shifted copy still matches the reference shape after alignment
    expect(a.metrics.shape.value).toBeGreaterThan(0.9);
  });
  it("works at 60 fps and with steps on some beats only", () => {
    const { a, clip } = run([30, -40, 0, 50, -20, 10], { fps: 60, stepOn: [0, 1, 2, 4, 5, 6] });
    expect(a.metrics.step_offset_ms.per).toHaveLength(6);
    a.metrics.step_offset_ms.per!.forEach((o, k) => expect(Math.abs(o - clip.truth.offsetsMs[k])).toBeLessThan(15));
  });
  it("computes metrics per phrase", () => {
    const clip = stepsOnBeats({ bpm: 120, beats: 16, offsetsMs: [...Array(8).fill(0), ...Array(8).fill(-60)] });
    const a = analyzeMovement({ ...SALSA_SPEC, metrics: { offset: "mean(step_offset_ms(left_ankle, right_ankle)) per phrase" }, mistakes: [] }, { frames: clip.frames, fps: 30, width: W, height: H, beats: clip.beats });
    const [p1, p2] = a.metrics.offset.per!;
    expect(Math.abs(p1)).toBeLessThan(15);
    expect(Math.abs(p2 + 60)).toBeLessThan(15);
  });
  it("asks for the music when there is no beat", () => {
    const clip = stepsOnBeats({});
    const a = analyzeMovement({ ...SALSA_SPEC, metrics: { timing: "on_beat(left_ankle, right_ankle)" } }, { frames: clip.frames, fps: 30, width: W, height: H });
    expect(a.quality.ok).toBe(false);
    expect(a.quality.reRecord).toMatch(/music|metronome/);
  });
});

describe("alignToBeats", () => {
  it("returns signed offsets to the nearest beat and the on-beat share", () => {
    const r = alignToBeats([0.98, 1.56, 2.0, 2.4, 9], [1, 1.5, 2, 2.5], 50);
    expect(r.offsetsMs.slice(0, 4).map((o) => Math.round(o!))).toEqual([-20, 60, 0, -100]);
    expect(r.offsetsMs[4]).toBeNull();
    expect(r.onBeatShare).toBeCloseTo(2 / 5);
    expect(alignToBeats([1], [], 50)).toEqual({ offsetsMs: [null], onBeatShare: 0 });
  });
});

describe("compareToReference (DTW)", () => {
  const clip = stepsOnBeats({ beats: 8 });
  it("gives similarity 1 for identical clips with a monotonic path", () => {
    const c = compareToReference(clip.frames, clip.frames, ["legs", "hips"]);
    expect(c.similarity).toBeGreaterThan(0.999);
    expect(c.path[0]).toEqual([0, 0]);
    expect(c.path[c.path.length - 1]).toEqual([clip.frames.length - 1, clip.frames.length - 1]);
    for (let k = 1; k < c.path.length; k++) {
      const [i0, j0] = c.path[k - 1];
      const [i1, j1] = c.path[k];
      expect(i1 - i0).toBeGreaterThanOrEqual(0);
      expect(j1 - j0).toBeGreaterThanOrEqual(0);
      expect(i1 - i0 + j1 - j0).toBeGreaterThan(0);
      expect(i1 - i0).toBeLessThanOrEqual(1);
      expect(j1 - j0).toBeLessThanOrEqual(1);
    }
    expect(Object.keys(c.perJoint).sort()).toEqual(["left_ankle", "left_hip", "left_knee", "right_ankle", "right_hip", "right_knee"]);
    expect(c.aligned).toHaveLength(clip.frames.length);
  });
  it("is lower for a noisy clip and recovers a time shift that plain clock alignment can't", () => {
    const noisy = compareToReference(addPoseNoise(clip.frames, 0.01, 3, W / H), clip.frames, ["legs", "hips"], { aspect: W / H });
    expect(noisy.similarity).toBeLessThan(0.97);
    const delayed = delayPoseFrames(clip.frames, 0.25, 30);
    const dtw = compareToReference(delayed, clip.frames, ["legs", "hips"], { aspect: W / H });
    const none = compareToReference(delayed, clip.frames, ["legs", "hips"], { aspect: W / H, align: "none" });
    expect(dtw.similarity).toBeGreaterThan(none.similarity);
    expect(none.similarity).toBeLessThan(0.97);
    // the path runs diagonal with a lag of about 0.25 s in the middle
    const mid = dtw.path[dtw.path.length >> 1];
    expect(Math.abs(mid[0] - mid[1] - 7.5)).toBeLessThan(3);
  });
  it("matches a short clip to the best stretch of a longer reference", () => {
    const part = clip.frames.slice(60, 120);
    const c = compareToReference(part, clip.frames, undefined, { subsequence: true });
    expect(c.similarity).toBeGreaterThan(0.99);
    expect(c.path[0][1]).toBeGreaterThan(30);
  });
});

describe("quality and framing", () => {
  it("framing check is ready when every needed point is visible", () => {
    const { clip } = squat({ reps: 1 });
    const f = clip.frames[0];
    const ok = framingCheck(f, ["left_hip", "left_knee", "left_ankle"]);
    expect(ok).toEqual({ pointsVisible: 3, ready: true, missing: [] });
    const hidden = hidePosePoints([f], ["left_ankle", "left_heel"])[0];
    const bad = framingCheck(hidden, ["legs", "left_heel", "vertical"]);
    expect(bad.ready).toBe(false);
    expect(bad.missing).toEqual(expect.arrayContaining(["left_ankle", "left_heel"]));
    // the far side is seen at 0.6 visibility in this side-on clip: below a stricter threshold
    expect(framingCheck(f, ["right_knee"], { minVisibility: 0.7 }).ready).toBe(false);
    expect(framingCheck(undefined, ["nose"])).toEqual({ pointsVisible: 0, ready: false, missing: ["nose"] });
    expect(framingCheck(f, []).ready).toBe(true);
  });
  it("asks to re-record with a specific instruction when the feet aren't visible", () => {
    const { clip } = squat({ reps: 3 });
    const frames = hidePosePoints(clip.frames, ["left_ankle", "left_heel", "left_foot_index", "right_ankle", "right_heel", "right_foot_index"]);
    const a = analyzeMovement({ ...SQUAT_SPEC, requires_visible: ["left_hip", "left_knee", "left_ankle"] }, { frames, fps: 30, width: W, height: H });
    expect(a.quality.ok).toBe(false);
    expect(a.quality.reRecord).toBe("I couldn't see your feet. Move the phone back a step so your whole body is in the frame.");
    expect(a.metrics).toEqual({});
    expect(a.mistakes).toEqual([]);
  });
  it("asks to re-record when most measured points are missing, even without requires_visible", () => {
    const { clip } = squat({ reps: 3 });
    const frames = hidePosePoints(clip.frames, ["left_hip", "left_knee", "left_ankle"], 0.2);
    const a = analyzeMovement(SQUAT_SPEC, { frames, fps: 30, width: W, height: H });
    expect(a.quality.ok).toBe(false);
    expect(a.quality.reRecord).toMatch(/left side/);
  });
  it("asks to re-record a clip that is too short, or with nobody in it", () => {
    const { clip } = squat({ reps: 1 });
    expect(analyzeMovement(SQUAT_SPEC, { frames: clip.frames.slice(0, 12), fps: 30, width: W, height: H }).quality.reRecord).toMatch(/too short/);
    const empty = clip.frames.map((f) => ({ t: f.t }));
    expect(analyzeMovement(SQUAT_SPEC, { frames: empty, fps: 30, width: W, height: H }).quality.reRecord).toMatch(/couldn't see you/);
  });
  it("lowers confidence when the camera angle is wrong, and asks to re-record when nothing can be trusted", () => {
    const { evidence } = squat({ reps: 3 });
    const wrong = analyzeMovement(SQUAT_SPEC, { ...evidence, detectedAngle: "front" });
    expect(wrong.quality.ok).toBe(false);
    expect(wrong.quality.reRecord).toMatch(/side-on/);
    const close = analyzeMovement(SQUAT_SPEC, { ...evidence, detectedAngle: "side-45" });
    expect(close.quality.ok).toBe(true);
    expect(close.quality.issues.join()).toMatch(/side-45/);
    expect(close.metrics.knee_bottom.confidence).toBeLessThan(analyzeMovement(SQUAT_SPEC, evidence).metrics.knee_bottom.confidence);
  });
  it("reports mistakes only at or above the confidence floor", () => {
    // filmed side-on: the far (right) side is tracked at 0.6 visibility, the near side at 0.95
    const { evidence } = squat({ reps: 3, bottomKneeAngle: 110, rightConf: 0.6 });
    const spec: MetricSpecInput = {
      segment: { by: "reps", signal: "left_hip.y" },
      metrics: {
        near_knee: "min(angle(left_hip, left_knee, left_ankle)) per rep",
        far_knee: "min(angle(right_hip, right_knee, right_ankle)) per rep"
      },
      mistakes: [
        { id: "near-shallow", when: "share(near_knee > 95) >= 0.5" },
        { id: "far-shallow", when: "share(far_knee > 95) >= 0.5", min_confidence: 0.5 }
      ]
    };
    const a = analyzeMovement(spec, evidence);
    expect(a.metrics.far_knee.confidence).toBeLessThan(CONFIDENCE_FLOOR);
    expect(a.mistakes.map((m) => m.id)).toEqual(["near-shallow"]);
    a.mistakes.forEach((m) => expect(m.confidence).toBeGreaterThanOrEqual(CONFIDENCE_FLOOR));
  });
  it("reports a spec it can't parse without crashing", () => {
    const { evidence } = squat({ reps: 1 });
    const a = analyzeMovement({ metrics: { ok: "fps", broken: "angle(left_hip," } }, evidence);
    expect(a.quality.ok).toBe(true);
    expect(a.metrics.ok.value).toBe(30);
    expect(a.quality.issues.join()).toMatch(/broken/);
    const unknown = analyzeMovement({ metrics: { x: "launch(1)", ok: "fps" } }, evidence);
    expect(unknown.quality.issues.join()).toMatch(/unknown function/);
  });
});
