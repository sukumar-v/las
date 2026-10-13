/** Sensor engine regression tests on synthetic accelerometer and gyroscope recordings with known truth. */
import { describe, expect, it } from "vitest";
import { analyzeSensor, stillSamples, swingSamples, steppingSamples } from "../src/sensor/index.js";

describe("cadence and steps", () => {
  for (const spm of [100, 150, 170, 190]) {
    it(`finds ${spm} steps per minute and counts the steps`, () => {
      const w = steppingSamples({ spm, seed: spm });
      const a = analyzeSensor({ detect: "cadence" }, { samples: w.samples });
      expect(a.quality.ok).toBe(true);
      expect(Math.abs(a.metrics.cadence_spm.value - spm)).toBeLessThan(2);
      expect(Math.abs(a.metrics.steps.value - w.truth.steps)).toBeLessThanOrEqual(1);
      expect(a.metrics.cadence_spm.confidence).toBeGreaterThanOrEqual(0.7);
      expect(a.engine).toBe("sensor");
    });
  }
  it("counts steps for step-count and reads the peak acceleration in g", () => {
    const w = steppingSamples({ spm: 120, durationS: 15, impactG: 1.2, noise: 0.05 });
    const a = analyzeSensor({ detect: "step-count", duration_s: 15 }, { samples: w.samples });
    expect(Math.abs(a.metrics.steps.value - w.truth.steps)).toBeLessThanOrEqual(1);
    // gravity (1 g) + impact (1.2 g) + bounce (0.25 g) at a footfall
    expect(Math.abs(a.metrics.peak_g.value - 2.45)).toBeLessThan(0.1);
  });
  it("evaluates the pass expression against the target and praises a metric on target", () => {
    const w = steppingSamples({ spm: 172 });
    const ok = analyzeSensor({ detect: "cadence", target: { cadence_spm: 170 }, pass: "abs(cadence_spm - target.cadence_spm) <= 5" }, { samples: w.samples });
    expect(ok.criteria.pass).toBe(true);
    expect(ok.praise?.metric).toBe("cadence_spm");
    const slow = analyzeSensor({ detect: "cadence", target: { cadence_spm: 200 }, pass: "abs(cadence_spm - target.cadence_spm) <= 5" }, { samples: w.samples }, { criteria: { quick: "cadence_spm >= 160" } });
    expect(slow.criteria).toEqual({ pass: false, quick: true });
    expect(slow.praise).toBeUndefined();
  });
});

describe("swing tempo", () => {
  for (const [back, down] of [
    [900, 300],
    [750, 250],
    [1000, 400]
  ]) {
    it(`times a ${back}/${down} ms swing within 10%`, () => {
      const s = swingSamples({ backswingMs: back, downswingMs: down });
      const a = analyzeSensor({ detect: "swing-tempo", placement: "hand" }, { samples: s.samples });
      expect(a.quality.ok).toBe(true);
      expect(Math.abs(a.metrics.backswing_ms.value - back) / back).toBeLessThan(0.1);
      expect(Math.abs(a.metrics.downswing_ms.value - down) / down).toBeLessThan(0.1);
      expect(Math.abs(a.metrics.tempo_ratio.value - back / down) / (back / down)).toBeLessThan(0.1);
      expect(a.segments).toHaveLength(2);
      expect(a.markers.map((m) => m.label)).toEqual(["start", "top", "peak"]);
      expect(Math.abs(a.markers[1].t - s.truth.topTime)).toBeLessThan(0.05);
    });
  }
  it("asks for the gyroscope instead of guessing from acceleration alone", () => {
    const s = swingSamples({ gyro: false });
    const a = analyzeSensor({ detect: "swing-tempo" }, { samples: s.samples });
    expect(a.quality.ok).toBe(false);
    expect(a.quality.reRecord).toMatch(/gyroscope/);
  });
});

describe("steadiness", () => {
  it("is near 1 when still and falls as the phone wobbles more", () => {
    const values = [0.02, 0.1, 0.5].map((sway) => analyzeSensor({ detect: "steadiness", placement: "strapped" }, stillSamples({ sway })).metrics.steadiness.value);
    expect(values[0]).toBeGreaterThan(0.95);
    expect(values[1]).toBeLessThan(values[0]);
    expect(values[2]).toBeLessThan(values[1]);
    expect(values[2]).toBeLessThan(0.3);
    const withGyro = analyzeSensor({ detect: "steadiness" }, stillSamples({ sway: 0.02, gyroSway: 0.1 })).metrics.steadiness.value;
    expect(withGyro).toBeLessThan(values[0]);
  });
});

describe("recording quality", () => {
  it("asks to re-record a recording that is too short", () => {
    const a = analyzeSensor({ detect: "cadence" }, { samples: steppingSamples({ durationS: 1 }).samples });
    expect(a.quality.ok).toBe(false);
    expect(a.quality.reRecord).toMatch(/too short.*in your pocket/);
    expect(a.metrics).toEqual({});
  });
  it("asks to re-record when there is no motion", () => {
    const a = analyzeSensor({ detect: "cadence", placement: "wrist" }, stillSamples({ sway: 0.02, durationS: 20 }));
    expect(a.quality.ok).toBe(false);
    expect(a.quality.reRecord).toMatch(/didn't feel any movement.*on your wrist/);
  });
  it("reports an invalid spec", () => {
    const a = analyzeSensor({ detect: "levitation" } as never, { samples: [] });
    expect(a.quality.ok).toBe(false);
    expect(a.quality.issues[0]).toMatch(/spec detect/);
  });
});
