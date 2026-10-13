import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COACH_DEFAULTS, WAKE_EVENT_TYPES, type LiveState } from "@las/schema";
import { COACH_ADAPTERS, findAdapter, wakeSummary, type CoachAdapter, type WakeCommand, type WakeResult } from "./adapters.js";
import { listClientSessions } from "./client-session.js";
import { findRepoRoot } from "./commands.js";
import type { Notifier } from "./notify.js";
import { isAlive } from "./procs.js";

/**
 * `las coach --watch` / `--once` (live-coach §4): when the learner acts in the studio and no coach is present, wake
 * the coach's own conversation through its client's adapter, or tell the learner where the coach is waiting.
 *
 * Rules, per live session (each number is a `coach.<name>` setting, COACH_DEFAULTS are the starting values):
 *   - only sessions in `coach-away`, or `live` with the presence window lapsed; only for pending WAKE_EVENT_TYPES;
 *   - at most one wake in flight, one per `wakeMinIntervalS`, `wakeMaxPerSession` in all (a notification counts);
 *   - never after the coach left on purpose until a `learner.asked` is pending;
 *   - never a headless resume while the LAS process holding the coach (`coachPid`) lives: notify instead.
 * Log lines are short, go to stderr and never carry learner text.
 */

/** The live-session row fields the watcher reads (a subset of @las/store's LiveSessionRow). */
export interface WatchRow {
  id: string;
  enrollmentId: string;
  state: LiveState;
  coachSessionId?: string;
  client?: string;
  coachPid?: number;
  lastWaitAt?: string;
  waitOpen: boolean;
  leftOnPurpose: boolean;
  wakes: number;
  lastWakeAt?: string;
}

/** The store methods the watcher uses; `LasContext.store` provides them. */
export interface WatchStore {
  listLiveSessions(opts: { states?: LiveState[] }): WatchRow[];
  getLiveSession(id: string): WatchRow | undefined;
  updateLiveSession(id: string, patch: Partial<Pick<WatchRow, "wakes" | "lastWakeAt" | "coachSessionId">>): unknown;
  /** atomic `wakes + 1`; optional so a plain fake store still works */
  recordLiveSessionWake?(id: string, at?: string): void;
  countPendingCoachEvents(liveSessionId: string, types?: string[]): number;
  pendingCoachEvents(liveSessionId: string, afterId?: number, limit?: number): { type: string }[];
  getSetting<T>(key: string, fallback: T): T;
  getEnrollment(id: string): { skillModelId: string } | undefined;
  getSkillModel(id: string): { skill: string } | undefined;
}

export interface SpawnedWake {
  /** the child's pid, recorded so another watcher process sees the wake as in flight */
  pid?: number;
  /** settles when the child exits, with its stdout */
  done: Promise<{ status: number; stdout: string }>;
}
export type WakeSpawner = (cmd: WakeCommand, files: { base: string; cwd?: string }) => SpawnedWake;

export interface WatchOptions {
  store: WatchStore;
  /** LAS_HOME: wake bookkeeping lives in <lasHome>/coach/wakes, client session files in <lasHome>/clients */
  lasHome: string;
  notify: Notifier;
  adapters?: CoachAdapter[];
  spawnWake?: WakeSpawner;
  isAlive?: (pid: number) => boolean;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface WatchAction {
  liveSessionId: string;
  action: "woke" | "notified" | "skipped";
  reason: string;
}

export const WATCH_POLL_S = 3;
export const STUDIO_RETRY_S = 5;

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : d);

export function coachSetting(store: Pick<WatchStore, "getSetting">, key: keyof typeof COACH_DEFAULTS): number {
  return num(store.getSetting<unknown>(`coach.${key}`, COACH_DEFAULTS[key]), COACH_DEFAULTS[key]);
}

/** present = a coach_wait is open (and its holder lives), or one returned within the presence window */
export function coachPresent(s: WatchRow, now: Date, presenceWindowS: number, alive: (pid: number) => boolean): boolean {
  if (s.waitOpen && (!s.coachPid || alive(s.coachPid))) return true;
  return !!s.lastWaitAt && now.getTime() - Date.parse(s.lastWaitAt) < presenceWindowS * 1000;
}

export class CoachWatcher {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly lastSkip = new Map<string, string>();
  private readonly adapters: CoachAdapter[];
  private readonly alive: (pid: number) => boolean;
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private readonly spawnWake: WakeSpawner;
  readonly wakesDir: string;

