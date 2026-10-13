/**
 * Generic view data for the snapshot route (/snapshots): every main screen drawn in any theme so the end-to-end
 * suite can check layout, overlap, focus and contrast. Placeholder content, the same for every theme.
 */
import type { IntakeView, TodayView, SessionPlan, FeedbackView, ProgressView, SummaryView, ProofResultView, RouteView, PlanView, PlacementView, MilestoneSuggestion, Analysis } from "@las/schema";

export const route: RouteView = {
  start: 1,
  target: 3,
  steps: [
    { step: 0, label: "Brand new", hours: [0, 0], state: "done", target: false, nodes: [] },
    { step: 1, label: "First clean rep", hours: [2, 4], state: "here", target: false, nodes: [{ id: "setup", name: "Setup", mastery: 0.8 }] },
    { step: 2, label: "Ten clean reps", hours: [6, 10], weeks: 3, state: "ahead", target: false, nodes: [{ id: "depth", name: "Depth", mastery: 0.3 }] },
    { step: 3, label: "Add weight", hours: [10, 20], weeks: 7, state: "ahead", target: true, nodes: [{ id: "brace", name: "Bracing", mastery: 0.05 }] }
  ]
};

export const placement: PlacementView = { step: 1, evidence: ["Tried a few times", "Placement: 2 of 3 right"], rows: route.steps.slice(0, 4).map((s) => ({ step: s.step, label: s.label, state: s.state, weeks: s.weeks })), canLower: true, canRaise: true };

export const suggestions: MilestoneSuggestion[] = [
  { kind: "picture", kindLabel: "Toward showing people", step: 3, title: "Add weight", proof: "Log three loaded sessions", engine: "self-report", weeks: 7, feasibility: { kind: "good", label: "Realistic" } },
  { kind: "quick", kindLabel: "Quick win", step: 2, title: "Ten clean reps", proof: "Ten reps in a row", engine: "movement", weeks: 3, feasibility: { kind: "good", label: "Fits your deadline" } },
  { kind: "stretch", kindLabel: "Stretch", step: 3, title: "Add weight", proof: "Log three loaded sessions", engine: "self-report", weeks: 7, feasibility: { kind: "warn", label: "Ambitious", message: 'Reach "Ten clean reps" by your deadline, then this by week 7.', stoneStep: 2 } }
];

export const plan: PlanView = {
  sk: "sk_test",
  skill: "Test skill",
  milestone: { title: "Ten clean reps", proof: "Ten reps in a row, knees to 95 degrees", engine: "movement", targetDate: "Nov 3", weeks: 3, hoursPerWeek: 3, feasibility: "Realistic" },
  route,
  why: ["For fun", "Health"],
  picture: "Enjoying it weekly",
  mix: [{ category: "Technique", share: 70 }, { category: "Theory", share: 20 }, { category: "Recovery & prehab", share: 10 }],
  mixReasons: ["new to this: more fundamentals", "knees: recovery built in"],
  schedule: { sessionsPerWeek: 3, minutesEach: 40, days: [0, 2, 5] },
  checkins: ["3 sessions a week, about 40 min each. We nudge you if you miss one.", "Proof check around Nov 3: a clip.", "Once you hit it, we ask why again. Goals change."],
  injuryRules: [{ injury: "Knees", rule: "Reduce depth and skip loaded reps for two weeks" }],
  safety: { supervisedOnly: [], stop: ["Sharp pain"] },
  profile: { skill: "Test skill", intent: { why: ["fun", "health"] } }
};

