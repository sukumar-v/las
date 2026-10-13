/**
 * Runs the eval checks that need only a model on a skill model a real agent wrote (the manual protocol in
 * evals/README.md). Usage: pnpm --filter @las/evals exec tsx src/check-model.ts <model.json> [scenario-id]
 * With a scenario id, the engines and supervised-only expectations of that scenario are checked too.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateSkillModel } from "@las/schema";
import { SCENARIOS } from "../scenarios/index.js";
import { crossRefsConsistent, enginesMatch, metricNamesExist, physicalSafetyPresent, predictFirst, stepHoursAreRanges, supervisedOnlyFlagged, wordBudgetHeld } from "./harness.js";

const [file, scenarioId] = process.argv.slice(2);
if (!file) {
  console.error("Usage: tsx src/check-model.ts <model.json> [scenario-id]");
  process.exit(2);
}
const raw = JSON.parse(readFileSync(resolve(process.env.INIT_CWD ?? process.cwd(), file), "utf8"));
const input = raw && typeof raw === "object" && "model" in raw ? raw.model : raw; // accepts get_skill_model output too
const v = validateSkillModel(input);
if (!v.ok || !v.model) {
  for (const e of v.errors) console.error(`validate  ${e.path}: ${e.message}`);
  process.exit(1);
}
const m = v.model;
const scenario = scenarioId ? SCENARIOS.find((s) => s.id === scenarioId) : undefined;
if (scenarioId && !scenario) console.error(`No scenario "${scenarioId}"; skipping the scenario checks.`);
const checks: Record<string, string[]> = {
  wordBudgetHeld: wordBudgetHeld(m),
  predictFirst: predictFirst(m),
  stepHoursAreRanges: stepHoursAreRanges(m),
  physicalSafetyPresent: physicalSafetyPresent(m),
  metricNamesExist: metricNamesExist(m),
  crossRefsConsistent: crossRefsConsistent(m),
  ...(scenario ? { enginesMatch: enginesMatch(m, scenario.expect), supervisedOnlyFlagged: supervisedOnlyFlagged(m, scenario.expect.supervisedOnly ?? []) } : {})
};
let failed = 0;
for (const [name, problems] of Object.entries(checks)) {
  console.log(`${problems.length ? "FAIL" : "ok  "}  ${name}`);
  for (const p of problems) console.log(`      ${p}`);
  failed += problems.length ? 1 : 0;
}
process.exit(failed ? 1 : 0);
