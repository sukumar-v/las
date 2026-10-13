import type { EngineSpec, Analysis } from "@las/schema";
import type { AnalyzeContext } from "./types.js";
import { analyzeMovement } from "./movement/index.js";
import { analyzeSensor } from "./sensor/index.js";
import { analyzeAudio } from "./audio/index.js";
import { analyzeSpeech } from "./speech/index.js";
import { analyzeCode } from "./code/index.js";
import { analyzeVisual } from "./visual/index.js";
import { analyzeKnowledge } from "./knowledge/index.js";
import { analyzeInteraction } from "./interaction/index.js";
import { analyzeGame } from "./game/index.js";
import { analyzeSelfReport } from "./self-report/index.js";

/** Routes a spec and its evidence to the right engine. Evidence shapes are in types.ts. */
export async function analyze(spec: EngineSpec, evidence: any, ctx?: AnalyzeContext): Promise<Analysis> {
  switch (spec.kind) {
    case "metric":
      return analyzeMovement(spec, evidence, ctx);
    case "sensor":
      return analyzeSensor(spec, evidence, ctx);
    case "audio":
      return analyzeAudio(spec, evidence, ctx);
    case "speech":
      return analyzeSpeech(spec, evidence, ctx);
    case "test":
      return analyzeCode(spec, evidence, ctx);
    case "rubric":
      return analyzeVisual(spec, evidence, ctx);
    case "items":
      return analyzeKnowledge(spec, evidence, ctx);
    case "task":
      return analyzeInteraction(spec, evidence, ctx);
    case "game":
      return analyzeGame(spec, evidence, ctx);
    case "self-report":
      return analyzeSelfReport(spec, evidence, ctx);
  }
}
