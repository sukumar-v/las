import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getUiCapability, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { LasContext } from "../context.js";
import { registerWidgets } from "./widgets.js";
import { registerSkillTools } from "./tools/skill.js";
import { registerThemeTools } from "./tools/theme.js";
import { registerResources } from "./resources.js";
import { registerPrompts } from "./prompts.js";
import { LAS_VERSION } from "../config.js";

/** Builds the MCP server with every tool, resource and prompt. */
export function createMcpServer(ctx: LasContext): McpServer {
  const server = new McpServer(
    { name: "learn-any-skill", version: LAS_VERSION },
    {
      instructions:
        "LAS coaches someone through learning any skill. Follow the learn-any-skill skill: visuals first (call render_* before explaining), never grade raw recordings (only get_analysis), one fix at a time, no silent plan changes, pain means stop, talk to the learner's why. For a new skill: get_capabilities, draft_skill_model, write the model, validate_skill_model until ok, then start_intake. If the learner brings a look: draft_theme, validate_theme, set_theme first."
    }
  );
  server.server.oninitialized = () => {
    const caps = server.server.getClientCapabilities();
    const ui = getUiCapability(caps as any);
    ctx.widgetsSupported = !!ui?.mimeTypes?.includes(RESOURCE_MIME_TYPE);
  };
  registerWidgets(server, ctx);
  registerSkillTools(server, ctx);
  registerThemeTools(server, ctx);
  for (const extra of extraRegistrars) extra(server, ctx);
  registerResources(server, ctx);
  registerPrompts(server, ctx);
  return server;
}

/** Tool groups added by later phases register here (onboard, plan, teach, practice, evaluate, track). */
export const extraRegistrars: ((server: McpServer, ctx: LasContext) => void)[] = [];
