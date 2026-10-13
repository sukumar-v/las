/**
 * Measurements the visual engine computes without any grader: distances and angles from the
 * points the learner tapped, and simple image statistics from raw pixels.
 *
 * A rubric criterion names one in `measure`, like `tapped_points(head_top, chin, feet)` or
 * `symmetry(vertical)`. Extra `key=value` arguments are allowed: `target=0.125` makes the
 * ratio measures also report `ratio_error` (the relative gap to that target).
 */
import type { VisualEvidence } from "../types.js";

export interface MeasureRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MeasureResult {
  /** measurement name -> value; names are local to the criterion */
  values: Record<string, number>;
  issues: string[];
  /** where on the image the measurement looked (taps' bounding box, or the whole image) */
  region?: MeasureRegion;
}

export interface ParsedMeasure {
  fn: string;
  args: string[];
  opts: Record<string, string>;
}

/** Split `name(a, b, key=value)` into its parts. Returns null when the text isn't a call. */
export function parseVisualMeasure(src: string): ParsedMeasure | null {
  const m = /^\s*([a-z_]+)\s*\(([^)]*)\)\s*$/.exec(src);
  if (!m) return null;
  const args: string[] = [];
  const opts: Record<string, string> = {};
  for (const part of m[2].split(",").map((s) => s.trim()).filter(Boolean)) {
    const eq = part.indexOf("=");
    if (eq > 0) opts[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    else args.push(part);
  }
  return { fn: m[1], args, opts };
}

const WHOLE: MeasureRegion = { x: 0, y: 0, w: 1, h: 1 };

function boundingBox(points: [number, number][]): MeasureRegion {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const x0 = Math.max(0, Math.min(...xs));
  const y0 = Math.max(0, Math.min(...ys));
  const x1 = Math.min(1, Math.max(...xs));
  const y1 = Math.min(1, Math.max(...ys));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Distance between two normalized points in pixel units, so a wide image doesn't skew it. */
function dist(a: [number, number], b: [number, number], w: number, h: number): number {
  return Math.hypot((a[0] - b[0]) * w, (a[1] - b[1]) * h);
}

interface Gray {
  data: Float32Array;
  w: number;
  h: number;
}

/** Luminance 0..1 (Rec. 709), box-averaged down so the longest side is at most `maxSide`. */
function grayscale(px: NonNullable<VisualEvidence["pixels"]>, maxSide = 512): Gray {
  const stride = Math.max(1, Math.ceil(Math.max(px.width, px.height) / maxSide));
  const w = Math.max(1, Math.floor(px.width / stride));
  const h = Math.max(1, Math.floor(px.height / stride));
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let n = 0;
      for (let dy = 0; dy < stride; dy++) {
        for (let dx = 0; dx < stride; dx++) {
          const sx = x * stride + dx;
          const sy = y * stride + dy;
          if (sx >= px.width || sy >= px.height) continue;
          const i = (sy * px.width + sx) * 4;
          s += (0.2126 * px.data[i] + 0.7152 * px.data[i + 1] + 0.0722 * px.data[i + 2]) / 255;
          n++;
        }
      }
      out[y * w + x] = n ? s / n : 0;
    }
  }
  return { data: out, w, h };
}

/** Sobel gradient magnitude per pixel (edges of the frame are left at zero). A step of height d gives 4d. */
function sobel(g: Gray): Float32Array {
  const { data, w, h } = g;
  const mag = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = -data[i - w - 1] - 2 * data[i - 1] - data[i + w - 1] + data[i - w + 1] + 2 * data[i + 1] + data[i + w + 1];
      const gy = -data[i - w - 1] - 2 * data[i - w] - data[i - w + 1] + data[i + w - 1] + 2 * data[i + w] + data[i + w + 1];
      mag[i] = Math.hypot(gx, gy);
    }
  }
  return mag;
}

/** A luminance step of about 15% counts as an edge. */
const EDGE_THRESHOLD = 0.6;

