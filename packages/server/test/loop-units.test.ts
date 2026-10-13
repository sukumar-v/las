import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SkillModelSchema, type SkillModel } from "@las/schema";
import { connect } from "./helpers.js";
import { minimalModel } from "../../schema/test/fixtures/minimal-model.js";
import { codeModel } from "./fixtures/code-model.js";
import { bktUpdate } from "../src/core/bkt.js";
import { gradeCard, newCard } from "../src/core/fsrs.js";
import { accessOptions, feasibility, focusMix, rankPictures, suggestMilestones, type MilestoneContext } from "../src/core/rules.js";
import { allocateMinutes, decide, type PlannerInput } from "../src/core/planner.js";
import { nextDifficulty } from "../src/core/sessions.js";
import { runCheckins } from "../src/core/checkins.js";
import { scheduleFor, weeksTo } from "../src/core/common.js";
import { setMilestone, startIntake } from "../src/core/intake.js";
import { validateAndStore } from "../src/core/skill-model.js";
import type { LasContext } from "../src/context.js";


const code = SkillModelSchema.parse(codeModel());
const physical = SkillModelSchema.parse(minimalModel());
const ctxFor = (model: SkillModel, over: Partial<MilestoneContext> = {}): MilestoneContext => ({ model, placement: 1, minutesPerWeek: 180, deadlineWeeks: null, why: [], ...over });

describe("BKT", () => {
  it("does the standard update with the node's parameters", () => {
    const p = { p_init: 0.1, p_learn: 0.2, p_slip: 0.1, p_guess: 0.15 };
    // posterior after a correct answer: 0.1·0.9 / (0.09 + 0.9·0.15) = 0.4; then learning: 0.4 + 0.6·0.2 = 0.52
    expect(bktUpdate(0.1, true, p)).toBeCloseTo(0.52, 6);
    // after a miss: 0.1·0.1 / (0.01 + 0.9·0.85) = 0.0129; then 0.0129 + 0.9871·0.2 = 0.2103
    expect(bktUpdate(0.1, false, p)).toBeCloseTo(0.21032, 4);
    let m = 0.1;
    for (let i = 0; i < 8; i++) m = bktUpdate(m, true, p);
    expect(m).toBeGreaterThan(0.95);
  });
});

describe("FSRS", () => {
  it("schedules a new card a day out and spaces good answers further than misses", () => {
    const now = new Date("2026-10-13T10:00:00Z");
    const c = newCard(now);
    expect(new Date(c.dueAt).getTime() - now.getTime()).toBe(864e5);
    const later = new Date(c.dueAt);
    const good = gradeCard(c.state, 3, later);
    const again = gradeCard(c.state, 1, later);
    const easy = gradeCard(c.state, 4, later);
    expect(new Date(good.dueAt).getTime()).toBeGreaterThan(new Date(again.dueAt).getTime());
    expect(new Date(easy.dueAt).getTime()).toBeGreaterThanOrEqual(new Date(good.dueAt).getTime());
    expect(good.state.reps).toBe(1);
    const second = gradeCard(good.state, 3, new Date(good.dueAt));
    expect(new Date(second.dueAt).getTime() - new Date(good.dueAt).getTime()).toBeGreaterThan(new Date(good.dueAt).getTime() - later.getTime());
  });
});

