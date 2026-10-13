import { describe, expect, it } from "vitest";
import { checkSpec, checkSimSpec, SimSpecSchema, trackersFor, MetricSpecSchema, checkLesson, LessonSpecSchema } from "../src/index.js";

describe("metric spec", () => {
  const squat = {
    kind: "metric",
    capture: { angle: "side", fps: 30 },
    segment: { by: "reps", signal: "left_hip.y" },
    phases: { bottom: "left_hip.y == max(left_hip.y)" },
    metrics: {
      knee_bottom: "min(angle(left_hip, left_knee, left_ankle)) per rep",
      depth_ok: "knee_bottom <= 95",
      torso_lean: "angle(left_shoulder, left_hip, vertical) at bottom",
      tempo_down_s: "phase_duration(down)"
    },
    mistakes: [{ id: "shallow", when: "share(not depth_ok) >= 0.3", show: "overlay(angle(left_hip, left_knee, left_ankle))", fix_drill: "box-squat-to-depth" }]
  };
  it("accepts the squat example from the design", () => {
    const r = checkSpec(squat);
    expect(r.issues).toEqual([]);
    expect(r.spec?.kind).toBe("metric");
    expect(trackersFor(MetricSpecSchema.parse(squat))).toEqual(["pose"]);
  });
  it("accepts the salsa example with a reference and beats", () => {
    const r = checkSpec({
      kind: "metric",
      capture: { angle: "front", fps: 30 },
      reference: "learner-media/teacher-basic.mp4",
      segment: { by: "phrases", beats: 8, beat_source: "audio_track" },
      metrics: {
        timing: "on_beat(left_ankle, right_ankle)",
        shape: "pose_similarity(reference, joints: [legs, hips], align: dtw)",
        step_offset_ms: "step_offset_ms(left_ankle, right_ankle)"
      },
      mistakes: [{ id: "rushing", when: "mean(step_offset_ms) < -80", show: "beat_timeline" }]
    });
    expect(r.issues).toEqual([]);
  });
  it("rejects unknown points, functions and bad syntax", () => {
    const r = checkSpec({ kind: "metric", metrics: { a: "angle(left_hip, left_knee, left_foot)", b: "launch(1)", c: "1 +" } });
    const msgs = r.issues.map((i) => i.message).join("\n");
    expect(msgs).toMatch(/unknown name "left_foot"/);
    expect(msgs).toMatch(/unknown function "launch"/);
    expect(msgs).toMatch(/unexpected token/);
  });
  it("derives trackers from points", () => {
    expect(trackersFor(MetricSpecSchema.parse({ metrics: { d: "distance(left_hand.index_tip, object.sports_ball)" } }))).toEqual(["hands", "objects"]);
  });
});

describe("other specs", () => {
  it("checks rubric levels and measures", () => {
    const r = checkSpec({ kind: "rubric", criteria: [{ id: "proportions", levels: { "1": "off", "2": "ok", "3": "within 10%" }, measure: "tapped_points(head_top, chin, feet)" }] });
    expect(r.issues).toEqual([]);
    const bad = checkSpec({ kind: "rubric", criteria: [{ id: "x", levels: { "1": "only one" }, measure: "magic(1)" }], safety_critical: true });
    expect(bad.issues.map((i) => i.message).join()).toMatch(/at least 2 levels.*unknown measure.*safety-critical/s);
  });
  it("checks test specs", () => {
    const r = checkSpec({ kind: "test", language: "rust", entry: "src/lib.rs", tests: [{ call: 'count_words("")', expect: "0", hidden: true }, { native: "tests/edge_cases.rs" }], runner: ["browser", "local", "container"], limits: { time_s: 10, memory_mb: 256, network: false } });
    expect(r.issues).toEqual([]);
    expect(checkSpec({ kind: "test", language: "rust", entry: "../etc/passwd", tests: [{ call: "x", expect: "1" }] }).issues[0].message).toMatch(/inside the workspace/);
  });
  it("checks audio specs", () => {
    expect(checkSpec({ kind: "audio", reference: { score: "minuet.musicxml", part: "right_hand", bars: "1-8" }, tempo: 72, tolerance: { pitch_cents: 30, onset_ms: 60 }, grade: ["pitch", "rhythm", "dynamics"] }).issues).toEqual([]);
    expect(checkSpec({ kind: "audio", grade: ["pitch"] }).issues[0].message).toMatch(/needs a reference/);
  });
  it("checks speech specs", () => {
    expect(checkSpec({ kind: "speech", language: "es", target: "Quisiera un café, por favor" }).issues).toEqual([]);
    expect(checkSpec({ kind: "speech", language: "zh-CN" }).issues[0].message).toMatch(/target text or an open prompt/);
  });
  it("checks sim specs: declarative, no code", () => {
    const sim = SimSpecSchema.parse({
      title: "Hips and arm load",
      params: { hip_cm: { label: "Hips from wall", min: 5, max: 60, default: 30, unit: "cm" } },
      formulas: { arm_load_pct: "clamp(hip_cm * 1.5, 0, 100)" },
      figure: { kind: "plot", x: "hip_cm", series: ["arm_load_pct"] },
      readout: [{ value: "arm_load_pct", label: "Arm load", unit: "%" }]
    });
    expect(checkSimSpec(sim)).toEqual([]);
    const bad = SimSpecSchema.parse({ title: "x", params: { a: { label: "a", min: 1, max: 0 } }, formulas: { b: "fetch(a)" }, figure: { kind: "gauge", value: "zzz", min: 0, max: 1 } });
    expect(checkSimSpec(bad).map((i) => i.message).join()).toMatch(/min must be below max.*unknown function "fetch".*not a parameter or formula/s);
  });
});

describe("lesson cards", () => {
  it("enforces the 25-word budget", () => {
    const ok = LessonSpecSchema.parse({ title: "Hips in", cards: [{ type: "predict", text: "Which hip position puts less weight on your arms?", options: ["Close to the wall", "Away from the wall"], answer: 0 }] });
    expect(checkLesson(ok)).toEqual([]);
    const over = LessonSpecSchema.parse({ title: "x", cards: [{ type: "diagram", text: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twenty-one twenty-two twenty-three twenty-four twenty-five twenty-six", figure: { kind: "mermaid", source: "graph LR; a-->b" } }] });
    expect(checkLesson(over)[0].message).toMatch(/26 words/);
  });
});