function symmetry(g: Gray, axis: string): Record<string, number> {
  const { data, w, h } = g;
  let diff = 0;
  let n = 0;
  if (axis === "horizontal") {
    for (let y = 0; y < Math.floor(h / 2); y++) for (let x = 0; x < w; x++) { diff += Math.abs(data[y * w + x] - data[(h - 1 - y) * w + x]); n++; }
  } else {
    for (let y = 0; y < h; y++) for (let x = 0; x < Math.floor(w / 2); x++) { diff += Math.abs(data[y * w + x] - data[y * w + (w - 1 - x)]); n++; }
  }
  const asymmetry = n ? diff / n : 0;
  return { symmetry: 1 - asymmetry, asymmetry };
}

function exposure(g: Gray): Record<string, number> {
  let sum = 0;
  let dark = 0;
  let bright = 0;
  for (const v of g.data) {
    sum += v;
    if (v <= 0.02) dark++;
    if (v >= 0.98) bright++;
  }
  const n = g.data.length || 1;
  return { mean_luma: sum / n, dark_clip: dark / n, bright_clip: bright / n, clipping: (dark + bright) / n };
}

/** Mean R, G, B each minus the mean of the three, in 0..1 units. A cast shows as one channel standing out. */
function colorBalance(px: NonNullable<VisualEvidence["pixels"]>): Record<string, number> {
  let r = 0;
  let gg = 0;
  let b = 0;
  const n = px.width * px.height || 1;
  for (let i = 0; i < n; i++) {
    r += px.data[i * 4];
    gg += px.data[i * 4 + 1];
    b += px.data[i * 4 + 2];
  }
  r /= n * 255;
  gg /= n * 255;
  b /= n * 255;
  const m = (r + gg + b) / 3;
  return { r_offset: r - m, g_offset: gg - m, b_offset: b - m, cast: Math.max(Math.abs(r - m), Math.abs(gg - m), Math.abs(b - m)) };
}

function edgeDensity(g: Gray): Record<string, number> {
  const mag = sobel(g);
  let edges = 0;
  let sum = 0;
  let n = 0;
  for (let y = 1; y < g.h - 1; y++) {
    for (let x = 1; x < g.w - 1; x++) {
      const m = mag[y * g.w + x];
      sum += m;
      if (m >= EDGE_THRESHOLD) edges++;
      n++;
    }
  }
  return { edge_density: n ? edges / n : 0, edge_strength: n ? sum / n / 4 : 0 };
}

/**
 * Rough stroke count: take the edge map, grow it by two pixels so the two edges of one stroke merge,
 * then count the connected blobs that are big enough to be a stroke and not dust.
 */
function lineCount(g: Gray): Record<string, number> {
  const { w, h } = g;
  const mag = sobel(g);
  let mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = mag[i] >= EDGE_THRESHOLD ? 1 : 0;
  for (let pass = 0; pass < 2; pass++) {
    const grown = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!mask[y * w + x]) continue;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h) grown[ny * w + nx] = 1;
        }
      }
    }
    mask = grown;
  }
  const minSize = Math.max(12, Math.round(w * h * 0.0004));
  const seen = new Uint8Array(w * h);
  let lines = 0;
  let total = 0;
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let size = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      size++;
      const x = i % w;
      const y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (mask[j] && !seen[j]) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    if (size >= minSize) {
      lines++;
      total += size;
    }
  }
  return { line_count: lines, line_share: total / (w * h) };
}

function words(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []).filter(Boolean);
}

function textMeasure(ocrText: string | undefined, expected: string | undefined): Record<string, number> {
  const got = words(ocrText ?? "");
  const out: Record<string, number> = { word_count: got.length };
  if (expected) {
    const want = words(expected);
    const pool = new Map<string, number>();
    for (const w of got) pool.set(w, (pool.get(w) ?? 0) + 1);
    let hit = 0;
    for (const w of want) {
      const c = pool.get(w) ?? 0;
      if (c > 0) {
        hit++;
        pool.set(w, c - 1);
      }
    }
    out.matched = want.length ? hit / want.length : 0;
    out.expected_words = want.length;
  }
  return out;
}

