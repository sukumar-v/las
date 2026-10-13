import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { LasContext } from "../context.js";
import { learnerProfile, routeFor, progressFor, mistakesFor } from "../core/views.js";

const text = (uri: string, data: unknown) => ({ contents: [{ uri, mimeType: "application/json", text: JSON.stringify(data, null, 2) }] });

export function registerResources(server: McpServer, ctx: LasContext): void {
  server.registerResource("learner-profile", "las://learner/profile", { title: "Learner profile", description: "The stored profile: skills, intent, constraints, milestones, themes", mimeType: "application/json" }, async (uri) => text(uri.href, learnerProfile(ctx)));

  const skillTemplate = (part: string) =>
    new ResourceTemplate(`las://skills/{sk}/${part}`, {
      list: async () => ({ resources: ctx.store.listEnrollments().map((e) => ({ uri: `las://skills/${e.id}/${part}`, name: `${ctx.store.getSkillModel(e.skillModelId)?.model.name ?? e.id} ${part}`, mimeType: "application/json" })) })
    });

  server.registerResource("skill-route", skillTemplate("route"), { title: "Route to the milestone", mimeType: "application/json" }, async (uri, { sk }) => {
    const e = ctx.store.resolveEnrollment(String(sk));
    return text(uri.href, e ? routeFor(ctx, e) : { error: "unknown skill" });
  });
  server.registerResource("skill-progress", skillTemplate("progress"), { title: "Progress", mimeType: "application/json" }, async (uri, { sk }) => {
    const e = ctx.store.resolveEnrollment(String(sk));
    return text(uri.href, e ? progressFor(ctx, e) : { error: "unknown skill" });
  });
  server.registerResource("skill-mistakes", skillTemplate("mistakes"), { title: "Mistakes and their states", mimeType: "application/json" }, async (uri, { sk }) => {
    const e = ctx.store.resolveEnrollment(String(sk));
    return text(uri.href, e ? mistakesFor(ctx, e) : { error: "unknown skill" });
  });
  server.registerResource("skill-model", skillTemplate("model"), { title: "The skill model", mimeType: "application/json" }, async (uri, { sk }) => {
    const e = ctx.store.resolveEnrollment(String(sk));
    const m = e ? ctx.store.getSkillModel(e.skillModelId) : ctx.store.getSkillModel(String(sk));
    return text(uri.href, m ? { id: m.id, version: m.version, source: m.source, model: m.model } : { error: "unknown skill" });
  });
  server.registerResource(
    "packs",
    new ResourceTemplate("las://packs/{pack}", { list: async () => ({ resources: [] }) }),
    { title: "Curated packs", description: "Reviewed skill models. None ship in v0.1: every model is generated.", mimeType: "application/json" },
    async (uri, { pack }) => text(uri.href, { error: `no curated pack "${String(pack)}"; v0.1 ships none, so the agent writes the model` })
  );
}
