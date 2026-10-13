/** Color math for theme validation: WCAG contrast, color-vision simulation, small adjustments. */

export type RGB = [number, number, number];

export function hexToRgb(hex: string): RGB {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]: RGB): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`.toUpperCase();
}

function lin(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2 contrast ratio, 1..21 */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export function rgbToHsl([r, g, b]: RGB): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

export function hslToRgb([h, s, l]: [number, number, number]): RGB {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rgb: RGB;
  if (h < 60) rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return [(rgb[0] + m) * 255, (rgb[1] + m) * 255, (rgb[2] + m) * 255];
}

/**
 * Adjust lightness of `fg` (keeping hue) until it reaches `ratio` against `bg`.
 * Moves away from the background's lightness. Returns the original if impossible.
 */
export function adjustForContrast(fg: string, bg: string, ratio: number): string {
  if (contrast(fg, bg) >= ratio) return fg;
  const [h, s, l0] = rgbToHsl(hexToRgb(fg));
  const darker = luminance(bg) > 0.5;
  for (let step = 1; step <= 100; step++) {
    const l = darker ? l0 - step / 100 : l0 + step / 100;
    if (l < 0 || l > 1) break;
    const candidate = rgbToHex(hslToRgb([h, s, l]));
    if (contrast(candidate, bg) >= ratio) return candidate;
  }
  return darker ? "#000000" : "#FFFFFF";
}

/** Color vision deficiency simulation (Viénot/Brettel-style linear approximation in linear RGB). */
const CVD: Record<"protan" | "deutan" | "tritan", number[][]> = {
  protan: [
    [0.567, 0.433, 0],
    [0.558, 0.442, 0],
    [0, 0.242, 0.758]
  ],
  deutan: [
    [0.625, 0.375, 0],
    [0.7, 0.3, 0],
    [0, 0.3, 0.7]
  ],
  tritan: [
    [0.95, 0.05, 0],
    [0, 0.433, 0.567],
    [0, 0.475, 0.525]
  ]
};

export function simulateCvd(hex: string, kind: "protan" | "deutan" | "tritan"): RGB {
  const [r, g, b] = hexToRgb(hex);
  const m = CVD[kind];
  return [m[0][0] * r + m[0][1] * g + m[0][2] * b, m[1][0] * r + m[1][1] * g + m[1][2] * b, m[2][0] * r + m[2][1] * g + m[2][2] * b];
}

/** Perceptual-ish distance between two RGB colors (weighted Euclidean, 0..~765). */
export function colorDistance(a: RGB, b: RGB): number {
  const rmean = (a[0] + b[0]) / 2;
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt((2 + rmean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rmean) / 256) * db * db);
}

/** The smallest pairwise distance in a series under each simulated deficiency, with the offending pair. */
export function seriesDistinguishability(series: string[]): { kind: "normal" | "protan" | "deutan" | "tritan"; min: number; pair: [number, number] }[] {
  const out: { kind: "normal" | "protan" | "deutan" | "tritan"; min: number; pair: [number, number] }[] = [];
  for (const kind of ["normal", "protan", "deutan", "tritan"] as const) {
    const cols = series.map((h) => (kind === "normal" ? hexToRgb(h) : simulateCvd(h, kind)));
    let min = Infinity;
    let pair: [number, number] = [0, 1];
    for (let i = 0; i < cols.length; i++)
      for (let j = i + 1; j < cols.length; j++) {
        const d = colorDistance(cols[i], cols[j]);
        if (d < min) {
          min = d;
          pair = [i, j];
        }
      }
    out.push({ kind, min, pair });
  }
  return out;
}

/** Blend two hex colors; t=0 gives a. */
export function mix(a: string, b: string, t: number): string {
  const ra = hexToRgb(a);
  const rb = hexToRgb(b);
  return rgbToHex([ra[0] + (rb[0] - ra[0]) * t, ra[1] + (rb[1] - ra[1]) * t, ra[2] + (rb[2] - ra[2]) * t]);
}

export function isDark(hex: string): boolean {
  return luminance(hex) < 0.35;
}

/** Adjust `fg` until it reaches `ratio` against every background. */
export function adjustForContrastAll(fg: string, bgs: string[], ratio: number): string {
  let out = fg;
  for (let round = 0; round < 4; round++) {
    let changed = false;
    for (const bg of bgs) {
      const next = adjustForContrast(out, bg, ratio);
      if (next !== out) {
        out = next;
        changed = true;
      }
    }
    if (!changed) return out;
  }
  return out;
}
