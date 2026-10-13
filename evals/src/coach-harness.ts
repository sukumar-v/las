/**
 * The coach-loop harness (docs/design/live-coach.md §16): a scripted learner against a scripted coach, for every
 * scenario's stored skill model, on a fake clock.
 *
 * - The learner acts only through the studio's HTTP API: the live routes (`/api/live/...`), studio events
 *   (`POST /api/events`), drills (`POST /api/drill/:id/next`) and analyses (`POST /api/attempt/:id/analysis`).
 *   An attempt is a synthetic Analysis for the attempt's engine, never media.
 * - The coach talks only through the four coach tools (`coach_start`, `coach_wait`, `coach_show`, `coach_end`)
 *   over an in-memory MCP client. Each policy below runs one live session from `coach_start` to `coach_end`.
 *
 * Everything that happens is recorded in a `CoachRun`; the checks at the bottom read it and, like `harness.ts`,
 * return a list of problems (empty means the check holds). Nothing here knows a skill: the coach's own screens
 * are built from the model's nodes, drills, mistakes and predict cards.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "@las/store";
import { createMcpServer, installLoop, LasContext, setDirectorClock, setMilestone, startHttp, startIntake, type DirectorClock } from "@las/server";
import {
  type AnalysisInput,
  type Capabilities,
  type CoachEndResult,
  type CoachEvent,
  type CoachScreen,
  type CoachShowResult,
  type CoachStartResult,
  type CoachSuggestion,
  type CoachWaitResult,
  type Drill,
  type EngineId,
  type EngineSpec,
  type EvidenceRef,
  type KnowledgeItem,
  type LiveAdvanceResult,
  type LiveView,
  type ScreenKind,
  type ScreenSource,
  type SkillModel
} from "@las/schema";
import { metricsOf } from "./harness.js";

const here = dirname(fileURLToPath(import.meta.url));
export const MODEL_FIXTURES = join(here, "../fixtures/models");

/** The ~2 KB target of §3.2, with headroom. */
export const WAIT_BYTES_LIMIT = 4096;
/** Screens a policy goes through at most before it ends the session itself. */
const MAX_SCREENS = 16;
const KNOWLEDGE_TYPES = new Set(["choice", "match", "order", "hotspot", "predict-output", "fill"]);
/** What the learner's analyses carry that must never reach the coach: a key frame as a data URL and an overlay. */
export const BAIT_FRAME = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk";

// ---------------------------------------------------------------- the fake clock

export interface FakeClock extends DirectorClock {
  advance(ms: number): void;
  ms(): number;
  /** real milliseconds each sleep takes (a tiny yield) */
  realMs: number;
}

/** Director time: a 60 s presence window or a 45 s wait takes a few real milliseconds. */
export function fakeClock(): FakeClock {
  let t = Date.parse(`${new Date().toISOString().slice(0, 10)}T10:00:00Z`);
  const c: FakeClock = {
    realMs: 1,
    now: () => new Date(t),
    ms: () => t,
    advance: (ms) => {
      t += ms;
    },
    sleep: async (ms, signal) => {
      if (signal?.aborted) return;
      t += ms;
      await new Promise((r) => setTimeout(r, c.realMs));
    }
  };
  return c;
}

// ---------------------------------------------------------------- what a run records

export type PolicyName = "follow" | "override" | "quitter" | "leaver" | "essayist";

export interface SessionRecord {
  policy: PolicyName;
  liveSessionId: string;
  start: CoachStartResult;
  end?: CoachEndResult;
  endError?: string;
  /** live_session.state after coach_end */
  finalState?: string;
}

export interface WaitRecord {
  policy: PolicyName;
  liveSessionId: string;
  ack?: string;
  timeoutS: number;
  result: CoachWaitResult;
  /** JSON size of the result the coach reads (structuredContent.data) */
  bytes: number;
  /** JSON size of the whole structuredContent, theme included (for the report) */
  fullBytes: number;
  /** the highest coach_event id in the store when the call began */
  pendingMaxBefore: number;
  /** fake milliseconds the call took */
  clockMs: number;
}

export interface ShowRecord {
  policy: PolicyName;
  liveSessionId: string;
  screen: unknown;
  result: CoachShowResult;
  isError: boolean;
  text: string;
  /** a screen the policy meant to be rejected, and where the validator must point */
  expect?: { what: string; path: string; message?: RegExp };
  /** the coach chose this over the planner's suggestion, with this reason */
  override?: { reason: string; suggested: string };
  /** what reached the studio although the screen was rejected */
  leaked?: string[];
  /** coach.message events the studio got during the call */
  messages: { screenId: string; text: string }[];
}

export interface StudioScreen {
  policy: PolicyName;
  liveSessionId: string;
  id: string;
  kind: ScreenKind;
  source: ScreenSource;
  /** the coach's presence as the studio last heard it (coach.state) */
  coachPresent: boolean;
  /** emitted while coach_end ran (its fallback wrap-up) */
  duringEnd: boolean;
}

export interface AskRecord {
  policy: PolicyName;
  liveSessionId: string;
  text: string;
  whileAway: boolean;
  event?: CoachEvent;
  reply?: ShowRecord;
  /** the message the studio draws right after the reply */
  studioMessage?: string;
}

export interface PainRecord {
  liveSessionId: string;
  capBefore?: number;
  /** the cap the server applied, from the studio event's result */
  applied?: number;
  event?: CoachEvent;
  stateCap?: number;
  hardest?: { id: string; intensity: number };
  above?: ShowRecord;
}

export interface PlanRecord {
  liveSessionId: string;
  screenId: string;
  optionId: string;
  change?: string;
  event?: CoachEvent;
}

export interface LeaveRecord {
  liveSessionId: string;
  message: ShowRecord;
  /** the coach screen queued when it left (it wrote it before saying goodbye) */
  queuedAtLeave?: string;
  view: LiveView;
  after: { id?: string; kind?: ScreenKind; source?: ScreenSource; waiting: boolean }[];
  ended: boolean;
}

export interface RedeliveryRecord {
  liveSessionId: string;
  /** the batch the quitter got and never handled */
  lost: string[];
  ack: string;
  /** what the view said while the quitter was away */
  away: LiveView;
  /** fallback screens the learner went through meanwhile */
  meanwhile: { kind?: ScreenKind; source?: ScreenSource }[];
  returned: string[];
}

export interface HeartbeatRecord {
  liveSessionId: string;
  wait: WaitRecord;
}

export interface AttemptRecord {
  liveSessionId: string;
  attemptId: string;
  drillId: string;
  engine: EngineId;
  qualityOk: boolean;
  mistakes: string[];
}

export interface CoachRun {
  scenario: string;
  sk: string;
  model: SkillModel;
  sessions: SessionRecord[];
  waits: WaitRecord[];
  shows: ShowRecord[];
  studio: StudioScreen[];
  asks: AskRecord[];
  pains: PainRecord[];
  plans: PlanRecord[];
  leaves: LeaveRecord[];
  redeliveries: RedeliveryRecord[];
  heartbeats: HeartbeatRecord[];
  attempts: AttemptRecord[];
  /** read from the store after the run */
  stored: Record<string, { id: number; type: string }[]>;
  plannerLog: Record<string, any[]>;
  planChanges: { reason: string; option: string }[];
  coachScreens: Record<string, { id: string; kind: string; source: string }[]>;
  /** checks that can't apply to this model, and why */
  na: Record<string, string>;
  /** real milliseconds the run took */
  ms: number;
}

// ---------------------------------------------------------------- the rig

let capsOnce: Promise<Capabilities> | undefined;

/** Reads a stored fixture model (`fixtures/models/<id>.json`). */
export function fixtureModel(id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(MODEL_FIXTURES, `${id}.json`), "utf8"));
}

