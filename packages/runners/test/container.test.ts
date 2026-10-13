import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { TestSpecSchema } from "@las/schema";
import { containerScript, detectContainerRuntime, parseContainerOutput, runContainer } from "../src/container.js";
import { assembleResult, buildHarness, planSteps } from "../src/harness.js";
import { which } from "../src/process.js";

const b64 = (s: string) => "b64:" + Buffer.from(s).toString("base64");

describe("container script output", () => {
  const spec = TestSpecSchema.parse({ language: "python", entry: "a.py", tests: [{ call: "f()", expect: "1" }, { stdin: "x", stdout: "x" }], limits: { time_s: 3 } });
  const steps = planSteps(spec, buildHarness(spec, { "a.py": "" }).command);

  it("splits the marked output back into step results", () => {
    const out = [
      "noise from the image",
      "##LAS## step hr 0 0",
      `##LAS## out ${b64("##LAS## begin 0\n1\n##LAS## end 0\n")}`,
      "##LAS## err ",
      "##LAS## step p1 137 3",
      `##LAS## out ${b64("partial")}`,
      `##LAS## err hex:${Buffer.from("killed").toString("hex")}`
    ].join("\n");
    const r = parseContainerOutput(out, steps);
    expect(r.hr).toMatchObject({ code: 0, stdout: "##LAS## begin 0\n1\n##LAS## end 0\n", stderr: "", timedOut: false });
    // exit 137 after the full time limit is the time limit, not a crash
    expect(r.p1).toMatchObject({ timedOut: true, stdout: "partial", stderr: "killed", ms: 3000 });
  });

  it("tells a crash from a time-out and reads skipped steps", () => {
    const r = parseContainerOutput(["##LAS## step hr 139 0", "##LAS## out ", "##LAS## err ", "##LAS## skip p1"].join("\n"), steps);
    expect(r.hr).toMatchObject({ code: null, signal: "SIGSEGV", timedOut: false });
    expect(r.p1.skipped).toBe(true);
  });
});

// The script is plain POSIX sh: run it here against temp folders to check what a container would do.
const canSh = process.platform !== "win32" && !!which("sh") && !!which("base64") && !!which("timeout") && !!which("python3");
(canSh ? describe : describe.skip)(`the container script under plain sh${canSh ? "" : " (skipped: needs sh, base64, timeout and python3)"}`, () => {
  it("runs the steps with their limits, skips dependants of failed steps and frames the output", () => {
    const spec = TestSpecSchema.parse({
      language: "python",
      entry: "a.py",
      tests: [{ call: "add(1, 2)", expect: "3" }, { call: "spin()", expect: "" }, { stdin: "Ada\n", stdout: "Hello, Ada!" }],
      limits: { time_s: 1 }
    });
    const src = "import sys\n\ndef add(a, b):\n    return a + b\n\ndef spin():\n    while True:\n        pass\n\nif __name__ == '__main__':\n    print('Hello, ' + sys.stdin.readline().strip() + '!')\n";
    const built = buildHarness(spec, { "a.py": src }, { tool: "python3" });
    const steps = planSteps(spec, built.command);
    const base = mkdtempSync(join(tmpdir(), "las-sh-"));
    try {
      const dirs = { src: join(base, "src"), work: join(base, "work"), tmp: join(base, "tmp") };
      for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
      const files: Record<string, string> = { ...built.files, "__las_run.sh": containerScript(steps, { vmLimitKb: 256 * 1024, ...dirs }) };
      for (const s of steps) if (s.stdin !== undefined) files[`.las_in/${s.id}.txt`] = s.stdin;
      for (const [p, c] of Object.entries(files)) {
        mkdirSync(dirname(join(dirs.src, p)), { recursive: true });
        writeFileSync(join(dirs.src, p), c);
      }
      const t0 = Date.now();
      const out = spawnSync("sh", [join(dirs.src, "__las_run.sh")], { encoding: "utf8", timeout: 30000 });
      expect(Date.now() - t0).toBeLessThan(10000);
      const results = parseContainerOutput(out.stdout, steps);
      expect(Object.keys(results).sort()).toEqual(["hr", "p2"]);
      const r = assembleResult(spec, built.command, results, "container");
      expect(r.tests.map((t) => t.pass)).toEqual([true, false, true]);
      expect(r.tests[1].error).toBe("timeout: stopped after 1 s");
      // the sources were copied, never changed in place
      expect(readFileSync(join(dirs.src, "a.py"), "utf8")).toBe(src);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("does not run a step whose build failed", () => {
    const spec = TestSpecSchema.parse({ language: "c", entry: "a.c", tests: [{ call: "f()", expect: "1" }] });
    const steps = [
      { id: "hc0", argv: ["sh", "-c", "echo 'a.c:1:1: error: nope' >&2; exit 1"], merge: true, limited: false, timeoutS: 5, after: [] },
      { id: "hr", argv: ["sh", "-c", "echo should-not-run"], merge: true, limited: true, timeoutS: 5, after: ["hc0"] }
    ];
    const base = mkdtempSync(join(tmpdir(), "las-sh-"));
    try {
      const dirs = { src: join(base, "src"), work: join(base, "work"), tmp: join(base, "tmp") };
      for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
      writeFileSync(join(dirs.src, "run.sh"), containerScript(steps, { vmLimitKb: 0, ...dirs }));
      const out = spawnSync("sh", [join(dirs.src, "run.sh")], { encoding: "utf8", timeout: 30000 });
      const results = parseContainerOutput(out.stdout, steps);
      expect(results.hc0).toMatchObject({ code: 1, stdout: "a.c:1:1: error: nope\n" });
      expect(results.hr.skipped).toBe(true);
      const r = assembleResult(spec, buildHarness(spec, { "a.c": "" }).command, results, "container");
      expect(r.compiled?.ok).toBe(false);
      expect(r.tests[0].error).toBe("compile: a.c:1:1: error: nope");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

const runtime = detectContainerRuntime();
(runtime ? describe : describe.skip)(`runContainer with a real container runtime${runtime ? ` (${runtime})` : " (skipped: neither podman nor docker is working here)"}`, () => {
  it(
    "runs the Python fixture with no network and a read-only copy of the files",
    async () => {
      const dir = join(import.meta.dirname, "fixtures", "python");
      const raw = JSON.parse(readFileSync(join(dir, "spec.json"), "utf8"));
      const r = await runContainer(TestSpecSchema.parse(raw), { "solution.py": readFileSync(join(dir, "solution.py"), "utf8") }, { runtime: runtime! });
      expect(r.error).toBeUndefined();
      expect(r.runner).toBe("container");
      expect(r.tests.map((t) => t.pass)).toEqual([true, true, true, false, false, true]);
    },
    900_000
  );
});
