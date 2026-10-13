/**
 * Evaluation (evaluation §1, §6, §7; mcp-and-data §2 Evaluate). Engines turn evidence into an Analysis;
 * the agent only ever grades from that analysis. Raw media stays on the device: the server stores derived
 * evidence (pose points, pitch tracks, test results) next to the attempt, never uploaded video.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AttemptSpecSchema, checkTestSpec, TestSpecSchema, type Analysis, type EngineSpec, type FeedbackView, type ProofResultView, type RubricSpec } from "@las/schema";
import type { AttemptRow } from "@las/store";
import type { LasContext } from "../context.js";
import { loadSk, LoopError, mean, type SkState } from "./common.js";
import { loadEngines, loadRunners } from "./engines.js";
import { buildFeedback } from "./feedback.js";
import { milestoneProof, readiness, type Readiness } from "./proof.js";
import { processAnalysis } from "./sessions.js";

export function attemptOrFail(ctx: LasContext, attemptId: string): AttemptRow {
  const a = ctx.store.getAttempt(attemptId);
  if (!a) throw new LoopError(`Unknown attempt "${attemptId}".`);
  return a;
}

const evidencePath = (ctx: LasContext, attemptId: string) => join(ctx.config.mediaDir, attemptId, "evidence.json");

export function saveEvidence(ctx: LasContext, attemptId: string, evidence: unknown): string {
  const file = evidencePath(ctx, attemptId);
  mkdirSync(join(ctx.config.mediaDir, attemptId), { recursive: true });
  writeFileSync(file, JSON.stringify(evidence));
  return file;
}

export function readEvidence(ctx: LasContext, attemptId: string): any | undefined {
  const file = evidencePath(ctx, attemptId);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
}

/** JSON can't carry typed arrays; engines expect them for audio samples and image pixels. */
function reviveEvidence(e: any): any {
  if (!e || typeof e !== "object") return e;
  const out = { ...e };
  if (Array.isArray(out.samples) && typeof out.samples[0] === "number") out.samples = Float32Array.from(out.samples);
  if (out.pixels && Array.isArray(out.pixels.data)) out.pixels = { ...out.pixels, data: Uint8ClampedArray.from(out.pixels.data) };
  return out;
}

/** The engine spec an attempt is measured with (a probe's, a drill's, or the milestone proof's) and the proof criteria to check. */
export function attemptSpec(ctx: LasContext, st: SkState, a: AttemptRow): { spec: EngineSpec; specId: string; criteria?: Record<string, string> } {
  const specId = a.specId ?? st.model.drills.find((d) => d.id === a.drillId)?.spec;
  const spec = specId ? st.model.specs[specId] : undefined;
  if (!spec || !specId) throw new LoopError(`Attempt ${a.id} has no engine spec to analyze with.`);
  const m = a.milestoneId ? ctx.store.getMilestone(a.milestoneId) : undefined;
  const criteria = m ? Object.fromEntries((milestoneProof(st, m)?.criteria ?? []).map((c) => [c.id, c.check])) : undefined;
  return { spec, specId, criteria };
}

export interface CaptureInfo {
  attempt: AttemptRow;
  studioPath: string;
  phone: boolean;
  how?: string;
  rubricPrompt?: string;
  checklist?: { id: string; label: string }[];
}

