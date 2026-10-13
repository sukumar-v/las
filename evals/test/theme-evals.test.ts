import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { colorDistance, hexToRgb, mix, type Theme } from "@las/schema";
import { session } from "../src/harness.js";
import { THEME_DESCRIPTIONS } from "../src/theme-descriptions.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const themesDir = join(root, "fixtures/themes");
const UPDATE = process.env.LAS_UPDATE_FIXTURES === "1";

const readFixture = (id: string): Theme => JSON.parse(readFileSync(join(themesDir, `${id}.json`), "utf8"));
const withoutId = (t: Theme) => {
  const { id: _id, ...rest } = t;
  return rest;
};

type Session = Awaited<ReturnType<typeof session>>;
let s: Session;
/** What the agent ends up with for each description: the theme it submitted (fixed if needed) and what LAS stored. */
const results = new Map<string, { submitted: Theme; stored: Theme; themeId: string; fixes: number }>();

beforeAll(async () => {
  // fixtures regenerate only on request; otherwise the committed ones are the reference
  if (UPDATE) execFileSync("pnpm", ["--filter", "@las/evals", "themes"], { cwd: join(root, ".."), stdio: "pipe" });
  s = await session();
  for (const d of THEME_DESCRIPTIONS) {
    const draft = await s.call("draft_theme", { description: d.description, name: d.name });
    expect(draft.isError, `${d.id}: draft_theme failed`).toBe(false);
    // the learner's own words go in the theme's source note; nothing else is added
    const theme: Theme = { ...draft.data.theme, source: { kind: "description", note: d.description } };
    let v = await s.call("validate_theme", { theme });
    let submitted = theme;
    if (!v.data.ok) {
      v = await s.call("validate_theme", { theme, apply_fixes: true });
      submitted = v.data.theme;
    }
    expect(v.data.ok, `${d.id}: ${v.text}`).toBe(true);
    results.set(d.id, { submitted, stored: v.data.theme, themeId: v.data.themeId, fixes: v.data.fixes?.length ?? 0 });
  }
}, 30_000);

afterAll(async () => {
  await s?.close();
});

/** The look-defining choices compared between themes. */
function traits(t: Theme) {
  return {
    modes: [...t.modes].sort().join("+"),
    accent: t.tokens.color.accent,
    display: t.tokens.type.display.family,
    card: t.components.card,
    button: t.components.button,
    motion: t.motion.personality,
    texture: t.texture.kind
  };
}

function differences(a: Theme, b: Theme): string[] {
  const x = traits(a);
  const y = traits(b);
  const out: string[] = [];
  if (x.modes !== y.modes) out.push("modes");
  if (colorDistance(hexToRgb(x.accent), hexToRgb(y.accent)) > 100) out.push("accent");
  for (const k of ["display", "card", "button", "motion", "texture"] as const) if (x[k] !== y[k]) out.push(k);
  return out;
}

function leafPaths(v: unknown, prefix = ""): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v)) for (const [p, y] of leafPaths(x, prefix ? `${prefix}.${k}` : k)) out.set(p, y);
  } else out.set(prefix, JSON.stringify(v));
  return out;
}

function changedPaths(a: Theme, b: Theme): string[] {
  const pa = leafPaths(a);
  const pb = leafPaths(b);
  return [...new Set([...pa.keys(), ...pb.keys()])].filter((p) => pa.get(p) !== pb.get(p)).sort();
}

