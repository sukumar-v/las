import { createServer, type Server } from "node:http";
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { StudioEventSchema, type StudioEvent } from "@las/schema";
import type { LasContext } from "../context.js";
import { activeTheme, readCachedFontCss } from "../core/theme.js";
import { Router, wrap } from "./router.js";
import { mountLoopRoutes } from "./loop-routes.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".webmanifest": "application/manifest+json",
  ".tflite": "application/octet-stream",
  ".task": "application/octet-stream",
  ".bin": "application/octet-stream",
  ".onnx": "application/octet-stream",
  ".data": "application/octet-stream",
  ".zip": "application/zip",
  ".whl": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8"
};

/** Handlers the learning loop installs (phase 5) so the HTTP layer stays thin. */
export interface EventSink {
  onEvent(event: StudioEvent): Promise<unknown> | unknown;
}

function serveFile(res: import("node:http").ServerResponse, file: string, headers: Record<string, string> = {}): boolean {
  if (!existsSync(file) || !statSync(file).isFile()) return false;
  const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": type, "content-length": statSync(file).size, ...headers });
  createReadStream(file).pipe(res);
  return true;
}

const PLACEHOLDER = `<!doctype html><meta charset="utf-8"><title>LAS studio</title><style>body{font-family:system-ui;margin:3rem auto;max-width:36rem;line-height:1.5}code{background:#eee;padding:.1em .3em}</style>
<h1>Learn Any Skill studio</h1><p>The studio hasn't been built yet. Run <code>pnpm --filter @las/studio build</code> (or <code>npx las-agents setup</code>) and reload. Everything else works through the MCP server meanwhile.</p>`;

export function createHttpApp(ctx: LasContext, sink?: EventSink): { server: Server; router: Router } {
  const router = new Router();
  const dist = ctx.config.studioDist;

  router.get("/api/health", (_req, res) => res.json({ ok: true, version: ctx.config.version, studio: !!(dist && existsSync(join(dist, "index.html"))) }));
  router.get("/api/capabilities", async (req, res) => res.json(await ctx.capabilities(req.query.get("fresh") === "1")));
  router.post("/api/devices", async (req, res) => {
    const d = await req.json();
    ctx.devices = { camera: !!d.camera, microphone: !!d.microphone, motion: !!d.motion, phone: !!d.phone || ctx.devices.phone, reportedAt: Date.now() };
    res.json({ ok: true });
  });
  router.get("/api/theme", (req, res) => {
    const sk = req.query.get("sk");
    const e = sk ? ctx.store.resolveEnrollment(sk) : undefined;
    const t = activeTheme(ctx, e?.id);
    res.json({ themeId: t.id, scope: t.scope, theme: t.theme });
  });
  router.get("/api/fonts/:family/font.css", (req, res) => {
    const css = readCachedFontCss(ctx, req.params.family);
    if (!css) return res.text("/* not cached: fallback stack */", 404, "text/css");
    res.text(css, 200, "text/css; charset=utf-8");
  });
  router.get("/api/fonts/:family/:file", (req, res) => {
    const dir = join(ctx.config.fontsDir, req.params.family.replace(/[^\w-]+/g, "_"));
    const file = resolve(dir, req.params.file);
    if (!file.startsWith(resolve(dir)) || !serveFile(res.raw, file, { "cache-control": "public, max-age=31536000" })) res.text("not found", 404);
  });
  router.get("/api/stream", (req, res) => {
    res.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.raw.write(`event: hello\ndata: {}\n\n`);
    const listener = (ev: { type: string; payload: unknown }) => res.raw.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev.payload)}\n\n`);
    ctx.listeners.add(listener);
    const ping = setInterval(() => res.raw.write(`: ping\n\n`), 25000);
    req.raw.on("close", () => {
      ctx.listeners.delete(listener);
      clearInterval(ping);
    });
  });
  router.post("/api/events", async (req, res) => {
    const parsed = StudioEventSchema.safeParse(await req.json());
    if (!parsed.success) return res.json({ ok: false, errors: parsed.error.issues }, 400);
    const result = sink ? await sink.onEvent(parsed.data) : undefined;
    res.json({ ok: true, result: result ?? null });
  });
  router.post("/api/media/:attemptId", async (req, res) => {
    const attempt = ctx.store.getAttempt(req.params.attemptId);
    if (!attempt) return res.json({ ok: false, error: "unknown attempt" }, 404);
    const type = req.raw.headers["content-type"] ?? "application/octet-stream";
    const ext = type.includes("webm") ? (type.includes("audio") ? ".webm" : ".webm") : type.includes("mp4") ? ".mp4" : type.includes("wav") ? ".wav" : type.includes("ogg") ? ".ogg" : type.includes("png") ? ".png" : type.includes("jpeg") ? ".jpg" : type.includes("json") ? ".json" : ".bin";
    const dir = join(ctx.config.mediaDir, attempt.id);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `media${ext}`);
    writeFileSync(file, await req.body());
    ctx.store.setAttemptMedia(attempt.id, file);
    ctx.store.logEvent(attempt.enrollmentId, "attempt.captured", { attemptId: attempt.id, mediaRef: file });
    res.json({ ok: true, mediaRef: file });
  });
  router.get("/api/media/:attemptId", (req, res) => {
    const attempt = ctx.store.getAttempt(req.params.attemptId);
    if (!attempt?.mediaRef || !serveFile(res.raw, attempt.mediaRef)) res.text("not found", 404);
  });
  mountLoopRoutes(router, ctx);
  router.get("/api/models/*", (req, res) => {
    const rel = normalize(req.params["*"]).replace(/^(\.\.[/\\])+/, "");
    const file = resolve(ctx.config.modelsDir, rel);
    if (!file.startsWith(resolve(ctx.config.modelsDir)) || !serveFile(res.raw, file, { "cache-control": "public, max-age=31536000" })) res.text("not cached", 404);
  });

  const server = createServer(async (raw, res) => {
    const url = new URL(raw.url ?? "/", "http://localhost");
    const m = router.match(raw.method ?? "GET", url.pathname);
    try {
      if (m) {
        const { req, out } = wrap(raw, res, m.params);
        await m.handler(req, out);
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      // static studio
      if (dist) {
        const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
        const file = resolve(dist, "." + rel);
        if (file.startsWith(resolve(dist)) && rel !== "/" && serveFile(res, file, { "cache-control": rel.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache" })) return;
        if (serveFile(res, join(dist, "index.html"), { "cache-control": "no-cache" })) return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PLACEHOLDER);
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: (e as Error).message }));
    }
  });
  return { server, router };
}

export function startHttp(ctx: LasContext, sink?: EventSink): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const { server } = createHttpApp(ctx, sink);
  return new Promise((resolveP, reject) => {
    server.once("error", reject);
    server.listen(ctx.config.port, ctx.config.host, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : ctx.config.port;
      resolveP({ server, url: `http://${ctx.config.host}:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}
