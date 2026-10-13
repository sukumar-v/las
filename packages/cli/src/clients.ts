import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "./env.js";
import type { ConfigFormat, ServerEntry } from "./configs.js";

/**
 * The table of MCP clients setup knows. Adding a client is one entry here:
 * where it keeps its config, how that config is shaped (a `ConfigFormat` in configs.ts), how to tell it is installed,
 * and where it loads agent skills from (omit `skillDir` when it has no skills folder).
 */

export interface ConfigTarget {
  path: string;
  format: ConfigFormat;
  /** the file to create when none of the candidates exists (default: the first candidate) */
  createWhenMissing?: boolean;
}

export interface ClientDef {
  id: string;
  name: string;
  aliases?: string[];
  /** files or folders that exist when the client is installed */
  signals(env: Env): string[];
  /** executables on PATH that mean the client is installed */
  commands?: string[];
  /** candidate MCP config files, most preferred first; the first that exists is edited */
  configs(env: Env): ConfigTarget[];
  /** the folder agent skills are copied into, for clients that have one */
  skillDir?(env: Env): string;
  /** register through the client's own CLI when it is on PATH (preferred over editing its file) */
  cli?: { command: string; add(entry: ServerEntry): string[]; remove: string[] };
  /** what to tell the learner after install */
  restart: string;
  /**
   * A second file setup edits for the live coach: Claude Code's user settings, where it raises MCP_TOOL_TIMEOUT and
   * installs the SessionStart hook that records the conversation id (`las-agents client-session`).
   */
  settings?: { path(env: Env): string; format: "json-claude-settings" };
  /**
   * The per-server tool-call timeout (seconds) written into the server entry, for configs that have such a field.
   * A 55 s coach_wait needs more than the common 60 s default to be safe.
   */
  toolTimeoutS?: number;
  /** ⚠ what is still unverified about this client's tool timeout */
  toolTimeoutNote?: string;
}

export const SKILL_FOLDER = "learn-any-skill";

/** VS Code user-data folders where Cline keeps its settings (stable, Insiders, VSCodium, and a remote server). */
function vscodeUserDirs(env: Env): string[] {
  const base = env.platform === "darwin" ? join(env.home, "Library", "Application Support") : env.platform === "win32" ? env.appData : env.configHome;
  const dirs = ["Code", "Code - Insiders", "VSCodium"].map((d) => join(base, d, "User"));
  if (env.platform === "linux") dirs.push(join(env.home, ".vscode-server", "data", "User"));
  return dirs;
}
const CLINE_REL = ["globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json"];

function claudeDesktopDir(env: Env): string {
  return env.platform === "darwin" ? join(env.home, "Library", "Application Support", "Claude") : env.platform === "win32" ? join(env.appData, "Claude") : join(env.configHome, "Claude");
}

function gooseDir(env: Env): string {
  return env.platform === "win32" ? join(env.appData, "Block", "goose", "config") : join(env.configHome, "goose");
}

