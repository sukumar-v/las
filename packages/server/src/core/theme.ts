import { mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BASE_THEME, mergeTheme, validateTheme, type Theme, type ThemeFont, type ThemePatch } from "@las/schema";
import type { LasContext } from "../context.js";

export interface DraftInput {
  prompt?: string;
  description?: string;
  /** the agent's reading of an image, as text; LAS never sees the pixels */
  image_notes?: string;
  tokens?: string | Record<string, unknown>;
  name?: string;
  /** the theme to edit, for "make it warmer" requests */
  base?: Theme;
}

export interface DraftResult {
  theme: Theme;
  patch: ThemePatch;
  notes: string[];
  /** questions the agent may ask the learner when the input was thin */
  questions: string[];
}

/** Keyword rules: a small vocabulary of looks mapped to theme patches. The agent refines the result. */
const RULES: { re: RegExp; note: string; patch: ThemePatch }[] = [
  { re: /\b(dark|night|midnight|black background|arcade)\b/i, note: "dark mode only", patch: { modes: ["dark"], tokens: { color: { bg: "#0E0F13", surface: "#181A20", ink: "#F2F3F5", muted: "#A6ACB8", line: "#30343D", accent: "#8AB4FF", on_accent: "#0B1020", focus: "#8AB4FF", good: "#4ADE80", warn: "#FBBF24", bad: "#F87171", data: ["#8AB4FF", "#FDBA74", "#2DD4BF", "#F9A8D4", "#A1A1AA"] } } } },
  { re: /\bneon|cyber|synthwave|glow\b/i, note: "neon accent on a dark base with a snappy motion personality", patch: { tokens: { color: { accent: "#39FF88", on_accent: "#04130A", focus: "#39FF88", data: ["#39FF88", "#FF4FD8", "#4FD3FF", "#FFE94F", "#C8C8D0"] }, shadow: { card: "none", raised: "0 0 18px rgba(57,255,136,0.35)" } }, components: { button: "square", card: "outlined", chip: "outlined" }, motion: { personality: "snappy", duration_ms: 120 } } },
  { re: /\bbrutal|raw|concrete|harsh|unpolished\b/i, note: "brutalist: square corners, thick borders, hard shadows, mono display", patch: { tokens: { radius: { sm: 0, md: 0, lg: 0, pill: 0 }, border: { width: 3, style: "solid" }, shadow: { card: "none", raised: "6px 6px 0 #000000" }, type: { display: { family: "Space Mono", fallback: "ui-monospace, monospace", weight: 700, license: "OFL-1.1", source: "https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&display=swap" } } }, components: { card: "hard-shadow", button: "square", chip: "tag", tile: "hard-shadow", progress: "steps", route: "timeline", meter: "ticks" }, motion: { personality: "none", duration_ms: 0 } } },
  { re: /\b(serif|editorial|magazine|book|literary|classic|newspaper)\b/i, note: "serif typography", patch: { tokens: { type: { display: { family: "Fraunces", fallback: "Georgia, serif", weight: 600, license: "OFL-1.1", source: "https://fonts.googleapis.com/css2?family=Fraunces:wght@400;600&display=swap" }, body: { family: "Literata", fallback: "Georgia, serif", license: "OFL-1.1", source: "https://fonts.googleapis.com/css2?family=Literata:wght@400;700&display=swap" } }, radius: { sm: 2, md: 4, lg: 6, pill: 999 } }, components: { button: "underline", card: "flat", chip: "tag", route: "timeline" } } },
  { re: /\bmono(chrome|chromatic)?\b|black and white|grayscale|greyscale/i, note: "monochrome palette; data series stay distinguishable by lightness", patch: { tokens: { color: { accent: "#111111", on_accent: "#FFFFFF", focus: "#111111", muted: "#555555", line: "#BBBBBB", good: "#2E6B3A", warn: "#8A5A00", bad: "#9B1C1C", data: ["#111111", "#555555", "#8A8A8A", "#B9B9B9", "#D9D9D9"] } } } },
  { re: /\b(playful|fun|bubbly|rounded|friendly|kids|candy|toy)\b/i, note: "playful: big radii, pill buttons, springy motion", patch: { tokens: { radius: { sm: 10, md: 16, lg: 24, pill: 999 }, color: { accent: "#7C3AED", on_accent: "#FFFFFF", focus: "#7C3AED", data: ["#7C3AED", "#F59E0B", "#10B981", "#EC4899", "#64748B"] } }, components: { card: "raised", button: "pill", chip: "filled", tile: "raised", progress: "dots", route: "path", meter: "ring" }, motion: { personality: "springy", duration_ms: 260, easing: "cubic-bezier(.34,1.56,.64,1)" } } },
  { re: /\b(glass|frosted|translucent|blur|aero)\b/i, note: "glass cards with a soft gradient texture", patch: { components: { card: "glass", tile: "raised", button: "rounded" }, tokens: { shadow: { card: "0 8px 32px rgba(31,38,135,0.15)", raised: "0 12px 40px rgba(31,38,135,0.25)" }, radius: { sm: 8, md: 14, lg: 20, pill: 999 } }, texture: { kind: "gradient", strength: 0.35 } } },
  { re: /\b(high[- ]contrast|accessible|a11y|low vision|bold borders)\b/i, note: "high contrast: pure black on white, thick focus, no texture", patch: { modes: ["light"], tokens: { color: { bg: "#FFFFFF", surface: "#FFFFFF", ink: "#000000", muted: "#1F1F1F", line: "#000000", accent: "#0000D6", on_accent: "#FFFFFF", focus: "#D60000", good: "#006B2E", warn: "#8A4B00", bad: "#B00020", data: ["#0000D6", "#B00020", "#006B2E", "#5B2C8F", "#000000"] }, border: { width: 2, style: "solid" }, type: { scale: [15, 18, 20, 24, 30, 38] } }, components: { card: "outlined", button: "square", chip: "outlined", tile: "outlined", progress: "steps", meter: "ticks" }, texture: { kind: "none", strength: 0 }, motion: { personality: "none", duration_ms: 0 } } },
  { re: /\b(paper|notebook|cozy|warm|cream|parchment|sketch|hand[- ]?drawn)\b/i, note: "warm paper tones with a grain texture", patch: { tokens: { color: { bg: "#F7F3EA", surface: "#FFFDF7", ink: "#22201C", muted: "#5F594F", line: "#D9D1C1", accent: "#2F5D8A", on_accent: "#FFFFFF", focus: "#2F5D8A", good: "#2E7D4F", warn: "#B4541E", bad: "#A3262B", data: ["#2F5D8A", "#C07A1E", "#4E8F5B", "#8C4A7A", "#5E6B78"] }, border: { width: 1.5, style: "solid" }, shadow: { card: "none", raised: "2px 2px 0 #22201C" } }, components: { card: "outlined", button: "square", chip: "outlined", progress: "steps", route: "path", meter: "ticks" }, texture: { kind: "grain", strength: 0.04 } } },
  { re: /\b(terminal|hacker|console|matrix|cli)\b/i, note: "terminal: mono everywhere, square, green on black", patch: { modes: ["dark"], tokens: { color: { bg: "#0A0C0A", surface: "#111511", ink: "#D7FFD9", muted: "#8FBF95", line: "#2D4A31", accent: "#5CFF7F", on_accent: "#04130A", focus: "#5CFF7F", good: "#5CFF7F", warn: "#FFD75C", bad: "#FF6B6B", data: ["#5CFF7F", "#FFD75C", "#5CD9FF", "#FF8BD1", "#A8B5A9"] }, type: { display: { family: "IBM Plex Mono", fallback: "ui-monospace, monospace", weight: 600, license: "OFL-1.1", source: "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&display=swap" }, body: { family: "IBM Plex Mono", fallback: "ui-monospace, monospace", license: "OFL-1.1", source: "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&display=swap" } }, radius: { sm: 0, md: 0, lg: 0, pill: 0 } }, components: { card: "outlined", button: "square", chip: "tag", tile: "outlined", progress: "steps", route: "timeline", meter: "ticks" }, motion: { personality: "none", duration_ms: 0 } } },
  { re: /\b(minimal|clean|calm|quiet|zen|airy|spacious)\b/i, note: "minimal: roomy density, flat cards, subtle motion", patch: { tokens: { density: "roomy", shadow: { card: "none", raised: "none" } }, components: { card: "flat", tile: "flat", button: "rounded", chip: "outlined" }, motion: { personality: "subtle", duration_ms: 200 } } },
  { re: /\b(compact|dense|data[- ]heavy|dashboard)\b/i, note: "compact density", patch: { tokens: { density: "compact" } } },
  { re: /\b(ocean|sea|blue|teal|aqua)\b/i, note: "blue accent", patch: { tokens: { color: { accent: "#0E7490", on_accent: "#FFFFFF", focus: "#0E7490" } } } },
  { re: /\b(forest|green|moss|sage)\b/i, note: "green accent", patch: { tokens: { color: { accent: "#2F6B3A", on_accent: "#FFFFFF", focus: "#2F6B3A" } } } },
  { re: /\b(sunset|orange|amber|coral|terracotta)\b/i, note: "orange accent", patch: { tokens: { color: { accent: "#C2410C", on_accent: "#FFFFFF", focus: "#C2410C" } } } },
  { re: /\b(purple|violet|lavender|plum)\b/i, note: "purple accent", patch: { tokens: { color: { accent: "#6D28D9", on_accent: "#FFFFFF", focus: "#6D28D9" } } } },
  { re: /\b(pink|rose|magenta)\b/i, note: "pink accent", patch: { tokens: { color: { accent: "#BE185D", on_accent: "#FFFFFF", focus: "#BE185D" } } } },
  { re: /\b(red|crimson|scarlet)\b/i, note: "red accent", patch: { tokens: { color: { accent: "#B91C1C", on_accent: "#FFFFFF", focus: "#B91C1C" } } } },
  { re: /\bless rounded|sharper|square(r)?\b/i, note: "edit: sharper corners", patch: { tokens: { radius: { sm: 0, md: 2, lg: 4, pill: 999 } } } },
  { re: /\bmore rounded|softer|rounder\b/i, note: "edit: rounder corners", patch: { tokens: { radius: { sm: 8, md: 14, lg: 20, pill: 999 } } } },
  { re: /\bbigger text|larger text|bigger type\b/i, note: "edit: larger type scale", patch: { tokens: { type: { scale: [15, 18, 20, 24, 30, 36] } } } },
  { re: /\bno (animation|motion)\b|still\b/i, note: "edit: no motion", patch: { motion: { personality: "none", duration_ms: 0 } } }
];

