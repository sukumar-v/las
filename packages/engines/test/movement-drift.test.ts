/**
 * Tolerance drift: fixed synthetic input must give the stored results. A change to the engine, its
 * thresholds or its smoothing that moves any number fails here, so feedback never changes quietly.
 * Regenerate deliberately with LAS_UPDATE_FIXTURES=1 and review the diff.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { movementDriftCases, record, type DriftRecord } from "./fixtures/movement/cases.js";

const FILE = fileURLToPath(new URL("./fixtures/movement/expected.json", import.meta.url));
const TOLERANCE = 1e-6;

function close(actual: number, expected: number, path: string) {
  expect(Math.abs(actual - expected), `${path}: ${actual} vs ${expected}`).toBeLessThanOrEqual(TOLERANCE * Math.max(1, Math.abs(expected)));
}

describe("movement engine results don't drift", () => {
  const actual = Object.fromEntries(Object.entries(movementDriftCases()).map(([k, a]) => [k, record(a)]));
  if (process.env.LAS_UPDATE_FIXTURES) writeFileSync(FILE, JSON.stringify(actual, null, 2) + "\n");
  const expected = JSON.parse(readFileSync(FILE, "utf8")) as Record<string, DriftRecord>;

  for (const [name, exp] of Object.entries(expected)) {
    it(`matches the stored results for ${name}`, () => {
      const got = actual[name];
      expect(got, name).toBeDefined();
      expect(Object.keys(got.metrics).sort()).toEqual(Object.keys(exp.metrics).sort());
      for (const [m, e] of Object.entries(exp.metrics)) {
        close(got.metrics[m].value, e.value, `${name}.${m}`);
        close(got.metrics[m].confidence, e.confidence, `${name}.${m}.confidence`);
        expect(got.metrics[m].per?.length).toBe(e.per?.length);
        e.per?.forEach((v, i) => close(got.metrics[m].per![i], v, `${name}.${m}.per[${i}]`));
      }
      expect(got.mistakes.map((m) => m.id)).toEqual(exp.mistakes.map((m) => m.id));
      exp.mistakes.forEach((m, i) => {
        if (m.share !== undefined) close(got.mistakes[i].share!, m.share, `${name}.${m.id}.share`);
        expect(got.mistakes[i].at.length).toBe(m.at.length);
        m.at.forEach((t, k) => close(got.mistakes[i].at[k], t, `${name}.${m.id}.at[${k}]`));
      });
      expect(got.segments.length).toBe(exp.segments.length);
      exp.segments.forEach(([s, e], i) => {
        close(got.segments[i][0], s, `${name}.segments[${i}]`);
        close(got.segments[i][1], e, `${name}.segments[${i}]`);
      });
    });
  }
});
