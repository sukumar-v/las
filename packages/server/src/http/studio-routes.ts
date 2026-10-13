/**
 * Routes only the studio PWA uses (DESIGN §10, mcp-and-data §8): the web app manifest, the skill models the
 * learner can start, themes for Settings, attempts the studio needs beyond the loop routes (a second attempt,
 * stored evidence, the attempt waiting for a paired phone), proof checks, export and delete, phone pairing with
 * a single-use QR token over HTTPS from mkcert, Web Push subscriptions, and a test-only seeding route.
 *
 * The plain server stays on 127.0.0.1. Pairing adds an HTTPS server on port+1, bound to the LAN, only while a
 * pairing token is live (and for 30 minutes after it is used or expires). Every LAN request except the studio
 * shell and the claim itself needs the cookie the claim sets.
 */
import { execFile } from "node:child_process";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { BASE_THEME, ThemeSchema, validateTheme, type Theme } from "@las/schema";
import type { LasContext } from "../context.js";
import type { Handler, Req, Res, Router } from "./router.js";
import { LoopError } from "../core/common.js";
import { activeTheme, cacheThemeFonts } from "../core/theme.js";
import { startIntake } from "../core/intake.js";
import { readEvidence, startProofCheck } from "../core/evaluate.js";
import { exportData, deleteData } from "../core/track.js";
import { validateAndStore } from "../core/skill-model.js";
import { isSubscription, subscriptions, vapidKeys } from "../core/push.js";

function h(fn: (req: Req, res: Res) => Promise<unknown> | unknown): Handler {
  return async (req, res) => {
    try {
      const out = await fn(req, res);
      if (out !== undefined) res.json(out);
    } catch (e) {
      if (e instanceof LoopError) res.json({ ok: false, error: e.message, data: e.data ?? null }, 400);
      else res.json({ ok: false, error: (e as Error).message }, 500);
    }
  };
}

const need = (v: unknown, name: string): string => {
  if (typeof v !== "string" || !v) throw new LoopError(`Missing ${name}.`);
  return v;
};

/** Engines whose capture needs a camera, a microphone or motion sensors: what a paired phone is for. */
const DEVICE_ENGINES = new Set(["movement", "audio", "speech", "visual", "sensor"]);

// ---------------------------------------------------------------------------------------------
// Manifest

/** App icon: a plain mark drawn with currentColor (no fixed palette), as an SVG data URL. */
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V4h11l-1.5 3L16 10H5"/></svg>`;
const iconUrl = `data:image/svg+xml,${encodeURIComponent(ICON_SVG)}`;

export function manifest(ctx: LasContext): Record<string, unknown> {
  const t = activeTheme(ctx).theme;
  const dark = t.modes.length === 1 && t.modes[0] === "dark" && t.dark?.color ? { ...t.tokens.color, ...t.dark.color } : t.tokens.color;
  return {
    name: "Learn Any Skill",
    short_name: "LAS",
    description: "Practice any skill with on-device feedback",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: dark.bg,
    theme_color: dark.bg,
    icons: [
      { src: iconUrl, sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: iconUrl, sizes: "any", type: "image/svg+xml", purpose: "maskable" }
    ]
  };
}

// ---------------------------------------------------------------------------------------------
// Pairing

const PAIR_TTL_MS = 10 * 60 * 1000;
const LINGER_MS = 30 * 60 * 1000;
const COOKIE = "las_pair";

interface PairState {
  token: string;
  expiresAt: number;
  usedAt?: number;
  https?: HttpsServer;
  port?: number;
  closeTimer?: ReturnType<typeof setTimeout>;
  /** secrets of devices that claimed a token; LAN requests must carry one */
  sessions: Set<string>;
}

const pairing = new WeakMap<LasContext, PairState>();

/** Non-loopback IPv4 addresses of this computer: where a phone on the same network can reach it. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) if ((a.family === "IPv4" || (a.family as unknown) === 4) && !a.internal) out.push(a.address);
  return out;
}

function run(bin: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => execFile(bin, args, { timeout: 30_000 }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve({ stdout, stderr }))));
}

/** A certificate for the LAN addresses from mkcert, made once into ~/.las/certs (again when the addresses change). */
async function lanCertificate(ctx: LasContext, mkcert: string, ips: string[]): Promise<{ key: Buffer; cert: Buffer; caFile?: string }> {
  const dir = join(ctx.config.dataDir, "certs");
  mkdirSync(dir, { recursive: true });
  const key = join(dir, "lan-key.pem");
  const cert = join(dir, "lan.pem");
  const names = join(dir, "lan-names.json");
  const want = [...ips, "localhost"].sort();
  const have = existsSync(names) ? (JSON.parse(readFileSync(names, "utf8")) as string[]) : [];
  if (!existsSync(key) || !existsSync(cert) || have.join(",") !== want.join(",")) {
    await run(mkcert, ["-key-file", key, "-cert-file", cert, ...want]);
    writeFileSync(names, JSON.stringify(want));
  }
  let caFile: string | undefined;
  try {
    const root = (await run(mkcert, ["-CAROOT"])).stdout.trim();
    if (root && existsSync(join(root, "rootCA.pem"))) caFile = join(root, "rootCA.pem");
  } catch {
    /* the CA download link is optional */
  }
  return { key: readFileSync(key), cert: readFileSync(cert), caFile };
}

