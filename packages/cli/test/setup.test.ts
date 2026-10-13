import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeEnv, type Env } from "../src/env.js";
import { packageEntry, type InstallInfo } from "../src/install.js";
import { runSetup, type Io, type SetupOptions } from "../src/setup.js";
import { run } from "../src/index.js";

let root: string;
let skillSrc: string;
const p = (...parts: string[]) => join(root, ...parts);
const put = (rel: string, text: string) => {
  mkdirSync(dirname(p(rel)), { recursive: true });
  writeFileSync(p(rel), text);
};
const read = (rel: string) => readFileSync(p(rel), "utf8");
const backups = (dir: string, prefix: string) => (existsSync(p(dir)) ? readdirSync(p(dir)).filter((f) => f.startsWith(prefix)) : []);

const env = (over: Partial<Env> = {}): Env => makeEnv({ home: root, configHome: p(".config"), appData: p("AppData"), lasHome: p(".las"), cwd: p("work"), codexHome: p(".codex"), hasCommand: () => false, platform: "linux", ...over });
const install = (): InstallInfo => ({ mode: "package", entry: packageEntry("linux"), skillSource: skillSrc });

function fakeIo(answers: string[] = [], ran: [string, string[]][] = [], runStatus = 0) {
  const lines: string[] = [];
  const asked: string[] = [];
  let tick = 0;
  const io: Io = {
    out: (l) => lines.push(l),
    err: (l) => lines.push(`ERR ${l}`),
    ask: async (q) => {
      asked.push(q);
      return answers.shift() ?? "";
    },
    run: (c, a) => {
      ran.push([c, a]);
      return { status: runStatus, output: "" };
    },
    now: () => new Date(Date.UTC(2026, 9, 13, 12, 0, tick++))
  };
  return { io, lines, asked, text: () => lines.join("\n") };
}
const opts = (o: Partial<SetupOptions> = {}): SetupOptions => ({ yes: false, dryRun: false, clients: [], noSkill: false, noCli: false, ...o });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "las-setup-"));
  mkdirSync(p("work"));
  skillSrc = p("src-skill");
  mkdirSync(join(skillSrc, "reference"), { recursive: true });
  writeFileSync(join(skillSrc, "SKILL.md"), "---\nname: learn-any-skill\n---\nv1\n");
  writeFileSync(join(skillSrc, "reference", "theme.md"), "theme\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** a fake HOME with one sample config per client */
function populate() {
  put(".claude.json", JSON.stringify({ numStartups: 3, mcpServers: { other: { command: "x" } } }, null, 2));
  put(".config/Claude/claude_desktop_config.json", "{}");
  put(".codex/config.toml", 'model = "o3"\n');
  put(".cursor/mcp.json", '{"mcpServers":{}}');
  put(".config/goose/config.yaml", "extensions:\n  developer:\n    type: builtin\n");
  put(".config/opencode/opencode.json", "{}");
  put(".continue/config.yaml", "name: c\nversion: 1\nschema: v1\n");
  put(".config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json", '{"mcpServers":{}}');
}
const ALL = [".claude.json", ".config/Claude/claude_desktop_config.json", ".codex/config.toml", ".cursor/mcp.json", ".config/goose/config.yaml", ".config/opencode/opencode.json", ".continue/config.yaml", ".config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json"];

describe("setup", () => {
  it("dry run shows every diff and writes nothing", async () => {
    populate();
    const before = ALL.map(read);
    const f = fakeIo();
    const r = await runSetup(opts({ dryRun: true }), env(), install(), f.io);
    expect(r.exitCode).toBe(0);
    expect(r.results.map((x) => x.server)).toEqual(Array(8).fill("dry-run"));
    expect(ALL.map(read)).toEqual(before);
    expect(f.asked).toEqual([]);
    expect(f.text()).toContain("+++ ");
    expect(f.text()).toContain("[mcp_servers.las]");
    expect(f.text()).toContain("Re-run without --dry-run");
    expect(existsSync(p(".claude/skills"))).toBe(false);
    expect(readdirSync(p(".config/goose"))).toEqual(["config.yaml"]);
  });

  it("--yes configures every client, backs up each existing file first, and installs skills where they exist", async () => {
    populate();
    const original = Object.fromEntries(ALL.map((f) => [f, read(f)]));
    const f = fakeIo();
    const r = await runSetup(opts({ yes: true }), env(), install(), f.io);
    expect(r.exitCode).toBe(0);
    expect(r.results.map((x) => x.server)).toEqual(Array(8).fill("applied"));
    expect(f.asked).toEqual([]);

    for (const file of ALL) {
      const dir = dirname(file);
      const bs = backups(dir, `${file.split("/").pop()}.las-backup-`);
      expect(bs, file).toHaveLength(1);
      expect(readFileSync(p(dir, bs[0]), "utf8")).toBe(original[file]);
      expect(read(file)).toContain("las-agents");
    }
    expect(JSON.parse(read(".claude.json")).mcpServers.other).toEqual({ command: "x" });
    expect(JSON.parse(read(".claude.json")).numStartups).toBe(3);
    expect(read(".codex/config.toml")).toContain('args = ["-y", "las-agents", "serve"]');
    expect(read(".config/goose/config.yaml")).toContain("  las:\n    name: las");
    expect(read(".continue/config.yaml")).toContain("  - name: las");
    expect(JSON.parse(read(".config/opencode/opencode.json")).mcp.las.type).toBe("local");

    for (const dir of [".claude/skills", ".codex/skills", ".cursor/skills"]) {
      expect(read(`${dir}/learn-any-skill/SKILL.md`)).toContain("v1");
      expect(read(`${dir}/learn-any-skill/reference/theme.md`)).toBe("theme\n");
    }
    const manual = r.results.filter((x) => x.skill === "manual").map((x) => x.id);
    expect(manual).toEqual(["claude-desktop", "goose", "opencode", "continue", "cline"]);
    expect(f.text()).toContain("I want to learn");
    expect(f.text()).toContain(skillSrc);
  });

  it("running setup twice changes nothing the second time (no duplicates, no new backups)", async () => {
    populate();
    await runSetup(opts({ yes: true }), env(), install(), fakeIo().io);
    const after1 = ALL.map(read);
    const files1 = ALL.map((f) => backups(dirname(f), "").length);
    const f = fakeIo();
    const r = await runSetup(opts({ yes: true }), env(), install(), f.io);
    expect(r.results.every((x) => x.server === "unchanged")).toBe(true);
    expect(r.results.filter((x) => x.id !== "claude-desktop" && ["claude-code", "codex", "cursor"].includes(x.id)).every((x) => x.skill === "unchanged")).toBe(true);
    expect(ALL.map(read)).toEqual(after1);
    expect(ALL.map((f) => backups(dirname(f), "").length)).toEqual(files1);
    for (const file of ALL) expect((read(file).match(/name: las|"las"|mcp_servers\.las\]/g) ?? []).length, file).toBeLessThanOrEqual(1);
    expect(existsSync(p(".las", "backups"))).toBe(false); // fresh skill installs need no backup
  });

  it("asks per client and writes only what is approved", async () => {
    put(".cursor/mcp.json", "{}");
    put(".codex/config.toml", "");
    const f = fakeIo(["y", "n", "n", "yes"]);
    const r = await runSetup(opts(), env(), install(), f.io);
    // order: codex server, codex skill, cursor server, cursor skill
    expect(r.results.map((x) => [x.id, x.server, x.skill])).toEqual([
      ["codex", "applied", "declined"],
      ["cursor", "declined", "applied"]
    ]);
    expect(f.asked).toHaveLength(4);
    expect(read(".codex/config.toml")).toContain("mcp_servers.las");
    expect(read(".cursor/mcp.json")).toBe("{}");
    expect(existsSync(p(".codex/skills"))).toBe(false);
    expect(existsSync(p(".cursor/skills/learn-any-skill/SKILL.md"))).toBe(true);
  });

  it("an empty answer (closed input) means no", async () => {
    put(".cursor/mcp.json", "{}");
    const r = await runSetup(opts({ noSkill: true }), env(), install(), fakeIo().io);
    expect(r.results[0].server).toBe("declined");
    expect(read(".cursor/mcp.json")).toBe("{}");
  });

  it("--client filters, accepts aliases and commas, and configures a client that wasn't detected", async () => {
    put(".cursor/mcp.json", "{}");
    const r = await runSetup(opts({ yes: true, noSkill: true, clients: ["codex,claude"] }), env(), install(), fakeIo().io);
    expect(r.results.map((x) => x.id)).toEqual(["codex", "claude-code"]);
    expect(read(".codex/config.toml")).toContain("mcp_servers.las");
    expect(JSON.parse(read(".claude.json")).mcpServers.las.command).toBe("npx");
    expect(read(".cursor/mcp.json")).toBe("{}");
    expect(backups(".codex", "config.toml.las-backup")).toEqual([]); // nothing existed to back up
  });

  it("rejects an unknown --client", async () => {
    const f = fakeIo();
    const r = await runSetup(opts({ clients: ["vim"] }), env(), install(), f.io);
    expect(r.exitCode).toBe(2);
    expect(f.text()).toContain("Unknown client: vim");
  });

  it("says so when no agent is installed", async () => {
    const f = fakeIo();
    const r = await runSetup(opts({ yes: true }), env(), install(), f.io);
    expect(r).toEqual({ results: [], exitCode: 0 });
    expect(f.text()).toContain("No supported agent found");
  });

  it("leaves a config it can't parse alone and fails clearly", async () => {
    put(".cursor/mcp.json", "{ // jsonc\n}");
    const f = fakeIo();
    const r = await runSetup(opts({ yes: true }), env(), install(), f.io);
    expect(r.exitCode).toBe(1);
    expect(r.results[0].server).toBe("failed");
    expect(read(".cursor/mcp.json")).toBe("{ // jsonc\n}");
    expect(f.text()).toContain("Add this server by hand");
  });

  it("updates a changed skill: shows the diff, backs the old folder up outside the skills folder", async () => {
    put(".claude/skills/learn-any-skill/SKILL.md", "---\nname: learn-any-skill\n---\nold\n");
    put(".claude/skills/learn-any-skill/extra.md", "mine\n");
    const f = fakeIo();
    const r = await runSetup(opts({ yes: true, clients: ["claude-code"] }), env(), install(), f.io);
    expect(r.results[0].skill).toBe("applied");
    expect(f.text()).toContain("-old");
    expect(f.text()).toContain("+v1");
    expect(read(".claude/skills/learn-any-skill/SKILL.md")).toContain("v1");
    expect(read(".claude/skills/learn-any-skill/extra.md")).toBe("mine\n");
    const b = r.results[0].backups.find((x) => x.includes("backups"))!;
    expect(b.startsWith(p(".las", "backups"))).toBe(true);
    expect(readFileSync(join(b, "SKILL.md"), "utf8")).toContain("old");
    expect(readdirSync(p(".claude/skills"))).toEqual(["learn-any-skill"]);
  });

  it("--no-skill skips skills", async () => {
    put(".codex/config.toml", "");
    await runSetup(opts({ yes: true, noSkill: true }), env(), install(), fakeIo().io);
    expect(existsSync(p(".codex/skills"))).toBe(false);
  });

  it("Claude Code: prefers the claude CLI when it is on PATH, backing up ~/.claude.json first", async () => {
    put(".claude.json", '{"mcpServers":{}}');
    const ran: [string, string[]][] = [];
    const f = fakeIo([], ran);
    const r = await runSetup(opts({ yes: true, noSkill: true, clients: ["claude-code"] }), env({ hasCommand: (n) => n === "claude" }), install(), f.io);
    expect(r.results[0].server).toBe("applied");
    expect(ran).toEqual([["claude", ["mcp", "add", "--scope", "user", "las", "--", "npx", "-y", "las-agents", "serve"]]]);
    expect(f.text()).toContain("claude mcp add --scope user las -- npx -y las-agents serve");
    expect(backups("", ".claude.json.las-backup-")).toHaveLength(1);
    expect(read(".claude.json")).toBe('{"mcpServers":{}}'); // the CLI does the writing
  });

  it("Claude Code: removes a stale entry before adding, and falls back to the file if the CLI fails", async () => {
    put(".claude.json", JSON.stringify({ mcpServers: { las: { command: "old" } } }));
    const ran: [string, string[]][] = [];
    const f = fakeIo([], ran, 1);
    const r = await runSetup(opts({ yes: true, noSkill: true, clients: ["claude-code"] }), env({ hasCommand: (n) => n === "claude" }), install(), f.io);
    expect(ran.map(([, a]) => a[1])).toEqual(["remove", "add"]);
    expect(r.results[0].server).toBe("applied");
    expect(JSON.parse(read(".claude.json")).mcpServers.las.command).toBe("npx");
    expect(f.text()).toContain("editing the file directly");
  });

  it("--no-cli edits ~/.claude.json directly", async () => {
    put(".claude.json", "{}");
    const ran: [string, string[]][] = [];
    await runSetup(opts({ yes: true, noSkill: true, noCli: true, clients: ["claude-code"] }), env({ hasCommand: () => true }), install(), fakeIo([], ran).io);
    expect(ran).toEqual([]);
    expect(JSON.parse(read(".claude.json")).mcpServers.las.type).toBe("stdio");
  });

  it("backup names carry the timestamp", async () => {
    put(".cursor/mcp.json", "{}");
    await runSetup(opts({ yes: true, noSkill: true }), env(), install(), fakeIo().io);
    expect(backups(".cursor", "mcp.json.las-backup-")).toEqual(["mcp.json.las-backup-20261013-120000"]);
  });
});

