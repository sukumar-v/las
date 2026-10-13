import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SCENARIOS } from "../scenarios/index.js";
import {
  COACH_CHECKS,
  coachChecks,
  eventsDelivered,
  eventsLostAfterEnd,
  maxWaitBytes,
  noRawMedia,
  queuedShownAfterLeaving,
  questionsAnswered,
  runCoachLoop,
  screensFromCoachWhilePresent,
  showsValidated,
  waitResultsSmall,
  WAIT_BYTES_LIMIT,
  type CoachRun
} from "../src/coach-harness.js";

/**
 * The coach loop, end to end, for every scenario's stored model (docs/design/live-coach.md §16): a scripted learner
 * over the studio's HTTP API against a scripted coach over the four coach tools, on a fake clock. Each scenario
 * runs five live sessions (follow, override, quitter, leaver, essayist) once, then every check reads the record.
 */

const rows: { scenario: string; ms: number; sessions: number; waits: number; shows: string; events: number; studio: string; maxWait: number; maxFull: number; na: string }[] = [];
const runs = new Map<string, CoachRun>();

/** The runs so far, or one fresh run when only these tests were selected (`-t`). */
async function someRuns(): Promise<Map<string, CoachRun>> {
  if (!runs.size) runs.set(SCENARIOS[0].id, await runCoachLoop(SCENARIOS[0].id));
  return runs;
}

describe.each(SCENARIOS.map((s) => [s.id] as const))("%s", (id) => {
  let run: CoachRun;
  beforeAll(async () => {
    run = await runCoachLoop(id);
    runs.set(id, run);
    const ok = run.shows.filter((s) => s.result?.ok).length;
    const coach = run.studio.filter((s) => s.source === "coach").length;
    const m = maxWaitBytes(run);
    rows.push({
      scenario: id,
      ms: run.ms,
      sessions: run.sessions.length,
      waits: run.waits.length,
      shows: `${ok}/${run.shows.length - ok}`,
      events: Object.values(run.stored).reduce((t, e) => t + e.length, 0),
      studio: `${coach}/${run.studio.length - coach}`,
      maxWait: m.bytes,
      maxFull: m.fullBytes,
      na: Object.keys(run.na).join(", ")
    });
  });

  // one test per check, so a failure names the check and the scenario
  it.each(COACH_CHECKS)("%s", (check) => {
    expect(coachChecks(run)[check]).toEqual([]);
  });
});

describe("the coach checks catch faults", () => {
  it("flags media, oversize results, skipped events, leaked screens and lost questions", async () => {
    const run = structuredClone([...(await someRuns()).values()][0]);
    const w = run.waits.find((x) => x.result.events.length)!;
    // raw media in an event
    (w.result.events[0] as any).mediaRef = "media://raw";
    expect(noRawMedia(run).some((p) => p.includes("mediaRef"))).toBe(true);
    (w.result.events[0] as any).keyFrames = [{ t: 1, ref: "data:image/png;base64,AAAA" }];
    expect(noRawMedia(run).some((p) => p.includes("data URL"))).toBe(true);
    // an oversize result
    w.bytes = WAIT_BYTES_LIMIT + 1;
    expect(waitResultsSmall(run)).toHaveLength(1);
    // a skipped event
    const sid = w.liveSessionId;
    run.stored[sid] = [...run.stored[sid], { id: 1_000_000, type: "card.answered" }];
    w.pendingMaxBefore = 1_000_000;
    expect(eventsDelivered(run).some((p) => p.includes("1000000"))).toBe(true);
    // a refused screen that reached the studio, and one accepted that should have been refused
    const bad = run.shows.find((s) => s.expect)!;
    bad.leaked = ["the studio was sent a screen"];
    expect(showsValidated(run).some((p) => p.includes("yet the studio was sent a screen"))).toBe(true);
    bad.result = { ok: true, errors: [], screenId: "scr_x", status: "queued" };
    expect(showsValidated(run).some((p) => p.includes("should be refused"))).toBe(true);
    // a fallback screen while the coach was present
    run.studio.push({ policy: "follow", liveSessionId: sid, id: "scr_fb", kind: "lesson", source: "fallback", coachPresent: true, duringEnd: false });
    expect(screensFromCoachWhilePresent(run).some((p) => p.includes("while the coach was present"))).toBe(true);
    // a question that never arrived
    run.asks[0].event = undefined;
    expect(questionsAnswered(run).some((p) => p.includes("never reached the coach"))).toBe(true);
  });
});

describe("known server bugs (flip to it once fixed)", () => {
  // BUG: packages/server/src/core/director.ts, coachWait (the `!row` branch, line 1022): a coach_wait made after the
  // session ended returns `events: []`, so events still pending (the wrap-up's screen.viewed, a last question) are
  // never delivered. When the session ends during a wait they are returned. eventsDelivered leaves these waits out.
  it("a coach_wait after the learner finished the wrap-up still delivers the pending events", async () => {
    const lost = [...(await someRuns())].flatMap(([id, run]) => eventsLostAfterEnd(run).map((p) => `${id}: ${p}`));
    expect(lost).toEqual([]);
  });

  // BUG: packages/server/src/core/director.ts, serveNext: a queued coach screen is shown before the presence check,
  // so the screen a coach queued before its leaving message shows after it left (§8: coach-away screens come from
  // the planner's next item; §15 rule 6: the session continues on fallback content). leaverHandsOver leaves it out.
  it("after a leaving message the next screen is the fallback's, not one the coach queued before", async () => {
    const shown = [...(await someRuns())].flatMap(([id, run]) => queuedShownAfterLeaving(run).map((p) => `${id}: ${p}`));
    expect(shown).toEqual([]);
  });
});

afterAll(() => {
  if (!rows.length) return;
  rows.sort((a, b) => a.scenario.localeCompare(b.scenario));
  console.log("\nCoach-loop evals (shows ok/refused, studio screens coach/fallback, wait sizes in bytes)\n" + table(rows));
});

function table(r: typeof rows): string {
  const head = ["scenario", "ms", "sessions", "waits", "shows", "events", "studio", "maxWait", "maxFull", "n/a"];
  const cells = r.map((x) => [x.scenario, String(x.ms), String(x.sessions), String(x.waits), x.shows, String(x.events), x.studio, String(x.maxWait), String(x.maxFull), x.na || "-"]);
  const w = head.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const line = (c: string[]) => c.map((v, i) => v.padEnd(w[i])).join("  ");
  return [line(head), line(w.map((n) => "-".repeat(n))), ...cells.map(line)].join("\n");
}
