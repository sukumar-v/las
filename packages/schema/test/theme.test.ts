import { describe, expect, it } from "vitest";
import { BASE_THEME, validateTheme, mergeTheme, contrast, seriesDistinguishability, ThemeSchema } from "../src/index.js";

describe("theme validation", () => {
  it("passes the base theme in both modes", () => {
    const r = validateTheme(BASE_THEME);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.report.light["ink/bg"]).toBeGreaterThan(4.5);
    expect(r.report.dark["ink/bg"]).toBeGreaterThan(4.5);
  });
  it("merges a partial theme over the base", () => {
    const t = mergeTheme({ name: "Paper", tokens: { color: { accent: "#2F5D8A" } }, components: { card: "hard-shadow" } });
    expect(t.tokens.color.accent).toBe("#2F5D8A");
    expect(t.tokens.color.bg).toBe(BASE_THEME.tokens.color.bg);
    expect(t.components.card).toBe("hard-shadow");
    expect(t.components.button).toBe(BASE_THEME.components.button);
    expect(ThemeSchema.safeParse(t).success).toBe(true);
  });
  it("keeps a single-mode theme's own colors: the base dark block does not leak in", () => {
    const night = { bg: "#0A0C0A", surface: "#111511", ink: "#D7FFD9", muted: "#8FBF95", line: "#2D4A31", accent: "#5CFF7F", on_accent: "#04130A", focus: "#5CFF7F", good: "#5CFF7F", warn: "#FFD75C", bad: "#FF6B6B", data: ["#5CFF7F", "#FFD75C", "#5CD9FF", "#FF8BD1", "#2DD4BF"] };
    const t = mergeTheme({ name: "Night", modes: ["dark"], tokens: { color: night } });
    expect(t.dark).toBeUndefined();
    expect(t.tokens.color.accent).toBe("#5CFF7F");
    // a second merge (what validate_theme does with the stored draft) changes nothing
    expect(mergeTheme(t)).toEqual(t);
    // the dark-mode checks run against the theme's own colors, not the base theme's dark palette
    const r = validateTheme(t);
    expect(r.ok, r.errors.map((e) => e.message).join("; ")).toBe(true);
    expect(r.report.dark["ink/bg"]).toBeCloseTo(contrast(night.ink, night.bg), 2);
    expect(r.report.light).toBeUndefined();
    // an empty `dark` object is not a dark block of its own
    expect(mergeTheme({ name: "Night", modes: ["dark"], dark: {}, tokens: { color: night } }).dark).toBeUndefined();
    // a dark-only theme that brings its own dark block keeps exactly that; the base's dark colors don't fill its gaps
    const own = mergeTheme({ name: "Night", modes: ["dark"], dark: { color: { accent: "#39FF88" } }, tokens: { color: night } });
    expect(own.dark).toEqual({ color: { accent: "#39FF88" } });
    // light-only themes drop the dark block too; two-mode themes keep the base one
    expect(mergeTheme({ name: "Day", modes: ["light"] }).dark).toBeUndefined();
    expect(mergeTheme({ name: "Both", modes: ["light", "dark"] }).dark).toEqual(BASE_THEME.dark);
    expect(mergeTheme({ name: "Default" }).dark).toEqual(BASE_THEME.dark);
  });
  it("fails low contrast and suggests a fix that passes", () => {
    const t = mergeTheme({ name: "Faint", modes: ["light"], tokens: { color: { muted: "#BBBBBB", good: "#9FE2B3", focus: "#DDDDDD" } } });
    const r = validateTheme(t);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.check === "contrast" && e.path.endsWith("muted"))).toBe(true);
    expect(r.errors.some((e) => e.check === "evaluation-colors")).toBe(true);
    expect(r.errors.some((e) => e.check === "focus")).toBe(true);
    const fix = r.fixes.find((f) => f.path === "tokens.color.muted")!;
    expect(contrast(fix.to as string, t.tokens.color.bg)).toBeGreaterThanOrEqual(4.5);
    expect(r.fixedOk).toBe(true);
  });
  it("catches data series that collapse under color blindness", () => {
    const t = mergeTheme({ name: "RG", modes: ["light"], tokens: { color: { data: ["#D7263D", "#1B8A2F", "#1D4ED8", "#7E22CE", "#52525B"] } } });
    const dist = seriesDistinguishability(t.tokens.color.data);
    expect(dist.find((d) => d.kind === "protan")!.min).toBeLessThan(60);
    const r = validateTheme(t);
    expect(r.errors.some((e) => e.check === "series")).toBe(true);
    expect(r.fixedOk).toBe(true);
  });
  it("requires allowed font licenses and caps motion", () => {
    const t = mergeTheme({ name: "Odd", tokens: { type: { display: { family: "Proprietary Sans", fallback: "serif", license: "custom" as any } } }, motion: { duration_ms: 900 } });
    const r = validateTheme(t);
    expect(r.errors.map((e) => e.check)).toContain("schema");
    const t2 = mergeTheme({ name: "Slow", motion: { duration_ms: 900 }, tokens: { type: { body: { family: "Literata", fallback: "serif", license: "OFL-1.1" } } } });
    const r2 = validateTheme(t2);
    expect(r2.errors.some((e) => e.check === "motion")).toBe(true);
    expect(r2.errors.some((e) => e.check === "fonts" && /source/.test(e.message))).toBe(true);
    expect(r2.fixedOk).toBe(true);
  });
  it("rejects variants off the menu", () => {
    expect(ThemeSchema.safeParse(mergeTheme({ name: "x", components: { card: "neon" as any } })).success).toBe(false);
  });
});
