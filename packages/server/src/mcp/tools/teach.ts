import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { LasContext } from "../../context.js";
import { explainMistake, renderDiagram, renderLesson, renderMechanism, renderSim } from "../../core/teach.js";
import { view } from "../widgets.js";
import { guard } from "./onboard.js";

const anyObject = z.record(z.string(), z.unknown());

export function registerTeachTools(server: McpServer, ctx: LasContext): void {
  server.registerTool(
    "render_lesson",
    {
      title: "Show a lesson",
      description: "1–5 teaching cards (predict, sim, mechanism, diagram, demo, compare, try-it), each 25 words or fewer; start with a prediction when you can. Specs over budget are rejected with the offending card. Use it for questions that come up in chat too.",
      inputSchema: { title: z.string(), cards: z.array(anyObject), nodes: z.array(z.string()).optional(), id: z.string().optional(), sk: z.string().optional() }
    },
    guard(async ({ sk, ...lesson }) => {
      const l = renderLesson(lesson);
      return view(ctx, { view: "lesson", title: l.title, data: l as unknown as Record<string, unknown>, text: `Lesson "${l.title}": ${l.cards.length} card(s): ${l.cards.map((c) => c.type).join(", ")}.`, studioPath: "/app/lesson", sk: sk ? (ctx.store.resolveEnrollment(sk)?.id ?? null) : null });
    })
  );

  server.registerTool(
    "render_sim",
    {
      title: "Show a simulation",
      description: "An interactive simulation for any concept: 1–4 parameters with ranges, formulas in the LAS expression language, a figure (plot, bars, gauge, linkage, timeline, grid) and a live readout. Declarative: nothing you write runs as code; unknown names or functions are rejected.",
      inputSchema: { sim: anyObject, sk: z.string().optional() }
    },
    guard(async ({ sim, sk }) => {
      const s = renderSim(sim);
      return view(ctx, { view: "sim", title: s.title, data: s as unknown as Record<string, unknown>, text: `Simulation "${s.title}": drag ${Object.keys(s.params).join(", ")}.`, studioPath: "/app/sim", sk: sk ? (ctx.store.resolveEnrollment(sk)?.id ?? null) : null });
    })
  );

  server.registerTool(
    "render_mechanism",
    {
      title: "Show how a mechanism works",
      description: "A mechanism figure for a concept (how something works inside: a lock, a pump, a lever), cached per concept because generating one is slow. If your anatomy skill (or another figure source) produced a figure, pass it as `figure` to validate and cache it.",
      inputSchema: { concept: z.string().min(1).max(80), figure: anyObject.optional() }
    },
    guard(async ({ concept, figure }) => {
      const r = renderMechanism(ctx, concept, figure);
      return view(ctx, { view: "mechanism", title: concept, data: r as unknown as Record<string, unknown>, text: `Mechanism "${concept}" (${r.source}).${r.source === "placeholder" ? " Pass a figure from the anatomy skill to cache a real one." : ""}`, studioPath: "/app/mechanism" });
    })
  );

  server.registerTool(
    "render_diagram",
    {
      title: "Show a diagram",
      description: "A figure drawn in the learner's theme: mermaid, graph (nodes and edges), figure (points and segments), notation (ABC), rhythm, code (with an optional trace), chart, contour, space, media. Validated before it's shown.",
      inputSchema: { figure: anyObject, title: z.string().max(60).optional(), caption: z.string().max(160).optional(), sk: z.string().optional() }
    },
    guard(async ({ figure, title, caption, sk }) => {
      const f = renderDiagram(figure);
      return view(ctx, { view: "diagram", title: title ?? "Diagram", data: { figure: f, title, caption }, text: `${f.kind} diagram${title ? `: ${title}` : ""}.`, studioPath: "/app/diagram", sk: sk ? (ctx.store.resolveEnrollment(sk)?.id ?? null) : null });
    })
  );

  server.registerTool(
    "explain_mistake",
    {
      title: "Why is this a mistake?",
      description: "The mistake's explanation visual from the skill model (a lesson card or figure), with the learner's own frame and measured evidence when an attempt is given, and its fix drill.",
      inputSchema: { mistakeId: z.string(), attemptId: z.string().optional(), sk: z.string().optional() }
    },
    guard(async ({ mistakeId, attemptId, sk }) => {
      const r = explainMistake(ctx, mistakeId, { attemptId, sk });
      return view(ctx, { view: "mistake", title: r.headline, data: r as unknown as Record<string, unknown>, text: `${r.headline}. Fix drill: ${r.fixDrillTitle ?? r.fixDrillId}.`, studioPath: attemptId ? `/app/feedback/${attemptId}` : undefined, sk: r.sk });
    })
  );
}
