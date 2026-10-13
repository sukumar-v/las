import { buildModel } from "./common.js";

/** Movement: reps filmed side-on, measured by a knee angle at the bottom of each rep. */
export const movementModel = buildModel({
  skill: "e2e movement skill",
  name: "Test movement",
  noun: "the test movement",
  physical: true,
  engine: "movement",
  perform: { id: "reps", type: "move", title: "Five deep reps", prompt: "Film five reps", spec: "rep-metrics", capture: { angle: "side", fps: 30, duration_s: 20, guide: "Side-on, phone at hip height" } },
  specs: {
    "rep-metrics": {
      kind: "metric",
      capture: { angle: "side", fps: 30 },
      segment: { by: "reps", signal: "left_hip.y" },
      metrics: { knee_bottom: "min(angle(left_hip, left_knee, left_ankle)) per rep", depth_ok: "knee_bottom <= 100", reps: "count(knee_bottom)" },
      mistakes: [{ id: "shallow", when: "share(not depth_ok) >= 0.3", show: "angle_arc(left_hip, left_knee, left_ankle)", fix_drill: "basics-fix" }]
    }
  },
  mistake: { id: "shallow", name: "Shallow reps", metric: "depth_ok", when: "share(not depth_ok) >= 0.3", headline: "Reps stop too high" },
  key_metric: { id: "depth", label: "Reps to depth", metric: "depth_ok", unit: "%", better: "higher", format: "percent" },
  proof: { label: "Five reps to depth", criteria: [{ id: "depth", label: "Deep enough", check: "share(depth_ok) >= 0.8" }] },
  extra: {
    warmups: [{ id: "wu", title: "Warm-up", steps: ["Two minutes of easy movement", "Five slow reps"], minutes: 3 }],
    safety: { warmup: "wu", injury_questions: ["Any pain?"], beginner_caps: { max_intensity: 3, max_minutes: 40, sessions_per_week: 4 }, stop_criteria: ["Sharp pain"], see_professional: ["Pain lasting more than a week"], supervised_only: [] },
    injuries: { Knees: "Reduce depth for two weeks" }
  }
});