/** A scaffold drill the learner can record: measured by an engine through a validated spec. */
export function measuredDrill(model: SkillModel): Drill | undefined {
  const ok = (d: Drill) => !KNOWLEDGE_TYPES.has(d.type) && !!d.spec && !!model.specs[d.spec] && model.specs[d.spec].kind !== "items" && model.specs[d.spec].kind !== "self-report";
  return model.drills.find((d) => ok(d) && model.mistakes.some((m) => m.fix_drill === d.id)) ?? model.drills.find(ok);
}

/** The first `n` words of a text, for budgets. */
export function clip(text: string, n: number): string {
  return text.split(/\s+/).filter(Boolean).slice(0, n).join(" ");
}

/** Where a synthetic analysis points its evidence, by engine. */
function evidenceFor(engine: EngineId): EvidenceRef {
  switch (engine) {
    case "code":
      return { kind: "line", file: "main", line: 3 };
    case "visual":
      return { kind: "region", x: 0.4, y: 0.4, w: 0.2, h: 0.2 };
    case "game":
      return { kind: "move", ply: 12 };
    case "knowledge":
    case "self-report":
      return { kind: "none" };
    default:
      return { kind: "time", t: 1.2 };
  }
}

/**
 * What an engine would return for an attempt: the spec's own metric names, one mistake the model knows (the
 * drill's, by fix drill), a marker, and bait the server must strip before the coach sees it (a key frame as a data
 * URL and an overlay naming a media ref). Never media bytes.
 */
export function syntheticAnalysis(model: SkillModel, engine: EngineId, spec: EngineSpec | undefined, drill: Drill | undefined, opts: { qualityOk?: boolean; mistake?: boolean } = {}): AnalysisInput {
  const names = spec ? [...metricsOf(spec)].slice(0, 3) : [];
  const mk = opts.mistake === false ? undefined : (model.mistakes.find((m) => m.fix_drill === drill?.id) ?? model.mistakes.find((m) => drill?.fixes?.includes(m.id)) ?? model.mistakes[0]);
  return {
    engine,
    quality: opts.qualityOk === false ? { ok: false, issues: ["too dark"], reRecord: "Too dark to measure. Add light and record again." } : { ok: true, issues: [] },
    metrics: Object.fromEntries(names.map((n, i) => [n, { value: 0.5 + i / 10, unit: "", confidence: 0.92 }])),
    markers: [{ t: 1.2, label: "key moment", role: "attention" }],
    mistakes: mk ? [{ id: mk.id, severity: 2, confidence: 0.95, at: [1.2], evidence: evidenceFor(engine) }] : [],
    keyFrames: [{ t: 1.2, ref: BAIT_FRAME, label: "key moment" }],
    overlay: { frame: BAIT_FRAME, mediaRef: "media://attempt/raw.webm" },
    version: "coach-evals"
  };
}

/** The right answer and a wrong one for a knowledge item, in the shapes the knowledge engine grades. */
export function answersFor(item: KnowledgeItem): { right: unknown; wrong: unknown } {
  switch (item.type) {
    case "choice":
    case "predict-output":
      return { right: item.answer, wrong: (item.answer + 1) % item.options.length };
    case "match":
      return { right: item.pairs, wrong: item.pairs.map((p, i) => [p[0], item.pairs[(i + 1) % item.pairs.length][1]]) };
    case "order":
      return { right: item.items, wrong: [...item.items].reverse() };
    case "fill":
      return { right: item.answers[0], wrong: "not-an-answer" };
    case "hotspot":
      return { right: { x: item.region.x, y: item.region.y }, wrong: { x: item.region.x + item.region.r * 4 + 1, y: item.region.y + item.region.r * 4 + 1 } };
  }
}

export class CoachRig {
  readonly run: CoachRun;
  policy: PolicyName = "follow";
  live = "";
  inEnd = false;
  lastSuggestion?: CoachSuggestion;
  lastState?: CoachWaitResult["state"];
  /** event ids the coach has handled (questions answered once) */
  private handled = new Set<string>();
  private presence = new Map<string, boolean>();
  private onScreen?: string;
  private coachItems = new Map<string, KnowledgeItem[]>();
  /** coach.message events the studio got */
  private messages: { screenId: string; text: string }[] = [];
  private constructor(
    readonly ctx: LasContext,
    readonly clock: FakeClock,
    readonly sk: string,
    readonly model: SkillModel,
    private http: { url: string; close: () => Promise<void> },
    private call: (name: string, args: Record<string, unknown>) => Promise<{ text: string; data: any; isError: boolean }>,
    private closeMcp: () => Promise<void>,
    scenario: string
  ) {
    this.run = { scenario, sk, model, sessions: [], waits: [], shows: [], studio: [], asks: [], pains: [], plans: [], leaves: [], redeliveries: [], heartbeats: [], attempts: [], stored: {}, plannerLog: {}, planChanges: [], coachScreens: {}, na: {}, ms: 0 };
    ctx.listeners.add((e) => {
      const ev = e as { type: string; payload: any };
      if (ev.type === "coach.state") this.presence.set(ev.payload.liveSessionId, !!ev.payload.coachPresent);
      if (ev.type === "coach.screen") {
        const s = ev.payload.screen as CoachScreen;
        this.run.studio.push({ policy: this.policy, liveSessionId: ev.payload.liveSessionId, id: s.id, kind: s.kind, source: s.source, coachPresent: this.presence.get(ev.payload.liveSessionId) ?? false, duringEnd: this.inEnd });
      }
      if (ev.type === "coach.message") this.messages.push({ screenId: ev.payload.message.screenId, text: ev.payload.message.text });
    });
  }

