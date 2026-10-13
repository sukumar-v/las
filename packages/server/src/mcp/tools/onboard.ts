import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { IntakeView } from "@las/schema";
import type { LasContext } from "../../context.js";
import { LoopError } from "../../core/common.js";
import { checkFeasibility, intakeView, milestoneSuggestions, placeLearner, recordAnswer, setMilestone, startIntake } from "../../core/intake.js";
import { fail } from "../result.js";
import { view } from "../widgets.js";

/** Turns a learner-facing LoopError into an isError result; anything else is reported plainly too. */
export function guard<A>(fn: (args: A) => Promise<CallToolResult> | CallToolResult): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      if (e instanceof LoopError) return fail(e.message, e.data);
      return fail(`Something went wrong: ${(e as Error).message}`);
    }
  };
}

/** Text for clients without widgets (and for the model): the question and its options, ranked. */
export function intakeText(v: IntakeView): string {
  const lines = [`[${v.step}] ${v.question}${v.sub ? ` (${v.sub})` : ""}`];
  if (v.options?.length) lines.push(...v.options.map((o) => `- ${String(o.value)}: ${o.label}${o.badge ? ` [${o.badge}]` : ""}${o.detail ? ` (${o.detail})` : ""}`));
  const item = v.payload?.item as { id?: string; prompt?: string; options?: string[] } | undefined;
  if (item) lines.push(`Question ${item.id}: ${item.prompt}${item.options ? ` Options: ${item.options.map((o, i) => `${i}=${o}`).join(", ")}` : ""}`);
  if (v.field) lines.push(`Answer with record_answer field "${v.field}".${v.cta.secondary ? ` Secondary: ${v.cta.secondary}.` : ""}`);
  return lines.join("\n");
}

