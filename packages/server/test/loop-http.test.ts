import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Store } from "@las/store";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LasContext } from "../src/context.js";
import { startHttp } from "../src/http/app.js";
import { installLoop } from "../src/loop.js";
import { validateAndStore } from "../src/core/skill-model.js";
import { codeModel } from "./fixtures/code-model.js";


describe("studio API for onboarding and the loop", () => {
  let ctx: LasContext;
  let url: string;
  let close: () => Promise<void>;
  const get = async (p: string) => (await fetch(url + p)).json();
  const post = async (p: string, body: unknown = {}) => {
    const r = await fetch(url + p, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    return { status: r.status, body: await r.json() };
  };
  beforeAll(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "las-loop-http-"));
    ctx = new LasContext({ dataDir, port: 0, mediaDir: join(dataDir, "media"), fontsDir: join(dataDir, "fonts"), modelsDir: join(dataDir, "models") }, new Store(":memory:"));
    const h = await startHttp(ctx, installLoop(ctx));
    url = h.url;
    close = h.close;
  });
  afterAll(async () => {
    await close();
    ctx.close();
  });

  it("runs onboarding, Today, a session, feedback and check-ins over HTTP", async () => {
    const stored = validateAndStore(ctx, codeModel(), await ctx.capabilities()).stored!;
    const { startIntake } = await import("../src/core/intake.js");
    const intakeId = (await startIntake(ctx, stored.id)).intake.id;
    expect((await get(`/api/intake/${intakeId}`)).step).toBe("look");
    const answers: [string, unknown][] = [
      ["look", "plain"],
      ["why", ["job"]],
      ["picture", "scripts"],
      ["fresh", true],
      ["place", "ok"],
      ["time", { minutes: 120, deadline: "none" }],
      ["around", { access: ["A computer"] }]
    ];
    for (const [field, value] of answers) {
      const r = await post(`/api/intake/${intakeId}/answer`, { field, value });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    const bad = await post(`/api/intake/${intakeId}/answer`, { field: "nope", value: 1 });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/Unknown field/);
    expect((await post(`/api/intake/${intakeId}/place`)).body.placement.step).toBe(0);
    expect((await post(`/api/intake/${intakeId}/suggest`)).body.suggestions[0].kind).toBe("picture");
    expect((await post(`/api/intake/${intakeId}/feasibility`, { milestone: "quick" })).body.verdict).toBe("Realistic");
    const set = await post(`/api/intake/${intakeId}/milestone`, { milestone: "quick" });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const sk = set.body.sk;
    const state = await get("/api/state");
    expect(state.enrollments[0].sk).toBe(sk);
    expect(state.themeId).toBe("base");
    const today = await get(`/api/today?sk=${sk}`);
    expect(today.state).toBe("first-day");
    const plan = (await post("/api/session/next", { sk, minutes: 30 })).body;
    expect(plan.blocks.reduce((t: number, b: any) => t + b.minutes, 0)).toBe(30);
    expect((await get(`/api/session/${plan.sessionId}`)).sessionId).toBe(plan.sessionId);
    const build = await post("/api/drill/fn-build/next", { sk, sessionId: plan.sessionId });
    expect(build.body.kind).toBe("capture");
    const capture = { attemptSpecId: build.body.attemptId as string };
    const attempt = await get(`/api/attempt/${capture.attemptSpecId}`);
    expect(attempt.spec.kind).toBe("test");
    const analysis = { engine: "code", quality: { ok: true, issues: [] }, metrics: { pass_rate: { value: 0.5, unit: "", confidence: 1 } }, mistakes: [{ id: "no-return", severity: 2, confidence: 0.95, at: [2], evidence: { kind: "line", file: "main.py", line: 2 } }], version: "test" };
    const posted = await post(`/api/attempt/${capture.attemptSpecId}/analysis`, { analysis });
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    expect(posted.body.feedback.mistakeId).toBe("no-return");
    const fb = await get(`/api/attempt/${capture.attemptSpecId}/feedback`);
    expect(fb.feedback.evidence.ref).toEqual({ kind: "line", file: "main.py", line: 2 });
    expect(fb.feedback.why.figure.kind).toBe("code");
    const drill = await post("/api/drill/fn-quiz/next", { sk, sessionId: plan.sessionId });
    expect(drill.body.kind).toBe("items");
    expect(drill.body.item.answer).toBeUndefined();
    const next = await post("/api/drill/fn-quiz/next", { sk, sessionId: plan.sessionId, answer: { itemId: drill.body.item.id, answer: 0 } });
    expect(next.body.last.itemId).toBe(drill.body.item.id);
    expect((await get(`/api/reviews?sk=${sk}`)).cards).toEqual([]);
    expect((await get(`/api/progress?sk=${sk}`)).sk).toBe(sk);
    const ev = await post("/api/events", { type: "session.completed", sessionId: plan.sessionId, minutes: 30 });
    expect(ev.body.ok).toBe(true);
    expect((await get(`/api/summary/${plan.sessionId}`)).minutes).toBe(30);
    const checkins = await get(`/api/checkins?sk=${sk}`);
    expect(checkins.checkins.map((c: any) => c.kind)).toEqual(expect.arrayContaining(["session-feel", "weekly-review"]));
    const run = await post("/api/checkins/run");
    expect(Array.isArray(run.body.due)).toBe(true);
    const consent = await post("/api/consent", { runner: "local", granted: true });
    expect(consent.body.granted).toBe(true);
    expect(ctx.store.getSetting("consent.runner.local", false)).toBe(true);
    expect((await post("/api/consent", { runner: "cloud", granted: true })).status).toBe(400);
    const unknown = await post("/api/events", { type: "session.started", sessionId: "ses_missing" });
    expect(unknown.body.result.error).toMatch(/Unknown session/);
  });
});
