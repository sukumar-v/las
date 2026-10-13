/**
 * The engines and runners are separate packages with fixed contracts. They are loaded lazily so the
 * server starts (and onboarding works) even before an engine is installed or built, and so a missing
 * engine shows up as a clear message at the moment it's needed, never as a crash at start-up.
 */
import type { Analysis, EngineSpec, ItemsSpec, KnowledgeItem, RubricSpec, TestSpec } from "@las/schema";

export interface EnginesApi {
  analyze(spec: EngineSpec, evidence: unknown, ctx?: { baseline?: Record<string, number>; learner?: Record<string, number | string>; specId?: string; modelVersion?: number; criteria?: Record<string, string> }): Promise<Analysis>;
  rubricPrompt(spec: RubricSpec, taps?: Record<string, [number, number]>): string;
  nextItem(spec: ItemsSpec, history: { itemId: string; correct: boolean }[]): KnowledgeItem | null;
  gradeItem(item: KnowledgeItem, answer: unknown): { correct: boolean; score: number };
  compareToReference?: (...args: any[]) => any;
}

export interface RunnersApi {
  selectRunner(spec: TestSpec, available: { browser: unknown; local: unknown; container: unknown }): { runner: "browser" | "local" | "container" | null; needsConsent: boolean; reason?: string };
  runLocal(spec: TestSpec, files: Record<string, string>, opts?: unknown): Promise<any>;
  runContainer(spec: TestSpec, files: Record<string, string>, opts: { runtime?: string }): Promise<any>;
}

let engines: Promise<EnginesApi> | undefined;
let runners: Promise<RunnersApi> | undefined;

export function loadEngines(): Promise<EnginesApi> {
  engines ??= import("@las/engines").then((m) => m as unknown as EnginesApi);
  return engines.catch((e) => {
    engines = undefined;
    throw new Error(`The LAS engines aren't available: ${(e as Error).message}`);
  });
}

export function loadRunners(): Promise<RunnersApi> {
  runners ??= import("@las/runners").then((m) => m as unknown as RunnersApi);
  return runners.catch((e) => {
    runners = undefined;
    throw new Error(`The LAS code runners aren't available: ${(e as Error).message}`);
  });
}
