import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { LasContext } from "../context.js";

const msg = (text: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text } }] });

export function registerPrompts(server: McpServer, ctx: LasContext): void {
  server.registerPrompt(
    "las-start",
    { title: "Learn something new", description: "Start coaching a new skill: look, skill model, onboarding, first session", argsSchema: { skill: z.string().optional().describe("The skill, if already known"), look: z.string().optional().describe("A pasted design prompt or a description of the look they want") } },
    ({ skill, look }) =>
      msg(
        [
          `I want to learn ${skill ?? "something new"}.`,
          look ? `Here is the look I want for my screens:\n${look}` : "",
          "Follow the learn-any-skill skill: if I gave you a look, turn it into a theme (draft_theme, validate_theme, set_theme) first. Then call get_capabilities, decide which engines this skill needs, write the skill model and call validate_skill_model until it passes. Then run onboarding with start_intake and keep every explanation visual: call a render_* tool before explaining anything, at most two sentences between visuals."
        ]
          .filter(Boolean)
          .join("\n")
      )
  );
  server.registerPrompt("las-session", { title: "Today's session", description: "Run today's session for a skill", argsSchema: { sk: z.string().optional().describe("Enrollment id or skill name") } }, ({ sk }) => {
    const e = sk ? ctx.store.resolveEnrollment(sk) : ctx.store.listEnrollments()[0];
    return msg(`Let's practice${e ? ` ${ctx.store.getSkillModel(e.skillModelId)?.model.name ?? ""}`.replace(/\s+$/, "") : ""}. Call get_today for ${e ? e.id : "my skill"}, then next_session, and walk me through it block by block with visuals. Grade only from get_analysis and quote its evidence. One fix at a time, plus one thing done well. End with get_session_summary.`);
  });
  server.registerPrompt("las-weekly-review", { title: "Weekly review", description: "A five-minute weekly review with visuals", argsSchema: { sk: z.string().optional() } }, ({ sk }) =>
    msg(`Run my weekly review${sk ? ` for ${sk}` : ""}: call get_progress and get_today, show progress against the plan, the practice mix actual vs planned, the top mistake and next week's plan, all as visuals. Ask whether the ladder feels right. If I'm behind or ahead, offer replan options and let me choose; never change the plan silently.`)
  );
  server.registerPrompt("las-stuck", { title: "Stuck or unmotivated", description: "A plateau or motivation conversation", argsSchema: { sk: z.string().optional() } }, ({ sk }) =>
    msg(`I feel stuck${sk ? ` with ${sk}` : ""}. Read las://learner/profile and get_progress, then talk to my why (not guilt): look for a plateau in the key metrics, offer variation, a lighter week, a smaller goal or a pause, and use replan for whatever I choose. No countdowns, no streak talk.`)
  );
}
