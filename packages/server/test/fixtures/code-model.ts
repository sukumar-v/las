import type { SkillModelInput } from "@las/schema";

/**
 * A second, very different test model: not physical, measured with code tests, quizzes and a typing task.
 * Test data only: it exists to prove that no rule in the loop depends on one kind of skill.
 */
export function codeModel(overrides: Partial<SkillModelInput> = {}): SkillModelInput {
  return {
    skill: "test coding skill",
    name: "Test coding",
    noun: "test coding",
    physical: false,
    engines: ["code", "knowledge", "interaction", "self-report"],
    why: [
      { id: "job", label: "Save time at work" },
      { id: "exam-prep", label: "Pass a course exam" },
      { id: "build", label: "Build my own tools" }
    ],
    pictures: [
      { id: "scripts", label: "Writing small scripts", why: ["job", "build"], ladderStep: 2, milestone: "A script that passes its tests", proof: "Tests pass on a small script", focus: { Reading: 40, Writing: 40, Typing: 20 } },
      { id: "course", label: "Passing the course", why: ["exam-prep"], ladderStep: 3, milestone: "Type code fluently for the exam", proof: "Type a snippet at 30 words a minute", focus: { Reading: 60, Writing: 30, Typing: 10 }, access: ["Course book"] }
    ],
    probes: [
      { id: "exp", type: "multi", question: "Which of these have you used?", max: 3, options: [{ value: "vars", label: "Variables" }, { value: "funcs", label: "Functions" }, { value: "loops", label: "Loops" }] },
      { id: "basics", type: "quiz", question: "A few quick questions.", spec: "basics-quiz" },
      { id: "try", type: "code", question: "Write one small function.", spec: "add-tests", optional: true }
    ],
    placement: [
      { when: "count(exp) >= 2 && basics.correct >= 3", step: 2, evidence: "Has written functions" },
      { when: "count(exp) >= 1 || basics.correct >= 2", step: 1 }
    ],
    ladder: [
      { id: "zero", label: "Brand new", hours: [0, 0] },
      { id: "read", label: "Read simple code", hours: [3, 5], nodes: ["values"], proof: { engine: "knowledge", spec: "basics-quiz", label: "Answer the reading questions", criteria: [{ id: "acc", label: "Most answers right", check: "accuracy >= 0.6" }] } },
      { id: "write", label: "Write a small function", hours: [6, 10], nodes: ["functions"], proof: { engine: "code", spec: "add-tests", label: "A function that passes its tests", criteria: [{ id: "tests", label: "All tests pass", check: "pass_rate >= 1" }] } },
      { id: "type", label: "Type code fluently", hours: [5, 8], nodes: ["typing"], proof: { engine: "interaction", spec: "typing-task", label: "Type a snippet at 30 wpm", criteria: [{ id: "wpm", label: "30 words a minute", check: "wpm >= 30" }] } },
      { id: "tool", label: "Build a small tool", hours: [15, 25], nodes: ["loops"], proof: { engine: "self-report", label: "Use your tool for a week", criteria: [{ id: "used", label: "Used it for a week", check: "done" }] } }
    ],
    nodes: [
      { id: "values", name: "Values", lesson: "values-lesson", drills: ["values-quiz"], review: { prompt: "What does x = 2 do?", kind: "choice", options: ["Stores 2", "Prints 2"], answer: 0 }, focus: "Reading" },
      { id: "functions", name: "Functions", requires: ["values"], lesson: "fn-lesson", drills: ["fn-quiz", "fn-build"], mistakes: ["no-return"], review: { prompt: "What does return do?", kind: "choice", options: ["Gives a value back", "Prints"], answer: 0 }, focus: "Writing" },
      { id: "typing", name: "Typing code", lesson: "type-lesson", drills: ["type-drill"], review: { prompt: "Which hand types the brackets?", kind: "recall" }, focus: "Typing" },
      { id: "loops", name: "Loops", requires: ["functions"], lesson: "fn-lesson", drills: ["fn-build"], review: { prompt: "When does a for loop stop?", kind: "recall" }, focus: "Writing" }
    ],
    lessons: [
      { id: "values-lesson", title: "Values", nodes: ["values"], cards: [{ type: "predict", text: "After x = 2, what is x + 1?", options: ["3", "21"], answer: 0 }] },
      { id: "fn-lesson", title: "Functions", nodes: ["functions"], cards: [{ type: "predict", text: "What comes back from a function with no return?", options: ["None", "Zero"], answer: 0 }, { type: "diagram", text: "Inputs in, one value out.", figure: { kind: "graph", nodes: [{ id: "a", label: "a, b" }, { id: "f", label: "add" }, { id: "r", label: "a + b" }], edges: [["a", "f"], ["f", "r"]] } }] },
      { id: "type-lesson", title: "Typing code", nodes: ["typing"], cards: [{ type: "predict", text: "Which is faster: looking at the keys or not?", options: ["Not looking", "Looking"], answer: 0 }] }
    ],
    drills: [
      { id: "values-quiz", type: "choice", title: "Read the values", nodes: ["values"], spec: "basics-quiz", minutes: 3, focus: "Reading" },
      { id: "fn-quiz", type: "predict-output", title: "What does it return?", nodes: ["functions"], spec: "fn-quiz", minutes: 3, focus: "Reading" },
      { id: "fn-build", type: "build", title: "Write add()", nodes: ["functions"], spec: "add-tests", success: "pass_rate >= 1", difficulty: { param: "tests", levels: ["basic", "edge cases", "hidden"] }, minutes: 8, focus: "Writing", fixes: ["no-return"] },
      { id: "type-drill", type: "tap-rhythm", title: "Type the snippet", nodes: ["typing"], spec: "typing-task", minutes: 3, focus: "Typing" }
    ],
    specs: {
      "basics-quiz": {
        kind: "items",
        items: [
          { type: "choice", id: "b1", prompt: "x = 2. What is x?", options: ["2", "x"], answer: 0, difficulty: 1, nodes: ["values"] },
          { type: "choice", id: "b2", prompt: "x = 2; x = x + 1. What is x?", options: ["2", "3"], answer: 1, difficulty: 2, nodes: ["values"] },
          { type: "choice", id: "b3", prompt: "Is '2' the same as 2?", options: ["Yes", "No"], answer: 1, difficulty: 3, nodes: ["values"] },
          { type: "choice", id: "b4", prompt: "x = [1, 2]. What is x[0]?", options: ["1", "2"], answer: 0, difficulty: 4, nodes: ["values"] }
        ]
      },
      "fn-quiz": {
        kind: "items",
        items: [
          { type: "predict-output", id: "f1", prompt: "What prints?", code: "def f():\n    return 1\nprint(f())", language: "python", options: ["1", "None"], answer: 0, nodes: ["functions"] },
          { type: "predict-output", id: "f2", prompt: "What prints?", code: "def f():\n    1\nprint(f())", language: "python", options: ["1", "None"], answer: 1, difficulty: 2, nodes: ["functions"] }
        ]
      },
      "add-tests": { kind: "test", language: "python", entry: "main.py", tests: [{ call: "add(1, 2)", expect: "3" }, { call: "add(0, 0)", expect: "0", hidden: true }] },
      "typing-task": { kind: "task", task: "type-text", content: ["def add(a, b):\n    return a + b"] }
    },
    mistakes: [
      { id: "no-return", name: "Missing return", nodes: ["functions"], engine: "code", detector: { metric: "pass_rate", when: "pass_rate < 1" }, severity: 2, explain: { figure: { kind: "code", language: "python", source: "def add(a, b):\n    a + b" } }, fix_drill: "fn-build", headline: "The function never gives a value back" }
    ],
    access: ["A computer"],
    focus: { Reading: 40, Writing: 40, Typing: 20 },
    key_metrics: [{ id: "passrate", label: "First-try pass rate", engine: "code", metric: "pass_rate", unit: "%", better: "higher", format: "percent" }],
    ...overrides
  };
}