function deepMerge(a: any, b: any): any {
  if (b === undefined) return a;
  if (Array.isArray(a) || Array.isArray(b) || typeof a !== "object" || typeof b !== "object" || a === null || b === null) return b;
  const out: any = { ...a };
  for (const k of Object.keys(b)) out[k] = deepMerge(a[k], b[k]);
  return out;
}

const ROLE_HINTS: [RegExp, string][] = [
  [/^(bg|background|canvas|page|base)$/i, "bg"],
  [/^(surface|card|panel|elevated|paper)$/i, "surface"],
  [/^(ink|text|foreground|fg|on[-_]?surface|body)$/i, "ink"],
  [/^(muted|secondary[-_]?text|subtle|text[-_]?secondary|dim)$/i, "muted"],
  [/^(line|border|divider|outline|stroke)$/i, "line"],
  [/^(accent|primary|brand|cta|interactive|link)$/i, "accent"],
  [/^(on[-_]?accent|on[-_]?primary|primary[-_]?foreground)$/i, "on_accent"],
  [/^(good|success|positive|ok)$/i, "good"],
  [/^(warn|warning|caution)$/i, "warn"],
  [/^(bad|error|danger|destructive|negative)$/i, "bad"],
  [/^(focus|ring)$/i, "focus"]
];