  constructor(private readonly o: WatchOptions) {
    this.adapters = o.adapters ?? COACH_ADAPTERS;
    this.alive = o.isAlive ?? isAlive;
    this.now = o.now ?? (() => new Date());
    this.log = o.log ?? ((l) => process.stderr.write(l + "\n"));
    this.spawnWake = o.spawnWake ?? spawnDetached;
    this.wakesDir = join(o.lasHome, "coach", "wakes");
  }

  /** Resolves when every wake this process started has finished (tests; `--once` doesn't wait). */
  async settle(): Promise<void> {
    while (this.inFlight.size) await Promise.all([...this.inFlight.values()]);
  }

  /** One pass over the open live sessions. */
  async pass(): Promise<WatchAction[]> {
    this.harvest();
    const { store } = this.o;
    const now = this.now();
    const presenceWindowS = coachSetting(store, "presenceWindowS");
    const minIntervalS = coachSetting(store, "wakeMinIntervalS");
    const maxWakes = coachSetting(store, "wakeMaxPerSession");
    const out: WatchAction[] = [];
    for (const s of store.listLiveSessions({ states: ["coach-away", "live"] })) {
      const skip = (reason: string, quiet = false): void => {
        out.push({ liveSessionId: s.id, action: "skipped", reason });
        if (!quiet && this.lastSkip.get(s.id) !== reason) this.log(`las coach: ${s.id}: not waking (${reason})`);
        this.lastSkip.set(s.id, reason);
      };
      if (coachPresent(s, now, presenceWindowS, this.alive)) {
        skip("coach present", true);
        continue;
      }
      if (store.countPendingCoachEvents(s.id, [...WAKE_EVENT_TYPES]) === 0) {
        skip("no learner action pending", true);
        continue;
      }
      if (s.leftOnPurpose && store.countPendingCoachEvents(s.id, ["learner.asked"]) === 0) {
        skip("the coach left on purpose; waiting for the learner to ask");
        continue;
      }
      if (this.inFlight.has(s.id) || this.wakeRunningElsewhere(s.id)) {
        skip("a wake is in flight", true);
        continue;
      }
      if (s.wakes >= maxWakes) {
        skip(`wake limit reached (${maxWakes})`);
        continue;
      }
      if (s.lastWakeAt && now.getTime() - Date.parse(s.lastWakeAt) < minIntervalS * 1000) {
        skip("woke less than the minimum interval ago", true);
        continue;
      }
      this.lastSkip.delete(s.id);
      out.push(await this.wake(s, now));
    }
    return out;
  }

  private async wake(s: WatchRow, now: Date): Promise<WatchAction> {
    const { store } = this.o;
    const adapter = findAdapter(s.client, this.adapters);
    // claim the wake first, so a second watcher (cron and --watch together) sees the interval
    if (store.recordLiveSessionWake) store.recordLiveSessionWake(s.id, now.toISOString());
    else store.updateLiveSession(s.id, { wakes: s.wakes + 1, lastWakeAt: now.toISOString() });
    const notify = async (reason: string): Promise<WatchAction> => {
      const via = await this.o.notify({
        channel: adapter?.notify ?? "push",
        text: adapter?.notifyText ?? "Your coach is waiting",
        url: `/app/session/${encodeURIComponent(s.id)}`,
        liveSessionId: s.id,
        sk: s.enrollmentId
      });
      this.log(`las coach: ${s.id}: ${reason}; notified (${via})`);
      return { liveSessionId: s.id, action: "notified", reason };
    };
    if (s.coachPid && this.alive(s.coachPid)) return notify(`the coach's ${adapter?.name ?? "client"} is still open`);
    if (!adapter?.resume) return notify(s.client ? `${adapter?.name ?? s.client} can't be resumed headlessly` : "no client recorded");
    if (!s.coachSessionId) return notify("no conversation id recorded");

    const types = store
      .pendingCoachEvents(s.id, 0, 200)
      .map((e) => e.type)
      .filter((t) => (WAKE_EVENT_TYPES as readonly string[]).includes(t));
    const enrollment = store.getEnrollment(s.enrollmentId);
    const skill = enrollment ? store.getSkillModel(enrollment.skillModelId)?.skill : undefined;
    const cmd = adapter.resume(s.coachSessionId, wakeSummary({ skill, sk: s.enrollmentId, liveSessionId: s.id, eventTypes: types }));
    const cwd = listClientSessions(this.o.lasHome).find((r) => r.record.sessionId === s.coachSessionId)?.record.cwd;
    mkdirSync(this.wakesDir, { recursive: true, mode: 0o700 });
    const base = join(this.wakesDir, safeName(s.id));
    let spawned: SpawnedWake;
    try {
      spawned = this.spawnWake(cmd, { base, cwd: cwd && existsSync(cwd) ? cwd : undefined });
    } catch (e) {
      this.log(`las coach: ${s.id}: could not start ${cmd.command}: ${(e as Error).message}`);
      return notify(`${adapter.name} could not be started`);
    }
    writeFileSync(`${base}.json`, JSON.stringify({ liveSessionId: s.id, client: adapter.id, pid: spawned.pid, at: now.toISOString() }) + "\n", { mode: 0o600 });
    this.log(`las coach: ${s.id}: waking the coach in ${adapter.name} (${types.length} event${types.length === 1 ? "" : "s"})`);
    const task = spawned.done
      .then(({ status, stdout }) => this.finish(s.id, adapter, status, stdout))
      .catch((e) => this.log(`las coach: ${s.id}: wake failed: ${(e as Error).message}`))
      .finally(() => {
        cleanup(base);
        this.inFlight.delete(s.id);
      });
    this.inFlight.set(s.id, task);
    return { liveSessionId: s.id, action: "woke", reason: `resumed in ${adapter.name}` };
  }

