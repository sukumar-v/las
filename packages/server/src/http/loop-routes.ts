/**
 * The studio's JSON API for onboarding and the learning loop. Same core functions as the MCP tools, so a
 * screen looks and behaves the same in a widget and in the studio. Events go through POST /api/events.
 */
import { AnalysisSchema, type IntakeStep } from "@las/schema";
import type { LasContext } from "../context.js";
import type { Handler, Req, Res, Router } from "./router.js";
import { LoopError, loadSk } from "../core/common.js";
import { checkFeasibility, intakeView, milestoneSuggestions, placeLearner, recordAnswer, setMilestone, getIntake } from "../core/intake.js";
import { getProgress, getToday, sessionSummary } from "../core/progress.js";
import { planSession, sessionPlanOf } from "../core/planner.js";
import { analyzeEvidence, attemptOrFail, consentKey, getAnalysis, readEvidence, runCodeTests } from "../core/evaluate.js";
import { processAnalysis } from "../core/sessions.js";
import { reviewCards, startDrill } from "../core/practice.js";
import { checkinView, runCheckins } from "../core/checkins.js";
import { loadEngines } from "../core/engines.js";
import { activeTheme } from "../core/theme.js";
import { milestoneProof } from "../core/proof.js";

function h(fn: (req: Req, res: Res) => Promise<unknown> | unknown): Handler {
  return async (req, res) => {
    try {
      const out = await fn(req, res);
      if (out !== undefined) res.json(out);
    } catch (e) {
      if (e instanceof LoopError) res.json({ ok: false, error: e.message, data: e.data ?? null }, 400);
      else res.json({ ok: false, error: (e as Error).message }, 500);
    }
  };
}

const need = (v: string | null | undefined, name: string): string => {
  if (!v) throw new LoopError(`Missing ${name}.`);
  return v;
};

