import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { runInNewContext } from "node:vm";
import * as extApps from "@modelcontextprotocol/ext-apps";
import { connect } from "./helpers.js";
import { codeModel } from "./fixtures/code-model.js";
import { setMilestone, startIntake } from "../src/core/intake.js";
import { validateAndStore } from "../src/core/skill-model.js";
import { analyzeEvidence, decodeWav, readEvidence } from "../src/core/evaluate.js";
import { fallbackWidgetHtml, MCP_APPS, WIDGET_HOST_TIMEOUT_MS } from "../src/mcp/widgets.js";
import type { LasContext } from "../src/context.js";

/**
 * Test data only: the code test model with three extra specs (a picture rubric, a chess game, a spoken phrase),
 * so the visual grading hand-off and the optional local helpers can be exercised without a skill of their own.
 */
function mixedModel() {
  const base = codeModel();
  return {
    ...base,
    engines: [...base.engines, "visual", "game", "speech"],
    specs: {
      ...base.specs,
      "sketch-rubric": { kind: "rubric", criteria: [{ id: "line", label: "Line quality", levels: { "1": "Shaky, broken lines", "2": "Mostly steady lines", "3": "Confident, even lines" } }, { id: "shape", label: "Shapes", levels: { "1": "Shapes off", "2": "Shapes close", "3": "Shapes right" } }], must_cite: "region" },
      "game-check": { kind: "game", game: "chess", side: "both", engine: "uci", depth: 6, fallback_items: [{ position: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", best: "e4", prompt: "A good first move" }] },
      "say-it": { kind: "speech", language: "es-ES", target: "hola mundo" }
    }
  };
}

async function enroll(ctx: LasContext) {
  const caps = await ctx.capabilities();
  const v = validateAndStore(ctx, mixedModel(), caps);
  if (!v.stored) throw new Error(`model rejected: ${JSON.stringify(v)}`);
  const r = await startIntake(ctx, v.stored.id);
  const model = ctx.store.getSkillModel(v.stored.id)!.model;
  ctx.store.updateIntake(r.intake.id, { answers: { look: "plain", why: [model.why[0].id], picture: model.pictures[0].id, fresh: true, placeConfirmed: true, minutes: 180, deadline: "none", aroundDone: true } });
  return setMilestone(ctx, r.intake.id, "quick");
}

/** A valid 1×1 RGBA PNG, built by hand. */
function tinyPng(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.from([0, 200, 120, 40, 255]))), chunk("IEND", Buffer.alloc(0))]);
}

/** 16-bit mono PCM WAV of a tone, loud enough to pass the audio quality check. */
function toneWav(seconds = 1.5, rate = 16000): Buffer {
  const n = Math.round(seconds * rate);
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(36 + n * 2, 4);
  b.write("WAVE", 8, "ascii");
  b.write("fmt ", 12, "ascii");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "ascii");
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 0.3 * 32767), 44 + i * 2);
  return b;
}

function putMedia(ctx: LasContext, attemptId: string, name: string, bytes: Buffer): string {
  const dir = join(ctx.config.mediaDir, attemptId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, bytes);
  ctx.store.setAttemptMedia(attemptId, file);
  return file;
}

