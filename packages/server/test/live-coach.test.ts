/**
 * The live coach (docs/design/live-coach.md §16, server rows): a scripted learner (studio events and the live
 * routes over HTTP, through the loop's event sink) against a scripted coach (the four MCP tools over an
 * in-memory client), on a fake clock so presence windows and deadlines take milliseconds.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "@las/store";
import { validateSkillModel, type SkillModelInput, type StudioEvent } from "@las/schema";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LasContext } from "../src/context.js";
import { createMcpServer } from "../src/mcp/server.js";
import { startHttp } from "../src/http/app.js";
import { installLoop } from "../src/loop.js";
import { validateAndStore } from "../src/core/skill-model.js";
import { setMilestone, startIntake } from "../src/core/intake.js";
import { getToday } from "../src/core/progress.js";
import { exportData, deleteData } from "../src/core/track.js";
import { setDirectorClock, type DirectorClock } from "../src/core/director.js";
import { discoverClientSession, parentFromProcStat } from "../src/core/client-session.js";
import { minimalModel } from "../../schema/test/fixtures/minimal-model.js";

// ------------------------------------------------------------------ the rig

interface FakeClock extends DirectorClock {
  advance(ms: number): void;
  /** real milliseconds each sleep takes (a tiny yield by default) */
  realMs: number;
}

function fakeClock(): FakeClock {
  let t = Date.parse(`${new Date().toISOString().slice(0, 10)}T10:00:00Z`);
  const c: FakeClock = {
    realMs: 1,
    now: () => new Date(t),
    advance: (ms) => {
      t += ms;
    },
    sleep: async (ms, signal) => {
      if (signal?.aborted) return;
      t += ms;
      await new Promise((r) => setTimeout(r, c.realMs));
    }
  };
  return c;
}

/** The test model plus a drill above every beginner cap. */
function model(over: Partial<SkillModelInput> = {}): SkillModelInput {
  const base = minimalModel();
  return minimalModel({ drills: [...base.drills!, { id: "max-jumps", type: "move", title: "Max jumps", nodes: ["depth"], spec: "rep-metrics", intensity: 5 }], ...over });
}

async function enroll(ctx: LasContext, input: SkillModelInput): Promise<string> {
  const stored = validateAndStore(ctx, input, await ctx.capabilities()).stored!;
  const r = await startIntake(ctx, stored.id);
  const m = ctx.store.getSkillModel(stored.id)!.model;
  ctx.store.updateIntake(r.intake.id, { answers: { look: "plain", why: [m.why[0].id], picture: m.pictures[0].id, fresh: true, placeConfirmed: true, minutes: 180, deadline: "none", aroundDone: true } });
  return ((await setMilestone(ctx, r.intake.id, "quick")) as { sk: string }).sk;
}

async function coachOn(ctx: LasContext) {
  const server = createMcpServer(ctx);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "coach", version: "0" });
  await server.connect(st);
  await client.connect(ct);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as any;
    return { text: (r.content ?? []).map((c: any) => c.text).join("\n") as string, data: r.structuredContent as any, isError: !!r.isError };
  };
  return { client, call, close: async () => { await client.close(); await server.close(); } };
}

const contexts: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close();
});

function newCtx(dataDir: string, store: Store, clock: FakeClock): LasContext {
  const ctx = new LasContext({ dataDir, port: 0, mediaDir: join(dataDir, "media"), modelsDir: join(dataDir, "models"), fontsDir: join(dataDir, "fonts") }, store);
  setDirectorClock(ctx, clock);
  return ctx;
}

async function rig(opts: { model?: SkillModelInput; store?: Store; dataDir?: string; clock?: FakeClock; sk?: string } = {}) {
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), "las-live-"));
  const clock = opts.clock ?? fakeClock();
  const ctx = newCtx(dataDir, opts.store ?? new Store(":memory:"), clock);
  ctx.store.updateLearner({ timezone: "UTC" });
  const sk = opts.sk ?? (await enroll(ctx, opts.model ?? model()));
  const http = await startHttp(ctx, installLoop(ctx));
  const emitted: { type: string; payload: any }[] = [];
  ctx.listeners.add((e) => emitted.push(e as { type: string; payload: any }));
  const coach = await coachOn(ctx);
  const req = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(http.url + p, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } });
    return { status: r.status, body: (await r.json()) as any };
  };
  const learner = {
    get: async (p: string) => (await req("GET", p)).body,
    post: (p: string, body: unknown = {}) => req("POST", p, body),
    event: async (e: StudioEvent) => {
      const r = await req("POST", "/api/events", e);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body.result;
    },
    advance: async (id: string, screenId: string | undefined, seconds?: number) => {
      const r = await req("POST", `/api/live/${id}/advance`, { screenId, seconds });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body;
    }
  };
  const wait = async (args: Record<string, unknown> = {}) => {
    const r = await coach.call("coach_wait", { sk, timeoutS: 3, ...args });
    expect(r.isError, r.text).toBe(false);
    return r.data.data;
  };
  const show = (screen: unknown) => coach.call("coach_show", { sk, screen });
  const start = async (args: Record<string, unknown> = {}) => {
    const r = await coach.call("coach_start", { sk, client: "claude-code", ...args });
    expect(r.isError, r.text).toBe(false);
    return r.data.data;
  };
  const out = { ctx, sk, dataDir, clock, http, coach, emitted, learner, wait, show, start, close: async () => { await coach.close(); await http.close(); } };
  contexts.push({ close: async () => { await out.close(); ctx.close(); } });
  return out;
}

