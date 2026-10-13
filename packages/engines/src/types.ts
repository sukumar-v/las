/** Evidence shapes each engine analyzes. The studio (or a node adapter) produces these; engines only measure. */
import type { Analysis, EngineId } from "@las/schema";

/** One tracked point: normalized x, y in [0,1] (top-left origin), z in roughly [-1,1], visibility/confidence in [0,1]. */
export type Point = [number, number, number, number];

export interface PoseFrame {
  /** seconds from the start of the clip */
  t: number;
  /** MediaPipe pose landmark names -> point */
  pose?: Record<string, Point>;
  /** hand landmark names -> point, per hand */
  hands?: { left?: Record<string, Point>; right?: Record<string, Point> };
  /** face landmark names (the named subset) -> point */
  face?: Record<string, Point>;
  /** object class -> box center as a point plus size */
  objects?: Record<string, { center: Point; w: number; h: number }>;
}

export interface MovementEvidence {
  frames: PoseFrame[];
  fps: number;
  width: number;
  height: number;
  /** beat times in seconds when the clip's audio track was analyzed, or a metronome was running */
  beats?: number[];
  /** a reference clip's frames (learner-supplied), already tracked */
  reference?: PoseFrame[];
  /** per-learner body proportions from the first recording, used by `baseline.*` */
  baseline?: Record<string, number>;
  /** the actual camera angle the studio detected, if it could */
  detectedAngle?: string;
}

export interface AudioEvidence {
  sampleRate: number;
  samples: Float32Array;
  /** device output delay measured by the tap test, subtracted from every timing result */
  outputDelayMs?: number;
  /** when a metronome or backing track played: its tempo and the time of its first beat */
  click?: { bpm: number; firstBeatS: number };
}

export interface SpeechEvidence {
  transcript: { text: string; language?: string; words: { word: string; start: number; end: number; confidence: number }[] };
  /** the audio, for pace, pauses and pitch contour */
  sampleRate?: number;
  samples?: Float32Array;
  /** pitch track in Hz per 10 ms hop when already extracted */
  pitchTrack?: { t: number; hz: number; clarity: number }[];
  durationS?: number;
}

export interface CodeEvidence {
  /** the runner's result; see @las/runners RunResult */
  result: {
    runner: "browser" | "local" | "container";
    language: string;
    compiled?: { ok: boolean; output: string };
    tests: { label: string; hidden: boolean; pass: boolean; expected?: string; got?: string; error?: string; timeMs?: number }[];
    timeMs: number;
    lint?: { tool: string; findings: { file: string; line: number; message: string; rule?: string }[] }[];
    error?: string;
  };
  files: Record<string, string>;
}

export interface VisualEvidence {
  width: number;
  height: number;
  /** normalized points the learner tapped, by the tap id in the rubric */
  taps?: Record<string, [number, number]>;
  /** RGBA pixels when image measurements are wanted (exposure, color, edges, symmetry) */
  pixels?: { data: Uint8ClampedArray | Uint8Array; width: number; height: number };
  /** text recognized by OCR in the studio */
  ocrText?: string;
  /** rubric grades submitted by the agent (its own vision) or a local vision model */
  grades?: { criterion: string; level: number; confidence: number; region?: { x: number; y: number; w: number; h: number }; note?: string }[];
  /** which grader produced the grades */
  grader?: "agent" | "local-model" | "none";
}

export interface KnowledgeEvidence {
  answers: { itemId: string; answer: unknown; ms: number }[];
}

export interface InteractionEvidence {
  events: { t: number; key?: string; expected?: string; correct?: boolean; x?: number; y?: number; target?: string }[];
  durationS: number;
}

export interface SensorEvidence {
  /** accelerometer (m/s^2) and optional gyroscope (rad/s) samples */
  samples: { t: number; ax: number; ay: number; az: number; gx?: number; gy?: number; gz?: number }[];
}

export interface GameEvidence {
  /** moves in SAN or UCI from the starting position */
  moves: string[];
  /** evaluations from an external engine (centipawns from the mover's side) per ply, when one ran */
  engineEvals?: { ply: number; best: string; bestCp: number; playedCp: number }[];
  /** answers to fallback tactics items */
  puzzleAnswers?: { position: string; answer: string }[];
}

export interface SelfReportEvidence {
  fields: Record<string, number | string | boolean>;
}

export type Evidence = MovementEvidence | AudioEvidence | SpeechEvidence | CodeEvidence | VisualEvidence | KnowledgeEvidence | InteractionEvidence | SensorEvidence | GameEvidence | SelfReportEvidence;

export interface AnalyzeContext {
  /** learner thresholds relative to their own body or first attempts: `baseline.*` in specs */
  baseline?: Record<string, number>;
  /** `learner.*` in specs */
  learner?: Record<string, number | string>;
  /** stamped into Analysis.version */
  specId?: string;
  modelVersion?: number;
}

export type Analyzer<S, E> = (spec: S, evidence: E, ctx?: AnalyzeContext) => Analysis | Promise<Analysis>;
export type { Analysis, EngineId };
