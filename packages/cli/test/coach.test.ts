import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LasContext } from "@las/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseClaudeJson, type CoachAdapter, type WakeCommand } from "../src/adapters.js";
import { CoachWatcher, coachCommand, type WakeSpawner } from "../src/coach.js";
import type { Notice } from "../src/notify.js";
import { run } from "../src/index.js";

let root: string;
let ctx: LasContext;
let sk: string;
let clock: number;
const T0 = Date.UTC(2026, 9, 13, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
/** a pid that existed and has exited */
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid!;

const fakeAdapters: CoachAdapter[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    resume: (sessionId, summary) => ({ command: "fake-claude", args: ["-p", "--resume", sessionId], stdin: summary }),
    parseResult: parseClaudeJson,
    notify: "push",
    notifyText: "Your coach is waiting in Claude Code",
    verified: true
  },
  { id: "claude-desktop", name: "Claude Desktop", notify: "os", notifyText: "Your coach is waiting in Claude Desktop", verified: false }
];

function harness(opts: { stdout?: string; pending?: boolean } = {}) {
  const spawned: { cmd: WakeCommand; base: string; cwd?: string }[] = [];
  const notices: Notice[] = [];
  const logs: string[] = [];
  const spawnWake: WakeSpawner = (cmd, files) => {
    spawned.push({ cmd, ...files });
    return { done: opts.pending ? new Promise(() => undefined) : Promise.resolve({ status: 0, stdout: opts.stdout ?? JSON.stringify({ type: "result", session_id: "sess-B", is_error: false }) }) };
  };
  const watcher = new CoachWatcher({
    store: ctx.store,
    lasHome: root,
    adapters: fakeAdapters,
    spawnWake,
    notify: async (n) => {
      notices.push(n);
      return "log";
    },
    now: () => new Date(clock),
    log: (l) => logs.push(l)
  });
  return { watcher, spawned, notices, logs, spawnWake };
}

