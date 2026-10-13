import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Capabilities, EngineStatus, Language } from "@las/schema";
import type { LasContext } from "../context.js";

const exec = promisify(execFile);

async function run(cmd: string, args: string[], timeout = 4000): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout, stderr } = await exec(cmd, args, { timeout, maxBuffer: 1 << 20, env: { ...process.env, LANG: "C" } });
    return { ok: true, out: `${stdout}${stderr}`.trim() };
  } catch (e: any) {
    const out = `${e?.stdout ?? ""}${e?.stderr ?? ""}`.trim();
    // tools that print a version but exit non-zero still count
    if (out && /\d+\.\d+/.test(out) && e?.code !== "ENOENT") return { ok: true, out };
    return { ok: false, out };
  }
}

function firstVersion(s: string): string | undefined {
  return /(\d+\.\d+(?:\.\d+)?)/.exec(s)?.[1];
}

export async function which(cmd: string): Promise<string | undefined> {
  const r = await run(process.platform === "win32" ? "where" : "which", [cmd], 2000);
  return r.ok ? r.out.split("\n")[0].trim() || undefined : undefined;
}

/** Local toolchains LAS knows how to drive, with the command that proves they're installed. */
export const TOOLCHAINS: { language: Language; tool: string; args: string[] }[] = [
  { language: "python", tool: "python3", args: ["--version"] },
  { language: "javascript", tool: "node", args: ["--version"] },
  { language: "typescript", tool: "npx", args: ["--no-install", "tsc", "--version"] },
  { language: "rust", tool: "rustc", args: ["--version"] },
  { language: "go", tool: "go", args: ["version"] },
  { language: "java", tool: "javac", args: ["-version"] },
  { language: "c", tool: "gcc", args: ["--version"] },
  { language: "cpp", tool: "g++", args: ["--version"] },
  { language: "csharp", tool: "dotnet", args: ["--version"] },
  { language: "ruby", tool: "ruby", args: ["--version"] },
  { language: "php", tool: "php", args: ["--version"] },
  { language: "kotlin", tool: "kotlinc", args: ["-version"] },
  { language: "swift", tool: "swift", args: ["--version"] },
  { language: "bash", tool: "bash", args: ["--version"] },
  { language: "lua", tool: "lua", args: ["-v"] },
  { language: "r", tool: "Rscript", args: ["--version"] },
  { language: "haskell", tool: "runghc", args: ["--version"] },
  { language: "elixir", tool: "elixir", args: ["--version"] },
  { language: "scala", tool: "scala-cli", args: ["--version"] },
  { language: "dart", tool: "dart", args: ["--version"] },
  { language: "zig", tool: "zig", args: ["version"] },
  { language: "sql", tool: "sqlite3", args: ["--version"] }
];

/** External tools LAS can call as separate processes over a standard protocol. GPL ones are never bundled. */
export const EXTERNAL_TOOLS: { name: string; protocol: string; license: string; note?: string }[] = [
  { name: "stockfish", protocol: "uci", license: "GPL-3.0", note: "chess engine, optional external tool" },
  { name: "lc0", protocol: "uci", license: "GPL-3.0", note: "chess engine, optional external tool" },
  { name: "katago", protocol: "gtp", license: "MIT", note: "go engine; check each network's license" },
  { name: "gnugo", protocol: "gtp", license: "GPL-3.0", note: "go engine, optional external tool" },
  { name: "ffmpeg", protocol: "cli", license: "LGPL-2.1+/GPL", note: "media conversion, optional external tool" },
  { name: "mkcert", protocol: "cli", license: "BSD-3-Clause", note: "HTTPS certificates for phone pairing" },
  { name: "whisper-cli", protocol: "cli", license: "MIT", note: "whisper.cpp command line" },
  { name: "whisper-cpp", protocol: "cli", license: "MIT", note: "whisper.cpp command line (Homebrew name)" },
  { name: "espeak-ng", protocol: "cli", license: "GPL-3.0", note: "phonemizer, optional external tool" },
  { name: "ollama", protocol: "http", license: "MIT", note: "local models, including open vision models" }
];

/** Browser runtimes: languages the studio runs with no install. Optional runtimes are listed when their package resolves. */
export function browserLanguages(): Language[] {
  const langs: Language[] = ["javascript", "typescript", "python", "sql"];
  const req = createRequire(import.meta.url);
  for (const [pkg, lang] of [
    ["@ruby/3.4-wasm-wasi", "ruby"],
    ["php-wasm", "php"]
  ] as const) {
    try {
      req.resolve(`${pkg}/package.json`);
      langs.push(lang);
    } catch {
      /* optional */
    }
  }
  return langs;
}