describe("visual grading hands the image to the agent", () => {
  let s: Awaited<ReturnType<typeof connect>>;
  let sk = "";
  beforeAll(async () => {
    s = await connect();
    s.ctx.store.updateLearner({ timezone: "UTC" });
    sk = (await enroll(s.ctx)).sk;
  }, 30000);
  afterAll(async () => s.close());

  const callRaw = async (name: string, args: Record<string, unknown>) => (await s.client.callTool({ name, arguments: args })) as any;

  it("get_analysis returns the uploaded image and the rubric until the agent grades it", async () => {
    const cap = await s.call("request_capture", { sk, engine: "visual", spec: "sketch-rubric", prompt: "Draw a cup" });
    expect(cap.isError, cap.text).toBe(false);
    expect(cap.text).toMatch(/get_analysis/);
    const attemptId = cap.data.data.attemptId as string;
    const png = tinyPng();
    putMedia(s.ctx, attemptId, "media.png", png);

    // the studio posts measurements only: the analysis is "reduced" and grading is pending
    const posted = await analyzeEvidence(s.ctx, attemptId, { width: 1, height: 1 });
    expect(posted.analysis.precision).toBe("reduced");

    const r = await callRaw("get_analysis", { attemptId });
    expect(r.isError).toBeFalsy();
    const image = r.content.find((c: any) => c.type === "image");
    expect(image).toBeTruthy();
    expect(image.mimeType).toBe("image/png");
    expect(Buffer.from(image.data, "base64").equals(png)).toBe(true);
    const text = r.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
    expect(text).toMatch(/Grade the attached image against this rubric/);
    expect(text).toMatch(/line \(Line quality\)/);
    expect(text).toMatch(/submit_rubric_grade/);
    expect(text).toMatch(/region/);
    expect(r.structuredContent.data.grading.imageAttached).toBe(true);

    const graded = await s.call("submit_rubric_grade", {
      attemptId,
      grades: [
        { criterion: "line", level: 1, confidence: 0.9, region: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, note: "wobbly outline" },
        { criterion: "shape", level: 3, confidence: 0.8, region: { x: 0, y: 0, w: 1, h: 1 }, note: "round cup" }
      ]
    });
    expect(graded.isError, graded.text).toBe(false);
    expect(graded.data.data.analysis.precision).toBe("full");

    const after = await callRaw("get_analysis", { attemptId });
    expect(after.content.some((c: any) => c.type === "image")).toBe(false);
    expect(after.structuredContent.data.analysis.precision).toBe("full");
    expect(after.structuredContent.data.feedback.headline).toBeTruthy();
  });

  it("points at the studio instead of attaching an image over 1.5 MB", async () => {
    const cap = await s.call("request_capture", { sk, engine: "visual", spec: "sketch-rubric", prompt: "Draw a chair" });
    const attemptId = cap.data.data.attemptId as string;
    putMedia(s.ctx, attemptId, "media.png", Buffer.concat([tinyPng(), Buffer.alloc(1.6 * 1024 * 1024)]));
    const r = await callRaw("get_analysis", { attemptId });
    expect(r.content.some((c: any) => c.type === "image")).toBe(false);
    const text = r.content.map((c: any) => c.text ?? "").join("\n");
    expect(text).toMatch(/too large/);
    expect(text).toContain(`/api/media/${attemptId}`);
    expect(text).toMatch(/submit_rubric_grade/);
  });
});

/** A UCI engine in a few lines of node: answers from a table of FEN -> best move and score. */
const FAKE_UCI = (table: string) => `#!/usr/bin/env node
const fs = require("node:fs");
const t = JSON.parse(fs.readFileSync(${JSON.stringify(table)}, "utf8"));
let fen = "";
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  if (line === "uci") console.log("id name Fake\\nuciok");
  else if (line === "isready") console.log("readyok");
  else if (line.startsWith("position fen ")) fen = line.slice(13);
  else if (line.startsWith("go depth ")) {
    const e = t[fen] || { best: "0000", score: "cp 0" };
    console.log("info depth 6 score " + e.score + " pv " + e.best);
    console.log("bestmove " + e.best);
  } else if (line === "quit") process.exit(0);
});
`;

/** A stand-in for whisper-cli: needs a WAV input, writes whisper.cpp JSON next to -of. */
const FAKE_WHISPER = `#!/bin/sh
OF=""; F=""
while [ $# -gt 0 ]; do
  case "$1" in
    -of) OF="$2"; shift ;;
    -f) F="$2"; shift ;;
  esac
  shift
done
[ "$(head -c 4 "$F")" = "RIFF" ] || { echo "bad wav" >&2; exit 2; }
printf '%s' '{"result":{"language":"es"},"transcription":[{"text":" hola mundo","offsets":{"from":0,"to":1200}}]}' > "$OF.json"
`;