export const CLIENTS: ClientDef[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    aliases: ["claude"],
    signals: (e) => [join(e.home, ".claude.json"), join(e.home, ".claude")],
    commands: ["claude"],
    configs: (e) => [{ path: join(e.home, ".claude.json"), format: "json-claude-code" }],
    skillDir: (e) => join(e.home, ".claude", "skills", SKILL_FOLDER),
    cli: {
      command: "claude",
      add: (entry) => ["mcp", "add", "--scope", "user", "las", "--", entry.command, ...entry.args],
      remove: ["mcp", "remove", "las", "--scope", "user"]
    },
    restart: "Start a new Claude Code session (or run /mcp) to load it.",
    // tool timeout: env.MCP_TOOL_TIMEOUT in settings.json (default about 28 h); `claude mcp add` has no per-server field
    settings: { path: (e) => join(e.home, ".claude", "settings.json"), format: "json-claude-settings" }
  },
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    aliases: ["desktop"],
    signals: (e) => [claudeDesktopDir(e)],
    configs: (e) => [{ path: join(claudeDesktopDir(e), "claude_desktop_config.json"), format: "json-mcp-servers" }],
    restart: "Quit and reopen Claude Desktop.",
    toolTimeoutNote: "⚠ verify: no per-server tool timeout field known"
  },
  {
    id: "codex",
    name: "Codex",
    signals: (e) => [e.codexHome],
    commands: ["codex"],
    configs: (e) => [{ path: join(e.codexHome, "config.toml"), format: "toml-codex" }],
    skillDir: (e) => join(e.codexHome, "skills", SKILL_FOLDER),
    // `[mcp_servers.las] tool_timeout_sec`, seconds (codex-rs/config/src/mcp_types.rs)
    toolTimeoutS: 300,
    restart: "Start a new Codex session."
  },
  {
    id: "cursor",
    name: "Cursor",
    signals: (e) => [join(e.home, ".cursor")],
    configs: (e) => [{ path: join(e.home, ".cursor", "mcp.json"), format: "json-mcp-servers" }],
    skillDir: (e) => join(e.home, ".cursor", "skills", SKILL_FOLDER),
    restart: "Reload Cursor (Settings > MCP shows the las server).",
    toolTimeoutNote: "⚠ verify: no per-server tool timeout field known"
  },
  {
    id: "goose",
    name: "Goose",
    signals: (e) => [gooseDir(e)],
    commands: ["goose"],
    configs: (e) => [{ path: join(gooseDir(e), "config.yaml"), format: "yaml-goose" }],
    // extensions.las.timeout, seconds
    toolTimeoutS: 300,
    restart: "Start a new Goose session."
  },
  {
    id: "opencode",
    name: "OpenCode",
    signals: (e) => [join(e.configHome, "opencode"), join(e.cwd, "opencode.json")],
    commands: ["opencode"],
    configs: (e) => [
      { path: join(e.configHome, "opencode", "opencode.json"), format: "json-opencode", createWhenMissing: true },
      { path: join(e.cwd, "opencode.json"), format: "json-opencode" }
    ],
    restart: "Start a new OpenCode session.",
    toolTimeoutNote: "⚠ verify: OpenCode's MCP `timeout` (ms, default 5000) covers fetching the tool list, not tool calls; no tool-call timeout field found"
  },
  {
    id: "continue",
    name: "Continue",
    signals: (e) => [join(e.home, ".continue")],
    configs: (e) => [
      { path: join(e.home, ".continue", "config.yaml"), format: "yaml-continue" },
      { path: join(e.home, ".continue", "config.json"), format: "json-continue" },
      // no main config: add a standalone block file, which Continue loads next to it
      { path: join(e.home, ".continue", "mcpServers", "las.yaml"), format: "yaml-continue", createWhenMissing: true }
    ],
    restart: "Reload the Continue extension.",
    toolTimeoutNote: "⚠ verify: no per-server tool timeout field known"
  },
  {
    id: "cline",
    name: "Cline",
    signals: (e) => vscodeUserDirs(e).map((d) => join(d, "globalStorage", "saoudrizwan.claude-dev")),
    configs: (e) => vscodeUserDirs(e).map((d, i) => ({ path: join(d, ...CLINE_REL), format: "json-cline" as const, createWhenMissing: i === 0 })),
    restart: "Reload the VS Code window.",
    toolTimeoutNote: "⚠ verify: no per-server tool timeout field known"
  }
];

export function findClient(name: string): ClientDef | undefined {
  const n = name.trim().toLowerCase();
  return CLIENTS.find((c) => c.id === n || c.aliases?.includes(n) || c.name.toLowerCase() === n);
}

export function isInstalled(def: ClientDef, env: Env): boolean {
  return def.signals(env).some((p) => existsSync(p)) || (def.commands ?? []).some((c) => env.hasCommand(c));
}

/** The config file to edit: the first candidate that exists, else the one marked createWhenMissing, else the first. */
export function resolveTarget(def: ClientDef, env: Env): ConfigTarget {
  const all = def.configs(env);
  return all.find((t) => existsSync(t.path)) ?? all.find((t) => t.createWhenMissing) ?? all[0];
}

export interface Detected {
  def: ClientDef;
  target: ConfigTarget;
  /** the file exists already (otherwise setup would create it) */
  configExists: boolean;
  /** the client's CLI is on PATH and can register the server itself */
  viaCli: boolean;
}

export function detectClients(env: Env): Detected[] {
  return CLIENTS.filter((c) => isInstalled(c, env)).map((def) => describe(def, env));
}

export function describe(def: ClientDef, env: Env): Detected {
  const target = resolveTarget(def, env);
  return { def, target, configExists: existsSync(target.path), viaCli: !!def.cli && env.hasCommand(def.cli.command) };
}
