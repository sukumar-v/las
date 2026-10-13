import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { SkillModelInput } from "@las/schema";
import { SCENARIOS } from "../scenarios/index.js";
import {
  asAgent,
  calledCapabilitiesFirst,
  crossRefsConsistent,
  enginesMatch,
  fallbacksUsed,
  metricNamesExist,
  modelFixture,
  noRawMediaGrading,
  normalize,
  physicalSafetyPresent,
  predictFirst,
  stepHoursAreRanges,
  supervisedOnlyFlagged,
  transcriptFixture,
  wordBudgetHeld,
  type AgentRun,
  type Mode,
  type Scenario
} from "../src/harness.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "../fixtures");
const UPDATE = process.env.LAS_UPDATE_FIXTURES === "1";

/** Writes a fixture the first time (or when updating); otherwise fails when the regenerated one drifted structurally. */
function checkFixture(rel: string, fresh: unknown) {
  const path = join(fixtures, rel);
  mkdirSync(dirname(path), { recursive: true });
  if (UPDATE || !existsSync(path)) {
    writeFileSync(path, JSON.stringify(fresh, null, 2) + "\n");
    return;
  }
  const committed = JSON.parse(readFileSync(path, "utf8"));
  expect(normalize(fresh), `${rel} drifted from the committed fixture; rerun with LAS_UPDATE_FIXTURES=1 if the change is intended`).toEqual(normalize(committed));
}

const rows: { scenario: string; mode: Mode; engines: string; nodes: number; cards: number; words: number; attempts: number; ok: boolean }[] = [];
const transcripts = new Map<string, Record<string, unknown>>();

function checks(run: AgentRun): Record<string, string[]> {
  const m = run.model!;
  const e = run.scenario.expect;
  return {
    calledCapabilitiesFirst: calledCapabilitiesFirst(run.transcript),
    enginesMatch: enginesMatch(m, e),
    fallbacksUsed: fallbacksUsed(m, run.caps),
    wordBudgetHeld: wordBudgetHeld(m),
    noRawMediaGrading: noRawMediaGrading(run.transcript, m),
    predictFirst: predictFirst(m),
    stepHoursAreRanges: stepHoursAreRanges(m),
    physicalSafetyPresent: e.physical ? physicalSafetyPresent(m) : m.physical ? ["marked physical but the scenario is not"] : [],
    supervisedOnlyFlagged: supervisedOnlyFlagged(m, e.supervisedOnly ?? []),
    metricNamesExist: metricNamesExist(m),
    crossRefsConsistent: crossRefsConsistent(m)
  };
}

