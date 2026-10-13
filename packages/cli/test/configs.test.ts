import { describe, expect, it } from "vitest";
import { ConfigError, upsertConfig, type ConfigFormat, type ServerEntry } from "../src/configs.js";

const entry: ServerEntry = { command: "npx", args: ["-y", "las-agents", "serve"] };
const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;

describe("JSON clients", () => {
  const formats: [ConfigFormat, string][] = [
    ["json-mcp-servers", "mcpServers"],
    ["json-claude-code", "mcpServers"],
    ["json-cline", "mcpServers"],
    ["json-opencode", "mcp"]
  ];
  it.each(formats)("%s: creates, adds beside existing servers, and is idempotent", (format, key) => {
    const created = upsertConfig(format, undefined, entry);
    expect(created.state).toBe("created");
    expect(JSON.parse(created.text)[key].las).toBeTruthy();

    const existing = JSON.stringify({ theme: "dark", [key]: { other: { command: "x" } } }, null, 2) + "\n";
    const added = upsertConfig(format, existing, entry);
    expect(added.state).toBe("added");
    const parsed = JSON.parse(added.text);
    expect(parsed.theme).toBe("dark");
    expect(parsed[key].other).toEqual({ command: "x" });
    expect(Object.keys(parsed[key])).toEqual(["other", "las"]);

    const again = upsertConfig(format, added.text, entry);
    expect(again.state).toBe("unchanged");
    expect(again.text).toBe(added.text);
    expect(count(again.text, /"las"/g)).toBe(1);
  });
  it("replaces a stale las entry and keeps keys the user added", () => {
    const old = JSON.stringify({ mcpServers: { las: { command: "node", args: ["old.js"], env: { A: "1" } } } });
    const r = upsertConfig("json-mcp-servers", old, entry);
    expect(r.state).toBe("replaced");
    expect(JSON.parse(r.text).mcpServers.las).toEqual({ command: "npx", args: ["-y", "las-agents", "serve"], env: { A: "1" } });
  });
  it("uses each client's own shape", () => {
    expect(JSON.parse(upsertConfig("json-claude-code", undefined, entry).text).mcpServers.las.type).toBe("stdio");
    expect(JSON.parse(upsertConfig("json-cline", undefined, entry).text).mcpServers.las.disabled).toBe(false);
    const oc = JSON.parse(upsertConfig("json-opencode", undefined, entry).text);
    expect(oc.mcp.las).toEqual({ type: "local", command: ["npx", "-y", "las-agents", "serve"], enabled: true });
    expect(oc.$schema).toMatch(/opencode/);
  });
  it("keeps the file's indent and missing trailing newline", () => {
    const r = upsertConfig("json-mcp-servers", '{\n\t"a": 1\n}', entry);
    expect(r.text.startsWith('{\n\t"a": 1')).toBe(true);
    expect(r.text.endsWith("\n")).toBe(false);
  });
  it("refuses JSON it can't parse or that has the wrong shape", () => {
    expect(() => upsertConfig("json-mcp-servers", '{ // comment\n}', entry)).toThrow(ConfigError);
    expect(() => upsertConfig("json-mcp-servers", "[]", entry)).toThrow(ConfigError);
    expect(() => upsertConfig("json-mcp-servers", '{"mcpServers": []}', entry)).toThrow(ConfigError);
  });
  it("Continue's config.json: one entry, idempotent", () => {
    const base = JSON.stringify({ models: [], experimental: { modelContextProtocolServers: [{ name: "x", transport: { type: "stdio", command: "y" } }] } });
    const a = upsertConfig("json-continue", base, entry);
    expect(a.state).toBe("added");
    expect(JSON.parse(a.text).experimental.modelContextProtocolServers).toHaveLength(2);
    const b = upsertConfig("json-continue", a.text, entry);
    expect(b.state).toBe("unchanged");
  });
});

describe("Codex TOML", () => {
  const block = '[mcp_servers.las]\ncommand = "npx"\nargs = ["-y", "las-agents", "serve"]\n';
  it("creates the file", () => {
    expect(upsertConfig("toml-codex", undefined, entry)).toEqual({ text: block, state: "created" });
  });
  it("appends after existing tables without touching them", () => {
    const base = 'model = "o3" # keep\n\n[mcp_servers.other]\ncommand = "z"\n';
    const r = upsertConfig("toml-codex", base, entry);
    expect(r.state).toBe("added");
    expect(r.text).toBe(`${base}\n${block}`);
  });
  it("is idempotent, including when the block sits in the middle", () => {
    const base = `a = 1\n\n${block}\n[other]\nb = 2\n`;
    const r = upsertConfig("toml-codex", base, entry);
    expect(r.state).toBe("unchanged");
    expect(r.text).toBe(base);
    const once = upsertConfig("toml-codex", "x = 1\n", entry);
    expect(upsertConfig("toml-codex", once.text, entry).text).toBe(once.text);
    expect(count(once.text, /\[mcp_servers\.las\]/g)).toBe(1);
  });
  it("replaces a stale block but keeps its sub-tables and the next table", () => {
    const base = '[mcp_servers.las]\ncommand = "old"\nargs = []\n\n[mcp_servers.las.env]\nKEY = "v"\n\n[next]\nz = 1\n';
    const r = upsertConfig("toml-codex", base, entry);
    expect(r.state).toBe("replaced");
    expect(r.text).toContain('command = "npx"');
    expect(r.text).not.toContain("old");
    expect(r.text).toContain('[mcp_servers.las.env]\nKEY = "v"');
    expect(r.text).toContain("[next]\nz = 1");
    expect(count(r.text, /^\[mcp_servers\.las\]$/gm)).toBe(1);
  });
  it("recognises a quoted key and preserves CRLF", () => {
    const base = '[mcp_servers."las"]\r\ncommand = "old"\r\n';
    const r = upsertConfig("toml-codex", base, entry);
    expect(r.state).toBe("replaced");
    expect(r.text).toContain("\r\n");
    expect(r.text.replace(/\r\n/g, "")).not.toContain("\n");
  });
  it("escapes Windows paths", () => {
    const r = upsertConfig("toml-codex", undefined, { command: "C:\\Program Files\\nodejs\\node.exe", args: ["a\"b"] });
    expect(r.text).toContain('command = "C:\\\\Program Files\\\\nodejs\\\\node.exe"');
    expect(r.text).toContain('args = ["a\\"b"]');
  });
});

