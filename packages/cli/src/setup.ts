import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CLIENTS, describe, detectClients, findClient, SKILL_FOLDER, type ClientDef, type Detected } from "./clients.js";
import { ConfigError, upsertClaudeSettings, upsertConfig, type ServerEntry, type Upsert } from "./configs.js";
import { unifiedDiff } from "./diff.js";
import type { Env } from "./env.js";
import type { InstallInfo } from "./install.js";
import { applySkill, planSkill, skillChanged } from "./skill.js";

export interface SetupOptions {
  /** approve every change without asking */
  yes: boolean;
  /** show what would change and write nothing */
  dryRun: boolean;
  /** only these clients (ids or aliases); named clients are set up even when not detected */
  clients: string[];
  noSkill: boolean;
  /** edit config files directly even when a client's own CLI is available */
  noCli: boolean;
}

export interface Io {
  out(line: string): void;
  err(line: string): void;
  /** returns "" when there is no answer (closed input) */
  ask(question: string): Promise<string>;
  /** run a program and wait; never throws */
  run(command: string, args: string[]): { status: number; output: string };
  now(): Date;
}

export type Outcome = "applied" | "unchanged" | "dry-run" | "declined" | "failed" | "manual" | "skipped";

export interface ClientResult {
  id: string;
  name: string;
  server: Outcome;
  skill: Outcome;
  /** the live-coach settings file (Claude Code's settings.json), for clients that have one */
  settings: Outcome;
  configPath: string;
  backups: string[];
  note?: string;
}

export interface SetupResult {
  results: ClientResult[];
  exitCode: number;
}

export const stamp = (d: Date) => d.toISOString().replace(/\.\d+Z$/, "").replace(/[-:]/g, "").replace("T", "-");

/** Writes through a temp file so a crash never leaves half a config behind. */
export function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.las-tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/** Copies `path` to `<path>.las-backup-<timestamp>` and returns the backup path. */
export function backupFile(path: string, when: Date): string {
  const backup = `${path}.las-backup-${stamp(when)}`;
  copyFileSync(path, backup);
  return backup;
}

const yes = (a: string) => /^y(es)?$/i.test(a.trim());

async function approve(opts: SetupOptions, io: Io, question: string): Promise<boolean> {
  if (opts.yes) return true;
  return yes(await io.ask(`${question} [y/N] `));
}

function indent(text: string, by = "    "): string {
  return text
    .split("\n")
    .map((l) => (l ? by + l : l))
    .join("\n");
}

function readIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

export function resolveRequested(names: string[]): { defs: ClientDef[]; unknown: string[] } {
  const defs: ClientDef[] = [];
  const unknown: string[] = [];
  for (const raw of names.flatMap((n) => n.split(",")).filter(Boolean)) {
    const d = findClient(raw);
    if (!d) unknown.push(raw);
    else if (!defs.includes(d)) defs.push(d);
  }
  return { defs, unknown };
}

async function setupServer(det: Detected, entry: ServerEntry, opts: SetupOptions, env: Env, io: Io, res: ClientResult): Promise<void> {
  const { def, target } = det;
  const before = readIfExists(target.path);
  let plan: Upsert | undefined;
  try {
    plan = upsertConfig(target.format, before, entry);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    io.err(`  Can't edit ${target.path}: ${e.message}`);
  }
  const useCli = det.viaCli && !opts.noCli && !!def.cli;
  io.out(`  MCP server: ${target.path}${before === undefined ? " (will be created)" : ""}`);
  if (useCli) io.out(`  Via ${def.cli!.command}:  ${[def.cli!.command, ...def.cli!.add(entry)].join(" ")}`);
  if (!plan) {
    res.server = "failed";
    res.note = "config could not be edited; add the server by hand";
    io.out(`  Add this server by hand: ${JSON.stringify({ command: entry.command, args: entry.args })}`);
    return;
  }
  if (plan.state === "unchanged") {
    res.server = "unchanged";
    io.out("  Already installed and up to date.");
    return;
  }
  const diff = unifiedDiff(before, plan.text, target.path);
  io.out(indent(diff.trimEnd()));
  if (opts.dryRun) {
    res.server = "dry-run";
    return;
  }
  if (!(await approve(opts, io, `  Apply this change for ${def.name}?`))) {
    res.server = "declined";
    return;
  }
  try {
    if (before !== undefined) {
      const b = backupFile(target.path, io.now());
      res.backups.push(b);
      io.out(`  Backed up to ${b}`);
    }
    if (useCli) {
      if (plan.state === "replaced") io.run(def.cli!.command, def.cli!.remove);
      const r = io.run(def.cli!.command, def.cli!.add(entry));
      if (r.status === 0) {
        res.server = "applied";
        return;
      }
      io.err(`  ${def.cli!.command} failed (${r.output.trim().split("\n").pop() ?? r.status}); editing the file directly instead.`);
    }
    writeAtomic(target.path, plan.text);
    res.server = "applied";
  } catch (e) {
    res.server = "failed";
    res.note = (e as Error).message;
    io.err(`  Could not write ${target.path}: ${(e as Error).message}`);
  }
}

