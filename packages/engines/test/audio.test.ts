import { describe, expect, it } from "vitest";
import { AudioSpecSchema, type AudioSpec } from "@las/schema";
import { analyzeAudio, beatsFromOnsets, calibrateOutputDelay, centsOff, detectOnsets, detectPitchTrack, estimateTempo, noteName, noteToHz } from "../src/audio/index.js";
import { synthClicks, synthMelody, synthNoise, synthTone, silence, mixInto } from "../src/audio/synth.js";

const SR = 44100;
const spec = (s: Record<string, unknown>): AudioSpec => AudioSpecSchema.parse(s);
const MELODY: [string, number][] = [
  ["C4", 1],
  ["D4", 1],
  ["E4", 1],
  ["F4", 1],
  ["G4", 0.5],
  ["G4", 0.5],
  ["A4", 1],
  ["B4", 1],
  ["C5", 2]
];

describe("pitch", () => {
  it("measures pure and harmonic tones within 5 cents and names them", () => {
    const cases: [number, string][] = [
      [82.41, "E2"],
      [110, "A2"],
      [261.63, "C4"],
      [440, "A4"],
      [466.16, "A#4"],
      [987.77, "B5"],
      [1760, "A6"]
    ];
    for (const [hz, name] of cases) {
      for (const harmonics of [[1], [1, 0.6, 0.3, 0.2]]) {
        const track = detectPitchTrack(synthTone({ hz, seconds: 0.5, sampleRate: SR, harmonics }), SR);
        const voiced = track.filter((f) => f.hz > 0).map((f) => f.hz);
        expect(voiced.length).toBeGreaterThan(10);
        const mid = voiced.sort((a, b) => a - b)[voiced.length >> 1];
        expect(Math.abs(centsOff(mid, hz))).toBeLessThan(5);
        expect(noteName(mid).name).toBe(name);
      }
    }
  });

  it("names notes against another tuning and reports cents", () => {
    expect(noteName(442, 442)).toMatchObject({ name: "A4", midi: 69 });
    expect(noteName(440, 442).cents).toBeCloseTo(centsOff(440, 442), 6);
    expect(noteToHz("A4")).toBe(440);
    expect(noteToHz("C4")).toBeCloseTo(261.63, 1);
    expect(noteToHz("Bb3")).toBeCloseTo(noteToHz("A#3"), 9);
    expect(centsOff(440 * 2 ** (25 / 1200), 440)).toBeCloseTo(25, 6);
  });
});

