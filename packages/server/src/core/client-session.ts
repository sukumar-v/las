/**
 * Which client conversation this LAS server belongs to (docs/design/live-coach.md §4.1). A SessionStart hook in
 * the client writes `<LAS_HOME>/clients/<client>/<pid>.json` = {sessionId, client, pid, cwd, at}, keyed by the
 * client's own process id. On coach_start the server walks its parent processes and uses the first file whose
 * pid is an ancestor. Best-effort and fast: Linux reads /proc, macOS and other Unixes ask `ps`, Windows asks
 * PowerShell once for the whole process table. Any failure means "not found", never an error.
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ClientSessionFile {
  sessionId: string;
  client: string;
  pid: number;
  cwd?: string;
  at?: string;
}

export type ParentOf = (pid: number) => Promise<number | undefined>;

const MAX_DEPTH = 16;

function run(cmd: string, args: string[], timeoutMs: number): Promise<string | undefined> {
  return new Promise((res) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => res(err ? undefined : String(stdout)));
    } catch {
      res(undefined);
    }
  });
}

/** Linux: field 4 of /proc/<pid>/stat, after the command name in parentheses (which may itself hold spaces or parens). */
export function parentFromProcStat(stat: string): number | undefined {
  const close = stat.lastIndexOf(")");
  if (close < 0) return undefined;
  const ppid = Number(stat.slice(close + 2).split(" ")[1]);
  return Number.isInteger(ppid) && ppid > 0 ? ppid : undefined;
}

const linuxParent: ParentOf = async (pid) => {
  try {
    return parentFromProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return undefined;
  }
};

const psParent: ParentOf = async (pid) => {
  const out = await run("ps", ["-o", "ppid=", "-p", String(pid)], 1500);
  const n = Number(out?.trim());
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

/** Windows: one PowerShell call for the whole table, then lookups in memory. */
function windowsParent(): ParentOf {
  let table: Promise<Map<number, number>> | undefined;
  const load = async () => {
    const out = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress"], 4000);
    const m = new Map<number, number>();
    try {
      const rows = JSON.parse(out ?? "[]") as { ProcessId: number; ParentProcessId: number }[] | { ProcessId: number; ParentProcessId: number };
      for (const r of Array.isArray(rows) ? rows : [rows]) if (r && r.ProcessId) m.set(Number(r.ProcessId), Number(r.ParentProcessId));
    } catch {
      /* not found */
    }
    return m;
  };
  return async (pid) => {
    table ??= load();
    const p = (await table).get(pid);
    return p && p > 0 ? p : undefined;
  };
}

/** The parent-process lookup for this platform. */
export function platformParentOf(platform = process.platform): ParentOf {
  if (platform === "linux" && existsSync("/proc/self/stat")) return linuxParent;
  if (platform === "win32") return windowsParent();
  return psParent;
}

/** Reads every client session file under `<dataDir>/clients` (or one client's folder), by pid. */
export function readClientSessionFiles(dataDir: string, client?: string): Map<number, ClientSessionFile> {
  const out = new Map<number, ClientSessionFile>();
  const root = join(dataDir, "clients");
  if (!existsSync(root)) return out;
  let clients: string[];
  try {
    clients = client ? [client] : readdirSync(root);
  } catch {
    return out;
  }
  for (const c of clients) {
    const dir = join(root, c.replace(/[^\w.-]+/g, "_"));
    if (!existsSync(dir)) continue;
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((f) => /^\d+\.json$/.test(f));
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        const j = JSON.parse(readFileSync(join(dir, f), "utf8")) as Partial<ClientSessionFile>;
        const pid = Number(j.pid ?? f.replace(/\.json$/, ""));
        if (typeof j.sessionId === "string" && j.sessionId && Number.isInteger(pid)) out.set(pid, { sessionId: j.sessionId, client: j.client ?? c, pid, cwd: j.cwd, at: j.at });
      } catch {
        /* a half-written file: skip it */
      }
    }
  }
  return out;
}

/**
 * The client conversation id for this process: the session file of the nearest ancestor process that has one.
 * `client` narrows the search to one client's folder. Undefined when there is none.
 */
export async function discoverClientSession(dataDir: string, opts: { client?: string; pid?: number; parentOf?: ParentOf; maxDepth?: number } = {}): Promise<ClientSessionFile | undefined> {
  const files = readClientSessionFiles(dataDir, opts.client);
  if (!files.size) return undefined;
  const parentOf = opts.parentOf ?? platformParentOf();
  let pid: number | undefined = opts.pid ?? process.pid;
  const seen = new Set<number>();
  for (let depth = 0; pid && depth <= (opts.maxDepth ?? MAX_DEPTH) && !seen.has(pid); depth++) {
    seen.add(pid);
    const f = files.get(pid);
    if (f && (!opts.client || f.client === opts.client)) return f;
    if (pid === 1) break;
    try {
      pid = await parentOf(pid);
    } catch {
      return undefined;
    }
  }
  return undefined;
}