function cachedModels(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export async function detectCapabilities(ctx: LasContext): Promise<Capabilities> {
  const models = cachedModels(ctx.config.modelsDir);
  const has = (p: string) => models.some((m) => m.toLowerCase().includes(p));
  const studio = !!(ctx.config.studioDist && existsSync(join(ctx.config.studioDist, "index.html")));

  const [toolchainResults, externalResults, podman, docker, ollamaList] = await Promise.all([
    Promise.all(TOOLCHAINS.map(async (t) => ({ ...t, r: await run(t.tool, t.args) }))),
    Promise.all(EXTERNAL_TOOLS.map(async (t) => ({ ...t, path: await which(t.name) }))),
    run("podman", ["info", "--format", "{{.Version.Version}}"], 6000),
    run("docker", ["version", "--format", "{{.Server.Version}}"], 6000),
    run("ollama", ["list"], 4000)
  ]);

  const consentLocal = ctx.store.getSetting<boolean>("consent.runner.local", false);
  const consentContainer = ctx.store.getSetting<boolean>("consent.runner.container", false);
  const local = toolchainResults.filter((t) => t.r.ok).map((t) => ({ language: t.language, tool: t.tool, version: firstVersion(t.r.out), consented: consentLocal }));
  const containerRuntime = podman.ok ? "podman" : docker.ok ? "docker" : undefined;
  const external = externalResults.filter((t) => t.path).map((t) => ({ name: t.name, protocol: t.protocol, path: t.path!, license: t.license, note: t.note }));
  const whisperCli = external.find((e) => e.name === "whisper-cli" || e.name === "whisper-cpp");
  const ollamaModels = ollamaList.ok ? ollamaList.out.split("\n").slice(1).map((l) => l.split(/\s+/)[0]).filter(Boolean) : [];
  const visionViaOllama = ollamaModels.filter((m) => /llava|moondream|minicpm-v|qwen.*vl|smolvlm|granite.*vision|gemma3|bakllava/i.test(m));

  const engines: EngineStatus[] = [
    { id: "movement", available: true, backend: "wasm", models: [{ id: "pose_landmarker_lite", downloaded: has("pose_landmarker"), license: "Apache-2.0" }, { id: "hand_landmarker", downloaded: has("hand_landmarker"), license: "Apache-2.0" }, { id: "face_landmarker", downloaded: has("face_landmarker"), license: "Apache-2.0" }, { id: "efficientdet_lite0", downloaded: has("efficientdet"), license: "Apache-2.0 code; weights unverified" }], details: { trackers: ["pose", "hands", "face", "objects"], smoothing: "one-euro", reference: "dtw", beat: "onset-autocorrelation", note: "runs in the studio; models download on first use and are cached" } },
    { id: "audio", available: true, backend: "wasm", models: [], details: { pitch: "pitchy (McLeod)", onsets: "spectral flux", tempo: "autocorrelation", references: ["musicxml", "midi", "abc", "recording", "pattern", "notes"], calibration: "tap test" } },
    { id: "speech", available: true, backend: whisperCli ? "native" : "wasm", models: [{ id: whisperCli ? "whisper.cpp (local)" : "onnx-community/whisper-base (Transformers.js)", downloaded: !!whisperCli || has("whisper"), license: "MIT" }], details: { transcription: whisperCli ? "whisper.cpp process" : "Transformers.js in the studio", languages: "any Whisper language", perSound: [], tones: "pitch contour", note: "per-sound scores need a license-clean model per language; none ships in v0.1, so the intelligibility and self-comparison fallback is used" } },
    { id: "code", available: true, backend: "native", models: [], details: { browser: browserLanguages(), local: local.map((l) => l.language), container: !!containerRuntime } },
    { id: "visual", available: true, backend: "wasm", models: [{ id: "tesseract.js eng", downloaded: has("tesseract") || has("eng.traineddata"), license: "Apache-2.0" }], details: { grading: "the agent's vision model grades with the rubric and submits through submit_rubric_grade; a local open vision model stands in when the agent is text-only", measurements: ["tapped_points", "proportion", "symmetry", "exposure", "color_balance", "edge_density", "text"], localVision: visionViaOllama } },
    { id: "knowledge", available: true, backend: "native", models: [], details: { spacing: "ts-fsrs", mastery: "BKT" } },
    { id: "interaction", available: true, backend: "native", models: [], details: { tasks: ["type-text", "shortcuts", "mental-math", "click-targets", "sequence"] } },
    { id: "sensor", available: true, backend: "wasm", models: [], details: { detect: ["cadence", "swing-tempo", "steadiness", "step-count", "impact"], needs: "a phone with motion sensors, paired or opened directly" } },
    { id: "game", available: true, backend: "native", models: [], details: { rules: ["chess (chess.js)"], engines: external.filter((e) => e.protocol === "uci" || e.protocol === "gtp").map((e) => e.name), fallback: "tactics quizzes from the game spec" } },
    { id: "self-report", available: true, backend: "native", models: [] }
  ];

  const localModels = [
    ...visionViaOllama.map((m) => ({ id: `ollama:${m}`, kind: "vision" as const, available: true, license: "check the model's license" })),
    { id: "onnx-community/whisper-base", kind: "stt" as const, available: has("whisper"), license: "MIT" },
    { id: "kokoro-82m", kind: "tts" as const, available: has("kokoro"), license: "Apache-2.0" }
  ];

  return {
    version: ctx.config.version,
    platform: { os: process.platform, arch: process.arch, node: process.version },
    engines,
    runners: { browser: browserLanguages(), local, container: { available: !!containerRuntime, runtime: containerRuntime, consented: consentContainer } },
    devices: { camera: ctx.devices.camera, microphone: ctx.devices.microphone, motion: ctx.devices.motion, phone: ctx.devices.phone, studio },
    external,
    localModels,
    widgets: ctx.widgetsSupported,
    studioUrl: ctx.config.studioUrl
  };
}
