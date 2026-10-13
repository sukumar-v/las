import { recordFallbacks, type Scenario } from "../src/harness.js";

/** Rust from zero to a small CLI: tests run on the local toolchain (or a container); predict-output quizzes otherwise. */
export const rust: Scenario = {
  id: "rust",
  skill: "Rust",
  notes: "Writes Python at work. Wants to build fast command-line tools in Rust.",
  expect: { engines: ["code"], main: "code", fallback: "knowledge", physical: false, supervisedOnly: [] },
  build: (draft) => ({
    skill: "Rust",
    name: "Rust",
    noun: "Rust",
    source: "generated",
    physical: false,
    engines: ["code", "knowledge", "self-report"],
    fallbacks: recordFallbacks(draft, { code: "knowledge" }),
    why: [
      { id: "tools", label: "Build fast CLI tools" },
      { id: "job", label: "A systems job" },
      { id: "safety", label: "Understand memory safety" },
      { id: "oss", label: "Contribute to open source" }
    ],
    pictures: [
      { id: "cli", label: "A word-count CLI I use daily", why: ["tools", "oss"], ladderStep: 5, milestone: "A CLI that parses input and handles errors", proof: "Hidden tests pass on the parser, errors included", focus: { Fundamentals: 30, Writing: 50, Reading: 20 } },
      { id: "borrow", label: "Reading Rust without fighting the borrow checker", why: ["safety", "job"], ladderStep: 2, milestone: "Explain moves and borrows", proof: "Ownership tests pass", focus: { Fundamentals: 50, Writing: 25, Reading: 25 } },
      { id: "iter", label: "Writing idiomatic iterator code", why: ["job", "oss"], ladderStep: 4, milestone: "Solve a task with iterators", proof: "Iterator tests pass without index loops", focus: { Fundamentals: 30, Writing: 45, Reading: 25 } }
    ],
    probes: [
      { id: "langs", type: "multi", question: "Which of these have you used?", options: [{ value: "python", label: "Python or JavaScript" }, { value: "c", label: "C or C++" }, { value: "rust", label: "Some Rust" }] },
      { id: "basics", type: "quiz", question: "What does this Rust print?", spec: "rust-predict" },
      { id: "try", type: "code", question: "Write one small function. Optional.", spec: "count-words", optional: true }
    ],
    placement: [
      { when: "!fresh && contains(langs, 'rust') && quiz.correct >= 3", step: 3, evidence: "Reads Rust already" },
      { when: "contains(langs, 'c') || quiz.correct >= 2", step: 1, evidence: "Knows another language well" }
    ],
    ladder: [
      { id: "start", label: "Brand new to Rust", hours: [0, 0] },
      { id: "basics", label: "Variables, functions, loops", hours: [3, 6], nodes: ["bindings"],
        proof: { engine: "code", spec: "count-words", label: "count_words passes every test, hidden ones too", criteria: [{ id: "tests", label: "All tests pass", check: "pass_rate >= 1 && compiled" }], fallback: "knowledge", fallback_spec: "rust-predict" } },
      { id: "ownership", label: "Ownership and borrowing", hours: [6, 12], nodes: ["ownership"],
        proof: { engine: "code", spec: "longest-len", label: "Borrowing functions compile and pass their tests", criteria: [{ id: "tests", label: "All tests pass", check: "pass_rate >= 1 && compiled" }], fallback: "knowledge", fallback_spec: "rust-predict" } },
      { id: "enums", label: "Enums, Option and match", hours: [5, 10], nodes: ["option-match"],
        proof: { engine: "code", spec: "find-first", label: "Option-returning search passes its tests", criteria: [{ id: "tests", label: "All tests pass", check: "pass_rate >= 1" }], fallback: "knowledge", fallback_spec: "rust-predict" } },
      { id: "iterators", label: "Iterators and closures", hours: [6, 12], nodes: ["iterators"],
        proof: { engine: "code", spec: "word-freq", label: "Word frequency with iterators, tests pass, no clippy warnings", criteria: [{ id: "tests", label: "All tests pass", check: "pass_rate >= 1" }, { id: "lint", label: "Clippy clean", check: "lint_findings == 0" }], fallback: "knowledge", fallback_spec: "rust-predict" } },
      { id: "errors", label: "Errors with Result and ?", hours: [8, 16], nodes: ["results"],
        proof: { engine: "code", spec: "parse-sum", label: "The parser passes hidden tests, bad input included", criteria: [{ id: "tests", label: "All tests pass", check: "pass_rate >= 1" }, { id: "hidden", label: "Hidden tests pass", check: "hidden_passed >= 2" }], fallback: "knowledge", fallback_spec: "rust-predict" } }
    ],
    nodes: [
      { id: "bindings", name: "Bindings and functions", lesson: "bindings-lesson", drills: ["bindings-quiz", "count-build"], mistakes: ["mut-missing"], review: { prompt: "Can you change a plain let binding?", kind: "choice", options: ["No, add mut", "Yes"], answer: 0 }, focus: "Fundamentals" },
      { id: "ownership", name: "Ownership", requires: ["bindings"], lesson: "ownership-lesson", drills: ["ownership-predict", "borrow-build"], mistakes: ["use-after-move"], review: { prompt: "After let b = a; for a String, can you use a?", kind: "choice", options: ["No, it moved", "Yes"], answer: 0 }, focus: "Fundamentals" },
      { id: "option-match", name: "Option and match", requires: ["ownership"], lesson: "option-lesson", drills: ["find-build"], review: { prompt: "What replaces null in Rust?", kind: "choice", options: ["Option", "0"], answer: 0 }, focus: "Writing" },
      { id: "iterators", name: "Iterators", requires: ["option-match"], lesson: "iter-lesson", drills: ["iter-predict", "freq-build"], review: { prompt: "Does map run before collect?", kind: "choice", options: ["No, iterators are lazy", "Yes"], answer: 0 }, focus: "Writing" },
      { id: "results", name: "Result and ?", requires: ["iterators"], lesson: "result-lesson", drills: ["parse-build"], review: { prompt: "What does ? do on an Err?", kind: "choice", options: ["Returns it early", "Panics"], answer: 0 }, focus: "Writing" }
    ],
    lessons: [
      { id: "bindings-lesson", title: "Bindings", nodes: ["bindings"], cards: [
        { type: "predict", text: "let x = 5; x = 6; Does it compile?", options: ["No", "Yes"], answer: 0, reveal: "Bindings are immutable unless marked mut." },
        { type: "diagram", text: "mut makes a binding changeable.", figure: { kind: "code", language: "rust", source: "let mut total = 0;\nfor n in 1..=3 {\n    total += n;\n}", trace: [{ line: 1, vars: { total: "0", n: "-" } }, { line: 3, vars: { total: "1", n: "1" } }, { line: 3, vars: { total: "3", n: "2" } }, { line: 3, vars: { total: "6", n: "3" } }] } }
      ] },
      { id: "ownership-lesson", title: "Ownership", nodes: ["ownership"], cards: [
        { type: "predict", text: "let b = a; with a String. Who owns it now?", options: ["b", "Both"], answer: 0 },
        { type: "demo", text: "A move hands the String over; a borrow lends it.", figure: { kind: "code", language: "rust", source: "let a = String::from(\"hi\");\nlet len = len_of(&a); // borrow\nlet b = a;            // move\n// a can't be used here", trace: [{ line: 1, vars: { a: "owner", b: "-" } }, { line: 2, vars: { a: "owner (lent)", b: "-" } }, { line: 3, vars: { a: "moved", b: "owner" } }] }, playback: "steps" },
        { type: "compare", text: "Tap the code that uses a moved value.", left: { kind: "code", language: "rust", source: "let b = a.clone();\nprintln!(\"{a}\");" }, right: { kind: "code", language: "rust", source: "let b = a;\nprintln!(\"{a}\");" }, answer: "right" }
      ] },
      { id: "option-lesson", title: "Option and match", nodes: ["option-match"], cards: [
        { type: "predict", text: "Searching an empty list returns...", options: ["None", "A crash"], answer: 0 },
        { type: "diagram", text: "match makes you handle both cases.", figure: { kind: "code", language: "rust", source: "match find_first(&v, 3) {\n    Some(i) => println!(\"at {i}\"),\n    None => println!(\"missing\"),\n}" } }
      ] },
      { id: "iter-lesson", title: "Iterators", nodes: ["iterators"], cards: [
        { type: "predict", text: "v.iter().map(|x| x * 2) alone: does it double anything?", options: ["No, it's lazy", "Yes"], answer: 0 },
        { type: "diagram", text: "Each step feeds the next; collect runs them.", figure: { kind: "graph", nodes: [{ id: "i", label: "iter()" }, { id: "f", label: "filter" }, { id: "m", label: "map" }, { id: "c", label: "collect" }], edges: [["i", "f"], ["f", "m"], ["m", "c"]] } }
      ] },
      { id: "result-lesson", title: "Result and ?", nodes: ["results"], cards: [
        { type: "predict", text: "\"x\".parse::<i32>() returns...", options: ["Err", "0"], answer: 0 },
        { type: "demo", text: "? returns the error early; otherwise unwraps.", figure: { kind: "code", language: "rust", source: "fn sum_numbers(s: &str) -> Result<i32, ParseIntError> {\n    let mut t = 0;\n    for p in s.split(',') { t += p.trim().parse::<i32>()?; }\n    Ok(t)\n}" }, playback: "steps" }
      ] }
    ],
    drills: [
      { id: "bindings-quiz", type: "predict-output", title: "What prints?", prompt: "Read the code and pick the output.", nodes: ["bindings"], spec: "rust-predict", minutes: 3, intensity: 1, focus: "Reading" },
      { id: "count-build", type: "build", title: "count_words", prompt: "Write count_words: the number of whitespace-separated words.", nodes: ["bindings"], spec: "count-words", success: "pass_rate >= 1", difficulty: { param: "tests", levels: ["basic", "edge cases", "hidden"] }, minutes: 10, intensity: 1, focus: "Writing", fixes: ["mut-missing"] },
      { id: "ownership-predict", type: "predict-output", title: "Does it compile?", prompt: "Pick what happens.", nodes: ["ownership"], spec: "rust-predict", minutes: 3, intensity: 1, focus: "Reading" },
      { id: "borrow-build", type: "build", title: "Borrow, don't move", prompt: "Write longest_len taking a slice of &str, without taking ownership.", nodes: ["ownership"], spec: "longest-len", success: "pass_rate >= 1 && compiled", difficulty: { param: "tests", levels: ["basic", "hidden"] }, minutes: 12, intensity: 1, focus: "Writing", fixes: ["use-after-move"] },
      { id: "find-build", type: "build", title: "find_first", prompt: "Return Some(index) of the first match, or None.", nodes: ["option-match"], spec: "find-first", success: "pass_rate >= 1", minutes: 10, intensity: 1, focus: "Writing" },
      { id: "iter-predict", type: "predict-output", title: "Iterator output", prompt: "What does the chain produce?", nodes: ["iterators"], spec: "rust-predict", minutes: 3, intensity: 1, focus: "Reading" },
      { id: "freq-build", type: "build", title: "Word frequency", prompt: "Count each word with iterators and a HashMap.", nodes: ["iterators"], spec: "word-freq", success: "pass_rate >= 1", difficulty: { param: "tests", levels: ["basic", "case and punctuation"] }, minutes: 15, intensity: 1, focus: "Writing" },
      { id: "parse-build", type: "build", title: "Parse and sum", prompt: "Sum comma-separated numbers; return Err on bad input.", nodes: ["results"], spec: "parse-sum", success: "pass_rate >= 1", difficulty: { param: "tests", levels: ["good input", "bad input", "hidden"] }, minutes: 15, intensity: 1, focus: "Writing" }
    ],
    specs: {
      "count-words": { kind: "test", language: "rust", entry: "src/lib.rs", tests: [{ call: "count_words(\"\")", expect: "0", label: "Empty input" }, { call: "count_words(\"one two\")", expect: "2" }, { call: "count_words(\"  a  b   c \")", expect: "3", hidden: true }, { call: "count_words(\"tab\\tsplit\")", expect: "2", hidden: true }], runner: ["local", "container"], limits: { time_s: 20, memory_mb: 512, network: false }, lint: ["cargo clippy"], starter: { "src/lib.rs": "pub fn count_words(s: &str) -> usize {\n    0\n}\n" } },
      "longest-len": { kind: "test", language: "rust", entry: "src/lib.rs", tests: [{ call: "longest_len(&[\"a\", \"abc\", \"ab\"])", expect: "3" }, { call: "longest_len(&[])", expect: "0", label: "Empty slice" }, { native: "tests/borrow.rs", hidden: true, label: "Caller still owns its data" }], runner: ["local", "container"], limits: { time_s: 20, memory_mb: 512, network: false }, starter: { "src/lib.rs": "pub fn longest_len(words: &[&str]) -> usize {\n    0\n}\n" } },
      "find-first": { kind: "test", language: "rust", entry: "src/lib.rs", tests: [{ call: "find_first(&[4, 3, 3], 3)", expect: "Some(1)" }, { call: "find_first(&[], 3)", expect: "None" }, { call: "find_first(&[1, 2], 9)", expect: "None", hidden: true }], runner: ["local", "container"], limits: { time_s: 20, memory_mb: 512, network: false }, starter: { "src/lib.rs": "pub fn find_first(v: &[i32], target: i32) -> Option<usize> {\n    None\n}\n" } },
      "word-freq": { kind: "test", language: "rust", entry: "src/lib.rs", tests: [{ call: "word_freq(\"a b a\")[\"a\"]", expect: "2" }, { call: "word_freq(\"\").len()", expect: "0" }, { call: "word_freq(\"The the\")[\"the\"]", expect: "2", hidden: true }], runner: ["local", "container"], limits: { time_s: 20, memory_mb: 512, network: false }, lint: ["cargo clippy"] },
      "parse-sum": { kind: "test", language: "rust", entry: "src/lib.rs", tests: [{ call: "sum_numbers(\"1,2,3\").unwrap()", expect: "6" }, { call: "sum_numbers(\"1,x\").is_err()", expect: "true" }, { call: "sum_numbers(\" 4, 5 \").unwrap()", expect: "9", hidden: true }, { call: "sum_numbers(\"\").is_err()", expect: "true", hidden: true }], runner: ["local", "container"], limits: { time_s: 20, memory_mb: 512, network: false } },
      "rust-predict": {
        kind: "items",
        stop_after_wrong: 2,
        items: [
          { type: "predict-output", id: "r1", prompt: "What prints?", code: "let mut total = 0;\nfor n in 1..=3 { total += n; }\nprintln!(\"{total}\");", language: "rust", options: ["6", "3", "It doesn't compile"], answer: 0, difficulty: 1, nodes: ["bindings"] },
          { type: "predict-output", id: "r2", prompt: "What happens?", code: "let a = String::from(\"hi\");\nlet b = a;\nprintln!(\"{a}\");", language: "rust", options: ["Compile error: a was moved", "hi"], answer: 0, difficulty: 2, nodes: ["ownership"] },
          { type: "predict-output", id: "r3", prompt: "What prints?", code: "let v = vec![1, 2, 3];\nlet d: Vec<i32> = v.iter().map(|x| x * 2).collect();\nprintln!(\"{:?}\", d);", language: "rust", options: ["[2, 4, 6]", "[1, 2, 3]"], answer: 0, difficulty: 3, nodes: ["iterators"] },
          { type: "predict-output", id: "r4", prompt: "What prints?", code: "let r: Result<i32, _> = \"x\".parse::<i32>();\nprintln!(\"{}\", r.is_err());", language: "rust", options: ["true", "false"], answer: 0, difficulty: 4, nodes: ["results"] }
        ],
        pass: "accuracy >= 0.75"
      }
    },
    mistakes: [
      { id: "mut-missing", name: "Missing mut", nodes: ["bindings"], engine: "code", detector: { metric: "compiled", when: "compiled == 0" }, severity: 1, explain: { lesson: "bindings-lesson", card: 1 }, fix_drill: "count-build", headline: "Code doesn't compile; check mut" },
      { id: "use-after-move", name: "Use after move", nodes: ["ownership"], engine: "code", detector: { metric: "compiled", when: "compiled == 0" }, severity: 2, explain: { lesson: "ownership-lesson", card: 2 }, fix_drill: "borrow-build", headline: "A value is used after moving" }
    ],
    access: ["A computer", "The Rust toolchain or a container runtime"],
    focus: { Fundamentals: 35, Writing: 45, Reading: 20 },
    key_metrics: [
      { id: "pass", label: "Tests passing", engine: "code", metric: "pass_rate", unit: "%", better: "higher", format: "percent" },
      { id: "lint", label: "Clippy findings", engine: "code", metric: "lint_findings", better: "lower", format: "count" }
    ],
    copy: { placeholder: "Rust, Go, Zig", blurb: "Ownership, Option, iterators, errors" },
    notes: "Engines: code runs Rust tests with the local toolchain (rustc detected by get_capabilities) or a container; Rust has no browser runner here. If neither exists, each proof falls back to predict-output items in Rust. Compile errors stand in for ownership mistakes. Hours are estimates from general beginner book pacing for programmers who know another language, shown as ranges."
  }),
  // The first draft named the equipment in a phrase over the 40-character limit; the validator's schema check caught it.
  repair: (errors, model) => {
    const access = [...(model.access ?? [])];
    for (const e of errors) {
      const i = /^access\.(\d+)$/.exec(e.path)?.[1];
      if (i !== undefined && access[Number(i)] === "The Rust toolchain or a container runtime") access[Number(i)] = "Rust toolchain or a container";
    }
    return { ...model, access };
  }
};