  /** A fresh server for one scenario: the fixture model stored through validate_skill_model, then enrolled. */
  static async create(scenario: string): Promise<CoachRig> {
    const dataDir = mkdtempSync(join(tmpdir(), "las-coach-evals-"));
    const clock = fakeClock();
    const ctx = new LasContext({ dataDir, port: 0, mediaDir: join(dataDir, "media"), modelsDir: join(dataDir, "models"), fontsDir: join(dataDir, "fonts") } as ConstructorParameters<typeof LasContext>[0], new Store(":memory:"));
    setDirectorClock(ctx, clock);
    ctx.store.updateLearner({ timezone: "UTC" });
    // capabilities are detected once per process (detection spawns short processes), like the agent evals
    capsOnce ??= ctx.capabilities(true);
    const caps = await capsOnce;
    ctx.capabilities = async () => structuredClone(caps);
    const server = createMcpServer(ctx);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "coach-evals", version: "0" });
    await server.connect(st);
    await client.connect(ct);
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = (await client.callTool({ name, arguments: args })) as any;
      return { text: ((r.content ?? []) as { text?: string }[]).map((c) => c.text ?? "").join("\n"), data: r.structuredContent, isError: !!r.isError };
    };
    // the stored model, through the same tool the agent evals use
    const v = await call("validate_skill_model", { model: fixtureModel(scenario) });
    if (!v.data?.ok) throw new Error(`${scenario}: the fixture model no longer validates: ${JSON.stringify(v.data?.errors ?? v.text).slice(0, 500)}`);
    const modelId = v.data.stored.id as string;
    // the quickest enrollment, as the server's live-coach tests do: the intake's answers, then the quick milestone
    const intake = await startIntake(ctx, modelId);
    const model = ctx.store.getSkillModel(modelId)!.model;
    const picture = model.pictures[0];
    const access = [...new Set([...(model.access ?? []), ...(picture.access ?? [])])];
    ctx.store.updateIntake(intake.intake.id, { answers: { look: "plain", why: [model.why[0].id], picture: picture.id, fresh: true, placeConfirmed: true, minutes: 180, deadline: "none", aroundDone: true, access } });
    const sk = ((await setMilestone(ctx, intake.intake.id, "quick")) as { sk: string }).sk;
    const http = await startHttp(ctx, installLoop(ctx));
    return new CoachRig(ctx, clock, sk, model, http, call, async () => {
      await client.close();
      await server.close();
    }, scenario);
  }

  async close(): Promise<void> {
    await this.closeMcp();
    await this.http.close();
    this.ctx.close();
  }

  /** The store's view after the run: events, planner log, plan changes, screens. */
  collect(): void {
    for (const s of this.run.sessions) {
      const id = s.liveSessionId;
      this.run.stored[id] = this.ctx.store.db.all("SELECT id, type FROM coach_event WHERE live_session_id = ? ORDER BY id", id).map((r) => ({ id: Number(r.id), type: String(r.type) }));
      this.run.plannerLog[id] = this.ctx.store.db.all("SELECT json FROM planner_log WHERE session_id = ? ORDER BY id", id).map((r) => JSON.parse(String(r.json)));
      this.run.coachScreens[id] = this.ctx.store.listCoachScreens(id).map((r) => ({ id: r.id, kind: r.kind, source: r.source }));
    }
    this.run.planChanges = this.ctx.store.listPlanChanges(this.sk).map((c) => ({ reason: c.reason, option: c.option }));
  }

  private maxEventId(): number {
    return Number((this.ctx.store.db.get("SELECT MAX(id) AS n FROM coach_event WHERE live_session_id = ?", this.live) as { n: number | null } | undefined)?.n ?? 0);
  }

  // -------------------------------------------------------------- the coach (MCP tools only)

  async start(policy: PolicyName): Promise<CoachStartResult> {
    this.policy = policy;
    this.handled.clear();
    this.onScreen = undefined;
    const r = await this.call("coach_start", { sk: this.sk, client: "coach-evals", clientSessionId: `eval-${policy}` });
    if (r.isError) throw new Error(`${policy}: coach_start failed: ${r.text}`);
    const s = r.data.data as CoachStartResult;
    this.live = s.liveSessionId;
    this.lastSuggestion = s.suggestion;
    this.lastState = s.state;
    this.run.sessions.push({ policy, liveSessionId: s.liveSessionId, start: s });
    return s;
  }

  async wait(opts: { timeoutS?: number; ack?: string } = {}): Promise<CoachWaitResult> {
    const timeoutS = opts.timeoutS ?? 3;
    const pendingMaxBefore = this.maxEventId();
    const t0 = this.clock.ms();
    const r = await this.call("coach_wait", { sk: this.sk, timeoutS, ...(opts.ack !== undefined ? { ack: opts.ack } : {}) });
    if (r.isError) throw new Error(`${this.policy}: coach_wait failed: ${r.text}`);
    const result = r.data.data as CoachWaitResult;
    const rec: WaitRecord = { policy: this.policy, liveSessionId: this.live, ack: opts.ack, timeoutS, result, bytes: JSON.stringify(result).length, fullBytes: JSON.stringify(r.data).length, pendingMaxBefore, clockMs: this.clock.ms() - t0 };
    this.run.waits.push(rec);
    if (result.suggestion) this.lastSuggestion = result.suggestion;
    this.lastState = result.state;
    for (const e of result.events) {
      const ask = e.type === "learner.asked" ? this.run.asks.find((a) => a.liveSessionId === this.live && a.text === e.text && !a.event) : undefined;
      if (ask) ask.event = e;
      const pain = e.type === "pain.reported" ? this.run.pains.find((p) => p.liveSessionId === this.live && !p.event) : undefined;
      if (pain) {
        pain.event = e;
        pain.stateCap = result.state.intensityCap;
      }
      const plan = e.type === "plan.chosen" ? this.run.plans.find((p) => p.liveSessionId === this.live && p.screenId === e.screenId) : undefined;
      if (plan) plan.event = e;
    }
    return result;
  }

  /** A quiet wait: nothing is pending, so it comes back as a heartbeat after `timeoutS` of fake time. */
  async quietWait(timeoutS = 2): Promise<CoachWaitResult> {
    const w = await this.wait({ timeoutS });
    this.run.heartbeats.push({ liveSessionId: this.live, wait: this.run.waits[this.run.waits.length - 1] });
    return w;
  }

  async show(screen: unknown, meta: { expect?: ShowRecord["expect"]; override?: ShowRecord["override"] } = {}): Promise<ShowRecord> {
    const rows = this.ctx.store.listCoachScreens(this.live).length;
    const emits = this.run.studio.length;
    const msgs = this.messages.length;
    const queued = (this.ctx.store.getLiveSession(this.live)?.data as { queuedId?: string } | undefined)?.queuedId;
    const r = await this.call("coach_show", { sk: this.sk, screen });
    const result = (r.isError ? r.data : r.data?.data) as CoachShowResult;
    const rec: ShowRecord = { policy: this.policy, liveSessionId: this.live, screen, result, isError: r.isError, text: r.text, ...meta, messages: this.messages.slice(msgs) };
    if (!result?.ok) {
      const leaked: string[] = [];
      if (this.ctx.store.listCoachScreens(this.live).length !== rows) leaked.push("a coach_screen row was stored");
      if (this.run.studio.length !== emits) leaked.push("the studio was sent a screen");
      if (this.messages.length !== msgs) leaked.push("the studio was sent a message");
      if ((this.ctx.store.getLiveSession(this.live)?.data as { queuedId?: string } | undefined)?.queuedId !== queued) leaked.push("the queued screen changed");
      rec.leaked = leaked;
    } else if (typeof screen === "object" && screen && Array.isArray((screen as { items?: unknown }).items) && result.screenId) {
      this.coachItems.set(`coach.${result.screenId}`.toLowerCase(), (screen as { items: KnowledgeItem[] }).items);
    }
    this.run.shows.push(rec);
    return rec;
  }

  async end(): Promise<void> {
    const s = this.run.sessions[this.run.sessions.length - 1];
    this.inEnd = true;
    try {
      const r = await this.call("coach_end", { sk: this.sk });
      if (r.isError) s.endError = r.text;
      else s.end = r.data.data as CoachEndResult;
    } finally {
      this.inEnd = false;
    }
    s.finalState = this.ctx.store.getLiveSession(s.liveSessionId)?.state;
  }

  /** Answers every question it hasn't answered yet with a short message, and checks the studio drew it at once. */
  async answerQuestions(w: CoachWaitResult): Promise<void> {
    for (const e of w.events) {
      if (e.type !== "learner.asked" || this.handled.has(e.id)) continue;
      this.handled.add(e.id);
      const reply = await this.show({ kind: "message", text: "Short answer: watch the next screen, it shows exactly that.", replyTo: e.id });
      const ask = this.run.asks.find((a) => a.event?.id === e.id);
      if (ask) {
        ask.reply = reply;
        ask.studioMessage = (await this.view()).message?.text;
      }
    }
  }

  /** The follow coach's turn: wait, answer questions, queue the planner's suggestion if nothing is queued. */
  async followTurn(): Promise<CoachWaitResult> {
    const w = await this.wait();
    await this.answerQuestions(w);
    // nothing left to suggest once the wrap-up is on screen
    if (w.state.state !== "ended" && !w.state.queued && w.suggestion) await this.show("suggested");
    return w;
  }

  /** A last wait before coach_end, so everything queued is delivered (a heartbeat if nothing is). */
  async drain(): Promise<CoachWaitResult> {
    const w = await this.wait({ timeoutS: 1 });
    await this.answerQuestions(w);
    return w;
  }

  // -------------------------------------------------------------- the learner (studio HTTP API only)

  private async req(method: string, path: string, body?: unknown): Promise<any> {
    const r = await fetch(this.http.url + path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } });
    const json = (await r.json()) as any;
    if (r.status !== 200 || json?.ok === false) throw new Error(`${method} ${path} → ${r.status}: ${JSON.stringify(json).slice(0, 400)}`);
    return json;
  }

  async event(e: Record<string, unknown>): Promise<any> {
    return (await this.req("POST", "/api/events", e)).result;
  }

  /** The studio opens (or re-reads) the live session. */
  async view(): Promise<LiveView> {
    return this.req("GET", `/api/live/${this.live}`);
  }

  async advance(screenId: string | undefined, seconds = 30): Promise<LiveAdvanceResult> {
    return this.req("POST", `/api/live/${this.live}/advance`, { screenId, seconds });
  }

  async ask(text: string): Promise<void> {
    this.run.asks.push({ policy: this.policy, liveSessionId: this.live, text, whileAway: !(this.presence.get(this.live) ?? false) });
    await this.event({ type: "learner.asked", sessionId: this.live, screenId: this.onScreen, text });
  }

  async hesitate(): Promise<void> {
    if (this.onScreen) await this.event({ type: "learner.hesitated", sessionId: this.live, screenId: this.onScreen, seconds: 20 });
  }

  async pain(level: number): Promise<PainRecord> {
    const rec: PainRecord = { liveSessionId: this.live, capBefore: this.lastState?.intensityCap };
    this.run.pains.push(rec);
    const r = await this.event({ type: "pain.reported", sk: this.sk, area: "lower back", level });
    rec.applied = r?.cap;
    return rec;
  }

  /** Views a screen and does what it asks: answers cards (wrong first, then right), drill items, records attempts, taps a plan. */
  async act(screen: CoachScreen): Promise<void> {
    const previous = this.onScreen && this.onScreen !== screen.id ? { screenId: this.onScreen, seconds: 30 } : undefined;
    await this.event({ type: "screen.viewed", sessionId: this.live, screenId: screen.id, ...(previous ? { previous } : {}) });
    this.onScreen = screen.id;
    const item = screen.item as any;
    switch (item.type) {
      case "lesson": {
        let right = false;
        for (const [i, c] of (item.cards as any[]).entries()) {
          if (c.type === "predict") {
            const answer = right ? c.answer : (c.answer + 1) % c.options.length;
            await this.event({ type: "card.answered", sessionId: this.live, screenId: screen.id, card: i, cardType: c.type, answer, correct: right, seconds: 4 });
            right = !right;
          } else if (c.type === "compare" && c.answer) {
            await this.event({ type: "card.answered", sessionId: this.live, screenId: screen.id, card: i, cardType: c.type, answer: c.answer, correct: true, seconds: 5 });
          }
        }
        break;
      }
      case "drill":
        await this.doDrill(item.drill as Drill);
        break;
      case "capture":
        await this.analyze(item.attemptSpecId, item.drillId);
        break;
      case "plan": {
        const opt = item.options[0];
        const r = await this.event({ type: "plan.chosen", sessionId: this.live, screenId: screen.id, optionId: opt.id });
        this.run.plans.push({ liveSessionId: this.live, screenId: screen.id, optionId: opt.id, change: r?.change });
        break;
      }
    }
  }

  /** A drill screen: knowledge items one by one (one wrong, then right), or a take of a measured drill. */
  async doDrill(drill: Drill): Promise<void> {
    let step = await this.req("POST", `/api/drill/${drill.id}/next`, { sk: this.sk, sessionId: this.live });
    if (step.kind === "capture") {
      await this.analyze(step.attemptId, drill.id);
      return;
    }
    const pool = this.coachItems.get(drill.id) ?? (drill.spec ? ((this.model.specs[drill.spec] as { items?: KnowledgeItem[] }).items ?? []) : []);
    const all = [...pool, ...Object.values(this.model.specs).flatMap((s) => ((s as { items?: KnowledgeItem[] }).items ?? []))];
    let first = true;
    for (let i = 0; i < 12 && !step.done && step.item; i++) {
      const it = all.find((x) => x.id === step.item.id);
      if (!it) throw new Error(`no key for item "${step.item.id}" of drill "${drill.id}"`);
      const a = answersFor(it);
      step = await this.req("POST", `/api/drill/${drill.id}/next`, { sk: this.sk, sessionId: this.live, answer: { itemId: it.id, answer: first ? a.wrong : a.right } });
      first = false;
    }
  }

  /** Records a take of a measured drill (POST /api/drill/:id/next makes the attempt) and posts its analysis. */
  async recordTake(drill: Drill, opts: { qualityOk?: boolean; mistake?: boolean } = {}): Promise<AttemptRecord | undefined> {
    const step = await this.req("POST", `/api/drill/${drill.id}/next`, { sk: this.sk, sessionId: this.live });
    if (step.kind !== "capture") return undefined;
    return this.analyze(step.attemptId, drill.id, opts);
  }

  /** The studio's analysis of an attempt: read the attempt (engine, spec), post a synthetic Analysis. */
  async analyze(attemptId: string, drillId: string | undefined, opts: { qualityOk?: boolean; mistake?: boolean } = {}): Promise<AttemptRecord> {
    const info = await this.req("GET", `/api/attempt/${attemptId}`);
    const engine = info.attempt.engine as EngineId;
    const drill = this.model.drills.find((d) => d.id === (drillId ?? info.attempt.drillId));
    const analysis = syntheticAnalysis(this.model, engine, info.spec ?? undefined, drill, opts);
    await this.req("POST", `/api/attempt/${attemptId}/analysis`, { analysis });
    const rec: AttemptRecord = { liveSessionId: this.live, attemptId, drillId: drill?.id ?? "", engine, qualityOk: opts.qualityOk !== false, mistakes: analysis.mistakes?.map((m) => m.id) ?? [] };
    this.run.attempts.push(rec);
    return rec;
  }
}