export const intakeSteps: IntakeView[] = [
  { intakeId: "int_1", step: "look", stepIndex: 0, sections: ["Look", "Skill", "Why", "Picture it", "Level", "Time", "Milestone", "Plan"], sectionIndex: 0, ribbon: [], question: "Pick a look", sub: "Optional. Everything after this is drawn in it.", answerType: "single", options: [{ value: "base", label: "Keep it plain", detail: "The neutral base theme" }, { value: "agent", label: "Describe it in the chat", detail: "Paste a design prompt, describe it, or add a screenshot" }], cta: { label: "Skip", enabled: true } },
  { intakeId: "int_1", step: "skill", stepIndex: 1, sections: ["Look", "Skill", "Why", "Picture it", "Level", "Time", "Milestone", "Plan"], sectionIndex: 1, ribbon: [{ id: "look", label: "Base look", icon: "look" }], question: "What do you want to learn?", answerType: "text", options: [{ value: "Test skill", label: "Test skill", icon: "dumbbell" }], cta: { label: "Continue", enabled: false } },
  { intakeId: "int_1", step: "why", stepIndex: 2, sections: ["Look", "Skill", "Why", "Picture it", "Level", "Time", "Milestone", "Plan"], sectionIndex: 2, ribbon: [{ id: "skill", label: "Test skill" }], question: "What's pulling you toward the test skill?", answerType: "multi", options: [{ value: "fun", label: "For fun", icon: "heart" }, { value: "health", label: "Health", icon: "care" }, { value: "prove", label: "Prove it to myself", icon: "flag" }], value: ["fun"], max: 2, cta: { label: "Continue", enabled: true } },
  { intakeId: "int_1", step: "picture", stepIndex: 3, sections: ["Look", "Skill", "Why", "Picture it", "Level", "Time", "Milestone", "Plan"], sectionIndex: 3, ribbon: [{ id: "skill", label: "Test skill" }, { id: "why", label: "For fun" }], question: "Six months from now, what are you doing?", sub: "You're here to have fun. These fit that best.", answerType: "single", options: [{ value: "enjoy", label: "Enjoying it weekly", badge: "Fits your why" }, { value: "show", label: "Showing people" }], cta: { label: "Continue", enabled: false } },
  { intakeId: "int_1", step: "probe", stepIndex: 4, sections: ["Look", "Skill", "Why", "Picture it", "Level", "Time", "Milestone", "Plan"], sectionIndex: 4, ribbon: [{ id: "skill", label: "Test skill" }], question: "How much have you done?", answerType: "single", field: "level", options: [{ value: 0, label: "Never", detail: "Starting from zero" }, { value: 1, label: "A few times" }, { value: 2, label: "Every week" }], payload: { first: true }, cta: { label: "Continue", enabled: false } },
  { intakeId: "int_1", step: "probe", stepIndex: 5, sections: ["Look", "Skill", "Why", "Picture it", "Level", "Time", "Milestone", "Plan"], sectionIndex: 4, ribbon: [], question: "Three quick questions.", answerType: "quiz", field: "quiz", payload: { item: { prompt: "How wide is a normal stance?", options: ["Shoulder width", "Feet together"] }, history: [true] }, cta: { label: "Continue", enabled: false } },
  { intakeId: "int_1", step: "probe", stepIndex: 5, sections: ["Look", "Skill", "Why", "Picture it", "Level", "Time", "Milestone", "Plan"], sectionIndex: 4, ribbon: [], question: "Which of these do you know?", answerType: "visual-multi", field: "shapes", options: [{ value: "a", label: "Shape A", figure: { kind: "figure", points: { a: [20, 20], b: [80, 80] }, segments: [["a", "b"]], marks: [] } }, { value: "b", label: "Shape B", figure: { kind: "figure", points: { a: [20, 80], b: [80, 20] }, segments: [["a", "b"]], marks: [] } }], cta: { label: "Skip", enabled: true } },
  { intakeId: "int_1", step: "probe", stepIndex: 5, sections: ["Look", "Skill", "Why", "Picture it", "Level", "Time", "Milestone", "Plan"], sectionIndex: 4, ribbon: [], question: "Tap with the click.", answerType: "tap", field: "tap", payload: { taps: 3 }, cta: { label: "Continue", enabled: false } },
  { intakeId: "int_1", step: "probe", stepIndex: 5, sections: ["Look", "Skill", "Why", "Picture it", "Level", "Time", "Milestone", "Plan"], sectionIndex: 4, ribbon: [], question: "Which level are you at?", answerType: "scale", field: "grade", options: [{ value: 0, label: "Never" }, { value: 1, label: "L1" }, { value: 2, label: "L2" }, { value: 3, label: "L3" }], cta: { label: "Continue", enabled: false } },
  { intakeId: "int_1", step: "place", stepIndex: 6, sections: ["Look", "Skill", "Why", "Picture it", "Level", "Time", "Milestone", "Plan"], sectionIndex: 4, ribbon: [], question: "Here's where you start", answerType: "none", payload: { placement }, cta: { label: "Continue", enabled: true } },
  { intakeId: "int_1", step: "time", stepIndex: 7, sections: ["Look", "Skill", "Why", "Picture it", "Level", "Time", "Milestone", "Plan"], sectionIndex: 5, ribbon: [], question: "How much time can you give it?", answerType: "slider", payload: { minutes: 180, deadline: "none", schedule: { sessionsPerWeek: 3, minutesEach: 60, days: [0, 2, 5] } }, cta: { label: "Continue", enabled: true } },
  { intakeId: "int_1", step: "around", stepIndex: 8, sections: ["Look", "Skill", "Why", "Picture it", "Level", "Time", "Milestone", "Plan"], sectionIndex: 5, ribbon: [], question: "Anything we should plan around?", answerType: "multi", payload: { accessOptions: ["A clear floor", "A mat"], injuryOptions: ["Knees", "Back"], access: ["A mat"], injuries: ["Knees"] }, cta: { label: "Continue", enabled: true } },
  { intakeId: "int_1", step: "milestone", stepIndex: 9, sections: ["Look", "Skill", "Why", "Picture it", "Level", "Time", "Milestone", "Plan"], sectionIndex: 6, ribbon: [], question: "Pick your first milestone", sub: "Your first step toward enjoying it weekly.", answerType: "single", payload: { suggestions, picked: 1, placeholder: "e.g. My first clean set", route }, cta: { label: "Continue", enabled: true } },
  { intakeId: "int_1", step: "plan", stepIndex: 10, sections: ["Look", "Skill", "Why", "Picture it", "Level", "Time", "Milestone", "Plan"], sectionIndex: 7, ribbon: [], question: "Your plan", answerType: "none", payload: { plan }, cta: { label: "Start", enabled: true }, done: true, sk: "sk_test" }
];

