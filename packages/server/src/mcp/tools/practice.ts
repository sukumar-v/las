import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { LasContext } from "../../context.js";
import { reviewCards, startDrill } from "../../core/practice.js";
import { view } from "../widgets.js";
import { guard } from "./onboard.js";

export function registerPracticeTools(server: McpServer, ctx: LasContext): void {
  server.registerTool(
    "start_drill",
    {
      title: "Start or continue a drill",
      description: "Knowledge drills serve one item at a time (pass `answer: {itemId, answer}` to grade it and get the next); when the drill ends its outcome updates mastery. Performance drills (move, play-along, say-it, build, make, timed-reps) return a capture in the studio.",
      inputSchema: { drillId: z.string(), sk: z.string().optional(), sessionId: z.string().optional(), difficulty: z.number().int().min(0).max(7).optional(), answer: z.object({ itemId: z.string(), answer: z.unknown() }).optional() }
    },
    guard(async ({ drillId, sk, sessionId, difficulty, answer }) => {
      const r = await startDrill(ctx, drillId, { sk, sessionId, difficulty, answer: answer as { itemId: string; answer: unknown } | undefined });
      const item = r.item as { id?: string; prompt?: string; options?: string[] } | undefined;
      const text = r.kind === "capture"
        ? `${r.drill.title} (${r.label}): record it in the studio${ctx.devices.phone ? " or on the paired phone" : ""}.`
        : r.done
          ? `${r.drill.title} done: ${r.progress?.correct} of ${r.progress?.answered} right.`
          : `${r.last ? (r.last.correct ? "Right. " : "Not quite. ") : ""}${item?.prompt ?? ""}${item?.options ? ` Options: ${item.options.map((o, i) => `${i}=${o}`).join(", ")}` : ""} (item ${item?.id})`;
      return view(ctx, { view: r.kind === "capture" ? "capture" : "drill", title: r.drill.title, data: r as unknown as Record<string, unknown>, text, studioPath: r.studioPath, sk: r.sk });
    })
  );

  server.registerTool(
    "review_cards",
    {
      title: "Reviews due",
      description: "Due spaced-repetition (FSRS) cards with each skill's review prompt. The learner grades each 1–4 (again, hard, good, easy); the studio sends review.graded.",
      inputSchema: { sk: z.string(), n: z.number().int().min(1).max(50).optional() }
    },
    guard(async ({ sk, n }) => {
      const r = reviewCards(ctx, sk, n);
      return view(ctx, { view: "review", title: `${r.cards.length} review${r.cards.length === 1 ? "" : "s"}`, data: r as unknown as Record<string, unknown>, text: r.cards.length ? `${r.due} due, about ${r.minutes} min:\n${r.cards.map((c) => `- ${c.cardId}: ${c.prompt}`).join("\n")}` : "Nothing due.", studioPath: `/app/review/${r.sk}`, sk: r.sk });
    })
  );
}