// ---------------------------------------------------------------- the coach's own screens (built from the model)

type Sug = CoachSuggestion | undefined;

const sugNodes = (s: Sug): string[] => (!s ? [] : s.item.type === "lesson" ? s.item.nodes : s.item.type === "drill" ? s.item.drill.nodes : []);
const describe = (s: Sug) => (!s ? "nothing" : s.item.type === "lesson" ? `lesson on ${s.item.nodes.join(", ")}` : s.item.type === "drill" ? `drill ${s.item.drill.id}` : s.item.type);

/** A node the suggestion doesn't cover, so the coach's screen is a real override. */
function otherNode(model: SkillModel, s: Sug) {
  const taken = new Set(sugNodes(s));
  return model.nodes.find((n) => !taken.has(n.id)) ?? model.nodes[0];
}

/** A lesson in the coach's words: a prediction between two of the model's nodes, then a mechanism card. */
export function ownLesson(model: SkillModel, nodeId: string, reason: string) {
  const node = model.nodes.find((n) => n.id === nodeId)!;
  const other = model.nodes.find((n) => n.id !== nodeId) ?? node;
  return {
    kind: "lesson",
    title: node.name.slice(0, 60),
    nodes: [node.id],
    cards: [
      { type: "predict", text: "Which of these do we work on first today?", options: [clip(node.name, 6).slice(0, 60), clip(other.name, 6).slice(0, 60)], answer: 0 },
      { type: "mechanism", text: "Small, slow repetitions first; speed comes after the shape is right.", concept: node.name.slice(0, 80) }
    ],
    reason
  };
}

/** A knowledge drill with the coach's own items: the model's predict cards, asked again as a quick check. */
export function ownDrill(model: SkillModel, nodeId: string, reason: string) {
  const cards = model.lessons.flatMap((l) => l.cards).filter((c): c is Extract<typeof c, { type: "predict" }> => c.type === "predict");
  const items = cards.slice(0, 3).map((c, i) => ({ type: "choice", id: `eval-check-${i}`, prompt: c.text.slice(0, 200), options: c.options.map((o) => o.slice(0, 80)), answer: c.answer }));
  return { kind: "drill", type: "choice", title: "Quick check", nodes: [nodeId], prompt: "Pick the best answer for each.", items, reason };
}

/** Feedback from the analysis the coach just got: its top mistake, else a measured metric, else a marker. */
function ownFeedback(model: SkillModel, e: Extract<CoachEvent, { type: "attempt.analyzed" }>) {
  const mk = e.top?.mistakeId ?? e.analysis.mistakes.find((m) => m.confidence >= 0.7)?.id;
  const metric = Object.entries(e.analysis.metrics).find(([, m]) => m.confidence >= 0.7)?.[0];
  const name = mk ? (model.mistakes.find((m) => m.id === mk)?.name ?? mk) : "that take";
  const evidence = mk ? { kind: "mistake", mistakeId: mk } : metric ? { kind: "metric", metricId: metric } : { kind: "marker", index: 0 };
  return { kind: "feedback", attemptId: e.attemptId, headline: clip(`One fix: ${name}`, 8), evidence, praise: "Steady effort on that take", reason: "Feedback on the take you just did" };
}

