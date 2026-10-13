/** Tolerance drift for the sensor engine: fixed synthetic recordings must give the stored results (LAS_UPDATE_FIXTURES=1 regenerates). */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sensorDriftCases } from "./fixtures/sensor/cases.js";

const FILE = fileURLToPath(new URL("./fixtures/sensor/expected.json", import.meta.url));
const TOLERANCE = 1e-6;

describe("sensor engine results don't drift", () => {
  const actual = Object.fromEntries(
    Object.entries(sensorDriftCases()).map(([k, a]) => [k, { metrics: Object.fromEntries(Object.entries(a.metrics).map(([m, v]) => [m, { value: v.value, confidence: v.confidence }])), criteria: a.criteria, ok: a.quality.ok }])
  );
  if (process.env.LAS_UPDATE_FIXTURES) writeFileSync(FILE, JSON.stringify(actual, null, 2) + "\n");
  const expected = JSON.parse(readFileSync(FILE, "utf8")) as typeof actual;
  for (const [name, exp] of Object.entries(expected)) {
    it(`matches the stored results for ${name}`, () => {
      const got = actual[name];
      expect(got.ok).toBe(exp.ok);
      expect(got.criteria).toEqual(exp.criteria);
      expect(Object.keys(got.metrics).sort()).toEqual(Object.keys(exp.metrics).sort());
      for (const [m, e] of Object.entries(exp.metrics)) {
        for (const key of ["value", "confidence"] as const) {
          const diff = Math.abs(got.metrics[m][key] - e[key]);
          expect(diff, `${name}.${m}.${key}: ${got.metrics[m][key]} vs ${e[key]}`).toBeLessThanOrEqual(TOLERANCE * Math.max(1, Math.abs(e[key])));
        }
      }
    });
  }
});
