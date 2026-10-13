/** Node helpers shared by the local and container runners: finding binaries and running a step with limits. */
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { performance } from "node:perf_hooks";
import type { StepResult } from "./types.js";

/** Most output kept per stream; the rest is read and dropped so a print loop cannot fill memory. */
export const OUTPUT_CAP = 1_000_000;

export function which(bin: string, path = process.env.PATH ?? ""): string | undefined {
  if (bin.includes("/") || bin.includes("\\")) return bin;
  const exts = process.platform === "win32" ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").map((e) => e.toLowerCase())] : [""];
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, bin + ext);
      try {
        accessSync(p, constants.X_OK);
        if (statSync(p).isFile()) return p;
      } catch {}
    }
  }
  return undefined;
}

let netPrefix: string[] | undefined;
/**
 * Best-effort network isolation for local runs: on Linux, `unshare -n` (or `unshare -r -n` with an
 * unprivileged user namespace) gives the process a network namespace with no interfaces. Detected
 * once; on other systems, or when user namespaces are disabled, it is skipped and the run still
 * gets a minimal environment with offline settings for package managers.
 */
export function networkPrefix(): string[] {
  if (netPrefix) return netPrefix;
  netPrefix = [];
  if (process.platform === "linux" && which("unshare")) {
    for (const args of [["-n"], ["-r", "-n"]]) {
      const r = spawnSync("unshare", [...args, "true"], { stdio: "ignore", timeout: 5000 });
      if (r.status === 0) {
        netPrefix = ["unshare", ...args];
        break;
      }
    }
  }
  return netPrefix;
}

/** Best-effort address-space limit: prlimit on Linux, else `ulimit -v` in a sh wrapper. None on Windows. */
export function memoryPrefix(mb: number): string[] {
  if (process.platform === "win32") return [];
  if (process.platform === "linux" && which("prlimit")) return ["prlimit", `--as=${mb * 1024 * 1024}`];
  return ["sh", "-c", 'ulimit -v "$0" 2>/dev/null; exec "$@"', String(mb * 1024)];
}

class Capped {
  private parts: Buffer[] = [];
  private size = 0;
  constructor(private cap = OUTPUT_CAP) {}
  push(b: Buffer) {
    if (this.size >= this.cap) return;
    const keep = b.subarray(0, this.cap - this.size);
    this.parts.push(keep);
    this.size += keep.length;
  }
  text() {
    return Buffer.concat(this.parts).toString("utf8");
  }
}

export interface ExecOptions {
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
  timeoutS: number;
  merge?: boolean;
}

/** Runs one command, kills its whole process group at the time limit and never rejects. */
export function exec(argv: string[], o: ExecOptions): Promise<StepResult> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const out = new Capped();
    const err = o.merge ? out : new Capped();
    let timedOut = false;
    let settled = false;
    const timer: { id?: ReturnType<typeof setTimeout> } = {};
    const done = (r: Partial<StepResult>) => {
      if (settled) return;
      settled = true;
      if (timer.id) clearTimeout(timer.id);
      resolve({ code: null, signal: null, stdout: out.text(), stderr: o.merge ? "" : err.text(), timedOut, ms: performance.now() - t0, ...r });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd: o.cwd, env: o.env, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      done({ spawnError: (e as Error).message });
      return;
    }
    const kill = () => {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
    };
    timer.id = setTimeout(() => {
      timedOut = true;
      kill();
    }, o.timeoutS * 1000);
    child.stdout?.on("data", (d: Buffer) => out.push(d));
    child.stderr?.on("data", (d: Buffer) => err.push(d));
    child.on("error", (e: NodeJS.ErrnoException) => done({ spawnError: e.code === "ENOENT" ? `${argv[0]} was not found` : e.message }));
    child.on("close", (code, signal) => {
      // children that outlived the main process are stopped too
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }
      done({ code, signal });
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(o.stdin ?? "");
  });
}
