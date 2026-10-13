import { BASE_THEME } from "./base.js";
import { adjustForContrast, adjustForContrastAll, contrast, hexToRgb, hslToRgb, isDark, mix, rgbToHex, rgbToHsl, seriesDistinguishability } from "./color.js";
import { COMPONENT_VARIANTS, FONT_LICENSES, ThemeSchema, type ColorTokens, type Theme, type ThemeMode } from "./schema.js";

export interface ThemeIssue {
  /** dotted path into the theme */
  path: string;
  check: "contrast" | "evaluation-colors" | "series" | "focus" | "touch" | "motion" | "fonts" | "assets" | "schema" | "variants";
  message: string;
  mode?: ThemeMode;
}

export interface ThemeFix {
  path: string;
  from: unknown;
  to: unknown;
  why: string;
}

export interface ThemeValidation {
  ok: boolean;
  errors: ThemeIssue[];
  fixes: ThemeFix[];
  /** the theme with every suggested fix applied; passes when `fixedOk` */
  fixed?: Theme;
  fixedOk?: boolean;
  /** per-mode summary of contrast ratios, for the preview */
  report: Record<string, Record<string, number>>;
}

const DATA_MIN_DISTANCE = 60;

function setPath(obj: any, path: string, value: unknown): void {
  const parts = path.split(".");
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (o[k] === undefined || o[k] === null) o[k] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    o = o[k];
  }
  o[parts[parts.length - 1]] = value;
}