describe("onboarding rules (§5.3)", () => {
  it("computes the schedule and weeks from the ladder's mean hours", () => {
    expect(scheduleFor(60)).toEqual({ sessionsPerWeek: 2, minutesEach: 30, days: [1, 5] });
    expect(scheduleFor(150)).toEqual({ sessionsPerWeek: 3, minutesEach: 50, days: [0, 2, 5] });
    expect(scheduleFor(300).sessionsPerWeek).toBe(4);
    expect(scheduleFor(600)).toEqual({ sessionsPerWeek: 5, minutesEach: 60, days: [0, 1, 3, 4, 6] });
    expect(weeksTo(code, 1, 2, 180)).toBe(3);
    expect(weeksTo(code, 1, 4, 180)).toBe(12);
    expect(weeksTo(code, 2, 2, 180)).toBe(0);
  });

  it("labels feasibility with and without a deadline, offering a stepping stone", () => {
    expect(feasibility(ctxFor(code), 4).label).toBe("Realistic");
    const long = feasibility(ctxFor(code, { minutesPerWeek: 120 }), 4);
    expect(long.label).toBe("Long road");
    expect(long.stoneStep).toBe(3);
    expect(feasibility(ctxFor(code, { deadlineWeeks: 4 }), 2).label).toBe("Fits your deadline");
    const amb = feasibility(ctxFor(code, { deadlineWeeks: 4 }), 3);
    expect(amb.label).toBe("Ambitious");
    expect(amb.stoneStep).toBe(2);
    expect(feasibility(ctxFor(code), 1).label).toBe("You're already past this");
  });

  it("orders suggestions: the picture leads unless a deadline or an urgent why puts the quick win first", () => {
    const pic = code.pictures[0];
    const calm = suggestMilestones(ctxFor(code, { picture: pic, why: ["job"] }));
    expect(calm.map((s) => s.kind)).toEqual(["picture", "quick", "stretch"]);
    expect(calm[2].step).toBe(3);
    const urgent = suggestMilestones(ctxFor(code, { picture: pic, why: ["exam-prep"] }));
    expect(urgent[0].kind).toBe("quick");
    const own = suggestMilestones(ctxFor(code, { pictureText: "Automating my reports" }));
    expect(own.find((s) => s.kind === "picture")?.title).toBe('First step toward "Automating my reports"');
    expect(own.find((s) => s.kind === "picture")?.kindLabel).toBe("Toward automating my reports");
  });

  it("ranks pictures by why, keeping the model's order on ties, and adds the picture's equipment", () => {
    expect(rankPictures(code, ["exam-prep"]).map((r) => [r.picture.id, r.fit])).toEqual([["course", 1], ["scripts", 0]]);
    expect(rankPictures(code, []).map((r) => r.picture.id)).toEqual(["scripts", "course"]);
    expect(accessOptions(code, "course")).toEqual(["A computer", "Course book"]);
  });

  it("bends the practice mix for beginners and injuries, always to 100", () => {
    const m = focusMix(physical, physical.pictures[0], 1, ["Knees"]);
    expect(m.mix.reduce((t, x) => t + x.share, 0)).toBe(100);
    expect(m.mix.map((x) => x.category)).toEqual(["Technique", "Theory", "Recovery & prehab"]);
    expect(m.mix[0].share).toBe(55);
    expect(m.reasons).toHaveLength(2);
    const plain = focusMix(code, undefined, 3, []);
    expect(plain.mix).toEqual([{ category: "Reading", share: 40 }, { category: "Writing", share: 40 }, { category: "Typing", share: 20 }]);
    expect(plain.reasons).toEqual([]);
  });
});

function input(model: SkillModel, over: Partial<PlannerInput> = {}): PlannerInput {
  return {
    model,
    placement: 1,
    milestoneStep: 3,
    mastery: {},
    mistakes: [],
    dueReviews: [],
    mixPlanned: Object.entries(model.focus).map(([category, share]) => ({ category, share })),
    minutesByCategory: {},
    access: [...model.access],
    minutes: 40,
    short: false,
    injuries: [],
    difficultyOffset: 0,
    variation: false,
    now: new Date("2026-10-13T10:00:00Z"),
    ...over
  };
}

