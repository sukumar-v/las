import { recordFallbacks, type Scenario } from "../src/harness.js";

/** Bodyweight strength (squat and push-up) measured as repetitions from a side view. The load itself isn't visible. */
export const strengthWorkout: Scenario = {
  id: "strength-workout",
  skill: "strength workout: squats and push-ups",
  notes: "Training at home three times a week; has a pair of dumbbells. Asked whether to test a one-rep max.",
  expect: { engines: ["movement"], main: "movement", fallback: "self-report", physical: true, supervisedOnly: ["maximal load"] },
  build: (draft) => ({
    skill: "strength workout: squats and push-ups",
    name: "Strength basics",
    noun: "strength training",
    source: "generated",
    physical: true,
    engines: ["movement", "knowledge", "self-report"],
    fallbacks: recordFallbacks(draft, { movement: "self-report" }),
    why: [
      { id: "strong", label: "Get stronger" },
      { id: "health", label: "Stay healthy" },
      { id: "look", label: "Feel good in my body" },
      { id: "sport", label: "Support my sport" }
    ],
    pictures: [
      { id: "habit", label: "Three home sessions a week", why: ["health", "look"], ladderStep: 3, milestone: "3 x 10 controlled squats", proof: "One clip: ten squats to depth, two seconds down", focus: { Fundamentals: 50, Strength: 35, Theory: 15 }, access: ["A clear floor"] },
      { id: "pushups", label: "Fifteen full push-ups", why: ["strong", "sport"], ladderStep: 4, milestone: "Fifteen push-ups, body straight", proof: "One clip of fifteen full push-ups", focus: { Fundamentals: 35, Strength: 50, Theory: 15 } },
      { id: "loaded", label: "Training with dumbbells", why: ["strong", "look"], ladderStep: 5, milestone: "Six weeks of logged loaded sessions", proof: "A training log with steady, pain-free progress", focus: { Fundamentals: 30, Strength: 55, Theory: 15 }, access: ["Dumbbells"] }
    ],
    probes: [
      { id: "squats", type: "single", question: "How many bodyweight squats can you do in a row?", options: [{ value: 0, label: "None yet" }, { value: 10, label: "About 10" }, { value: 25, label: "25 or more" }] },
      { id: "pushups", type: "single", question: "How many full push-ups can you do?", options: [{ value: 0, label: "None yet" }, { value: 5, label: "About 5" }, { value: 15, label: "15 or more" }] },
      { id: "theory", type: "quiz", question: "Three quick questions on form.", spec: "form-quiz" }
    ],
    placement: [
      { when: "!fresh && squats >= 25 && pushups >= 15", step: 4, evidence: "Strong bodyweight base" },
      { when: "squats >= 10 && pushups >= 5", step: 2, evidence: "Can already do both moves" },
      { when: "squats >= 10 || quiz.correct >= 2", step: 1 }
    ],
    ladder: [
      { id: "start", label: "Brand new", hours: [0, 0] },
      { id: "first-squats", label: "Five squats to depth", hours: [1, 3], nodes: ["brace", "squat"],
        proof: { engine: "movement", spec: "squat-reps", label: "Five bodyweight squats, each to depth", criteria: [{ id: "depth", label: "Deep enough", check: "share(depth_ok) >= 0.8" }, { id: "count", label: "Five reps", check: "reps >= 5" }], capture: { angle: "side", fps: 30, duration_s: 45 }, fallback: "self-report" } },
      { id: "first-pushups", label: "Five push-ups, body straight", hours: [3, 8], nodes: ["pushup"],
        proof: { engine: "movement", spec: "pushup-reps", label: "Five push-ups (incline is fine) with a straight body", criteria: [{ id: "line", label: "Straight body", check: "share(line_ok) >= 0.8" }, { id: "count", label: "Five reps", check: "reps >= 5" }], capture: { angle: "side", fps: 30, duration_s: 45 }, fallback: "self-report" } },
      { id: "tempo", label: "Ten slow squats", hours: [4, 8], nodes: ["tempo"],
        proof: { engine: "movement", spec: "squat-reps", label: "Ten squats, two seconds down, all to depth", criteria: [{ id: "slow", label: "Two seconds down", check: "tempo_down_s >= 2" }, { id: "depth", label: "Deep enough", check: "share(depth_ok) >= 0.8" }, { id: "count", label: "Ten reps", check: "reps >= 10" }], capture: { angle: "side", fps: 30, duration_s: 90 }, fallback: "self-report" } },
      { id: "fifteen", label: "Fifteen full push-ups", hours: [8, 20], nodes: ["pushup"],
        proof: { engine: "movement", spec: "pushup-reps", label: "Fifteen floor push-ups, chest low, body straight", criteria: [{ id: "depth", label: "Chest low", check: "share(depth_ok) >= 0.8" }, { id: "line", label: "Straight body", check: "share(line_ok) >= 0.8" }, { id: "count", label: "Fifteen reps", check: "reps >= 15" }], capture: { angle: "side", fps: 30, duration_s: 90 }, fallback: "self-report" } },
      { id: "loaded", label: "Six weeks of logged loaded training", hours: [15, 30], nodes: ["progress"],
        proof: { engine: "self-report", spec: "training-log", label: "Six weeks logged: load, sets, reps and effort, no pain", criteria: [{ id: "logged", label: "Eighteen sessions logged", check: "count >= 18" }, { id: "pain_free", label: "No pain", check: "pain == 0" }] } }
    ],
    nodes: [
      { id: "brace", name: "Bracing", lesson: "brace-lesson", drills: ["brace-quiz"], review: { prompt: "When do you take your breath and brace?", kind: "choice", options: ["Before each rep", "At the bottom"], answer: 0 }, focus: "Fundamentals" },
      { id: "squat", name: "Squat to depth", requires: ["brace"], lesson: "squat-lesson", drills: ["box-squat"], mistakes: ["shallow"], review: { prompt: "Which knee angle counts as deep?", kind: "choice", options: ["95 degrees or less", "150 degrees"], answer: 0 }, focus: "Fundamentals" },
      { id: "pushup", name: "Push-up", requires: ["brace"], lesson: "pushup-lesson", drills: ["incline-pushups"], mistakes: ["sagging-hips"], review: { prompt: "Where should your hips be?", kind: "choice", options: ["In line with shoulders and ankles", "Higher than shoulders"], answer: 0 }, focus: "Strength" },
      { id: "tempo", name: "Slow lowering", requires: ["squat"], lesson: "tempo-lesson", drills: ["tempo-squats"], mistakes: ["dropping"], review: { prompt: "How long is a slow lowering?", kind: "choice", options: ["About two seconds", "Under half a second"], answer: 0 }, focus: "Strength" },
      { id: "progress", name: "Adding load safely", requires: ["tempo", "pushup"], lesson: "progress-lesson", drills: ["progress-quiz"], review: { prompt: "What do you change first: reps or load?", kind: "choice", options: ["Reps", "Load"], answer: 0 }, focus: "Theory" }
    ],
    lessons: [
      { id: "brace-lesson", title: "Bracing", nodes: ["brace"], cards: [
        { type: "predict", text: "Does bracing mean sucking your belly in?", options: ["No, it stiffens all around", "Yes"], answer: 0, reveal: "Breathe in, then tighten like a cylinder." },
        { type: "mechanism", text: "A braced trunk keeps the spine still under load.", concept: "trunk bracing" }
      ] },
      { id: "squat-lesson", title: "Squat depth", nodes: ["squat"], cards: [
        { type: "predict", text: "Which joint angle shows squat depth best from the side?", options: ["Knee", "Elbow"], answer: 0 },
        { type: "sim", text: "Drag the knee angle. Watch the hip drop.", sim: { title: "Knee angle and hip height", params: { knee_deg: { label: "Knee angle", min: 60, max: 180, default: 120, unit: "deg" } }, formulas: { hip_drop_pct: "clamp((180 - knee_deg) / 1.2, 0, 100)" }, figure: { kind: "plot", x: "knee_deg", series: ["hip_drop_pct"] }, readout: [{ value: "hip_drop_pct", label: "Hip drop", unit: "%" }] } },
        { type: "compare", text: "Same squat, two depths. Tap the shallow one.", left: { kind: "figure", points: { hip: [45, 62], knee: [62, 68], ankle: [55, 92] }, segments: [["hip", "knee"], ["knee", "ankle"]], marks: [{ at: "knee", label: "90°", role: "good" }] }, right: { kind: "figure", points: { hip: [48, 48], knee: [60, 66], ankle: [55, 92] }, segments: [["hip", "knee"], ["knee", "ankle"]], marks: [{ at: "knee", label: "130°", role: "attention" }] }, answer: "right" }
      ] },
      { id: "pushup-lesson", title: "The push-up", nodes: ["pushup"], cards: [
        { type: "predict", text: "Hands on a bench: easier or harder?", options: ["Easier", "Harder"], answer: 0, reveal: "Incline push-ups lift less body weight." },
        { type: "compare", text: "Tap the push-up with sagging hips.", left: { kind: "figure", points: { shoulder: [25, 50], hip: [55, 55], ankle: [85, 60] }, segments: [["shoulder", "hip"], ["hip", "ankle"]] }, right: { kind: "figure", points: { shoulder: [25, 50], hip: [55, 66], ankle: [85, 60] }, segments: [["shoulder", "hip"], ["hip", "ankle"]], marks: [{ at: "hip", label: "sag", role: "attention" }] }, answer: "right" }
      ] },
      { id: "tempo-lesson", title: "Slow lowering", nodes: ["tempo"], cards: [
        { type: "predict", text: "Which builds more control: fast or slow lowering?", options: ["Slow", "Fast"], answer: 0 },
        { type: "diagram", text: "Two counts down, a short pause, one count up.", figure: { kind: "chart", type: "bar", series: [{ label: "Seconds", values: [2, 0.5, 1] }], labels: ["Down", "Pause", "Up"] } },
        { type: "try-it", text: "Count the lowering out loud with the click.", action: "count", seconds: 20 }
      ] },
      { id: "progress-lesson", title: "Adding load", nodes: ["progress"], cards: [
        { type: "predict", text: "Ten easy reps: add load or add reps first?", options: ["Reps, up to 15", "Load right away"], answer: 0 },
        { type: "diagram", text: "Small steps: reps first, then a little load.", figure: { kind: "chart", type: "line", series: [{ label: "Load", values: [0, 0, 2, 2, 4, 4] }, { label: "Reps", values: [8, 12, 8, 12, 8, 12] }], labels: ["W1", "W2", "W3", "W4", "W5", "W6"] } },
        { type: "mechanism", text: "Maximal lifts need a coach and a spotter. We teach the idea only.", concept: "why one-rep max tests are supervised" }
      ] }
    ],
    drills: [
      { id: "brace-quiz", type: "choice", title: "Brace check", prompt: "Pick the braced trunk.", nodes: ["brace"], spec: "form-quiz", minutes: 2, intensity: 1, focus: "Fundamentals" },
      { id: "box-squat", type: "timed-reps", title: "Squat to a box", prompt: "Film five squats from the side, touching a chair each rep.", nodes: ["squat"], spec: "squat-reps", capture: { angle: "side", fps: 30, duration_s: 45 }, needs: ["A clear floor", "A sturdy chair"], success: "share(depth_ok) >= 0.7", difficulty: { param: "reps", levels: [5, 8, 12] }, minutes: 6, intensity: 2, focus: "Fundamentals", fixes: ["shallow"] },
      { id: "incline-pushups", type: "timed-reps", title: "Incline push-ups", prompt: "Film push-ups from the side, hands on a bench. Keep a straight line.", nodes: ["pushup"], spec: "pushup-reps", capture: { angle: "side", fps: 30, duration_s: 45 }, needs: ["A clear floor"], success: "share(line_ok) >= 0.8", difficulty: { param: "height", levels: ["counter", "bench", "low step", "floor"] }, minutes: 6, intensity: 3, focus: "Strength", fixes: ["sagging-hips"] },
      { id: "tempo-squats", type: "timed-reps", title: "Two-second squats", prompt: "Ten squats, two seconds down. Film from the side.", nodes: ["tempo"], spec: "squat-reps", capture: { angle: "side", fps: 30, duration_s: 90 }, needs: ["A clear floor"], success: "tempo_down_s >= 2 && share(depth_ok) >= 0.8", difficulty: { param: "reps", levels: [6, 8, 10] }, minutes: 6, intensity: 3, focus: "Strength", fixes: ["dropping"] },
      { id: "progress-quiz", type: "order", title: "Plan a progression", prompt: "Put the six weeks in order.", nodes: ["progress"], spec: "form-quiz", minutes: 3, intensity: 1, focus: "Theory" }
    ],
    specs: {
      "squat-reps": {
        kind: "metric",
        capture: { angle: "side", fps: 30, guide: "Side view, whole body in frame, camera at hip height" },
        segment: { by: "reps", signal: "left_hip.y" },
        phases: { bottom: "left_hip.y == max(left_hip.y)" },
        metrics: {
          knee_bottom: "min(angle(left_hip, left_knee, left_ankle)) per rep",
          depth_ok: "knee_bottom <= 95",
          torso_lean: "angle(left_shoulder, left_hip, vertical) at bottom",
          tempo_down_s: "phase_duration(down)",
          reps: "count(knee_bottom)"
        },
        units: { knee_bottom: "deg", torso_lean: "deg", tempo_down_s: "s" },
        mistakes: [
          { id: "shallow", when: "share(not depth_ok) >= 0.3", show: "overlay(angle(left_hip, left_knee, left_ankle))", fix_drill: "box-squat" },
          { id: "dropping", when: "tempo_down_s < 1", show: "overlay(phase_duration(down))", fix_drill: "tempo-squats" }
        ],
        requires_visible: ["left_hip", "left_knee", "left_ankle", "left_shoulder"]
      },
      "pushup-reps": {
        kind: "metric",
        capture: { angle: "side", fps: 30, guide: "Side view at floor height, head to feet in frame" },
        segment: { by: "reps", signal: "left_shoulder.y" },
        metrics: {
          elbow_bottom: "min(angle(left_shoulder, left_elbow, left_wrist)) per rep",
          depth_ok: "elbow_bottom <= 100",
          body_line: "min(angle(left_shoulder, left_hip, left_ankle)) per rep",
          line_ok: "body_line >= 160",
          reps: "count(elbow_bottom)"
        },
        units: { elbow_bottom: "deg", body_line: "deg" },
        mistakes: [{ id: "sagging-hips", when: "share(not line_ok) >= 0.3", show: "overlay(angle(left_shoulder, left_hip, left_ankle))", fix_drill: "incline-pushups" }],
        requires_visible: ["left_shoulder", "left_elbow", "left_wrist", "left_hip", "left_ankle"]
      },
      "form-quiz": {
        kind: "items",
        items: [
          { type: "choice", id: "f1", prompt: "From which side should the camera film a squat?", options: ["The side", "The front"], answer: 0, difficulty: 1, nodes: ["squat"] },
          { type: "choice", id: "f2", prompt: "Which trunk is braced?", options: ["Stiff all around after a breath", "Belly sucked in"], answer: 0, difficulty: 1, nodes: ["brace"] },
          { type: "choice", id: "f3", prompt: "In a push-up, where should the hips be?", options: ["In line", "Sagging", "Piked up"], answer: 0, difficulty: 2, nodes: ["pushup"] },
          { type: "order", id: "f4", prompt: "Order a safe progression.", items: ["Bodyweight, 8 reps", "Bodyweight, 15 reps", "Light dumbbells, 8 reps", "Light dumbbells, 12 reps"], difficulty: 3, nodes: ["progress"] }
        ],
        pass: "accuracy >= 0.75"
      },
      "training-log": { kind: "self-report", fields: ["done", "count", "effort", "pain", "note"], criterion: "Logged load, sets, reps and effort for each session; effort stays at 8 of 10 or below", pass: "done && pain == 0" }
    },
    mistakes: [
      { id: "shallow", name: "Shallow squats", nodes: ["squat"], engine: "movement", detector: { metric: "depth_ok", when: "share(not depth_ok) >= 0.3", min_share: 0.3 }, severity: 2, explain: { lesson: "squat-lesson", card: 2 }, fix_drill: "box-squat", headline: "Squats stop above the target depth" },
      { id: "sagging-hips", name: "Sagging hips", nodes: ["pushup"], engine: "movement", detector: { metric: "line_ok", when: "share(not line_ok) >= 0.3", min_share: 0.3 }, severity: 2, explain: { lesson: "pushup-lesson", card: 1 }, fix_drill: "incline-pushups", headline: "Hips sag below the line" },
      { id: "dropping", name: "Dropping into the squat", nodes: ["tempo"], engine: "movement", detector: { metric: "tempo_down_s", when: "tempo_down_s < 1" }, severity: 1, explain: { lesson: "tempo-lesson", card: 1 }, fix_drill: "tempo-squats", headline: "Lowering takes under one second" }
    ],
    warmups: [
      { id: "strength-warmup", title: "Joints and pulse", steps: ["Two minutes of brisk marching", "Ten arm circles each way", "Ten slow bodyweight squats to a chair", "Five wall push-ups"], minutes: 5 },
      { id: "shoulder-warmup", title: "Gentle shoulders", steps: ["Two minutes of marching", "Ten small arm circles", "Ten wall slides, pain-free range only"], minutes: 5, for_injuries: ["Shoulders"] }
    ],
    safety: {
      warmup: "strength-warmup",
      injury_questions: ["Any knee, back, shoulder or wrist pain right now?", "Has a doctor limited your exercise?"],
      beginner_caps: { max_intensity: 3, max_minutes: 40, sessions_per_week: 3 },
      stop_criteria: ["Sharp or joint pain", "Dizziness or chest tightness", "Numbness or tingling"],
      see_professional: ["Pain that lasts more than a week", "Chest pain or fainting during exercise"],
      supervised_only: ["Heavy lifting with a maximal load (one-rep max tests)"]
    },
    access: ["A clear floor", "A sturdy chair", "Dumbbells", "A phone to film with"],
    injuries: { Knees: "Squat only to a high box, pain-free depth, for two weeks; no loaded squats", Shoulders: "Incline push-ups only, pain-free range, for two weeks", "Lower back": "Bodyweight only and slower reps; skip loaded work for two weeks" },
    focus: { Fundamentals: 45, Strength: 40, Theory: 15 },
    hard_focus: ["Strength"],
    key_metrics: [
      { id: "squat-depth", label: "Squats to depth", engine: "movement", metric: "depth_ok", unit: "%", better: "higher", format: "percent" },
      { id: "pushup-line", label: "Push-ups in a straight line", engine: "movement", metric: "line_ok", unit: "%", better: "higher", format: "percent" },
      { id: "reps", label: "Clean reps", engine: "movement", metric: "reps", better: "higher", format: "count" }
    ],
    copy: { placeholder: "squats, push-ups, a home workout", blurb: "Clean reps first, then load" },
    notes: "Engines: movement counts reps and checks depth and body line from a side view. The load can't be seen on camera, so loaded progress is a self-reported log. Maximal lifts (one-rep max tests) are supervised-only: taught as theory in the progression lesson, never coached or assessed. Hours are estimates from general beginner strength guidance, shown as ranges."
  })
};
