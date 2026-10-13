import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLIENTS, detectClients, findClient, resolveTarget } from "../src/clients.js";
import { makeEnv, type Env } from "../src/env.js";

let root: string;
const put = (rel: string, text = "") => {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
  return p;
};
const env = (over: Partial<Env> = {}) => makeEnv({ home: root, appData: join(root, "AppData", "Roaming"), configHome: join(root, ".config"), lasHome: join(root, ".las"), cwd: join(root, "work"), codexHome: join(root, ".codex"), hasCommand: () => false, platform: "linux", ...over });
const ids = (e: Env) => detectClients(e).map((d) => d.def.id);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "las-cli-"));
  mkdirSync(join(root, "work"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("detection", () => {
  it("finds nothing on a bare home", () => {
    expect(ids(env())).toEqual([]);
  });

  it("detects every client from its config files (linux)", () => {
    put(".claude.json", "{}");
    put(".config/Claude/claude_desktop_config.json", "{}");
    put(".codex/config.toml", "");
    put(".cursor/mcp.json", "{}");
    put(".config/goose/config.yaml", "");
    put(".config/opencode/opencode.json", "{}");
    put(".continue/config.yaml", "");
    put(".config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json", "{}");
    expect(ids(env())).toEqual(CLIENTS.map((c) => c.id));
    expect(CLIENTS.map((c) => c.id)).toEqual(["claude-code", "claude-desktop", "codex", "cursor", "goose", "opencode", "continue", "cline"]);
  });

  it("points each client at its config file", () => {
    for (const rel of [".claude.json", ".config/Claude/claude_desktop_config.json", ".codex/config.toml", ".cursor/mcp.json", ".config/goose/config.yaml", ".config/opencode/opencode.json", ".continue/config.yaml"]) put(rel, "x");
    put(".config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json", "{}");
    const got = Object.fromEntries(detectClients(env()).map((d) => [d.def.id, [d.target.path.slice(root.length + 1), d.target.format]]));
    expect(got).toEqual({
      "claude-code": [".claude.json", "json-claude-code"],
      "claude-desktop": [".config/Claude/claude_desktop_config.json", "json-mcp-servers"],
      codex: [".codex/config.toml", "toml-codex"],
      cursor: [".cursor/mcp.json", "json-mcp-servers"],
      goose: [".config/goose/config.yaml", "yaml-goose"],
      opencode: [".config/opencode/opencode.json", "json-opencode"],
      continue: [".continue/config.yaml", "yaml-continue"],
      cline: [".config/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json", "json-cline"]
    });
  });

  it("detects a client by its folder alone and plans to create the file", () => {
    mkdirSync(join(root, ".cursor"));
    mkdirSync(join(root, ".config/goose"), { recursive: true });
    const d = detectClients(env());
    expect(d.map((x) => x.def.id)).toEqual(["cursor", "goose"]);
    expect(d.every((x) => !x.configExists)).toBe(true);
  });

  it("detects by an executable on PATH, and marks Claude Code as CLI-capable", () => {
    const e = env({ hasCommand: (n) => n === "claude" || n === "codex" });
    const d = detectClients(e);
    expect(d.map((x) => x.def.id)).toEqual(["claude-code", "codex"]);
    expect(d[0].viaCli).toBe(true);
    expect(d[1].viaCli).toBe(false);
  });

  it("honors the platform's folders (macOS and Windows)", () => {
    put("Library/Application Support/Claude/claude_desktop_config.json", "{}");
    put("Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json", "{}");
    expect(ids(env({ platform: "darwin" }))).toEqual(["claude-desktop", "cline"]);
    put("AppData/Roaming/Claude/claude_desktop_config.json", "{}");
    put("AppData/Roaming/Block/goose/config/config.yaml", "");
    put("AppData/Roaming/Code - Insiders/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json", "{}");
    const win = detectClients(env({ platform: "win32" }));
    expect(win.map((d) => d.def.id)).toEqual(["claude-desktop", "goose", "cline"]);
    expect(win.find((d) => d.def.id === "cline")!.target.path).toContain("Code - Insiders");
  });

  it("honors a custom config home (XDG_CONFIG_HOME) and CODEX_HOME", () => {
    put("xdg/goose/config.yaml", "");
    put("codex-home/config.toml", "");
    const e = env({ configHome: join(root, "xdg"), codexHome: join(root, "codex-home") });
    expect(detectClients(e).map((d) => [d.def.id, d.target.path.slice(root.length + 1)])).toEqual([
      ["codex", "codex-home/config.toml"],
      ["goose", "xdg/goose/config.yaml"]
    ]);
  });

  it("OpenCode: prefers the global file, accepts a project opencode.json", () => {
    put("work/opencode.json", "{}");
    const only = detectClients(env());
    expect(only.map((d) => d.def.id)).toEqual(["opencode"]);
    expect(only[0].target.path).toBe(join(root, "work", "opencode.json"));
    put(".config/opencode/opencode.json", "{}");
    expect(detectClients(env())[0].target.path).toBe(join(root, ".config/opencode/opencode.json"));
  });

  it("Continue: config.yaml, else config.json, else a block file to create", () => {
    mkdirSync(join(root, ".continue"));
    const c = findClient("continue")!;
    expect(resolveTarget(c, env())).toMatchObject({ path: join(root, ".continue/mcpServers/las.yaml"), format: "yaml-continue" });
    put(".continue/config.json", "{}");
    expect(resolveTarget(c, env())).toMatchObject({ format: "json-continue" });
    put(".continue/config.yaml", "");
    expect(resolveTarget(c, env())).toMatchObject({ format: "yaml-continue", path: join(root, ".continue/config.yaml") });
  });

  it("looks clients up by id, alias or name", () => {
    expect(findClient("claude")?.id).toBe("claude-code");
    expect(findClient("Cursor")?.id).toBe("cursor");
    expect(findClient("nope")).toBeUndefined();
  });
});
