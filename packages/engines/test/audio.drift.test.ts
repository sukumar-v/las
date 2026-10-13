/**
 * Drift guard: fixed synthesized takes must keep producing the same metrics. If a change to the
 * engine moves any metric past its tolerance, this fails; regenerate the fixture on purpose with
 * LAS_UPDATE_FIXTURES=1 only after checking the new numbers are right.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AudioSpecSchema } from "@las/schema";
import { analyzeAudio } from "../src/audio/index.js";
import { synthClicks, synthMelody } from "../src/audio/synth.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures/audio/expected.json");
const SR = 44100;
const MELODY: [string, number][] = [
  ["A3", 1],
  ["C4", 0.5],
  ["E4", 0.5],
  ["A4", 1],
  ["G4", 1],
  ["F4", 1.5],
  ["E4", 0.5],
  ["D4", 1],
  ["E4", 2]
];

function cases(): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  const round = (m: Record<string, { value: number }>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, Math.round(v.value * 1000) / 1000]));
  const mel = synthMelody(MELODY, 96, SR, { pitchErrorCents: { 1: 25, 6: -35 }, onsetErrorMs: { 3: 45, 7: -30 }, harmonics: [1, 0.5, 0.3], decayS: 0.8, amp: { 0: 0.5, 4: 0.2 } });
  const melSpec = AudioSpecSchema.parse({ reference: { notes: MELODY }, tempo: 96, grade: ["pitch", "rhythm", "dynamics"] });
  out.melody_click = round(analyzeAudio(melSpec, { sampleRate: SR, samples: mel.samples, click: { bpm: 96, firstBeatS: mel.firstBeatS } }).metrics);
  out.melody_free = round(analyzeAudio(AudioSpecSchema.parse({ reference: { notes: MELODY }, grade: ["pitch", "tempo"] }), { sampleRate: SR, samples: mel.samples }).metrics);
  const pat = synthClicks({ pattern: "D.DU.UDU", bpm: 104, bars: 4, offsetMs: (i, s) => (s === "U" ? -25 : i % 5 === 0 ? 20 : 0) });
  out.pattern = round(analyzeAudio(AudioSpecSchema.parse({ reference: { pattern: "D.DU.UDU" }, tempo: 104, grade: ["rhythm"] }), { sampleRate: SR, samples: pat.samples, click: { bpm: 104, firstBeatS: pat.firstBeatS }, outputDelayMs: 0 }).metrics);
  return out;
}

/** How far each metric may move: ms and cents by a little, shares by one event's worth, levels by 0.5 dB. */
function tolerance(name: string, v: number): number {
  if (name.endsWith("_ms")) return 2;
  if (name.includes("cents")) return 2;
  if (name.endsWith("_db")) return 0.5;
  if (name === "tempo_bpm") return 0.5;
  if (name === "tempo_drift_pct") return 1;
  return Math.max(0.01, Math.abs(v) * 0.001);
}

describe("audio drift", () => {
  it("matches the committed fixture", () => {
    const got = cases();
    if (process.env.LAS_UPDATE_FIXTURES || !existsSync(FIXTURE)) {
      if (!process.env.LAS_UPDATE_FIXTURES) throw new Error(`missing ${FIXTURE}; run with LAS_UPDATE_FIXTURES=1 once and commit it`);
      writeFileSync(FIXTURE, JSON.stringify(got, null, 2) + "\n");
    }
    const want = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, Record<string, number>>;
    expect(Object.keys(got).sort()).toEqual(Object.keys(want).sort());
    for (const [c, metrics] of Object.entries(want)) {
      expect(Object.keys(got[c]).sort(), c).toEqual(Object.keys(metrics).sort());
      for (const [k, v] of Object.entries(metrics)) {
        const diff = Math.abs(got[c][k] - v);
        expect(diff, `${c}.${k}: got ${got[c][k]}, fixture ${v}`).toBeLessThanOrEqual(tolerance(k, v));
      }
    }
  });
});
