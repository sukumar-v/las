import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { LasContext } from "../../context.js";
import { getProgress, sessionSummary } from "../../core/progress.js";
import { deleteData, exportData, logExternal, reportPain, revisitWhy } from "../../core/track.js";
import { loadSk } from "../../core/common.js";
import { ok } from "../result.js";
import { view } from "../widgets.js";
import { guard, intakeText } from "./onboard.js";

export function registerTrackTools(server: McpServer, ctx: LasContext): void {
  server.registerTool(
    "get_progress",
    {
      title: "Progress",
      description: "Route with mastery per skill, key metric trends, the first attempt beside the latest, time and practice mix actual vs planned, history and proof readiness. Only ever compared with the learner's own past.",
      inputSchema: { sk: z.string() }
    },
    guard(async ({ sk }) => {
      const p = getProgress(ctx, sk);
      const text = [
        `${p.skill}: ${p.proof.title} ${p.proof.percent}% ready${p.proof.ready ? " (proof ready)" : ""}.`,
        ...p.keyMetrics.map((k) => `${k.label}: ${k.first ?? "–"} → ${k.latest ?? "–"} ${k.unit}`.trim()),
        `Time: ${p.time.actualMinutes} of ${p.time.plannedMinutes} planned minutes. Mix: ${p.time.mix.map((m) => `${m.category} ${m.actual}%/${m.planned}%`).join(", ")}`
      ];
      return view(ctx, { view: "progress", title: "Progress", data: p as unknown as Record<string, unknown>, text: text.join("\n"), studioPath: `/app/progress/${p.sk}`, sk: p.sk });
    })
  );

  server.registerTool(
    "get_session_summary",
    {
      title: "Session summary",
      description: "What changed (mastery before and after), one fix, one thing done well, and the next session.",
      inputSchema: { sessionId: z.string() }
    },
    guard(async ({ sessionId }) => {
      const s = sessionSummary(ctx, sessionId);
      const text = [`${s.minutes} min.`, ...s.changed.map((c) => `${c.name}: ${Math.round(c.before * 100)}% → ${Math.round(c.after * 100)}%`), s.oneFix ? `One fix: ${s.oneFix.headline}${s.oneFix.fixDrillTitle ? ` (try: ${s.oneFix.fixDrillTitle})` : ""}` : "", s.praise ? `Done well: ${s.praise}` : "", `Next: ${s.next.title}`].filter(Boolean);
      return view(ctx, { view: "summary", title: "Session summary", data: s as unknown as Record<string, unknown>, text: text.join("\n"), studioPath: `/app/summary/${sessionId}`, sk: s.sk });
    })
  );

  server.registerTool(
    "log_external",
    {
      title: "Log practice outside the app",
      description: "Counts practice done outside the app. milestoneDone: true marks the active milestone done as self-reported (the learner is trusted; proof stays optional).",
      inputSchema: { sk: z.string(), minutes: z.number().min(0).max(1440), note: z.string().max(500).optional(), category: z.string().max(40).optional(), milestoneDone: z.boolean().optional() }
    },
    guard(async ({ sk, minutes, note, category, milestoneDone }) => {
      const r = logExternal(ctx, sk, minutes, note ?? "", { category, milestoneDone });
      return ok(`Logged ${minutes} min.${r.milestone ? ` "${r.milestone.title}" marked done (self-reported). Next: revisit_why.` : ""}`, r as unknown as Record<string, unknown>);
    })
  );

  server.registerTool(
    "report_pain",
    {
      title: "Report pain",
      description: "Pain means stop: lowers intensity now (for 7 days), applies the skill's injury rule, schedules a follow-up and says to see a professional if it lasts more than a week. Never diagnose.",
      inputSchema: { sk: z.string(), area: z.string().max(40), level: z.number().int().min(1).max(5) }
    },
    guard(async ({ sk, area, level }) => {
      const r = (await reportPain(ctx, sk, area, level)) as { note: string; rule?: string };
      return ok(`${r.note}${r.rule ? ` Rule: ${r.rule}.` : ""}`, r as unknown as Record<string, unknown>);
    })
  );

  server.registerTool(
    "revisit_why",
    {
      title: "Ask why again",
      description: "Re-opens the why and six-month questions for an existing skill (after a milestone, or when the learner has gone quiet), then the next milestone screen. Answer with record_answer; set_milestone adds the next milestone.",
      inputSchema: { sk: z.string() }
    },
    guard(async ({ sk }) => {
      const st = loadSk(ctx, sk);
      const r = await revisitWhy(ctx, st.enrollment.id);
      return view(ctx, { view: "onboarding", title: r.view.question, data: { ...r.view, next: r.view.step, whyOptions: r.whyOptions }, text: intakeText(r.view), studioPath: `/app/onboarding/${r.intake.id}`, sk: st.enrollment.id });
    })
  );

  server.registerTool(
    "export_data",
    {
      title: "Export the learner's data",
      description: "Writes everything (scope 'all') or one skill (scope = sk) to a JSON file in the LAS data folder and lists the media files on the device.",
      inputSchema: { scope: z.string().default("all") }
    },
    guard(async ({ scope }) => {
      const r = exportData(ctx, scope);
      return ok(`Exported to ${r.file} (${r.media.length} media file(s) listed).`, r as unknown as Record<string, unknown>);
    })
  );

  server.registerTool(
    "delete_data",
    {
      title: "Delete the learner's data",
      description: "Deletes one skill (scope = sk) or everything (scope 'all'), media files included. It can't be undone: ask the learner and pass confirm: true.",
      inputSchema: { scope: z.string(), confirm: z.boolean().optional() }
    },
    guard(async ({ scope, confirm }) => {
      const r = deleteData(ctx, scope, !!confirm);
      return ok(`Deleted ${r.scope === "all" ? "everything" : r.scope}, ${r.mediaFilesRemoved} media file(s).`, r as unknown as Record<string, unknown>);
    })
  );
}