describe("session planner (learning loop §3)", () => {
  it("scores candidates with the weighted formula", () => {
    const d = decide(
      input(code, {
        mastery: { values: { p: 0.85, started: true }, functions: { p: 0.1, started: true }, typing: { p: 0.1, started: false } },
        mistakes: [{ id: "no-return", state: "coached", lastSeenAt: "2026-10-13T10:00:00Z" }],
        minutesByCategory: { Writing: 60 }
      })
    );
    const by = Object.fromEntries(d.candidates.map((c) => [c.nodeId, c]));
    // functions: 0.35·0.9 + 0.25·(2/3) + 0.2·0 (Writing is over plan) + 0.2·0.5 (an earlier step)
    expect(by.functions.score).toBeCloseTo(0.35 * 0.9 + 0.25 * (2 / 3) + 0.1, 2);
    // typing: 0.35·0.9 + 0 + 0.2·0.5 (half the biggest gap) + 0.2·1 (the milestone step needs it)
    expect(by.typing.score).toBeCloseTo(0.35 * 0.9 + 0.1 + 0.2, 2);
    expect(d.practice.map((p) => p.nodeId)).toEqual(["typing", "functions"]);
    expect(d.learn).toBe("typing");
    expect(d.blocks.find((b) => b.kind === "practice")!.reason.length).toBeGreaterThan(5);
  });

  it("decays a mistake's weight over 14 days", () => {
    const fresh = decide(input(code, { mistakes: [{ id: "no-return", state: "detected", lastSeenAt: "2026-10-13T10:00:00Z" }] }));
    const old = decide(input(code, { mistakes: [{ id: "no-return", state: "detected", lastSeenAt: "2026-09-20T10:00:00Z" }] }));
    expect(fresh.candidates.find((c) => c.nodeId === "functions")!.parts.mistake).toBeCloseTo(2 / 3, 3);
    expect(old.candidates.find((c) => c.nodeId === "functions")!.parts.mistake).toBe(0);
  });

  it("drops nodes over the intensity cap, without the equipment, or the last session's focus", () => {
    const capped = decide(input(physical, { milestoneStep: 2, intensityCap: 2, mastery: { setup: { p: 0.85, started: true } } }));
    expect(capped.dropped.map((x) => x.nodeId)).toContain("depth");
    expect(capped.dropped.find((x) => x.nodeId === "depth")!.reason).toMatch(/too intense/);
    const needy = SkillModelSchema.parse(codeModel({ drills: codeModel().drills!.map((d) => (d.id === "type-drill" ? { ...d, needs: ["Course book"] } : d)) }));
    const noBook = decide(input(needy, { mastery: { values: { p: 0.85, started: true } } }));
    expect(noBook.dropped.find((x) => x.nodeId === "typing")?.reason).toMatch(/needs Course book/);
    const withBook = decide(input(needy, { access: ["A computer", "Course book"], mastery: { values: { p: 0.85, started: true } } }));
    expect(withBook.dropped.map((x) => x.nodeId)).not.toContain("typing");
    const last = decide(input(code, { lastFocus: "typing", mastery: { values: { p: 0.85, started: true } } }));
    expect(last.dropped).toEqual([{ nodeId: "typing", reason: "Main focus of your last session" }]);
  });

  it("starts new material only once prerequisites reach 60%", () => {
    const blocked = decide(input(code, { placement: 0, milestoneStep: 2, mastery: { values: { p: 0.3, started: true } } }));
    expect(blocked.candidates.map((c) => c.nodeId)).toEqual(["values"]);
    const open = decide(input(code, { placement: 0, milestoneStep: 2, mastery: { values: { p: 0.65, started: true } } }));
    expect(open.candidates.map((c) => c.nodeId)).toContain("functions");
    expect(open.learn).toBe("functions");
  });

  it("turns Perform into a proof rehearsal once every milestone skill is at 80%", () => {
    const d = decide(input(code, { milestoneStep: 2, mastery: { values: { p: 0.9, started: true }, functions: { p: 0.82, started: true } } }));
    expect(d.rehearsalReady).toBe(true);
    expect(d.perform?.rehearsal).toBe(true);
  });

  it("gives warm-ups to physical skills only, and a short session is recall plus one drill", () => {
    expect(decide(input(physical, { milestoneStep: 2, mastery: { setup: { p: 0.85, started: true } } })).blocks[0].kind).toBe("warmup");
    expect(decide(input(code)).blocks.some((b) => b.kind === "warmup")).toBe(false);
    const short = decide(input(code, { short: true, dueReviews: ["c1", "c2"] }));
    expect(short.blocks.map((b) => [b.kind, b.minutes])).toEqual([["recall", 2], ["practice", 3]]);
    expect(short.practice).toHaveLength(1);
  });

  it("splits any session length over the blocks present", () => {
    const kinds = ["warmup", "recall", "learn", "practice", "perform", "wrapup"] as const;
    for (let m = 10; m <= 60; m++) {
      for (let n = 2; n <= kinds.length; n++) {
        const a = allocateMinutes([...kinds.slice(0, n - 1), "wrapup"], m);
        expect(Object.values(a).reduce((t, v) => t + v, 0)).toBe(m);
        expect(Math.min(...Object.values(a))).toBeGreaterThanOrEqual(1);
      }
    }
    const full = allocateMinutes([...kinds], 40);
    expect(full.practice / 40).toBeGreaterThanOrEqual(0.35);
    expect(full.practice / 40).toBeLessThanOrEqual(0.45);
  });

  it("moves in-session difficulty up after 3 successes and down after 2 misses", () => {
    let st = { succ: 0, miss: 0 };
    let lv = 1;
    for (const ok of [true, true]) ({ level: lv, run: st } = nextDifficulty(lv, 3, st, ok));
    const up = nextDifficulty(lv, 3, st, true);
    expect(up).toEqual({ level: 2, run: { succ: 0, miss: 0 }, changed: "up" });
    const m1 = nextDifficulty(2, 3, { succ: 0, miss: 0 }, false);
    expect(m1.level).toBe(2);
    expect(nextDifficulty(2, 3, m1.run, false)).toEqual({ level: 1, run: { succ: 0, miss: 0 }, changed: "down" });
    expect(nextDifficulty(2, 3, { succ: 2, miss: 0 }, true).changed).toBeUndefined();
  });
});