describe("Goose YAML", () => {
  it("creates extensions with a las child", () => {
    const r = upsertConfig("yaml-goose", undefined, entry);
    expect(r.state).toBe("created");
    expect(r.text).toBe(
      "extensions:\n  las:\n    name: las\n    description: Learn Any Skill: coaching engines and a local studio\n    type: stdio\n    cmd: npx\n    args:\n      - -y\n      - las-agents\n      - serve\n    enabled: true\n    envs: {}\n    timeout: 300\n"
    );
  });
  it("adds under an existing extensions map, keeps neighbours and comments, and is idempotent", () => {
    const base = "GOOSE_PROVIDER: openai\n# my tools\nextensions:\n  developer:\n    enabled: true\n    type: builtin\n\nGOOSE_MODEL: gpt\n";
    const r = upsertConfig("yaml-goose", base, entry);
    expect(r.state).toBe("added");
    expect(r.text).toContain("# my tools\nextensions:\n  developer:\n    enabled: true\n    type: builtin\n  las:\n    name: las");
    expect(r.text.endsWith("\n\nGOOSE_MODEL: gpt\n") || r.text.endsWith("    timeout: 300\n\nGOOSE_MODEL: gpt\n")).toBe(true);
    const again = upsertConfig("yaml-goose", r.text, entry);
    expect(again.state).toBe("unchanged");
    expect(again.text).toBe(r.text);
    expect(count(r.text, /^ {2}las:/gm)).toBe(1);
  });
  it("replaces a stale las block by key without eating the next extension", () => {
    const base = "extensions:\n  las:\n    name: las\n    type: stdio\n    cmd: old\n    args: []\n  other:\n    type: builtin\n";
    const r = upsertConfig("yaml-goose", base, entry);
    expect(r.state).toBe("replaced");
    expect(r.text).not.toContain("old");
    expect(r.text).toContain("  other:\n    type: builtin\n");
    expect(count(r.text, /^ {2}las:/gm)).toBe(1);
  });
  it("appends the section when the file has none, and handles `extensions: {}`", () => {
    const a = upsertConfig("yaml-goose", "GOOSE_MODEL: gpt\n", entry);
    expect(a.text.startsWith("GOOSE_MODEL: gpt\n\nextensions:\n  las:")).toBe(true);
    const b = upsertConfig("yaml-goose", "extensions: {}\n", entry);
    expect(b.text.startsWith("extensions:\n  las:")).toBe(true);
  });
  it("quotes values that aren't safe plain scalars", () => {
    const r = upsertConfig("yaml-goose", undefined, { command: "node", args: ["--import", "file:///a b/x.mjs"] });
    expect(r.text).toContain('- "file:///a b/x.mjs"');
    expect(r.text).toContain("- --import");
  });
});

describe("Continue YAML", () => {
  it("creates a standalone block file with the header Continue needs", () => {
    const r = upsertConfig("yaml-continue", undefined, entry);
    expect(r.state).toBe("created");
    expect(r.text).toBe("name: Learn Any Skill\nversion: 0.0.1\nschema: v1\n\nmcpServers:\n  - name: las\n    command: npx\n    args:\n      - -y\n      - las-agents\n      - serve\n");
  });
  it("appends an item to an existing list and is idempotent", () => {
    const base = "name: Config\nversion: 1.0.0\nschema: v1\nmodels:\n  - name: m\n    provider: x\nmcpServers:\n  - name: sqlite\n    command: uvx\n    args:\n      - mcp-server-sqlite\n";
    const r = upsertConfig("yaml-continue", base, entry);
    expect(r.state).toBe("added");
    expect(r.text.startsWith(base)).toBe(true);
    expect(r.text).toContain("  - name: las\n    command: npx");
    const again = upsertConfig("yaml-continue", r.text, entry);
    expect(again.state).toBe("unchanged");
    expect(count(again.text, /name: las/g)).toBe(1);
  });
  it("replaces the las item wherever it sits, with dashes at column 0, and keeps the items after it", () => {
    const base = "mcpServers:\n- name: las\n  command: old\n  args: []\n- name: next\n  command: n\nmodels:\n  - name: m\n";
    const r = upsertConfig("yaml-continue", base, entry);
    expect(r.state).toBe("replaced");
    expect(r.text).toContain("- name: las\n  command: npx\n  args:\n    - -y");
    expect(r.text).toContain("- name: next\n  command: n\nmodels:\n  - name: m\n");
    expect(r.text).not.toContain("old");
  });
  it("adds the section when only other keys exist and when the list is `[]`", () => {
    expect(upsertConfig("yaml-continue", "name: a\nversion: 1\nschema: v1\n", entry).text).toContain("mcpServers:\n  - name: las");
    expect(upsertConfig("yaml-continue", "mcpServers: []\nmodels: []\n", entry).text).toBe("mcpServers:\n  - name: las\n    command: npx\n    args:\n      - -y\n      - las-agents\n      - serve\nmodels: []\n");
  });
});
