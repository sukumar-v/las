import { describe, expect, it } from "vitest";
import { TestSpecSchema, type TestSpecInput } from "@las/schema";
import { selectRunner } from "../src/select.js";
import type { RunnerCaps } from "../src/types.js";

const spec = (extra: Partial<TestSpecInput> = {}) => TestSpecSchema.parse({ language: "python", entry: "a.py", tests: [{ call: "f()", expect: "1" }], ...extra });
const none: RunnerCaps = { browser: [], local: [], container: { available: false, consented: false } };

describe("selectRunner", () => {
  it("takes the first runner in the spec's order that is available", () => {
    const caps: RunnerCaps = { browser: ["python"], local: [{ language: "python", tool: "python3", consented: true }], container: { available: true, consented: true } };
    expect(selectRunner(spec(), caps)).toMatchObject({ runner: "browser", needsConsent: false });
    expect(selectRunner(spec({ runner: ["local", "browser"] }), caps)).toMatchObject({ runner: "local", needsConsent: false });
    expect(selectRunner(spec({ runner: ["container"] }), caps)).toMatchObject({ runner: "container", needsConsent: false });
  });

  it("reports when the learner still has to agree to a runner's first use", () => {
    const caps: RunnerCaps = { ...none, local: [{ language: "python", tool: "python3", consented: false }] };
    const c = selectRunner(spec(), caps);
    expect(c).toMatchObject({ runner: "local", needsConsent: true });
    expect(c.reason).toMatch(/python3/);
    expect(selectRunner(spec({ runner: ["container"] }), { ...none, container: { available: true, consented: false } })).toMatchObject({ runner: "container", needsConsent: true });
  });

  it("skips the browser for languages without a browser runtime and for native test files", () => {
    const caps: RunnerCaps = { browser: ["python", "rust"], local: [{ language: "rust", tool: "rustc", consented: true }], container: { available: false, consented: false } };
    const rust = TestSpecSchema.parse({ language: "rust", entry: "lib.rs", tests: [{ call: "f()", expect: "1" }] });
    expect(selectRunner(rust, caps)).toMatchObject({ runner: "local" });
    const native = spec({ tests: [{ native: "test_a.py" }] });
    expect(selectRunner(native, { ...caps, local: [] })).toEqual({ runner: null, reason: expect.stringContaining("native test files need a local toolchain or a container") });
  });

  it("explains every reason when nothing can run", () => {
    const c = selectRunner(TestSpecSchema.parse({ language: "zig", entry: "a.zig", tests: [{ call: "f()", expect: "1" }] }), none);
    expect(c.runner).toBeNull();
    expect(c.reason).toBe("Zig has no browser runtime; no Zig toolchain is installed on this computer; no container runtime (Podman or Docker Engine) is available");
  });

  it("only uses a local toolchain for the spec's own language", () => {
    const c = selectRunner(spec({ runner: ["local"] }), { ...none, local: [{ language: "ruby", tool: "ruby", consented: true }] });
    expect(c.runner).toBeNull();
  });
});