export const today: TodayView = {
  sk: "sk_test",
  skill: "Test skill",
  state: "missed",
  nextSession: { title: "Session 2: Depth", minutes: 40, focus: "Depth", reason: "Picked because reps stop above parallel on your last attempt." },
  reviewsDue: { count: 3, minutes: 1 },
  milestone: { title: "Ten clean reps", percent: 42, proofDate: "Nov 3", step: 2 },
  checkin: { id: "chk_1", kind: "missed", question: "Missed Tuesday. Move it to today?", options: [{ id: "move", label: "Move it" }, { id: "quick", label: "Quick 5-min" }, { id: "skip", label: "Skip" }] },
  week: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, state: day === 0 ? "done" : day === 1 ? "missed" : day === 2 || day === 5 ? "plan" : "none", today: day === 2 })),
  weeklyReview: "Weekly review on Sunday, 5 minutes with your coach.",
  route
};

export const analysis: Analysis = {
  engine: "movement",
  quality: { ok: true, issues: [] },
  metrics: { knee_bottom: { value: 104, unit: "deg", confidence: 0.86, per: [110, 101, 108, 96, 104] }, depth_ok: { value: 0.2, unit: "", confidence: 0.86 }, reps: { value: 5, unit: "reps", confidence: 0.95 } },
  markers: [{ t: 2.1, label: "deepest rep", role: "good" }],
  mistakes: [{ id: "shallow", severity: 2, confidence: 0.86, at: [1.2, 3.4, 5.1], evidence: { kind: "time", t: 3.4 }, share: 0.8 }],
  criteria: { depth: false },
  praise: { metric: "reps", label: "Five reps found, steady tempo" },
  keyFrames: [],
  segments: [[0, 1.5], [1.5, 3], [3, 4.4], [4.4, 5.9], [5.9, 7.3]],
  version: "movement@0.1.0/rep-metrics",
  precision: "full"
};

