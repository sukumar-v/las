import type { SkillModelInput } from "@las/schema";

/**
 * End-to-end test data: five small skill models, one per engine, with generic content. They exist to prove
 * that the studio's screens and flows work the same for every kind of evidence. Not packs, not product content.
 */
export interface EngineParts {
  skill: string;
  name: string;
  noun: string;
  physical: boolean;
  engine: SkillModelInput["engines"][number];
  /** the performance drill (move, play-along, say-it, build, make) and its spec */
  perform: { id: string; type: string; title: string; prompt?: string; spec: string; capture?: Record<string, unknown> };
  specs: Record<string, unknown>;
  /** the one mistake the fixture evidence shows; its id matches the engine's or the spec's mistake id */
  mistake: { id: string; name: string; metric: string; when: string; headline: string };
  key_metric: { id: string; label: string; metric: string; unit: string; better: "higher" | "lower"; format: string };
  proof: { label: string; criteria: { id: string; label: string; check: string }[] };
  extra?: Partial<SkillModelInput>;
}

export function buildModel(p: EngineParts): SkillModelInput {
  const model: SkillModelInput = {
    skill: p.skill,
    name: p.name,
    noun: p.noun,
    physical: p.physical,
    engines: [p.engine, "knowledge", "self-report"],
    why: [
      { id: "fun", label: "For fun" },
      { id: "work", label: "For work" },
      { id: "prove", label: "Prove it to myself" }
    ],
    pictures: [
      { id: "weekly", label: "Doing it every week", why: ["fun"], ladderStep: 1, milestone: "One clean attempt", proof: p.proof.label, focus: { Technique: 70, Theory: 30 } },
      { id: "show", label: "Showing someone", why: ["prove", "work"], ladderStep: 2, milestone: "Three clean attempts", proof: "Three clean attempts in a row", focus: { Technique: 60, Theory: 40 } }
    ],
    probes: [{ id: "level", type: "single", question: "How much have you done?", options: [{ value: 0, label: "Never" }, { value: 1, label: "A few times" }, { value: 2, label: "Every week" }] }],
    placement: [{ when: "level >= 2", step: 1 }],
    ladder: [
      { id: "start", label: "Brand new", hours: [0, 0] },
      { id: "first", label: "First clean attempt", hours: [2, 4], nodes: ["basics"], proof: { engine: p.engine, spec: p.perform.spec, label: p.proof.label, criteria: p.proof.criteria } },
      { id: "three", label: "Three clean attempts", hours: [4, 8], nodes: ["steady"], proof: { engine: "self-report", label: "Log three clean attempts", criteria: [{ id: "n", label: "Three attempts", check: "count >= 3" }] } },
      { id: "show", label: "Show someone", hours: [8, 14], nodes: ["show"], proof: { engine: "self-report", label: "Show it to someone", criteria: [{ id: "shown", label: "Shown", check: "done" }] } }
    ],
    nodes: [
      { id: "basics", name: "Basics", requires: [], lesson: "basics-lesson", drills: ["basics-quiz", p.perform.id, "basics-fix"], mistakes: [p.mistake.id], review: { prompt: "Which comes first?", kind: "choice", options: ["Setup", "Speed"], answer: 0 } },
      { id: "steady", name: "Steadiness", requires: ["basics"], lesson: "basics-lesson", drills: ["basics-quiz"], review: { prompt: "What makes it steady?", kind: "choice", options: ["Practice", "Luck"], answer: 0 } },
      { id: "show", name: "Showing it", requires: ["steady"], lesson: "basics-lesson", drills: ["basics-quiz"], review: { prompt: "Who do you show?", kind: "choice", options: ["Someone kind", "Nobody"], answer: 0 } }
    ],
    lessons: [
      {
        id: "basics-lesson",
        title: "Basics",
        nodes: ["basics"],
        cards: [
          { type: "predict", text: "Which helps more at the start?", options: ["Slow and clean", "Fast and messy"], answer: 0 },
          {
            type: "sim",
            text: "Drag the pace. Watch the error rate.",
            sim: { kind: "sim", title: "Pace and errors", params: { pace: { label: "Pace", min: 1, max: 10, default: 4, unit: "" } }, formulas: { errors: "clamp(pace * pace, 0, 100)" }, figure: { kind: "plot", x: "pace", series: ["errors"] }, readout: [{ value: "errors", label: "Errors", unit: "%", decimals: 0 }] }
          }
        ]
      }
    ],
    drills: [
      { id: "basics-quiz", type: "choice", title: "Quick check", nodes: ["basics"], spec: "basics-items", minutes: 2 },
      { id: "basics-fix", type: "choice", title: "Fix it", nodes: ["basics"], spec: "fix-items", minutes: 2, fixes: [p.mistake.id] },
      { ...(p.perform as any), nodes: ["basics"], minutes: 5, intensity: 1, fixes: [p.mistake.id] }
    ],
    specs: {
      "basics-items": {
        kind: "items",
        items: [
          { type: "choice", id: "q1", prompt: "What do you do first?", options: ["Set up", "Rush"], answer: 0 },
          { type: "choice", id: "q2", prompt: "When do you speed up?", options: ["When it's clean", "Right away"], answer: 0, difficulty: 2 }
        ]
      },
      "fix-items": { kind: "items", items: [{ type: "choice", id: "f1", prompt: "What fixes it?", options: ["Slow down", "Skip it"], answer: 0 }] },
      ...p.specs
    },
    mistakes: [{ id: p.mistake.id, name: p.mistake.name, nodes: ["basics"], engine: p.engine, detector: { metric: p.mistake.metric, when: p.mistake.when }, severity: 2, explain: { lesson: "basics-lesson", card: 0 }, fix_drill: "basics-fix", headline: p.mistake.headline }],
    access: ["A quiet room"],
    focus: { Technique: 70, Theory: 30 },
    key_metrics: [{ ...p.key_metric, engine: p.engine } as any],
    ...(p.extra ?? {})
  } as SkillModelInput;
  return model;
}
