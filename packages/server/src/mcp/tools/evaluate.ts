import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FeedbackView } from "@las/schema";
import type { LasContext } from "../../context.js";
import { compareToReference, getAnalysis, requestCapture, runCodeTests, startProofCheck, submitRubricGrade } from "../../core/evaluate.js";
import { ok } from "../result.js";
import { view } from "../widgets.js";
import { guard } from "./onboard.js";

export function feedbackText(f: FeedbackView): string {
  if (f.reRecord) return `Record again: ${f.reRecord}`;
  return [`${f.headline}${f.evidence.label ? ` (${f.evidence.label})` : ""}.`, f.praise ? `Done well: ${f.praise.headline}.` : "", f.fixDrillTitle ? `Try this: ${f.fixDrillTitle}.` : "", f.compare?.metric && f.compare.before !== undefined ? `${f.compare.metric}: ${f.compare.before} → ${f.compare.after}${f.compare.unit ? ` ${f.compare.unit}` : ""}.` : "", f.precision !== "full" ? `This check is ${f.precision === "reduced" ? "less precise" : "self-reported"}.` : ""].filter(Boolean).join(" ");
}

export function registerEvaluateTools(server: McpServer, ctx: LasContext): void {
  server.registerTool(
    "request_capture",
    {
      title: "Ask for a recording or submission",
      description: "Creates an attempt and returns where to record it: the capture widget or a studio link (opens on the phone when paired). For rubric (visual) specs it also returns the grading prompt.",
      inputSchema: {
        sk: z.string(),
        engine: z.string(),
        spec: z.string().describe("Spec id in the skill model"),
        prompt: z.string().max(200),
        drillId: z.string().optional(),
        milestoneId: z.string().optional(),
        how: z.string().max(200).optional(),
        kind: z.enum(["drill", "perform", "proof", "probe", "rehearsal"]).optional(),
        attempt: z.number().int().min(1).optional(),
        singleTake: z.boolean().optional()
      }
    },
    guard(async (spec) => {
      const r = await requestCapture(ctx, spec);
      return view(ctx, { view: "capture", title: spec.prompt, data: { attemptId: r.attempt.id, attempt: r.attempt, how: r.how, phone: r.phone, rubricPrompt: r.rubricPrompt }, text: `Attempt ${r.attempt.id}: ${spec.prompt}.${r.phone ? " It opens on the paired phone." : ""}${r.rubricPrompt ? `\nGrade with submit_rubric_grade using:\n${r.rubricPrompt}` : ""}`, studioPath: r.studioPath, sk: r.attempt.enrollmentId });
    })
  );

  server.registerTool(
    "get_analysis",
    {
      title: "The analysis of an attempt",
      description: "The engine's Analysis plus the one-fix feedback card (top mistake with evidence, one thing done well, fix drill, why) or a re-record request. Grade only from this, and quote its evidence.",
      inputSchema: { attemptId: z.string() }
    },
    guard(async ({ attemptId }) => {
      const r = getAnalysis(ctx, attemptId);
      if (!r.analysis) return view(ctx, { view: "capture", title: "Waiting for the recording", data: { attemptId, attempt: r.attempt, analyzed: false }, text: `Attempt ${attemptId} hasn't been analyzed yet.`, studioPath: `/app/capture/${attemptId}`, sk: r.attempt.enrollmentId });
      const proofText = r.proof ? `\nProof: ${r.proof.passed ? "passed" : "not yet"}: ${r.proof.criteria.map((c) => `${c.label} ${c.passed ? "✓" : "✗"}`).join(", ")}` : "";
      return view(ctx, { view: r.proof ? "proof" : "feedback", title: r.feedback!.headline, data: { analysis: r.analysis, feedback: r.feedback, proof: r.proof }, text: feedbackText(r.feedback!) + proofText, studioPath: `/app/feedback/${attemptId}`, sk: r.attempt.enrollmentId });
    })
  );

  server.registerTool(
    "run_code_tests",
    {
      title: "Run code against tests",
      description: "Runs the files against a test spec with the best available runner (browser sandbox in the studio, a local toolchain, or a container). Asks before a runner's first use: when the result says consent is needed, ask the learner and call again with consent: true. Pass sk to store it as an attempt and get feedback.",
      inputSchema: { spec: z.record(z.string(), z.unknown()), files: z.record(z.string(), z.string()), sk: z.string().optional(), drillId: z.string().optional(), sessionId: z.string().optional(), specId: z.string().optional(), consent: z.boolean().optional() }
    },
    guard(async (input) => {
      const r = await runCodeTests(ctx, input);
      if (r.runner === "browser") return view(ctx, { view: "capture", title: "Run it in the studio", data: r as unknown as Record<string, unknown>, text: r.message, studioPath: r.studioPath });
      const f = (r as { feedback?: FeedbackView }).feedback;
      const tests = (r.result as { tests?: { pass: boolean }[] } | undefined)?.tests ?? [];
      return view(ctx, { view: "feedback", title: f?.headline ?? "Test results", data: r as unknown as Record<string, unknown>, text: `${tests.filter((t) => t.pass).length} of ${tests.length} tests pass (${r.runner} runner).${f ? ` ${feedbackText(f)}` : ""}`, studioPath: (r as { attemptId?: string }).attemptId ? `/app/feedback/${(r as { attemptId?: string }).attemptId}` : undefined });
    })
  );

  server.registerTool(
    "compare_to_reference",
    {
      title: "Compare with a reference",
      description: "Similarity to a reference over time: for movement, the engine lines up body points with the reference clip's; otherwise metric by metric against a reference attempt's analysis. reference: the reference attempt's id.",
      inputSchema: { attemptId: z.string(), reference: z.string() }
    },
    guard(async ({ attemptId, reference }) => {
      const r = await compareToReference(ctx, attemptId, reference);
      const text = r.method === "metrics" ? `Similarity ${r.similarity ?? "n/a"}: ${r.metrics.map((m) => `${m.metric} ${m.you} vs ${m.reference}`).join(", ")}` : "Compared with the reference clip.";
      return ok(text, r as unknown as Record<string, unknown>);
    })
  );

  server.registerTool(
    "run_proof_check",
    {
      title: "Take the proof check",
      description: "Checks readiness (every milestone skill at 80%, 2 recent passing attempts). If not ready it says what's missing; pass proceed: true to take it anyway. Then one continuous take in the app; the result per criterion comes with get_analysis once it's analyzed.",
      inputSchema: { milestoneId: z.string().describe("Milestone id, or sk for the active milestone"), proceed: z.boolean().optional() }
    },
    guard(async ({ milestoneId, proceed }) => {
      const r = startProofCheck(ctx, milestoneId, !!proceed);
      return view(ctx, { view: "proof", title: "Proof check", data: r as unknown as Record<string, unknown>, text: `${r.message}\nChecklist: ${r.checklist.map((c) => c.label).join("; ")}${r.attempt ? `\nAttempt ${r.attempt.id}.` : ""}`, studioPath: r.studioPath ?? `/app/proof/${r.milestoneId}`, sk: r.attempt?.enrollmentId ?? null });
    })
  );

  server.registerTool(
    "submit_rubric_grade",
    {
      title: "Grade work against its rubric",
      description: "For visual (rubric) attempts: your grades per criterion with confidence and the image region you looked at. The engine combines them with the measurements, stores the analysis and returns feedback.",
      inputSchema: {
        attemptId: z.string(),
        grades: z.array(z.object({ criterion: z.string(), level: z.number(), confidence: z.number().min(0).max(1), region: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional(), note: z.string().max(200).optional() })).min(1)
      }
    },
    guard(async ({ attemptId, grades }) => {
      const r = await submitRubricGrade(ctx, attemptId, grades);
      return view(ctx, { view: "feedback", title: r.feedback?.headline ?? "Graded", data: r as unknown as Record<string, unknown>, text: r.feedback ? feedbackText(r.feedback) : "Stored.", studioPath: `/app/feedback/${attemptId}` });
    })
  );
}