export const feedback: FeedbackView = {
  attemptId: "att_1",
  sk: "sk_test",
  headline: "Reps stop above parallel",
  mistakeId: "shallow",
  severity: 2,
  confidence: 0.86,
  evidence: { ref: { kind: "time", t: 3.4 }, figure: { kind: "figure", points: { hip: [50, 40], knee: [60, 70], ankle: [50, 95] }, segments: [["hip", "knee"], ["knee", "ankle"]], marks: [{ at: "knee", label: "104°", role: "attention" }] }, label: "Rep 4 at 3.4s: knee 104°, target 95°" },
  praise: { headline: "Five reps found, steady tempo", metric: "reps" },
  fixDrillId: "depth-reps",
  fixDrillTitle: "Five deep reps",
  why: { figure: { kind: "chart", type: "bar", series: [{ label: "Knee angle", values: [110, 101, 108, 96, 104] }], labels: ["1", "2", "3", "4", "5"] } },
  analysis,
  precision: "full",
  compare: { previousAttemptId: "att_0", metric: "depth_ok", before: 20, after: 60, unit: "%" }
};

export const session: SessionPlan = {
  sessionId: "ses_1",
  sk: "sk_test",
  skill: "Test skill",
  title: "Session 1: Depth",
  minutes: 40,
  focus: { nodeId: "depth", name: "Depth", reason: "Picked because it's the biggest gap between you and your milestone." },
  status: "active",
  blocks: [
    { kind: "warmup", minutes: 5, reason: "Knees flagged: a warm-up is required.", title: "Warm-up", items: [{ type: "warmup", steps: ["Two minutes of easy movement", "Ten bodyweight reps"] }] },
    { kind: "recall", minutes: 4, reason: "Three cards are due.", title: "Recall", items: [{ type: "review", cardIds: ["c1", "c2", "c3"], count: 3 }] },
    { kind: "learn", minutes: 7, reason: "Depth is the lowest-mastery skill with its prerequisites met.", title: "Learn", items: [{ type: "lesson", lessonId: "depth-lesson", title: "Depth", nodes: ["depth"], cards: [{ type: "predict", text: "Deeper reps work which muscle more?", options: ["Glutes", "Calves"], answer: 0 }, { type: "sim", text: "Drag the depth. Watch the load.", sim: { kind: "sim", title: "Depth and load", params: { depth: { label: "Knee angle", min: 60, max: 150, default: 100, unit: "°" } }, formulas: { load: "clamp((150 - depth) * 1.2, 0, 100)" }, figure: { kind: "plot", x: "depth", series: ["load"] }, readout: [{ value: "load", label: "Glute load", unit: "%", decimals: 0 }] } }] }] },
    { kind: "practice", minutes: 15, reason: "Top-scored candidate: lowest mastery and an open mistake.", title: "Practice", items: [{ type: "drill", drill: { id: "setup-quiz", type: "choice", title: "Setup check", nodes: ["setup"], spec: "placement-quiz", minutes: 2, intensity: 1, needs: [], fixes: [] }, difficulty: 0, label: "" }] },
    { kind: "perform", minutes: 7, reason: "One real attempt, analyzed on this device.", title: "Perform", items: [{ type: "capture", attemptSpecId: "as_1", engine: "movement", specId: "rep-metrics", prompt: "Film five reps", how: "Side-on, phone at hip height, about 3 m back.", kind: "perform", angle: "side", durationS: 30 }] },
    { kind: "wrapup", minutes: 2, reason: "What changed and what's next.", title: "Wrap-up", items: [{ type: "wrapup" }] }
  ]
};

