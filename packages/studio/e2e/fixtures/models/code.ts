import { buildModel } from "./common.js";

/** Code: a small JavaScript function run in the browser sandbox, plus a drill pinned to the local toolchain. */
export const codeModel = buildModel({
  skill: "e2e code skill",
  name: "Test functions",
  noun: "test functions",
  physical: false,
  engine: "code",
  perform: { id: "build-add", type: "build", title: "Write add()", prompt: "Write add(a, b)", spec: "add-tests" },
  specs: {
    "add-tests": { kind: "test", language: "javascript", entry: "main.js", tests: [{ call: "add(1, 2)", expect: "3" }, { call: "add(2, 2)", expect: "4" }], runner: ["browser"], starter: { "main.js": "function add(a, b) {\n  return a - b;\n}\n" } },
    "local-tests": { kind: "test", language: "javascript", entry: "main.js", tests: [{ call: "twice(2)", expect: "4" }], runner: ["local"], starter: { "main.js": "function twice(x) {\n  return x * 2;\n}\n" } }
  },
  mistake: { id: "wrong-output", name: "Wrong output", metric: "pass_rate", when: "pass_rate < 1", headline: "add() gives the wrong answer" },
  key_metric: { id: "passrate", label: "Tests passed", metric: "pass_rate", unit: "%", better: "higher", format: "percent" },
  proof: { label: "add() passes its tests", criteria: [{ id: "tests", label: "All tests pass", check: "pass_rate >= 1" }] },
  extra: {}
});
// a drill on its own node (off the first milestone's path) that runs on this computer's toolchain
codeModel.nodes.push({ id: "local", name: "Local runs", requires: ["basics"], lesson: "basics-lesson", drills: ["local-build"], review: { prompt: "Where does it run?", kind: "choice", options: ["Here", "Nowhere"], answer: 0 } } as any);
codeModel.ladder[3].nodes = [...(codeModel.ladder[3].nodes ?? []), "local"];
codeModel.drills.push({ id: "local-build", type: "build", title: "Write twice()", prompt: "Write twice(x)", nodes: ["local"], spec: "local-tests", minutes: 5 } as any);