describe("cli entry", () => {
  it("setup parses flags through run()", async () => {
    put(".cursor/mcp.json", "{}");
    const f = fakeIo();
    const code = await run(["setup", "--dry-run", "--client", "cursor", "--no-skill"], { io: f.io, env: env(), install: install() });
    expect(code).toBe(0);
    expect(read(".cursor/mcp.json")).toBe("{}");
    expect(f.text()).toContain("Dry run");
  });
  it("rejects unknown commands and options with exit code 2", async () => {
    expect(await run(["frobnicate"], { io: fakeIo().io })).toBe(2);
    expect(await run(["setup", "--bogus"], { io: fakeIo().io, env: env(), install: install() })).toBe(2);
  });
  it("model validate reads JSON only and prints errors", async () => {
    put("m.yaml", "a: 1");
    const y = fakeIo();
    expect(await run(["model", "validate", p("m.yaml")], { io: y.io })).toBe(2);
    expect(y.text()).toContain("JSON only");
    put("bad.json", '{"nope":true}');
    const b = fakeIo();
    expect(await run(["model", "validate", p("bad.json")], { io: b.io })).toBe(1);
    expect(b.lines.some((l) => l.startsWith("ERR error"))).toBe(true);
    put("broken.json", "{");
    expect(await run(["model", "validate", p("broken.json")], { io: fakeIo().io })).toBe(2);
  });
});
