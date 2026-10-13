import { z } from "zod";

export const RUNNER_IDS = ["browser", "local", "container"] as const;
export type RunnerId = (typeof RUNNER_IDS)[number];

/** Languages with a known browser runtime, local toolchain command set, or container image. */
export const LANGUAGES = [
  "javascript",
  "typescript",
  "python",
  "sql",
  "ruby",
  "php",
  "rust",
  "go",
  "java",
  "c",
  "cpp",
  "csharp",
  "kotlin",
  "swift",
  "bash",
  "lua",
  "r",
  "haskell",
  "elixir",
  "scala",
  "dart",
  "zig"
] as const;
export type Language = (typeof LANGUAGES)[number];

export const TestCaseSchema = z.union([
  z.object({
    /** an expression in the language, e.g. `count_words("")` */
    call: z.string().min(1),
    /** expected printed/returned value, compared as trimmed text */
    expect: z.string(),
    hidden: z.boolean().default(false),
    label: z.string().max(60).optional()
  }),
  z.object({
    /** program stdin -> expected stdout */
    stdin: z.string(),
    stdout: z.string(),
    hidden: z.boolean().default(false),
    label: z.string().max(60).optional()
  }),
  z.object({
    /** the language's own test file, relative to the workspace */
    native: z.string().min(1),
    hidden: z.boolean().default(false),
    label: z.string().max(60).optional()
  })
]);
export type TestCase = z.infer<typeof TestCaseSchema>;

export const TestSpecSchema = z.object({
  kind: z.literal("test").default("test"),
  language: z.enum(LANGUAGES),
  /** entry file, relative to the workspace */
  entry: z.string().min(1),
  tests: z.array(TestCaseSchema).min(1).max(50),
  runner: z.array(z.enum(RUNNER_IDS)).min(1).default(["browser", "local", "container"]),
  limits: z
    .object({
      time_s: z.number().min(1).max(120).default(10),
      memory_mb: z.number().min(16).max(4096).default(256),
      network: z.literal(false).default(false)
    })
    .prefault({}),
  /** optional lint command names the local runner may use when installed */
  lint: z.array(z.string()).optional(),
  /** files the learner starts from */
  starter: z.record(z.string(), z.string()).optional()
});
export type TestSpec = z.infer<typeof TestSpecSchema>;
export type TestSpecInput = z.input<typeof TestSpecSchema>;

export function checkTestSpec(spec: TestSpec): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  if (spec.tests.every((t) => "native" in t) && !spec.tests.length) issues.push({ path: "tests", message: "at least one test" });
  if (spec.entry.includes("..")) issues.push({ path: "entry", message: "entry must stay inside the workspace" });
  spec.tests.forEach((t, i) => {
    if ("native" in t && t.native.includes("..")) issues.push({ path: `tests[${i}].native`, message: "test file must stay inside the workspace" });
  });
  return issues;
}
