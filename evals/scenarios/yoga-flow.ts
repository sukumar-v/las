import { recordFallbacks, type Scenario } from "../src/harness.js";

/** A beginner vinyasa flow measured as holds. Floor poses hide limbs, so those captures are side-on at floor height. */
export const yogaFlow: Scenario = {
  id: "yoga-flow",
  skill: "yoga flow",
  notes: "Stiff hamstrings, desk job. Wants a 20-minute morning flow.",
  expect: { engines: ["movement"], main: "movement", fallback: "self-report", physical: true, supervisedOnly: [] },
  build: (draft) => ({
    skill: "yoga flow",
    name: "Yoga flow",
    noun: "yoga",
    source: "generated",
    physical: true,
    engines: ["movement", "knowledge", "self-report"],
    fallbacks: recordFallbacks(draft, { movement: "self-report" }),
    why: [
      { id: "mobility", label: "Move more freely" },
      { id: "calm", label: "Feel calmer" },
      { id: "habit", label: "A morning habit" },
      { id: "balance", label: "Better balance" }
    ],
    pictures: [
      { id: "morning", label: "A 20-minute morning flow", why: ["habit", "calm"], ladderStep: 4, milestone: "Flow the full sequence, holds steady", proof: "One continuous flow, every hold steady", focus: { Fundamentals: 40, Mobility: 35, Balance: 25 }, access: ["A yoga mat"] },
      { id: "fold", label: "Touching the floor in a fold", why: ["mobility"], ladderStep: 3, milestone: "Down dog with straight back for 30 s", proof: "A side-view clip of a 30-second down dog", focus: { Fundamentals: 30, Mobility: 55, Balance: 15 } },
      { id: "tree", label: "Steady on one leg", why: ["balance", "calm"], ladderStep: 2, milestone: "Tree pose, 30 seconds each side", proof: "A front clip of tree pose, both sides", focus: { Fundamentals: 35, Mobility: 15, Balance: 50 } }
    ],
    probes: [
      { id: "level", type: "scale", question: "How often have you done yoga?", options: [{ value: 0, label: "Never" }, { value: 1, label: "A few classes" }, { value: 2, label: "Weekly" }, { value: 3, label: "Years" }] },
      { id: "poses", type: "multi", question: "Which can you hold for 30 seconds?", optional: true, options: [{ value: "warrior", label: "Warrior II" }, { value: "tree", label: "Tree pose" }, { value: "dog", label: "Downward dog" }] }
    ],
    placement: [
      { when: "!fresh && level >= 2 && count(poses) >= 3", step: 3, evidence: "Holds the core poses" },
      { when: "level >= 1 && contains(poses, 'warrior')", step: 1, evidence: "Holds Warrior II" }
    ],
    ladder: [
      { id: "start", label: "Brand new", hours: [0, 0] },
      { id: "warrior", label: "A steady Warrior II", hours: [1, 3], nodes: ["breath", "warrior"],
        proof: { engine: "movement", spec: "standing-holds", label: "Warrior II, 30 seconds each side, front knee over ankle", criteria: [{ id: "hold", label: "30 seconds", check: "hold_s >= 30" }, { id: "knee", label: "Knee bent to about 90", check: "front_knee <= 110" }], capture: { angle: "front", fps: 30, duration_s: 90 }, fallback: "self-report" } },
      { id: "tree", label: "Balance in tree pose", hours: [2, 5], nodes: ["tree"],
        proof: { engine: "movement", spec: "standing-holds", label: "Tree pose, 30 seconds each side, little sway", criteria: [{ id: "hold", label: "30 seconds", check: "hold_s >= 30" }, { id: "steady", label: "Little sway", check: "sway <= 0.03" }], capture: { angle: "front", fps: 30, duration_s: 90 }, fallback: "self-report" } },
      { id: "dog", label: "Downward dog with a long back", hours: [4, 10], nodes: ["dog"],
        proof: { engine: "movement", spec: "floor-holds", label: "Down dog for 30 seconds, hips high, back long", criteria: [{ id: "hold", label: "30 seconds", check: "hold_s >= 30" }, { id: "hips", label: "Hip angle under 100", check: "hip_angle <= 100" }], capture: { angle: "side", fps: 30, duration_s: 60 }, fallback: "self-report" } },
      { id: "flow", label: "The full morning flow", hours: [8, 20], nodes: ["flow"],
        proof: { engine: "movement", spec: "flow-sequence", label: "The whole flow in one take, five steady holds", criteria: [{ id: "holds", label: "Five holds", check: "holds >= 5" }, { id: "steady", label: "Steady holds", check: "mean_sway <= 0.04" }], capture: { angle: "side-45", fps: 30, duration_s: 600 }, fallback: "self-report" } },
      { id: "daily", label: "Three weeks of morning practice", hours: [6, 12], nodes: ["flow"],
        proof: { engine: "self-report", spec: "practice-log", label: "Fifteen mornings logged in three weeks", criteria: [{ id: "sessions", label: "Fifteen sessions", check: "count >= 15" }] } }
    ],
    nodes: [
      { id: "breath", name: "Breath with movement", lesson: "breath-lesson", drills: ["breath-quiz"], review: { prompt: "Lift the arms: inhale or exhale?", kind: "choice", options: ["Inhale", "Exhale"], answer: 0 }, focus: "Fundamentals" },
      { id: "warrior", name: "Warrior II", requires: ["breath"], lesson: "warrior-lesson", drills: ["warrior-hold"], mistakes: ["knee-past-ankle"], review: { prompt: "Where does the front knee point?", kind: "choice", options: ["Over the ankle", "Inward"], answer: 0 }, focus: "Fundamentals" },
      { id: "tree", name: "Tree pose", requires: ["breath"], lesson: "tree-lesson", drills: ["tree-hold"], mistakes: ["swaying"], review: { prompt: "Where does the lifted foot go?", kind: "choice", options: ["Calf or thigh", "On the knee"], answer: 0 }, focus: "Balance" },
      { id: "dog", name: "Downward dog", requires: ["breath"], lesson: "dog-lesson", drills: ["dog-hold"], mistakes: ["rounded-back"], review: { prompt: "Bend knees or round the back?", kind: "choice", options: ["Bend knees", "Round back"], answer: 0 }, focus: "Mobility" },
      { id: "flow", name: "Linking the flow", requires: ["warrior", "tree", "dog"], lesson: "flow-lesson", drills: ["flow-run"], review: { prompt: "What links each pose?", kind: "choice", options: ["One breath", "A rest"], answer: 0 }, focus: "Mobility" }
    ],
    lessons: [
      { id: "breath-lesson", title: "Breath leads", nodes: ["breath"], cards: [
        { type: "predict", text: "Folding forward: inhale or exhale?", options: ["Exhale", "Inhale"], answer: 0, reveal: "Exhale as you fold; inhale as you lift." },
        { type: "sim", text: "Slow the breath. Watch the count per pose.", sim: { title: "Breaths per minute", params: { bpm: { label: "Breaths per minute", min: 4, max: 20, default: 12 } }, formulas: { seconds: "60 / bpm" }, figure: { kind: "gauge", value: "seconds", min: 0, max: 15, good: [4, 8] }, readout: [{ value: "seconds", label: "Seconds per breath", decimals: 1 }] } }
      ] },
      { id: "warrior-lesson", title: "Warrior II", nodes: ["warrior"], cards: [
        { type: "predict", text: "Where should the front knee sit?", options: ["Over the ankle", "Past the toes"], answer: 0 },
        { type: "compare", text: "Tap the knee that drifts past the ankle.", left: { kind: "figure", points: { hip: [40, 50], knee: [60, 68], ankle: [60, 92] }, segments: [["hip", "knee"], ["knee", "ankle"]], marks: [{ at: "knee", label: "90°", role: "good" }] }, right: { kind: "figure", points: { hip: [40, 50], knee: [70, 68], ankle: [60, 92] }, segments: [["hip", "knee"], ["knee", "ankle"]], marks: [{ at: "knee", label: "past", role: "attention" }] }, answer: "right" }
      ] },
      { id: "tree-lesson", title: "Tree pose", nodes: ["tree"], cards: [
        { type: "predict", text: "Fixing your eyes on one spot makes balance...", options: ["Easier", "Harder"], answer: 0 },
        { type: "diagram", text: "Sway over time: steady is a flat line.", figure: { kind: "chart", type: "line", series: [{ label: "Steady", values: [0, 1, 0, 1, 0, 1] }, { label: "Swaying", values: [0, 4, -3, 5, -4, 3] }] } }
      ] },
      { id: "dog-lesson", title: "Downward dog", nodes: ["dog"], cards: [
        { type: "predict", text: "Tight hamstrings: bend the knees or round the back?", options: ["Bend the knees", "Round the back"], answer: 0, reveal: "Bent knees keep the back long." },
        { type: "compare", text: "Tap the rounded back.", left: { kind: "figure", points: { wrist: [20, 90], shoulder: [35, 60], hip: [55, 30], ankle: [80, 90] }, segments: [["wrist", "shoulder"], ["shoulder", "hip"], ["hip", "ankle"]] }, right: { kind: "figure", points: { wrist: [20, 90], shoulder: [32, 55], mid: [42, 38], hip: [55, 40], ankle: [80, 90] }, segments: [["wrist", "shoulder"], ["shoulder", "mid"], ["mid", "hip"], ["hip", "ankle"]], marks: [{ at: "mid", label: "rounded", role: "attention" }] }, answer: "right" }
      ] },
      { id: "flow-lesson", title: "The morning flow", nodes: ["flow"], cards: [
        { type: "predict", text: "Rushing between poses makes holds...", options: ["Shakier", "Steadier"], answer: 0 },
        { type: "demo", text: "Mountain, fold, dog, warrior, tree, rest.", figure: { kind: "graph", nodes: [{ id: "m", label: "Mountain" }, { id: "f", label: "Fold" }, { id: "d", label: "Down dog" }, { id: "w", label: "Warrior II" }, { id: "t", label: "Tree" }, { id: "r", label: "Rest" }], edges: [["m", "f"], ["f", "d"], ["d", "w"], ["w", "t"], ["t", "r"]] }, playback: "steps" }
      ] }
    ],
    drills: [
      { id: "breath-quiz", type: "match", title: "Breath and movement", prompt: "Match each move to its breath.", nodes: ["breath"], spec: "yoga-quiz", minutes: 2, intensity: 1, focus: "Fundamentals" },
      { id: "warrior-hold", type: "move", title: "Warrior II hold", prompt: "Hold Warrior II facing the camera, each side.", nodes: ["warrior"], spec: "standing-holds", capture: { angle: "front", fps: 30, duration_s: 90 }, needs: ["A yoga mat"], success: "hold_s >= 20 && front_knee <= 110", difficulty: { param: "hold seconds", levels: [15, 20, 30, 45] }, minutes: 5, intensity: 2, focus: "Fundamentals", fixes: ["knee-past-ankle"] },
      { id: "tree-hold", type: "move", title: "Tree hold", prompt: "Tree pose facing the camera, each side.", nodes: ["tree"], spec: "standing-holds", capture: { angle: "front", fps: 30, duration_s: 90 }, needs: ["A yoga mat"], success: "hold_s >= 20 && sway <= 0.04", difficulty: { param: "foot height", levels: ["ankle", "calf", "thigh"] }, minutes: 5, intensity: 2, focus: "Balance", fixes: ["swaying"] },
      { id: "dog-hold", type: "move", title: "Down dog hold", prompt: "Down dog, side-on to the camera at floor height.", nodes: ["dog"], spec: "floor-holds", capture: { angle: "side", fps: 30, duration_s: 60 }, needs: ["A yoga mat"], success: "hold_s >= 20 && hip_angle <= 105", difficulty: { param: "hold seconds", levels: [15, 30, 45] }, minutes: 5, intensity: 2, focus: "Mobility", fixes: ["rounded-back"] },
      { id: "flow-run", type: "move", title: "Run the flow", prompt: "Flow the sequence once, camera at a corner of the mat.", nodes: ["flow"], spec: "flow-sequence", capture: { angle: "side-45", fps: 30, duration_s: 600 }, needs: ["A yoga mat"], success: "holds >= 5", difficulty: { param: "breaths per pose", levels: [3, 5, 8] }, minutes: 15, intensity: 2, focus: "Mobility" }
    ],
    specs: {
      "standing-holds": {
        kind: "metric",
        capture: { angle: "front", fps: 30, guide: "Whole body in frame, camera at chest height" },
        segment: { by: "holds", min_duration_s: 3 },
        metrics: {
          hold_s: "max(hold_time()) per hold",
          front_knee: "min(min(angle(left_hip, left_knee, left_ankle)), min(angle(right_hip, right_knee, right_ankle))) per hold",
          sway: "std(center_of_mass.x) per hold",
          arm_level: "mean(abs(left_wrist.y - right_wrist.y))"
        },
        units: { hold_s: "s", front_knee: "deg" },
        mistakes: [
          { id: "knee-past-ankle", when: "front_knee < 80", show: "overlay(angle(left_hip, left_knee, left_ankle))", fix_drill: "warrior-hold" },
          { id: "swaying", when: "sway > baseline.sway * 1.5", show: "skeleton", fix_drill: "tree-hold" }
        ],
        requires_visible: ["left_hip", "right_hip", "left_knee", "right_knee", "left_ankle", "right_ankle"]
      },
      "floor-holds": {
        kind: "metric",
        capture: { angle: "side", fps: 30, guide: "Camera at floor height, side-on: floor poses hide limbs from above" },
        segment: { by: "holds", min_duration_s: 3 },
        metrics: {
          hold_s: "max(hold_time()) per hold",
          hip_angle: "mean(angle(left_shoulder, left_hip, left_ankle)) per hold",
          back_line: "mean(angle(left_wrist, left_shoulder, left_hip)) per hold"
        },
        units: { hold_s: "s", hip_angle: "deg", back_line: "deg" },
        mistakes: [{ id: "rounded-back", when: "back_line < 150", show: "overlay(angle(left_wrist, left_shoulder, left_hip))", fix_drill: "dog-hold" }],
        requires_visible: ["left_wrist", "left_shoulder", "left_hip", "left_ankle"]
      },
      "flow-sequence": {
        kind: "metric",
        capture: { angle: "side-45", fps: 30, guide: "Camera at a corner of the mat, whole mat in frame" },
        segment: { by: "holds", min_duration_s: 3 },
        metrics: { hold_s: "max(hold_time()) per hold", holds: "count(hold_s)", sway: "std(center_of_mass.x) per hold", mean_sway: "mean(sway)" },
        units: { hold_s: "s" }
      },
      "yoga-quiz": {
        kind: "items",
        items: [
          { type: "match", id: "y1", prompt: "Match each move to its breath.", pairs: [["Arms up", "Inhale"], ["Fold forward", "Exhale"], ["Lift halfway", "Inhale"]], difficulty: 1, nodes: ["breath"] },
          { type: "choice", id: "y2", prompt: "Tight hamstrings in down dog: what first?", options: ["Bend the knees", "Push heels down hard"], answer: 0, difficulty: 2, nodes: ["dog"] },
          { type: "order", id: "y3", prompt: "Order the morning flow.", items: ["Mountain", "Fold", "Down dog", "Warrior II", "Tree"], difficulty: 3, nodes: ["flow"] }
        ]
      },
      "practice-log": { kind: "self-report", fields: ["done", "count", "minutes", "felt", "pain"], criterion: "Did the morning flow and noted how it felt", pass: "done && minutes >= 15" }
    },
    mistakes: [
      { id: "knee-past-ankle", name: "Knee past the ankle", nodes: ["warrior"], engine: "movement", detector: { metric: "front_knee", when: "front_knee < 80" }, severity: 2, explain: { lesson: "warrior-lesson", card: 1 }, fix_drill: "warrior-hold", headline: "Front knee drifts past the ankle" },
      { id: "swaying", name: "Swaying in balance", nodes: ["tree"], engine: "movement", detector: { metric: "sway", when: "sway > learner.baseline.sway * 1.5" }, severity: 1, explain: { lesson: "tree-lesson", card: 1 }, fix_drill: "tree-hold", headline: "More sway than your usual" },
      { id: "rounded-back", name: "Rounded back", nodes: ["dog"], engine: "movement", detector: { metric: "back_line", when: "back_line < 150" }, severity: 2, explain: { lesson: "dog-lesson", card: 1 }, fix_drill: "dog-hold", headline: "Back rounds; bend the knees" }
    ],
    warmups: [
      { id: "yoga-warmup", title: "Wake up gently", steps: ["Five slow breaths standing", "Ten neck and shoulder rolls", "Five cat-cow rounds", "Ten easy hip circles"], minutes: 4 },
      { id: "wrist-warmup", title: "Kind to wrists", steps: ["Five slow breaths", "Wrist circles both ways", "Forearm stretches against a wall"], minutes: 4, for_injuries: ["Wrists"] }
    ],
    safety: {
      warmup: "yoga-warmup",
      injury_questions: ["Any back, knee or wrist pain right now?", "Are you pregnant or recovering from surgery?"],
      beginner_caps: { max_intensity: 2, max_minutes: 30, sessions_per_week: 6 },
      stop_criteria: ["Sharp or pinching pain", "Numbness or tingling", "Dizziness when standing up"],
      see_professional: ["Pain that lasts more than a week", "Pregnancy or recent surgery, before starting"],
      supervised_only: []
    },
    access: ["A yoga mat", "A phone to film with"],
    injuries: { Wrists: "Forearm dog instead of down dog for two weeks", Knees: "A folded blanket under the knee; shallower Warrior II", "Lower back": "Bend the knees in every fold; skip deep folds for two weeks" },
    focus: { Fundamentals: 35, Mobility: 40, Balance: 25 },
    hard_focus: ["Mobility"],
    key_metrics: [
      { id: "hold", label: "Hold time", engine: "movement", metric: "hold_s", unit: "s", better: "higher", format: "number" },
      { id: "sway", label: "Sway in balance", engine: "movement", metric: "sway", better: "lower", format: "number" }
    ],
    copy: { placeholder: "yoga, a morning flow, stretching", blurb: "Steady holds, linked by breath" },
    notes: "Engines: movement measures holds (time, joint angles, sway). Floor poses hide limbs from a front camera, so down dog is filmed side-on at floor height; the flow is filmed from a mat corner. Sway thresholds are relative to the learner's own first attempts. Hours are estimates from general beginner practice guidance, shown as ranges."
  })
};
