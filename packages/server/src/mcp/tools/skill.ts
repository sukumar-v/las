import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { LasContext } from "../../context.js";
import { draftSkillModel, validateAndStore } from "../../core/skill-model.js";
import { ok, fail } from "../result.js";
import { view } from "../widgets.js";

export function registerSkillTools(server: McpServer, ctx: LasContext): void {
  server.registerTool(
    "get_capabilities",
    {
      title: "What LAS can measure here",
      description: "Engines and their status, code runners and detected toolchains, devices, external tools on PATH and local models. Call this before writing a skill model, and again when something seems missing.",
      inputSchema: { fresh: z.boolean().optional().describe("Re-detect instead of using the cached result") }
    },
    async ({ fresh }) => {
      const caps = await ctx.capabilities(!!fresh);
      const lines = [
        `Engines available: ${caps.engines.filter((e) => e.available).map((e) => e.id).join(", ")}`,
        caps.engines.some((e) => !e.available) ? `Unavailable: ${caps.engines.filter((e) => !e.available).map((e) => `${e.id} (${e.reason})`).join(", ")}` : "",
        `Code runners: browser [${caps.runners.browser.join(", ")}]; local [${caps.runners.local.map((l) => `${l.language} ${l.version ?? ""}`.trim()).join(", ") || "none"}]; container: ${caps.runners.container.available ? caps.runners.container.runtime : "none"}`,
        `External tools: ${caps.external.map((e) => `${e.name} (${e.protocol}, ${e.license})`).join(", ") || "none"}`,
        `Local models: ${caps.localModels.filter((m) => m.available).map((m) => m.id).join(", ") || "none"}`,
        `Devices (reported by the studio): camera ${caps.devices.camera}, microphone ${caps.devices.microphone}, motion ${caps.devices.motion}, phone ${caps.devices.phone}; studio built: ${caps.devices.studio}`,
        `Widgets: ${caps.widgets ? "this client renders MCP Apps" : "this client does not render MCP Apps; tools return studio links"}; studio: ${caps.studioUrl}`
      ].filter(Boolean);
      return view(ctx, { view: "capabilities", title: "What LAS can measure here", data: caps as any, text: lines.join("\n"), studioPath: "/settings" });
    }
  );

  server.registerTool(
    "draft_skill_model",
    {
      title: "Start a skill model",
      description: "Returns an empty skill model skeleton with the schema, the engines available now, the rules to follow, and a curated pack or previous model to start from if one exists. Then write the model and call validate_skill_model.",
      inputSchema: { skill: z.string().min(1).max(80).describe("What the learner wants to learn, in their words"), notes: z.string().max(2000).optional().describe("Anything the learner said that shapes the model") }
    },
    async ({ skill, notes }) => {
      const caps = await ctx.capabilities();
      const d = draftSkillModel(ctx, skill, caps, notes);
      const text = [
        `Skill model draft for "${skill}".`,
        d.startFrom ? `Start from the ${d.startFrom.kind} model ${d.startFrom.id} (version ${d.startFrom.version}) and adapt it to this learner.` : "No curated pack and no previous model: write a new one from the skeleton.",
        `Engines available now: ${d.availableEngines.join(", ")}.`,
        d.unavailableEngines.length ? `Not available: ${d.unavailableEngines.map((u) => `${u.id} -> fallback ${u.fallback}`).join(", ")}.` : "",
        "Rules:",
        ...d.rules.map((r) => `- ${r}`)
      ].filter(Boolean);
      return ok(text.join("\n"), d as any);
    }
  );

  server.registerTool(
    "validate_skill_model",
    {
      title: "Validate and store a skill model",
      description: "Runs every check a skill model must pass (schema, word budgets, proofs bound to specs, spec languages, skill graph, safety fields, engine availability). Stores the model when it passes and returns its id. Fix every error and call again until ok is true.",
      inputSchema: { model: z.record(z.string(), z.unknown()).describe("The full skill model as JSON") }
    },
    async ({ model }) => {
      const caps = await ctx.capabilities();
      const r = validateAndStore(ctx, model, caps);
      const data = { ok: r.ok, errors: r.errors, warnings: r.warnings, summary: r.summary, stored: r.stored, enginesAvailable: r.enginesAvailable };
      if (r.ok) {
        return ok(`Skill model stored as ${r.stored!.id} (version ${r.stored!.version}). ${r.warnings.length ? `Warnings:\n${r.warnings.map((w) => `- ${w.path}: ${w.message}`).join("\n")}` : "No warnings."}\nNext: start_intake with skillModelId "${r.stored!.id}".`, data);
      }
      const shown = r.errors.slice(0, 40);
      return fail(`${r.errors.length} error(s). Fix them and call validate_skill_model again.\n${shown.map((e) => `- ${e.path}: ${e.message}`).join("\n")}${r.errors.length > shown.length ? `\n…and ${r.errors.length - shown.length} more` : ""}`, data);
    }
  );

  server.registerTool(
    "get_skill_model",
    {
      title: "Read a stored skill model",
      description: "The stored model for a skill name, a skill model id or an enrollment id, for viewing or revising.",
      inputSchema: { skill: z.string().describe("Skill name, skill model id or enrollment id (sk)") }
    },
    async ({ skill }) => {
      const row = ctx.store.getSkillModel(skill) ?? ctx.store.findSkillModel(skill) ?? (() => {
        const e = ctx.store.resolveEnrollment(skill);
        return e ? ctx.store.getSkillModel(e.skillModelId) : undefined;
      })();
      if (!row) return fail(`No skill model for "${skill}". Call draft_skill_model to write one.`);
      return ok(`Skill model ${row.id} (${row.model.name}, version ${row.version}, ${row.source}): ${row.model.ladder.length} ladder steps, ${row.model.nodes.length} nodes, ${row.model.drills.length} drills, engines ${row.model.engines.join(", ")}.`, { id: row.id, version: row.version, source: row.source, validatedAt: row.validatedAt, model: row.model as any });
    }
  );
}