export const progress: ProgressView = {
  sk: "sk_test",
  skill: "Test skill",
  route,
  nodes: [{ id: "setup", name: "Setup", mastery: 0.85 }, { id: "depth", name: "Depth", mastery: 0.45 }, { id: "brace", name: "Bracing", mastery: 0.05 }],
  keyMetrics: [{ id: "depth", label: "Reps to depth", unit: "%", better: "higher", format: "percent", history: [{ value: 0.2, at: "2026-10-01" }, { value: 0.4, at: "2026-10-03" }, { value: 0.6, at: "2026-10-05" }], first: 0.2, latest: 0.6 }],
  beforeAfter: { drillId: "depth-reps", label: "Five deep reps", first: { attemptId: "att_0", value: 1, at: "2026-10-01" }, latest: { attemptId: "att_1", value: 3, at: "2026-10-05" }, unit: " of 5" },
  time: { actualMinutes: 85, plannedMinutes: 120, mix: [{ category: "Technique", planned: 70, actual: 80 }, { category: "Theory", planned: 20, actual: 10 }, { category: "Recovery & prehab", planned: 10, actual: 10 }] },
  history: { sessions: [{ id: "ses_1", at: "2026-10-05T10:00:00Z", minutes: 40, focus: "Depth", status: "done" }], attempts: [{ id: "att_1", at: "2026-10-05T10:20:00Z", kind: "perform", drillId: "depth-reps", engine: "movement" }] },
  proof: { title: "Ten reps in a row", ready: false, percent: 45, criteria: [{ id: "depth", label: "Deep enough", passed: false }, { id: "count", label: "Ten reps" }] }
};

export const summary: SummaryView = { sessionId: "ses_1", sk: "sk_test", skill: "Test skill", minutes: 38, changed: [{ nodeId: "depth", name: "Depth", before: 0.3, after: 0.45 }], oneFix: { headline: "Reps stop above parallel", mistakeId: "shallow", fixDrillTitle: "Five deep reps" }, praise: "Five reps found, steady tempo", next: { title: "Session 2: Depth", focus: "Hips back first, then down", when: "Thu" }, metric: { label: "Reps to depth", before: 1, after: 3, unit: " of 5" } };

export const proof: ProofResultView = { milestoneId: "ms_1", title: "Ten reps in a row", passed: true, criteria: [{ id: "depth", label: "Deep enough", passed: true, evidence: "9 of 10 reps to 95°" }, { id: "count", label: "Ten reps", passed: true, evidence: "10 reps found" }], attemptId: "att_9", precision: "full" };

// ------------------------------------------------------------------ the live coach (live-coach §7)

import type { CoachMessageView, PlanProposalView } from "@las/schema";
import type { LiveScreenModel } from "@las/ui";

export const coachMessage: CoachMessageView = { type: "message", screenId: "scr_msg", text: "Nice prediction. Watch the knee line on this one.", figure: { kind: "figure", points: { hip: [50, 40], knee: [60, 70], ankle: [50, 95] }, segments: [["hip", "knee"], ["knee", "ankle"]], marks: [{ at: "knee", label: "95°", role: "good" }] }, leaving: false, at: "2026-10-13T10:00:00Z" };
export const coachLeaving: CoachMessageView = { type: "message", screenId: "scr_bye", text: "I have to go. The next screens are ready for you.", leaving: true, at: "2026-10-13T10:20:00Z" };

export const planProposal: PlanProposalView = {
  type: "plan",
  screenId: "scr_plan",
  sk: "sk_test",
  question: "Depth is coming fast. Move the proof check a week earlier?",
  reason: "Three sessions in a row above target.",
  options: [
    { id: "earlier", label: "A week earlier", detail: "Proof check on Oct 27" },
    { id: "keep", label: "Keep Nov 3" },
    { id: "later", label: "Give me more time", detail: "Proof check on Nov 10" }
  ]
};

export const liveScreens: Record<"lesson" | "drill" | "feedback" | "plan" | "pause" | "wrapup", LiveScreenModel> = {
  lesson: { id: "scr_1", kind: "lesson", block: "learn", source: "coach", item: session.blocks[2].items[0] },
  drill: { id: "scr_2", kind: "drill", block: "practice", source: "fallback", item: session.blocks[3].items[0] },
  feedback: { id: "scr_3", kind: "feedback", block: "perform", source: "coach", item: { type: "feedback", view: feedback } },
  plan: { id: "scr_plan", kind: "plan", block: "wrapup", source: "coach", item: planProposal },
  pause: { id: "scr_p", kind: "pause", block: "practice", source: "fallback", item: { type: "pause", pausedAt: "2026-10-13T10:10:00Z" } },
  wrapup: { id: "scr_w", kind: "wrapup", block: "wrapup", source: "fallback", item: summary }
};
