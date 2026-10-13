import { describe, expect, it } from "vitest";
import { validateSkillModel, type Capabilities } from "../src/index.js";
import { minimalModel } from "./fixtures/minimal-model.js";

const caps = (available: string[]): Capabilities => ({
  version: "test",
  platform: { os: "linux", arch: "x64", node: "22" },
  engines: ["movement", "audio", "speech", "code", "visual", "knowledge", "interaction", "sensor", "game", "self-report"].map((id) => ({ id: id as any, available: available.includes(id), models: [], backend: "wasm" })),
  runners: { browser: ["javascript"], local: [], container: { available: false, consented: false } },
  devices: { camera: true, microphone: true, motion: false, phone: false, studio: true },
  external: [],
  localModels: [],
  widgets: false,
  studioUrl: "http://127.0.0.1:4711"
});

describe("validateSkillModel", () => {
  it("passes a minimal valid model", () => {
    const r = validateSkillModel(minimalModel(), caps(["movement", "knowledge"]));
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.summary?.ladderSteps).toBe(4);
  });
  it("fails when a proof's engine is unavailable and no fallback is named", () => {
    const r = validateSkillModel(minimalModel(), caps(["knowledge"]));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.check === "capabilities")).toBe(true);
  });
  it("accepts a self-report fallback when the engine is missing, with a warning", () => {
    const m = minimalModel();
    for (const s of m.ladder) if (s.proof?.engine === "movement") s.proof.fallback = "self-report";
    const r = validateSkillModel(m, caps(["knowledge"]));
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.check === "capabilities")).toBe(true);
  });
  it("catches cycles and unreachable nodes", () => {
    const m = minimalModel();
    m.nodes[0].requires = ["brace"];
    const r = validateSkillModel(m);
    expect(r.errors.some((e) => /cycle/.test(e.message))).toBe(true);
    const m2 = minimalModel();
    m2.nodes.push({ id: "orphan", name: "Orphan", lesson: "setup-lesson", drills: ["setup-quiz"], review: { prompt: "?", options: ["a", "b"], answer: 0 } });
    expect(validateSkillModel(m2).errors.some((e) => /not on the path/.test(e.message))).toBe(true);
  });
  it("requires proofs bound to specs of the right engine", () => {
    const m = minimalModel();
    (m.ladder[1].proof as any).spec = "placement-quiz";
    const r = validateSkillModel(m);
    expect(r.errors.some((e) => /is for knowledge, not movement/.test(e.message))).toBe(true);
    const m2 = minimalModel();
    delete (m2.ladder[2] as any).proof;
    expect(validateSkillModel(m2).errors.some((e) => e.check === "proof")).toBe(true);
  });
  it("enforces word budgets and headline length", () => {
    const m = minimalModel();
    m.mistakes![0].headline = "one two three four five six seven eight nine";
    m.lessons[0].cards![0].text = "a ".repeat(30).trim();
    const r = validateSkillModel(m);
    expect(r.errors.filter((e) => e.check === "word-budget").length).toBeGreaterThanOrEqual(2);
  });
  it("requires safety fields for physical skills and flags supervised-only activities", () => {
    const m = minimalModel();
    delete (m as any).safety;
    expect(validateSkillModel(m).errors.some((e) => e.check === "safety")).toBe(true);
    const m2 = minimalModel({ skill: "freediving", name: "Freediving breath-hold" });
    const r2 = validateSkillModel(m2);
    expect(r2.errors.some((e) => /supervised_only/.test(e.path))).toBe(true);
    m2.safety!.supervised_only = ["breath-holding and anything underwater"];
    expect(validateSkillModel(m2).errors.some((e) => /supervised_only/.test(e.path))).toBe(false);
  });
  it("checks that drills use specs for the right engine", () => {
    const m = minimalModel();
    m.drills[1].spec = "placement-quiz";
    expect(validateSkillModel(m).errors.some((e) => /scored by movement/.test(e.message))).toBe(true);
  });
  it("rejects schema violations like a non-standard drill type", () => {
    const m = minimalModel();
    (m.drills[0] as any).type = "freestyle";
    const r = validateSkillModel(m);
    expect(r.ok).toBe(false);
    expect(r.errors[0].check).toBe("schema");
  });
});