/** Maps a tokens file (W3C design tokens JSON, CSS custom properties, or a Tailwind config) onto theme tokens. */
export function tokensToPatch(input: string | Record<string, unknown>): { patch: ThemePatch; notes: string[] } {
  const notes: string[] = [];
  const color: Record<string, string> = {};
  const data: string[] = [];
  const fonts: Partial<Record<"display" | "body" | "mono", string>> = {};
  let radius: number | undefined;
  const visit = (key: string, value: unknown) => {
    if (typeof value === "string") {
      const hex = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/.exec(value)?.[0];
      const k = key.replace(/^--/, "").replace(/^(color|colors|palette|theme)[-_.]/i, "");
      if (hex) {
        const role = ROLE_HINTS.find(([re]) => re.test(k))?.[1];
        if (role) color[role] = hex.toUpperCase();
        else if (/chart|series|data|categorical/i.test(k)) data.push(hex.toUpperCase());
        return;
      }
      if (/font|family/i.test(k)) {
        const fam = value.split(",")[0].replace(/['"]/g, "").trim();
        if (/mono|code/i.test(k)) fonts.mono = fam;
        else if (/display|heading|title/i.test(k)) fonts.display = fam;
        else fonts.body = fam;
        return;
      }
      if (/radius/i.test(k)) {
        const n = parseFloat(value);
        if (!Number.isNaN(n)) radius = n;
      }
      return;
    }
    if (typeof value === "number") {
      if (/radius/i.test(key)) radius = value;
      return;
    }
    if (value && typeof value === "object") {
      if ("$value" in (value as any)) return visit(key, (value as any).$value);
      if ("value" in (value as any) && Object.keys(value as any).length <= 3) return visit(key, (value as any).value);
      if ("DEFAULT" in (value as any)) visit(key, (value as any).DEFAULT);
      for (const [k2, v2] of Object.entries(value as Record<string, unknown>)) visit(key ? `${key}.${k2}` : k2, v2);
    }
  };
  if (typeof input === "string") {
    const text = input.trim();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    if (parsed && typeof parsed === "object") {
      notes.push("read a JSON tokens file");
      visit("", parsed);
    } else {
      const re = /--([\w-]+)\s*:\s*([^;]+);/g;
      let m: RegExpExecArray | null;
      let n = 0;
      while ((m = re.exec(text))) {
        visit(m[1], m[2].trim());
        n++;
      }
      notes.push(n ? `read ${n} CSS custom properties` : "no tokens recognized in the text");
      const tw = /colors\s*:\s*\{([\s\S]*?)\}\s*,?\s*(?:fontFamily|borderRadius|\})/.exec(text);
      if (tw) {
        const re2 = /['"]?([\w-]+)['"]?\s*:\s*['"](#[0-9a-fA-F]{3,8})['"]/g;
        while ((m = re2.exec(tw[1]))) visit(m[1], m[2]);
        notes.push("read a Tailwind colors block");
      }
    }
  } else {
    notes.push("read a tokens object");
    visit("", input);
  }
  const patch: ThemePatch = { tokens: {} };
  if (Object.keys(color).length) {
    (patch.tokens as any).color = color;
    notes.push(`mapped colors: ${Object.keys(color).join(", ")}`);
  }
  if (data.length >= 3) (patch.tokens as any).color = { ...(patch.tokens as any).color, data: data.slice(0, 8) };
  if (fonts.display || fonts.body || fonts.mono) {
    (patch.tokens as any).type = {};
    for (const role of ["display", "body", "mono"] as const) {
      if (fonts[role]) (patch.tokens as any).type[role] = { family: fonts[role], fallback: role === "mono" ? "ui-monospace, monospace" : "system-ui, sans-serif", license: "OFL-1.1", source: `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fonts[role]!).replace(/%20/g, "+")}&display=swap` };
    }
    notes.push(`fonts: ${Object.values(fonts).join(", ")} (license assumed OFL-1.1; confirm from the font's own license file)`);
  }
  if (radius !== undefined) (patch.tokens as any).radius = { sm: Math.round(radius / 2), md: radius, lg: Math.round(radius * 1.5), pill: 999 };
  return { patch, notes };
}

/** Turns what the learner brought into a draft theme. Heuristic; the agent refines it before validating. */
export function draftTheme(input: DraftInput): DraftResult {
  const text = [input.prompt, input.description, input.image_notes].filter(Boolean).join("\n");
  const notes: string[] = [];
  const questions: string[] = [];
  let patch: ThemePatch = {};
  const sourceKind = input.tokens ? "tokens" : input.prompt ? "prompt" : input.image_notes ? "image" : input.base ? "edit" : "description";
  for (const rule of RULES) {
    if (rule.re.test(text)) {
      patch = deepMerge(patch, rule.patch);
      notes.push(rule.note);
    }
  }
  if (input.tokens) {
    const t = tokensToPatch(input.tokens);
    patch = deepMerge(patch, t.patch);
    notes.push(...t.notes);
  }
  if (!notes.length) {
    notes.push("no known style words found; starting from the base theme");
    questions.push("Light or dark?", "Rounded or sharp corners?", "One word for the mood: calm, playful, serious, bold?");
  }
  const name = input.name ?? ((text.split(/[\n.,;]/)[0] || "Custom").trim().slice(0, 40) || "Custom");
  patch.name = name;
  (patch as any).source = { kind: sourceKind, note: sourceKind === "prompt" ? "Pasted by the learner" : undefined };
  const theme = mergeTheme(patch, input.base ?? BASE_THEME);
  if (theme.modes.length === 1 && theme.modes[0] === "dark" && theme.dark) delete (theme as any).dark;
  if (theme.modes.includes("dark") && theme.modes.length === 1 && !theme.dark) {
    // single dark theme: tokens are the dark tokens
  }
  const v = validateTheme(theme);
  const final = v.ok ? theme : v.fixedOk && v.fixed ? v.fixed : theme;
  if (!v.ok && v.fixedOk) notes.push(`applied ${v.fixes.length} accessibility fix(es)`);
  if (!v.ok && !v.fixedOk) notes.push("the draft still fails validation; see validate_theme");
  return { theme: final, patch, notes, questions };
}

export interface FontCacheStatus {
  role: "display" | "body" | "mono";
  family: string;
  cached: boolean;
  cssPath?: string;
  error?: string;
}

/** Downloads a font family's CSS and files once into the fonts cache. Failure means the fallback stack is used. */
export async function cacheFont(ctx: LasContext, role: "display" | "body" | "mono", font: ThemeFont): Promise<FontCacheStatus> {
  if (font.license === "system" || !font.source) return { role, family: font.family, cached: false };
  const dir = join(ctx.config.fontsDir, font.family.replace(/[^\w-]+/g, "_"));
  const cssPath = join(dir, "font.css");
  if (existsSync(cssPath)) return { role, family: font.family, cached: true, cssPath };
  try {
    mkdirSync(dir, { recursive: true });
    const res = await fetch(font.source, { headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36" }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let css = await res.text();
    const urls = [...css.matchAll(/url\((["']?)(https?:[^)"']+)\1\)/g)].map((m) => m[2]);
    let i = 0;
    for (const u of [...new Set(urls)].slice(0, 24)) {
      const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) continue;
      const ext = (/\.(woff2|woff|ttf|otf)(?:\?|$)/.exec(u)?.[1] ?? "woff2").toLowerCase();
      const file = `f${i++}.${ext}`;
      writeFileSync(join(dir, file), Buffer.from(await r.arrayBuffer()));
      css = css.split(u).join(`./${file}`);
    }
    writeFileSync(cssPath, css);
    return { role, family: font.family, cached: true, cssPath };
  } catch (e) {
    return { role, family: font.family, cached: false, error: (e as Error).message };
  }
}

export async function cacheThemeFonts(ctx: LasContext, theme: Theme): Promise<FontCacheStatus[]> {
  const out: FontCacheStatus[] = [];
  for (const role of ["display", "body", "mono"] as const) out.push(await cacheFont(ctx, role, theme.tokens.type[role]));
  return out;
}

export function readCachedFontCss(ctx: LasContext, family: string): string | undefined {
  const p = join(ctx.config.fontsDir, family.replace(/[^\w-]+/g, "_"), "font.css");
  return existsSync(p) ? readFileSync(p, "utf8") : undefined;
}

/** The theme to use for a learner and optional enrollment: scoped theme, else the base theme. */
export function activeTheme(ctx: LasContext, enrollmentId?: string | null): { theme: Theme; id: string; scope: "skill" | "all" | "base" } {
  const learner = ctx.store.getOrCreateLearner();
  if (enrollmentId) {
    const scoped = ctx.store.activeTheme(learner.id, enrollmentId);
    const all = ctx.store.activeTheme(learner.id, null);
    if (scoped && scoped.id !== all?.id) return { theme: scoped.theme, id: scoped.id, scope: "skill" };
  }
  const all = ctx.store.activeTheme(learner.id, null);
  if (all) return { theme: all.theme, id: all.id, scope: "all" };
  return { theme: BASE_THEME, id: "base", scope: "base" };
}
