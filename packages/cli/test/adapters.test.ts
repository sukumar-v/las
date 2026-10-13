import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COACH_ADAPTERS, findAdapter, parseClaudeJson, wakeSummary } from "../src/adapters.js";
import { CLIENTS } from "../src/clients.js";
import { resolveCommand } from "../src/coach.js";

describe("coach adapters", () => {
  it("has exactly one row per client in clients.ts", () => {
    expect(COACH_ADAPTERS.map((a) => a.id).sort()).toEqual(CLIENTS.map((c) => c.id).sort());
    expect(new Set(COACH_ADAPTERS.map((a) => a.id)).size).toBe(COACH_ADAPTERS.length);
    for (const a of COACH_ADAPTERS) {
      expect(a.notifyText, a.id).toMatch(/coach is waiting/);
      if (!a.verified) expect(a.open, a.id).toMatch(/⚠/);
    }
  });

  it("Claude Code resumes headlessly with LAS tools only, JSON output, and the summary on stdin", () => {
    const cmd = findAdapter("claude-code")!.resume!("sess-1", "SUMMARY TEXT");
    expect(cmd).toEqual({ command: "claude", args: ["-p", "--resume", "sess-1", "--allowedTools", "mcp__las__*", "--output-format", "json"], stdin: "SUMMARY TEXT" });
    // --allowedTools is variadic: its value must be followed by a flag, never a positional
    const i = cmd.args.indexOf("--allowedTools");
    expect(cmd.args[i + 2]?.startsWith("--")).toBe(true);
  });

  it("notify-only clients have no resume", () => {
    for (const id of ["claude-desktop", "cursor", "continue", "cline"]) expect(findAdapter(id)!.resume, id).toBeUndefined();
    expect(findAdapter(undefined)).toBeUndefined();
  });

  it("reads session_id from Claude Code's JSON result, tolerating noise", () => {
    expect(parseClaudeJson('{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"abc"}')).toEqual({ sessionId: "abc", isError: false });
    expect(parseClaudeJson('Warning: something\n{"type":"result","session_id":"def","is_error":true}\n')).toEqual({ sessionId: "def", isError: true });
    expect(parseClaudeJson("not json")).toEqual({});
  });

  it("the summary names the skill, the session and the event types, and says to call coach_wait", () => {
    const s = wakeSummary({ skill: "juggling", sk: "sk_1", liveSessionId: "ses_1", eventTypes: ["card.answered", "card.answered", "learner.asked"] });
    expect(s).toContain('"juggling"');
    expect(s).toContain("sk_1");
    expect(s).toContain("ses_1");
    expect(s).toContain("card.answered x2, learner.asked");
    expect(s).toContain("coach_wait");
    expect(s).toContain("LAS tools only");
  });

  it("on Windows runs an npm .cmd shim through cmd.exe and an .exe directly", () => {
    const dir = mkdtempSync(join(tmpdir(), "las-path-"));
    try {
      mkdirSync(join(dir, "a"));
      mkdirSync(join(dir, "b"));
      writeFileSync(join(dir, "a", "claude.cmd"), "");
      writeFileSync(join(dir, "b", "codex.exe"), "");
      const pathVar = [join(dir, "a"), join(dir, "b")].join(";");
      const c = resolveCommand({ command: "claude", args: ["-p"] }, "win32", pathVar);
      expect(c.args.slice(0, 3)).toEqual(["/d", "/c", join(dir, "a", "claude.cmd")]);
      expect(c.args.at(-1)).toBe("-p");
      expect(resolveCommand({ command: "codex", args: [] }, "win32", pathVar)).toEqual({ command: join(dir, "b", "codex.exe"), args: [] });
      expect(resolveCommand({ command: "claude", args: ["-p"] }, "linux", pathVar)).toEqual({ command: "claude", args: ["-p"] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