/** An enrollment straight from stored answers: the fast path for tests that start after onboarding. */
async function enroll(ctx: LasContext, modelInput: unknown, milestone: unknown = "quick") {
  const caps = await ctx.capabilities();
  const stored = validateAndStore(ctx, modelInput, caps).stored!;
  const r = await startIntake(ctx, stored.id);
  const model = ctx.store.getSkillModel(stored.id)!.model;
  ctx.store.updateIntake(r.intake.id, { answers: { look: "plain", why: [model.why[0].id], picture: model.pictures[0].id, fresh: true, placeConfirmed: true, minutes: 180, deadline: "none", aroundDone: true } });
  return setMilestone(ctx, r.intake.id, milestone);
}

describe("check-in limits (learning loop §7)", () => {
  let s: Awaited<ReturnType<typeof connect>>;
  let sk = "";
  beforeAll(async () => {
    s = await connect();
    s.ctx.store.updateLearner({ timezone: "UTC", quietHours: { start: 22, end: 8 }, nudgeLimits: { perDay: 1, perWeek: 4 } });
    sk = (await enroll(s.ctx, codeModel())).sk;
  }, 30000);
  afterAll(async () => s.close());

  const due = (n: number, at: Date) => {
    s.ctx.store.deletePendingCheckins(sk);
    for (let i = 0; i < n; i++) s.ctx.store.addCheckin({ enrollmentId: sk, kind: "plateau", dueAt: new Date(at.getTime() - 60e3).toISOString(), payload: { label: "Pass rate" } });
  };

  it("sends nothing in quiet hours, at most one a day, and pauses stop everything", async () => {
    const night = new Date("2030-03-04T23:30:00Z");
    due(3, night);
    const quiet = await runCheckins(s.ctx, night);
    expect(quiet.due.length).toBeGreaterThanOrEqual(3);
    expect(quiet.delivered).toEqual([]);
    const noon = new Date("2030-03-05T12:00:00Z");
    const sent: string[] = [];
    const r = await runCheckins(s.ctx, noon, { deliver: (c) => void sent.push(c.id) });
    expect(r.delivered).toHaveLength(1);
    expect(sent).toEqual(r.delivered);
    expect((await runCheckins(s.ctx, new Date(noon.getTime() + 3600e3))).delivered).toHaveLength(0);
    s.ctx.store.setEnrollmentStatus(sk, "paused");
    expect((await runCheckins(s.ctx, new Date(noon.getTime() + 2 * 864e5))).delivered).toHaveLength(0);
    s.ctx.store.setEnrollmentStatus(sk, "active");
  });

  it("sends at most the weekly limit", async () => {
    s.ctx.store.db.run("UPDATE checkin SET sent_at = NULL");
    s.ctx.store.updateLearner({ nudgeLimits: { perDay: 10, perWeek: 4 } });
    const day = new Date("2030-04-02T12:00:00Z");
    due(6, day);
    expect((await runCheckins(s.ctx, day)).delivered).toHaveLength(4);
    expect((await runCheckins(s.ctx, new Date(day.getTime() + 864e5))).delivered).toHaveLength(0);
  });
});