const PLAN_SCREEN = {
  kind: "plan",
  question: "Sessions keep running short. Add an hour a week?",
  reason: "Practice time looks tight for this milestone",
  options: [
    { id: "more", label: "Add an hour a week", action: { kind: "reschedule", minutesPerWeek: 240 } },
    { id: "keep", label: "Keep it as it is", action: { kind: "replan", option: "keep" } }
  ]
};

// ---------------------------------------------------------------- policies (one live session each)

export type Policy = (r: CoachRig) => Promise<void>;

/** Learner and coach take turns through the session; the coach's turn is `turn`. */
async function walk(r: CoachRig, turn: () => Promise<unknown>, opts: { maxScreens?: number; stopAt?: ScreenKind; onScreen?: (i: number) => Promise<void> } = {}): Promise<void> {
  for (let i = 0; i < (opts.maxScreens ?? MAX_SCREENS); i++) {
    const v = await r.view();
    if (v.state === "ended" || (opts.stopAt && v.screen?.kind === opts.stopAt)) return;
    if (!v.screen) {
      await turn();
      continue;
    }
    await r.act(v.screen);
    await opts.onScreen?.(i);
    await turn();
    const a = await r.advance(v.screen.id);
    if (a.view.state === "ended") return;
    if (a.waiting) await turn();
  }
}

/** follow: always shows the planner's suggestion (coach_show "suggested") and answers questions; the learner finishes the wrap-up. */
export const follow: Policy = async (r) => {
  await r.start("follow");
  await r.show("suggested");
  await r.view();
  await r.quietWait();
  await walk(r, () => r.followTurn(), {
    onScreen: async (i) => {
      if (i === 0) await r.ask("Why does this part matter so much?");
      if (i === 1) await r.hesitate();
    }
  });
  await r.drain();
  await r.end();
};

/** override: writes its own lesson, drill, feedback, plan and wrap-up, each within budget and with a reason. */
export const override: Policy = async (r) => {
  const s = await r.start("override");
  const node = otherNode(r.model, s.suggestion);
  const meta = (kind: string, nodes: string[], reason: string) => {
    const sug = r.lastSuggestion;
    const differs = kind === "lesson" ? sug?.item.type !== "lesson" || !nodes.some((n) => sugNodes(sug).includes(n)) : kind === "drill" ? sug?.item.type !== "drill" || !nodes.some((n) => sugNodes(sug).includes(n)) : sug?.item.type !== kind;
    return differs ? { override: { reason, suggested: describe(sug) } } : {};
  };
  const lessonReason = "They know the planned topic; this node is the gap";
  await r.show(ownLesson(r.model, node.id, lessonReason), meta("lesson", [node.id], lessonReason));
  let v = await r.view();
  // the warm-up (the director's) comes first; the coach's lesson shows after it
  for (let i = 0; i < 3 && v.screen && v.screen.source !== "coach"; i++) {
    await r.act(v.screen);
    await r.wait();
    const a = await r.advance(v.screen.id);
    v = a.view;
  }
  if (v.screen) await r.act(v.screen);
  await r.wait();
  const drillReason = "A quick check before more practice";
  await r.show(ownDrill(r.model, node.id, drillReason), meta("drill", [node.id], drillReason));
  let a = await r.advance(v.screen?.id);
  if (a.screen) await r.act(a.screen);
  let w = await r.wait();
  const measured = measuredDrill(r.model);
  if (measured) {
    await r.recordTake(measured);
    w = await r.wait();
    const ev = w.events.find((e): e is Extract<CoachEvent, { type: "attempt.analyzed" }> => e.type === "attempt.analyzed");
    if (ev) {
      await r.show(ownFeedback(r.model, ev));
      a = await r.advance(a.screen?.id);
      if (a.screen) await r.act(a.screen);
      await r.wait();
    }
  }
  await r.show(PLAN_SCREEN);
  a = await r.advance(a.screen?.id);
  if (a.screen) await r.act(a.screen);
  await r.wait();
  const wrapReason = "Ending on a win while it's fresh";
  await r.show({ kind: "wrapup", praise: "Good focus today", oneFix: clip(r.model.mistakes[0]?.name ?? "Slow down", 8), nextNote: "Next time: more of the same, a little faster.", reason: wrapReason }, meta("wrapup", [], wrapReason));
  a = await r.advance(a.screen?.id);
  if (a.screen) {
    await r.act(a.screen);
    a = await r.advance(a.screen.id);
  }
  await r.drain();
  await r.end();
};

/**
 * quitter: coaches `n` screens, gets one more batch and stops calling (its last turn queues nothing); the learner
 * carries on with the fallback while it's away; it comes back with `ack` naming the last event it handled.
 */
export function quitter(n = 1): Policy {
  return async (r) => {
    await r.start("quitter");
    let v = await r.view();
    // no warm-up: the coach's first screen shows at once
    if (!v.screen) {
      await r.show("suggested");
      v = await r.view();
    }
    await walk(r, () => r.followTurn(), { maxScreens: n - 1, stopAt: "wrapup" });
    // one more batch, never handled: the quitter stops here
    const before = r.run.waits.filter((w) => w.liveSessionId === r.live && w.result.events.length);
    const lastHandled = before.length ? before[before.length - 1].result.events.at(-1)!.id : "0";
    v = await r.view();
    if (v.screen) await r.act(v.screen);
    const lost = await r.wait();
    // the coach is gone longer than the presence window
    r.clock.advance((60 + 1) * 1000);
    const away = await r.view();
    const meanwhile: RedeliveryRecord["meanwhile"] = [];
    let cur = away.screen;
    // never past the wrap-up: the quitter comes back to a session that's still open
    for (let i = 0; i < 3 && cur && cur.kind !== "wrapup"; i++) {
      const a = await r.advance(cur.id);
      if (a.view.state === "ended" || !a.screen) break;
      cur = a.screen;
      meanwhile.push({ kind: cur.kind, source: cur.source });
      await r.act(cur);
    }
    await r.ask("Am I doing this right?");
    // back: it says what it last handled, so the lost batch comes again with everything since
    const back = await r.wait({ ack: lastHandled });
    r.run.redeliveries.push({ liveSessionId: r.live, lost: lost.events.map((e) => e.id), ack: lastHandled, away, meanwhile, returned: back.events.map((e) => e.id) });
    await r.answerQuestions(back);
    await r.drain();
    await r.end();
  };
}

/** leaver: coaches the first screen, then says it's leaving (`leaving: true`); the learner finishes on the fallback. */
export const leaver: Policy = async (r) => {
  await r.start("leaver");
  await r.show("suggested");
  const v = await r.view();
  if (v.screen) await r.act(v.screen);
  // it leaves with nothing queued, so every later screen is the fallback's
  await r.wait();
  const message = await r.show({ kind: "message", text: "I have to go now. The app carries on with you from here.", leaving: true });
  const view = await r.view();
  const rec: LeaveRecord = { liveSessionId: r.live, message, view, queuedAtLeave: view.queued?.source === "coach" ? view.queued.id : undefined, after: [], ended: false };
  r.run.leaves.push(rec);
  let cur = view.screen;
  for (let i = 0; i < MAX_SCREENS && cur; i++) {
    const a = await r.advance(cur.id);
    if (a.view.state === "ended") {
      rec.ended = true;
      break;
    }
    rec.after.push({ id: a.screen?.id, kind: a.screen?.kind, source: a.screen?.source, waiting: !!a.waiting });
    cur = a.screen;
    if (cur) await r.act(cur);
  }
  await r.end();
};