function cookieOf(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** LAN requests: the studio shell and the claim are open; everything else under /api needs a claimed device's cookie. */
export function lanAllowed(path: string, method: string, cookie: string | undefined, sessions: Set<string>): boolean {
  if (!path.startsWith("/api/")) return true;
  if (path === "/api/pair/claim" && method === "POST") return true;
  if (path === "/api/health" || path.startsWith("/api/fonts/") || path === "/api/pair/ca") return true;
  if (!cookie) return false;
  for (const s of sessions) if (sameSecret(s, cookie)) return true;
  return false;
}

function scheduleClose(state: PairState): void {
  if (state.closeTimer) clearTimeout(state.closeTimer);
  const until = Math.max(state.expiresAt, state.usedAt ?? 0) + LINGER_MS;
  state.closeTimer = setTimeout(() => {
    state.https?.close();
    state.https = undefined;
    state.port = undefined;
    state.sessions.clear();
  }, Math.max(0, until - Date.now()));
  state.closeTimer.unref?.();
}

async function startLanServer(ctx: LasContext, state: PairState, plain: Server, creds: { key: Buffer; cert: Buffer }): Promise<number> {
  if (state.https && state.port) return state.port;
  const forward = plain.listeners("request")[0] as ((req: IncomingMessage, res: ServerResponse) => void) | undefined;
  if (!forward) throw new LoopError("The studio server isn't running.");
  const server = createHttpsServer(creds, (req, res) => {
    const url = new URL(req.url ?? "/", "https://lan");
    if (!lanAllowed(url.pathname, req.method ?? "GET", cookieOf(req, COOKIE), state.sessions)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Pair this device first: scan the QR code in the studio's settings." }));
      return;
    }
    forward(req, res);
  });
  const port = ctx.config.port + 1;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => resolve());
  });
  state.https = server;
  state.port = port;
  // the LAN server never outlives the studio server
  plain.once("close", () => {
    server.close();
    if (state.https === server) {
      state.https = undefined;
      state.port = undefined;
    }
  });
  return port;
}

// ---------------------------------------------------------------------------------------------