describe("teaching tools reject what doesn't fit", () => {
  let s: Awaited<ReturnType<typeof connect>>;
  beforeAll(async () => {
    s = await connect();
  }, 30000);
  afterAll(async () => s.close());

  it("lists every onboarding and loop tool (DESIGN §4)", async () => {
    const tools = (await s.client.listTools()).tools.map((t) => t.name);
    const all = ["start_intake", "record_answer", "place_learner", "suggest_milestones", "check_feasibility", "set_milestone", "get_today", "next_session", "reschedule", "replan", "render_lesson", "render_sim", "render_mechanism", "render_diagram", "explain_mistake", "start_drill", "review_cards", "request_capture", "get_analysis", "run_code_tests", "compare_to_reference", "run_proof_check", "get_progress", "get_session_summary", "log_external", "report_pain", "revisit_why", "export_data", "delete_data", "submit_rubric_grade"];
    for (const t of all) expect(tools).toContain(t);
  });

  it("render_lesson rejects a 26-word card and shows the offending card", async () => {
    const long = Array.from({ length: 26 }, (_, i) => `word${i}`).join(" ");
    const bad = await s.call("render_lesson", { title: "Too long", cards: [{ type: "predict", text: long, options: ["a", "b"], answer: 0 }] });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/cards\[0\]/);
    expect(bad.data.card.text).toBe(long);
    const okLesson = await s.call("render_lesson", { title: "Short", cards: [{ type: "predict", text: "Which is steadier?", options: ["Wide", "Narrow"], answer: 0 }] });
    expect(okLesson.isError).toBe(false);
    expect(okLesson.data.view).toBe("lesson");
  });

  it("render_sim rejects an unknown function and accepts a declarative sim", async () => {
    const sim = { title: "Lever", params: { d: { label: "Distance", min: 0, max: 10 } }, formulas: { load: "d * 2" }, figure: { kind: "gauge", value: "load", min: 0, max: 20 } };
    const bad = await s.call("render_sim", { sim: { ...sim, formulas: { load: "fetch(d)" } } });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/unknown function "fetch"/);
    const good = await s.call("render_sim", { sim });
    expect(good.isError, good.text).toBe(false);
    expect(good.data.view).toBe("sim");
  });

  it("render_diagram validates figures and render_mechanism caches supplied figures", async () => {
    expect((await s.call("render_diagram", { figure: { kind: "nope" } })).isError).toBe(true);
    const d = await s.call("render_diagram", { figure: { kind: "mermaid", source: "graph LR; a-->b" }, title: "Flow" });
    expect(d.data.view).toBe("diagram");
    const first = await s.call("render_mechanism", { concept: "String pitch" });
    expect(first.data.data.source).toBe("placeholder");
    await s.call("render_mechanism", { concept: "String pitch", figure: { kind: "graph", nodes: [{ id: "a", label: "Length" }, { id: "b", label: "Pitch" }], edges: [["a", "b"]] } });
    const again = await s.call("render_mechanism", { concept: "string  pitch" });
    expect(again.data.data.source).toBe("cache");
    expect(again.data.data.figure.kind).toBe("graph");
  });
});

