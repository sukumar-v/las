import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect } from "./helpers.js";
import { minimalModel } from "../../schema/test/fixtures/minimal-model.js";

describe("MCP server", () => {
  let s: Awaited<ReturnType<typeof connect>>;
  beforeAll(async () => {
    s = await connect();
  }, 30000);
  afterAll(async () => {
    await s.close();
  });

  it("lists the skill and theme tools, resources and prompts", async () => {
    const tools = (await s.client.listTools()).tools.map((t) => t.name);
    for (const t of ["get_capabilities", "draft_skill_model", "validate_skill_model", "get_skill_model", "draft_theme", "validate_theme", "preview_theme", "set_theme", "get_theme"]) expect(tools).toContain(t);
    const prompts = (await s.client.listPrompts()).prompts.map((p) => p.name);
    expect(prompts).toEqual(expect.arrayContaining(["las-start", "las-session", "las-weekly-review", "las-stuck"]));
    const resources = (await s.client.listResources()).resources.map((r) => r.uri);
    expect(resources).toContain("las://learner/profile");
    expect(resources).toContain("ui://las/view.html");
    const templates = (await s.client.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate);
    expect(templates).toEqual(expect.arrayContaining(["las://skills/{sk}/route", "las://skills/{sk}/progress", "las://skills/{sk}/mistakes", "las://skills/{sk}/model", "las://packs/{pack}"]));
  });

  it("reports capabilities with every engine and real toolchains", async () => {
    const r = await s.call("get_capabilities");
    expect(r.isError).toBe(false);
    expect(r.data.data.engines.map((e: any) => e.id)).toEqual(["movement", "audio", "speech", "code", "visual", "knowledge", "interaction", "sensor", "game", "self-report"]);
    expect(r.data.data.runners.browser).toContain("python");
    expect(r.data.data.runners.local.some((l: any) => l.language === "javascript")).toBe(true);
    expect(r.text).toMatch(/Engines available/);
    expect(r.meta?.ui?.resourceUri).toBe("ui://las/view.html");
  }, 30000);

  it("drafts, validates and stores a skill model, then reads it back", async () => {
    const d = await s.call("draft_skill_model", { skill: "test skill", notes: "wants to practice at home" });
    expect(d.isError).toBe(false);
    expect(d.data.availableEngines).toContain("movement");
    expect(d.data.startFrom).toBeUndefined();
    expect(d.text).toMatch(/Rules:/);
    const bad = await s.call("validate_skill_model", { model: { skill: "x" } });
    expect(bad.isError).toBe(true);
    expect(bad.data.ok).toBe(false);
    const good = await s.call("validate_skill_model", { model: minimalModel() });
    expect(good.isError).toBe(false);
    expect(good.data.stored.id).toMatch(/^skm_/);
    const again = await s.call("draft_skill_model", { skill: "Test skill" });
    expect(again.data.startFrom?.kind).toBe("previous");
    const got = await s.call("get_skill_model", { skill: "test skill" });
    expect(got.data.model.name).toBe("Test skill");
    const res = await s.client.readResource({ uri: `las://skills/${good.data.stored.id}/model` });
    expect(JSON.parse((res.contents[0] as any).text).model.name).toBe("Test skill");
  }, 30000);

  it("drafts a theme from a description, validates it and applies it", async () => {
    const d = await s.call("draft_theme", { description: "dark and neon, like an arcade", name: "Arcade" });
    expect(d.isError).toBe(false);
    expect(d.data.theme.modes).toEqual(["dark"]);
    expect(d.data.notes.join(" ")).toMatch(/neon/);
    const v = await s.call("validate_theme", { theme: d.data.theme });
    expect(v.isError).toBe(false);
    const themeId = v.data.themeId;
    const bad = await s.call("validate_theme", { theme: { name: "Faint", modes: ["light"], tokens: { color: { muted: "#CCCCCC" } } } });
    expect(bad.isError).toBe(true);
    expect(bad.data.fixes.length).toBeGreaterThan(0);
    const fixed = await s.call("validate_theme", { theme: { name: "Faint", modes: ["light"], tokens: { color: { muted: "#CCCCCC" } } }, apply_fixes: true });
    expect(fixed.isError).toBe(false);
    const set = await s.call("set_theme", { themeId, scope: "all" });
    expect(set.isError).toBe(false);
    const get = await s.call("get_theme");
    expect(get.data.themeId).toBe(themeId);
    expect(get.data.theme.name).toBe("Arcade");
    const prev = await s.call("preview_theme", { theme: themeId, screen: "today" });
    expect(prev.data.view).toBe("theme-preview");
    expect(prev.data.theme.name).toBe("Arcade");
    expect(prev.text).toMatch(/Open in the studio/);
    const base = await s.call("set_theme", { themeId: "base" });
    expect(base.isError).toBe(false);
    expect((await s.call("get_theme")).data.themeId).toBe("base");
  });

  it("maps a tokens file onto theme roles", async () => {
    const d = await s.call("draft_theme", { tokens: ":root { --background: #101014; --foreground: #f1f1f1; --primary: #ff6a00; --border: #333; --font-heading: 'Space Grotesk', sans-serif; --radius: 12px; }", name: "Tokens" });
    expect(d.data.theme.tokens.color.accent).toBe("#FF6A00");
    expect(d.data.theme.tokens.color.ink).toBe("#F1F1F1");
    expect(d.data.theme.tokens.type.display.family).toBe("Space Grotesk");
    expect(d.data.theme.tokens.radius.md).toBe(12);
  });

  it("exposes the widget resource", async () => {
    const r = await s.client.readResource({ uri: "ui://las/view.html" });
    expect((r.contents[0] as any).mimeType).toBe("text/html;profile=mcp-app");
    expect((r.contents[0] as any).text).toMatch(/--las-color-bg/);
  });
});

describe("widget negotiation", () => {
  it("drops the studio link text when the client renders MCP Apps", async () => {
    const s = await connect({ widgets: true });
    const r = await s.call("get_capabilities");
    expect(r.data.data.widgets).toBe(true);
    expect(r.text).not.toMatch(/Open in the studio/);
    await s.close();
  }, 30000);
});
