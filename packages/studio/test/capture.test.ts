import { describe, expect, it } from "vitest";
import { evidenceToJson, fixtureEvidence, jsonSize, reviveEvidence } from "../src/capture/fixture.js";
import { frameDifference, meanLuminance, MotionWindow, neededPoints, ReadyGate, HOLD_MS } from "../src/capture/framing.js";
import { fitWithin, needsOcr } from "../src/capture/visual.js";
import { criteriaOf } from "../src/capture/pipeline.js";
import { runsInBrowser, starterFiles, testRows } from "../src/capture/code.js";
import { base64UrlToBytes } from "../src/push.js";
import { frameAt, overlayMarks } from "../src/screens/replay.js";

describe("framing guide", () => {
  it("needs a full second with every point visible, light and steadiness", () => {
    const g = new ReadyGate();
    const ok = { share: 1, allVisible: true, light: true, steady: true };
    expect(g.update(0, ok).ready).toBe(false);
    expect(g.update(HOLD_MS - 1, ok).ready).toBe(false);
    expect(g.update(HOLD_MS, ok).ready).toBe(true);
    expect(g.update(HOLD_MS + 10, { ...ok, steady: false }).ready).toBe(false);
    // losing a point restarts the second
    g.update(HOLD_MS + 20, { ...ok, allVisible: false, share: 0.5 });
    expect(g.update(HOLD_MS + 500, ok).ready).toBe(false);
    expect(g.update(HOLD_MS + 500 + HOLD_MS, ok).ready).toBe(true);
  });
  it("reads the points a metric spec measures", () => {
    const pts = neededPoints({ segment: { by: "reps", signal: "left_hip.y" }, metrics: { knee: "min(angle(left_hip, left_knee, left_ankle)) per rep" } } as any);
    expect(pts.sort()).toEqual(["left_ankle", "left_hip", "left_knee"]);
    expect(neededPoints({ requires_visible: ["legs"], metrics: {} } as any)).toEqual(["legs"]);
  });
  it("measures light and frame-to-frame motion", () => {
    const dark = new Uint8ClampedArray(16 * 4).fill(10);
    const light = new Uint8ClampedArray(16 * 4).fill(200);
    expect(meanLuminance(dark, 1)).toBeLessThan(0.1);
    expect(meanLuminance(light, 1)).toBeGreaterThan(0.7);
    expect(frameDifference(dark, dark, 1)).toBe(0);
    expect(frameDifference(dark, light, 1)).toBeGreaterThan(0.5);
    const m = new MotionWindow();
    for (let i = 0; i < 10; i++) m.push(i * 50, 0.01, 0, 0);
    expect(m.has && m.steady()).toBe(true);
    for (let i = 10; i < 20; i++) m.push(i * 50, i % 2 ? 4 : -4, 0, 0);
    expect(m.steady()).toBe(false);
  });
});

describe("fixture hook and evidence", () => {
  it("revives typed arrays and turns them back into JSON", () => {
    const e = reviveEvidence({ samples: [0.1, -0.2], sampleRate: 8000, pixels: { width: 1, height: 1, data: [1, 2, 3, 255] } });
    expect(e.samples).toBeInstanceOf(Float32Array);
    expect(e.pixels.data).toBeInstanceOf(Uint8ClampedArray);
    const j = evidenceToJson(e);
    expect(Array.isArray(j.samples)).toBe(true);
    expect(j.pixels.data).toEqual([1, 2, 3, 255]);
    expect(jsonSize(j)).toBeGreaterThan(10);
  });
  it("uses window.__lasFixture only when a test sets it", () => {
    expect(fixtureEvidence("movement")).toBeUndefined();
    (globalThis as any).window = { __lasFixture: { evidence: { audio: { samples: [0, 1], sampleRate: 2 } } } };
    try {
      expect(fixtureEvidence<any>("audio").samples).toBeInstanceOf(Float32Array);
      expect(fixtureEvidence("movement")).toBeUndefined();
    } finally {
      delete (globalThis as any).window;
    }
  });
  it("passes the milestone's proof criteria to the analysis", () => {
    expect(criteriaOf({ attempt: { spec: { criteria: [{ id: "depth", check: "share(ok) >= 0.8" }] } } } as any)).toEqual({ depth: "share(ok) >= 0.8" });
    expect(criteriaOf({ attempt: { spec: {} } } as any)).toBeUndefined();
  });
});

describe("photos, code and push helpers", () => {
  it("downscales photos to 1024 px at most", () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: 1024, height: 768 });
    expect(fitWithin(500, 300)).toEqual({ width: 500, height: 300 });
    expect(needsOcr({ criteria: [{ measure: "text(title)" }] })).toBe(true);
    expect(needsOcr({ criteria: [{ measure: "exposure()" }] })).toBe(false);
  });
  it("runs in the browser only where the language and the spec allow it", () => {
    const tests = [{ call: "f()", expect: "1", hidden: false }, { call: "g()", expect: "2", hidden: true }];
    expect(runsInBrowser({ language: "javascript", runner: ["browser", "local"], tests } as any)).toBe(true);
    expect(runsInBrowser({ language: "javascript", runner: ["local"], tests } as any)).toBe(false);
    expect(runsInBrowser({ language: "rust", runner: ["browser", "local"], tests } as any)).toBe(false);
    expect(starterFiles({ entry: "main.js" } as any)).toEqual({ "main.js": "" });
    const rows = testRows({ tests } as any, { tests: [{ pass: true }, { pass: false }] } as any);
    expect(rows).toEqual([{ label: "f() → 1", pass: true }, { label: "hidden test", pass: false }]);
  });
  it("decodes VAPID keys", () => {
    expect([...base64UrlToBytes("AQID_w")]).toEqual([1, 2, 3, 255]);
  });
});

describe("replay helpers", () => {
  const frames = [0, 0.5, 1, 1.5].map((t) => ({ t, pose: { left_hip: [t, 0.5, 0, 1] as [number, number, number, number] } }));
  it("finds the body points nearest the scrub time", () => {
    expect(frameAt(frames, 0.7)?.t).toBe(0.5);
    expect(frameAt(frames, 0.8)?.t).toBe(1);
    expect(frameAt([], 1)).toBeUndefined();
  });
  it("turns the engine's marks into overlay marks near the time", () => {
    const overlay = { marks: [{ mistake: "m", t: 1, draw: "arc", points: ["a", "b", "c"], coords: [[0, 0], [0.5, 0.5], [1, 1]], value: 104 }, { mistake: "m", t: 5, draw: "line", points: [], coords: [[0, 0], [1, 1]] }] };
    const near = overlayMarks(overlay, 1.2);
    expect(near.marks).toEqual([{ kind: "arc", role: "attention", points: [[0, 0], [0.5, 0.5], [1, 1]], degrees: 104 }]);
    expect(overlayMarks(overlay, 3).marks).toEqual([]);
  });
});