export function mountStudioRoutes(router: Router, ctx: LasContext): void {
  router.get("/manifest.webmanifest", (_req, res) => {
    res.raw.writeHead(200, { "content-type": "application/manifest+json", "cache-control": "no-cache" });
    res.raw.end(JSON.stringify(manifest(ctx)));
  });

  // skill models the learner can start (the agent writes and validates them)
  router.get(
    "/api/skill-models",
    h(() => ({
      models: ctx.store
        .listSkillModels()
        .filter((m) => m.validatedAt)
        .map((m) => ({ id: m.id, skill: m.skill, name: m.model.name, engines: m.model.engines, source: m.source, version: m.version }))
    }))
  );
  router.post(
    "/api/intake/start",
    h(async (req) => {
      const b = await req.json();
      const r = await startIntake(ctx, need(b.skillModelId, "skillModelId"));
      return { intakeId: r.intake.id, view: r.view };
    })
  );

  // themes
  router.get(
    "/api/themes",
    h((req) => {
      const learner = ctx.store.getOrCreateLearner();
      const sk = req.query.get("sk");
      const e = sk ? ctx.store.resolveEnrollment(sk) : undefined;
      const active = activeTheme(ctx, e?.id);
      const all = activeTheme(ctx);
      return {
        active: { themeId: active.id, scope: active.scope },
        all: { themeId: all.id },
        themes: [{ id: "base", name: BASE_THEME.name, modes: BASE_THEME.modes, validated: true }, ...ctx.store.listThemes(learner.id).map((t) => ({ id: t.id, name: t.name, modes: t.theme.modes, validated: !!t.validatedAt }))]
      };
    })
  );
  router.get(
    "/api/themes/:id",
    h((req) => {
      if (req.params.id === "base") return { themeId: "base", theme: BASE_THEME };
      const row = ctx.store.getTheme(req.params.id);
      if (!row) throw new LoopError(`Unknown theme "${req.params.id}".`);
      return { themeId: row.id, theme: row.theme, validated: !!row.validatedAt };
    })
  );
  router.post(
    "/api/theme/set",
    h(async (req) => {
      const b = await req.json();
      const themeId = need(b.themeId, "themeId");
      const scope = typeof b.scope === "string" && b.scope ? b.scope : "all";
      const learner = ctx.store.getOrCreateLearner();
      const enrollment = scope === "all" ? null : ctx.store.resolveEnrollment(scope);
      if (scope !== "all" && !enrollment) throw new LoopError(`Unknown skill "${scope}".`);
      if (themeId === "base") ctx.store.clearThemeScope(learner.id, enrollment?.id ?? null);
      else {
        const row = ctx.store.getTheme(themeId);
        if (!row) throw new LoopError(`Unknown theme "${themeId}".`);
        if (!row.validatedAt) throw new LoopError(`Theme "${themeId}" never passed validation and can't be applied.`);
        await cacheThemeFonts(ctx, row.theme).catch(() => []);
        ctx.store.setThemeScope(learner.id, row.id, enrollment?.id ?? null);
      }
      ctx.store.logEvent(enrollment?.id ?? null, "theme.changed", { themeId, scope });
      ctx.emit("theme.changed", { themeId, scope });
      return { ok: true, themeId, scope };
    })
  );

  // attempts
  router.post(
    "/api/attempt/:id/again",
    h((req) => {
      const a = ctx.store.getAttempt(req.params.id);
      if (!a) throw new LoopError(`Unknown attempt "${req.params.id}".`);
      const next = ctx.store.createAttempt({ sessionId: a.sessionId, enrollmentId: a.enrollmentId, drillId: a.drillId, milestoneId: a.milestoneId, kind: a.kind, engine: a.engine, specId: a.specId, attemptNo: a.attemptNo + 1, prompt: a.prompt, spec: a.spec });
      return { attemptId: next.id, attemptNo: next.attemptNo, studioPath: `/app/capture/${next.id}` };
    })
  );
  router.get(
    "/api/attempt/:id/evidence",
    h((req) => {
      if (!ctx.store.getAttempt(req.params.id)) throw new LoopError(`Unknown attempt "${req.params.id}".`);
      return { evidence: readEvidence(ctx, req.params.id) ?? null };
    })
  );
  // the newest attempt in the last two hours that still needs a device: what a paired phone records next
  router.get(
    "/api/attempt/pending",
    h(() => {
      const since = new Date(Date.now() - 2 * 3600e3).toISOString();
      const rows = ctx.store.db.all("SELECT id, engine FROM attempt WHERE analysis IS NULL AND created_at >= ? ORDER BY created_at DESC LIMIT 20", since);
      const hit = rows.find((r) => DEVICE_ENGINES.has(String(r.engine)));
      return { attemptId: hit?.id ?? null, engine: hit?.engine ?? null };
    })
  );

  // proof checks
  router.post(
    "/api/proof/start",
    h(async (req) => {
      const b = await req.json();
      return startProofCheck(ctx, need(b.milestoneId ?? b.sk, "milestoneId or sk"), !!b.proceed);
    })
  );

  // export and delete
  router.get(
    "/api/export",
    h((req, res) => {
      const r = exportData(ctx, req.query.get("scope") ?? "all");
      res.raw.writeHead(200, { "content-type": "application/json", "content-disposition": `attachment; filename="${r.file.split(/[\\/]/).pop()}"`, "cache-control": "no-store" });
      res.raw.end(readFileSync(r.file));
      return undefined;
    })
  );
  router.post(
    "/api/delete",
    h(async (req) => {
      const b = await req.json();
      return deleteData(ctx, typeof b.scope === "string" ? b.scope : "all", b.confirm === true);
    })
  );

  // pairing
  router.get(
    "/api/pair",
    h(async (req) => {
      const caps = await ctx.capabilities();
      const mkcert = caps.external.find((e) => e.name === "mkcert")?.path;
      const ips = lanAddresses();
      if (!mkcert) return { available: false, reason: "mkcert", note: "Pairing a phone needs HTTPS on your local network, made with mkcert (BSD-3-Clause). Install mkcert and reload this page.", ips };
      if (!ips.length) return { available: false, reason: "network", note: "This computer isn't on a local network the phone can reach.", ips };
      const plain = (req.raw.socket as unknown as { server?: Server }).server;
      if (!plain) throw new LoopError("The studio server isn't running.");
      const prev = pairing.get(ctx);
      const state: PairState = prev ?? { token: "", expiresAt: 0, sessions: new Set() };
      state.token = ctx.store.createPairingToken(PAIR_TTL_MS);
      state.expiresAt = Date.now() + PAIR_TTL_MS;
      state.usedAt = undefined;
      pairing.set(ctx, state);
      let creds: { key: Buffer; cert: Buffer; caFile?: string };
      try {
        creds = await lanCertificate(ctx, mkcert, ips);
      } catch (e) {
        return { available: false, reason: "certificate", note: `mkcert couldn't make a certificate: ${(e as Error).message.split("\n")[0]}`, ips };
      }
      const port = await startLanServer(ctx, state, plain, creds);
      scheduleClose(state);
      return { available: true, https: true, token: state.token, expiresAt: new Date(state.expiresAt).toISOString(), urls: ips.map((ip) => `https://${ip}:${port}/pair/${state.token}`), ca: creds.caFile ? "/api/pair/ca" : undefined, ips };
    })
  );
  router.get("/api/pair/ca", (_req, res) => {
    void (async () => {
      const mkcert = (await ctx.capabilities()).external.find((e) => e.name === "mkcert")?.path;
      const root = mkcert ? (await run(mkcert, ["-CAROOT"]).catch(() => ({ stdout: "" }))).stdout.trim() : "";
      const file = root ? join(root, "rootCA.pem") : "";
      // only the public CA certificate, never its key
      if (!file || !existsSync(file)) return res.text("not found", 404);
      res.raw.writeHead(200, { "content-type": "application/x-pem-file", "content-disposition": 'attachment; filename="las-local-ca.pem"' });
      res.raw.end(readFileSync(file));
    })();
  });
  router.post(
    "/api/pair/claim",
    h(async (req, res) => {
      const b = await req.json();
      const token = need(b.token, "token");
      if (!ctx.store.consumePairingToken(token, String(req.raw.headers["user-agent"] ?? "phone").slice(0, 120))) {
        res.json({ ok: false, error: "This pairing code is used up or expired. Make a new one in the studio's settings." }, 400);
        return undefined;
      }
      ctx.devices = { ...ctx.devices, phone: true, reportedAt: Date.now() };
      const state = pairing.get(ctx);
      const secret = randomBytes(24).toString("base64url");
      if (state) {
        state.usedAt = Date.now();
        state.sessions.add(secret);
        scheduleClose(state);
      }
      ctx.emit("pair.claimed", { at: new Date().toISOString() });
      res.raw.setHeader("set-cookie", `${COOKIE}=${secret}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.round(LINGER_MS / 1000) + 600}`);
      return { ok: true, phone: true };
    })
  );

  // Web Push
  router.get(
    "/api/push/key",
    h(async () => ({ publicKey: (await vapidKeys(ctx)).publicKey }))
  );
  router.get(
    "/api/push/subscriptions",
    h(() => ({ subscriptions: subscriptions(ctx).map((s) => ({ id: s.id, endpointHost: new URL(s.subscription.endpoint).host })) }))
  );
  router.post(
    "/api/push/subscribe",
    h(async (req) => {
      const b = await req.json();
      const sub = b.subscription ?? b;
      if (!isSubscription(sub)) throw new LoopError("Not a push subscription: it needs an https endpoint and p256dh and auth keys.");
      const learner = ctx.store.getOrCreateLearner();
      const existing = ctx.store.listPushSubscriptions(learner.id).find((s) => (s.subscription as { endpoint?: string })?.endpoint === sub.endpoint);
      const id = existing?.id ?? ctx.store.addPushSubscription(learner.id, { endpoint: sub.endpoint, expirationTime: sub.expirationTime ?? null, keys: sub.keys });
      return { ok: true, id };
    })
  );
  router.delete(
    "/api/push/subscribe/:id",
    h((req) => {
      ctx.store.removePushSubscription(req.params.id);
      return { ok: true };
    })
  );

  // test-only seeding for the end-to-end suite
  if (process.env.LAS_E2E === "1") {
    router.post(
      "/api/e2e/seed",
      h(async (req) => {
        const b = await req.json();
        let skillModelId: string | undefined;
        let themeId: string | undefined;
        if (b.model) {
          const r = validateAndStore(ctx, b.model, await ctx.capabilities());
          if (!r.stored) throw new LoopError(`Model invalid: ${r.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`);
          skillModelId = r.stored.id;
        }
        if (b.theme) {
          const parsed = ThemeSchema.safeParse(b.theme);
          if (!parsed.success) throw new LoopError(`Theme invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
          const v = validateTheme(parsed.data);
          const theme: Theme = (v.ok ? parsed.data : (v.fixed ?? parsed.data)) as Theme;
          const learner = ctx.store.getOrCreateLearner();
          const row = ctx.store.saveTheme(learner.id, theme, true);
          themeId = row.id;
          // fonts are not fetched here: the suite runs offline and the fallback stacks are used
          if (b.apply !== false) {
            ctx.store.setThemeScope(learner.id, row.id, null);
            ctx.emit("theme.changed", { themeId: row.id, scope: "all" });
          }
        }
        return { ok: true, skillModelId, themeId };
      })
    );
  }
}