describe("melody against a notes reference", () => {
  // note index 2 (the third note) is 40 cents sharp; note index 4 (the fifth) is 80 ms early
  const m = synthMelody(MELODY, 100, SR, { pitchErrorCents: { 2: 40 }, onsetErrorMs: { 4: -80 } });
  const s = spec({
    reference: { notes: MELODY },
    tempo: 100,
    tolerance: { pitch_cents: 20, onset_ms: 40 },
    pass: "pitch_accuracy >= 0.8 && mean_abs_onset_ms <= 30",
    mistakes: [
      { id: "rushing", when: "early_share > 0", severity: 2 },
      { id: "out-of-tune", when: "pitch_accuracy < 1", severity: 1 },
      { id: "dragging", when: "late_share > 0" }
    ]
  });

  for (const withClick of [true, false]) {
    it(`finds exactly the injected errors (${withClick ? "with a click" : "free, tempo only"})`, () => {
      const a = analyzeAudio(s, { sampleRate: SR, samples: m.samples, ...(withClick ? { click: { bpm: 100, firstBeatS: m.firstBeatS } } : {}) }, { criteria: { in_tune: "mean_abs_cents < 10" } });
      expect(a.quality.ok).toBe(true);
      expect(a.precision).toBe("full");
      const M = a.metrics;
      expect(M.notes_expected.value).toBe(9);
      expect(M.notes_detected.value).toBe(9);
      expect(M.notes_correct.value).toBe(9);
      const cents = M.pitch_accuracy.per!;
      cents.forEach((c, i) => (i === 2 ? expect(c).toBeGreaterThan(35) : expect(Math.abs(c)).toBeLessThan(5)));
      expect(cents[2]).toBeLessThan(45);
      expect(M.pitch_accuracy.value).toBeCloseTo(8 / 9, 6);
      const offs = M.mean_onset_ms.per!;
      offs.forEach((o, i) => (i === 4 ? expect(o).toBeLessThan(-70) : expect(Math.abs(o)).toBeLessThan(10)));
      expect(offs[4]).toBeGreaterThan(-90);
      expect(M.early_share.value).toBeCloseTo(1 / 9, 6);
      expect(M.late_share.value).toBe(0);
      expect(M.onset_share_on_time.value).toBeCloseTo(8 / 9, 6);
      expect(Math.abs(M.tempo_bpm.value - 100)).toBeLessThan(2);

      const ids = a.mistakes.map((x) => x.id).sort();
      expect(ids).toEqual(["out-of-tune", "rushing"]);
      const rush = a.mistakes.find((x) => x.id === "rushing")!;
      expect(rush.at).toHaveLength(1);
      expect(rush.at[0]).toBeCloseTo(m.onsets[4], 1);
      expect(rush.evidence).toMatchObject({ kind: "time" });
      const sharp = a.mistakes.find((x) => x.id === "out-of-tune")!;
      expect(sharp.at[0]).toBeCloseTo(m.onsets[2], 1);
      expect(a.criteria).toEqual({ in_tune: true, pass: true });
      expect(a.markers.filter((k) => k.role === "attention")).toHaveLength(2);
      const ov = a.overlay as { kind: string; beats: number[]; offsetsMs: number[]; notes: { expected?: string }[] };
      expect(ov.kind).toBe("beat_timeline");
      expect(ov.beats).toHaveLength(9);
      expect(ov.notes[2].expected).toBe("E4");
      expect(a.praise).toBeDefined();
    });
  }

  it("counts a wrong note and a missing note", () => {
    const played: [string, number][] = MELODY.map(([n, b], i) => [i === 3 ? "F#4" : i === 6 ? "r" : n, b]);
    const w = synthMelody(played, 100, SR);
    const a = analyzeAudio(spec({ reference: { notes: MELODY }, tempo: 100, grade: ["notes", "pitch"] }), { sampleRate: SR, samples: w.samples, click: { bpm: 100, firstBeatS: w.firstBeatS } });
    expect(a.metrics.notes_expected.value).toBe(9);
    expect(a.metrics.notes_detected.value).toBe(8);
    expect(a.metrics.notes_correct.value).toBe(7);
    expect(a.metrics.note_accuracy.value).toBeCloseTo(7 / 9, 6);
    expect(a.markers.some((k) => k.label.startsWith("missed A4"))).toBe(true);
  });

  it("subtracts the measured output delay", () => {
    const late = synthMelody(MELODY, 100, SR, { onsetErrorMs: () => 150 });
    const ev = { sampleRate: SR, samples: late.samples, click: { bpm: 100, firstBeatS: late.firstBeatS } };
    const s2 = spec({ reference: { notes: MELODY }, tempo: 100, tolerance: { onset_ms: 40 } });
    const raw = analyzeAudio(s2, ev);
    expect(raw.metrics.mean_onset_ms.value).toBeGreaterThan(140);
    const fixed = analyzeAudio(s2, { ...ev, outputDelayMs: 150 });
    expect(Math.abs(fixed.metrics.mean_onset_ms.value)).toBeLessThan(10);
    expect(fixed.metrics.onset_share_on_time.value).toBe(1);
  });

  it("follows a learner who plays at their own tempo against a reference recording", () => {
    const ref = synthMelody(MELODY, 90, SR);
    const take = synthMelody(MELODY, 110, SR, { pitchErrorCents: { 6: -40 }, leadInS: 0.8 });
    const a = analyzeAudio(spec({ reference: { recording: "media/ref.wav" }, grade: ["pitch", "tempo"] }), { sampleRate: SR, samples: take.samples }, { referenceEvidence: { sampleRate: SR, samples: ref.samples } });
    expect(a.metrics.notes_expected.value).toBe(9);
    expect(a.metrics.notes_correct.value).toBe(9);
    const cents = a.metrics.pitch_accuracy.per!;
    expect(cents[6]).toBeLessThan(-30);
    expect(Math.abs(a.metrics.mean_abs_onset_ms.value)).toBeLessThan(10);
    // the learner's tempo in the reference's beats: 110/90 of the reference's own tempo
    expect(a.metrics.tempo_bpm.value / 110).toBeGreaterThan(0.97);
    expect(a.metrics.tempo_bpm.value / 110).toBeLessThan(1.03);
  });
});

describe("rhythm against a pattern", () => {
  const PATTERN = "D_DU_UDU";
  const c = synthClicks({ pattern: PATTERN, bpm: 90, bars: 4, offsetMs: (_i, sym) => (sym === "U" ? -35 : 0) });
  const ev = { sampleRate: SR, samples: c.samples, click: { bpm: 90, firstBeatS: c.firstBeatS } };

  it("measures early upstrokes and fires the spec's mistake", () => {
    const a = analyzeAudio(spec({ reference: { pattern: PATTERN, beats_per_bar: 4, bars: 4 }, tempo: 90, grade: ["rhythm"], mistakes: [{ id: "early-upstrokes", when: "up_offset_ms < -20" }] }), ev);
    // D_DU_UDU: six strokes a bar, four bars
    expect(a.metrics.notes_expected.value).toBe(24);
    expect(a.metrics.notes_correct.value).toBe(24);
    expect(a.metrics.up_offset_ms.value).toBeLessThan(-28);
    expect(a.metrics.up_offset_ms.value).toBeGreaterThan(-42);
    expect(Math.abs(a.metrics.down_offset_ms.value)).toBeLessThan(6);
    expect(a.mistakes.map((m) => m.id)).toEqual(["early-upstrokes"]);
    expect(Math.abs(a.metrics.tempo_bpm.value - 90)).toBeLessThan(2);
  });

  it("stays quiet when the threshold isn't crossed", () => {
    const a = analyzeAudio(spec({ reference: { pattern: PATTERN }, tempo: 90, grade: ["rhythm"], mistakes: [{ id: "early-upstrokes", when: "up_offset_ms < -50" }] }), ev);
    expect(a.mistakes).toEqual([]);
    expect(a.metrics.onset_share_on_time.value).toBe(1);
  });

  it("grades plain onsets against the beat grid without a reference", () => {
    const beats = synthClicks({ pattern: "x.x.x.x.", bpm: 120, bars: 2, offsetMs: (i) => (i === 3 ? 50 : 0) });
    const a = analyzeAudio(spec({ tempo: 120, grade: ["rhythm"], tolerance: { onset_ms: 30 } }), { sampleRate: SR, samples: beats.samples, click: { bpm: 120, firstBeatS: beats.firstBeatS } });
    expect(a.metrics.notes_expected).toBeUndefined();
    expect(a.metrics.late_share.value).toBeCloseTo(1 / 8, 6);
    expect(a.metrics.mean_onset_ms.per![3]).toBeGreaterThan(40);
  });
});

