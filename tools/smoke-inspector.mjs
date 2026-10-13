#!/usr/bin/env node
/**
 * Smoke test: starts the LAS MCP server over stdio and drives it with the MCP Inspector CLI
 * (`npx @modelcontextprotocol/inspector --cli`): tools/list, resources/list, prompts/list and a tools/call of
 * get_capabilities. The server is described in a throwaway --config file (the Inspector CLI swallows server flags
 * such as --no-studio when they are passed on the command line). If the Inspector can't be used (offline, npx
 * missing, or --builtin / LAS_SMOKE_BUILTIN=1), a minimal stdio JSON-RPC client below does the same checks.
 * Exits non-zero on any failure.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(root, "packages/server/src/bin.ts");
const tmp = mkdtempSync(join(tmpdir(), "las-smoke-"));
const EXPECT = { tools: ["get_capabilities", "draft_skill_model", "validate_skill_model", "get_theme"], prompts: ["las-session"], resources: ["learner-profile"] };
// tsx is installed under packages/server, not the root, so resolve its loader from there
const tsx = pathToFileURL(createRequire(join(root, "packages/server/package.json")).resolve("tsx")).href;
const server = { command: process.execPath, args: ["--import", tsx, bin, "--no-studio"], env: { LAS_HOME: join(tmp, "home"), LAS_DB: join(tmp, "las.db") } };
const failures = [];
const check = (ok, what) => (ok ? console.log(`ok    ${what}`) : (failures.push(what), console.error(`FAIL  ${what}`)));
const names = (list, key) => (list?.[key] ?? []).map((x) => x.name ?? x.uri);
const hasAll = (got, want, what) => check(want.every((w) => got.includes(w)), `${what}: ${want.join(", ")}${want.every((w) => got.includes(w)) ? "" : ` (got ${got.join(", ") || "none"})`}`);

function inspector(args) {
  const config = join(tmp, "mcp.json");
  writeFileSync(config, JSON.stringify({ mcpServers: { las: server } }));
  const r = spawnSync("npx", ["--yes", "@modelcontextprotocol/inspector", "--cli", "--config", config, "--server", "las", ...args], { cwd: root, encoding: "utf8", timeout: 120_000, shell: process.platform === "win32" });
  if (r.status !== 0) throw new Error(`inspector ${args.join(" ")} exited ${r.status}: ${(r.stdout + r.stderr).trim().split("\n").slice(-3).join(" | ")}`);
  const out = r.stdout.slice(r.stdout.indexOf("{"));
  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`inspector ${args.join(" ")} printed no JSON: ${r.stdout.slice(0, 200)}`);
  }
}

// Fallback: a minimal newline-delimited JSON-RPC client over the server's stdio.
async function builtin() {
  const child = spawn(server.command, server.args, { cwd: root, env: { ...process.env, ...server.env }, stdio: ["pipe", "pipe", "inherit"] });
  const pending = new Map();
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    for (let i; (i = buf.indexOf("\n")) >= 0; ) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        const m = JSON.parse(line);
        pending.get(m.id)?.(m);
      } catch {
        /* not a JSON-RPC line */
      }
    }
  });
  let id = 0;
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      const t = setTimeout(() => reject(new Error(`${method} timed out`)), 30_000);
      pending.set(n, (m) => (clearTimeout(t), m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
    });
  try {
    await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "las-smoke", version: "0" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    return { "tools/list": await call("tools/list"), "resources/list": await call("resources/list"), "prompts/list": await call("prompts/list"), caps: await call("tools/call", { name: "get_capabilities", arguments: {} }) };
  } finally {
    child.kill();
  }
}

async function run() {
  mkdirSync(join(tmp, "home"), { recursive: true });
  let r;
  let via = "MCP Inspector CLI";
  if (process.argv.includes("--builtin") || process.env.LAS_SMOKE_BUILTIN) via = "built-in stdio client";
  else {
    try {
      r = { "tools/list": inspector(["--method", "tools/list"]), "resources/list": inspector(["--method", "resources/list"]), "prompts/list": inspector(["--method", "prompts/list"]), caps: inspector(["--method", "tools/call", "--tool-name", "get_capabilities"]) };
    } catch (e) {
      console.warn(`MCP Inspector unavailable (${e.message}); using the built-in stdio client`);
      via = "built-in stdio client";
    }
  }
  r ??= await builtin();
  console.log(`Driving the server with the ${via}`);
  hasAll(names(r["tools/list"], "tools"), EXPECT.tools, "tools/list");
  hasAll(names(r["resources/list"], "resources"), EXPECT.resources, "resources/list");
  hasAll(names(r["prompts/list"], "prompts"), EXPECT.prompts, "prompts/list");
  const text = (r.caps.content ?? []).map((c) => c.text ?? "").join("");
  check(!r.caps.isError && (r.caps.structuredContent?.engines?.length > 0 || /Engines available/i.test(text)), "tools/call get_capabilities lists the engines");
}

try {
  await run();
} catch (e) {
  failures.push(String(e.message ?? e));
  console.error(`FAIL  ${e.stack ?? e}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
if (failures.length) {
  console.error(`\nSmoke test failed: ${failures.length} problem(s)`);
  process.exit(1);
}
console.log("Smoke test passed");
