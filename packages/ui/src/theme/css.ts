import { BASE_THEME, type ColorTokens, type Theme, type ThemeMode } from "@las/schema";

/**
 * Turns a theme into CSS custom properties and data attributes.
 * Components reference only `var(--las-*)` and `[data-*]` variants; this file is the one place
 * where token values become CSS.
 */
export const VARIANT_ATTRS = ["card", "button", "chip", "tile", "progress", "route", "meter"] as const;

function colorVars(c: ColorTokens | (Partial<ColorTokens> & { data?: string[] }), prefix = "--las-color-"): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(c)) {
    if (v === undefined) continue;
    if (k === "data") (v as string[]).forEach((hex, i) => out.push(`${prefix}data-${i}: ${hex};`));
    else out.push(`${prefix}${k.replace(/_/g, "-")}: ${v};`);
  }
  return out;
}

export function fontStack(f: { family: string; fallback: string }): string {
  const fam = /[\s'"]/.test(f.family) ? `"${f.family.replace(/"/g, "")}"` : f.family;
  return f.fallback.split(",").map((s) => s.trim()).includes(f.family) ? f.fallback : `${fam}, ${f.fallback}`;
}

/** The variables for the light (or only) mode. */
export function themeVars(theme: Theme): string[] {
  const t = theme.tokens;
  const vars: string[] = [...colorVars(t.color)];
  vars.push(`--las-font-display: ${fontStack(t.type.display)};`, `--las-font-body: ${fontStack(t.type.body)};`, `--las-font-mono: ${fontStack(t.type.mono)};`);
  vars.push(`--las-weight-display: ${t.type.display.weight ?? 700};`, `--las-weight-body: ${t.type.body.weight ?? 400};`, `--las-weight-bold: ${Math.min(900, (t.type.body.weight ?? 400) + 300)};`);
  t.type.scale.forEach((s, i) => vars.push(`--las-text-${i}: ${s}px;`));
  vars.push(`--las-line-height: ${t.type.line_height};`);
  t.space.forEach((s, i) => vars.push(`--las-space-${i}: ${s}px;`));
  for (const [k, v] of Object.entries(t.radius)) vars.push(`--las-radius-${k}: ${v}px;`);
  vars.push(`--las-border-width: ${t.border.width}px;`, `--las-border-style: ${t.border.style};`);
  vars.push(`--las-shadow-card: ${t.shadow.card};`, `--las-shadow-raised: ${t.shadow.raised};`);
  const densityPad = t.density === "compact" ? t.space[1] : t.density === "roomy" ? t.space[3] : t.space[2];
  vars.push(`--las-pad: ${densityPad}px;`, `--las-gap: ${t.density === "compact" ? t.space[1] : t.density === "roomy" ? t.space[3] : t.space[2]}px;`, `--las-tap: 44px;`);
  vars.push(`--las-motion-duration: ${theme.motion.personality === "none" ? 0 : theme.motion.duration_ms}ms;`, `--las-motion-easing: ${theme.motion.easing};`);
  vars.push(`--las-figure-stroke: ${theme.figures.stroke}px;`, `--las-figure-linejoin: ${theme.figures.corner === "round" ? "round" : theme.figures.corner === "bevel" ? "bevel" : "miter"};`, `--las-figure-linecap: ${theme.figures.corner === "round" ? "round" : "butt"};`);
  const role = (r: string) => (r.startsWith("data.") ? `var(--las-color-data-${r.slice(5)})` : `var(--las-color-${r.replace(/_/g, "-")})`);
  vars.push(`--las-overlay-good: ${role(theme.figures.overlay.good)};`, `--las-overlay-attention: ${role(theme.figures.overlay.attention)};`, `--las-overlay-reference: ${role(theme.figures.overlay.reference)};`, `--las-overlay-neutral: ${role(theme.figures.overlay.neutral)};`);
  vars.push(`--las-texture-strength: ${theme.texture.kind === "none" ? 0 : theme.texture.strength};`);
  vars.push(`--las-max-width: 480px;`);
  return vars;
}

export function darkVars(theme: Theme): string[] {
  if (!theme.dark) return [];
  const out = colorVars(theme.dark.color as any);
  if (theme.dark.shadow?.card) out.push(`--las-shadow-card: ${theme.dark.shadow.card};`);
  if (theme.dark.shadow?.raised) out.push(`--las-shadow-raised: ${theme.dark.shadow.raised};`);
  return out;
}

/** A stylesheet that applies the theme to a root element (default :root). */
export function themeToCss(theme: Theme, selector = ":root"): string {
  const light = themeVars(theme);
  const dark = darkVars(theme);
  const onlyDark = theme.modes.length === 1 && theme.modes[0] === "dark";
  const parts = [`${selector} { ${light.join(" ")} color-scheme: ${onlyDark ? "dark" : theme.modes.includes("dark") ? "light dark" : "light"}; }`];
  if (dark.length && theme.modes.includes("dark")) {
    parts.push(`@media (prefers-color-scheme: dark) { ${selector}:not([data-mode="light"]) { ${dark.join(" ")} color-scheme: dark; } }`);
    parts.push(`${selector}[data-mode="dark"] { ${dark.join(" ")} color-scheme: dark; }`);
  }
  const fonts = fontLinks(theme);
  return [...fonts.map((f) => `@import url("${f}");`), ...parts].join("\n");
}

/** Local font cache URLs for fonts that need loading (system fonts need none). */
export function fontLinks(theme: Theme, base = "/api/fonts"): string[] {
  const out = new Set<string>();
  for (const role of ["display", "body", "mono"] as const) {
    const f = theme.tokens.type[role];
    if (f.license !== "system" && f.source) out.add(`${base}/${encodeURIComponent(f.family.replace(/[^\w-]+/g, "_"))}/font.css`);
  }
  return [...out];
}

/** Data attributes that select component variants and other treatments. */
export function themeAttrs(theme: Theme): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const k of VARIANT_ATTRS) attrs[`data-${k}`] = theme.components[k];
  attrs["data-motion"] = theme.motion.personality;
  attrs["data-texture"] = theme.texture.kind;
  attrs["data-density"] = theme.tokens.density;
  attrs["data-figure-fill"] = theme.figures.fill;
  attrs["data-voice"] = theme.voice;
  attrs["data-modes"] = theme.modes.join(" ");
  return attrs;
}

/** Applies the theme to a live document: variables on the root, variant attributes, and a <style> for dark mode. */
export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement, mode?: ThemeMode): void {
  const id = "las-theme";
  let style = root.ownerDocument.getElementById(id) as HTMLStyleElement | null;
  if (!style) {
    style = root.ownerDocument.createElement("style");
    style.id = id;
    root.ownerDocument.head.appendChild(style);
  }
  style.textContent = themeToCss(theme, root === root.ownerDocument.documentElement ? ":root" : `[data-las-root="${root.dataset.lasRoot ?? "app"}"]`);
  for (const [k, v] of Object.entries(themeAttrs(theme))) root.setAttribute(k, v);
  if (mode) root.setAttribute("data-mode", mode);
  else if (theme.modes.length === 1) root.setAttribute("data-mode", theme.modes[0]);
  else root.removeAttribute("data-mode");
  root.setAttribute("data-theme-id", theme.id ?? "draft");
}

export { BASE_THEME };