  /** After a headless run: keep the client's conversation id if the run reports a different one. */
  private finish(liveSessionId: string, adapter: CoachAdapter, status: number, stdout: string): void {
    const r: WakeResult = adapter.parseResult?.(stdout) ?? {};
    const row = this.o.store.getLiveSession(liveSessionId);
    if (r.sessionId && row && r.sessionId !== row.coachSessionId) {
      this.o.store.updateLiveSession(liveSessionId, { coachSessionId: r.sessionId });
      this.log(`las coach: ${liveSessionId}: ${adapter.name} reported a new conversation id; stored`);
    }
    this.log(`las coach: ${liveSessionId}: ${adapter.name} run ended (${status === 0 && !r.isError ? "ok" : `exit ${status}${r.isError ? ", error result" : ""}`})`);
  }

  /** A wake started by another watcher process whose child still runs. */
  private wakeRunningElsewhere(liveSessionId: string): boolean {
    const meta = readMeta(join(this.wakesDir, `${safeName(liveSessionId)}.json`));
    return !!meta?.pid && this.alive(meta.pid);
  }

  /** Finishes wakes whose child exited while no watcher was listening (`--once` from cron): parse, store, clean. */
  harvest(): void {
    let names: string[] = [];
    try {
      names = readdirSync(this.wakesDir).filter((n) => n.endsWith(".json"));
    } catch {
      return;
    }
    for (const name of names) {
      const base = join(this.wakesDir, name.slice(0, -".json".length));
      const meta = readMeta(`${base}.json`);
      if (!meta?.liveSessionId || this.inFlight.has(meta.liveSessionId)) continue;
      if (meta.pid && this.alive(meta.pid)) continue;
      const adapter = findAdapter(meta.client, this.adapters);
      try {
        const stdout = existsSync(`${base}.out`) ? readFileSync(`${base}.out`, "utf8") : "";
        if (adapter && stdout.trim()) this.finish(meta.liveSessionId, adapter, 0, stdout);
      } catch (e) {
        this.log(`las coach: ${meta.liveSessionId}: could not read the wake result: ${(e as Error).message}`);
      }
      cleanup(base);
    }
  }
}

const safeName = (id: string) => id.replace(/[^A-Za-z0-9_.-]/g, "_");

function readMeta(path: string): { liveSessionId?: string; client?: string; pid?: number } | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function cleanup(base: string): void {
  for (const ext of [".json", ".in", ".out", ".err"]) {
    try {
      unlinkSync(base + ext);
    } catch {
      /* not there */
    }
  }
}

/**
 * Windows: `claude` may be claude.exe or an npm `claude.cmd` shim, and Node can't spawn .cmd files without a shell.
 * Resolve through PATH and PATHEXT and run .cmd/.bat through cmd.exe. Elsewhere spawn the name as is.
 */