function shape(run: AgentRun): string[] {
  const m = run.model!;
  const p: string[] = [];
  if (m.nodes.length < 3 || m.nodes.length > 6) p.push(`${m.nodes.length} nodes, not 3-6`);
  if (m.physical !== run.scenario.expect.physical) p.push("physical flag differs from the scenario");
  if (!m.notes || /https?:\/\//.test(m.notes)) p.push("notes are missing or carry a URL");
  if (m.source !== "generated") p.push("a model the agent wrote is stored as generated");
  return p;
}

describe.each(SCENARIOS.map((s) => [s.id, s] as const))("%s", (id, scenario: Scenario) => {
  it.each(["real", "fallback"] as const)("passes every check (%s capabilities)", async (mode) => {
    const run = await asAgent(scenario, mode);
    const last = run.attempts.at(-1)!;
    expect(last.errors, `${id} (${mode}) never passed validate_skill_model`).toEqual([]);
    expect(run.attempts.length).toBeLessThanOrEqual(4);
    expect(run.model).toBeDefined();
    const m = run.model!;
    const found = checks(run);
    const ok = Object.values(found).every((p) => p.length === 0) && shape(run).length === 0;
    rows.push({ scenario: id, mode, engines: m.engines.join("+"), nodes: m.nodes.length, cards: m.lessons.reduce((t, l) => t + l.cards.length, 0), words: run.summary?.words ?? 0, attempts: run.attempts.length, ok });

    expect(found).toEqual(Object.fromEntries(Object.keys(found).map((k) => [k, []])));
    expect(shape(run)).toEqual([]);

    if (mode === "fallback") {
      // the main engine really was missing, the server said so, and the fallback is recorded
      expect(run.caps.engines.find((x) => x.id === scenario.expect.main)?.available).toBe(false);
      expect(run.draft.unavailableEngines.map((u) => u.id)).toContain(scenario.expect.main);
      expect(m.fallbacks?.[scenario.expect.main]).toBe(scenario.expect.fallback);
      const affected = m.ladder.filter((s) => s.proof?.engine === scenario.expect.main).length;
      expect(affected, "the main engine proves at least one step").toBeGreaterThan(0);
      expect(last.warnings.filter((w) => w.check === "capabilities").length, "each affected proof is reported as less precise").toBe(affected);
    } else {
      expect(m.fallbacks ?? {}).toEqual({});
      expect(last.warnings.filter((w) => w.check === "capabilities")).toEqual([]);
    }

    checkFixture(`models/${id}${mode === "fallback" ? ".fallback" : ""}.json`, modelFixture(m));
    const t = transcripts.get(id) ?? {};
    t[mode] = transcriptFixture(run);
    transcripts.set(id, t);
    if (t.real && t.fallback) checkFixture(`transcripts/${id}.json`, { scenario: id, skill: scenario.skill, expect: scenario.expect, runs: t });
  });
});

describe("harness", () => {
  it("covers every row of the coverage table", () => {
    const ids = SCENARIOS.map((s) => s.id);
    for (const want of ["salsa-routine", "strength-workout", "yoga-flow", "running-form", "golf-swing", "bouldering", "juggling", "piano", "singing", "drums", "japanese", "mandarin", "spanish", "asl", "public-speaking", "rust", "go", "java", "c", "sql", "javascript", "python", "chess", "drawing", "calligraphy", "cooking", "typing"]) expect(ids).toContain(want);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("repairs a model the validator rejects, at most three times", async () => {
    const base = SCENARIOS.find((s) => s.id === "salsa-routine")!;
    let repairs = 0;
    const scenario: Scenario = {
      ...base,
      id: "salsa-repair",
      build: (draft, caps) => {
        const m = base.build(draft, caps) as SkillModelInput & { lessons: any[]; mistakes: any[] };
        // a first draft that runs long: a wordy card and a wordy headline
        m.lessons[0].cards[1].text = "Salsa music is counted in phrases of eight beats and you step on six of them, pausing on four and eight, which is why we count out loud.";
        m.mistakes[0].headline = "You keep stepping a little before the music's beat";
        return m;
      },
      repair: (errors, model) => {
        repairs++;
        const m = model as SkillModelInput & { lessons: any[]; mistakes: any[] };
        expect(errors.map((e) => e.check)).toEqual(expect.arrayContaining(["word-budget"]));
        m.lessons[0].cards[1].text = "Steps on 1-2-3, pause, 5-6-7, pause.";
        m.mistakes[0].headline = "Steps land before the beat";
        return m;
      }
    };
    const run = await asAgent(scenario);
    expect(repairs).toBe(1);
    expect(run.attempts.map((a) => a.ok)).toEqual([false, true]);
    expect(run.attempts[0].errors.map((e) => e.path)).toEqual(expect.arrayContaining(["lessons[0].cards[1]", "mistakes[0].headline"]));
    expect(run.transcript.map((c) => c.tool)).toEqual(["get_capabilities", "draft_skill_model", "validate_skill_model", "validate_skill_model", "get_skill_model"]);
  });

  it("flags a model that grades raw media or skips its fallback", async () => {
    const run = await asAgent(SCENARIOS.find((s) => s.id === "drawing")!, "fallback");
    const m = structuredClone(run.model!);
    const bad = [...run.transcript, { tool: "grade_video", args: { file: "learner-media/attempt.mp4" }, ok: true }, { tool: "submit_rubric_grade", args: { attemptId: "x", grades: [{ criterion: "proportions", level: 2, confidence: 0.8 }] }, ok: true }];
    expect(noRawMediaGrading(bad, m).length).toBeGreaterThanOrEqual(3);
    delete m.fallbacks;
    expect(fallbacksUsed(m, run.caps).length).toBeGreaterThan(0);
    expect(calledCapabilitiesFirst(run.transcript.slice(1))).not.toEqual([]);
    // names the validator never checks
    m.ladder[1].proof!.criteria[0].check = "line_confidnce_level >= 2";
    expect(metricNamesExist(m)).toEqual([expect.stringContaining("line_confidnce_level")]);
    m.mistakes[0].headline = "You keep using many short strokes for each line";
    expect(wordBudgetHeld(m)).toHaveLength(1);
    m.drills[0].fixes = [];
    expect(crossRefsConsistent(m)).toEqual([expect.stringContaining("doesn't list it in fixes")]);
  });
});

afterAll(() => {
  if (!rows.length) return;
  rows.sort((a, b) => a.scenario.localeCompare(b.scenario) || a.mode.localeCompare(b.mode));
  console.log("\nAgent evals\n" + table(rows));
});

function table(r: typeof rows): string {
  const head = ["scenario", "mode", "engines", "nodes", "cards", "words", "attempts", "ok"];
  const cells = r.map((x) => [x.scenario, x.mode, x.engines, String(x.nodes), String(x.cards), String(x.words), String(x.attempts), x.ok ? "yes" : "no"]);
  const w = head.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const line = (c: string[]) => c.map((v, i) => v.padEnd(w[i])).join("  ");
  return [line(head), line(w.map((n) => "-".repeat(n))), ...cells.map(line)].join("\n");
}
