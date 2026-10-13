/**
 * The live coach's four tools (docs/design/live-coach.md §3.1): coach_start, coach_wait, coach_show, coach_end.
 * The agent loops coach_wait → coach_show → coach_wait for the whole session; the director (core/director.ts)
 * holds the state in the store. Every result tells the agent what to do next (`instruction`).
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { CoachEvent, CoachShowResult } from "@las/schema";
import type { LasContext } from "../../context.js";
import { LoopError } from "../../core/common.js";
import { coachEnd, coachShow, coachStart, coachWait } from "../../core/director.js";
import { discoverClientSession } from "../../core/client-session.js";
import { fail } from "../result.js";
import { view } from "../widgets.js";

const anyObject = z.record(z.string(), z.unknown());

/** Like `guard`, with the next step for the agent in every error. */
function coachGuard<A, X>(fn: (args: A, extra: X) => Promise<CallToolResult> | CallToolResult): (args: A, extra: X) => Promise<CallToolResult> {
  return async (args: A, extra: X) => {
    try {
      return await fn(args, extra);
    } catch (e) {
      if (e instanceof LoopError) return fail(e.message, { ok: false, error: e.message, instruction: (e.data?.instruction as string | undefined) ?? e.message, ...(e.data ?? {}) });
      return fail(`Something went wrong: ${(e as Error).message}. Call coach_wait again; if it keeps failing, end with coach_end.`, { ok: false, instruction: "Call coach_wait again." });
    }
  };
}

/** One line per event for clients without widgets. */
function eventLine(e: CoachEvent): string {
  switch (e.type) {
    case "screen.viewed":
      return `#${e.id} screen.viewed ${e.kind} (${e.source})${e.previous ? `, ${Math.round(e.previous.seconds)} s on the last one` : ""}`;
    case "card.answered":
      return `#${e.id} card.answered card ${e.card} (${e.cardType})${e.correct === undefined ? "" : e.correct ? " right" : " wrong"}`;
    case "drill.answered":
      return `#${e.id} drill.answered ${e.drillId}${e.itemId ? ` item ${e.itemId}` : ""}${e.correct === undefined ? "" : e.correct ? " right" : " wrong"}${e.done ? ` done (${e.success ? "success" : "not yet"})` : ""}`;
    case "attempt.analyzed":
      return `#${e.id} attempt.analyzed ${e.attemptId}${e.analysis.quality.ok ? "" : " (quality failed: re-record)"}${e.top ? `, top mistake ${e.top.mistakeId} (${e.top.confidence})` : ""}`;
    case "learner.asked":
      return `#${e.id} learner.asked: "${e.text}"`;
    case "pain.reported":
      return `#${e.id} pain.reported ${e.area} level ${e.level}, intensity cap now ${e.intensityCap}`;
    default:
      return `#${e.id} ${e.type}`;
  }
}

