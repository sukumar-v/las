/** Metric specs used by the movement tests: the two examples from docs/design/any-skill.md §3.1, as an agent would write them. */
import type { MetricSpecInput } from "@las/schema";

/** The squat example. */
export const SQUAT_SPEC: MetricSpecInput = {
  capture: { angle: "side", fps: 30 },
  segment: { by: "reps", signal: "left_hip.y" },
  metrics: {
    knee_bottom: "min(angle(left_hip, left_knee, left_ankle)) per rep",
    depth_ok: "knee_bottom <= 95",
    torso_lean: "angle(left_shoulder, left_hip, vertical) at bottom",
    tempo_down_s: "phase_duration(down)"
  },
  mistakes: [{ id: "shallow", when: "share(not depth_ok) >= 0.3", show: "overlay(angle(left_hip, left_knee, left_ankle))", fix_drill: "box-squat-to-depth" }]
};

/** The salsa basic-step example, with step_offset_ms declared as a metric (the schema requires every name to be defined). */
export const SALSA_SPEC: MetricSpecInput = {
  capture: { angle: "front", fps: 30 },
  reference: "learner-media/teacher-basic.mp4",
  segment: { by: "phrases", beats: 8, beat_source: "audio_track" },
  metrics: {
    timing: "on_beat(left_ankle, right_ankle)",
    shape: "pose_similarity(reference, joints: [legs, hips], align: dtw)",
    step_offset_ms: "step_offset_ms(left_ankle, right_ankle)"
  },
  mistakes: [{ id: "rushing", when: "mean(step_offset_ms) < -80", show: "beat_timeline" }]
};