/** A shell word: bare when safe, else quoted for the shell the client runs hooks in (sh/Git Bash, or PowerShell/cmd on Windows). */
function shellWord(s: string, platform: NodeJS.Platform): string {
  if (/^[A-Za-z0-9_/\\.:=@%+,-]+$/.test(s)) return s;
  return platform === "win32" ? `"${s.replace(/"/g, '\\"')}"` : `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * The SessionStart hook command for `client`: runs `las-agents client-session` the cheapest way available
 * (`las-agents` on PATH, else the repository's shim through node, else npx). On macOS and Linux it passes
 * `--pid $PPID`: Claude Code runs the hook through `sh -c`, so `$PPID` there is Claude Code's pid. On Windows the
 * hook shell is Git Bash or PowerShell, whose `$PPID` is not the Windows pid, so the subcommand walks its parents.
 */
export function hookCommand(install: InstallInfo, env: Env, client = "claude-code"): string {
  const w = (s: string) => shellWord(s, env.platform);
  let base: string[];
  if (install.mode === "repo" && install.repoRoot) {
    // Windows: a quoted first word is an expression in PowerShell, so start with the bare `node` from PATH
    base = [env.platform === "win32" ? "node" : w(process.execPath), w(join(install.repoRoot, "packages", "cli", "bin", "las-agents.js"))];
  } else if (env.hasCommand("las-agents")) base = ["las-agents"];
  else base = ["npx", "-y", "las-agents"];
  const tail = ["client-session", "--client", client];
  if (env.platform !== "win32") tail.push("--pid", "$PPID");
  return [...base, ...tail].join(" ");
}

async function setupSettings(det: Detected, install: InstallInfo, opts: SetupOptions, env: Env, io: Io, res: ClientResult): Promise<void> {
  const spec = det.def.settings;
  if (!spec) return;
  const path = spec.path(env);
  const before = readIfExists(path);
  let plan: Upsert;
  try {
    plan = upsertClaudeSettings(before, hookCommand(install, env, det.def.id));
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    io.err(`  Can't edit ${path}: ${e.message}`);
    res.settings = "failed";
    return;
  }
  io.out(`  Live coach settings: ${path}${before === undefined ? " (will be created)" : ""}`);
  if (plan.state === "unchanged") {
    res.settings = "unchanged";
    io.out("  Already set (tool timeout and session hook).");
    return;
  }
  io.out("  Raises the MCP tool timeout so the coach can wait for the learner, and records this conversation's id at session start so a coach can be brought back.");
  io.out(indent(unifiedDiff(before, plan.text, path).trimEnd()));
  if (opts.dryRun) {
    res.settings = "dry-run";
    return;
  }
  if (!(await approve(opts, io, `  Apply this change for ${det.def.name}?`))) {
    res.settings = "declined";
    return;
  }
  try {
    if (before !== undefined) {
      const b = backupFile(path, io.now());
      res.backups.push(b);
      io.out(`  Backed up to ${b}`);
    }
    writeAtomic(path, plan.text);
    res.settings = "applied";
  } catch (e) {
    res.settings = "failed";
    io.err(`  Could not write ${path}: ${(e as Error).message}`);
  }
}

