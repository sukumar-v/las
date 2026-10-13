import { isDeepStrictEqual } from "node:util";

/**
 * Pure config editors: given a client's existing config text (or undefined when the file doesn't exist) and the
 * LAS server entry, return the new text. Running one twice never duplicates the entry.
 * JSON is parsed and rewritten; TOML and YAML are edited as text so the user's comments and ordering survive
 * (no TOML/YAML parser is bundled: LAS adds no dependencies for this).
 */

export const SERVER_NAME = "las";

export interface ServerEntry {
  command: string;
  args: string[];
  /** per-server tool-call timeout in seconds, written where the client's config has a field for it (the client's row in clients.ts) */
  toolTimeoutS?: number;
}

export type ConfigFormat = "json-mcp-servers" | "json-claude-code" | "json-cline" | "json-opencode" | "json-continue" | "toml-codex" | "yaml-goose" | "yaml-continue";

export type UpsertState = "created" | "added" | "replaced" | "unchanged";
export interface Upsert {
  text: string;
  state: UpsertState;
}

/** The config can't be edited safely (for example JSON with comments). The message is for the learner. */
export class ConfigError extends Error {}

type Json = Record<string, any>;
const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

// ---------- JSON ----------

function detectIndent(text: string | undefined): string | number {
  const m = text ? /\n([ \t]+)\S/.exec(text) : null;
  return m ? (m[1].startsWith("\t") ? "\t" : m[1].length) : 2;
}

function jsonEntry(format: ConfigFormat, e: ServerEntry): Json {
  switch (format) {
    case "json-claude-code":
      return { type: "stdio", command: e.command, args: e.args };
    case "json-cline":
      return { command: e.command, args: e.args, disabled: false };
    case "json-opencode":
      return { type: "local", command: [e.command, ...e.args], enabled: true };
    default:
      return { command: e.command, args: e.args };
  }
}

function jsonUpsert(format: ConfigFormat, existing: string | undefined, entry: ServerEntry): Upsert {
  const blank = existing === undefined || existing.trim() === "";
  let root: Json = {};
  if (!blank) {
    try {
      root = JSON.parse(existing!);
    } catch (e) {
      throw new ConfigError(`not valid JSON (files with comments are not supported): ${(e as Error).message}`);
    }
    if (!isObj(root)) throw new ConfigError("the top level is not a JSON object");
  }
  const holder = (parent: Json, key: string): Json => {
    if (parent[key] === undefined) parent[key] = {};
    if (!isObj(parent[key])) throw new ConfigError(`"${key}" is not an object`);
    return parent[key];
  };
  let before: unknown;
  let after: unknown;
  if (format === "json-continue") {
    // Continue's older config.json: experimental.modelContextProtocolServers: [{ name, transport: { type, command, args } }]
    const exp = holder(root, "experimental");
    if (exp.modelContextProtocolServers === undefined) exp.modelContextProtocolServers = [];
    const list = exp.modelContextProtocolServers;
    if (!Array.isArray(list)) throw new ConfigError('"experimental.modelContextProtocolServers" is not a list');
    const next = { name: SERVER_NAME, transport: { type: "stdio", command: entry.command, args: entry.args } };
    const i = list.findIndex((x) => isObj(x) && (x.name === SERVER_NAME || (Array.isArray(x.transport?.args) && x.transport.args.includes("las-agents"))));
    before = i >= 0 ? list[i] : undefined;
    after = isObj(before) ? { ...before, ...next, transport: { ...before.transport, ...next.transport } } : next;
    if (i >= 0) list[i] = after;
    else list.push(after);
  } else {
    const key = format === "json-opencode" ? "mcp" : "mcpServers";
    if (format === "json-opencode" && blank) root.$schema = "https://opencode.ai/config.json";
    const servers = holder(root, key);
    before = servers[SERVER_NAME];
    after = { ...(isObj(before) ? before : {}), ...jsonEntry(format, entry) };
    servers[SERVER_NAME] = after;
  }
  if (!blank && isDeepStrictEqual(before, after)) return { text: existing!, state: "unchanged" };
  const trailing = blank || existing!.endsWith("\n") ? "\n" : "";
  return { text: JSON.stringify(root, null, detectIndent(existing)) + trailing, state: blank ? "created" : before === undefined ? "added" : "replaced" };
}

// ---------- scalars ----------

/** A YAML scalar: plain when that is safe, otherwise a JSON string (which is valid YAML). */
export function yamlScalar(s: string): string {
  return /^[A-Za-z0-9_./@+=~\\-]+$/.test(s) && !/^(true|false|null|yes|no|on|off|~|-+|[-+]?\d[\d_.]*)$/i.test(s) ? s : JSON.stringify(s);
}