describe("optional local helpers (a chess engine, whisper.cpp)", () => {
  let bin = "";
  let path0 = "";
  const env0 = process.env.LAS_WHISPER_MODEL;
  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), "las-fake-bin-"));
    path0 = process.env.PATH ?? "";
    process.env.PATH = `${bin}${delimiter}${path0}`;
    delete process.env.LAS_WHISPER_MODEL;
  });
  afterEach(() => {
    process.env.PATH = path0;
    if (env0 === undefined) delete process.env.LAS_WHISPER_MODEL;
    else process.env.LAS_WHISPER_MODEL = env0;
    rmSync(bin, { recursive: true, force: true });
  });

  const tool = (name: string, body: string) => {
    const p = join(bin, name);
    writeFileSync(p, body);
    chmodSync(p, 0o755);
  };

  it("fills engine evaluations from a UCI engine on PATH", async () => {
    const start = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    const afterE4 = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
    const afterE5 = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2";
    const table = join(bin, "table.json");
    writeFileSync(table, JSON.stringify({ [start]: { best: "e2e4", score: "cp 30" }, [afterE4]: { best: "c7c5", score: "cp -20" }, [afterE5]: { best: "g1f3", score: "cp 45" } }));
    tool("stockfish", FAKE_UCI(table));
    const s = await connect();
    try {
      const { sk } = await enroll(s.ctx);
      const cap = await s.call("request_capture", { sk, engine: "game", spec: "game-check", prompt: "Play two moves" });
      const attemptId = cap.data.data.attemptId as string;
      const r = await analyzeEvidence(s.ctx, attemptId, { moves: ["e4", "e5"] });
      expect(r.analysis.precision).toBe("full");
      expect(r.analysis.metrics.agreement).toBeTruthy();
      expect(r.analysis.metrics.puzzles_total).toBeUndefined();
      const stored = readEvidence(s.ctx, attemptId);
      expect(stored.engineEvals).toHaveLength(2);
      expect(stored.engineEvals[0]).toMatchObject({ ply: 1, best: "e2e4", bestCp: 30 });
    } finally {
      await s.close();
    }
  }, 30000);

  it("falls back to puzzles and says why when the engine breaks", async () => {
    tool("stockfish", "#!/bin/sh\nexit 3\n");
    const s = await connect();
    try {
      const { sk } = await enroll(s.ctx);
      const cap = await s.call("request_capture", { sk, engine: "game", spec: "game-check", prompt: "Play two moves" });
      const r = await analyzeEvidence(s.ctx, cap.data.data.attemptId, { moves: ["e4", "e5"], puzzleAnswers: [{ position: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", answer: "e4" }] });
      expect(r.analysis.metrics.puzzles_solved?.value).toBe(1);
      expect(r.analysis.quality.issues.join(" ")).toMatch(/local chess engine \(stockfish\) failed/);
    } finally {
      await s.close();
    }
  }, 30000);

  it("transcribes an uploaded WAV with whisper-cli and a model file", async () => {
    tool("whisper-cli", FAKE_WHISPER);
    const s = await connect();
    try {
      mkdirSync(s.ctx.config.modelsDir, { recursive: true });
      writeFileSync(join(s.ctx.config.modelsDir, "ggml-tiny.bin"), "not a real model");
      const caps = await s.ctx.capabilities(true);
      expect(caps.engines.find((e) => e.id === "speech")?.details?.transcription).toBe("whisper.cpp process");
      const { sk } = await enroll(s.ctx);
      const cap = await s.call("request_capture", { sk, engine: "speech", spec: "say-it", prompt: "Say hola mundo" });
      const attemptId = cap.data.data.attemptId as string;
      putMedia(s.ctx, attemptId, "media.wav", toneWav());
      const r = await analyzeEvidence(s.ctx, attemptId, {});
      expect(r.analysis.quality.ok, r.analysis.quality.issues.join("; ")).toBe(true);
      expect(r.analysis.metrics.intelligibility?.value).toBe(1);
      const stored = readEvidence(s.ctx, attemptId);
      expect(stored.transcript.text).toBe("hola mundo");
      expect(stored.transcriber).toBe("whisper-cli:ggml-tiny.bin");
      expect(stored.samples).toBeUndefined();
    } finally {
      await s.close();
    }
  }, 30000);

  it("skips transcription with a note when the recording isn't WAV and ffmpeg is missing", async () => {
    tool("whisper-cli", FAKE_WHISPER);
    const s = await connect();
    try {
      mkdirSync(s.ctx.config.modelsDir, { recursive: true });
      writeFileSync(join(s.ctx.config.modelsDir, "ggml-tiny.bin"), "x");
      const caps = await s.ctx.capabilities(true);
      // whatever this machine has, act as if ffmpeg were missing
      s.ctx.capabilities = async () => ({ ...caps, external: caps.external.filter((e) => e.name !== "ffmpeg") });
      const { sk } = await enroll(s.ctx);
      const cap = await s.call("request_capture", { sk, engine: "speech", spec: "say-it", prompt: "Say hola mundo" });
      const attemptId = cap.data.data.attemptId as string;
      putMedia(s.ctx, attemptId, "media.webm", Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]));
      const r = await analyzeEvidence(s.ctx, attemptId, {});
      expect(r.analysis.quality.issues.join(" ")).toMatch(/ffmpeg isn't installed/);
    } finally {
      await s.close();
    }
  }, 30000);

  it("decodes other formats with ffmpeg before transcribing", async () => {
    tool("whisper-cli", FAKE_WHISPER);
    // a stand-in for ffmpeg: checks the arguments LAS passes and writes 1.5 s of 16 kHz float samples
    tool(
      "ffmpeg",
      `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a.join(" ").indexOf("-f f32le -ac 1 -ar 16000 -") < 0) { console.error("bad args " + a.join(" ")); process.exit(1); }
const n = 24000, f = new Float32Array(n);
for (let i = 0; i < n; i++) f[i] = Math.sin(2 * Math.PI * 220 * i / 16000) * 0.3;
process.stdout.write(Buffer.from(f.buffer));
`
    );
    const s = await connect();
    try {
      mkdirSync(s.ctx.config.modelsDir, { recursive: true });
      writeFileSync(join(s.ctx.config.modelsDir, "ggml-tiny.bin"), "x");
      const { sk } = await enroll(s.ctx);
      const cap = await s.call("request_capture", { sk, engine: "speech", spec: "say-it", prompt: "Say hola mundo" });
      const attemptId = cap.data.data.attemptId as string;
      putMedia(s.ctx, attemptId, "media.webm", Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]));
      const r = await analyzeEvidence(s.ctx, attemptId, {});
      expect(r.analysis.quality.ok, r.analysis.quality.issues.join("; ")).toBe(true);
      expect(readEvidence(s.ctx, attemptId).transcript.text).toBe("hola mundo");
      expect(r.analysis.metrics.duration_s?.value ?? 1.5).toBeCloseTo(1.5, 1);
    } finally {
      await s.close();
    }
  }, 30000);

  it("changes nothing when no helper is installed", async () => {
    const s = await connect();
    try {
      const caps = await s.ctx.capabilities(true);
      s.ctx.capabilities = async () => ({ ...caps, external: [] });
      const { sk } = await enroll(s.ctx);
      const cap = await s.call("request_capture", { sk, engine: "speech", spec: "say-it", prompt: "Say hola mundo" });
      const attemptId = cap.data.data.attemptId as string;
      putMedia(s.ctx, attemptId, "media.wav", toneWav());
      const r = await analyzeEvidence(s.ctx, attemptId, { transcript: { text: "hola mundo", words: [{ word: "hola", start: 0, end: 0.4, confidence: 0.9 }, { word: "mundo", start: 0.5, end: 0.9, confidence: 0.9 }] } });
      expect(r.analysis.metrics.intelligibility?.value).toBe(1);
      expect(r.analysis.quality.issues.join(" ")).not.toMatch(/whisper|ffmpeg/);
      const g = await s.call("request_capture", { sk, engine: "game", spec: "game-check", prompt: "Play" });
      const gr = await analyzeEvidence(s.ctx, g.data.data.attemptId, { moves: ["e4"], puzzleAnswers: [] });
      expect(gr.analysis.precision).toBe("reduced");
      expect(gr.analysis.quality.issues.join(" ")).not.toMatch(/local chess engine/);
    } finally {
      await s.close();
    }
  }, 30000);

  it("names the studio's transcriber when whisper-cli has no model file", async () => {
    tool("whisper-cli", FAKE_WHISPER);
    const s = await connect();
    try {
      const caps = await s.ctx.capabilities(true);
      expect(caps.external.some((e) => e.name === "whisper-cli")).toBe(true);
      const speech = caps.engines.find((e) => e.id === "speech")!;
      expect(speech.details?.transcription).toBe("Transformers.js in the studio");
      expect(speech.available).toBe(true);
      // no studio build in tests: capture says so, analysis still works
      for (const e of caps.engines) expect(e.details?.capture).toMatch(/studio not built/);
    } finally {
      await s.close();
    }
  }, 30000);
});