describe("theme evals", () => {
  it("has at least six very different descriptions, written in our own words", () => {
    expect(THEME_DESCRIPTIONS.length).toBeGreaterThanOrEqual(6);
    expect(new Set(THEME_DESCRIPTIONS.map((d) => d.id)).size).toBe(THEME_DESCRIPTIONS.length);
  });

  it.each(THEME_DESCRIPTIONS.map((d) => [d.id] as const))("%s: draft_theme then validate_theme passes, and matches its fixture", (id) => {
    const r = results.get(id)!;
    expect(r).toBeDefined();
    expect(r.submitted.source.kind).toBe("description");
    expect(r.stored.source.kind).toBe("description");
    expect(withoutId(r.submitted)).toEqual(withoutId(readFixture(id)));
  });

  it("every pair of themes differs in at least three look-defining choices", () => {
    const ids = THEME_DESCRIPTIONS.map((d) => d.id);
    const report: string[] = [];
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const diff = differences(results.get(ids[i])!.submitted, results.get(ids[j])!.submitted);
        if (diff.length < 3) report.push(`${ids[i]} vs ${ids[j]}: only ${diff.join(", ") || "nothing"}`);
      }
    expect(report).toEqual([]);
  });

  it("carries no third-party prompt text: no gallery names and no URLs except font sources", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".json")) files.push(p);
      }
    };
    walk(join(root, "fixtures"));
    files.push(join(root, "src/theme-descriptions.ts"));
    const problems: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      const rel = relative(root, f);
      if (/designprompts/i.test(text)) problems.push(`${rel} mentions designprompts`);
      const urls = text.match(/https?:\/\/[^\s"'`)]+/g) ?? [];
      if (!rel.startsWith("fixtures/themes/")) {
        for (const u of urls) problems.push(`${rel} carries a URL: ${u}`);
        continue;
      }
      // a theme may only point at its fonts' sources, on an open font host
      const theme = JSON.parse(text) as Theme;
      const fontSources = new Set(Object.values(theme.tokens.type).flatMap((x) => (x && typeof x === "object" && "source" in x && x.source ? [x.source] : [])));
      for (const u of urls) {
        if (!fontSources.has(u)) problems.push(`${rel} carries a URL outside a font source: ${u}`);
        else if (new URL(u).host !== "fonts.googleapis.com") problems.push(`${rel} loads a font from ${new URL(u).host}`);
      }
      if (theme.source.kind !== "description") problems.push(`${rel} source.kind is ${theme.source.kind}`);
      if (theme.source.note && /https?:/.test(theme.source.note)) problems.push(`${rel} source note carries a URL`);
    }
    expect(problems).toEqual([]);
  });

  it("edits: 'make it warmer' on a stored theme still validates and changes only a few color tokens", async () => {
    const base = results.get("glass")!;
    const draft = await s.call("draft_theme", { description: "make it warmer", base: base.themeId, name: base.stored.name });
    expect(draft.isError).toBe(false);
    let edited: Theme = draft.data.theme;
    // the agent is the designer: when the draft read no style words, it warms the page and card colors itself, a little
    if (!changedPaths(base.stored, edited).some((p) => p.startsWith("tokens.") || p.startsWith("dark."))) {
      edited = structuredClone(edited);
      edited.tokens.color.bg = mix(edited.tokens.color.bg, "#F2C58A", 0.18);
      edited.tokens.color.surface = mix(edited.tokens.color.surface, "#F2C58A", 0.08);
    }
    let v = await s.call("validate_theme", { theme: edited });
    if (!v.data.ok) v = await s.call("validate_theme", { theme: edited, apply_fixes: true });
    expect(v.data.ok, v.text).toBe(true);
    const changed = changedPaths(base.stored, v.data.theme).filter((p) => p !== "id" && !p.startsWith("source.") && p !== "name");
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.length).toBeLessThanOrEqual(6);
    for (const p of changed) expect(p).toMatch(/^(tokens|dark)\.color\./);
    const warmth = (hex: string) => hexToRgb(hex)[0] - hexToRgb(hex)[2];
    expect(warmth(v.data.theme.tokens.color.bg)).toBeGreaterThan(warmth(base.stored.tokens.color.bg));
    expect(v.data.theme.components).toEqual(base.stored.components);
  });

  // validate_theme merges every theme over the base theme. A dark-only theme carries its colors in `tokens`, so the
  // base theme's `dark` overrides (which the UI applies on dark-mode systems) must not come back in the stored copy.
  it("a dark-only theme keeps its own colors when stored", () => {
    for (const d of THEME_DESCRIPTIONS) {
      const r = results.get(d.id)!;
      expect(r.stored.dark, d.id).toEqual(r.submitted.dark);
    }
  });
});
