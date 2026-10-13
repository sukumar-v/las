import type { SkillModelInput } from "../../src/index.js";

/** A small, valid skill model used by tests. It is test data, not a pack. */
export function minimalModel(overrides: Partial<SkillModelInput> = {}): SkillModelInput {
  return {
    skill: "test skill",
    name: "Test skill",
    noun: "the test skill",
    physical: true,
    engines: ["movement", "knowledge", "self-report"],
    why: [
      { id: "fun", label: "For fun" },
      { id: "health", label: "Health" },
      { id: "prove", label: "Prove it to myself" }
    ],
    pictures: [
      { id: "enjoy", label: "Enjoying it weekly", why: ["fun", "health"], ladderStep: 1, milestone: "One clean session", proof: "A clip of one clean set", focus: { Technique: 60, Theory: 40 } },
      { id: "show", label: "Showing people", why: ["prove"], ladderStep: 2, milestone: "Ten clean reps", proof: "A clip of ten clean reps", focus: { Technique: 70, Theory: 30 } }
    ],
    probes: [
      { id: "level", type: "single", question: "How much have you done?", options: [{ value: 0, label: "Never" }, { value: 1, label: "A few times" }, { value: 2, label: "Every week" }] },
      { id: "theory", type: "quiz", question: "Three quick questions.", spec: "placement-quiz" }
    ],
    placement: [
      { when: "level >= 2 && quiz.correct >= 2", step: 2 },
      { when: "level >= 1", step: 1 }
    ],
    ladder: [
      { id: "start", label: "Brand new", hours: [0, 0] },
      { id: "first", label: "First clean rep", hours: [2, 4], nodes: ["setup"], proof: { engine: "movement", spec: "rep-metrics", label: "Five reps, knees to 95 degrees", criteria: [{ id: "depth", label: "Deep enough", check: "share(depth_ok) >= 0.8" }] } },
      { id: "ten", label: "Ten clean reps", hours: [6, 10], nodes: ["depth"], proof: { engine: "movement", spec: "rep-metrics", label: "Ten reps in a row", criteria: [{ id: "depth", label: "Deep enough", check: "share(depth_ok) >= 0.8" }, { id: "count", label: "Ten reps", check: "reps >= 10" }] } },
      { id: "load", label: "Add weight", hours: [10, 20], nodes: ["brace"], proof: { engine: "self-report", label: "Log three loaded sessions", criteria: [{ id: "n", label: "Three sessions", check: "count >= 3" }] } }
    ],
    nodes: [
      { id: "setup", name: "Setup", requires: [], lesson: "setup-lesson", drills: ["setup-quiz"], review: { prompt: "Where do your feet go?", kind: "choice", options: ["Shoulder width", "Together"], answer: 0 } },
      { id: "depth", name: "Depth", requires: ["setup"], lesson: "depth-lesson", drills: ["depth-reps"], mistakes: ["shallow"], review: { prompt: "What angle counts as deep?", kind: "choice", options: ["95", "150"], answer: 0 } },
      { id: "brace", name: "Bracing", requires: ["depth"], lesson: "depth-lesson", drills: ["depth-reps"], review: { prompt: "When do you brace?", kind: "choice", options: ["Before", "After"], answer: 0 } }
    ],
    lessons: [
      { id: "setup-lesson", title: "Setup", nodes: ["setup"], cards: [{ type: "predict", text: "Which stance is steadier?", options: ["Wide", "Narrow"], answer: 0 }] },
      { id: "depth-lesson", title: "Depth", nodes: ["depth"], cards: [{ type: "predict", text: "Deeper reps work which muscle more?", options: ["Glutes", "Calves"], answer: 0 }, { type: "diagram", text: "Knee angle at the bottom.", figure: { kind: "figure", points: { hip: [50, 40], knee: [60, 70], ankle: [50, 95] }, segments: [["hip", "knee"], ["knee", "ankle"]] } }] }
    ],
    drills: [
      { id: "setup-quiz", type: "choice", title: "Setup check", nodes: ["setup"], spec: "placement-quiz", minutes: 2 },
      { id: "depth-reps", type: "move", title: "Five deep reps", nodes: ["depth"], spec: "rep-metrics", capture: { angle: "side", fps: 30, duration_s: 30 }, success: "share(depth_ok) >= 0.7", difficulty: { param: "reps", levels: [5, 8, 12] }, minutes: 5, intensity: 3, fixes: ["shallow"] }
    ],
    specs: {
      "rep-metrics": {
        kind: "metric",
        capture: { angle: "side", fps: 30 },
        segment: { by: "reps", signal: "left_hip.y" },
        metrics: { knee_bottom: "min(angle(left_hip, left_knee, left_ankle)) per rep", depth_ok: "knee_bottom <= 95", reps: "count(knee_bottom)" },
        mistakes: [{ id: "shallow", when: "share(not depth_ok) >= 0.3", show: "overlay(angle(left_hip, left_knee, left_ankle))", fix_drill: "depth-reps" }]
      },
      "placement-quiz": {
        kind: "items",
        items: [
          { type: "choice", id: "q1", prompt: "How wide is a normal stance?", options: ["Shoulder width", "Feet together"], answer: 0 },
          { type: "choice", id: "q2", prompt: "Where should your weight sit?", options: ["Toes", "Mid-foot"], answer: 1 },
          { type: "choice", id: "q3", prompt: "Knees track over?", options: ["Toes", "Inward"], answer: 0, difficulty: 2 }
        ]
      }
    },
    mistakes: [
      { id: "shallow", name: "Shallow reps", nodes: ["depth"], engine: "movement", detector: { metric: "depth_ok", when: "share(not depth_ok) >= 0.3" }, severity: 2, explain: { lesson: "depth-lesson", card: 1 }, fix_drill: "depth-reps", headline: "Reps stop above parallel" }
    ],
    warmups: [{ id: "wu", title: "Warm-up", steps: ["Two minutes of easy movement", "Ten bodyweight reps"], minutes: 4 }],
    safety: { warmup: "wu", injury_questions: ["Any knee or back pain?"], beginner_caps: { max_intensity: 3, max_minutes: 40, sessions_per_week: 4 }, stop_criteria: ["Sharp pain"], see_professional: ["Pain lasting more than a week"], supervised_only: [] },
    access: ["A clear floor"],
    injuries: { Knees: "Reduce depth and skip loaded reps for two weeks" },
    focus: { Technique: 60, Theory: 40 },
    hard_focus: ["Technique"],
    key_metrics: [{ id: "depth", label: "Reps to depth", engine: "movement", metric: "depth_ok", unit: "%", better: "higher", format: "percent" }],
    ...overrides
  };
}