async function setupSkill(def: ClientDef, install: InstallInfo, opts: SetupOptions, env: Env, io: Io, res: ClientResult): Promise<void> {
  if (!install.skillSource) {
    res.skill = "skipped";
    io.out("  Skill: not found next to this CLI, skipping.");
    return;
  }
  const dest = def.skillDir?.(env);
  if (!dest) {
    res.skill = "manual";
    io.out(`  Skill: ${def.name} has no skills folder. Add it by hand from ${install.skillSource}`);
    return;
  }
  const plan = planSkill(install.skillSource, dest);
  io.out(`  Skill: ${dest}`);
  if (!skillChanged(plan)) {
    res.skill = "unchanged";
    io.out("  Already installed and up to date.");
    return;
  }
  for (const f of plan) {
    if (f.state === "new") io.out(`    + ${f.rel}${f.lines ? ` (new, ${f.lines} lines)` : " (new)"}`);
    else if (f.state === "changed") io.out(f.diff ? indent(f.diff.trimEnd()) : `    ~ ${f.rel} (binary, changed)`);
  }
  if (opts.dryRun) {
    res.skill = "dry-run";
    return;
  }
  if (!(await approve(opts, io, `  Install the skill for ${def.name}?`))) {
    res.skill = "declined";
    return;
  }
  try {
    // backups live outside the skills folder so the agent never loads a second copy of the skill
    const backupDir = join(env.lasHome, "backups", stamp(io.now()), def.id, SKILL_FOLDER);
    const r = applySkill(plan, dest, backupDir);
    if (r.backup) {
      res.backups.push(r.backup);
      io.out(`  Backed up the old skill to ${r.backup}`);
    }
    res.skill = "applied";
  } catch (e) {
    res.skill = "failed";
    io.err(`  Could not install the skill: ${(e as Error).message}`);
  }
}

export async function runSetup(opts: SetupOptions, env: Env, install: InstallInfo, io: Io): Promise<SetupResult> {
  const results: ClientResult[] = [];
  let targets: Detected[];
  if (opts.clients.length) {
    const { defs, unknown } = resolveRequested(opts.clients);
    if (unknown.length) {
      io.err(`Unknown client: ${unknown.join(", ")}. Known: ${CLIENTS.map((c) => c.id).join(", ")}`);
      return { results, exitCode: 2 };
    }
    targets = defs.map((d) => describe(d, env));
  } else {
    targets = detectClients(env);
  }

  io.out(`LAS setup (${install.mode === "repo" ? "running from the repository" : "installed package"})`);
  io.out(`Server command: ${[install.entry.command, ...install.entry.args].join(" ")}`);
  if (opts.dryRun) io.out("Dry run: nothing will be written.");
  io.out("");
  if (!targets.length) {
    io.out(`No supported agent found. Looked for: ${CLIENTS.map((c) => c.name).join(", ")}.`);
    io.out("Install one, or name it with --client <name> to create its config anyway.");
    return { results, exitCode: 0 };
  }
  io.out(`Found: ${targets.map((t) => t.def.name).join(", ")}`);

  for (const det of targets) {
    const res: ClientResult = { id: det.def.id, name: det.def.name, server: "skipped", skill: "skipped", settings: "skipped", configPath: det.target.path, backups: [] };
    results.push(res);
    io.out("");
    io.out(`== ${det.def.name} ==`);
    const entry: ServerEntry = det.def.toolTimeoutS ? { ...install.entry, toolTimeoutS: det.def.toolTimeoutS } : install.entry;
    await setupServer(det, entry, opts, env, io, res);
    await setupSettings(det, install, opts, env, io, res);
    if (!opts.noSkill) await setupSkill(det.def, install, opts, env, io, res);
  }

  io.out("");
  io.out("Summary");
  for (const r of results) {
    const def = CLIENTS.find((c) => c.id === r.id);
    io.out(`  ${r.name.padEnd(15)} server: ${r.server.padEnd(9)} skill: ${r.skill.padEnd(9)}${def?.settings ? ` settings: ${r.settings}` : ""}`.trimEnd());
    for (const b of r.backups) io.out(`    backup: ${b}`);
  }
  const changed = results.filter((r) => r.server === "applied" || r.skill === "applied" || r.settings === "applied");
  for (const r of changed) io.out(`  ${r.name}: ${CLIENTS.find((c) => c.id === r.id)?.restart ?? ""}`);
  if (!opts.dryRun) io.out('\nNext: open your agent and say "I want to learn <anything>" (guitar, Spanish, chess, a lab technique).');
  else io.out("\nRe-run without --dry-run to apply.");
  return { results, exitCode: results.some((r) => r.server === "failed" || r.skill === "failed" || r.settings === "failed") ? 1 : 0 };
}