describe("WAV decoding", () => {
  it("reads 16-bit PCM and mixes stereo to mono", () => {
    const mono = decodeWav(toneWav(0.1, 8000))!;
    expect(mono.sampleRate).toBe(8000);
    expect(mono.samples.length).toBe(800);
    expect(Math.max(...mono.samples)).toBeCloseTo(0.3, 2);
    const b = Buffer.alloc(44 + 8);
    b.write("RIFF", 0, "ascii");
    b.writeUInt32LE(44, 4);
    b.write("WAVEfmt ", 8, "ascii");
    b.writeUInt32LE(16, 16);
    b.writeUInt16LE(1, 20);
    b.writeUInt16LE(2, 22);
    b.writeUInt32LE(8000, 24);
    b.writeUInt32LE(32000, 28);
    b.writeUInt16LE(4, 32);
    b.writeUInt16LE(16, 34);
    b.write("data", 36, "ascii");
    b.writeUInt32LE(8, 40);
    b.writeInt16LE(16384, 44);
    b.writeInt16LE(0, 46);
    b.writeInt16LE(-16384, 48);
    b.writeInt16LE(-16384, 50);
    const st = decodeWav(b)!;
    expect(Array.from(st.samples)).toEqual([0.25, -0.5]);
    expect(decodeWav(Buffer.from("not a wav file"))).toBeUndefined();
  });
});