function getPath(obj: any, path: string): unknown {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** Deep-merge a partial theme over the base theme. Arrays are replaced, objects merged. */
export function mergeTheme(partial: unknown, base: Theme = BASE_THEME): Theme {
  const merge = (a: any, b: any): any => {
    if (b === undefined || b === null) return a;
    if (Array.isArray(a) || Array.isArray(b) || typeof a !== "object" || typeof b !== "object" || a === null) return b;
    const out: any = { ...a };
    for (const k of Object.keys(b)) out[k] = merge(a[k], b[k]);
    return out;
  };
  const merged = merge(structuredClone(base), partial ?? {});
  if (merged.id === "base" && (partial as any)?.id !== "base") delete merged.id;
  // A single-mode theme carries its own colors in `tokens`; the base theme's dark block must not leak into it.
  const modes: string[] | undefined = (partial as any)?.modes;
  if (modes && modes.length === 1 && !(partial as any)?.dark) delete merged.dark;
  return merged;
}

function colorsFor(theme: Theme, mode: ThemeMode): ColorTokens {
  if (mode === "dark" && theme.dark?.color) return { ...theme.tokens.color, ...theme.dark.color } as ColorTokens;
  return theme.tokens.color;
}

function colorPath(theme: Theme, mode: ThemeMode, role: keyof ColorTokens | `data.${number}`): string {
  const inDark = mode === "dark" && theme.dark?.color && (role.startsWith("data") ? theme.dark.color.data : (theme.dark.color as any)[role]) !== undefined;
  return `${inDark ? "dark" : "tokens"}.color.${role}`;
}

/**
 * Validates a theme: schema, WCAG AA contrast in every mode, evaluation colors, color-blind-safe
 * series, focus ring, touch targets, motion, font licenses and assets. Every failure comes with a fix.
 */
export function validateTheme(input: unknown, depth = 0): ThemeValidation {
  const parsed = ThemeSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => ({ path: i.path.join("."), check: "schema", message: i.message })),
      fixes: [],
      report: {}
    };
  }
  const theme = parsed.data;
  const errors: ThemeIssue[] = [];
  const fixes: ThemeFix[] = [];
  const report: Record<string, Record<string, number>> = {};
  const fixed = structuredClone(theme);
  const propose = (path: string, to: unknown, why: string) => {
    const from = getPath(theme, path);
    fixes.push({ path, from, to, why });
    setPath(fixed, path, to);
  };

  for (const mode of theme.modes) {
    const c = colorsFor(theme, mode);
    const rep: Record<string, number> = {};
    report[mode] = rep;
    const pairs: [Exclude<keyof ColorTokens, "data">, Exclude<keyof ColorTokens, "data">, number, string][] = [
      ["ink", "bg", 4.5, "body text on the background"],
      ["ink", "surface", 4.5, "body text on cards"],
      ["muted", "bg", 4.5, "secondary text on the background"],
      ["muted", "surface", 4.5, "secondary text on cards"],
      ["on_accent", "accent", 4.5, "text on buttons"],
      ["accent", "bg", 3, "accent as a control boundary"],
      ["accent", "surface", 3, "accent as a control boundary on cards"],
      ["line", "bg", 1.3, "lines against the background"]
    ];
    for (const [fg, bg, min, what] of pairs) {
      const r = contrast(c[fg] as string, c[bg] as string);
      rep[`${fg}/${bg}`] = Math.round(r * 100) / 100;
      if (r < min) {
        const bgs = fg === "on_accent" ? [c.accent] : [c.bg, c.surface];
        const to = adjustForContrastAll(c[fg] as string, bgs, min);
        errors.push({ path: colorPath(theme, mode, fg), check: "contrast", mode, message: `${what}: ${fg} on ${bg} is ${r.toFixed(2)}:1, needs ${min}:1` });
        if (fg === "line") propose(colorPath(theme, mode, fg), mix(c[bg] as string, c.ink, 0.25), `lines need to be visible against ${bg}`);
        else if (!fixes.some((f) => f.path === colorPath(theme, mode, fg))) propose(colorPath(theme, mode, fg), to, `${fg} to ${to} reaches ${min}:1 on ${bgs.length > 1 ? "bg and surface" : bg}`);
      }
    }
    for (const role of ["good", "warn", "bad"] as const) {
      for (const bg of ["bg", "surface"] as const) {
        const r = contrast(c[role], c[bg]);
        rep[`${role}/${bg}`] = Math.round(r * 100) / 100;
        if (r < 3) {
          const to = adjustForContrastAll(c[role], [c.bg, c.surface], 3);
          errors.push({ path: colorPath(theme, mode, role), check: "evaluation-colors", mode, message: `${role} on ${bg} is ${r.toFixed(2)}:1, needs 3:1 (icons and labels are always shown too)` });
          if (!fixes.some((f) => f.path === colorPath(theme, mode, role))) propose(colorPath(theme, mode, role), to, `${role} to ${to} reaches 3:1 on bg and surface`);
        }
      }
    }
    const fr = contrast(c.focus, c.bg);
    rep["focus/bg"] = Math.round(fr * 100) / 100;
    if (fr < 3) {
      const to = adjustForContrast(c.focus, c.bg, 3);
      errors.push({ path: colorPath(theme, mode, "focus"), check: "focus", mode, message: `focus ring on bg is ${fr.toFixed(2)}:1, needs 3:1` });
      propose(colorPath(theme, mode, "focus"), to, `focus to ${to} reaches 3:1`);
    }
    const dist = seriesDistinguishability(c.data);
    const worst = dist.find((d) => d.min < DATA_MIN_DISTANCE);
    if (worst) {
      const [i, j] = worst.pair;
      errors.push({ path: `${colorPath(theme, mode, "data")}.${j}`, check: "series", mode, message: `data series ${i} and ${j} look alike for ${worst.kind === "normal" ? "everyone" : worst.kind + " color vision"}` });
      const basePalette = mode === "dark" ? BASE_THEME.dark!.color.data! : BASE_THEME.tokens.color.data;
      const safe = (arr: string[]) => seriesDistinguishability(arr).every((e) => e.min >= DATA_MIN_DISTANCE);
      const candidates: string[] = [...basePalette.filter((h) => !c.data.includes(h))];
      const [h, sat, l] = rgbToHsl(hexToRgb(c.data[j]));
      for (const dl of [0.25, -0.25, 0.4, -0.4]) {
        const nl = Math.max(0.08, Math.min(0.92, l + dl));
        candidates.push(rgbToHex(hslToRgb([h, sat, nl])));
      }
      let newData: string[] | undefined;
      for (const target of [j, i]) {
        const found = candidates.find((cand) => safe(c.data.map((x, k) => (k === target ? cand : x))));
        if (found) {
          newData = c.data.map((x, k) => (k === target ? found : x));
          break;
        }
      }
      if (!newData) newData = basePalette.slice(0, Math.max(3, Math.min(c.data.length, basePalette.length)));
      propose(colorPath(theme, mode, "data"), newData, `replace series ${j} with a distinguishable color`);
      c.data = newData;
    }
    const dataFixed = [...c.data];
    let dataChanged = false;
    c.data.forEach((d, k) => {
      const r = Math.max(contrast(d, c.bg), contrast(d, c.surface));
      if (r < 2) {
        errors.push({ path: `${colorPath(theme, mode, "data")}.${k}`, check: "series", mode, message: `data color ${d} is hard to see on ${mode} surfaces (${r.toFixed(2)}:1)` });
        dataFixed[k] = adjustForContrastAll(d, [c.bg, c.surface], 2.2);
        dataChanged = true;
      }
    });
    if (dataChanged) {
      const existing = fixes.find((f) => f.path === colorPath(theme, mode, "data"));
      if (existing) {
        existing.to = dataFixed;
        setPath(fixed, existing.path, dataFixed);
      } else propose(colorPath(theme, mode, "data"), dataFixed, "data colors need 2:1 against the surfaces");
      c.data = dataFixed;
    }
    const darkBg = isDark(c.bg);
    if (mode === "dark" && !darkBg) errors.push({ path: colorPath(theme, mode, "bg"), check: "contrast", mode, message: "the dark mode background is light" });
    if (mode === "light" && darkBg && theme.modes.length === 2) errors.push({ path: colorPath(theme, mode, "bg"), check: "contrast", mode, message: "the light mode background is dark; declare modes: [dark] for a single dark theme" });
  }

  // Touch targets: the structural minimum is 44px whatever the density. The theme's spacing must allow it.
  const t = theme.tokens;
  const bodySize = t.type.scale[1];
  const padY = t.density === "compact" ? t.space[1] : t.density === "roomy" ? t.space[3] : t.space[2];
  const control = bodySize * t.type.line_height + 2 * padY;
  if (control < 44) {
    errors.push({ path: "tokens.density", check: "touch", message: `controls would be ${Math.round(control)}px tall; LAS pads them to 44px, so density "${t.density}" is treated as comfortable` });
    propose("tokens.density", "comfortable", "keeps 44px touch targets without extra padding");
  }
  if (bodySize < 14) {
    errors.push({ path: "tokens.type.scale.1", check: "contrast", message: `body text is ${bodySize}px; use 14px or more` });
    propose("tokens.type.scale", t.type.scale.map((s, i) => (i === 1 ? 14 : i === 0 ? Math.min(s, 13) : Math.max(s, 14 + i * 2))), "readable body size");
  }
  for (let i = 1; i < t.type.scale.length; i++) if (t.type.scale[i] < t.type.scale[i - 1]) errors.push({ path: `tokens.type.scale.${i}`, check: "schema", message: "type scale must ascend" });
  for (let i = 1; i < t.space.length; i++) if (t.space[i] < t.space[i - 1]) errors.push({ path: `tokens.space.${i}`, check: "schema", message: "space scale must ascend" });

  // Motion: reduced motion always wins (in CSS); durations are capped.
  if (theme.motion.duration_ms > 400) {
    errors.push({ path: "motion.duration_ms", check: "motion", message: `${theme.motion.duration_ms}ms is longer than the 400ms cap` });
    propose("motion.duration_ms", 400, "capped");
  }

  // Fonts: each family carries an allowed license; otherwise the fallback stack is used.
  for (const role of ["display", "body", "mono"] as const) {
    const f = t.type[role];
    if (!(FONT_LICENSES as readonly string[]).includes(f.license)) {
      errors.push({ path: `tokens.type.${role}.license`, check: "fonts", message: `font license "${f.license}" is not allowed; use OFL-1.1, Apache-2.0 or a system font` });
      propose(`tokens.type.${role}`, { ...f, family: BASE_THEME.tokens.type[role].family, license: "system", source: undefined }, "fall back to the system stack");
    } else if (f.license !== "system" && !f.source) {
      errors.push({ path: `tokens.type.${role}.source`, check: "fonts", message: `"${f.family}" needs a source URL so it can be cached locally, or license: system to use the fallback stack` });
      propose(`tokens.type.${role}.source`, `https://fonts.googleapis.com/css2?family=${encodeURIComponent(f.family).replace(/%20/g, "+")}&display=swap`, "fetch once from Google Fonts and cache locally");
    }
    if (f.source && !/^https:\/\//.test(f.source)) errors.push({ path: `tokens.type.${role}.source`, check: "assets", message: "font sources must be https" });
  }

  // Assets: textures are CSS only; shadows must not reference images.
  for (const k of ["card", "raised"] as const) {
    if (/url\(/i.test(t.shadow[k])) {
      errors.push({ path: `tokens.shadow.${k}`, check: "assets", message: "shadows cannot reference files" });
      propose(`tokens.shadow.${k}`, "none", "no external assets");
    }
  }

  // Variants: enforced by the schema, repeated here so a fix is offered.
  for (const [comp, allowed] of Object.entries(COMPONENT_VARIANTS)) {
    const v = (theme.components as any)[comp];
    if (!(allowed as readonly string[]).includes(v)) {
      errors.push({ path: `components.${comp}`, check: "variants", message: `"${v}" is not on the menu: ${allowed.join(", ")}` });
      propose(`components.${comp}`, (BASE_THEME.components as any)[comp], "base variant");
    }
  }

  const ok = errors.length === 0;
  let fixedOk: boolean | undefined;
  if (!ok && fixes.length && depth < 2) {
    const again = validateTheme(fixed, depth + 1);
    fixedOk = again.ok;
    if (!again.ok && again.fixedOk && again.fixed) {
      // a second round of fixes converged; adopt it
      for (const f of again.fixes) {
        fixes.push(f);
        setPath(fixed, f.path, f.to);
      }
      fixedOk = true;
    }
  }
  return { ok, errors, fixes, fixed: ok ? undefined : fixed, fixedOk, report };
}
