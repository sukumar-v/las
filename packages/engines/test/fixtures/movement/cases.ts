/**
 * Fixed synthetic inputs for the tolerance-drift test. Changing an engine, a threshold or the
 * smoothing changes these results; the test fails until expected.json is deliberately regenerated
 * (LAS_UPDATE_FIXTURES=1 pnpm vitest run --project engines test/movement-drift.test.ts).
 */
import type { Analysis } from "@las/schema";
import { analyzeMovement, holdSequence, squatSequence, stepsOnBeats, swingSequence, type SyntheticClip } from "../../../src/movement/index.js";
import { SALSA_SPEC, SQUAT_SPEC } from "./specs.js";

export interface DriftRecord {
  metrics: Record<string, { value: number; confidence: number; per?: number[] }>;
  mistakes: { id: string; share?: number; at: number[] }[];
  segments: [number, number][];
}

export function record(a: Analysis): DriftRecord {
  return {
    metrics: Object.fromEntries(Object.entries(a.metrics).map(([k, m]) => [k, { value: m.value, confidence: m.confidence, ...(m.per ? { per: m.per } : {}) }])),
    mistakes: a.mistakes.map((m) => ({ id: m.id, ...(m.share !== undefined ? { share: m.share } : {}), at: m.at })),
    segments: a.segments ?? []
  };
}

export function movementDriftCases(): Record<string, Analysis> {
  const squat = squatSequence({ reps: 4, bottomKneeAngle: [88, 96, 104, 90], noise: 0.002, seed: 42 });
  const reference = stepsOnBeats({ bpm: 110, beats: 16, noise: 0.001, seed: 8 });
  const steps = stepsOnBeats({ bpm: 110, beats: 16, offsetsMs: [-90, -40, 10, 60, -120, 0, 30, -70, 20, -100, 50, -10, -85, 15, 40, -60], noise: 0.001, seed: 9 });
  const hold = holdSequence({ holdS: 2.5, armAngleDeg: 80, jitter: 0.001, noise: 0.001, seed: 5 });
  const swing = swingSequence({ backswingS: 0.8, downswingS: 0.28, noise: 0.001, seed: 6 });
  const ev = (c: SyntheticClip) => ({ frames: c.frames, fps: c.fps, width: c.width, height: c.height });
  return {
    squat: analyzeMovement(SQUAT_SPEC, ev(squat)),
    salsa: analyzeMovement(SALSA_SPEC, { ...ev(steps), beats: steps.beats, reference: reference.frames }),
    hold: analyzeMovement(
      {
        capture: { angle: "front", fps: 30 },
        segment: { by: "holds" },
        metrics: {
          held_s: "hold_time(angle(left_elbow, left_shoulder, left_hip) >= 85)",
          arm: "median(angle(left_elbow, left_shoulder, left_hip)) per hold",
          level: "symmetry(left_wrist, right_wrist)",
          balance: "share(between(center_of_mass, left_ankle, right_ankle))"
        }
      },
      ev(hold)
    ),
    swing: analyzeMovement(
      {
        capture: { angle: "front", fps: 60 },
        segment: { by: "moves" },
        metrics: { fastest: "max(speed(left_wrist)) per move", smooth: "mean(jerk(left_wrist)) per move", reach: "max(distance(left_wrist, mid_shoulder, unit: \"torso\"))", top_s: "phase_duration(down) per move" },
        mistakes: [{ id: "jerky", when: "smooth > 20", severity: 1 }]
      },
      ev(swing)
    )
  };
}
