/**
 * Runtime values for the expression language.
 *
 * A `Series` is a per-frame (or per-sample) numeric signal; a `PointSeries` is a
 * tracked point over time. Arithmetic lifts element-wise over series so a spec
 * can write `angle(a, b, c) > 150` and get a series of 0/1.
 */
export interface Series {
  kind: "series";
  values: Float64Array;
  /** confidence per sample in [0,1]; missing means 1 */
  conf?: Float64Array;
  /** timestamps in seconds; missing means index/fps */
  t?: Float64Array;
}

export interface PointSeries {
  kind: "points";
  x: Float64Array;
  y: Float64Array;
  z?: Float64Array;
  conf?: Float64Array;
  t?: Float64Array;
}

export type Value = number | boolean | string | null | Value[] | { [k: string]: Value } | Series | PointSeries;

export function isSeries(v: Value): v is Series {
  return typeof v === "object" && v !== null && !Array.isArray(v) && (v as Series).kind === "series";
}
export function isPoints(v: Value): v is PointSeries {
  return typeof v === "object" && v !== null && !Array.isArray(v) && (v as PointSeries).kind === "points";
}
export function series(values: ArrayLike<number>, conf?: ArrayLike<number>, t?: ArrayLike<number>): Series {
  const s: Series = { kind: "series", values: Float64Array.from(values) };
  if (conf) s.conf = Float64Array.from(conf);
  if (t) s.t = Float64Array.from(t);
  return s;
}
export function truthy(v: Value): boolean {
  if (isSeries(v)) return v.values.length > 0 && Array.from(v.values).every((x) => x !== 0 && !Number.isNaN(x));
  if (Array.isArray(v)) return v.length > 0;
  return !!v;
}
export function toNumber(v: Value): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === null) return NaN;
  if (typeof v === "string") return Number(v);
  if (isSeries(v)) return mean(v.values);
  if (Array.isArray(v)) return mean(Float64Array.from(v.map(toNumber)));
  return NaN;
}
export function toArray(v: Value): number[] {
  if (isSeries(v)) return Array.from(v.values);
  if (Array.isArray(v)) return v.map(toNumber);
  if (typeof v === "number" || typeof v === "boolean") return [toNumber(v)];
  return [];
}
export function mean(a: ArrayLike<number>): number {
  let s = 0;
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    if (Number.isNaN(x)) continue;
    s += x;
    n++;
  }
  return n ? s / n : NaN;
}
export function minConf(s: Series): number {
  if (!s.conf || s.conf.length === 0) return 1;
  let m = 1;
  for (let i = 0; i < s.conf.length; i++) m = Math.min(m, s.conf[i]);
  return m;
}
export function meanConf(s: Series): number {
  if (!s.conf || s.conf.length === 0) return 1;
  return mean(s.conf);
}