export function mountLoopRoutes(router: Router, ctx: LasContext): void {
  router.get(
    "/api/state",
    h(() => {
      const learner = ctx.store.getOrCreateLearner();
      const enrollments = ctx.store.listEnrollments(learner.id).map((e) => {
        const m = ctx.store.getSkillModel(e.skillModelId)?.model;
        const ms = ctx.store.activeMilestone(e.id);
        return { sk: e.id, skill: m?.name ?? e.skillModelId, status: e.status, milestone: ms ? { id: ms.id, title: ms.title, targetDate: ms.targetDate } : null, themeId: activeTheme(ctx, e.id).id };
      });
      return { learner: { id: learner.id, name: learner.name, timezone: learner.timezone, quietHours: learner.quietHours, nudgeLimits: learner.nudgeLimits }, enrollments, themeId: activeTheme(ctx).id };
    })
  );

  // onboarding
  router.get(
    "/api/intake/:id",
    h(async (req) => intakeView(ctx, getIntake(ctx, req.params.id), (req.query.get("step") as IntakeStep | null) ?? undefined))
  );
  router.post(
    "/api/intake/:id/answer",
    h(async (req) => {
      const b = await req.json();
      const r = await recordAnswer(ctx, req.params.id, need(b.field, "field"), b.value);
      return { view: r.view, answer: r.feedback ?? null };
    })
  );
  router.post(
    "/api/intake/:id/place",
    h((req) => placeLearner(ctx, req.params.id))
  );
  router.post(
    "/api/intake/:id/suggest",
    h((req) => ({ suggestions: milestoneSuggestions(ctx, req.params.id) }))
  );
  router.post(
    "/api/intake/:id/feasibility",
    h(async (req) => checkFeasibility(ctx, req.params.id, (await req.json()).milestone))
  );
  router.post(
    "/api/intake/:id/milestone",
    h(async (req) => setMilestone(ctx, req.params.id, (await req.json()).milestone))
  );

  // Today and sessions
  router.get(
    "/api/today",
    h((req) => getToday(ctx, need(req.query.get("sk"), "sk")))
  );
  router.post(
    "/api/session/next",
    h(async (req) => {
      const b = await req.json();
      return planSession(ctx, loadSk(ctx, need(b.sk, "sk")).enrollment.id, { minutes: b.minutes, location: b.location, short: b.short });
    })
  );
  router.get(
    "/api/session/:id",
    h((req) => sessionPlanOf(ctx, req.params.id))
  );

  // attempts and feedback
  router.get(
    "/api/attempt/:id",
    h(async (req) => {
      const a = attemptOrFail(ctx, req.params.id);
      const e = ctx.store.getEnrollment(a.enrollmentId);
      const intake = e ? undefined : ctx.store.getIntake(a.enrollmentId);
      const model = ctx.store.getSkillModel(e?.skillModelId ?? intake?.skillModelId ?? "")?.model;
      const spec = a.specId && model ? model.specs[a.specId] : undefined;
      const drill = model?.drills.find((d) => d.id === a.drillId);
      const m = a.milestoneId ? ctx.store.getMilestone(a.milestoneId) : undefined;
      const checklist = m && e ? (milestoneProof(loadSk(ctx, e.id), m)?.criteria ?? []).map((c) => ({ id: c.id, label: c.label })) : undefined;
      let rubricPrompt: string | undefined;
      if (spec?.kind === "rubric") rubricPrompt = await loadEngines().then((x) => x.rubricPrompt(spec), () => undefined);
      return { attempt: a, spec, capture: drill?.capture ?? (a.spec as { capture?: unknown } | undefined)?.capture ?? null, prompt: a.prompt, how: (a.spec as { how?: string } | undefined)?.how, singleTake: a.kind === "proof", checklist, rubricPrompt, phone: ctx.devices.phone, hasEvidence: !!readEvidence(ctx, a.id) };
    })
  );
  router.post(
    "/api/attempt/:id/evidence",
    h(async (req) => {
      const r = await analyzeEvidence(ctx, req.params.id, await req.json());
      ctx.emit("attempt.analyzed", { attemptId: req.params.id });
      return r;
    })
  );
  router.post(
    "/api/attempt/:id/analysis",
    h(async (req) => {
      const b = await req.json();
      const parsed = AnalysisSchema.safeParse(b.analysis ?? b);
      if (!parsed.success) throw new LoopError(`Not an analysis: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      const r = processAnalysis(ctx, req.params.id, parsed.data);
      ctx.emit("attempt.analyzed", { attemptId: req.params.id });
      return r;
    })
  );
  router.get(
    "/api/attempt/:id/feedback",
    h((req) => getAnalysis(ctx, req.params.id))
  );

  // practice
  router.post(
    "/api/drill/:id/next",
    h(async (req) => {
      const b = await req.json();
      return startDrill(ctx, req.params.id, { sk: b.sk, sessionId: b.sessionId, difficulty: b.difficulty, answer: b.answer, history: b.history });
    })
  );
  router.get(
    "/api/reviews",
    h((req) => reviewCards(ctx, need(req.query.get("sk"), "sk"), Number(req.query.get("n") ?? 10)))
  );
  router.post(
    "/api/code/run",
    h(async (req) => {
      const b = await req.json();
      return runCodeTests(ctx, { spec: b.spec, files: b.files ?? {}, sk: b.sk, drillId: b.drillId, sessionId: b.sessionId, specId: b.specId, consent: b.consent });
    })
  );
  router.post(
    "/api/consent",
    h(async (req) => {
      const b = await req.json();
      if (!["browser", "local", "container"].includes(b.runner)) throw new LoopError("runner is browser, local or container.");
      ctx.store.setSetting(consentKey(b.runner), !!b.granted);
      return { ok: true, runner: b.runner, granted: !!b.granted };
    })
  );

  // progress and check-ins
  router.get(
    "/api/progress",
    h((req) => getProgress(ctx, need(req.query.get("sk"), "sk")))
  );
  router.get(
    "/api/summary/:sessionId",
    h((req) => sessionSummary(ctx, req.params.sessionId))
  );
  router.post(
    "/api/checkins/run",
    h(() => runCheckins(ctx))
  );
  router.get(
    "/api/checkins",
    h((req) => {
      const st = loadSk(ctx, need(req.query.get("sk"), "sk"));
      const now = new Date().toISOString();
      return { checkins: ctx.store.listCheckins(st.enrollment.id, { pending: true }).map((c) => ({ ...checkinView(ctx, c, st), due: c.dueAt <= now, sent: !!c.sentAt })) };
    })
  );
}