export function registerCoachTools(server: McpServer, ctx: LasContext): void {
  server.registerTool(
    "coach_start",
    {
      title: "Start coaching live",
      description:
        "Opens a live practice session and makes you its coach: plans it (the plan is advice), returns the first state, the planner's suggestion and the studio link. If you already hold the open session it re-attaches. Then loop coach_wait → coach_show until coach_end. Pass clientSessionId (your conversation id) when you know it, so the watcher can bring you back.",
      inputSchema: { sk: z.string(), minutes: z.number().min(5).max(120).optional(), location: z.string().max(200).optional(), client: z.string().max(40).optional(), clientSessionId: z.string().max(200).optional() }
    },
    coachGuard(async ({ sk, minutes, location, client, clientSessionId }) => {
      const found = clientSessionId ? undefined : await discoverClientSession(ctx.config.dataDir, { client }).catch(() => undefined);
      const r = await coachStart(ctx, { sk, minutes, location, client: client ?? found?.client, clientSessionId, discoveredSessionId: found?.sessionId });
      const text = [`${r.plan.title} · ${r.plan.minutes} min${r.reattached ? " (re-attached)" : ""}`, ...r.plan.blocks.map((b) => `- ${b.kind} ${b.minutes} min: ${b.title}. Why: ${b.reason}`), r.suggestion ? `Suggestion: ${r.suggestion.item.type} (${r.suggestion.reason})` : "", r.instruction].filter(Boolean).join("\n");
      return view(ctx, { view: "coach", title: r.plan.title, data: r as unknown as Record<string, unknown>, text, studioPath: r.studioPath, sk: r.sk });
    })
  );

  server.registerTool(
    "coach_wait",
    {
      title: "Wait for the learner",
      description:
        "Blocks until something happens in the studio (default 45 s, at most 55 s), then returns {events, state, suggestion, instruction}. Returns at once if events are waiting. A heartbeat means nothing happened: call coach_wait again at once, don't reply in the chat. Events come at least once, with ids: skip ids you've already handled. `ack` (optional): the id of the last event you handled, if a reply was lost.",
      inputSchema: { sk: z.string(), timeoutS: z.number().min(1).max(300).optional(), ack: z.string().max(20).optional() }
    },
    coachGuard(async ({ sk, timeoutS, ack }, extra) => {
      const token = extra._meta?.progressToken;
      const r = await coachWait(ctx, sk, {
        timeoutS,
        ack,
        signal: extra.signal,
        onProgress: token === undefined ? undefined : (waited, total) => extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: waited, total, message: "Waiting for the learner" } })
      });
      const text = [r.heartbeat ? "Heartbeat: nothing happened." : r.events.length ? r.events.map(eventLine).join("\n") : `State: ${r.state.state}.`, r.state.waiting ? `The learner is waiting for the next screen (fallback at ${r.state.waiting.until}).` : "", r.suggestion ? `Suggestion: ${r.suggestion.item.type} (${r.suggestion.reason})` : "", r.instruction].filter(Boolean).join("\n");
      return view(ctx, { view: "coach", title: "Live session", data: r as unknown as Record<string, unknown>, text, studioPath: `/app/session/${r.liveSessionId}`, sk: r.sk });
    })
  );

  server.registerTool(
    "coach_show",
    {
      title: "Show the next screen",
      description:
        'Validates one screen and shows it: a message at once over the current screen, anything else as the next screen (it replaces an earlier queued one, and shows at once if the learner is waiting). Kinds: lesson {title, nodes, cards (1–5, 25 words each)}, drill {drillId | type+nodes+items, prompt (25 words), difficulty}, capture {drillId | milestoneId, prompt, how}, feedback {attemptId, headline (8 words), evidence {kind: mistake|marker|metric}, fixDrillId, why, praise}, message {text (25 words), figure, replyTo, leaving}, plan {question, options (2–4), reason, checkinId}, wrapup {praise, oneFix, nextNote}. Pass "suggested" to show the planner\'s suggestion. A screen that differs from the suggestion needs a reason. Over budget or unsafe: rejected with errors, nothing shown.',
      inputSchema: { sk: z.string(), screen: z.union([z.literal("suggested"), anyObject]) }
    },
    coachGuard(async ({ sk, screen }) => {
      const r: CoachShowResult = coachShow(ctx, sk, screen);
      if (!r.ok) return fail(`Rejected, nothing shown:\n${r.errors.map((e) => `- ${e.path}: ${e.message}`).join("\n")}\n${r.instruction ?? ""}`, r as unknown as Record<string, unknown>);
      const live = ctx.store.resolveEnrollment(sk);
      const liveId = live ? ctx.store.openLiveSession(live.id)?.id : undefined;
      return view(ctx, { view: "coach", title: r.status === "shown" ? "Shown" : "Queued", data: r as unknown as Record<string, unknown>, text: `${r.status === "shown" ? "Shown" : "Queued"} (${r.screenId}). ${r.instruction ?? ""}`, studioPath: liveId ? `/app/session/${liveId}` : undefined, sk: live?.id ?? null });
    })
  );

  server.registerTool(
    "coach_end",
    {
      title: "End the live session",
      description: "Ends the live session (showing the fallback wrap-up first if you didn't show one) and returns the summary. Then say a few words to the learner in the chat.",
      inputSchema: { sk: z.string() }
    },
    coachGuard(async ({ sk }) => {
      const r = await coachEnd(ctx, sk);
      const s = r.summary;
      const text = [`${s.skill}: ${s.minutes} min.`, s.changed.length ? `Changed: ${s.changed.map((c) => `${c.name} ${Math.round(c.before * 100)}% → ${Math.round(c.after * 100)}%`).join(", ")}.` : "", s.oneFix ? `One fix: ${s.oneFix.headline}.` : "", s.praise ? `Done well: ${s.praise}.` : "", `Next: ${s.next.title}.`, r.instruction].filter(Boolean).join("\n");
      return view(ctx, { view: "coach", title: "Session summary", data: r as unknown as Record<string, unknown>, text, studioPath: `/app/session/${r.liveSessionId}`, sk: r.sk });
    })
  );
}
