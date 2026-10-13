import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BASE_THEME, ThemeSchema, validateTheme, mergeTheme } from "@las/schema";
import type { LasContext } from "../../context.js";
import { activeTheme, cacheThemeFonts, draftTheme } from "../../core/theme.js";
import { ok, fail } from "../result.js";
import { view } from "../widgets.js";

export function registerThemeTools(server: McpServer, ctx: LasContext): void {
  server.registerTool(
    "draft_theme",
    {
      title: "Draft a theme from what the learner brought",
      description: "Turns a pasted design prompt, a description, your reading of a screenshot (as text), or a tokens file into a theme draft. Returns the theme plus notes on how the input was read. Refine it (you are the designer), then call validate_theme. For edits like 'make it warmer', pass the current theme id as base.",
      inputSchema: {
        prompt: z.string().max(8000).optional().describe("A design prompt pasted by the learner (from a gallery or a DESIGN.md)"),
        description: z.string().max(2000).optional().describe("A description in words"),
        image_notes: z.string().max(2000).optional().describe("What you see in the learner's screenshot: colors, fonts, shapes, density, mood"),
        tokens: z.union([z.string(), z.record(z.string(), z.unknown())]).optional().describe("A tokens file: W3C design tokens JSON, CSS custom properties or a Tailwind config"),
        name: z.string().max(40).optional(),
        base: z.string().optional().describe("Theme id to edit; omit to start from the base theme")
      }
    },
    async (input) => {
      let base = undefined;
      if (input.base) {
        const row = input.base === "base" ? { theme: BASE_THEME } : ctx.store.getTheme(input.base);
        if (!row) return fail(`Unknown theme "${input.base}"`);
        base = row.theme;
      }
      const d = draftTheme({ ...input, base });
      const text = [`Draft theme "${d.theme.name}" (${d.theme.modes.join("+")}).`, `How it was read: ${d.notes.join("; ")}.`, d.questions.length ? `If the learner is around, you could ask: ${d.questions.join(" ")}` : "", "Adjust tokens and component variants as the input calls for, then call validate_theme."].filter(Boolean);
      return ok(text.join("\n"), { theme: d.theme as any, notes: d.notes, questions: d.questions });
    }
  );

  server.registerTool(
    "validate_theme",
    {
      title: "Validate a theme",
      description: "Checks contrast (WCAG AA in every mode), evaluation colors, color-blind-safe chart series, focus ring, touch targets, motion caps, font licenses and assets. Each failure comes with a suggested fix and a fixed copy of the theme. Stores the theme when it passes (or when you pass apply_fixes and the fixed theme passes).",
      inputSchema: { theme: z.record(z.string(), z.unknown()).describe("A full theme, or a partial one merged over the base theme"), apply_fixes: z.boolean().optional().describe("Store the fixed theme when the original fails but the fixes pass") }
    },
    async ({ theme, apply_fixes }) => {
      const merged = mergeTheme(theme);
      const r = validateTheme(merged);
      const learner = ctx.store.getOrCreateLearner();
      if (r.ok) {
        const row = ctx.store.saveTheme(learner.id, merged, true);
        return ok(`Theme "${row.name}" passes every check. Stored as ${row.id}. Next: preview_theme or set_theme.`, { ok: true, themeId: row.id, report: r.report, theme: row.theme as any });
      }
      if (apply_fixes && r.fixedOk && r.fixed) {
        const row = ctx.store.saveTheme(learner.id, r.fixed, true);
        return ok(`Theme "${row.name}" passes after ${r.fixes.length} fix(es): ${r.fixes.map((f) => `${f.path} -> ${JSON.stringify(f.to)} (${f.why})`).join("; ")}. Stored as ${row.id}.`, { ok: true, themeId: row.id, fixes: r.fixes, errors: r.errors, report: r.report, theme: row.theme as any });
      }
      return fail(`${r.errors.length} issue(s):\n${r.errors.map((e) => `- ${e.path}${e.mode ? ` [${e.mode}]` : ""}: ${e.message}`).join("\n")}\nSuggested fixes:\n${r.fixes.map((f) => `- ${f.path}: ${JSON.stringify(f.from)} -> ${JSON.stringify(f.to)} (${f.why})`).join("\n") || "- none"}\n${r.fixedOk ? "Calling validate_theme again with apply_fixes: true stores the fixed theme." : "Some issues need a different choice; adjust and resubmit."}`, { ok: false, errors: r.errors, fixes: r.fixes, fixed: r.fixed as any, fixedOk: r.fixedOk, report: r.report });
    }
  );

  server.registerTool(
    "preview_theme",
    {
      title: "Preview a theme on the learner's own screens",
      description: "Shows Today, a lesson card and a feedback card in the given theme, using this learner's real data when they have an enrollment.",
      inputSchema: { theme: z.string().describe("Theme id, or 'base'"), screen: z.enum(["today", "lesson", "feedback", "onboarding", "progress", "all"]).optional(), sk: z.string().optional() }
    },
    async ({ theme, screen, sk }) => {
      const row = theme === "base" ? { id: "base", theme: BASE_THEME, name: BASE_THEME.name } : ctx.store.getTheme(theme);
      if (!row) return fail(`Unknown theme "${theme}"`);
      const e = sk ? ctx.store.resolveEnrollment(sk) : ctx.store.listEnrollments()[0];
      const model = e ? ctx.store.getSkillModel(e.skillModelId)?.model : undefined;
      const sample = {
        skill: model?.name ?? "Your skill",
        milestone: e ? ctx.store.activeMilestone(e.id)?.title ?? "Your first milestone" : "Your first milestone",
        nextSession: model?.nodes[0]?.name ?? "Session 1",
        ladder: model?.ladder.map((s) => s.label) ?? ["Brand new", "First steps", "Basics down", "First real result", "Comfortable"],
        lessonCard: model?.lessons[0]?.cards[0] ?? { type: "predict", text: "Which hip position puts less weight on your arms?", options: ["Close to the wall", "Away from the wall"], answer: 0 },
        feedback: { headline: model?.mistakes[0]?.headline ?? "One thing to fix", praise: "One thing done well" }
      };
      return view(ctx, { view: "theme-preview", title: `Preview: ${row.name}`, data: { screen: screen ?? "all", sample, themeId: row.id }, theme: row.theme, text: `Preview of "${row.name}" on ${screen ?? "every"} screen.`, studioPath: `/theme/${row.id}` });
    }
  );

  server.registerTool(
    "set_theme",
    {
      title: "Apply a theme",
      description: "Applies a validated theme everywhere (scope 'all') or to one skill (scope = the enrollment id). Caches the theme's fonts locally; when a font can't be fetched, its fallback stack is used.",
      inputSchema: { themeId: z.string().describe("A stored theme id, or 'base'"), scope: z.string().default("all").describe("'all' or an enrollment id (sk)") }
    },
    async ({ themeId, scope }) => {
      const learner = ctx.store.getOrCreateLearner();
      const enrollment = scope === "all" ? null : ctx.store.resolveEnrollment(scope);
      if (scope !== "all" && !enrollment) return fail(`Unknown skill "${scope}"`);
      if (themeId === "base") {
        ctx.store.clearThemeScope(learner.id, enrollment?.id ?? null);
        ctx.emit("theme.changed", { themeId: "base", scope });
        return ok(`Base theme applied to ${scope === "all" ? "everything" : enrollment!.id}.`, { themeId: "base", scope });
      }
      const row = ctx.store.getTheme(themeId);
      if (!row) return fail(`Unknown theme "${themeId}". validate_theme stores themes.`);
      if (!row.validatedAt) return fail(`Theme "${themeId}" never passed validation and can't be applied.`);
      const fonts = await cacheThemeFonts(ctx, row.theme);
      ctx.store.setThemeScope(learner.id, row.id, enrollment?.id ?? null);
      ctx.store.logEvent(enrollment?.id ?? null, "theme.changed", { themeId: row.id, scope });
      ctx.emit("theme.changed", { themeId: row.id, scope });
      const fontNote = fonts.filter((f) => f.error).map((f) => `${f.family}: not cached (${f.error}); the fallback stack is used`).join("; ");
      return ok(`Theme "${row.name}" applied to ${scope === "all" ? "everything" : enrollment!.id}.${fontNote ? ` Fonts: ${fontNote}.` : ""}`, { themeId: row.id, scope, fonts: fonts as any });
    }
  );

  server.registerTool(
    "get_theme",
    {
      title: "The active theme",
      description: "The theme in use for everything, or for one skill when sk is given.",
      inputSchema: { sk: z.string().optional() }
    },
    async ({ sk }) => {
      const e = sk ? ctx.store.resolveEnrollment(sk) : undefined;
      const t = activeTheme(ctx, e?.id);
      const parsed = ThemeSchema.safeParse(t.theme);
      return ok(`Active theme: "${t.theme.name}" (${t.id}, scope ${t.scope}, modes ${t.theme.modes.join("+")}).`, { themeId: t.id, scope: t.scope, theme: (parsed.success ? parsed.data : t.theme) as any, available: ctx.store.listThemes(ctx.store.getOrCreateLearner().id).map((r) => ({ id: r.id, name: r.name, validated: !!r.validatedAt })) });
    }
  );
}
