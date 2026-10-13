import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Store } from "@las/store";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LasContext } from "../src/context.js";
import { startHttp } from "../src/http/app.js";
import { installLoop } from "../src/loop.js";

describe("http app", () => {
  let ctx: LasContext;
  let url: string;
  let close: () => Promise<void>;
  beforeAll(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "las-http-"));
    ctx = new LasContext({ dataDir, port: 0, mediaDir: join(dataDir, "media"), fontsDir: join(dataDir, "fonts"), modelsDir: join(dataDir, "models") }, new Store(":memory:"));
    const h = await startHttp(ctx, installLoop(ctx));
    url = h.url;
    close = h.close;
  });
  afterAll(async () => {
    await close();
    ctx.close();
  });
  it("answers health, theme and devices, and serves a placeholder when the studio isn't built", async () => {
    expect((await (await fetch(`${url}/api/health`)).json()).ok).toBe(true);
    const t = await (await fetch(`${url}/api/theme`)).json();
    expect(t.themeId).toBe("base");
    const d = await fetch(`${url}/api/devices`, { method: "POST", body: JSON.stringify({ camera: true, microphone: true }), headers: { "content-type": "application/json" } });
    expect((await d.json()).ok).toBe(true);
    expect(ctx.devices.camera).toBe(true);
    const page = await (await fetch(`${url}/`)).text();
    expect(page).toMatch(/studio hasn't been built/);
    expect((await fetch(`${url}/api/nope`)).status).toBe(404);
  });
  it("accepts studio events and stores uploaded media per attempt", async () => {
    const bad = await fetch(`${url}/api/events`, { method: "POST", body: JSON.stringify({ type: "nope" }), headers: { "content-type": "application/json" } });
    expect(bad.status).toBe(400);
    const ok = await fetch(`${url}/api/events`, { method: "POST", body: JSON.stringify({ type: "session.started", sessionId: "ses_x" }), headers: { "content-type": "application/json" } });
    expect((await ok.json()).ok).toBe(true);
    const learner = ctx.store.getOrCreateLearner();
    const model = ctx.store.saveSkillModel({ skill: "x", name: "X", source: "generated" } as any, true);
    const e = ctx.store.createEnrollment(learner.id, model.id);
    const a = ctx.store.createAttempt({ enrollmentId: e.id, kind: "perform", engine: "audio", attemptNo: 1 });
    const up = await fetch(`${url}/api/media/${a.id}`, { method: "POST", body: new Uint8Array([1, 2, 3]), headers: { "content-type": "audio/webm" } });
    const j = await up.json();
    expect(j.ok).toBe(true);
    expect(ctx.store.getAttempt(a.id)?.mediaRef).toBe(j.mediaRef);
    const back = await fetch(`${url}/api/media/${a.id}`);
    expect(new Uint8Array(await back.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });
});
