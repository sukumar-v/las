import { z } from "zod";
import { RubricSpecSchema } from "./rubric.js";

export const SpeechSpecSchema = z.object({
  kind: z.literal("speech").default("speech"),
  /** BCP-47 language tag, e.g. "es", "ja", "zh-CN" */
  language: z.string().min(2).max(12),
  /** repeat-after-me text; omit for an open prompt */
  target: z.string().max(400).optional(),
  /** open prompt the learner answers, e.g. a role-play line */
  prompt: z.string().max(200).optional(),
  /** tonal language: measure pitch contour per syllable */
  tones: z.boolean().default(false),
  /** expected tone pattern per syllable when `tones`, e.g. [1,4,3] */
  tone_pattern: z.array(z.number().int().min(0).max(6)).optional(),
  rubric: RubricSpecSchema.optional(),
  /** which per-sound scores to request when a license-clean model exists for the language */
  sounds: z.array(z.string()).optional(),
  pass: z.string().optional(),
  mistakes: z
    .array(z.object({ id: z.string(), when: z.string(), severity: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2), show: z.string().optional(), fix_drill: z.string().optional() }))
    .default([])
});
export type SpeechSpec = z.infer<typeof SpeechSpecSchema>;

export const SPEECH_METRICS = [
  "intelligibility",
  "words_recognized",
  "words_expected",
  "mean_word_confidence",
  "words_per_minute",
  "pause_count",
  "pause_share",
  "filler_count",
  "duration_s",
  "pitch_range_st",
  "tone_accuracy",
  "sound_score"
] as const;

export function checkSpeechSpec(spec: SpeechSpec): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  if (!spec.target && !spec.prompt) issues.push({ path: "target", message: "a speech spec needs a target text or an open prompt" });
  if (spec.tone_pattern && !spec.tones) issues.push({ path: "tone_pattern", message: "tone_pattern needs tones: true" });
  return issues;
}
