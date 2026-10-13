import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { LasContext } from "../../context.js";
import { getToday } from "../../core/progress.js";
import { planSession } from "../../core/planner.js";
import { replan, reschedule } from "../../core/replan.js";
import { loadSk } from "../../core/common.js";
import { ok } from "../result.js";
import { view } from "../widgets.js";
import { guard } from "./onboard.js";

export function registerPlanTools(server: McpServer, ctx: LasContext): void {
  server.registerTool(
    "get_today",
    {
      title: "Today",
      description: "What should the learner do now: the next session, reviews due, the milestone, this week's dots and the one check-in that needs a decision (answer it with its option ids via the studio, or replan/reschedule). States: first-day, normal, missed, behind, proof-ready, milestone-done, paused.",
      inputSchema: { sk: z.string().describe("Enrollment id or skill name") }
    },
    guard(async ({ sk }) => {
      const t = getToday(ctx, sk);
      const text = [
        `${t.skill} · ${t.state}. ${t.message ?? ""}`,
        t.nextSession ? `Next: ${t.nextSession.title}, ${t.nextSession.minutes} min (${t.nextSession.reason})` : "",
        `Reviews due: ${t.reviewsDue.count} (~${t.reviewsDue.minutes} min)`,
        t.milestone ? `Milestone: ${t.milestone.title}, ${t.milestone.percent}% of the skills, proof ~${t.milestone.proofDate}` : "",
        t.checkin ? `Check-in ${t.checkin.id}: ${t.checkin.question} Options: ${t.checkin.options.map((o) => `${o.id} (${o.label})`).join(", ")}` : ""
      ].filter(Boolean);
      return view(ctx, { view: "today", title: "Today", data: t as unknown as Record<string, unknown>, text: text.join("\n"), studioPath: `/app/today/${t.sk}`, sk: t.sk });
    })
  );

  server.registerTool(
    "next_session",
    {
      title: "Plan the next session",
      description: "Plans the next session from the route, mastery, due reviews, open mistakes, the practice mix, injuries, equipment and today's time. Every block carries a reason. minutes: today's time (5 = a short session: recall plus one drill). location: a place or a comma-separated list of what's at hand.",
      inputSchema: { sk: z.string(), minutes: z.number().min(5).max(120).optional(), location: z.string().max(200).optional(), short: z.boolean().optional() }
    },
    guard(async ({ sk, minutes, location, short }) => {
      const st = loadSk(ctx, sk);
      const plan = planSession(ctx, st.enrollment.id, { minutes, location, short });
      const text = [`${plan.title} · ${plan.minutes} min`, ...plan.blocks.map((b) => `- ${b.kind} ${b.minutes} min: ${b.title}. Why: ${b.reason}`)].join("\n");
      return view(ctx, { view: "session", title: plan.title, data: plan as unknown as Record<string, unknown>, text, studioPath: `/app/session/${plan.sessionId}`, sk: plan.sk });
    })
  );

  server.registerTool(
    "reschedule",
    {
      title: "Move or skip a session",
      description: "Moves a planned session ('today', 'tomorrow', an ISO date or time) or skips it ('skip'). Missing a day never resets anything.",
      inputSchema: { sessionId: z.string(), when: z.string() }
    },
    guard(async ({ sessionId, when }) => {
      const r = reschedule(ctx, sessionId, when);
      return ok(r.status === "skipped" ? `Skipped.${r.next ? ` Next: ${r.next.title} on ${r.next.plannedAt}.` : ""}` : `Moved to ${r.plannedAt}.`, r as unknown as Record<string, unknown>);
    })
  );

  server.registerTool(
    "replan",
    {
      title: "Change the plan (the learner's choice)",
      description: "Applies a re-plan option the learner chose; never call it without their choice. Options: stone (a closer stepping stone), more-time (value: minutes per week, default +60), later-date (value: YYYY-MM-DD, default the projected date), stretch, keep, change-days (value: days, Monday = 0 or names), change-minutes (value: minutes per week), pause, resume. Logged as a plan change.",
      inputSchema: { sk: z.string(), option: z.string(), value: z.unknown().optional() }
    },
    guard(async ({ sk, option, value }) => {
      const r = replan(ctx, sk, option, value);
      return view(ctx, { view: "plan", title: r.plan.milestone.title || "Plan", data: { option: r.option, change: r.change, plan: r.plan, route: r.route }, text: `${r.change} Milestone: ${r.plan.milestone.title}, target ${r.plan.milestone.targetDate}.`, studioPath: `/app/today/${r.plan.sk}`, sk: r.plan.sk });
    })
  );
}
