import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Process-table helpers for the client-session hook and the watcher. No dependencies; every lookup fails soft. */

export interface ProcInfo {
  pid: number;
  ppid?: number;
  name?: string;
}

/** True while `pid` exists (EPERM means it exists but belongs to someone else). */
export function isAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function linuxProc(pid: number): ProcInfo | undefined {
  try {
    // "pid (comm) state ppid ...": comm may hold spaces and parentheses, so split at the last ")"
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const name = stat.slice(stat.indexOf("(") + 1, close);
    const ppid = Number(stat.slice(close + 2).split(" ")[1]);
    return { pid, ppid: Number.isFinite(ppid) ? ppid : undefined, name };
  } catch {
    return undefined;
  }
}

function psProc(pid: number): ProcInfo | undefined {
  const r = spawnSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 });
  const m = /^\s*(\d+)\s+(.*)$/.exec((r.stdout ?? "").trim());
  return m ? { pid, ppid: Number(m[1]), name: m[2].split("/").pop() } : undefined;
}

/** Windows: one PowerShell call lists every process; walking then needs no more calls. */
function windowsTable(): Map<number, ProcInfo> {
  const map = new Map<number, ProcInfo>();
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId),$($_.ParentProcessId),$($_.Name)" }'], {
    encoding: "utf8",
    timeout: 8000,
    windowsHide: true
  });
  for (const line of (r.stdout ?? "").split(/\r?\n/)) {
    const [pid, ppid, ...name] = line.trim().split(",");
    if (pid && ppid) map.set(Number(pid), { pid: Number(pid), ppid: Number(ppid), name: name.join(",") });
  }
  return map;
}

/**
 * The chain of processes from `start` upward (start included), at most `max` long. Stops at pid 1 or when a
 * parent can't be read.
 */
export function ancestry(start: number, max = 8, platform: NodeJS.Platform = process.platform): ProcInfo[] {
  const out: ProcInfo[] = [];
  const table = platform === "win32" ? windowsTable() : undefined;
  const look = (pid: number) => (table ? table.get(pid) : platform === "linux" ? linuxProc(pid) : psProc(pid));
  let pid: number | undefined = start;
  const seen = new Set<number>();
  while (pid && pid > 1 && out.length < max && !seen.has(pid)) {
    seen.add(pid);
    const info: ProcInfo = look(pid) ?? { pid };
    out.push(info);
    pid = info.ppid;
  }
  return out;
}

/** Shells and package-runner wrappers that sit between a client and the hook command it runs. */
const WRAPPER = /^(?:sh|bash|dash|zsh|fish|ksh|ash|cmd|powershell|pwsh|npm|npx|npm exec.*|pnpm|yarn|corepack|env|timeout|tsx)(?:\.exe)?$/i;

export function isWrapper(name: string | undefined): boolean {
  return !!name && WRAPPER.test(name.trim());
}
