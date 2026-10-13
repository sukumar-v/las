import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ancestry, isWrapper, type ProcInfo } from "./procs.js";

/**
 * `las-agents client-session`: the SessionStart hook `las-agents setup` installs in Claude Code. It reads the hook's
 * JSON from stdin and writes `<LAS_HOME>/clients/<client>/<pid>.json`, keyed by the client's process id, so the LAS
 * server can find its conversation id by walking its own parent processes on `coach_start` (live-coach §4.1;
 * HTTP contract "Client session id file").
 *
 * Which pid is which (verified by running, see adapters.ts finding 2):
 *   - `--pid "$PPID"` in the hook command: `$PPID` is expanded by the `sh -c` Claude Code starts the hook in, so it
 *     is Claude Code's own pid. This is `pid` when given.
 *   - `process.ppid` here: the `sh -c` (or npx) between Claude Code and this process. Recorded as `ppid`.
 *   - Without `--pid` (Windows), `pid` is the first ancestor that isn't a shell or package-runner wrapper.
 *   - `ancestors`: the chain from `ppid` up to and including `pid`, so a reader can match any of them.
 *
 * It must never print to stdout: Claude Code adds a SessionStart hook's stdout to the model's context. It always
 * exits 0 so a problem here never shows as a hook error at session start.
 */

export interface ClientSessionRecord {
  sessionId: string;
  client: string;
  /** the client's own process id */
  pid: number;
  cwd?: string;
  /** ISO time the hook ran */
  at: string;
  /** this subcommand's parent (the hook shell) */
  ppid?: number;
  ancestors?: number[];
  /** SessionStart source: startup, resume, clear, compact, fork */
  source?: string;
  transcriptPath?: string;
}

export const CLIENT_SESSION_MAX_AGE_MS = 24 * 3600 * 1000;
const CLIENT_ID = /^[a-z0-9][a-z0-9-]{0,40}$/;

export function clientsDir(lasHome: string, client?: string): string {
  return client ? join(lasHome, "clients", client) : join(lasHome, "clients");
}

/** Reads all of stdin, or "" for a terminal, a closed pipe or after `timeoutMs`. */
export function readStdin(timeoutMs = 3000): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    let data = "";
    const done = () => {
      clearTimeout(timer);
      process.stdin.removeAllListeners("data");
      process.stdin.pause();
      resolve(data);
    };
    const timer = setTimeout(done, timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.once("end", done);
    process.stdin.once("error", done);
  });
}

/** Deletes session files older than `maxAgeMs`; returns how many went. */
export function pruneClientSessions(dir: string, now: Date, maxAgeMs = CLIENT_SESSION_MAX_AGE_MS): number {
  let removed = 0;
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    const p = join(dir, name);
    try {
      if (now.getTime() - statSync(p).mtimeMs > maxAgeMs) {
        unlinkSync(p);
        removed++;
      }
    } catch {
      /* gone already */
    }
  }
  return removed;
}

export interface WriteClientSessionInput {
  lasHome: string;
  client: string;
  /** the hook's stdin JSON, parsed */
  hook: Record<string, unknown>;
  /** the client's pid from `--pid "$PPID"`, when the shell provided one */
  pid?: number;
  /** this process's parent and its ancestors, nearest first (index 0 is `ppid`) */
  chain: ProcInfo[];
  now: Date;
}

/** Picks the client pid and writes the record. Returns undefined when the hook JSON has no session id. */
export function writeClientSession(input: WriteClientSessionInput): { path: string; record: ClientSessionRecord } | undefined {
  const { hook, chain } = input;
  const sessionId = typeof hook.session_id === "string" ? hook.session_id.trim() : "";
  if (!sessionId || !CLIENT_ID.test(input.client)) return undefined;
  const given = input.pid && Number.isInteger(input.pid) && input.pid > 1 ? input.pid : undefined;
  const pid = given ?? chain.find((p) => !isWrapper(p.name))?.pid ?? chain[0]?.pid;
  if (!pid) return undefined;
  const upTo = chain.findIndex((p) => p.pid === pid);
  // never past the client: a process above it (the terminal's shell) is an ancestor of other sessions too
  const ancestors = upTo >= 0 ? chain.slice(0, upTo + 1).map((p) => p.pid) : [...new Set([chain[0]?.pid, pid].filter((p): p is number => !!p))];
  const record: ClientSessionRecord = {
    sessionId,
    client: input.client,
    pid,
    cwd: typeof hook.cwd === "string" ? hook.cwd : undefined,
    at: input.now.toISOString(),
    ppid: chain[0]?.pid,
    ancestors,
    source: typeof hook.source === "string" ? hook.source : undefined,
    transcriptPath: typeof hook.transcript_path === "string" ? hook.transcript_path : undefined
  };
  const dir = clientsDir(input.lasHome, input.client);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${pid}.json`);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
  pruneClientSessions(dir, input.now);
  return { path, record };
}

/** Every client session file under LAS_HOME, newest first. */
export function listClientSessions(lasHome: string): { client: string; file: string; record: Partial<ClientSessionRecord> }[] {
  const out: { client: string; file: string; record: Partial<ClientSessionRecord>; mtime: number }[] = [];
  let clients: string[] = [];
  try {
    clients = readdirSync(clientsDir(lasHome));
  } catch {
    return [];
  }
  for (const client of clients) {
    let names: string[] = [];
    try {
      names = readdirSync(clientsDir(lasHome, client));
    } catch {
      continue;
    }
    for (const name of names.filter((n) => /^\d+\.json$/.test(n))) {
      const file = join(clientsDir(lasHome, client), name);
      try {
        out.push({ client, file, record: JSON.parse(readFileSync(file, "utf8")), mtime: statSync(file).mtimeMs });
      } catch {
        /* unreadable: skip */
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).map(({ client, file, record }) => ({ client, file, record }));
}

export interface ClientSessionDeps {
  lasHome: string;
  /** the hook JSON; read from stdin when absent */
  stdin?: string;
  /** this process's ancestor chain starting at its parent; read from the OS when absent */
  chain?: ProcInfo[];
  now?: Date;
  /** diagnostics go here (stderr), never to stdout */
  err?: (line: string) => void;
}

/** The subcommand. Always returns 0. */
export async function clientSession(argv: string[], deps: ClientSessionDeps): Promise<number> {
  const err = deps.err ?? (() => undefined);
  try {
    const { values } = parseArgs({ args: argv, options: { client: { type: "string" }, pid: { type: "string" } }, allowPositionals: false, strict: false });
    const client = typeof values.client === "string" && values.client ? values.client : "claude-code";
    const raw = deps.stdin ?? (await readStdin());
    if (!raw.trim()) return 0;
    const hook = JSON.parse(raw) as Record<string, unknown>;
    const pid = typeof values.pid === "string" && /^\d+$/.test(values.pid) ? Number(values.pid) : undefined;
    const chain = deps.chain ?? ancestry(process.ppid, 6);
    const r = writeClientSession({ lasHome: deps.lasHome, client, hook, pid, chain, now: deps.now ?? new Date() });
    if (!r) err("las client-session: no session id in the hook input; nothing written");
  } catch (e) {
    err(`las client-session: ${(e as Error).message}`);
  }
  return 0;
}