describe("level checks: tap and 'completely new'", () => {
  let s: Awaited<ReturnType<typeof connect>>;
  beforeAll(async () => {
    s = await connect();
  }, 30000);
  afterAll(async () => s.close());

  it("accepts tap offsets and places from their mean", async () => {
    const model = minimalModel({ probes: [{ id: "beat", type: "tap", question: "Tap along with the click.", spec: "placement-quiz" }], placement: [{ when: "tap.meanAbsMs < 50", step: 2, evidence: "Steady taps" }] });
    const id = (await s.call("validate_skill_model", { model })).data.stored.id;
    const intakeId = (await s.call("start_intake", { skillModelId: id })).data.data.intakeId;
    await s.call("record_answer", { intakeId, field: "look", value: "plain" });
    await s.call("record_answer", { intakeId, field: "why", value: ["fun"] });
    const probe = await s.call("record_answer", { intakeId, field: "picture", value: "enjoy" });
    expect(probe.data.data.answerType).toBe("tap");
    expect(probe.data.data.cta.secondary).toBe("I'm completely new to this");
    const r = await s.call("record_answer", { intakeId, field: "beat", value: [20, -30, 40, -10] });
    expect(r.data.data.step).toBe("place");
    expect(r.data.data.answer.meanAbsMs).toBe(25);
    const p = await s.call("place_learner", { intakeId });
    expect(p.data.data.step).toBe(2);
    expect(p.data.data.evidence).toEqual(["Steady taps", "25 ms off the beat"]);
  });

  it("'I'm completely new to this' skips straight to placement at step 0", async () => {
    const id = (await s.call("validate_skill_model", { model: codeModel() })).data.stored.id;
    const intakeId = (await s.call("start_intake", { skillModelId: id })).data.data.intakeId;
    await s.call("record_answer", { intakeId, field: "look", value: "plain" });
    await s.call("record_answer", { intakeId, field: "why", value: ["exam-prep"] });
    const pic = await s.call("record_answer", { intakeId, field: "picture", value: { text: "Automating my reports" } });
    expect(pic.data.data.ribbon.find((r: any) => r.id === "picture").label).toBe("Automating my reports");
    const fresh = await s.call("record_answer", { intakeId, field: "fresh", value: true });
    expect(fresh.data.data.step).toBe("place");
    expect(fresh.data.data.payload.placement.step).toBe(0);
    expect(fresh.data.data.payload.placement.evidence).toEqual(["Starting fresh"]);
    expect(fresh.data.data.payload.placement.canLower).toBe(false);
  });
});