const analysis = (over: Record<string, unknown> = {}) => ({ engine: "movement", quality: { ok: true, issues: [] }, metrics: { depth_ok: { value: 0.5, unit: "", confidence: 0.95 } }, mistakes: [], version: "test", ...over });
const shallow = { id: "shallow", severity: 2, confidence: 0.9, at: [1.2], evidence: { kind: "time", t: 1.2 } };

/** An attempt in the live session, analyzed through the studio route (the director makes attempt.analyzed). */
async function analyzedAttempt(r: Awaited<ReturnType<typeof rig>>, liveId: string, a: Record<string, unknown>) {
  const att = r.ctx.store.createAttempt({ sessionId: liveId, enrollmentId: r.sk, drillId: "depth-reps", kind: "perform", engine: "movement", specId: "rep-metrics", attemptNo: 1, prompt: "Five deep reps", spec: {} });
  const res = await r.learner.post(`/api/attempt/${att.id}/analysis`, { analysis: a });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return att.id;
}

const ofType = (emitted: { type: string; payload: any }[], t: string) => emitted.filter((e) => e.type === t);

// ------------------------------------------------------------------ tests

describe("live coach: scripted learner × scripted coach", () => {
  it("runs the loop end to end following the planner's suggestions", async () => {
    const r = await rig();
    const s0 = await r.start({ clientSessionId: "conv-1" });
    const id = s0.liveSessionId as string;
    expect(s0.studioPath).toBe(`/app/session/${id}`);
    expect(s0.reattached).toBe(false);
    expect(s0.plan.blocks.map((b: any) => b.kind)).toEqual(["warmup", "learn", "practice", "wrapup"]);
    // the director shows the warm-up itself; the coach is advised to teach next
    expect(s0.state).toMatchObject({ state: "live", block: "warmup", step: 0, holder: { client: "claude-code", present: true } });
    expect(s0.state.screen.kind).toBe("warmup");
    expect(s0.suggestion.item.type).toBe("lesson");
    expect(s0.instruction).toMatch(/coach_wait/);
    const row = r.ctx.store.getLiveSession(id)!;
    expect(row).toMatchObject({ coachSessionId: "conv-1", client: "claude-code", coachPid: process.pid, state: "live" });
    expect(r.ctx.store.getSession(id)!.status).toBe("active");
    expect(JSON.stringify(s0.state).length).toBeLessThan(2048);

    // the learner opens the studio
    const v0 = await r.learner.get(`/api/live/${id}`);
    expect(v0).toMatchObject({ liveSessionId: id, state: "live", coachPresent: true });
    const warm = v0.screen.id as string;
    await r.learner.event({ type: "screen.viewed", sessionId: id, screenId: warm });
    // the coach writes ahead: the suggestion with its pre-written content
    const q1 = await r.show("suggested");
    expect(q1.isError, q1.text).toBe(false);
    expect(q1.data.data).toMatchObject({ ok: true, status: "queued", current: { id: warm, kind: "warmup" } });
    let w = await r.wait();
    expect(w.events.map((e: any) => e.type)).toEqual(["screen.viewed"]);
    expect(w.events[0]).toMatchObject({ kind: "warmup", source: "fallback", screenId: warm });

    // the learner finishes the warm-up: the coach's queued lesson shows
    const a1 = await r.learner.advance(id, warm, 120);
    expect(a1.screen).toMatchObject({ kind: "lesson", source: "coach", block: "learn" });
    const lesson = a1.screen.id as string;
    expect(ofType(r.emitted, "coach.screen").map((e) => e.payload.screen.id)).toContain(lesson);
    await r.learner.event({ type: "screen.viewed", sessionId: id, screenId: lesson, previous: { screenId: warm, seconds: 120 } });
    await r.learner.event({ type: "card.answered", sessionId: id, screenId: lesson, card: 0, cardType: "predict", answer: 1, correct: false, seconds: 4 });
    w = await r.wait();
    expect(w.events.map((e: any) => e.type)).toEqual(["screen.viewed", "card.answered"]);
    expect(w.events[0].previous).toEqual({ screenId: warm, kind: "warmup", seconds: 120 });
    expect(Number(w.events[1].id)).toBeGreaterThan(Number(w.events[0].id));
    expect(w.state).toMatchObject({ block: "learn", step: 0, screen: { id: lesson, kind: "lesson", source: "coach" } });
    expect(w.suggestion.item.type).toBe("drill");

    // the knowledge drill, item by item through the studio API: drill.answered per item, done with the outcome
    expect((await r.show("suggested")).data.data.status).toBe("queued");
    const a2 = await r.learner.advance(id, lesson, 30);
    expect(a2.screen.kind).toBe("drill");
    const drillId = a2.screen.item.drill.id as string;
    const spec = r.ctx.store.getSkillModel(r.ctx.store.getEnrollment(r.sk)!.skillModelId)!.model.specs["placement-quiz"] as any;
    let step = (await r.learner.post(`/api/drill/${drillId}/next`, { sk: r.sk, sessionId: id })).body;
    for (let i = 0; i < 6 && !step.done; i++) {
      const key = spec.items.find((it: any) => it.id === step.item.id).answer;
      step = (await r.learner.post(`/api/drill/${drillId}/next`, { sk: r.sk, sessionId: id, answer: { itemId: step.item.id, answer: key } })).body;
    }
    expect(step.done).toBe(true);
    w = await r.wait();
    const answered = w.events.filter((e: any) => e.type === "drill.answered");
    expect(answered.length).toBeGreaterThanOrEqual(2);
    expect(answered.every((e: any) => e.drillId === drillId && e.correct === true)).toBe(true);
    expect(answered.slice(0, -1).every((e: any) => !e.done)).toBe(true);
    const last = answered[answered.length - 1];
    expect(last).toMatchObject({ done: true, success: true });
    expect(last.outcome.drillId).toBe(drillId);
    expect(last.mastery[0].after).toBeGreaterThan(last.mastery[0].before);
    expect(w.state.mastery.map((m: any) => m.nodeId)).toContain("setup");

    // a wrap-up in the coach's words; the learner finishes it and the session ends
    const q3 = await r.show({ kind: "wrapup", praise: "Steady stance today", oneFix: "Feet shoulder width", nextNote: "Next time: depth." });
    expect(q3.data.data.status).toBe("queued");
    const a3 = await r.learner.advance(id, a2.screen.id, 200);
    expect(a3.screen.kind).toBe("wrapup");
    expect(a3.screen.item).toMatchObject({ type: "wrapup", summary: { praise: "Steady stance today", nextNote: "Next time: depth." } });
    const a4 = await r.learner.advance(id, a3.screen.id, 10);
    expect(a4.view.state).toBe("ended");
    expect(a4.view.summary.praise).toBe("Steady stance today");
    expect(ofType(r.emitted, "coach.ended")).toHaveLength(1);
    w = await r.wait();
    expect(w.state.state).toBe("ended");
    expect(w.instruction).toMatch(/coach_end/);
    const end = await r.coach.call("coach_end", { sk: r.sk });
    expect(end.isError, end.text).toBe(false);
    expect(end.data.data.summary.changed.map((c: any) => c.nodeId)).toContain("setup");
    // existing completeSession semantics: the session is done, Today and the next session work
    expect(r.ctx.store.getSession(id)!.status).toBe("done");
    expect(getToday(r.ctx, r.sk).nextSession?.title).toMatch(/^Session 2/);
  });

  it("re-attaches the same coach and returns at once when events are waiting; heartbeats otherwise", async () => {
    const r = await rig();
    const s0 = await r.start();
    const again = await r.start();
    expect(again.reattached).toBe(true);
    expect(again.liveSessionId).toBe(s0.liveSessionId);
    // block.completed and review.graded update the model as before, but aren't coach events
    await r.learner.event({ type: "block.completed", sessionId: s0.liveSessionId, block: "warmup", durationS: 300 });
    const card = r.ctx.store.listReviewCards(r.sk)[0];
    if (card) await r.learner.event({ type: "review.graded", cardId: card.id, grade: 3 });
    const hb = await r.wait({ timeoutS: 3 });
    expect(hb).toMatchObject({ heartbeat: true, events: [] });
    expect(hb.instruction).toMatch(/coach_wait again/);
  });

  it("makes attempt.analyzed with the analysis, key frames by reference (never media) and the top-mistake pick", async () => {
    const r = await rig();
    const { liveSessionId: id } = await r.start();
    const att = await analyzedAttempt(r, id, analysis({ mistakes: [shallow], keyFrames: [{ t: 1.2, ref: "data:image/png;base64,AAAA", label: "bottom of rep 2" }], overlay: { points: { a: [1, 2] } } }));
    const w = await r.wait();
    expect(w.events).toHaveLength(1);
    const e = w.events[0];
    expect(e).toMatchObject({ type: "attempt.analyzed", attemptId: att, drillId: "depth-reps", top: { mistakeId: "shallow", name: "Shallow reps", fixDrillId: "depth-reps" } });
    expect(e.keyFrames).toEqual([{ t: 1.2, ref: `attempt:${att}/frame/0`, label: "bottom of rep 2" }]);
    expect(JSON.stringify(e)).not.toMatch(/data:image/);
    expect(e.analysis.overlay).toBeUndefined();
    expect(w.state.mistakes).toContainEqual({ id: "shallow", state: "detected" });
    // the coach writes feedback from it; the learner sees it after the warm-up
    expect((await r.show({ kind: "feedback", attemptId: att, headline: "Stop a little deeper", evidence: { kind: "mistake", mistakeId: "shallow" } })).isError).toBe(false);
  });

  it("ends a paused session at the end of the learner's day, keeping what was done", async () => {
    const r = await rig();
    const { liveSessionId: id } = await r.start();
    await r.learner.get(`/api/live/${id}`);
    await r.learner.event({ type: "session.paused", sessionId: id, reason: "learner" });
    r.clock.advance(24 * 3600e3);
    const v = await r.learner.get(`/api/live/${id}`);
    expect(v.state).toBe("ended");
    expect(r.ctx.store.getSession(id)!.status).toBe("done");
    const late = await r.show({ kind: "message", text: "Still there?" });
    expect(late.text).toMatch(/ended/);
  });

  it("an override needs a reason and goes in the planner log", async () => {
    const r = await rig();
    const s0 = await r.start();
    expect(s0.suggestion.item.type).toBe("lesson");
    const bare = await r.show({ kind: "drill", drillId: "setup-quiz" });
    expect(bare.isError).toBe(true);
    expect(bare.data.errors.map((e: any) => e.path)).toEqual(["reason"]);
    const ok = await r.show({ kind: "drill", drillId: "setup-quiz", reason: "They know the stance: check it first" });
    expect(ok.isError, ok.text).toBe(false);
    const log = r.ctx.store.db.all("SELECT json FROM planner_log WHERE session_id = ?", s0.liveSessionId).map((x) => JSON.parse(x.json as string));
    const entry = log.find((e) => e.by === "coach");
    expect(entry).toMatchObject({ by: "coach", reason: "They know the stance: check it first", suggested: { type: "lesson", block: "learn" }, chosen: { kind: "drill" } });
    // the plan item wasn't served, so it's still the suggestion
    expect((await r.wait()).suggestion.item.type).toBe("lesson");
  });

  it("rejects every over-budget or unsafe screen, and nothing reaches the studio (budget evals)", async () => {
    const r = await rig();
    const { liveSessionId: id } = await r.start();
    await r.learner.get(`/api/live/${id}`);
    const screensBefore = ofType(r.emitted, "coach.screen").length;
    const rows = () => r.ctx.store.listCoachScreens(id).length;
    const before = rows();
    const rejected = async (screen: unknown, path: string, message: RegExp) => {
      const res = await r.show(screen);
      expect(res.isError, JSON.stringify(screen)).toBe(true);
      expect(res.data.ok).toBe(false);
      const e = res.data.errors.find((x: any) => x.path === path);
      expect(e, JSON.stringify(res.data.errors)).toBeTruthy();
      expect(e.message).toMatch(message);
      expect(res.data.instruction).toMatch(/Nothing was shown|Fix/);
    };
    const essay = Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ");
    await rejected({ kind: "lesson", title: "Stance", nodes: ["setup"], cards: [{ type: "diagram", text: essay, figure: { kind: "mermaid", source: "graph LR; a-->b" } }] }, "cards[0]", /40 words; a card has at most 25/);
    await rejected({ kind: "lesson", title: "Stance", nodes: ["setup"], cards: [{ type: "essay", text: "Read this." }] }, "cards[0].type", /unknown card type "essay"/);
    await rejected({ kind: "drill", type: "move", title: "Deep reps", nodes: ["depth"], spec: { kind: "metric", metrics: { knee: "min(angle(left_hip, left_knee, left_ankle))" } }, reason: "new" }, "spec", /can't be written live/);
    await rejected({ kind: "drill", drillId: "max-jumps", reason: "push them" }, "drillId", /intensity 5; the cap now is 3/);
    await rejected({ kind: "message", text: essay }, "text", /at most 25/);
    await rejected({ kind: "drill", drillId: "setup-quiz", prompt: essay, reason: "x" }, "prompt", /at most 25/);
    // feedback citing a mistake the analysis doesn't have
    const clean = await analyzedAttempt(r, id, analysis());
    await rejected({ kind: "feedback", attemptId: clean, headline: "Go deeper", evidence: { kind: "mistake", mistakeId: "shallow" } }, "evidence.mistakeId", /has no mistake "shallow"/);
    // feedback on a recording that failed its quality check is a re-record
    const dark = await analyzedAttempt(r, id, analysis({ quality: { ok: false, issues: ["too dark"] }, mistakes: [shallow] }));
    await rejected({ kind: "feedback", attemptId: dark, headline: "Go deeper", evidence: { kind: "mistake", mistakeId: "shallow" } }, "attemptId", /re-record, not feedback/);
    // a headline over 8 words, and a fix drill that isn't this mistake's fix
    const seen = await analyzedAttempt(r, id, analysis({ mistakes: [shallow] }));
    await rejected({ kind: "feedback", attemptId: seen, headline: "one two three four five six seven eight nine", evidence: { kind: "mistake", mistakeId: "shallow" } }, "headline", /at most 8/);
    await rejected({ kind: "feedback", attemptId: seen, headline: "Go deeper", evidence: { kind: "mistake", mistakeId: "shallow" }, fixDrillId: "setup-quiz" }, "fixDrillId", /one fix per feedback/);
    // nothing over budget reached the studio
    expect(rows()).toBe(before);
    expect(ofType(r.emitted, "coach.screen").length).toBe(screensBefore);
    expect((await r.learner.get(`/api/live/${id}`)).queued).toBeUndefined();
    // the valid one goes through, with the coach's words on the analysis' evidence
    const good = await r.show({ kind: "feedback", attemptId: seen, headline: "Stop a little deeper", evidence: { kind: "mistake", mistakeId: "shallow" }, praise: "Even tempo" });
    expect(good.isError, good.text).toBe(false);
    const q = r.ctx.store.getCoachScreen(good.data.data.screenId)!;
    expect((q.screen as any).item.view).toMatchObject({ headline: "Stop a little deeper", mistakeId: "shallow", fixDrillId: "depth-reps", praise: { headline: "Even tempo" }, evidence: { ref: { kind: "time", t: 1.2 } } });
    expect(r.ctx.store.getMistakeStates(r.sk).get("shallow")?.state).toBe("coached");
  });

  it("serves the fallback when the coach's presence lapses, and redelivers every missed event when it's back", async () => {
    const r = await rig();
    const { liveSessionId: id } = await r.start();
    let v = await r.learner.get(`/api/live/${id}`);
    const warm = v.screen.id;
    await r.wait({ timeoutS: 1 });
    // the coach stops calling
    r.clock.advance(61_000);
    v = await r.learner.get(`/api/live/${id}`);
    expect(v).toMatchObject({ state: "coach-away", coachPresent: false });
    expect(ofType(r.emitted, "coach.state").some((e) => e.payload.state === "coach-away" && e.payload.coachPresent === false)).toBe(true);
    await r.learner.event({ type: "screen.viewed", sessionId: id, screenId: warm });
    const a1 = await r.learner.advance(id, warm, 90);
    expect(a1.waiting).toBeUndefined();
    expect(a1.screen).toMatchObject({ kind: "lesson", source: "fallback" });
    await r.learner.event({ type: "screen.viewed", sessionId: id, screenId: a1.screen.id, previous: { screenId: warm, seconds: 90 } });
    await r.learner.event({ type: "card.answered", sessionId: id, screenId: a1.screen.id, card: 0, cardType: "predict", answer: 0, correct: true });
    const a2 = await r.learner.advance(id, a1.screen.id, 20);
    expect(a2.screen).toMatchObject({ kind: "drill", source: "fallback" });
    await r.learner.event({ type: "learner.asked", sessionId: id, screenId: a2.screen.id, text: "Why wide?" });
    // the coach comes back: everything it missed, in order
    const w = await r.wait();
    expect(w.events.map((e: any) => e.type)).toEqual(["screen.viewed", "screen.viewed", "card.answered", "learner.asked"]);
    expect(w.events[1]).toMatchObject({ source: "fallback", kind: "lesson" });
    expect(w.events[3].text).toBe("Why wide?");
    expect(w.state).toMatchObject({ state: "live", screen: { kind: "drill", source: "fallback" } });
    expect(w.instruction).toMatch(/message/);
    // the answer to the question, as a message replying to its event
    const msg = await r.show({ kind: "message", text: "Wide feet give a bigger base, so you sway less.", replyTo: w.events[3].id });
    expect(msg.data.data.status).toBe("shown");
  });

  it("delivers at least once: unacknowledged events come again, and a lost reply is redelivered", async () => {
    const r = await rig();
    const { liveSessionId: id } = await r.start();
    for (const s of ["a", "b", "c"]) await r.learner.event({ type: "learner.hesitated", sessionId: id, screenId: s, seconds: 20 });
    // once per screen
    await r.learner.event({ type: "learner.hesitated", sessionId: id, screenId: "a", seconds: 40 });
    const w1 = await r.wait();
    expect(w1.events.map((e: any) => e.screenId)).toEqual(["a", "b", "c"]);
    // the coach says it only handled the first one
    const w2 = await r.wait({ ack: w1.events[0].id });
    expect(w2.events.map((e: any) => e.id)).toEqual(w1.events.slice(1).map((e: any) => e.id));
    const w3 = await r.wait({ timeoutS: 1 });
    expect(w3.heartbeat).toBe(true);
    // a reply the client never got: it timed out (and cancelled) during the batch window
    await r.learner.event({ type: "learner.asked", sessionId: id, text: "Still there?" });
    r.clock.realMs = 200;
    await expect(r.coach.client.callTool({ name: "coach_wait", arguments: { sk: r.sk, timeoutS: 3 } }, undefined, { timeout: 50 })).rejects.toThrow();
    await new Promise((res) => setTimeout(res, 400));
    r.clock.realMs = 1;
    const w4 = await r.wait();
    expect(w4.events.map((e: any) => e.type)).toEqual(["learner.asked"]);
    expect(Number(w4.events[0].id)).toBeGreaterThan(Number(w1.events[2].id));
  });

  it("keeps events in order across two processes sharing one SQLite file", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "las-live-2p-"));
    const file = join(dataDir, "las.db");
    const clock = fakeClock();
    // process A serves the studio; process B is the coach's stdio server
    const a = await rig({ store: new Store(file), dataDir, clock });
    const ctxB = newCtx(dataDir, new Store(file), clock);
    const b = await coachOn(ctxB);
    contexts.push({ close: async () => { await b.close(); ctxB.close(); } });
    const start = await b.call("coach_start", { sk: a.sk, client: "claude-code" });
    expect(start.isError, start.text).toBe(false);
    const id = start.data.data.liveSessionId;
    const waitB = async () => (await b.call("coach_wait", { sk: a.sk, timeoutS: 3 })).data.data;
    // a burst
    for (let i = 0; i < 25; i++) await a.learner.event({ type: "card.answered", sessionId: id, screenId: "s", card: i, cardType: "predict", answer: i });
    const w1 = await waitB();
    expect(w1.events.map((e: any) => e.card)).toEqual(Array.from({ length: 25 }, (_, i) => i));
    // more while B's wait is open (B polls the store)
    const pending = waitB();
    await new Promise((res) => setTimeout(res, 30));
    for (let i = 25; i < 28; i++) await a.learner.event({ type: "card.answered", sessionId: id, screenId: "s", card: i, cardType: "predict", answer: i });
    const w2 = await pending;
    const w3 = w2.events.length < 3 ? await waitB() : { events: [] };
    const all = [...w1.events, ...w2.events, ...w3.events];
    expect(all.map((e: any) => e.card)).toEqual(Array.from({ length: 28 }, (_, i) => i));
    const ids = all.map((e: any) => Number(e.id));
    expect(ids).toEqual([...ids].sort((x, y) => x - y));
    expect(new Set(ids).size).toBe(ids.length);
    // B's message reaches A's studio stream through A's poller
    const msg = await b.call("coach_show", { sk: a.sk, screen: { kind: "message", text: "Nice and steady." } });
    expect(msg.isError, msg.text).toBe(false);
    for (let i = 0; i < 40 && !ofType(a.emitted, "coach.message").length; i++) await new Promise((res) => setTimeout(res, 50));
    expect(ofType(a.emitted, "coach.message")[0].payload).toMatchObject({ liveSessionId: id, message: { text: "Nice and steady." } });
  });

  it("allows one coach at a time; a second takes over only when the first is away", async () => {
    const r = await rig();
    const ctx2 = newCtx(r.dataDir, r.ctx.store, r.clock);
    const c2 = await coachOn(ctx2);
    contexts.push({ close: () => c2.close() });
    const { liveSessionId: id } = await r.start();
    const refused = await c2.call("coach_start", { sk: r.sk, client: "codex" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/claude-code/);
    r.clock.advance(61_000);
    const took = await c2.call("coach_start", { sk: r.sk, client: "codex" });
    expect(took.isError, took.text).toBe(false);
    expect(took.data.data.liveSessionId).toBe(id);
    expect(r.ctx.store.getLiveSession(id)!.client).toBe("codex");
    expect(r.ctx.store.listEvents(r.sk).some((e) => e.type === "coach.takeover" && e.payload.from === "claude-code" && e.payload.to === "codex")).toBe(true);
    const old = await r.show({ kind: "message", text: "Still here." });
    expect(old.isError).toBe(true);
    expect(old.text).toMatch(/another coach took over/i);
    expect((await c2.call("coach_show", { sk: r.sk, screen: { kind: "message", text: "I'm your coach now." } })).isError).toBe(false);
  });

  it("tells the coach session.left (studio-offline) after the studio goes quiet, and pauses", async () => {
    const r = await rig();
    const { liveSessionId: id } = await r.start();
    const v = await r.learner.post(`/api/live/${id}/ping`);
    expect(v.body).toMatchObject({ ok: true, coachPresent: true, state: "live" });
    const warm = (await r.learner.get(`/api/live/${id}`)).screen.id;
    r.clock.advance(301_000);
    const w = await r.wait({ timeoutS: 2 });
    expect(w.events.map((e: any) => [e.type, e.reason])).toEqual([["session.left", "studio-offline"]]);
    expect(w.state.state).toBe("paused");
    expect(w.state.screen.kind).toBe("pause");
    // the studio comes back and the learner resumes where they were
    const res = await r.learner.event({ type: "session.resumed", sessionId: id, pausedSeconds: 0 });
    expect(res.state).toBe("live");
    const back = await r.learner.get(`/api/live/${id}`);
    expect(back.screen.id).toBe(warm);
    const w2 = await r.wait();
    expect(w2.events[0].type).toBe("session.resumed");
    expect(w2.events[0].pausedSeconds).toBeGreaterThanOrEqual(0);
  });

  it("pauses and resumes on the learner's tap, showing the pause screen in between", async () => {
    const r = await rig();
    const { liveSessionId: id } = await r.start();
    const warm = (await r.learner.get(`/api/live/${id}`)).screen.id;
    await r.learner.event({ type: "session.paused", sessionId: id, reason: "learner" });
    let v = await r.learner.get(`/api/live/${id}`);
    expect(v.state).toBe("paused");
    expect(v.screen.item).toMatchObject({ type: "pause" });
    // advancing a pause screen does nothing
    expect((await r.learner.advance(id, v.screen.id)).view.state).toBe("paused");
    r.clock.advance(30_000);
    await r.learner.event({ type: "session.resumed", sessionId: id, pausedSeconds: 30 });
    v = await r.learner.get(`/api/live/${id}`);
    expect(v.screen.id).toBe(warm);
    const w = await r.wait();
    expect(w.events.map((e: any) => e.type)).toEqual(["session.paused", "session.resumed"]);
    expect(w.state.minutesUsed).toBeLessThan(0.1);
  });

  it("serves the fallback (source fallback) when a present coach misses the screen deadline", async () => {
    const r = await rig();
    const { liveSessionId: id } = await r.start();
    const warm = (await r.learner.get(`/api/live/${id}`)).screen.id;
    await r.wait({ timeoutS: 1 });
    const a1 = await r.learner.advance(id, warm, 60);
    expect(a1.waiting).toBe(true);
    expect(Date.parse(a1.until) - r.clock.now().getTime()).toBe(8000);
    // the coach hears the learner is waiting
    const w = await r.wait();
    expect(w.events).toEqual([]);
    expect(w.state.waiting.until).toBe(a1.until);
    expect(w.instruction).toMatch(/waiting/);
    r.clock.advance(9000);
    const a2 = await r.learner.advance(id, warm, 60);
    expect(a2.screen).toMatchObject({ kind: "lesson", source: "fallback" });
    expect(r.ctx.store.getCoachScreen(a2.screen.id)!.source).toBe("fallback");
    await r.learner.event({ type: "screen.viewed", sessionId: id, screenId: a2.screen.id });
    const w2 = await r.wait();
    expect(w2.events[0]).toMatchObject({ type: "screen.viewed", source: "fallback" });
    // a late coach screen doesn't replace what the learner started: it's queued
    expect((await r.show({ kind: "message", text: "Back. Carry on." })).data.data.status).toBe("shown");
    expect((await r.show("suggested")).data.data.status).toBe("queued");
  });

  it("shows a coach screen at once when the learner is already waiting", async () => {
    const r = await rig();
    const { liveSessionId: id } = await r.start();
    const warm = (await r.learner.get(`/api/live/${id}`)).screen.id;
    await r.wait({ timeoutS: 1 });
    expect((await r.learner.advance(id, warm)).waiting).toBe(true);
    const shown = await r.show("suggested");
    expect(shown.data.data.status).toBe("shown");
    expect(ofType(r.emitted, "coach.screen").pop()!.payload.screen).toMatchObject({ kind: "lesson", source: "coach" });
  });

  it("applies the plan option the learner taps and logs it as a plan change", async () => {
    const r = await rig();
    const { liveSessionId: id } = await r.start();
    const warm = (await r.learner.get(`/api/live/${id}`)).screen.id;
    const plan = await r.show({
      kind: "plan",
      question: "Sessions keep running short. Add an hour a week?",
      reason: "Three sessions ended early",
      options: [
        { id: "more", label: "Add an hour", action: { kind: "reschedule", minutesPerWeek: 240 } },
        { id: "keep", label: "Keep it", action: { kind: "replan", option: "keep" } }
      ]
    });
    expect(plan.isError, plan.text).toBe(false);
    const a = await r.learner.advance(id, warm);
    expect(a.screen.kind).toBe("plan");
    expect(a.screen.item).toMatchObject({ type: "plan", question: "Sessions keep running short. Add an hour a week?", options: [{ id: "more", label: "Add an hour" }, { id: "keep", label: "Keep it" }] });
    expect(a.screen.item.options[0].action).toBeUndefined();
    const res = await r.learner.event({ type: "plan.chosen", sessionId: id, screenId: a.screen.id, optionId: "more" });
    expect(res.change).toMatch(/hours a week/);
    expect(r.ctx.store.getConstraints(r.sk)!.minutesPerWeek).toBe(240);
    const changes = r.ctx.store.listPlanChanges(r.sk);
    expect(changes.some((c) => c.reason === `coach-plan:${a.screen.id}` && c.option === "more:reschedule")).toBe(true);
    expect(changes.some((c) => c.reason === "replan" && c.option.startsWith("change-minutes"))).toBe(true);
    expect((await r.learner.event({ type: "plan.chosen", sessionId: id, screenId: a.screen.id, optionId: "keep" })).duplicate).toBe(true);
    const w = await r.wait();
    expect(w.events.find((e: any) => e.cardType === "plan-option")).toMatchObject({ type: "card.answered", screenId: a.screen.id, answer: { optionId: "more" } });
    // a bad option is refused before anything shows
    const bad = await r.show({ kind: "plan", question: "Change?", reason: "x", options: [{ id: "a", label: "A", action: { kind: "replan", option: "move-mountains" } }, { id: "b", label: "B", action: { kind: "none" } }] });
    expect(bad.isError).toBe(true);
  });

  it("pain lowers intensity first, and the coach's event carries the cap", async () => {
    const r = await rig();
    const { liveSessionId: id } = await r.start();
    const q = await r.show({ kind: "drill", drillId: "depth-reps", reason: "Depth is the gap today" });
    expect(q.data.data.status).toBe("queued");
    await r.learner.event({ type: "pain.reported", sk: r.sk, area: "Knees", level: 2 });
    const w = await r.wait();
    expect(w.events).toHaveLength(1);
    expect(w.events[0]).toMatchObject({ type: "pain.reported", area: "Knees", level: 2, intensityCap: 2 });
    expect(w.state.intensityCap).toBe(2);
    expect(w.instruction).toMatch(/Pain/);
    // the queued drill above the new cap never shows, and the coach can't queue it again
    expect(w.state.queued).toBeUndefined();
    const again = await r.show({ kind: "drill", drillId: "depth-reps", reason: "Depth is the gap today" });
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/cap now is 2/);
    void id;
  });

  it("shows a message at once over the current screen; a leaving message hands over to the fallback", async () => {
    const r = await rig();
    const { liveSessionId: id } = await r.start();
    const warm = (await r.learner.get(`/api/live/${id}`)).screen.id;
    const m = await r.show({ kind: "message", text: "Slow breaths while you warm up.", figure: { kind: "rhythm", pattern: "D_D_", subdivisions: 4 } });
    expect(m.data.data).toMatchObject({ ok: true, status: "shown", current: { id: warm } });
    const v = await r.learner.get(`/api/live/${id}`);
    expect(v.screen.id).toBe(warm);
    expect(v.message).toMatchObject({ type: "message", text: "Slow breaths while you warm up.", leaving: false });
    expect(ofType(r.emitted, "coach.message").pop()!.payload.message.text).toBe("Slow breaths while you warm up.");
    const bye = await r.show({ kind: "message", text: "I have to go; the app carries on.", leaving: true });
    expect(bye.isError, bye.text).toBe(false);
    const v2 = await r.learner.get(`/api/live/${id}`);
    expect(v2).toMatchObject({ state: "coach-away", coachPresent: false, leftOnPurpose: true });
  });

  it("coach_end shows the fallback wrap-up when the coach didn't, and returns the summary", async () => {
    const r = await rig();
    const { liveSessionId: id } = await r.start();
    await r.learner.get(`/api/live/${id}`);
    const end = await r.coach.call("coach_end", { sk: r.sk });
    expect(end.isError, end.text).toBe(false);
    expect(end.data.data.summary.sessionId).toBe(id);
    const screens = r.ctx.store.listCoachScreens(id);
    expect(screens.some((s) => s.kind === "wrapup" && s.source === "fallback")).toBe(true);
    expect(r.ctx.store.getLiveSession(id)!.state).toBe("ended");
    expect(r.ctx.store.getSession(id)!.status).toBe("done");
    // a new session can start afterwards
    expect((await r.start()).liveSessionId).not.toBe(id);
  });

  it("sends MCP progress notifications while waiting", async () => {
    const r = await rig();
    await r.start();
    const progress: any[] = [];
    const res = (await r.coach.client.callTool({ name: "coach_wait", arguments: { sk: r.sk, timeoutS: 45 } }, undefined, { onprogress: (p) => progress.push(p), timeout: 30_000 })) as any;
    expect(res.structuredContent.data.heartbeat).toBe(true);
    expect(progress.length).toBeGreaterThanOrEqual(3);
    expect(progress[0]).toMatchObject({ total: 45 });
  });

  it("export and delete cover the live coach's tables", async () => {
    const r = await rig();
    const { liveSessionId: id } = await r.start();
    await r.learner.event({ type: "learner.asked", sessionId: id, text: "How deep?" });
    await r.show({ kind: "message", text: "Thighs level with the floor." });
    const ex = exportData(r.ctx, r.sk);
    expect(ex.counts.live_session).toBe(1);
    expect(ex.counts.coach_event).toBeGreaterThanOrEqual(1);
    expect(ex.counts.coach_screen).toBeGreaterThanOrEqual(2);
    deleteData(r.ctx, r.sk, true);
    const n = (t: string) => (r.ctx.store.db.get(`SELECT COUNT(*) AS n FROM ${t}`) as any).n;
    expect([n("live_session"), n("coach_event"), n("coach_screen")]).toEqual([0, 0, 0]);
  });
});