/** Run one criterion's measurement. Never throws: a problem becomes an issue and the value is left out. */
export function measureVisual(src: string, ev: VisualEvidence, opts: { expectedText?: string } = {}): MeasureResult {
  const parsed = parseVisualMeasure(src);
  if (!parsed) return { values: {}, issues: [`cannot read measure "${src}"`] };
  const { fn, args, opts: kv } = parsed;
  const W = ev.width || ev.pixels?.width || 1;
  const H = ev.height || ev.pixels?.height || 1;
  const target = kv.target !== undefined ? Number(kv.target) : undefined;
  const issues: string[] = [];

  const needTaps = (ids: string[]): [number, number][] | null => {
    const missing = ids.filter((id) => !ev.taps?.[id]);
    if (missing.length) {
      issues.push(`missing tapped point${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`);
      return null;
    }
    return ids.map((id) => ev.taps![id]);
  };
  const needPixels = () => {
    if (!ev.pixels || !ev.pixels.width || !ev.pixels.height) {
      issues.push(`${fn} needs image pixels`);
      return null;
    }
    return ev.pixels;
  };
  const withError = (values: Record<string, number>, key: string, got: number) => {
    if (target !== undefined && Number.isFinite(target) && Number.isFinite(got)) values[`${key}_error`] = target === 0 ? Math.abs(got) : Math.abs(got - target) / Math.abs(target);
  };

  switch (fn) {
    case "tapped_points": {
      if (args.length < 2) return { values: {}, issues: ["tapped_points needs at least two points"] };
      const pts = needTaps(args);
      if (!pts) return { values: {}, issues };
      const values: Record<string, number> = {};
      for (let i = 0; i + 1 < pts.length; i++) values[`d${i + 1}`] = dist(pts[i], pts[i + 1], W, H);
      const span = dist(pts[0], pts[pts.length - 1], W, H);
      values.span = span;
      values.ratio = span > 0 ? values.d1 / span : NaN;
      withError(values, "ratio", values.ratio);
      return { values, issues, region: boundingBox(pts) };
    }
    case "proportion": {
      if (args.length !== 4) return { values: {}, issues: ["proportion needs four points: a, b, c, d (segment a-b over segment c-d)"] };
      const pts = needTaps(args);
      if (!pts) return { values: {}, issues };
      const ab = dist(pts[0], pts[1], W, H);
      const cd = dist(pts[2], pts[3], W, H);
      const values: Record<string, number> = { first: ab, second: cd, ratio: cd > 0 ? ab / cd : NaN };
      withError(values, "ratio", values.ratio);
      return { values, issues, region: boundingBox(pts) };
    }
    case "angle": {
      if (args.length !== 3) return { values: {}, issues: ["angle needs three points: a, b, c (the angle sits at b)"] };
      const pts = needTaps(args);
      if (!pts) return { values: {}, issues };
      const ux = (pts[0][0] - pts[1][0]) * W;
      const uy = (pts[0][1] - pts[1][1]) * H;
      const vx = (pts[2][0] - pts[1][0]) * W;
      const vy = (pts[2][1] - pts[1][1]) * H;
      const nu = Math.hypot(ux, uy);
      const nv = Math.hypot(vx, vy);
      const cos = nu > 0 && nv > 0 ? Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (nu * nv))) : NaN;
      const values: Record<string, number> = { angle: (Math.acos(cos) * 180) / Math.PI };
      withError(values, "angle", values.angle);
      return { values, issues, region: boundingBox(pts) };
    }
    case "symmetry": {
      const px = needPixels();
      if (!px) return { values: {}, issues };
      return { values: symmetry(grayscale(px), args[0] === "horizontal" ? "horizontal" : "vertical"), issues, region: WHOLE };
    }
    case "exposure": {
      const px = needPixels();
      if (!px) return { values: {}, issues };
      return { values: exposure(grayscale(px)), issues, region: WHOLE };
    }
    case "color_balance": {
      const px = needPixels();
      if (!px) return { values: {}, issues };
      return { values: colorBalance(px), issues, region: WHOLE };
    }
    case "edge_density": {
      const px = needPixels();
      if (!px) return { values: {}, issues };
      return { values: edgeDensity(grayscale(px)), issues, region: WHOLE };
    }
    case "line_count": {
      const px = needPixels();
      if (!px) return { values: {}, issues };
      return { values: lineCount(grayscale(px)), issues, region: WHOLE };
    }
    case "text": {
      if (ev.ocrText === undefined) return { values: {}, issues: ["text needs recognized text from the studio"] };
      return { values: textMeasure(ev.ocrText, opts.expectedText), issues, region: WHOLE };
    }
    default:
      return { values: {}, issues: [`unknown measure "${fn}"`] };
  }
}
