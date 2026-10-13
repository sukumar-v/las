/** Fixed synthetic recordings for the sensor tolerance-drift test (see movement cases for how to regenerate). */
import type { Analysis } from "@las/schema";
import { analyzeSensor, stillSamples, swingSamples, steppingSamples } from "../../../src/sensor/index.js";

export function sensorDriftCases(): Record<string, Analysis> {
  return {
    cadence: analyzeSensor({ detect: "cadence", target: { cadence_spm: 165 }, pass: "abs(cadence_spm - target.cadence_spm) <= 5" }, { samples: steppingSamples({ spm: 163, durationS: 25, noise: 0.2, seed: 21 }).samples }),
    swing: analyzeSensor({ detect: "swing-tempo", placement: "hand" }, { samples: swingSamples({ backswingMs: 820, downswingMs: 270, noise: 0.1, seed: 22 }).samples }),
    steadiness: analyzeSensor({ detect: "steadiness", placement: "strapped" }, stillSamples({ sway: 0.08, gyroSway: 0.03, seed: 23 }))
  };
}
