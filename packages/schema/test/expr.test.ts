import { describe, expect, it } from "vitest";
import { evalWith, parseExpr, parseMetricExpr, series, isSeries, checkExpr, STANDARD_FUNCTIONS, type Series } from "../src/index.js";

describe("expression language", () => {
  it("parses arithmetic with precedence", () => {
    expect(evalWith(parseExpr("1 + 2 * 3"), {})).toBe(7);
    expect(evalWith(parseExpr("(1 + 2) * 3"), {})).toBe(9);
    expect(evalWith(parseExpr("-2 * -3"), {})).toBe(6);
    expect(evalWith(parseExpr("7 % 3"), {})).toBe(1);
  });
  it("compares and combines booleans", () => {
    expect(evalWith(parseExpr("3 >= 2 && !(1 == 2)"), {})).toBe(true);
    expect(evalWith(parseExpr("1 > 2 or 2 > 1"), {})).toBe(true);
    expect(evalWith(parseExpr("not true"), {})).toBe(false);
    expect(evalWith(parseExpr("'V2' >= 'V1'"), {})).toBe(true);
    expect(evalWith(parseExpr("grade >= 'V2'"), { grade: "V3" })).toBe(true);
  });
  it("reads members and indexes", () => {
    expect(evalWith(parseExpr("baseline.torso * 1.4"), { baseline: { torso: 10 } })).toBeCloseTo(14);
    expect(evalWith(parseExpr("moves[1]"), { moves: ["a", "b"] })).toBe("b");
    expect(evalWith(parseExpr("contains(moves, 'Flagging')"), { moves: ["Flagging"] })).toBe(true);
    expect(evalWith(parseExpr("data.0"), { data: [5, 6] })).toBe(5);
  });
  it("lifts arithmetic and comparison over series", () => {
    const s = series([100, 160, 170]);
    const out = evalWith(parseExpr("s > 150"), { s });
    expect(isSeries(out)).toBe(true);
    expect(Array.from((out as Series).values)).toEqual([0, 1, 1]);
    expect(evalWith(parseExpr("share(s > 150)"), { s })).toBeCloseTo(2 / 3);
    expect(evalWith(parseExpr("min(s)"), { s })).toBe(100);
    expect(evalWith(parseExpr("mean(s) / 10"), { s })).toBeCloseTo(14.33, 1);
    expect(evalWith(parseExpr("range(s)"), { s })).toBe(70);
  });
  it("supports named arguments and lists", () => {
    const calls: unknown[] = [];
    evalWith(parseExpr("pose_similarity(reference, joints: [legs, hips], align: dtw)"), { reference: 1, legs: "legs", hips: "hips", dtw: "dtw" }, {
      pose_similarity: (args, named) => {
        calls.push([args, named]);
        return 0.9;
      }
    });
    expect(calls[0]).toEqual([[1], { joints: ["legs", "hips"], align: "dtw" }]);
  });
  it("parses metric clauses", () => {
    const m = parseMetricExpr("min(angle(left_hip, left_knee, left_ankle)) per rep");
    expect(m.per).toBe("rep");
    expect(m.expr.kind).toBe("call");
    expect(parseMetricExpr("angle(a, b, vertical) at bottom").at).toBe("bottom");
  });
  it("reports syntax errors with positions", () => {
    expect(checkExpr("1 +")).toMatch(/unexpected token/);
    expect(checkExpr("foo(")).toMatch(/unexpected token/);
    expect(checkExpr("\"open")).toMatch(/unterminated/);
    expect(checkExpr("1 2")).toMatch(/trailing/);
  });
  it("refuses unknown names and functions at runtime", () => {
    expect(() => evalWith(parseExpr("nope + 1"), {})).toThrow(/unknown name/);
    expect(() => evalWith(parseExpr("explode(1)"), {})).toThrow(/unknown function/);
    expect(Object.keys(STANDARD_FUNCTIONS)).not.toContain("eval");
  });
  it("has no access to the host", () => {
    expect(() => evalWith(parseExpr("constructor.constructor('return 1')()"), {})).toThrow();
    expect(() => evalWith(parseExpr("x.__proto__"), { x: {} })).toThrow(/unknown property/);
  });
});
