import { describe, expect, it } from "vitest";
import type { IntakeView } from "@las/schema";
import { adaptIntake, ladderRoute, submission, toggle } from "../src/intake.js";
import { withFixLoop, stepIndexOf } from "../src/screens/session.js";
import { sessionSteps } from "@las/ui";

const base = { intakeId: "i", stepIndex: 2, sections: [] as string[], sectionIndex: 2, ribbon: [], question: "q", cta: { label: "Pick one or two", enabled: false } };

describe("onboarding glue", () => {
  it("keeps multi picks on the device until Continue", () => {
    const v = { ...base, step: "why", answerType: "multi", value: [], max: 2 } as IntakeView;
    expect(adaptIntake(v).cta.enabled).toBe(false);
    const a = adaptIntake(v, { why: ["fun"] });
    expect(a.value).toEqual(["fun"]);
    expect(a.cta).toEqual({ label: "Continue", enabled: true });
    expect(submission(v, { why: ["fun"] })).toEqual({ field: "why", value: ["fun"] });
    expect(toggle(["a", "b"], "c", 2)).toEqual(["b", "c"]);
    expect(toggle(["a"], "a")).toEqual([]);
  });
  it("maps the server's time and around payloads to the screen's", () => {
    const time = adaptIntake({ ...base, step: "time", answerType: "slider", value: { minutes: 120, deadline: "4w" }, payload: { schedule: { sessionsPerWeek: 3, minutesEach: 40, days: [0, 2, 4] } } } as IntakeView, { minutes: 240 });
    expect(time.payload).toMatchObject({ minutes: 240, deadline: "4w" });
    expect(submission({ ...base, step: "time", answerType: "slider", value: { minutes: 120, deadline: "4w" } } as IntakeView, { deadline: "3m" })).toEqual({ field: "time", value: { minutes: 120, deadline: "3m" } });
    const around = adaptIntake({ ...base, step: "around", answerType: "multi", value: { access: [], injuries: [] }, payload: { access: ["A mat"], injuries: [{ value: "Knees", label: "Knees" }] } } as IntakeView, { access: ["A mat"] });
    expect(around.payload).toMatchObject({ accessOptions: ["A mat"], injuryOptions: ["Knees"], access: ["A mat"], injuries: [] });
  });
  it("marks the picked milestone and draws the ladder from the placement", () => {
    const sugs = [{ kind: "quick", step: 1, title: "A" }, { kind: "stretch", step: 3, title: "B" }];
    const v = adaptIntake({ ...base, step: "milestone", answerType: "single", payload: { suggestions: sugs, ladder: [{ step: 0, label: "Zero", done: true }, { step: 1, label: "One" }, { step: 3, label: "Three" }] } } as IntakeView, { milestone: "stretch:3" });
    expect(v.payload?.picked).toBe(1);
    expect(v.cta).toEqual({ label: "Build my plan", enabled: true });
    expect(ladderRoute([{ step: 0, label: "Zero", done: true }, { step: 1, label: "One" }])!.steps.map((s) => s.state)).toEqual(["here", "ahead"]);
  });
  it("marks the first level check so the screen offers 'completely new'", () => {
    const v = adaptIntake({ ...base, step: "probe", answerType: "single", payload: { index: 0 } } as IntakeView);
    expect(v.payload?.first).toBe(true);
  });
});

describe("closing the loop in a session", () => {
  it("puts the fix drill and a second attempt right after the attempt", () => {
    const capture = { type: "capture", attemptSpecId: "att_1", engine: "movement", specId: "s", prompt: "p", kind: "perform" } as const;
    const plan = { sessionId: "s", sk: "e", skill: "x", title: "t", minutes: 10, focus: { nodeId: "n", name: "n", reason: "" }, status: "active", blocks: [{ kind: "perform", minutes: 5, reason: "", title: "Perform", items: [capture] }, { kind: "wrapup", minutes: 1, reason: "", title: "Wrap-up", items: [{ type: "wrapup" }] }] } as any;
    const fix = { type: "drill", drill: { id: "fix", type: "choice" }, difficulty: 0, label: "" } as any;
    const again = { ...capture, attemptSpecId: "att_2" };
    const p = withFixLoop(plan, { blockIndex: 0, itemIndex: 0 }, fix, again);
    expect(p.blocks[0].items.map((i: any) => i.attemptSpecId ?? i.drill?.id)).toEqual(["att_1", "fix", "att_2"]);
    const steps = sessionSteps(p);
    expect(stepIndexOf(steps, { blockIndex: 0, itemIndex: 0, phase: "feedback" })).toBe(2);
    expect(steps[3]).toEqual({ blockIndex: 0, itemIndex: 1 });
    expect(plan.blocks[0].items).toHaveLength(1);
  });
});