/** request_capture: an attempt row and where to record it (the studio, on the phone when one is paired). */
export async function requestCapture(ctx: LasContext, input: unknown): Promise<CaptureInfo> {
  const r = AttemptSpecSchema.safeParse(input);
  if (!r.success) throw new LoopError(`Not an attempt spec: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const spec = r.data;
  const st = loadSk(ctx, spec.sk);
  if (!st.model.specs[spec.spec]) throw new LoopError(`"${st.model.name}" has no spec "${spec.spec}".`);
  if (spec.drillId && !st.model.drills.some((d) => d.id === spec.drillId)) throw new LoopError(`Unknown drill "${spec.drillId}".`);
  const a = ctx.store.createAttempt({ enrollmentId: st.enrollment.id, drillId: spec.drillId, milestoneId: spec.milestoneId, kind: spec.kind, engine: spec.engine, specId: spec.spec, attemptNo: spec.attempt, prompt: spec.prompt, spec: { how: spec.how, singleTake: spec.singleTake } });
  const engSpec = st.model.specs[spec.spec];
  let rubricPrompt: string | undefined;
  if (engSpec.kind === "rubric") {
    try {
      rubricPrompt = (await loadEngines()).rubricPrompt(engSpec as RubricSpec);
    } catch {
      rubricPrompt = undefined;
    }
  }
  return { attempt: a, studioPath: `/app/capture/${a.id}`, phone: ctx.devices.phone, how: spec.how, rubricPrompt };
}

/** The studio posted evidence: keep it with the attempt and analyze it on the server. */
export async function analyzeEvidence(ctx: LasContext, attemptId: string, evidence: unknown, now = new Date()) {
  const a = attemptOrFail(ctx, attemptId);
  const enrollment = ctx.store.getEnrollment(a.enrollmentId);
  const intake = enrollment ? undefined : ctx.store.getIntake(a.enrollmentId);
  const modelRow = enrollment ? ctx.store.getSkillModel(enrollment.skillModelId) : intake ? ctx.store.getSkillModel(intake.skillModelId) : undefined;
  if (!modelRow) throw new LoopError(`Attempt ${attemptId} has no skill model.`);
  saveEvidence(ctx, attemptId, evidence);
  const st = enrollment ? loadSk(ctx, enrollment.id) : undefined;
  const { spec, specId, criteria } = st ? attemptSpec(ctx, st, a) : { spec: modelRow.model.specs[a.specId ?? ""], specId: a.specId ?? "", criteria: undefined };
  if (!spec) throw new LoopError(`Attempt ${attemptId} has no engine spec to analyze with.`);
  const eng = await loadEngines();
  const baseline = st ? ctx.store.getSetting<Record<string, number> | null>(`baseline.${st.enrollment.id}`, null) ?? undefined : undefined;
  const analysis = await eng.analyze(spec, reviveEvidence(evidence), { specId, modelVersion: modelRow.version, criteria, baseline });
  // the first recording sets the learner's own body proportions (evaluation §3 calibration)
  const ev = evidence as { baseline?: Record<string, number> };
  if (st && ev?.baseline && !baseline) ctx.store.setSetting(`baseline.${st.enrollment.id}`, ev.baseline);
  return { analysis, ...processAnalysis(ctx, attemptId, analysis, now) };
}

/** get_analysis: the analysis, the one-fix feedback card, and the proof result for a proof attempt. */
export function getAnalysis(ctx: LasContext, attemptId: string): { attempt: AttemptRow; analysis?: Analysis; feedback?: FeedbackView; proof?: ProofResultView } {
  const a = attemptOrFail(ctx, attemptId);
  if (!a.analysis) return { attempt: a };
  const feedback = buildFeedback(ctx, a.id, { markCoached: true });
  const proof = a.kind === "proof" ? (ctx.store.db.get("SELECT result FROM proof WHERE attempt_id = ? ORDER BY created_at DESC LIMIT 1", a.id)?.result as string | undefined) : undefined;
  return { attempt: a, analysis: a.analysis, feedback, proof: proof ? (JSON.parse(proof) as ProofResultView) : undefined };
}

export interface CodeRunInput {
  spec: unknown;
  files: Record<string, string>;
  sk?: string;
  drillId?: string;
  sessionId?: string;
  specId?: string;
  kind?: "drill" | "perform" | "proof" | "probe" | "rehearsal";
  consent?: boolean;
}

export const consentKey = (runner: string) => `consent.runner.${runner}`;

/**
 * run_code_tests: the best available runner, asking the learner before a runner's first use (the consent is
 * stored per runner). Browser runs happen in the studio, which posts its result back as evidence.
 */
export async function runCodeTests(ctx: LasContext, input: CodeRunInput, now = new Date()) {
  const r = TestSpecSchema.safeParse(input.spec);
  if (!r.success) throw new LoopError(`Not a test spec: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const spec = r.data;
  const issues = checkTestSpec(spec);
  if (issues.length) throw new LoopError(`Test spec issues: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
  const caps = await ctx.capabilities();
  const granted = (id: string) => ctx.store.getSetting<boolean>(consentKey(id), false);
  const runners = await loadRunners();
  const sel = runners.selectRunner(spec, {
    browser: caps.runners.browser,
    local: caps.runners.local.map((l) => ({ ...l, consented: l.consented || granted("local") })),
    container: { ...caps.runners.container, consented: caps.runners.container.consented || granted("container") }
  });
  if (!sel.runner) throw new LoopError(sel.reason ?? `No runner for ${spec.language} here. Install its toolchain or a container runtime (Podman).`);
  const st = input.sk ? loadSk(ctx, input.sk) : undefined;
  const makeAttempt = () =>
    st ? ctx.store.createAttempt({ sessionId: input.sessionId, enrollmentId: st.enrollment.id, drillId: input.drillId, kind: input.kind ?? "drill", engine: "code", specId: input.specId ?? st.model.drills.find((d) => d.id === input.drillId)?.spec, attemptNo: 1, prompt: spec.entry, spec: { test: spec } }) : undefined;
  if (sel.runner === "browser") {
    const a = makeAttempt();
    return { runner: "browser" as const, attemptId: a?.id, studioPath: a ? `/app/capture/${a.id}` : "/app/code", message: "This runs in the studio's browser sandbox; the studio sends the result back." };
  }
  if (sel.needsConsent && !granted(sel.runner)) {
    if (!input.consent) throw new LoopError(`Running ${spec.language} uses the ${sel.runner} runner${sel.reason ? ` (${sel.reason})` : ""} for the first time. Ask the learner, then call again with consent: true.`, { needsConsent: true, runner: sel.runner });
    ctx.store.setSetting(consentKey(sel.runner), true);
  }
  const result = sel.runner === "local" ? await runners.runLocal(spec, input.files, {}) : await runners.runContainer(spec, input.files, { runtime: caps.runners.container.runtime });
  const analysis = await (await loadEngines()).analyze(spec as EngineSpec, { result, files: input.files }, { specId: input.specId });
  const a = makeAttempt();
  if (!a) return { runner: sel.runner, result, analysis };
  saveEvidence(ctx, a.id, { result, files: input.files });
  const processed = processAnalysis(ctx, a.id, analysis, now);
  return { runner: sel.runner, result, analysis, attemptId: a.id, ...processed };
}

const metricSimilarity = (a: number, b: number) => 1 - Math.min(1, Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-9));

/**
 * compare_to_reference: for movement, the engine's reference comparison over the stored body points;
 * for everything else (and as the fallback), metric by metric against the reference attempt's analysis.
 */
export async function compareToReference(ctx: LasContext, attemptId: string, reference: string | { attemptId?: string; evidence?: unknown }) {
  const a = attemptOrFail(ctx, attemptId);
  if (!a.analysis) throw new LoopError(`Attempt ${attemptId} hasn't been analyzed yet.`);
  const refId = typeof reference === "string" ? reference : reference.attemptId;
  const ref = refId ? attemptOrFail(ctx, refId) : undefined;
  const refEvidence = typeof reference === "object" && reference.evidence !== undefined ? reference.evidence : ref ? readEvidence(ctx, ref.id) : undefined;
  if (a.engine === "movement") {
    // the movement engine lines up the learner's body points with the reference's (dynamic time warping)
    const frames = (e: any) => (Array.isArray(e) ? e : Array.isArray(e?.frames) ? e.frames : undefined);
    const mine = readEvidence(ctx, a.id);
    const learnerFrames = frames(mine);
    const refFrames = frames(refEvidence) ?? frames(mine?.reference);
    try {
      const eng = await loadEngines();
      if (eng.compareToReference && learnerFrames?.length && refFrames?.length) {
        const out = await eng.compareToReference(learnerFrames, refFrames);
        return { attemptId, reference: refId, method: "engine" as const, result: out };
      }
    } catch {
      /* fall back to metrics */
    }
  }
  if (!ref?.analysis) throw new LoopError("Compare needs a reference attempt that has been analyzed (pass its attempt id).");
  const metrics = Object.keys(a.analysis.metrics)
    .filter((k) => k in ref.analysis!.metrics)
    .map((k) => ({ metric: k, you: a.analysis!.metrics[k].value, reference: ref.analysis!.metrics[k].value, unit: a.analysis!.metrics[k].unit, similarity: Math.round(metricSimilarity(a.analysis!.metrics[k].value, ref.analysis!.metrics[k].value) * 100) / 100 }));
  return { attemptId, reference: ref.id, method: "metrics" as const, similarity: metrics.length ? Math.round(mean(metrics.map((m) => m.similarity)) * 100) / 100 : undefined, metrics };
}

/**
 * run_proof_check: readiness first (every milestone skill at 80%, 2 recent passing attempts); if not ready it
 * says what's missing and the learner may proceed anyway. Then one continuous take; the result arrives when
 * the attempt is analyzed.
 */
export function startProofCheck(ctx: LasContext, milestoneOrSk: string, proceed = false): { ready: boolean; readiness: Readiness; attempt?: AttemptRow; studioPath?: string; checklist: { id: string; label: string }[]; message: string; milestoneId: string } {
  const m = ctx.store.getMilestone(milestoneOrSk) ?? (() => {
    const e = ctx.store.resolveEnrollment(milestoneOrSk);
    return e ? ctx.store.activeMilestone(e.id) : undefined;
  })();
  if (!m) throw new LoopError(`Unknown milestone "${milestoneOrSk}".`);
  if (m.status === "done") throw new LoopError("This milestone is already done. revisit_why sets the next one.");
  const st = loadSk(ctx, m.enrollmentId);
  const r = readiness(ctx, st, m);
  const proof = milestoneProof(st, m);
  const checklist = (proof?.criteria ?? []).map((c) => ({ id: c.id, label: c.label }));
  if (!r.ready && !proceed) return { ready: false, readiness: r, checklist, milestoneId: m.id, message: `${r.message} The app suggests waiting until a rehearsal passes; call again with proceed: true to take it anyway.` };
  const a = ctx.store.createAttempt({ enrollmentId: st.enrollment.id, milestoneId: m.id, kind: "proof", engine: proof?.engine ?? "self-report", specId: proof?.spec, attemptNo: 1, prompt: (m.proof as { label?: string })?.label ?? proof?.label ?? m.title, spec: { singleTake: true, criteria: proof?.criteria, capture: proof?.capture } });
  return { ready: r.ready, readiness: r, attempt: a, studioPath: `/app/capture/${a.id}`, checklist, milestoneId: m.id, message: "One continuous take, recorded in the app." };
}

/** submit_rubric_grade: the agent's own rubric grades for a visual attempt, measured with the engine and stored. */
export async function submitRubricGrade(ctx: LasContext, attemptId: string, grades: { criterion: string; level: number; confidence: number; region?: { x: number; y: number; w: number; h: number }; note?: string }[], now = new Date()) {
  const a = attemptOrFail(ctx, attemptId);
  const st = loadSk(ctx, a.enrollmentId);
  const { spec, specId, criteria } = attemptSpec(ctx, st, a);
  if (spec.kind !== "rubric") throw new LoopError(`Attempt ${attemptId} isn't graded with a rubric.`);
  const evidence = { width: 1, height: 1, ...(readEvidence(ctx, a.id) ?? {}), grades, grader: "agent" };
  saveEvidence(ctx, a.id, evidence);
  const analysis = await (await loadEngines()).analyze(spec, reviveEvidence(evidence), { specId, modelVersion: ctx.store.getSkillModel(st.modelId)?.version, criteria });
  return { analysis, ...processAnalysis(ctx, a.id, analysis, now) };
}
