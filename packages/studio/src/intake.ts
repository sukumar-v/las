/**
 * Onboarding glue: the server's IntakeView (one step at a time) turned into what the shared Onboarding screen
 * draws, plus the learner's not-yet-sent picks on multi-answer steps. Pure functions, so they're unit-tested.
 */
import type { IntakeView, MilestoneSuggestion, RouteView } from "@las/schema";

/** Picks held on the device until the step's main button sends them. */
export interface IntakeDraft {
  why?: string[];
  multi?: Record<string, (string | number)[]>;
  minutes?: number;
  deadline?: string;
  access?: string[];
  injuries?: string[];
  milestone?: string;
  /** quiz answers so far, right or wrong, per probe */
  quiz?: Record<string, boolean[]>;
  taps?: number;
}

export function toggle<T>(list: T[] | undefined, v: T, max?: number): T[] {
  const cur = list ?? [];
  if (cur.includes(v)) return cur.filter((x) => x !== v);
  const next = [...cur, v];
  return max && next.length > max ? next.slice(next.length - max) : next;
}

const asList = (v: unknown): any[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

/** The milestone ladder in the server's payload, drawn as a route (placement is "here", earlier steps done). */
export function ladderRoute(ladder: { step: number; label: string; weeks?: number; done?: boolean }[] | undefined, pickedStep?: number): RouteView | undefined {
  if (!ladder?.length) return undefined;
  const lastDone = Math.max(-1, ...ladder.filter((l) => l.done).map((l) => l.step));
  return {
    start: Math.max(0, lastDone),
    target: pickedStep,
    steps: ladder.map((l) => ({ step: l.step, label: l.label, hours: [0, 0] as [number, number], weeks: l.weeks, state: l.step < lastDone ? ("done" as const) : l.step === lastDone ? ("here" as const) : ("ahead" as const), target: l.step === pickedStep, nodes: [] }))
  };
}

export function suggestionValue(s: Pick<MilestoneSuggestion, "kind" | "step">): string {
  return `${s.kind}:${s.step}`;
}

/** What the Onboarding screen needs from one server step and the local draft. */
export function adaptIntake(view: IntakeView, draft: IntakeDraft = {}): IntakeView {
  const p = { ...(view.payload ?? {}) } as Record<string, any>;
  const v: IntakeView = { ...view, payload: p, cta: { ...view.cta } };
  switch (view.step) {
    case "look":
      v.cta = { label: view.cta.label, enabled: true };
      break;
    case "why": {
      const picked = draft.why ?? (asList(view.value) as string[]);
      v.value = picked;
      v.cta = { label: picked.length ? "Continue" : view.cta.label, enabled: picked.length > 0 };
      break;
    }
    case "picture":
      p.pictureText = typeof view.value === "string" && !view.options?.some((o) => o.value === view.value) ? view.value : undefined;
      break;
    case "probe": {
      const field = view.field ?? String(p.probeId ?? "probe");
      p.first = p.index === 0;
      // the screen shows "I'm completely new to this" itself; the server's secondary text would repeat it
      v.cta = { label: view.cta.label, enabled: view.cta.enabled };
      if (view.answerType === "multi" || view.answerType === "visual-multi") {
        const picked = draft.multi?.[field] ?? asList(view.value);
        v.value = picked;
        v.cta = { label: picked.length ? "Continue" : view.cta.label, enabled: true };
      }
      if (view.answerType === "quiz") {
        const q = (p.quiz ?? {}) as { answered?: number; correct?: number };
        const local = draft.quiz?.[field];
        p.history = local && local.length === (q.answered ?? local.length) ? local : [...Array(q.correct ?? 0).fill(true), ...Array(Math.max(0, (q.answered ?? 0) - (q.correct ?? 0))).fill(false)];
      }
      if (view.answerType === "tap") p.taps = draft.taps ?? 0;
      break;
    }
    case "place":
      v.cta = { label: view.cta.label, enabled: true };
      break;
    case "time": {
      const val = (view.value ?? {}) as { minutes?: number; deadline?: string };
      p.minutes = draft.minutes ?? val.minutes ?? 180;
      p.deadline = draft.deadline ?? val.deadline ?? "none";
      break;
    }
    case "around": {
      const val = (view.value ?? {}) as { access?: string[]; injuries?: string[] };
      p.accessOptions = asList(p.access).map((a: any) => (typeof a === "string" ? a : String(a.value ?? a.label)));
      p.injuryOptions = asList(p.injuries).map((a: any) => (typeof a === "string" ? a : String(a.value ?? a.label)));
      p.access = draft.access ?? val.access ?? [];
      p.injuries = draft.injuries ?? val.injuries ?? [];
      const any = (p.access as string[]).length + (p.injuries as string[]).length > 0;
      v.cta = { label: any ? "Continue" : view.cta.label, enabled: true };
      break;
    }
    case "milestone": {
      const sugs = (p.suggestions ?? []) as MilestoneSuggestion[];
      const value = draft.milestone ?? (typeof view.value === "string" ? view.value : undefined);
      const idx = value ? sugs.findIndex((s) => suggestionValue(s) === value) : -1;
      p.picked = idx >= 0 ? idx : undefined;
      p.route = ladderRoute(p.ladder, idx >= 0 ? sugs[idx].step : undefined);
      v.cta = { label: value ? "Build my plan" : view.cta.label, enabled: !!value || view.cta.enabled };
      break;
    }
    case "plan":
      v.cta = { label: view.cta.label, enabled: view.cta.enabled };
      break;
  }
  return v;
}

/** The value the step's main button sends, or undefined when the button only moves on. */
export function submission(view: IntakeView, draft: IntakeDraft): { field: string; value: unknown } | undefined {
  switch (view.step) {
    case "look":
      return { field: "look", value: view.value ?? "plain" };
    case "why":
      return { field: "why", value: draft.why ?? asList(view.value) };
    case "probe": {
      const field = view.field ?? "probe";
      if (view.answerType === "multi" || view.answerType === "visual-multi") return { field, value: draft.multi?.[field] ?? asList(view.value) };
      if (view.answerType === "tap" || view.answerType === "record" || view.answerType === "code") return { field, value: "skip" };
      return undefined;
    }
    case "place":
      return { field: "place", value: "ok" };
    case "time": {
      const val = (view.value ?? {}) as { minutes?: number; deadline?: string };
      return { field: "time", value: { minutes: draft.minutes ?? val.minutes ?? 180, deadline: draft.deadline ?? val.deadline ?? "none" } };
    }
    case "around": {
      const val = (view.value ?? {}) as { access?: string[]; injuries?: string[] };
      return { field: "around", value: { access: draft.access ?? val.access ?? [], injuries: draft.injuries ?? val.injuries ?? [] } };
    }
    default:
      return undefined;
  }
}
