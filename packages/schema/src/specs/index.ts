import { z } from "zod";
import { MetricSpecSchema, checkMetricSpec } from "./metric.js";
import { RubricSpecSchema, checkRubricSpec } from "./rubric.js";
import { TestSpecSchema, checkTestSpec } from "./test.js";
import { AudioSpecSchema, checkAudioSpec } from "./audio.js";
import { SpeechSpecSchema, checkSpeechSpec } from "./speech.js";
import { checkSimSpec } from "./sim.js";
import { GameSpecSchema, ItemsSpecSchema, SelfReportSpecSchema, SensorSpecSchema, TaskSpecSchema, checkItemsSpec } from "./others.js";
import type { EngineId } from "../engines.js";

export * from "./metric.js";
export * from "./rubric.js";
export * from "./test.js";
export * from "./audio.js";
export * from "./speech.js";
export * from "./sim.js";
export * from "./others.js";

/** Any engine spec, discriminated by `kind`. */
export const EngineSpecSchema = z.discriminatedUnion("kind", [
  MetricSpecSchema.required({ kind: true }),
  RubricSpecSchema.required({ kind: true }),
  TestSpecSchema.required({ kind: true }),
  AudioSpecSchema.required({ kind: true }),
  SpeechSpecSchema.required({ kind: true }),
  ItemsSpecSchema.required({ kind: true }),
  TaskSpecSchema.required({ kind: true }),
  SensorSpecSchema.required({ kind: true }),
  GameSpecSchema.required({ kind: true }),
  SelfReportSpecSchema.required({ kind: true })
]);
export type EngineSpec = z.infer<typeof EngineSpecSchema>;
export type EngineSpecInput = z.input<typeof EngineSpecSchema>;

export const ENGINE_FOR_SPEC_KIND: Record<EngineSpec["kind"], EngineId> = {
  metric: "movement",
  rubric: "visual",
  test: "code",
  audio: "audio",
  speech: "speech",
  items: "knowledge",
  task: "interaction",
  sensor: "sensor",
  game: "game",
  "self-report": "self-report"
};

/** Parse and statically check any spec. Returns the parsed spec and issues (empty when ok). */
export function checkSpec(input: unknown): { spec?: EngineSpec; issues: { path: string; message: string }[] } {
  const r = EngineSpecSchema.safeParse(input);
  if (!r.success) {
    return { issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
  }
  const spec = r.data;
  let issues: { path: string; message: string }[] = [];
  switch (spec.kind) {
    case "metric":
      issues = checkMetricSpec(spec);
      break;
    case "rubric":
      issues = checkRubricSpec(spec);
      break;
    case "test":
      issues = checkTestSpec(spec);
      break;
    case "audio":
      issues = checkAudioSpec(spec);
      break;
    case "speech":
      issues = checkSpeechSpec(spec);
      break;
    case "items":
      issues = checkItemsSpec(spec);
      break;
  }
  return { spec, issues };
}

export { checkSimSpec };
