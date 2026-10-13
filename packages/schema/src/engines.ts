import { z } from "zod";

/** Kinds of evidence LAS can measure. Each engine is general-purpose and configured by a spec. */
export const ENGINE_IDS = ["movement", "audio", "speech", "code", "visual", "knowledge", "interaction", "sensor", "game", "self-report"] as const;
export type EngineId = (typeof ENGINE_IDS)[number];
export const EngineIdSchema = z.enum(ENGINE_IDS);

/** Which spec language configures each engine. */
export const SPEC_KIND_FOR_ENGINE: Record<EngineId, SpecKind> = {
  movement: "metric",
  audio: "audio",
  speech: "speech",
  code: "test",
  visual: "rubric",
  knowledge: "items",
  interaction: "task",
  sensor: "sensor",
  game: "game",
  "self-report": "self-report"
};

export const SPEC_KINDS = ["metric", "rubric", "test", "audio", "speech", "items", "task", "sensor", "game", "self-report"] as const;
export type SpecKind = (typeof SPEC_KINDS)[number];

export interface EngineInfo {
  id: EngineId;
  input: string;
  configuredBy: SpecKind;
  outputs: string[];
  /** Capture devices the studio needs for this engine */
  devices: ("camera" | "microphone" | "motion" | "none")[];
  /** Engines that can stand in when this one is unavailable, in order */
  fallbacks: EngineId[];
}

export const ENGINES: Record<EngineId, EngineInfo> = {
  movement: {
    id: "movement",
    input: "camera or video file",
    configuredBy: "metric",
    outputs: ["joint angles", "speeds", "repetitions", "tempo", "range of motion", "symmetry", "balance", "similarity to reference", "share of moves on the beat"],
    devices: ["camera"],
    fallbacks: ["self-report"]
  },
  audio: {
    id: "audio",
    input: "microphone or file",
    configuredBy: "audio",
    outputs: ["notes", "pitch error (cents)", "timing error (ms)", "tempo stability", "dynamics", "chords"],
    devices: ["microphone"],
    fallbacks: ["self-report"]
  },
  speech: {
    id: "speech",
    input: "microphone",
    configuredBy: "speech",
    outputs: ["transcript", "intelligibility", "confidence per word", "speaking rate", "pauses", "fillers", "pitch contour", "per-sound scores where a model exists"],
    devices: ["microphone"],
    fallbacks: ["self-report"]
  },
  code: {
    id: "code",
    input: "files",
    configuredBy: "test",
    outputs: ["tests passed", "errors", "run time", "lint findings"],
    devices: ["none"],
    fallbacks: ["knowledge"]
  },
  visual: {
    id: "visual",
    input: "photo, scan or screenshot",
    configuredBy: "rubric",
    outputs: ["rubric scores with confidence", "proportions", "symmetry", "exposure", "color", "recognized text"],
    devices: ["camera"],
    fallbacks: ["self-report"]
  },
  knowledge: { id: "knowledge", input: "answers", configuredBy: "items", outputs: ["accuracy", "response time", "spaced-repetition state"], devices: ["none"], fallbacks: [] },
  interaction: { id: "interaction", input: "keystrokes and clicks in the studio", configuredBy: "task", outputs: ["speed", "accuracy", "consistency"], devices: ["none"], fallbacks: ["self-report"] },
  sensor: { id: "sensor", input: "phone motion sensors", configuredBy: "sensor", outputs: ["cadence", "swing tempo", "steadiness"], devices: ["motion"], fallbacks: ["self-report"] },
  game: { id: "game", input: "positions and moves", configuredBy: "game", outputs: ["agreement with the engine's best move", "blunders", "evaluation loss"], devices: ["none"], fallbacks: ["knowledge"] },
  "self-report": { id: "self-report", input: "learner input", configuredBy: "self-report", outputs: ["minutes", "effort (RPE)", "how it felt", "pain"], devices: ["none"], fallbacks: [] }
};