export function resolveCommand(cmd: WakeCommand, platform: NodeJS.Platform = process.platform, pathVar = process.env.PATH ?? ""): { command: string; args: string[] } {
  if (platform !== "win32" || extname(cmd.command)) return { command: cmd.command, args: cmd.args };
  const exts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  for (const dir of pathVar.split(";").filter(Boolean)) {
    for (const ext of exts) {
      const file = join(dir, cmd.command + ext.toLowerCase());
      if (!existsSync(file)) continue;
      return /\.(cmd|bat)$/i.test(file) ? { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/c", file, ...cmd.args] } : { command: file, args: cmd.args };
    }
  }
  return { command: cmd.command, args: cmd.args };
}

/**
 * The real spawner: the child is detached so it outlives a `--once` run. Its stdin is a file holding the summary
 * (never argv), its stdout goes to `<base>.out` so a later pass can read the client's session id even when no
 * watcher was listening when it exited.
 */
export const spawnDetached: WakeSpawner = (cmd, files) => {
  writeFileSync(`${files.base}.in`, cmd.stdin ?? "", { mode: 0o600 });
  const fds = [openSync(`${files.base}.in`, "r"), openSync(`${files.base}.out`, "w", 0o600), openSync(`${files.base}.err`, "w", 0o600)];
  const r = resolveCommand(cmd);
  try {
    const child = spawn(r.command, r.args, { detached: true, stdio: fds, cwd: files.cwd, windowsHide: true, env: process.env });
    child.unref();
    const done = new Promise<{ status: number; stdout: string }>((resolve) => {
      const read = () => {
        try {
          return readFileSync(`${files.base}.out`, "utf8");
        } catch {
          return "";
        }
      };
      child.once("error", () => resolve({ status: 127, stdout: "" }));
      child.once("exit", (code) => resolve({ status: code ?? 1, stdout: read() }));
    });
    return { pid: child.pid, done };
  } finally {
    for (const fd of fds) closeSync(fd);
  }
};

// ------------------------------------------------------------------ the command

export interface CoachCommandOptions {
  once: boolean;
  /** seconds between passes */
  intervalS?: number;
  /** serve the studio while the port is free (default true without --once) */
  studio?: boolean;
  /** stop the loop (tests); defaults to SIGINT/SIGTERM */
  stop?: Promise<void>;
  log?: (line: string) => void;
  /** test seams */
  spawnWake?: WakeSpawner;
  notify?: Notifier;
  adapters?: CoachAdapter[];
  ctx?: unknown;
}

/** Waits `ms` or until `stop`. The timer stays referenced: it is what keeps a watcher alive while no studio is served. */
function sleep(ms: number, stop: Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    void stop.then(() => {
      clearTimeout(t);
      resolve();
    });
  });
}

/** `las coach --watch` / `--once`. */
export async function coachCommand(o: CoachCommandOptions): Promise<number> {
  const log = o.log ?? ((l: string) => process.stderr.write(l + "\n"));
  const server = (await import("@las/server")) as typeof import("@las/server");
  const { makeNotifier } = await import("./notify.js");
  const ctx = (o.ctx as InstanceType<typeof server.LasContext> | undefined) ?? new server.LasContext({ studioDist: studioDist() });
  const watcher = new CoachWatcher({
    store: ctx.store,
    lasHome: ctx.config.dataDir,
    notify: o.notify ?? makeNotifier(ctx, log),
    adapters: o.adapters,
    spawnWake: o.spawnWake,
    log
  });
  const ownsCtx = !o.ctx;
  try {
    if (o.once) {
      await watcher.pass();
      return 0;
    }
    const stop =
      o.stop ??
      new Promise<void>((done) => {
        for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => done());
      });
    let stopped = false;
    void stop.then(() => (stopped = true));
    const pollMs = Math.max(1, o.intervalS ?? num(ctx.store.getSetting<unknown>("coach.watchPollS", WATCH_POLL_S), WATCH_POLL_S)) * 1000;
    log(`las coach: watching for learner actions every ${pollMs / 1000} s`);
    let http: { close(): Promise<void> } | undefined;
    let nextStudioTry = 0;
    while (!stopped) {
      if (o.studio !== false && !http && Date.now() >= nextStudioTry) {
        try {
          const h = await server.startHttp(ctx, server.installLoop(ctx));
          http = h;
          log(`las coach: serving the studio at ${h.url}`);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") log(`las coach: studio not started: ${(e as Error).message}`);
          nextStudioTry = Date.now() + STUDIO_RETRY_S * 1000;
        }
      }
      try {
        await watcher.pass();
      } catch (e) {
        log(`las coach: pass failed: ${(e as Error).message}`);
      }
      await sleep(pollMs, stop);
    }
    await http?.close();
    return 0;
  } finally {
    if (ownsCtx) ctx.close();
  }
}

/** The built studio next to a repository checkout, like `las studio`. */
function studioDist(): string | undefined {
  if (process.env.LAS_STUDIO_DIST) return process.env.LAS_STUDIO_DIST;
  const root = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
  const dist = root ? join(root, "packages", "studio", "dist") : undefined;
  return dist && existsSync(join(dist, "index.html")) ? dist : undefined;
}