describe("code runs, rescheduling, outside practice and pain", () => {
  let s: Awaited<ReturnType<typeof connect>>;
  beforeAll(async () => {
    s = await connect();
    s.ctx.store.updateLearner({ timezone: "UTC" });
  }, 30000);
  afterAll(async () => s.close());

  it("run_code_tests asks before a runner's first use and remembers the consent", async () => {
    const { sk } = await enroll(s.ctx, codeModel());
    const spec = { kind: "test", language: "javascript", entry: "main.js", runner: ["local"], tests: [{ call: "add(1, 2)", expect: "3" }] };
    const files = { "main.js": "function add(a, b) { return a + b; }\nmodule.exports = { add };\n" };
    const caps = await s.ctx.capabilities();
    if (!caps.runners.local.some((l) => l.language === "javascript")) return;
    const ask = await s.call("run_code_tests", { spec, files, sk, drillId: "fn-build" });
    expect(ask.isError).toBe(true);
    expect(ask.data.needsConsent).toBe(true);
    expect(ask.text).toMatch(/consent: true/);
    const run = await s.call("run_code_tests", { spec, files, sk, drillId: "fn-build", consent: true });
    expect(s.ctx.store.getSetting("consent.runner.local", false)).toBe(true);
    if (!run.isError) {
      expect(run.data.data.runner).toBe("local");
      expect(run.data.data.analysis.engine).toBe("code");
      expect(s.ctx.store.getAttempt(run.data.data.attemptId)?.analysis).toBeTruthy();
    }
    const inBrowser = await s.call("run_code_tests", { spec: { ...spec, runner: ["browser"] }, files, sk });
    if (caps.runners.browser.includes("javascript")) {
      expect(inBrowser.isError, inBrowser.text).toBe(false);
      expect(inBrowser.data.studioLink).toMatch(/\/app\/capture\/att_/);
    }
  });

  it("counts an attempt once, even when its analysis is posted twice", async () => {
    const { sk } = await enroll(s.ctx, codeModel());
    const a = await s.call("request_capture", { sk, engine: "code", spec: "add-tests", drillId: "fn-build", prompt: "Write add()" });
    const { installLoop } = await import("../src/loop.js");
    const sink = installLoop(s.ctx);
    const analysis = { engine: "code", quality: { ok: true, issues: [] }, metrics: { pass_rate: { value: 1, unit: "", confidence: 1 } }, markers: [], mistakes: [], criteria: {}, keyFrames: [], version: "t", precision: "full" };
    await sink.onEvent({ type: "attempt.analyzed", attemptId: a.data.data.attemptId, analysis: analysis as any });
    const again = (await sink.onEvent({ type: "attempt.analyzed", attemptId: a.data.data.attemptId, analysis: analysis as any })) as any;
    expect(again.repeat).toBe(true);
    expect(s.ctx.store.metricHistory(sk, "passrate")).toHaveLength(1);
    expect(s.ctx.store.getMastery(sk).get("functions")!.attempts).toBe(1);
  });

  it("reschedule moves or skips a session; skipping plans the next one", async () => {
    const { sk, firstSession } = await enroll(s.ctx, codeModel());
    const moved = await s.call("reschedule", { sessionId: firstSession.sessionId, when: "tomorrow" });
    expect(moved.isError, moved.text).toBe(false);
    expect(new Date(moved.data.plannedAt).getTime()).toBeGreaterThan(Date.now() + 20 * 3600e3);
    const skipped = await s.call("reschedule", { sessionId: firstSession.sessionId, when: "skip" });
    expect(skipped.data.status).toBe("skipped");
    expect(skipped.data.next.sessionId).not.toBe(firstSession.sessionId);
    expect(s.ctx.store.listPlanChanges(sk).some((p) => p.option.startsWith("skip:"))).toBe(true);
    expect((await s.call("reschedule", { sessionId: firstSession.sessionId, when: "someday" })).isError).toBe(true);
  });

  it("log_external counts outside practice, and 'I did it outside the app' is self-reported", async () => {
    const { sk } = await enroll(s.ctx, codeModel());
    const r = await s.call("log_external", { sk, minutes: 25, note: "Practiced at work", category: "Writing" });
    expect(r.isError, r.text).toBe(false);
    expect(s.ctx.store.timeSince(sk, new Date(Date.now() - 60e3).toISOString()).byCategory.Writing).toBe(25);
    const done = await s.call("log_external", { sk, minutes: 0, note: "Did it at home", milestoneDone: true });
    expect(done.data.milestone.selfReported).toBe(true);
    const m = s.ctx.store.listMilestones(sk)[0];
    expect(m.status).toBe("done");
    expect(m.selfReported).toBe(true);
    expect((await s.call("get_today", { sk })).data.data.state).toBe("milestone-done");
  });

  it("report_pain lowers intensity for a week, follows up, and points to a professional", async () => {
    const { sk } = await enroll(s.ctx, minimalModel(), { step: 2 });
    s.ctx.store.setMastery(sk, "setup", 0.85, 3, true);
    const before = (await s.call("next_session", { sk, minutes: 40 })).data.data;
    const drills = (p: any) => p.blocks.flatMap((b: any) => b.items).filter((i: any) => i.type === "drill" || i.type === "capture").map((i: any) => i.drill?.id ?? i.drillId);
    expect(drills(before)).toContain("depth-reps");
    const pain = await s.call("report_pain", { sk, area: "Knees", level: 3 });
    expect(pain.isError, pain.text).toBe(false);
    expect(pain.text).toMatch(/see a professional/);
    expect(pain.data.cap).toBe(2);
    expect(pain.data.rule).toBe("Reduce depth and skip loaded reps for two weeks");
    const after = (await s.call("next_session", { sk, minutes: 40 })).data.data;
    expect(drills(after)).not.toContain("depth-reps");
    expect(after.blocks[0].kind).toBe("warmup");
    const follow = s.ctx.store.listCheckins(sk, { pending: true }).find((c) => c.kind === "pain-followup")!;
    expect(new Date(follow.dueAt).getTime()).toBeGreaterThan(Date.now() + 1.5 * 864e5);
  });
});
