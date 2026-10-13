/**
 * The studio's client for the local server's JSON API (packages/server/src/http). One function per route;
 * errors come back as ApiError with the server's learner-safe message.
 */
import type { Analysis, Capabilities, CoachScreen, FeedbackView, IntakeView, LiveState, LiveView, ProgressView, ProofResultView, SessionPlan, StudioEvent, SummaryView, Theme, TodayView, Drill } from "@las/schema";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly data?: unknown
  ) {
    super(message);
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface AttemptInfo {
  attempt: { id: string; sessionId?: string; enrollmentId: string; drillId?: string; milestoneId?: string; kind: string; engine: string; specId?: string; attemptNo: number; prompt?: string; spec?: any; analysis?: Analysis };
  spec?: any;
  capture?: { angle?: string; fps?: number; duration_s?: number; distance_m?: number; guide?: string } | null;
  prompt?: string;
  how?: string;
  singleTake?: boolean;
  checklist?: { id: string; label: string }[];
  rubricPrompt?: string;
  phone?: boolean;
  hasEvidence?: boolean;
}

export interface DrillStepView {
  sk: string;
  drill: Drill;
  kind: "items" | "capture";
  difficulty: number;
  label: string;
  item?: { id: string; type?: string; prompt: string; options?: string[]; code?: string; figures?: any[]; pairs?: [string, string][]; items?: string[] };
  last?: { itemId: string; correct: boolean };
  progress?: { answered: number; correct: number };
  done?: boolean;
  outcome?: Record<string, unknown>;
  attemptId?: string;
  studioPath: string;
}

export interface ReviewCard {
  cardId: string;
  nodeId: string;
  name: string;
  prompt: string;
  kind: string;
  options?: string[];
  answer?: number | string;
  figure?: any;
  dueAt: string;
}

export interface StateView {
  learner: { id: string; name?: string; timezone: string };
  enrollments: { sk: string; skill: string; status: string; milestone: { id: string; title: string; targetDate?: string } | null; themeId: string }[];
  themeId: string;
}

export interface PairInfo {
  available: boolean;
  reason?: string;
  note?: string;
  https?: boolean;
  token?: string;
  expiresAt?: string;
  urls?: string[];
  ca?: string;
  ips?: string[];
}

/** `POST /api/live/:id/advance`: the next screen, or wait for the coach until `until`. */
export interface AdvanceResult {
  screen?: CoachScreen;
  waiting?: true;
  until?: string;
  view: LiveView;
}

export interface PingResult {
  ok: boolean;
  coachPresent: boolean;
  state: LiveState;
}

export function createApi(fetchImpl: FetchLike = (i, init) => fetch(i, init), base = "") {
  async function call<T>(method: string, path: string, body?: unknown, raw?: { body: BodyInit; type: string }): Promise<T> {
    const init: RequestInit = { method, headers: {} };
    if (raw) {
      init.body = raw.body;
      (init.headers as Record<string, string>)["content-type"] = raw.type;
    } else if (body !== undefined) {
      init.body = JSON.stringify(body);
      (init.headers as Record<string, string>)["content-type"] = "application/json";
    }
    let res: Response;
    try {
      res = await fetchImpl(base + path, init);
    } catch (e) {
      throw new ApiError(`Can't reach the LAS server (${(e as Error).message}). Is it running?`, 0);
    }
    const text = await res.text();
    let data: any = undefined;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = text;
    }
    if (!res.ok || (data && typeof data === "object" && data.ok === false)) throw new ApiError((data && data.error) || `${method} ${path}: ${res.status}`, res.status, data?.data ?? data);
    return data as T;
  }
  const get = <T>(p: string) => call<T>("GET", p);
  const post = <T>(p: string, b: unknown = {}) => call<T>("POST", p, b);
  const q = encodeURIComponent;
  return {
    call,
    health: () => get<{ ok: boolean; version: string; studio: boolean }>("/api/health"),
    state: () => get<StateView>("/api/state"),
    capabilities: () => get<Capabilities>("/api/capabilities"),
    devices: (d: { camera: boolean; microphone: boolean; motion: boolean; phone?: boolean }) => post<{ ok: boolean }>("/api/devices", d),
    theme: (sk?: string | null) => get<{ themeId: string; scope: string; theme: Theme }>(`/api/theme${sk ? `?sk=${q(sk)}` : ""}`),
    themes: (sk?: string | null) => get<{ active: { themeId: string; scope: string }; all: { themeId: string }; themes: { id: string; name: string; modes: string[]; validated: boolean }[] }>(`/api/themes${sk ? `?sk=${q(sk)}` : ""}`),
    themeById: (id: string) => get<{ themeId: string; theme: Theme }>(`/api/themes/${q(id)}`),
    setTheme: (themeId: string, scope: string) => post<{ ok: boolean }>("/api/theme/set", { themeId, scope }),
    skillModels: () => get<{ models: { id: string; skill: string; name: string; engines: string[]; source: string; version: number }[] }>("/api/skill-models"),
    startIntake: (skillModelId: string) => post<{ intakeId: string; view: IntakeView }>("/api/intake/start", { skillModelId }),
    intake: (id: string, step?: string) => get<IntakeView>(`/api/intake/${q(id)}${step ? `?step=${q(step)}` : ""}`),
    answer: (id: string, field: string, value: unknown) => post<{ view: IntakeView; answer: Record<string, unknown> | null }>(`/api/intake/${q(id)}/answer`, { field, value }),
    setMilestone: (id: string, milestone: unknown) => post<{ sk: string; milestoneId: string; firstSession: SessionPlan; view: IntakeView }>(`/api/intake/${q(id)}/milestone`, { milestone }),
    today: (sk: string) => get<TodayView>(`/api/today?sk=${q(sk)}`),
    nextSession: (sk: string, opts: { minutes?: number; short?: boolean; location?: string } = {}) => post<SessionPlan>("/api/session/next", { sk, ...opts }),
    session: (id: string) => get<SessionPlan>(`/api/session/${q(id)}`),
    attempt: (id: string) => get<AttemptInfo>(`/api/attempt/${q(id)}`),
    attemptAgain: (id: string) => post<{ attemptId: string; attemptNo: number }>(`/api/attempt/${q(id)}/again`),
    attemptEvidence: (id: string) => get<{ evidence: any }>(`/api/attempt/${q(id)}/evidence`),
    pendingAttempt: () => get<{ attemptId: string | null; engine: string | null }>("/api/attempt/pending"),
    postEvidence: (id: string, evidence: unknown) => post<{ analysis: Analysis; feedback?: FeedbackView; proof?: ProofResultView }>(`/api/attempt/${q(id)}/evidence`, evidence),
    postAnalysis: (id: string, analysis: Analysis) => post<{ feedback?: FeedbackView; proof?: ProofResultView; stored?: boolean }>(`/api/attempt/${q(id)}/analysis`, { analysis }),
    feedback: (id: string) => get<{ attempt: AttemptInfo["attempt"]; analysis?: Analysis; feedback?: FeedbackView; proof?: ProofResultView }>(`/api/attempt/${q(id)}/feedback`),
    uploadMedia: (id: string, blob: Blob) => call<{ ok: boolean; mediaRef: string }>("POST", `/api/media/${q(id)}`, undefined, { body: blob, type: blob.type || "application/octet-stream" }),
    mediaUrl: (id: string) => `${base}/api/media/${q(id)}`,
    drillNext: (id: string, body: { sk?: string; sessionId?: string; difficulty?: number; answer?: { itemId: string; answer: unknown }; history?: { itemId: string; correct: boolean }[] }) => post<DrillStepView>(`/api/drill/${q(id)}/next`, body),
    reviews: (sk: string, n = 10) => get<{ sk: string; cards: ReviewCard[]; due: number; minutes: number }>(`/api/reviews?sk=${q(sk)}&n=${n}`),
    codeRun: (body: { spec: unknown; files: Record<string, string>; sk?: string; drillId?: string; sessionId?: string; specId?: string; consent?: boolean }) => post<any>("/api/code/run", body),
    consent: (runner: "browser" | "local" | "container", granted: boolean) => post<{ ok: boolean }>("/api/consent", { runner, granted }),
    progress: (sk: string) => get<ProgressView>(`/api/progress?sk=${q(sk)}`),
    summary: (sessionId: string) => get<SummaryView>(`/api/summary/${q(sessionId)}`),
    checkins: (sk: string) => get<{ checkins: any[] }>(`/api/checkins?sk=${q(sk)}`),
    event: (ev: StudioEvent) => post<{ ok: boolean; result: any }>("/api/events", ev),
    liveFor: (sk: string) => get<{ live: LiveView | null }>(`/api/live?sk=${q(sk)}`),
    liveStart: (body: { sk: string; minutes?: number; location?: string }) => post<LiveView>("/api/live/start", body),
    live: (id: string) => get<LiveView>(`/api/live/${q(id)}`),
    liveAdvance: (id: string, body: { screenId: string; seconds?: number }) => post<AdvanceResult>(`/api/live/${q(id)}/advance`, body),
    livePing: (id: string) => post<PingResult>(`/api/live/${q(id)}/ping`),
    /** the URL a page-hide beacon posts events to */
    eventsUrl: () => `${base}/api/events`,
    proofStart: (body: { sk?: string; milestoneId?: string; proceed?: boolean }) => post<{ ready: boolean; attempt?: { id: string }; studioPath?: string; milestoneId: string; message: string; checklist: { id: string; label: string }[] }>("/api/proof/start", body),
    deleteData: (scope: string) => post<{ deleted: boolean }>("/api/delete", { scope, confirm: true }),
    exportUrl: (scope = "all") => `${base}/api/export?scope=${q(scope)}`,
    pair: () => get<PairInfo>("/api/pair"),
    pairClaim: (token: string) => post<{ ok: boolean; phone: boolean }>("/api/pair/claim", { token }),
    pushKey: () => get<{ publicKey: string }>("/api/push/key"),
    pushSubscriptions: () => get<{ subscriptions: { id: string; endpointHost: string }[] }>("/api/push/subscriptions"),
    pushSubscribe: (subscription: unknown) => post<{ ok: boolean; id: string }>("/api/push/subscribe", { subscription }),
    pushUnsubscribe: (id: string) => call<{ ok: boolean }>("DELETE", `/api/push/subscribe/${q(id)}`)
  };
}

export type Api = ReturnType<typeof createApi>;
export const api = createApi();
