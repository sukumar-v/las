/** Small helpers the audio and speech analyzers share for reading expressions and criteria. */

/** Identifiers an expression mentions (used to find which metrics a mistake depends on). */
export function namesIn(src: string): Set<string> {
  return new Set(src.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);
}

/** Criteria as id -> expression; a list of {id, check} is accepted too. */
export function criteriaFrom(c: unknown): Record<string, string> {
  if (!c || typeof c !== "object") return {};
  if (Array.isArray(c)) return Object.fromEntries(c.filter((x) => x && (x.check ?? x.when)).map((x) => [String(x.id), String(x.check ?? x.when)]));
  return c as Record<string, string>;
}