function live(id: string, over: Record<string, unknown> = {}) {
  ctx.store.createLiveSession({ id, enrollmentId: sk, state: "coach-away", client: "claude-code", coachSessionId: "sess-A", coachPid: deadPid() });
  if (Object.keys(over).length) ctx.store.updateLiveSession(id, over);
  return id;
}
const row = (id: string) => ctx.store.getLiveSession(id)!;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "las-coach-"));
  ctx = new LasContext({ dataDir: root, dbPath: join(root, "las.db") });
  const learner = ctx.store.getOrCreateLearner();
  const model = ctx.store.saveSkillModel({ id: "juggling", skill: "juggling", source: "generated" } as never, false);
  sk = ctx.store.createEnrollment(learner.id, model.id).id;
  clock = T0;
});
afterEach(() => {
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

describe("las coach watcher", () => {
  it("wakes a coach-away session once, with a summary on stdin that carries no learner text, and stores the new session id", async () => {
    const id = live("ses_1");
    ctx.store.queueCoachEvent(id, "card.answered", { card: 0, answer: "my private answer" });
    ctx.store.queueCoachEvent(id, "learner.asked", { text: "SECRET question about my knee" });
    ctx.store.queueCoachEvent(id, "learner.hesitated", { seconds: 30 });
    const h = harness();
    const acts = await h.watcher.pass();
    expect(acts).toEqual([{ liveSessionId: id, action: "woke", reason: "resumed in Claude Code" }]);
    expect(h.spawned).toHaveLength(1);
    const { cmd } = h.spawned[0];
    expect(cmd.args).toEqual(["-p", "--resume", "sess-A"]);
    expect(cmd.stdin).toContain("coach_wait");
    expect(cmd.stdin).toContain("card.answered");
    expect(cmd.stdin).toContain("learner.asked");
    expect(cmd.stdin).toContain('"juggling"');
    expect(cmd.stdin).toContain(sk);
    expect(cmd.stdin).not.toContain("learner.hesitated");
    expect(cmd.stdin).not.toMatch(/SECRET|private answer/);
    expect(cmd.args.join(" ")).not.toContain("coach_wait");
    expect(row(id).wakes).toBe(1);
    expect(row(id).lastWakeAt).toBe(iso(T0));

    await h.watcher.settle();
    expect(row(id).coachSessionId).toBe("sess-B");
    expect(readdirSync(h.watcher.wakesDir)).toEqual([]); // bookkeeping cleaned up
    expect(h.logs.join("\n")).not.toMatch(/SECRET|private/);

    // the next pass, right away: inside the interval, nothing happens
    expect((await h.watcher.pass())[0].action).toBe("skipped");
    expect(h.spawned).toHaveLength(1);
  });

  it("respects the minimum interval between wakes, then wakes again", async () => {
    const id = live("ses_2");
    ctx.store.queueCoachEvent(id, "drill.answered", {});
    const h = harness();
    await h.watcher.pass();
    await h.watcher.settle();
    clock = T0 + 119_000;
    await h.watcher.pass();
    expect(h.spawned).toHaveLength(1);
    clock = T0 + 121_000;
    await h.watcher.pass();
    expect(h.spawned).toHaveLength(2);
    expect(h.spawned[1].cmd.args).toContain("sess-B"); // resumes the id the last run reported
    expect(row(id).wakes).toBe(2);
  });

  it("the interval is a setting", async () => {
    ctx.store.setSetting("coach.wakeMinIntervalS", 10);
    const id = live("ses_2b");
    ctx.store.queueCoachEvent(id, "drill.answered", {});
    const h = harness();
    await h.watcher.pass();
    await h.watcher.settle();
    clock = T0 + 11_000;
    await h.watcher.pass();
    expect(h.spawned).toHaveLength(2);
  });

  it("stops at the per-session cap", async () => {
    const id = live("ses_3", { wakes: 5 });
    ctx.store.queueCoachEvent(id, "screen.viewed", {});
    const h = harness();
    expect(await h.watcher.pass()).toEqual([{ liveSessionId: id, action: "skipped", reason: "wake limit reached (5)" }]);
    expect(h.spawned).toHaveLength(0);
    ctx.store.setSetting("coach.wakeMaxPerSession", 6);
    expect((await h.watcher.pass())[0].action).toBe("woke");
  });

  it("never wakes after the coach left on purpose until the learner asks", async () => {
    const id = live("ses_4", { leftOnPurpose: true });
    ctx.store.queueCoachEvent(id, "card.answered", {});
    const h = harness();
    expect((await h.watcher.pass())[0].reason).toMatch(/left on purpose/);
    expect(h.spawned).toHaveLength(0);
    ctx.store.queueCoachEvent(id, "learner.asked", { text: "hello?" });
    expect((await h.watcher.pass())[0].action).toBe("woke");
  });

  it("sends a notification instead of resuming while the LAS process holding the coach is alive", async () => {
    const id = live("ses_5", { coachPid: process.pid });
    ctx.store.queueCoachEvent(id, "card.answered", {});
    const h = harness();
    const [a] = await h.watcher.pass();
    expect(a.action).toBe("notified");
    expect(h.spawned).toHaveLength(0);
    expect(h.notices).toEqual([{ channel: "push", text: "Your coach is waiting in Claude Code", url: `/app/session/${id}`, liveSessionId: id, sk }]);
    expect(row(id).wakes).toBe(1); // a notification counts toward the cap and the interval
    await h.watcher.pass();
    expect(h.notices).toHaveLength(1);
  });

  it("wakes only for learner actions and only when no coach is present", async () => {
    const quiet = live("ses_6");
    ctx.store.queueCoachEvent(quiet, "learner.hesitated", { seconds: 20 });
    ctx.store.queueCoachEvent(quiet, "session.paused", { reason: "learner" });
    const present = live("ses_7");
    ctx.store.updateLiveSession(present, { state: "live", lastWaitAt: iso(T0 - 10_000) });
    ctx.store.queueCoachEvent(present, "card.answered", {});
    const lapsed = live("ses_8");
    ctx.store.updateLiveSession(lapsed, { state: "live", lastWaitAt: iso(T0 - 61_000) });
    ctx.store.queueCoachEvent(lapsed, "card.answered", {});
    // a wait marked open by a process that died is not presence
    const stale = live("ses_9");
    ctx.store.updateLiveSession(stale, { state: "live", waitOpen: true });
    ctx.store.queueCoachEvent(stale, "card.answered", {});
    const ended = live("ses_10");
    ctx.store.updateLiveSession(ended, { state: "ended" });
    ctx.store.queueCoachEvent(ended, "card.answered", {});

    const h = harness();
    const acts = Object.fromEntries((await h.watcher.pass()).map((a) => [a.liveSessionId, a.action]));
    expect(acts).toEqual({ [quiet]: "skipped", [present]: "skipped", [lapsed]: "woke", [stale]: "woke" });
  });

  it("notifies for a client with no headless mode, or with no conversation id", async () => {
    const desk = live("ses_11", { client: "claude-desktop" });
    ctx.store.queueCoachEvent(desk, "card.answered", {});
    const noId = live("ses_12", { coachSessionId: undefined });
    ctx.store.queueCoachEvent(noId, "card.answered", {});
    const h = harness();
    const acts = await h.watcher.pass();
    expect(acts.map((a) => a.action)).toEqual(["notified", "notified"]);
    expect(h.notices.map((n) => [n.channel, n.text]).sort()).toEqual([
      ["os", "Your coach is waiting in Claude Desktop"],
      ["push", "Your coach is waiting in Claude Code"]
    ]);
    expect(h.spawned).toHaveLength(0);
  });

  it("keeps one wake in flight per session, even across watcher processes", async () => {
    const id = live("ses_13", { wakes: 0 });
    ctx.store.queueCoachEvent(id, "card.answered", {});
    const h = harness({ pending: true });
    await h.watcher.pass();
    clock = T0 + 10 * 60_000;
    expect((await h.watcher.pass())[0].reason).toBe("a wake is in flight");
    // another process: the meta file names a live child
    writeFileSync(join(h.watcher.wakesDir, "ses_13.json"), JSON.stringify({ liveSessionId: id, client: "claude-code", pid: process.pid }));
    const other = harness();
    expect((await other.watcher.pass())[0].reason).toBe("a wake is in flight");
    expect(other.spawned).toHaveLength(0);
  });

  it("harvests a wake whose child exited while nobody listened (cron) and stores its session id", async () => {
    const id = live("ses_14");
    const h = harness();
    mkdirSync(h.watcher.wakesDir, { recursive: true });
    const base = join(h.watcher.wakesDir, id);
    writeFileSync(`${base}.json`, JSON.stringify({ liveSessionId: id, client: "claude-code", pid: deadPid() }));
    writeFileSync(`${base}.out`, 'noise\n{"type":"result","session_id":"sess-C","is_error":false}\n');
    writeFileSync(`${base}.in`, "summary");
    await h.watcher.pass();
    expect(row(id).coachSessionId).toBe("sess-C");
    expect(existsSync(`${base}.out`) || existsSync(`${base}.json`) || existsSync(`${base}.in`)).toBe(false);
  });

  it("--once does one pass and returns; the watch loop stops on its signal", async () => {
    const id = live("ses_15");
    ctx.store.queueCoachEvent(id, "card.answered", {});
    const h = harness();
    const logs: string[] = [];
    const notify = async () => "log" as const;
    expect(await coachCommand({ once: true, ctx, adapters: fakeAdapters, spawnWake: h.spawnWake, notify, log: (l) => logs.push(l) })).toBe(0);
    expect(h.spawned).toHaveLength(1);
    const stop = new Promise<void>((r) => setTimeout(r, 50));
    expect(await coachCommand({ once: false, studio: false, intervalS: 1, stop, ctx, adapters: fakeAdapters, spawnWake: h.spawnWake, notify, log: (l) => logs.push(l) })).toBe(0);
    expect(logs.some((l) => l.includes("watching for learner actions"))).toBe(true);
  });

  it("las coach needs --watch or --once", async () => {
    const err: string[] = [];
    const io = { out: () => undefined, err: (l: string) => err.push(l), ask: async () => "", run: () => ({ status: 0, output: "" }), now: () => new Date() };
    expect(await run(["coach"], { io })).toBe(2);
    expect(err.join("\n")).toContain("--watch");
    expect(await run(["coach", "--watch", "--interval", "0"], { io })).toBe(2);
  });
});
