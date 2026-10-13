/**
 * The end-to-end test hook. When a test page sets `window.__lasFixture`, capture screens use its evidence
 * instead of live devices and downloaded models, so analysis is deterministic and needs no network. The
 * real device path still runs up to permissions and the framing guide.
 */
export interface LasFixture {
  /** evidence per engine id, in JSON form (arrays where the engines expect typed arrays) */
  evidence?: Record<string, any>;
}

export function fixture(): LasFixture | undefined {
  return typeof window !== "undefined" ? ((window as unknown as { __lasFixture?: LasFixture }).__lasFixture ?? undefined) : undefined;
}

/** Revives typed arrays in JSON evidence: audio samples and image pixels. */
export function reviveEvidence<T = any>(e: any): T {
  if (!e || typeof e !== "object") return e;
  const out = { ...e };
  if (Array.isArray(out.samples) && (out.samples.length === 0 || typeof out.samples[0] === "number")) out.samples = Float32Array.from(out.samples);
  if (out.pixels && Array.isArray(out.pixels.data)) out.pixels = { ...out.pixels, data: Uint8ClampedArray.from(out.pixels.data) };
  return out as T;
}

export function fixtureEvidence<T = any>(engine: string): T | undefined {
  const e = fixture()?.evidence?.[engine];
  return e === undefined ? undefined : reviveEvidence<T>(structuredClone(e));
}

/** JSON can't carry typed arrays: the evidence as the server's evidence route takes it. */
export function evidenceToJson(e: any): any {
  if (!e || typeof e !== "object") return e;
  const out = { ...e };
  if (out.samples instanceof Float32Array) out.samples = Array.from(out.samples, (v: number) => Math.round(v * 1e5) / 1e5);
  if (out.pixels?.data && !(Array.isArray(out.pixels.data))) out.pixels = { ...out.pixels, data: Array.from(out.pixels.data as ArrayLike<number>) };
  return out;
}

/** About how big the evidence is as JSON, without building the string twice for big clips. */
export function jsonSize(e: unknown): number {
  try {
    return JSON.stringify(e).length;
  } catch {
    return Infinity;
  }
}

export const EVIDENCE_UPLOAD_LIMIT = 2 * 1024 * 1024;
