import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Store } from "@las/store";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpsRequest } from "node:https";
import { LasContext } from "../src/context.js";
import { startHttp } from "../src/http/app.js";
import { installLoop } from "../src/loop.js";
import { lanAllowed } from "../src/http/studio-routes.js";
import { pushDeliverer, vapidKeys } from "../src/core/push.js";
import { validateAndStore } from "../src/core/skill-model.js";
import { codeModel } from "./fixtures/code-model.js";

/** A stand-in for mkcert (BSD-3-Clause) made with openssl, so the pairing path runs without it installed. */
function fakeMkcert(dir: string): void {
  const script = `#!/bin/sh
if [ "$1" = "-CAROOT" ]; then echo "${dir}/ca"; exit 0; fi
KEY=""; CERT=""
while [ $# -gt 0 ]; do case "$1" in -key-file) KEY="$2"; shift 2;; -cert-file) CERT="$2"; shift 2;; *) shift;; esac; done
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$KEY" -out "$CERT" -days 1 -subj "/CN=las-test" >/dev/null 2>&1
`;
  writeFileSync(join(dir, "mkcert"), script);
  chmodSync(join(dir, "mkcert"), 0o755);
}

function https(port: number, path: string, opts: { method?: string; body?: string; cookie?: string } = {}): Promise<{ status: number; body: string; setCookie?: string[] }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest({ host: "127.0.0.1", port, path, method: opts.method ?? "GET", rejectUnauthorized: false, headers: { ...(opts.cookie ? { cookie: opts.cookie } : {}), ...(opts.body ? { "content-type": "application/json" } : {}) } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, setCookie: res.headers["set-cookie"] }));
    });
    req.on("error", reject);
    req.end(opts.body);
  });
}

describe("studio routes", () => {
  let ctx: LasContext;
  let url: string;
  let close: () => Promise<void>;
  const port = 47000 + Math.floor(Math.random() * 900) * 2;
  const oldPath = process.env.PATH;
  const get = async (p: string) => (await fetch(url + p)).json();
  const post = async (p: string, body: unknown = {}) => {
    const r = await fetch(url + p, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    return { status: r.status, body: await r.json() };
  };
  beforeAll(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "las-studio-routes-"));
    const bin = mkdtempSync(join(tmpdir(), "las-fake-bin-"));
    fakeMkcert(bin);
    process.env.PATH = `${bin}:${oldPath}`;
    ctx = new LasContext({ dataDir, port, mediaDir: join(dataDir, "media"), fontsDir: join(dataDir, "fonts"), modelsDir: join(dataDir, "models") }, new Store(":memory:"));
    const h = await startHttp(ctx, installLoop(ctx));
    url = h.url;
    close = h.close;
  });
  afterAll(async () => {
    process.env.PATH = oldPath;
    await close();
    ctx.close();
  });

  it("serves a manifest whose color comes from the active theme", async () => {
    const m = await get("/manifest.webmanifest");
    expect(m.display).toBe("standalone");
    expect(m.theme_color).toMatch(/^#/);
    expect(m.icons[0].src).toMatch(/^data:image\/svg\+xml/);
  });

  it("lists skill models, starts an intake, and makes a second attempt", async () => {
    const stored = validateAndStore(ctx, codeModel(), await ctx.capabilities()).stored!;
    const models = (await get("/api/skill-models")).models;
    expect(models.map((m: any) => m.id)).toContain(stored.id);
    const started = await post("/api/intake/start", { skillModelId: stored.id });
    expect(started.body.view.step).toBe("look");
    const a = ctx.store.createAttempt({ enrollmentId: started.body.intakeId, kind: "probe", engine: "movement", attemptNo: 1, prompt: "x" });
    const again = await post(`/api/attempt/${a.id}/again`);
    expect(again.body.attemptNo).toBe(2);
    expect((await get("/api/attempt/pending")).attemptId).toBe(again.body.attemptId);
    expect((await get(`/api/attempt/${a.id}/evidence`)).evidence).toBeNull();
    expect((await get("/api/themes/base")).theme.id).toBeDefined();
    expect((await get("/api/themes")).themes[0].id).toBe("base");
  });

  it("pairs a phone over HTTPS with a single-use token and a device cookie", async () => {
    const info = await get("/api/pair");
    expect(info.available, JSON.stringify(info)).toBe(true);
    expect(info.urls[0]).toMatch(new RegExp(`^https://[\\d.]+:${port + 1}/pair/pair_`));
    const lan = port + 1;
    expect((await https(lan, "/api/state")).status).toBe(401);
    expect((await https(lan, "/pair/x")).status).toBe(200);
    const claim = await https(lan, "/api/pair/claim", { method: "POST", body: JSON.stringify({ token: info.token }) });
    expect(claim.status).toBe(200);
    const cookie = claim.setCookie![0].split(";")[0];
    expect(ctx.devices.phone).toBe(true);
    expect((await https(lan, "/api/state", { cookie })).status).toBe(200);
    expect((await https(lan, "/api/pair/claim", { method: "POST", body: JSON.stringify({ token: info.token }) })).status).toBe(400);
  });

  it("keeps LAN requests to the shell and the claim until a device is paired", () => {
    const sessions = new Set(["secret"]);
    expect(lanAllowed("/app/today", "GET", undefined, sessions)).toBe(true);
    expect(lanAllowed("/api/pair/claim", "POST", undefined, sessions)).toBe(true);
    expect(lanAllowed("/api/state", "GET", undefined, sessions)).toBe(false);
    expect(lanAllowed("/api/state", "GET", "wrong!", sessions)).toBe(false);
    expect(lanAllowed("/api/state", "GET", "secret", sessions)).toBe(true);
  });

  it("stores push subscriptions and pushes check-ins only once someone opted in", async () => {
    const key = await get("/api/push/key");
    expect(key.publicKey).toBe((await vapidKeys(ctx)).publicKey);
    expect(pushDeliverer(ctx)).toBeUndefined();
    expect((await post("/api/push/subscribe", { subscription: { endpoint: "http://insecure" } })).status).toBe(400);
    const sub = { endpoint: "https://127.0.0.1:1/push", keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" } };
    const r = await post("/api/push/subscribe", { subscription: sub });
    expect(r.body.id).toMatch(/^push_/);
    expect((await get("/api/push/subscriptions")).subscriptions).toHaveLength(1);
    const deliver = pushDeliverer(ctx)!;
    // an unreachable push service never fails the check-in run
    await expect(deliver({ id: "chk_x", kind: "weekly-review", question: "q", options: [], dueAt: new Date().toISOString() })).resolves.toBeUndefined();
    await fetch(`${url}/api/push/subscribe/${r.body.id}`, { method: "DELETE" });
    expect(pushDeliverer(ctx)).toBeUndefined();
  });
});