describe("fallback content is optional (scaffold vs fallback, §9)", () => {
  function bare(): SkillModelInput {
    const m = model();
    return {
      ...m,
      lessons: m.lessons!.map((l) => ({ id: l.id, title: l.title, nodes: l.nodes })),
      mistakes: m.mistakes!.map(({ headline: _h, explain: _e, ...rest }) => rest),
      drills: m.drills!.map(({ prompt: _p, ...rest }) => rest)
    } as SkillModelInput;
  }

  it("validates a model without it and warns about each gap", () => {
    const v = validateSkillModel(bare());
    expect(v.ok, JSON.stringify(v.errors)).toBe(true);
    const msgs = v.warnings.map((w) => w.message);
    expect(msgs).toContain('mistake "shallow" has no headline: the fallback feedback will use its name');
    expect(msgs).toContain('mistake "shallow" has no explain: the fallback feedback leaves out the Why button');
    expect(msgs.some((m) => /lesson "setup-lesson" has no cards/.test(m))).toBe(true);
    expect(msgs.some((m) => /drill "depth-reps" has no prompt/.test(m))).toBe(true);
    // present fallback content is still checked
    const over = bare();
    (over.mistakes![0] as any).headline = "one two three four five six seven eight nine";
    expect(validateSkillModel(over).errors.some((e) => e.path === "mistakes[0].headline")).toBe(true);
    // a spec a level check reads still needs its items
    const noItems = bare();
    (noItems.specs!["placement-quiz"] as any).items = [];
    expect(validateSkillModel(noItems).errors.some((e) => e.path === "specs.placement-quiz.items")).toBe(true);
  });

  it("skips what has no content, never invents text, and names the mistake when there's no headline", async () => {
    const r = await rig({ model: bare() });
    // the learner starts from the studio with no coach
    const v = (await r.learner.post("/api/live/start", { sk: r.sk })).body;
    expect(v).toMatchObject({ state: "coach-away", coachPresent: false });
    expect(v.screen).toMatchObject({ kind: "warmup", source: "fallback" });
    expect((await r.learner.get(`/api/live?sk=${r.sk}`)).live.liveSessionId).toBe(v.liveSessionId);
    const id = v.liveSessionId;
    // the lesson has no cards: skipped
    const a1 = await r.learner.advance(id, v.screen.id);
    expect(a1.screen.kind).toBe("drill");
    // a recording with a mistake: the fallback feedback uses the mistake's name, with no Why
    await analyzedAttempt(r, id, analysis({ mistakes: [shallow] }));
    const a2 = await r.learner.advance(id, a1.screen.id);
    expect(a2.screen).toMatchObject({ kind: "feedback", source: "fallback" });
    expect(a2.screen.item.view).toMatchObject({ headline: "Shallow reps", mistakeId: "shallow" });
    expect(a2.screen.item.view.why).toBeUndefined();
  });

  it("asks a coach to write what the model has no content for", async () => {
    const r = await rig({ model: bare() });
    const s = await r.start();
    expect(s.suggestion.item).toMatchObject({ type: "lesson", lessonId: "setup-lesson", cards: [], nodes: ["setup"] });
    expect(s.suggestion.reason).toMatch(/write them/);
    const res = await r.show("suggested");
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/no pre-written content/);
    expect(res.data.instruction).toMatch(/Write that screen yourself/);
    const written = await r.show({ kind: "lesson", title: "Setup", nodes: ["setup"], cards: [{ type: "predict", text: "Which stance is steadier?", options: ["Wide", "Narrow"], answer: 0 }] });
    expect(written.isError, written.text).toBe(false);
  });
});

