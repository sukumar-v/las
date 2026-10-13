import { describe, expect, it } from "vitest";
import { AnalysisSchema, SelfReportSpecSchema } from "@las/schema";
import { analyzeSelfReport } from "../src/self-report/index.js";

const spec = SelfReportSpecSchema.parse({ fields: ["minutes", "effort", "felt", "pain", "done", "count", "note"], pass: "done == 1 && minutes >= 20" });

describe("self-report", () => {
  it("copies the fields into metrics and labels the result self-report", () => {
    const a = analyzeSelfReport(spec, { fields: { minutes: 25, effort: 7, felt: 4, pain: 0, done: true, count: 12, note: "went fine" } });
    expect(AnalysisSchema.safeParse(a).success).toBe(true);
    expect(a.precision).toBe("self-report");
    expect(a.engine).toBe("self-report");
    expect(Object.fromEntries(Object.entries(a.metrics).map(([k, m]) => [k, m.value]))).toEqual({ minutes: 25, effort: 7, felt: 4, pain: 0, count: 12, done: 1 });
    expect(a.metrics.minutes.unit).toBe("min");
    expect(a.criteria.pass).toBe(true);
    expect(a.quality.ok).toBe(true);
    expect(a.quality.issues).toEqual([]);
  });

  it("is never a mistake, even for high effort or pain", () => {
    const a = analyzeSelfReport(spec, { fields: { minutes: 5, effort: 10, felt: 1, pain: 8, done: false } });
    expect(a.mistakes).toEqual([]);
    expect(a.praise).toBeUndefined();
    expect(a.criteria.pass).toBe(false);
  });

  it("adds a quality issue for pain of 3 or more, and none below", () => {
    expect(analyzeSelfReport(spec, { fields: { pain: 3 } }).quality.issues).toContain("pain reported");
    expect(analyzeSelfReport(spec, { fields: { pain: 2 } }).quality.issues).not.toContain("pain reported");
    // pain is read even when the spec didn't ask for it
    const quiet = SelfReportSpecSchema.parse({ fields: ["minutes"] });
    expect(analyzeSelfReport(quiet, { fields: { minutes: 10, pain: 5 } }).quality.issues).toContain("pain reported");
  });

  it("accepts numbers written as text and yes/no words for done", () => {
    const a = analyzeSelfReport(spec, { fields: { minutes: "30", effort: " 6 ", done: "yes" } });
    expect(a.metrics.minutes.value).toBe(30);
    expect(a.metrics.effort.value).toBe(6);
    expect(a.metrics.done.value).toBe(1);
    expect(analyzeSelfReport(spec, { fields: { done: "no" } }).metrics.done.value).toBe(0);
  });

  it("lists asked-for fields that were not answered, without failing", () => {
    const a = analyzeSelfReport(SelfReportSpecSchema.parse({ fields: ["minutes", "effort", "note"] }), { fields: { minutes: 10 } });
    expect(a.quality.ok).toBe(true);
    expect(a.quality.issues).toEqual(["not answered: effort"]);
    expect(a.metrics.effort).toBeUndefined();
  });

  it("leaves pass out when the spec has none, and evaluates ctx proof criteria", () => {
    const plain = SelfReportSpecSchema.parse({});
    const a = analyzeSelfReport(plain, { fields: { minutes: 15, effort: 5, felt: 3 } }, { criteria: { practiced: "minutes >= 10", easy: "effort <= 3" } } as any);
    expect(a.criteria).toEqual({ practiced: true, easy: false });
  });

  it("stamps the version with the spec id", () => {
    expect(analyzeSelfReport(spec, { fields: {} }, { specId: "sr1", modelVersion: 2 }).version).toBe("self-report@0.1.0/sr1@v2");
  });
});