export function registerOnboardTools(server: McpServer, ctx: LasContext): void {
  const screen = (v: IntakeView, extra: Record<string, unknown> = {}, text?: string) =>
    view(ctx, { view: "onboarding", title: v.question, data: { ...v, next: v.step, ...extra }, text: text ?? intakeText(v), studioPath: `/app/onboarding/${v.intakeId}`, sk: v.sk ?? null });

  server.registerTool(
    "start_intake",
    {
      title: "Start onboarding",
      description: "Starts onboarding for a validated skill model: look (optional), why, six-month picture, level checks, placement, time, things to plan around, milestone, plan. Returns the first screen and the why options. Then call record_answer for each screen.",
      inputSchema: { skillModelId: z.string().describe("The id validate_skill_model returned (or the skill name)") }
    },
    guard(async ({ skillModelId }) => {
      const r = await startIntake(ctx, skillModelId);
      return screen(r.view, { intakeId: r.intake.id, whyOptions: r.whyOptions });
    })
  );

  server.registerTool(
    "record_answer",
    {
      title: "Record an onboarding answer",
      description:
        "Records one answer and returns the next screen with its options already ranked for this learner. Fields: look ('plain' | 'chat'), why (up to 2 ids), picture (an id, or {text}), a probe id (single: value; multi: [values]; quiz: {itemId, answer}; tap: [offsets ms]; record/code: {attemptId} or {analysis}; null skips), fresh (true = completely new), place ('ok' | 'too-easy' | 'too-hard'), time ({minutes, deadline: none|4w|3m|6m}), around ({access: [], injuries: []}), milestone ('quick:2', a ladder step number, or {custom: 'own words'}). Re-answering an earlier field invalidates later answers that depend on it.",
      inputSchema: { intakeId: z.string(), field: z.string(), value: z.unknown().optional() }
    },
    guard(async ({ intakeId, field, value }) => {
      const r = await recordAnswer(ctx, intakeId, field, value);
      const fb = r.feedback?.correct !== undefined ? `${r.feedback.correct ? "Right." : "Not quite."} ` : "";
      return screen(r.view, { answer: r.feedback, options: r.view.options }, fb + intakeText(r.view));
    })
  );

  server.registerTool(
    "place_learner",
    {
      title: "Where the learner starts",
      description: "Runs the skill model's placement rules over the answers (first match wins), with the learner's 'too easy' / 'too hard' moves. Returns {step, evidence} and the placement screen.",
      inputSchema: { intakeId: z.string() }
    },
    guard(async ({ intakeId }) => {
      const r = placeLearner(ctx, intakeId);
      const ladder = ctx.store.getSkillModel(ctx.store.getIntake(intakeId)!.skillModelId)!.model.ladder;
      return view(ctx, {
        view: "onboarding",
        title: "Here's where you start",
        data: { intakeId, step: r.placement.step, evidence: r.placement.evidence, raw: r.placement.raw, adjusted: r.placement.adjusted, placement: r.view },
        text: `Start at step ${r.placement.step}: "${ladder[r.placement.step].label}". Evidence: ${r.placement.evidence.join("; ") || "none"}. The learner can move it with record_answer field "place" ('too-easy' / 'too-hard'), then 'ok'.`,
        studioPath: `/app/onboarding/${intakeId}`
      });
    })
  );

  server.registerTool(
    "suggest_milestones",
    {
      title: "Suggest first milestones",
      description: "Quick win (next step), toward your picture (the picture's own milestone), stretch (furthest step in about 6 weeks). A deadline or an urgent why puts the quick win first. Each has weeks and feasibility.",
      inputSchema: { intakeId: z.string() }
    },
    guard(async ({ intakeId }) => {
      const s = milestoneSuggestions(ctx, intakeId);
      const v = await intakeView(ctx, intakeId, "milestone");
      return screen(v, { suggestions: s }, s.map((x) => `- ${x.kind}:${x.step} [${x.kindLabel}] ${x.title}: ${x.proof} (~${x.weeks} wk, ${x.feasibility.label})`).join("\n"));
    })
  );

  server.registerTool(
    "check_feasibility",
    {
      title: "Is this milestone realistic?",
      description: "Weeks to a milestone at the learner's pace and a verdict (Fits your deadline / Ambitious / Realistic / Long road), with a closer stepping stone when it's far.",
      inputSchema: { intakeId: z.string(), milestone: z.unknown().describe("A suggestion like 'picture:3', a ladder step number, or {step, title}") }
    },
    guard(async ({ intakeId, milestone }) => {
      const r = checkFeasibility(ctx, intakeId, milestone);
      const v = await intakeView(ctx, intakeId, "milestone");
      return screen(v, { ...r, feasibility: r }, `${r.verdict}: about ${r.weeks} weeks to "${r.milestone.title}".${r.message ? ` ${r.message}` : ""}${r.steppingStone ? ` Stepping stone: "${r.steppingStone.title}" (${r.steppingStone.value}).` : ""}`);
    })
  );

  server.registerTool(
    "set_milestone",
    {
      title: "Set the first milestone and build the plan",
      description: "Creates the learner's enrollment (sk) with intent, constraints, the milestone and its target date, starting mastery, review cards, the first session and the check-in schedule. Returns {sk, route, firstSession} and the plan screen.",
      inputSchema: { intakeId: z.string(), milestone: z.unknown().optional().describe("Optional if already answered with record_answer field milestone") }
    },
    guard(async ({ intakeId, milestone }) => {
      const r = await setMilestone(ctx, intakeId, milestone);
      const p = r.plan;
      const text = [
        `Milestone: ${p.milestone.title} (${p.milestone.proof}), about ${p.milestone.weeks} weeks, target ${p.milestone.targetDate}, ${p.milestone.feasibility}.`,
        `Practice mix: ${p.mix.map((x) => `${x.category} ${x.share}%`).join(", ")}${p.mixReasons.length ? ` (adjusted for: ${p.mixReasons.join("; ")})` : ""}.`,
        ...p.checkins,
        `First session: ${r.firstSession.title}, ${r.firstSession.minutes} min (${r.firstSession.sessionId}). sk = ${r.sk}.`
      ].join("\n");
      return view(ctx, { view: "onboarding", title: p.milestone.title, data: { ...r.view, sk: r.sk, milestoneId: r.milestoneId, route: r.route, firstSession: r.firstSession, plan: p }, text, studioPath: `/app/today/${r.sk}`, sk: r.sk });
    })
  );
}
