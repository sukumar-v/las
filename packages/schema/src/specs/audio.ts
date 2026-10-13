import { z } from "zod";

export const AudioReferenceSchema = z.union([
  z.object({ score: z.string().min(1), part: z.string().optional(), bars: z.string().regex(/^\d+-\d+$|^\d+$/).optional() }),
  z.object({ midi: z.string().min(1), track: z.number().int().min(0).optional(), bars: z.string().optional() }),
  z.object({ abc: z.string().min(1) }),
  z.object({ recording: z.string().min(1) }),
  /** a pattern of onsets in beats, e.g. a drum or strumming pattern: "x.x.xx.x" per bar, or beat fractions */
  z.object({ pattern: z.string().min(1), beats_per_bar: z.number().int().min(1).max(16).default(4), bars: z.number().int().min(1).max(64).default(4) }),
  /** a melody as note names with durations in beats: [["C4", 1], ["D4", 0.5]] */
  z.object({ notes: z.array(z.tuple([z.string(), z.number().positive()])).min(1) })
]);
export type AudioReference = z.infer<typeof AudioReferenceSchema>;

export const AudioSpecSchema = z.object({
  kind: z.literal("audio").default("audio"),
  reference: AudioReferenceSchema.optional(),
  tempo: z.number().min(20).max(300).optional(),
  tuning_hz: z.number().min(400).max(480).default(440),
  tolerance: z
    .object({
      pitch_cents: z.number().min(1).max(200).default(30),
      onset_ms: z.number().min(5).max(500).default(60)
    })
    .prefault({}),
  grade: z.array(z.enum(["pitch", "rhythm", "dynamics", "tempo", "notes", "onsets"])).min(1).default(["pitch", "rhythm"]),
  /** click or backing track the studio plays in the headphones */
  playback: z.enum(["metronome", "backing", "none"]).default("metronome"),
  /** pass expression over metrics, e.g. `pitch_accuracy >= 0.8 && mean_abs_onset_ms <= 60` */
  pass: z.string().optional(),
  mistakes: z
    .array(z.object({ id: z.string(), when: z.string(), severity: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2), show: z.string().optional(), fix_drill: z.string().optional() }))
    .default([])
});
export type AudioSpec = z.infer<typeof AudioSpecSchema>;

/** Metrics the audio engine produces; pass/mistake expressions may use these. */
export const AUDIO_METRICS = [
  "pitch_accuracy",
  "mean_abs_cents",
  "notes_correct",
  "notes_expected",
  "notes_detected",
  "note_accuracy",
  "mean_abs_onset_ms",
  "mean_onset_ms",
  "onset_std_ms",
  "onset_share_on_time",
  "tempo_bpm",
  "tempo_drift_pct",
  "dynamics_range_db",
  "rms_db",
  "early_share",
  "late_share",
  "up_offset_ms",
  "down_offset_ms"
] as const;

export function checkAudioSpec(spec: AudioSpec): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  if (!spec.reference && spec.grade.some((g) => g === "pitch" || g === "notes")) {
    issues.push({ path: "reference", message: "grading pitch or notes needs a reference (score, MIDI, ABC, notes or a recording)" });
  }
  if (spec.grade.includes("rhythm") && !spec.tempo && !spec.reference) issues.push({ path: "tempo", message: "grading rhythm needs a tempo or a reference" });
  return issues;
}