describe("client session discovery", () => {
  it("finds the nearest ancestor's session file and ignores others", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "las-clients-"));
    const dir = join(dataDir, "clients", "claude-code");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "4242.json"), JSON.stringify({ sessionId: "not-mine", client: "claude-code", pid: 4242 }));
    expect(await discoverClientSession(dataDir, { pid: process.pid })).toBeUndefined();
    writeFileSync(join(dir, `${process.ppid}.json`), JSON.stringify({ sessionId: "conv-42", client: "claude-code", pid: process.ppid, cwd: "/x", at: new Date().toISOString() }));
    const found = await discoverClientSession(dataDir, { client: "claude-code" });
    expect(found).toMatchObject({ sessionId: "conv-42", pid: process.ppid });
    // an injected process table, as on any platform
    const parents = new Map([[10, 20], [20, 4242]]);
    expect((await discoverClientSession(dataDir, { pid: 10, parentOf: async (p) => parents.get(p) }))?.sessionId).toBe("not-mine");
    expect(await discoverClientSession(mkdtempSync(join(tmpdir(), "las-none-")))).toBeUndefined();
  });

  it("parses /proc stat lines whose command has spaces and parentheses", () => {
    expect(parentFromProcStat("1234 (node (worker) x) S 999 1234 1234 0 -1")).toBe(999);
    expect(parentFromProcStat("garbage")).toBeUndefined();
  });

  it("coach_start records the discovered conversation id", async () => {
    const r = await rig();
    const dir = join(r.dataDir, "clients", "claude-code");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${process.ppid}.json`), JSON.stringify({ sessionId: "conv-found", client: "claude-code", pid: process.ppid }));
    const s = await r.start({ client: undefined });
    expect(r.ctx.store.getLiveSession(s.liveSessionId)!.coachSessionId).toBe("conv-found");
    expect(r.ctx.store.getLiveSession(s.liveSessionId)!.client).toBe("claude-code");
  });
});