/** essayist: tries every screen the validator must refuse, then pain, a drill above the new cap, pause and resume. */
export const essayist: Policy = async (r) => {
  await r.start("essayist");
  // a valid first screen, so the learner is never left waiting while the coach misbehaves
  await r.show("suggested");
  const v = await r.view();
  if (v.screen) await r.act(v.screen);
  let w = await r.wait();
  const node = r.model.nodes[0].id;
  const essay = "Before you start you should know that this skill has a long history and many schools, and every teacher explains it differently, so read all of this carefully and remember every single detail of it now.";
  // 40 short words: over the 25-word budget, under the 240-character field
  const forty = Array.from({ length: 40 }, (_, i) => ["so", "keep", "on", "and", "go"][i % 5]).join(" ");
  await r.show({ kind: "lesson", title: "Background", nodes: [node], cards: [{ type: "mechanism", text: essay, concept: "history" }] }, { expect: { what: "an essay card", path: "cards[0]", message: /a card has at most 25/ } });
  await r.show({ kind: "lesson", title: "Background", nodes: [node], cards: [{ type: "essay", text: "Read this." }] }, { expect: { what: "an unknown card type", path: "cards[0].type", message: /unknown card type "essay"/ } });
  await r.show({ kind: "drill", type: "move", title: "New drill", nodes: [node], spec: { kind: "metric", metrics: { made_up_score: "max(angle(left_hip, left_knee, left_ankle))" } }, reason: "Measure something new" }, { expect: { what: "a made-up metric spec", path: "spec", message: /can't be written live/ } });
  await r.show({ kind: "message", text: forty }, { expect: { what: "a 40-word message", path: "text", message: /at most 25/ } });
  const measured = measuredDrill(r.model);
  if (measured) {
    const dark = await r.recordTake(measured, { qualityOk: false });
    const clean = await r.recordTake(measured, { mistake: false });
    w = await r.wait();
    const cite = r.model.mistakes.find((m) => m.fix_drill === measured.id)?.id ?? r.model.mistakes[0].id;
    if (dark) await r.show({ kind: "feedback", attemptId: dark.attemptId, headline: "Go a little deeper", evidence: { kind: "mistake", mistakeId: cite } }, { expect: { what: "feedback on a quality-failed analysis", path: "attemptId", message: /re-record, not feedback/ } });
    if (clean) await r.show({ kind: "feedback", attemptId: clean.attemptId, headline: "Go a little deeper", evidence: { kind: "mistake", mistakeId: cite } }, { expect: { what: "feedback citing a missing mistake", path: "evidence.mistakeId", message: /has no mistake/ } });
  } else r.run.na.feedbackChecks = `"${r.model.name}" has no drill measured by an engine, so there's no attempt to give feedback on`;
  // pain lowers the cap; the hardest drill is now above it
  const pain = await r.pain(4);
  w = await r.wait();
  const cap = w.state.intensityCap ?? pain.applied ?? 5;
  const hardest = [...r.model.drills].sort((a, b) => b.intensity - a.intensity)[0];
  pain.hardest = { id: hardest.id, intensity: hardest.intensity };
  if (hardest.intensity > cap) pain.above = await r.show({ kind: "drill", drillId: hardest.id, reason: "Push the pace a little" }, { expect: { what: "a drill above the intensity cap", path: "drillId", message: new RegExp(`the cap now is ${cap}`) } });
  else r.run.na.painLowersCap = `no drill is above the lowered cap (${cap}); the hardest, "${hardest.id}", is intensity ${hardest.intensity}`;
  await r.show({ kind: "message", text: "Let's stop here and rest. If it keeps hurting, see a professional." });
  // pause and resume
  await r.event({ type: "session.paused", sessionId: r.live, reason: "learner" });
  r.clock.advance(30_000);
  await r.event({ type: "session.resumed", sessionId: r.live, pausedSeconds: 30 });
  await r.drain();
  await r.end();
};

export const POLICIES: { name: PolicyName; run: Policy }[] = [
  { name: "follow", run: follow },
  { name: "override", run: override },
  { name: "quitter", run: quitter() },
  { name: "leaver", run: leaver },
  // last: pain lowers intensity for 7 days
  { name: "essayist", run: essayist }
];

/** Every policy against one scenario's model, one live session each, then the store's view of it. */
export async function runCoachLoop(scenario: string, policies = POLICIES): Promise<CoachRun> {
  const t0 = Date.now();
  const r = await CoachRig.create(scenario);
  try {
    for (const p of policies) await p.run(r);
    r.collect();
  } finally {
    await r.close();
  }
  r.run.ms = Date.now() - t0;
  return r.run;
}

// ---------------------------------------------------------------- checks

const DIRECTOR_OWNED: ScreenKind[] = ["warmup", "recall", "pause"];

/** Every policy's session ran from coach_start to coach_end, and coach_end returned the summary of that session. */
export function loopCompleted(run: CoachRun, policies: PolicyName[] = POLICIES.map((p) => p.name)): string[] {
  const p: string[] = [];
  for (const name of policies) if (!run.sessions.some((s) => s.policy === name)) p.push(`${name}: never started`);
  for (const s of run.sessions) {
    if (s.endError) p.push(`${s.policy}: coach_end failed: ${s.endError.slice(0, 200)}`);
    else if (!s.end) p.push(`${s.policy}: coach_end was never called`);
    else if (s.end.summary?.sessionId !== s.liveSessionId) p.push(`${s.policy}: coach_end's summary is for ${s.end.summary?.sessionId}, not ${s.liveSessionId}`);
    else if (!s.end.summary.next?.title) p.push(`${s.policy}: the summary has no next session`);
    if (s.finalState !== "ended") p.push(`${s.policy}: the live session is ${s.finalState} after coach_end`);
  }
  return p;
}

/** Screens the studio got: the coach's while it was present, the fallback's only while it was away. */
export function screensFromCoachWhilePresent(run: CoachRun): string[] {
  const p: string[] = [];
  const okIds = new Set(run.shows.filter((s) => s.result?.ok && s.result.screenId).map((s) => s.result.screenId!));
  for (const s of run.studio) {
    if (s.source === "coach" && !okIds.has(s.id)) p.push(`${s.policy}: the studio got coach screen ${s.id} (${s.kind}) that no accepted coach_show made`);
    if (s.source === "fallback" && s.coachPresent && !DIRECTOR_OWNED.includes(s.kind) && !(s.duringEnd && s.kind === "wrapup")) p.push(`${s.policy}: a fallback ${s.kind} (${s.id}) was shown while the coach was present`);
  }
  if (!run.studio.some((s) => s.source === "coach")) p.push("the studio never got a coach screen");
  if (!run.studio.some((s) => s.source === "fallback" && !s.coachPresent && !DIRECTOR_OWNED.includes(s.kind))) p.push("the studio never got a fallback screen while the coach was away");
  return p;
}

/** Every coach_show was validated: accepted ones were stored as coach screens; refused ones name the path, and nothing reached the studio. */
export function showsValidated(run: CoachRun): string[] {
  const p: string[] = [];
  for (const s of run.shows) {
    const label = `${s.policy}: ${s.expect?.what ?? (typeof s.screen === "string" ? s.screen : (s.screen as { kind?: string })?.kind)}`;
    const r = s.result;
    if (!r || typeof r.ok !== "boolean" || !Array.isArray(r.errors)) {
      p.push(`${label}: coach_show returned no {ok, errors}: ${s.text.slice(0, 200)}`);
      continue;
    }
    if (r.ok) {
      if (s.expect) p.push(`${label}: accepted; it should be refused at ${s.expect.path}`);
      if (!r.screenId) p.push(`${label}: accepted without a screen id`);
      // a queued screen a newer coach_show replaced is deleted, so only what the studio drew must still be stored
      else if (run.studio.some((x) => x.id === r.screenId) && !(run.coachScreens[s.liveSessionId] ?? []).some((x) => x.id === r.screenId && x.source === "coach")) p.push(`${label}: shown but not stored as a coach screen`);
      if (r.errors.length) p.push(`${label}: accepted with errors ${JSON.stringify(r.errors)}`);
      continue;
    }
    if (!r.errors.length || r.errors.some((e) => !e.path || !e.message)) p.push(`${label}: refused without errors naming the path: ${JSON.stringify(r.errors)}`);
    if (!s.isError) p.push(`${label}: refused but not reported as a tool error`);
    if (!s.expect) p.push(`${label}: refused: ${r.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`);
    else {
      const hit = r.errors.find((e) => e.path === s.expect!.path);
      if (!hit) p.push(`${label}: refused, but no error at ${s.expect.path} (got ${r.errors.map((e) => e.path).join(", ")})`);
      else if (s.expect.message && !s.expect.message.test(hit.message)) p.push(`${label}: the error at ${s.expect.path} says "${hit.message}"`);
    }
    if (s.leaked?.length) p.push(`${label}: refused, yet ${s.leaked.join(" and ")}`);
  }
  if (!run.shows.some((s) => s.expect)) p.push("no screen was meant to be refused");
  return p;
}

/** Each override is in the planner log with by: "coach", the coach's reason and the screen it chose. */
export function overridesLogged(run: CoachRun): string[] {
  const p: string[] = [];
  const overrides = run.shows.filter((s) => s.override);
  if (!overrides.length) p.push("the override coach never overrode the planner");
  for (const s of overrides) {
    if (!s.result?.ok) {
      p.push(`override (${(s.screen as { kind?: string }).kind}) was refused: ${JSON.stringify(s.result?.errors)}`);
      continue;
    }
    const entry = (run.plannerLog[s.liveSessionId] ?? []).find((e) => e.chosen?.screenId === s.result.screenId);
    if (!entry) p.push(`override ${s.result.screenId} (${(s.screen as { kind?: string }).kind} over the ${s.override!.suggested}) isn't in the planner log`);
    else {
      if (entry.by !== "coach") p.push(`planner log entry for ${s.result.screenId} is by ${entry.by}`);
      if (entry.reason !== s.override!.reason) p.push(`planner log entry for ${s.result.screenId} has reason "${entry.reason}"`);
      if (!entry.suggested?.type) p.push(`planner log entry for ${s.result.screenId} doesn't say what was suggested`);
    }
  }
  for (const [id, log] of Object.entries(run.plannerLog)) for (const e of log) if (e.by === "coach" && !e.reason) p.push(`session ${id}: a coach entry in the planner log has no reason`);
  return p;
}

/** What the delivery rule finds: problems, and the waits that hit the known server bug below. */
function delivery(run: CoachRun): { problems: string[]; lostAfterEnd: string[] } {
  const problems: string[] = [];
  const lostAfterEnd: string[] = [];
  for (const s of run.sessions) {
    const stored = (run.stored[s.liveSessionId] ?? []).map((e) => e.id);
    const waits = run.waits.filter((w) => w.liveSessionId === s.liveSessionId);
    // the server's rule: a wait first marks every event up to its ack delivered (the id it names, else the
    // previous batch's last id), then returns every event not yet delivered
    const delivered = new Set<number>();
    let prev: number[] = [];
    for (const [k, w] of waits.entries()) {
      const ack = w.ack !== undefined ? Number(w.ack) : prev.length ? Math.max(...prev) : 0;
      for (const x of stored) if (x <= ack) delivered.add(x);
      const ids = w.result.events.map((e) => Number(e.id));
      if (ids.some((x, i) => i > 0 && x <= ids[i - 1])) problems.push(`${s.policy} wait ${k}: ids out of order: ${ids.join(", ")}`);
      if (ids.some((x) => !stored.includes(x))) problems.push(`${s.policy} wait ${k}: delivered ids the store doesn't have`);
      const upTo = Math.max(0, ...ids, w.pendingMaxBefore);
      const want = stored.filter((x) => !delivered.has(x) && x <= upTo);
      if (JSON.stringify(ids) !== JSON.stringify(want)) {
        const msg = `${s.policy} wait ${k}${w.ack !== undefined ? ` (ack ${w.ack})` : ""}: got [${ids.join(", ")}]; undelivered in the store: [${want.join(", ")}]`;
        if (w.result.state.state === "ended" && !ids.length) lostAfterEnd.push(`${msg} (${want.map((x) => run.stored[s.liveSessionId].find((e) => e.id === x)?.type).join(", ")})`);
        else problems.push(msg);
      }
      prev = ids;
    }
  }
  return { problems, lostAfterEnd };
}

/**
 * Events arrive in id order, at least once, and nothing is skipped: each wait returns exactly the stored events not
 * yet acknowledged, up to at least what was pending when it began. The quitter's lost batch comes again.
 * `knownBugs` leaves out the waits `eventsLostAfterEnd` reports, so that bug is tested on its own.
 */
export function eventsDelivered(run: CoachRun, opts: { knownBugs?: boolean } = { knownBugs: true }): string[] {
  const d = delivery(run);
  const p = opts.knownBugs ? [...d.problems] : [...d.problems, ...d.lostAfterEnd];
  if (!run.redeliveries.length) p.push("the quitter never came back");
  for (const r of run.redeliveries) {
    if (!r.lost.length) p.push("the quitter's last batch was empty: nothing to redeliver");
    const missing = r.lost.filter((id) => !r.returned.includes(id));
    if (missing.length) p.push(`the quitter's lost batch [${r.lost.join(", ")}] wasn't redelivered: ${missing.join(", ")} missing from [${r.returned.join(", ")}]`);
    if (r.returned.length <= r.lost.length) p.push("nothing that happened while the quitter was away reached it");
  }
  return p;
}

/**
 * Known server bug: a coach_wait made after the session ended (the learner finished the wrap-up between two
 * waits) returns no events, so what was still pending (the wrap-up's screen.viewed, a last question) is never
 * delivered. packages/server/src/core/director.ts, coachWait: the `!row` branch returns `waitResult(..., [], ...)`
 * instead of the pending events (and doesn't acknowledge the previous batch). When the session ends during a wait,
 * the loop's `row.state === "ended"` branch does return them.
 */
export function eventsLostAfterEnd(run: CoachRun): string[] {
  return delivery(run).lostAfterEnd;
}

const MEDIA = [
  [/"mediaRef"/, "a mediaRef"],
  [/data:[a-z]+\/[a-z0-9.+-]+[;,]/i, "a data URL"],
  [/"overlay"/, "an overlay"]
] as const;

/** No event the coach got carries raw media: no mediaRef, no data URL, no overlay (the learner's analyses carried all three as bait). */
export function noRawMedia(run: CoachRun): string[] {
  const p: string[] = [];
  for (const w of run.waits)
    for (const e of w.result.events) {
      const json = JSON.stringify(e);
      for (const [re, what] of MEDIA) if (re.test(json)) p.push(`${w.policy}: event ${e.id} (${e.type}) carries ${what}`);
    }
  const analyzed = run.waits.flatMap((w) => w.result.events).filter((e) => e.type === "attempt.analyzed");
  if (run.attempts.length && !analyzed.length) p.push("the learner recorded attempts but no attempt.analyzed reached the coach");
  return p;
}

/** Every coach_wait result stays under 4 KB of JSON. */
export function waitResultsSmall(run: CoachRun, limit = WAIT_BYTES_LIMIT): string[] {
  return run.waits.filter((w) => w.bytes >= limit).map((w) => `${w.policy}: a coach_wait result is ${w.bytes} bytes (${w.result.events.length} events: ${w.result.events.map((e) => e.type).join(", ")})`);
}

export function maxWaitBytes(run: CoachRun): { bytes: number; fullBytes: number } {
  return { bytes: Math.max(0, ...run.waits.map((w) => w.bytes)), fullBytes: Math.max(0, ...run.waits.map((w) => w.fullBytes)) };
}

/** The learner's questions reach the coach word for word, and a message reply shows in the studio at once. */
export function questionsAnswered(run: CoachRun): string[] {
  const p: string[] = [];
  if (!run.asks.length) p.push("the learner never asked anything");
  if (!run.asks.some((a) => a.whileAway)) p.push("the learner never asked while the coach was away");
  for (const a of run.asks) {
    const label = `${a.policy}: "${a.text}"${a.whileAway ? " (asked while away)" : ""}`;
    if (!a.event) {
      p.push(`${label} never reached the coach`);
      continue;
    }
    if (a.event.type !== "learner.asked" || a.event.text !== a.text) p.push(`${label} arrived as ${JSON.stringify(a.event)}`);
    if (!a.reply) p.push(`${label}: the coach never replied`);
    else {
      const r = a.reply.result;
      if (!r?.ok) p.push(`${label}: the reply was refused: ${JSON.stringify(r?.errors)}`);
      else {
        if (r.status !== "shown") p.push(`${label}: the reply was ${r.status}, not shown at once`);
        const text = (a.reply.screen as { text: string }).text;
        if (!a.reply.messages.some((m) => m.screenId === r.screenId && m.text === text)) p.push(`${label}: the studio wasn't sent the reply during coach_show`);
        if (a.studioMessage !== text) p.push(`${label}: the studio draws "${a.studioMessage}" over the screen, not the reply`);
      }
    }
  }
  return p;
}

/** Pain lowers the intensity cap, the event and state carry it, and the coach's next drill above it is refused. */
export function painLowersCap(run: CoachRun): string[] {
  const p: string[] = [];
  if (!run.pains.length) p.push("the learner never reported pain");
  for (const x of run.pains) {
    if (!x.event || x.event.type !== "pain.reported") {
      p.push("pain.reported never reached the coach");
      continue;
    }
    if (x.event.intensityCap !== x.applied) p.push(`the event's cap is ${x.event.intensityCap}; the server applied ${x.applied}`);
    if (x.capBefore !== undefined && x.event.intensityCap >= x.capBefore) p.push(`the cap didn't go down: ${x.capBefore} → ${x.event.intensityCap}`);
    if (x.stateCap !== x.event.intensityCap) p.push(`the state's cap is ${x.stateCap}, the event's ${x.event.intensityCap}`);
    if (x.hardest && x.hardest.intensity > x.event.intensityCap) {
      if (!x.above) p.push(`the coach never tried "${x.hardest.id}" above the cap`);
      else if (x.above.result?.ok) p.push(`"${x.hardest.id}" (intensity ${x.hardest.intensity}) was accepted above the cap of ${x.event.intensityCap}`);
      else if (!x.above.result?.errors.some((e) => e.path === "drillId" && /cap now is/.test(e.message))) p.push(`"${x.hardest.id}" was refused, but not for the cap: ${JSON.stringify(x.above.result?.errors)}`);
    }
  }
  return p;
}

/** A plan screen's tapped option is applied and logged as a plan change, and the coach hears plan.chosen. */
export function planChoiceLogged(run: CoachRun): string[] {
  const p: string[] = [];
  if (!run.plans.length) p.push("the learner never saw a plan screen");
  for (const x of run.plans) {
    if (!run.planChanges.some((c) => c.reason === `coach-plan:${x.screenId}` && c.option.startsWith(x.optionId))) p.push(`the tap on "${x.optionId}" (${x.screenId}) isn't logged as a plan change`);
    if (!x.change) p.push(`the tap on "${x.optionId}" returned no change`);
    if (!x.event || x.event.type !== "plan.chosen" || x.event.optionId !== x.optionId) p.push(`plan.chosen for "${x.optionId}" never reached the coach`);
  }
  return p;
}

/**
 * A leaving message sets coach-away at once, and the fallback carries the session to its end with no waiting.
 * `knownBugs` leaves out what `queuedShownAfterLeaving` reports, so that bug is tested on its own.
 */
export function leaverHandsOver(run: CoachRun, opts: { knownBugs?: boolean } = { knownBugs: true }): string[] {
  const p: string[] = [];
  if (!run.leaves.length) p.push("the leaver never left");
  for (const l of run.leaves) {
    if (!l.message.result?.ok || l.message.result.status !== "shown") p.push(`the leaving message wasn't shown: ${l.message.text.slice(0, 200)}`);
    if (l.view.state !== "coach-away" || l.view.coachPresent || !l.view.leftOnPurpose) p.push(`after the leaving message the studio sees ${JSON.stringify({ state: l.view.state, coachPresent: l.view.coachPresent, leftOnPurpose: l.view.leftOnPurpose })}`);
    if (!l.after.some((a) => a.source === "fallback")) p.push("no fallback screen came after the coach left");
    for (const a of l.after) {
      if (a.waiting) p.push("the learner was left waiting for an absent coach");
      else if (a.source !== "fallback" && !(opts.knownBugs && a.id && a.id === l.queuedAtLeave)) p.push(`a ${a.kind} from ${a.source} came after the coach left`);
    }
    if (!l.ended) p.push("the fallback didn't carry the session to its end");
  }
  return p;
}

/**
 * Known server bug: a coach screen queued before the coach left still shows after it left, though a coach-away
 * session's next screen is "the planner's next item with the model's pre-written content" (live-coach.md §8) and
 * after a leaving message "the session continues on fallback content" (§15 rule 6).
 * packages/server/src/core/director.ts, serveNext: `const queued = screenById(ctx, data.queuedId)` is shown before
 * the presence check; and coachShow's leaving branch keeps `queuedId`.
 */
export function queuedShownAfterLeaving(run: CoachRun): string[] {
  return run.leaves.flatMap((l) => l.after.filter((a) => a.source === "coach" && a.id === l.queuedAtLeave).map((a) => `the ${a.kind} queued before the leaving message (${a.id}) showed after the coach left`));
}

/** A wait with nothing to report comes back as a heartbeat once the fake clock has moved past the timeout. */
export function heartbeatOnQuiet(run: CoachRun): string[] {
  const p: string[] = [];
  if (!run.heartbeats.length) p.push("no quiet wait was made");
  for (const h of run.heartbeats) {
    const w = h.wait;
    if (w.result.heartbeat !== true) p.push(`a quiet wait returned ${w.result.events.length} events and no heartbeat (${w.result.instruction})`);
    if (w.result.events.length) p.push(`a heartbeat carried events: ${w.result.events.map((e) => e.type).join(", ")}`);
    if (w.clockMs < w.timeoutS * 1000) p.push(`the heartbeat came after ${w.clockMs} ms of fake time; the timeout was ${w.timeoutS} s`);
    if (!/coach_wait again/.test(w.result.instruction)) p.push(`the heartbeat's instruction is "${w.result.instruction}"`);
  }
  return p;
}

export const COACH_CHECKS = ["loopCompleted", "screensFromCoachWhilePresent", "showsValidated", "overridesLogged", "eventsDelivered", "noRawMedia", "waitResultsSmall", "questionsAnswered", "painLowersCap", "planChoiceLogged", "leaverHandsOver", "heartbeatOnQuiet"] as const;
export type CoachCheck = (typeof COACH_CHECKS)[number];

/** All checks, by name, for a run. */
export function coachChecks(run: CoachRun): Record<CoachCheck, string[]> {
  return {
    loopCompleted: loopCompleted(run),
    screensFromCoachWhilePresent: screensFromCoachWhilePresent(run),
    showsValidated: showsValidated(run),
    overridesLogged: overridesLogged(run),
    eventsDelivered: eventsDelivered(run),
    noRawMedia: noRawMedia(run),
    waitResultsSmall: waitResultsSmall(run),
    questionsAnswered: questionsAnswered(run),
    painLowersCap: painLowersCap(run),
    planChoiceLogged: planChoiceLogged(run),
    leaverHandsOver: leaverHandsOver(run),
    heartbeatOnQuiet: heartbeatOnQuiet(run)
  };
}
