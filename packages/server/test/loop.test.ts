import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { AnalysisSchema, SkillModelSchema, type IntakeView, type SessionPlan, type SkillModelInput, type StudioEvent } from "@las/schema";
import { connect } from "./helpers.js";
import { minimalModel } from "../../schema/test/fixtures/minimal-model.js";
import { codeModel } from "./fixtures/code-model.js";
import { installLoop } from "../src/loop.js";
import { runCheckins } from "../src/core/checkins.js";
import { velocity } from "../src/core/replan.js";
import { loadSk, pathNodes } from "../src/core/common.js";


/** The physical test model with a third, optional recorded check: single + quiz + record. */
function physicalModel(): SkillModelInput {
  const base = minimalModel();
  return minimalModel({ probes: [...base.probes!, { id: "clip", type: "record", question: "Film five reps from the side.", spec: "rep-metrics", optional: true }] });
}

const an = (engine: string, over: Record<string, unknown> = {}) => AnalysisSchema.parse({ engine, quality: { ok: true, issues: [] }, metrics: {}, version: "test", ...over });

const cases = [
  { name: "a physical skill (movement + knowledge + self-report)", model: physicalModel },
  { name: "a desk skill (code + knowledge + interaction)", model: () => codeModel() }
];

describe.each(cases)("the whole loop for $name", ({ model: makeModel }) => {
  let s: Awaited<ReturnType<typeof connect>>;
  let sink: ReturnType<typeof installLoop>;
  const model = SkillModelSchema.parse(makeModel());
  const top = model.ladder.length - 1;
  let modelId = "";
  let intakeId = "";
  let view: IntakeView;
  let sk = "";
  let session: SessionPlan;
  const post = (e: StudioEvent) => sink.onEvent(e) as Promise<any>;
  const answer = async (field: string, value: unknown) => {
    const r = await s.call("record_answer", { intakeId, field, value });
    expect(r.isError, r.text).toBe(false);
    view = r.data.data as IntakeView;
    return r;
  };

  beforeAll(async () => {
    s = await connect();
    s.ctx.store.updateLearner({ timezone: "UTC" });
    sink = installLoop(s.ctx);
  }, 30000);
  afterAll(async () => {
    vi.useRealTimers();
    await s.close();
  });

  it("validates the model and starts onboarding with the look screen", async () => {
    const v = await s.call("validate_skill_model", { model: makeModel() });
    expect(v.isError, v.text).toBe(false);
    modelId = v.data.stored.id;
    const r = await s.call("start_intake", { skillModelId: modelId });
    expect(r.isError, r.text).toBe(false);
    expect(r.data.view).toBe("onboarding");
    expect(r.meta?.ui?.resourceUri).toBe("ui://las/view.html");
    intakeId = r.data.data.intakeId;
    expect(r.data.data.whyOptions.map((o: any) => o.value)).toEqual(model.why.map((w) => w.id));
    expect(r.data.data.step).toBe("look");
    expect(r.data.data.options.map((o: any) => o.label)).toEqual(["Keep it plain", "Describe it in the chat"]);
    await answer("look", "plain");
    expect(view.step).toBe("why");
    expect(view.question).toContain(model.noun);
    expect(view.max).toBe(2);
  });

  it("re-ranks pictures by why, and re-answering an earlier step updates what follows", async () => {
    await answer("why", [model.pictures[1].why[0]]);
    expect(view.step).toBe("picture");
    expect(view.options![0].value).toBe(model.pictures[1].id);
    expect(view.options![0].badge).toBe("Fits your why");
    expect(view.ribbon.map((r) => r.id)).toContain("why");
    await answer("why", [model.pictures[0].why[0]]);
    expect(view.options![0].value).toBe(model.pictures[0].id);
    const bad = await s.call("record_answer", { intakeId, field: "why", value: ["a", "b", "c"] });
    expect(bad.isError).toBe(true);
    await answer("picture", model.pictures[0].id);
    expect(view.step).toBe("probe");
    expect(view.cta.secondary).toBe("I'm completely new to this");
  });

  it("serves every level check through the standard answer types", async () => {
    let guard = 0;
    while (view.step === "probe" && guard++ < 20) {
      const p = model.probes.find((x) => x.id === view.field)!;
      expect(view.answerType).toBe(p.type);
      if (p.type === "single" || p.type === "scale") await answer(p.id, p.options![1].value);
      else if (p.type === "multi" || p.type === "visual-multi") await answer(p.id, [p.options![0].value]);
      else if (p.type === "quiz") {
        const item = view.payload!.item as { id: string; answer?: unknown };
        expect(item.answer).toBeUndefined();
        const spec = model.specs[p.spec!] as any;
        const key = spec.items.find((it: any) => it.id === item.id).answer;
        const r = await answer(p.id, { itemId: item.id, answer: key });
        expect(r.data.data.answer.correct).toBe(true);
      } else if (p.type === "record" || p.type === "code") {
        expect(view.payload!.attemptId).toMatch(/^att_/);
        await answer(p.id, { analysis: an(p.type === "code" ? "code" : "movement", { metrics: { pass_rate: { value: 1 } }, criteria: { pass: true } }) });
      }
    }
    expect(view.step).toBe("place");
  });

  it("places the learner and moves one step at a time on too easy / too hard", async () => {
    const p = await s.call("place_learner", { intakeId });
    expect(p.data.data.step).toBe(1);
    expect(p.data.data.evidence.length).toBeGreaterThan(0);
    await answer("place", "too-easy");
    expect((view.payload!.placement as any).step).toBe(2);
    expect((view.payload!.placement as any).evidence.join(" ")).toMatch(/moved it up/);
    await answer("place", "too-easy");
    await answer("place", "too-easy");
    expect((view.payload!.placement as any).step).toBe(Math.min(top - 1, 4));
    expect((view.payload!.placement as any).canRaise).toBe(false);
    for (let i = 0; i < 4; i++) await answer("place", "too-hard");
    expect((view.payload!.placement as any).step).toBe(0);
    expect((view.payload!.placement as any).evidence.join(" ")).toMatch(/moved it down/);
    await answer("place", "too-easy");
    expect((view.payload!.placement as any).step).toBe(1);
    await answer("place", "ok");
    expect(view.step).toBe("time");
    expect(view.ribbon.find((r) => r.id === "place")?.label).toBe(`Start: ${model.ladder[1].label}`);
  });

  it("orders suggestions by deadline and why, and judges feasibility", async () => {
    await answer("time", { minutes: 180, deadline: "none" });
    expect(view.step).toBe("around");
    expect(view.options!.map((o) => o.value)).toEqual([...model.access, ...(model.pictures[0].access ?? []).filter((a) => !model.access.includes(a))]);
    const injuries = Object.keys(model.injuries ?? {});
    expect((view.payload!.injuries as any[]).map((o) => o.value)).toEqual(injuries);
    await answer("around", { access: [model.access[0]], injuries: injuries.slice(0, 1) });
    expect(view.step).toBe("milestone");
    let sug = (await s.call("suggest_milestones", { intakeId })).data.data.suggestions;
    expect(sug[0].kind).toBe("picture");
    expect(sug.map((x: any) => x.kind)).toEqual(expect.arrayContaining(["quick", "picture", "stretch"]));
    // a deadline puts the quick win first
    await answer("time", { minutes: 180, deadline: "4w" });
    expect(view.step).toBe("milestone");
    sug = (await s.call("suggest_milestones", { intakeId })).data.data.suggestions;
    expect(sug[0].kind).toBe("quick");
    expect(sug[0].kindLabel).toBe("Before your deadline");
    const quick = await s.call("check_feasibility", { intakeId, milestone: "quick" });
    expect(quick.data.data.verdict).toBe("Fits your deadline");
    const far = await s.call("check_feasibility", { intakeId, milestone: top });
    expect(far.data.data.verdict).toBe("Ambitious");
    expect(far.data.data.steppingStone.step).toBeGreaterThan(1);
    expect(view.cta.enabled).toBe(false);
  });

  it("set_milestone builds the enrollment, mastery, reviews, the first session and check-ins", async () => {
    const r = await s.call("set_milestone", { intakeId, milestone: "quick" });
    expect(r.isError, r.text).toBe(false);
    sk = r.data.data.sk;
    expect(sk).toMatch(/^sk_/);
    expect(r.data.data.step).toBe("plan");
    const plan = r.data.data.plan;
    expect(plan.milestone.title).toBe(model.ladder[2].label);
    expect(plan.mix.reduce((t: number, x: any) => t + x.share, 0)).toBe(100);
    expect(plan.mixReasons.join(" ")).toMatch(/New to this/);
    if (model.injuries) {
      expect(plan.mix.map((x: any) => x.category)).toContain("Recovery & prehab");
      expect(plan.injuryRules[0].rule).toBe(Object.values(model.injuries)[0]);
    }
    expect(plan.schedule).toEqual({ sessionsPerWeek: 4, minutesEach: 45, days: [0, 1, 3, 5] });
    expect(r.data.data.firstSession.blocks.length).toBeGreaterThan(1);
    const mastery = s.ctx.store.getMastery(sk);
    expect(mastery.size).toBe(model.nodes.length);
    const known = model.ladder[1].nodes;
    for (const n of known) expect(mastery.get(n)?.pKnown).toBe(0.85);
    const cards = s.ctx.store.listReviewCards(sk);
    expect(cards.map((c) => c.nodeId)).toEqual(expect.arrayContaining(known));
    expect(new Date(cards[0].dueAt).getTime()).toBeGreaterThan(Date.now() + 20 * 3600e3);
    const kinds = s.ctx.store.listCheckins(sk, { pending: true }).map((c) => c.kind);
    expect(kinds).toEqual(expect.arrayContaining(["weekly-review", "gone-quiet"]));
    expect(s.ctx.store.activeMilestone(sk)?.targetDate).toBeTruthy();
    const again = await s.call("record_answer", { intakeId, field: "why", value: [model.why[0].id] });
    expect(again.isError).toBe(true);
  });

  it("Today starts on the first day", async () => {
    const t = await s.call("get_today", { sk });
    expect(t.isError, t.text).toBe(false);
    expect(t.data.view).toBe("today");
    expect(t.data.data.state).toBe("first-day");
    expect(t.data.data.nextSession.title).toMatch(/^Session 1: /);
    expect(t.data.data.week).toHaveLength(7);
    expect(t.data.data.milestone.title).toBe(model.ladder[2].label);
  });

  it("plans sessions whose blocks fill the time, each with a reason, and logs the decision", async () => {
    const r = await s.call("next_session", { sk, minutes: 40 });
    expect(r.isError, r.text).toBe(false);
    session = r.data.data;
    expect(r.data.view).toBe("session");
    expect(session.blocks.reduce((t, b) => t + b.minutes, 0)).toBe(session.minutes);
    expect(session.minutes).toBe(40);
    for (const b of session.blocks) expect(b.reason.length).toBeGreaterThan(5);
    expect(session.blocks.some((b) => b.kind === "warmup")).toBe(model.physical);
    expect(session.blocks.map((b) => b.kind)).toEqual(expect.arrayContaining(["learn", "practice", "wrapup"]));
    const learn = session.blocks.find((b) => b.kind === "learn")!.items[0] as any;
    expect(learn.type).toBe("lesson");
    const log = s.ctx.store.db.get("SELECT json FROM planner_log WHERE session_id = ? ORDER BY id DESC", session.sessionId);
    const entry = JSON.parse(log!.json);
    expect(entry.candidates.length).toBeGreaterThan(0);
    expect(entry.weights).toEqual({ mastery: 0.35, mistake: 0.25, mix: 0.2, relevance: 0.2 });
    const short = (await s.call("next_session", { sk, minutes: 5 })).data.data as SessionPlan;
    expect(short.short).toBe(true);
    expect(short.blocks.reduce((t, b) => t + b.minutes, 0)).toBe(5);
    expect(short.blocks.every((b) => ["warmup", "recall", "practice"].includes(b.kind))).toBe(true);
    session = (await s.call("next_session", { sk, minutes: 40 })).data.data;
    expect(short.sessionId).toBe(session.sessionId);
  });

  it("drill outcomes update mastery and difficulty within the session", async () => {
    await post({ type: "session.started", sessionId: session.sessionId });
    const drill = model.drills.find((d) => d.difficulty && d.difficulty.levels.length > 1)!;
    const before = s.ctx.store.getMastery(sk).get(drill.nodes[0])!.pKnown;
    const out = (success: boolean) => post({ type: "drill.outcome", sessionId: session.sessionId, outcome: { drillId: drill.id, nodes: drill.nodes, success, score: success ? 1 : 0, metrics: {}, mistakes: [], difficulty: 0 } });
    await out(true);
    await out(true);
    const third = await out(true);
    expect(third.difficulty).toBe(1);
    expect(third.changed).toBe("up");
    await out(false);
    const down = await out(false);
    expect(down.difficulty).toBe(0);
    expect(down.changed).toBe("down");
    expect(s.ctx.store.getMastery(sk).get(drill.nodes[0])!.pKnown).toBeGreaterThan(before);
  });

  it("completes the session, logs the time by category and summarizes it", async () => {
    await post({ type: "block.completed", sessionId: session.sessionId, block: "practice", durationS: 600 });
    const done = await post({ type: "session.completed", sessionId: session.sessionId, minutes: 38 });
    expect(done.next.sessionId).not.toBe(session.sessionId);
    const sum = await s.call("get_session_summary", { sessionId: session.sessionId });
    expect(sum.isError, sum.text).toBe(false);
    expect(sum.data.data.minutes).toBe(38);
    expect(sum.data.data.changed.length).toBeGreaterThan(0);
    expect(sum.data.data.next.title).toMatch(/^Session 2: /);
    const logged = s.ctx.store.timeSince(sk, new Date(Date.now() - 3600e3).toISOString());
    expect(Math.round(logged.minutes)).toBe(38);
    expect(Object.keys(logged.byCategory).length).toBeGreaterThan(0);
    const t = (await s.call("get_today", { sk })).data.data;
    expect(t.state).toBe("normal");
    expect(t.checkin.kind).toBe("session-feel");
    const r = await post({ type: "checkin.answered", checkinId: t.checkin.id, option: t.checkin.options[0].id });
    expect(r.ok).toBe(true);
    const progress = await s.call("get_progress", { sk });
    expect(progress.data.view).toBe("progress");
    expect(progress.data.data.time.actualMinutes).toBe(38);
  });

  it("check-ins: a missed session, the weekly review, nudge limits and pause", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 6 * 864e5));
    const t = (await s.call("get_today", { sk })).data.data;
    expect(t.state).toBe("missed");
    expect(t.checkin.kind).toBe("missed-session");
    expect(t.checkin.options.map((o: any) => o.id)).toEqual(["move", "quick", "skip", "pause"]);
    expect(t.week.some((d: any) => d.state === "missed") || t.state === "missed").toBe(true);
    const learner = s.ctx.store.updateLearner({ quietHours: { start: 23, end: 0 } });
    expect(learner.quietHours.start).toBe(23);
    const now = new Date();
    now.setUTCHours(12);
    const first = await runCheckins(s.ctx, now);
    expect(first.due.map((c) => c.kind)).toContain("missed-session");
    expect(first.delivered.length).toBe(1);
    const second = await runCheckins(s.ctx, new Date(now.getTime() + 60e3));
    expect(second.delivered.length).toBe(0);
    const weekly = s.ctx.store.listCheckins(sk, { pending: true }).find((c) => c.kind === "weekly-review")!;
    const atReview = new Date(Math.max(new Date(weekly.dueAt).getTime() + 3600e3, now.getTime() + 60e3));
    const third = await runCheckins(s.ctx, atReview);
    expect(third.due.map((c) => c.kind)).toContain("weekly-review");
    const paused = await post({ type: "checkin.answered", checkinId: t.checkin.id, option: "pause" });
    expect(paused.action).toBe("replan");
    expect((await s.call("get_today", { sk })).data.data.state).toBe("paused");
    expect((await runCheckins(s.ctx, atReview)).delivered).toHaveLength(0);
    const resumed = await s.call("replan", { sk, option: "resume" });
    expect(resumed.isError, resumed.text).toBe(false);
    vi.useRealTimers();
    expect(s.ctx.store.listPlanChanges(sk).map((p) => p.option)).toEqual(expect.arrayContaining(["pause", "resume"]));
  });

  it("analyses drive mistake states, the one-fix feedback, disputes and resolution", async () => {
    const mk = model.mistakes[0];
    const drill = model.drills.find((d) => d.id === mk.fix_drill)!;
    const km = model.key_metrics[0];
    const capture = async () => {
      const r = await s.call("request_capture", { sk, engine: mk.engine, spec: drill.spec!, drillId: drill.id, prompt: drill.title, kind: "perform" });
      expect(r.isError, r.text).toBe(false);
      expect(r.data.studioLink).toContain(`/app/capture/${r.data.data.attemptId}`);
      return r.data.data.attemptId as string;
    };
    const withMistake = (value: number) => an(mk.engine, { metrics: { [km.metric]: { value, confidence: 0.9, per: [1, 0, 0, 1] } }, mistakes: [{ id: mk.id, severity: 2, confidence: 0.9, at: [1], evidence: { kind: "time", t: 1.2 } }], praise: { metric: km.metric, label: "Steady pace" } });
    const clean = () => an(mk.engine, { metrics: { [km.metric]: { value: 1, confidence: 0.95 } } });

    const a1 = await capture();
    await post({ type: "attempt.analyzed", attemptId: a1, analysis: withMistake(0.4) });
    expect(s.ctx.store.getMistakeStates(sk).get(mk.id)?.state).toBe("detected");
    expect(s.ctx.store.metricHistory(sk, km.id).map((h) => h.value)).toEqual([0.4]);
    const f1 = await s.call("get_analysis", { attemptId: a1 });
    expect(f1.data.view).toBe("feedback");
    const fb = f1.data.data.feedback;
    expect(fb.mistakeId).toBe(mk.id);
    expect(fb.headline).toBe(mk.headline);
    expect(fb.fixDrillId).toBe(mk.fix_drill);
    expect(fb.praise.headline).toBe("Steady pace");
    expect(fb.evidence.figure.kind).toBe("chart");
    expect(fb.why).toBeTruthy();
    expect(s.ctx.store.getMistakeStates(sk).get(mk.id)?.state).toBe("coached");
    const ex = await s.call("explain_mistake", { mistakeId: mk.id, attemptId: a1 });
    expect(ex.data.view).toBe("mistake");
    expect(ex.data.data.learner.attemptId).toBe(a1);

    const a2 = await capture();
    await post({ type: "attempt.analyzed", attemptId: a2, analysis: withMistake(0.5) });
    const f2 = (await s.call("get_analysis", { attemptId: a2 })).data.data.feedback;
    expect(f2.compare.before).toBe(0.4);
    expect(f2.compare.after).toBe(0.5);
    await post({ type: "attempt.disputed", attemptId: a2, mistakeId: mk.id, consentToTune: true });
    const muted = (await s.call("get_analysis", { attemptId: a2 })).data.data.feedback;
    expect(muted.mistakeId).toBeUndefined();
    expect(s.ctx.store.listDisputes(sk)).toHaveLength(1);
    expect(s.ctx.store.listDisputes(sk)[0].consent).toBe(true);

    // a bad recording asks for a better one instead of guessing
    const a3 = await capture();
    await post({ type: "attempt.analyzed", attemptId: a3, analysis: an(mk.engine, { quality: { ok: false, issues: ["out of frame"], reRecord: "Step back so I can see all of you." } }) });
    const rr = (await s.call("get_analysis", { attemptId: a3 })).data.data.feedback;
    expect(rr.reRecord).toBe("Step back so I can see all of you.");
    expect(rr.mistakeId).toBeUndefined();

    for (let i = 0; i < mk.resolved_after; i++) {
      const a = await capture();
      await post({ type: "attempt.analyzed", attemptId: a, analysis: clean() });
      expect(s.ctx.store.getMistakeStates(sk).get(mk.id)?.state).toBe(i + 1 >= mk.resolved_after ? "resolved" : "improving");
    }
    // it comes back: resurfaced
    const back = await capture();
    await post({ type: "attempt.analyzed", attemptId: back, analysis: withMistake(0.6) });
    expect(s.ctx.store.getMistakeStates(sk).get(mk.id)?.state).toBe("resurfaced");
    const progress = (await s.call("get_progress", { sk })).data.data;
    expect(progress.keyMetrics[0].history.length).toBeGreaterThan(2);
    expect(progress.beforeAfter.first.value).toBe(0.4);
    expect(progress.beforeAfter.latest.value).toBe(0.6);
  });

  it("re-plans when behind or ahead, only on the learner's choice", async () => {
    const st = loadSk(s.ctx, sk);
    const m = st.milestone!;
    const db = s.ctx.store.db;
    db.run("UPDATE milestone SET created_at = ?, target_date = ? WHERE id = ?", new Date(Date.now() - 21 * 864e5).toISOString(), new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10), m.id);
    for (const n of pathNodes(model, st.placement, m.ladderStep)) s.ctx.store.setMastery(sk, n, 0.12, 1, true);
    expect(velocity(s.ctx, loadSk(s.ctx, sk)).status).toBe("behind");
    const later = await s.call("replan", { sk, option: "later-date" });
    expect(later.isError, later.text).toBe(false);
    expect(s.ctx.store.activeMilestone(sk)!.targetDate! > m.targetDate!).toBe(true);
    db.run("UPDATE milestone SET created_at = ?, target_date = ? WHERE id = ?", new Date(Date.now() - 8 * 864e5).toISOString(), new Date(Date.now() + 70 * 864e5).toISOString().slice(0, 10), m.id);
    for (const n of pathNodes(model, st.placement, m.ladderStep)) s.ctx.store.setMastery(sk, n, 0.75, 4, true);
    expect(velocity(s.ctx, loadSk(s.ctx, sk)).status).toBe("ahead");
    const stretch = await s.call("replan", { sk, option: "stretch" });
    expect(stretch.isError, stretch.text).toBe(false);
    expect(s.ctx.store.activeMilestone(sk)!.ladderStep).toBe(m.ladderStep + 1);
    const bad = await s.call("replan", { sk, option: "nonsense" });
    expect(bad.isError).toBe(true);
  });

  it("proof readiness and a passing proof check complete the milestone", async () => {
    const st = loadSk(s.ctx, sk);
    const m = st.milestone!;
    const proof = model.ladder[m.ladderStep].proof!;
    const notYet = await s.call("run_proof_check", { milestoneId: m.id });
    expect(notYet.data.data.ready).toBe(false);
    expect(notYet.data.data.attempt).toBeUndefined();
    for (const n of pathNodes(model, st.placement, m.ladderStep)) s.ctx.store.setMastery(sk, n, 0.86, 6, true);
    const pass = an(proof.engine, { criteria: Object.fromEntries(proof.criteria.map((c) => [c.id, true])) });
    if (proof.engine !== "self-report") {
      for (let i = 0; i < 2; i++) {
        const r = await s.call("request_capture", { sk, engine: proof.engine, spec: proof.spec!, prompt: "Rehearsal", kind: "rehearsal", milestoneId: m.id });
        await post({ type: "attempt.analyzed", attemptId: r.data.data.attemptId, analysis: pass });
      }
    }
    expect((await s.call("get_today", { sk })).data.data.state).toBe("proof-ready");
    const go = await s.call("run_proof_check", { milestoneId: m.id });
    expect(go.isError, go.text).toBe(false);
    expect(go.data.data.ready).toBe(true);
    const attemptId = go.data.data.attempt.id;
    const res = await post({ type: "attempt.analyzed", attemptId, analysis: pass });
    expect(res.proof.passed).toBe(true);
    const g = await s.call("get_analysis", { attemptId });
    expect(g.data.view).toBe("proof");
    expect(g.data.data.proof.criteria.every((c: any) => c.passed)).toBe(true);
    expect(s.ctx.store.getMilestone(m.id)!.status).toBe("done");
    const t = (await s.call("get_today", { sk })).data.data;
    expect(t.state).toBe("milestone-done");
    expect(t.checkin.kind).toBe("revisit-why");
  });

  it("asks why again and sets the next milestone on the same skill", async () => {
    const r = await s.call("revisit_why", { sk });
    expect(r.isError, r.text).toBe(false);
    intakeId = r.data.data.intakeId;
    expect(r.data.data.step).toBe("why");
    await answer("why", [model.why[1].id]);
    expect(s.ctx.store.getIntent(sk)?.revisitedAt).toBeTruthy();
    expect(s.ctx.store.getIntent(sk)?.why).toEqual([model.why[1].id]);
    await answer("picture", model.pictures[1].id);
    expect(view.step).toBe("milestone");
    const before = s.ctx.store.listMilestones(sk).length;
    const set = await s.call("set_milestone", { intakeId, milestone: "quick" });
    expect(set.isError, set.text).toBe(false);
    expect(set.data.data.sk).toBe(sk);
    expect(s.ctx.store.listMilestones(sk).length).toBe(before + 1);
    expect((await s.call("get_today", { sk })).data.data.state).not.toBe("milestone-done");
  });

  it("exports and deletes the learner's data, media included", async () => {
    const ex = await s.call("export_data", { scope: sk });
    expect(ex.isError, ex.text).toBe(false);
    expect(existsSync(ex.data.file)).toBe(true);
    const dump = JSON.parse(readFileSync(ex.data.file, "utf8"));
    expect(dump.tables.session.length).toBeGreaterThan(0);
    expect(dump.tables.planner_log.length).toBeGreaterThan(0);
    const no = await s.call("delete_data", { scope: sk });
    expect(no.isError).toBe(true);
    const yes = await s.call("delete_data", { scope: sk, confirm: true });
    expect(yes.isError, yes.text).toBe(false);
    expect(s.ctx.store.resolveEnrollment(sk)).toBeUndefined();
    expect(s.ctx.store.db.get("SELECT COUNT(*) AS n FROM attempt WHERE enrollment_id = ?", sk)!.n).toBe(0);
  });
});
