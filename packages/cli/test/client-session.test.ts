import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clientSession, listClientSessions, pruneClientSessions, writeClientSession } from "../src/client-session.js";
import { ancestry, isAlive, isWrapper } from "../src/procs.js";

let root: string;
const hookJson = { session_id: "4f1c-session", transcript_path: "/home/me/.claude/projects/p/4f1c-session.jsonl", cwd: "/home/me/work", hook_event_name: "SessionStart", source: "startup" };
const NOW = new Date(Date.UTC(2026, 9, 13, 12, 0, 0));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "las-client-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("client-session (SessionStart hook)", () => {
  it("writes <LAS_HOME>/clients/claude-code/<pid>.json from the hook JSON, with the pid from $PPID", async () => {
    const chain = [
      { pid: 300, name: "sh" },
      { pid: 200, name: "claude" },
      { pid: 100, name: "bash" }
    ];
    const errs: string[] = [];
    expect(await clientSession(["--client", "claude-code", "--pid", "200"], { lasHome: root, stdin: JSON.stringify(hookJson), chain, now: NOW, err: (l) => errs.push(l) })).toBe(0);
    const file = join(root, "clients", "claude-code", "200.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      sessionId: "4f1c-session",
      client: "claude-code",
      pid: 200,
      cwd: "/home/me/work",
      at: NOW.toISOString(),
      ppid: 300,
      ancestors: [300, 200], // never the terminal's shell above the client
      source: "startup",
      transcriptPath: "/home/me/.claude/projects/p/4f1c-session.jsonl"
    });
    expect(errs).toEqual([]);
    expect(listClientSessions(root).map((s) => [s.client, s.record.sessionId])).toEqual([["claude-code", "4f1c-session"]]);
  });

  it("without --pid (Windows) takes the first ancestor that isn't a shell or package runner", () => {
    const chain = [
      { pid: 31, name: "sh" },
      { pid: 32, name: "npm exec las-ag" },
      { pid: 33, name: "pwsh.exe" },
      { pid: 34, name: "claude.exe" },
      { pid: 35, name: "explorer.exe" }
    ];
    const r = writeClientSession({ lasHome: root, client: "claude-code", hook: hookJson, chain, now: NOW })!;
    expect(r.record.pid).toBe(34);
    expect(r.record.ancestors).toEqual([31, 32, 33, 34]);
    // a $PPID that isn't a real pid (Git Bash gives 1) is ignored
    expect(writeClientSession({ lasHome: root, client: "claude-code", hook: hookJson, pid: 1, chain, now: NOW })!.record.pid).toBe(34);
  });

  it("writes nothing and still exits 0 for empty, broken or id-less input, or an unsafe client id", async () => {
    const errs: string[] = [];
    const deps = { lasHome: root, chain: [{ pid: 5, name: "claude" }], now: NOW, err: (l: string) => errs.push(l) };
    expect(await clientSession([], { ...deps, stdin: "" })).toBe(0);
    expect(await clientSession([], { ...deps, stdin: "{not json" })).toBe(0);
    expect(await clientSession([], { ...deps, stdin: JSON.stringify({ cwd: "/x" }) })).toBe(0);
    expect(await clientSession(["--client", "../evil"], { ...deps, stdin: JSON.stringify(hookJson) })).toBe(0);
    expect(existsSync(join(root, "clients"))).toBe(false);
    expect(errs.length).toBe(3); // diagnostics go to stderr only
  });

  it("prunes files older than a day", () => {
    const dir = join(root, "clients", "claude-code");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "111.json"), "{}");
    writeFileSync(join(dir, "222.json"), "{}");
    const old = new Date(NOW.getTime() - 25 * 3600 * 1000);
    utimesSync(join(dir, "111.json"), old, old);
    writeClientSession({ lasHome: root, client: "claude-code", hook: hookJson, pid: 333, chain: [], now: NOW });
    expect(readdirSync(dir).sort()).toEqual(["222.json", "333.json"]);
    expect(pruneClientSessions(dir, new Date(NOW.getTime() + 2 * 86400_000))).toBeGreaterThanOrEqual(1);
  });

  it("end to end through the bin: reads stdin, prints nothing on stdout, honours LAS_HOME", () => {
    const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "las-agents.js");
    const r = spawnSync(process.execPath, [bin, "client-session", "--client", "claude-code", "--pid", String(process.pid)], {
      input: JSON.stringify(hookJson),
      env: { ...process.env, LAS_HOME: root },
      encoding: "utf8",
      timeout: 30000
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    const rec = JSON.parse(readFileSync(join(root, "clients", "claude-code", `${process.pid}.json`), "utf8"));
    expect(rec.sessionId).toBe("4f1c-session");
    expect(rec.pid).toBe(process.pid);
  });
});

describe("process helpers", () => {
  it("isAlive tells a running pid from an exited one", () => {
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(spawnSync(process.execPath, ["-e", ""]).pid!)).toBe(false);
    expect(isAlive(undefined)).toBe(false);
  });
  it("ancestry starts at the given pid and walks up", () => {
    const chain = ancestry(process.pid, 3);
    expect(chain[0].pid).toBe(process.pid);
    if (process.platform !== "win32") expect(chain[1]?.pid).toBe(process.ppid);
  });
  it("knows the wrappers between a client and its hook", () => {
    for (const n of ["sh", "bash", "npm exec las-ag", "npx", "cmd.exe", "pwsh.exe", "powershell.exe"]) expect(isWrapper(n), n).toBe(true);
    for (const n of ["claude", "claude.exe", "node", "codex"]) expect(isWrapper(n), n).toBe(false);
  });
});