// ---------- TOML (Codex) ----------

export function codexBlock(entry: ServerEntry): string[] {
  const block = [`[mcp_servers.${SERVER_NAME}]`, `command = ${JSON.stringify(entry.command)}`, `args = [${entry.args.map((a) => JSON.stringify(a)).join(", ")}]`];
  // Codex: `tool_timeout_sec`, seconds, per server (codex-rs/config/src/mcp_types.rs)
  if (entry.toolTimeoutS) block.push(`tool_timeout_sec = ${entry.toolTimeoutS}`);
  return block;
}

const TOML_HEADER = /^\s*\[/;
const TOML_LAS_HEADER = /^\s*\[\s*mcp_servers\s*\.\s*(?:las|"las"|'las')\s*\]\s*(?:#.*)?$/;

function tomlUpsert(existing: string | undefined, entry: ServerEntry): Upsert {
  const text = existing ?? "";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text === "" ? [] : text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const block = codexBlock(entry);
  const start = lines.findIndex((l) => TOML_LAS_HEADER.test(l));
  if (start >= 0) {
    let end = start + 1;
    while (end < lines.length && !TOML_HEADER.test(lines[end])) end++;
    // keep blank/comment lines that trail the block attached to what follows
    let content = end;
    while (content > start + 1 && /^\s*(#.*)?$/.test(lines[content - 1])) content--;
    const current = lines.slice(start, content).filter((l) => !/^\s*(#.*)?$/.test(l));
    if (isDeepStrictEqual(current, block)) return { text, state: "unchanged" };
    lines.splice(start, content - start, ...block);
    return { text: lines.join(eol) + eol, state: "replaced" };
  }
  if (lines.length && lines[lines.length - 1].trim() !== "") lines.push("");
  lines.push(...block);
  return { text: lines.join(eol) + eol, state: existing === undefined || existing.trim() === "" ? "created" : "added" };
}

// ---------- YAML (Goose, Continue) ----------

const indentOf = (l: string) => l.length - l.trimStart().length;
const isBlank = (l: string) => /^\s*(#.*)?$/.test(l);

interface YamlDoc {
  lines: string[];
  eol: string;
}

function yamlLines(text: string): YamlDoc {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text === "" ? [] : text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return { lines, eol };
}

/** Finds `key:` at column 0 and the end of its section; rewrites an empty flow value (`key: {}`) to `key:`. */
function yamlSection(lines: string[], key: string): { t: number; end: number; last: number } | undefined {
  const t = lines.findIndex((l) => new RegExp(`^${key}:\\s*(?:#.*)?$`).test(l) || new RegExp(`^${key}:\\s*(?:\\{\\s*\\}|\\[\\s*\\])\\s*(?:#.*)?$`).test(l));
  if (t < 0) return undefined;
  lines[t] = `${key}:`;
  let end = t + 1;
  while (end < lines.length && (isBlank(lines[end]) || /^\s/.test(lines[end]) || /^-(\s|$)/.test(lines[end]))) end++;
  let last = end - 1;
  while (last > t && isBlank(lines[last])) last--;
  return { t, end, last };
}

const pad = (n: number) => " ".repeat(n);

/** `extensions: { las: {...} }` style: upsert one child mapping under a top-level key. */
function yamlMapChild(existing: string, key: string, child: string, body: string[]): Upsert {
  const doc = yamlLines(existing);
  const { lines } = doc;
  const sec = yamlSection(lines, key);
  const render = (indent: number) => [`${pad(indent)}${child}:`, ...body.map((l) => pad(indent + 2) + l)];
  let state: UpsertState;
  if (!sec) {
    if (lines.length && lines[lines.length - 1].trim() !== "") lines.push("");
    lines.push(`${key}:`, ...render(2));
    state = existing.trim() === "" ? "created" : "added";
  } else {
    const first = lines.slice(sec.t + 1, sec.end).find((l) => !isBlank(l));
    const ci = first ? indentOf(first) : 2;
    const c = lines.findIndex((l, i) => i > sec.t && i < sec.end && indentOf(l) === ci && new RegExp(`^\\s*(["']?)${child}\\1\\s*:`).test(l));
    if (c >= 0) {
      let e = c + 1;
      while (e < sec.end && (isBlank(lines[e]) || indentOf(lines[e]) > ci)) e++;
      while (e > c + 1 && isBlank(lines[e - 1])) e--;
      lines.splice(c, e - c, ...render(ci));
      state = "replaced";
    } else {
      lines.splice(sec.last + 1, 0, ...render(ci));
      state = "added";
    }
  }
  const text = lines.join(doc.eol) + doc.eol;
  return { text, state: text === normalize(existing) ? "unchanged" : state };
}

/** `mcpServers: [ - name: las ... ]` style: upsert one list item, matched by its `name`. */
function yamlSeqItem(existing: string, key: string, name: string, body: string[]): Upsert {
  const doc = yamlLines(existing);
  const { lines } = doc;
  const sec = yamlSection(lines, key);
  const render = (d: number) => body.map((l, i) => (i === 0 ? `${pad(d)}- ${l}` : `${pad(d + 2)}${l}`));
  let state: UpsertState;
  if (!sec) {
    if (lines.length && lines[lines.length - 1].trim() !== "") lines.push("");
    lines.push(`${key}:`, ...render(2));
    state = existing.trim() === "" ? "created" : "added";
  } else {
    const firstDash = lines.slice(sec.t + 1, sec.end).find((l) => /^\s*-(\s|$)/.test(l));
    const d = firstDash ? indentOf(firstDash) : 2;
    const starts: number[] = [];
    for (let i = sec.t + 1; i < sec.end; i++) if (indentOf(lines[i]) === d && /^\s*-(\s|$)/.test(lines[i])) starts.push(i);
    const nameRe = new RegExp(`^(?:\\s*-\\s+|\\s+)name:\\s*(["']?)${name}\\1\\s*(?:#.*)?$`);
    let hit = -1;
    let hitEnd = -1;
    starts.forEach((s, k) => {
      let e = k + 1 < starts.length ? starts[k + 1] : sec.last + 1;
      while (e > s + 1 && isBlank(lines[e - 1])) e--;
      if (hit < 0 && lines.slice(s, e).some((l, i) => (i === 0 || indentOf(l) === d + 2) && nameRe.test(l))) {
        hit = s;
        hitEnd = e;
      }
    });
    if (hit >= 0) {
      lines.splice(hit, hitEnd - hit, ...render(d));
      state = "replaced";
    } else {
      lines.splice(sec.last + 1, 0, ...render(d));
      state = "added";
    }
  }
  const text = lines.join(doc.eol) + doc.eol;
  return { text, state: text === normalize(existing) ? "unchanged" : state };
}

/** existing text with a single trailing newline and its original line endings, for exact comparison */
function normalize(t: string): string {
  if (t === "") return "";
  const eol = t.includes("\r\n") ? "\r\n" : "\n";
  return t.replace(/(\r?\n)*$/, "") + eol;
}

export function gooseBody(entry: ServerEntry): string[] {
  return [
    `name: ${SERVER_NAME}`,
    "description: Learn Any Skill: coaching engines and a local studio",
    "type: stdio",
    `cmd: ${yamlScalar(entry.command)}`,
    "args:",
    ...entry.args.map((a) => `  - ${yamlScalar(a)}`),
    "enabled: true",
    "envs: {}",
    `timeout: ${entry.toolTimeoutS ?? 300}`
  ];
}

export function continueBody(entry: ServerEntry): string[] {
  return [`name: ${SERVER_NAME}`, `command: ${yamlScalar(entry.command)}`, "args:", ...entry.args.map((a) => `  - ${yamlScalar(a)}`)];
}

const CONTINUE_HEADER = "name: Learn Any Skill\nversion: 0.0.1\nschema: v1\n";

/** Applies the LAS server entry to a client's config text for the given format. */
export function upsertConfig(format: ConfigFormat, existing: string | undefined, entry: ServerEntry): Upsert {
  switch (format) {
    case "toml-codex":
      return tomlUpsert(existing, entry);
    case "yaml-goose": {
      const r = yamlMapChild(existing ?? "", "extensions", SERVER_NAME, gooseBody(entry));
      return existing === undefined ? { ...r, state: "created" } : r;
    }
    case "yaml-continue": {
      // a missing file becomes a standalone Continue block file, which needs name/version/schema
      const r = yamlSeqItem(existing ?? CONTINUE_HEADER, "mcpServers", SERVER_NAME, continueBody(entry));
      return existing === undefined ? { ...r, state: "created" } : r;
    }
    default:
      return jsonUpsert(format, existing, entry);
  }
}

// ---------- Claude Code settings.json (live coach: tool timeout and the SessionStart hook) ----------

/** setup raises `env.MCP_TOOL_TIMEOUT` when it is unset or below this (ms); a 55 s coach_wait needs room */
export const CLAUDE_TOOL_TIMEOUT_MIN_MS = 120_000;
/**
 * The value written. Claude Code's own default is 100000000 ms (about 28 h) and the variable applies to every MCP
 * server, so writing the minimum would cut the learner's other servers short; 30 minutes matches Claude Code's
 * idle timeout for stdio servers (adapters.ts, finding 3).
 */
export const CLAUDE_TOOL_TIMEOUT_MS = 1_800_000;
/** seconds Claude Code gives the hook before cancelling it */
export const CLIENT_SESSION_HOOK_TIMEOUT_S = 10;

export const isLasSessionHook = (command: unknown): boolean => typeof command === "string" && /\bclient-session\b/.test(command) && /las/.test(command);

export interface ClaudeSettingsStatus {
  /** the MCP_TOOL_TIMEOUT in the env block, as a number, when set */
  toolTimeoutMs?: number;
  hookInstalled: boolean;
  hookCommand?: string;
}

function sessionStartHooks(root: Json): Json[] {
  const groups = isObj(root.hooks) && Array.isArray(root.hooks.SessionStart) ? root.hooks.SessionStart : [];
  return groups.filter(isObj).flatMap((g: Json) => (Array.isArray(g.hooks) ? g.hooks.filter(isObj) : []));
}

/** What `las doctor` reports from ~/.claude/settings.json. */
export function inspectClaudeSettings(text: string | undefined): ClaudeSettingsStatus {
  let root: Json = {};
  try {
    root = text ? JSON.parse(text) : {};
  } catch {
    return { hookInstalled: false };
  }
  if (!isObj(root)) return { hookInstalled: false };
  const raw = isObj(root.env) ? root.env.MCP_TOOL_TIMEOUT : undefined;
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  const hook = sessionStartHooks(root).find((h) => isLasSessionHook(h.command));
  return { toolTimeoutMs: Number.isFinite(n) ? n : undefined, hookInstalled: !!hook, hookCommand: hook?.command };
}

/**
 * Ensures `env.MCP_TOOL_TIMEOUT` is at least CLAUDE_TOOL_TIMEOUT_MIN_MS (never lowers a larger value) and that one
 * SessionStart command hook runs `client-session`. Everything else in the file, other hooks included, is kept.
 * The hook group has no matcher, so it runs for every source (startup, resume, clear, compact): /clear and
 * compaction can change the session id, and the newest file per pid wins.
 */
export function upsertClaudeSettings(existing: string | undefined, hookCommand: string): Upsert {
  const blank = existing === undefined || existing.trim() === "";
  let root: Json = {};
  if (!blank) {
    try {
      root = JSON.parse(existing!);
    } catch (e) {
      throw new ConfigError(`not valid JSON (files with comments are not supported): ${(e as Error).message}`);
    }
    if (!isObj(root)) throw new ConfigError("the top level is not a JSON object");
  }
  const before = JSON.stringify(root);
  if (root.env === undefined) root.env = {};
  if (!isObj(root.env)) throw new ConfigError('"env" is not an object');
  const current = Number(root.env.MCP_TOOL_TIMEOUT);
  // values in "env" are strings: Claude Code copies them into its environment as written
  if (!(Number.isFinite(current) && current >= CLAUDE_TOOL_TIMEOUT_MIN_MS)) root.env.MCP_TOOL_TIMEOUT = String(CLAUDE_TOOL_TIMEOUT_MS);

  if (root.hooks === undefined) root.hooks = {};
  if (!isObj(root.hooks)) throw new ConfigError('"hooks" is not an object');
  if (root.hooks.SessionStart === undefined) root.hooks.SessionStart = [];
  if (!Array.isArray(root.hooks.SessionStart)) throw new ConfigError('"hooks.SessionStart" is not a list');
  const mine = sessionStartHooks(root).filter((h) => isLasSessionHook(h.command));
  const hadHook = mine.length > 0;
  if (hadHook) for (const h of mine) h.command = hookCommand;
  else root.hooks.SessionStart.push({ hooks: [{ type: "command", command: hookCommand, timeout: CLIENT_SESSION_HOOK_TIMEOUT_S }] });

  if (!blank && JSON.stringify(root) === before) return { text: existing!, state: "unchanged" };
  const trailing = blank || existing!.endsWith("\n") ? "\n" : "";
  return { text: JSON.stringify(root, null, detectIndent(existing)) + trailing, state: blank ? "created" : hadHook ? "replaced" : "added" };
}