describe("tempo", () => {
  for (const bpm of [60, 72, 96, 120, 144, 180]) {
    it(`estimates ${bpm} BPM within 3% from a click track`, () => {
      const times = Array.from({ length: 16 }, (_, i) => 0.3 + (i * 60) / bpm);
      const c = synthClicks(times, { sampleRate: SR });
      const on = detectOnsets(c.samples, SR);
      expect(on).toHaveLength(16);
      const est = estimateTempo(on);
      expect(Math.abs(est.bpm / bpm - 1)).toBeLessThan(0.03);
      expect(Math.abs(est.driftPct)).toBeLessThan(1);
      const grid = beatsFromOnsets(on);
      expect(grid.beats.length).toBe(16);
      grid.beats.forEach((b, i) => expect(Math.abs(b - times[i])).toBeLessThan(0.01));
    });
  }

  it("reports drift when the player speeds up", () => {
    const times: number[] = [];
    let t = 0.2;
    for (let i = 0; i < 24; i++) {
      times.push(t);
      t += 60 / (100 + i); // 100 -> 123 BPM
    }
    expect(estimateTempo(times).driftPct).toBeGreaterThan(5);
  });
});

describe("calibration", () => {
  it("finds the output delay from the tap test", () => {
    const clicks = Array.from({ length: 12 }, (_, i) => 0.5 + i * 0.75);
    const jitter = [5, -8, 3, 0, -4, 9, -2, 6, -7, 1, 4, -5];
    const taps = clicks.map((c, i) => c + 0.21 + jitter[i] / 1000);
    const r = calibrateOutputDelay(taps, clicks);
    expect(r.delayMs).toBeGreaterThan(205);
    expect(r.delayMs).toBeLessThan(215);
    expect(r.jitterMs).toBeGreaterThan(2);
    expect(r.jitterMs).toBeLessThan(10);
    expect(Number.isNaN(calibrateOutputDelay([], clicks).delayMs)).toBe(true);
  });
});

describe("quality", () => {
  const s = spec({ reference: { notes: MELODY }, tempo: 100 });
  it("asks to re-record silence", () => {
    const a = analyzeAudio(s, { sampleRate: SR, samples: silence(3, SR) });
    expect(a.quality.ok).toBe(false);
    expect(a.quality.reRecord).toMatch(/couldn't hear anything/);
    expect(a.metrics).toEqual({});
  });
  it("asks to re-record a take that is too short, clipping or too quiet", () => {
    expect(analyzeAudio(s, { sampleRate: SR, samples: synthTone({ hz: 440, seconds: 0.2, sampleRate: SR }) }).quality.issues).toContain("recording too short");
    const loud = synthTone({ hz: 440, seconds: 2, sampleRate: SR, amp: 3 }).map((x) => Math.max(-1, Math.min(1, x)));
    expect(analyzeAudio(s, { sampleRate: SR, samples: loud }).quality.issues).toContain("clipping audio");
    expect(analyzeAudio(s, { sampleRate: SR, samples: synthTone({ hz: 440, seconds: 2, sampleRate: SR, amp: 0.008 }) }).quality.issues).toContain("audio too quiet");
  });
  it("asks to re-record steady noise with no notes or hits", () => {
    const a = analyzeAudio(s, { sampleRate: SR, samples: synthNoise(3, SR, 0.2) });
    expect(a.quality.ok).toBe(false);
    expect(a.quality.reRecord).toMatch(/clear notes or hits/);
  });
  it("still measures a melody over light background noise", () => {
    const m = synthMelody(MELODY, 100, SR);
    const x = m.samples.slice();
    mixInto(x, synthNoise(x.length / SR, SR, 0.01, 3), 0);
    const a = analyzeAudio(s, { sampleRate: SR, samples: x, click: { bpm: 100, firstBeatS: m.firstBeatS } });
    expect(a.metrics.notes_correct.value).toBe(9);
    expect(a.metrics.mean_abs_onset_ms.value).toBeLessThan(10);
  });
});