describe("fallback widget", () => {
  it("speaks the MCP Apps protocol version and method names of the installed ext-apps", () => {
    expect(MCP_APPS.protocolVersion).toBe(extApps.LATEST_PROTOCOL_VERSION);
    expect(MCP_APPS.initialize).toBe(extApps.INITIALIZE_METHOD);
    expect(MCP_APPS.initialized).toBe(extApps.INITIALIZED_METHOD);
    expect(MCP_APPS.toolResult).toBe(extApps.TOOL_RESULT_METHOD);
  });

  it("loads nothing from the network", async () => {
    const s = await connect();
    try {
      const r = await s.client.readResource({ uri: "ui://las/view.html" });
      const html = (r.contents[0] as any).text as string;
      expect(html).not.toMatch(/<script[^>]*\bsrc=/i);
      expect(html).not.toMatch(/import[^;]*["'`]https?:\/\//);
      expect(html).not.toMatch(/https?:\/\//);
    } finally {
      await s.close();
    }
  });

  /** Runs the widget script against a fake window and host. */
  function runWidget() {
    const html = fallbackWidgetHtml();
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
    const sent: any[] = [];
    const listeners: ((ev: any) => void)[] = [];
    const timers: (() => void)[] = [];
    const root = { innerHTML: "", textContent: "Loading" };
    const vars: Record<string, string> = {};
    const host = { postMessage: (m: any) => sent.push(JSON.parse(JSON.stringify(m))) };
    const win: any = { parent: host, addEventListener: (t: string, f: any) => t === "message" && listeners.push(f) };
    runInNewContext(script, { window: win, document: { getElementById: () => root, documentElement: { style: { setProperty: (k: string, v: string) => (vars[k] = v) } } }, setTimeout: (f: () => void) => (timers.push(f), timers.length), clearTimeout: (i: number) => (timers[i - 1] = () => {}), JSON, String, Object });
    const fromHost = (data: unknown) => listeners.forEach((f) => f({ source: host, data }));
    return { sent, root, vars, fromHost, fireTimers: () => timers.forEach((f) => f()) };
  }

  it("initializes with the host, then renders the tool result in the theme", () => {
    const w = runWidget();
    expect(w.sent[0]).toMatchObject({ jsonrpc: "2.0", method: "ui/initialize", params: { protocolVersion: MCP_APPS.protocolVersion, appInfo: { name: "las-view" } } });
    w.fromHost({ jsonrpc: "2.0", id: w.sent[0].id, result: { protocolVersion: MCP_APPS.protocolVersion, hostInfo: { name: "h", version: "1" }, hostCapabilities: {}, hostContext: {} } });
    expect(w.sent[1]).toEqual({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
    w.fromHost({ jsonrpc: "2.0", id: 7, method: "ping" });
    expect(w.sent[2]).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
    w.fromHost({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { content: [], structuredContent: { view: "today", title: "Today <b>", studioLink: "/app/today", data: { a: 1 }, theme: { tokens: { color: { bg: "var-bg", accent_2: "a2" }, type: { body: { family: "F", fallback: "sans" }, mono: { family: "M", fallback: "mono" }, scale: [12] }, space: [4], radius: { lg: 8 }, border: { width: 1 } } } } } });
    expect(w.root.innerHTML).toContain("Today &lt;b&gt;");
    expect(w.root.innerHTML).toContain("Open in the studio");
    expect(w.vars["--las-color-bg"]).toBe("var-bg");
    expect(w.vars["--las-color-accent-2"]).toBe("a2");
    expect(w.vars["--las-font-body"]).toBe("F, sans");
    w.fireTimers();
    expect(w.root.textContent).not.toMatch(/Open this in the studio/);
  });

  it(`says to open the studio when no host answers within ${WIDGET_HOST_TIMEOUT_MS} ms`, () => {
    const w = runWidget();
    w.fireTimers();
    expect(w.root.textContent).toBe("Open this in the studio.");
  });
});
