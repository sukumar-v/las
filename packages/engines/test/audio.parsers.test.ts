import { describe, expect, it } from "vitest";
import { AudioSpecSchema } from "@las/schema";
import { analyzeAudio, expectedFromReference, keyAccidentals, midiToExpected, midiToHz, parseAbc, parseMidi, parseMusicXml, parsePattern, type ExpectedEvent } from "../src/audio/index.js";
import { synthMelody } from "../src/audio/synth.js";

const SR = 44100;
const pick = (evs: ExpectedEvent[]) => evs.map((e) => [Math.round(e.beat * 1000) / 1000, e.midis, Math.round(e.dur * 1000) / 1000]);

/** Expected events -> a melody the synthesizer can play (gaps become rests). */
function toMelody(events: ExpectedEvent[]): [string | number, number][] {
  const out: [string | number, number][] = [];
  let beat = 0;
  for (const e of events) {
    if (e.beat > beat + 1e-9) out.push(["r", e.beat - beat]);
    out.push([midiToHz(e.midis[0]), e.dur]);
    beat = e.beat + e.dur;
  }
  return out;
}

// ------------------------------------------------------------- a tiny Standard MIDI File writer
const vlq = (n: number) => {
  const bytes = [n & 0x7f];
  while ((n >>= 7)) bytes.unshift((n & 0x7f) | 0x80);
  return bytes;
};
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const chunk = (id: string, data: number[]) => [...[...id].map((c) => c.charCodeAt(0)), ...u32(data.length), ...data];
function smf(tracks: number[][], division = 480): Uint8Array {
  return new Uint8Array([...chunk("MThd", [0, 1, 0, tracks.length, division >> 8, division & 255]), ...tracks.flatMap((t) => chunk("MTrk", [...t, 0, 0xff, 0x2f, 0]))]);
}
/** [deltaTicks, ...event bytes] list -> track bytes */
const track = (events: number[][]) => events.flatMap(([d, ...e]) => [...vlq(d), ...e]);
const name = (s: string) => [0, 0xff, 0x03, s.length, ...[...s].map((c) => c.charCodeAt(0))];

describe("ABC", () => {
  it("reads key, lengths, octaves, accidentals, chords, ties, broken rhythm and triplets", () => {
    const tune = `X:1
T:Test tune
M:3/4
L:1/8
Q:1/4=90
K:G
G2 AB | c2 B>A G2 | [DG]4 z2 | (3efg f2- f2 | _B,2 =F c' ^c c |]`;
    const t = parseAbc(tune);
    expect(t.title).toBe("Test tune");
    expect(t.tempoBpm).toBe(90);
    expect(t.beatsPerBar).toBe(3);
    expect(pick(t.events)).toEqual([
      [0, [67], 1],
      [1, [69], 0.5],
      [1.5, [71], 0.5],
      [2, [72], 1],
      [3, [71], 0.75],
      [3.75, [69], 0.25],
      [4, [67], 1],
      [5, [62, 67], 2],
      [8, [76], 0.333],
      [8.333, [78], 0.333],
      [8.667, [79], 0.333],
      [9, [78], 2],
      [11, [58], 1],
      [12, [65], 0.5],
      [12.5, [84], 0.5],
      [13, [73], 0.5],
      [13.5, [73], 0.5]
    ]);
  });

  it("knows key signatures and modes", () => {
    expect(keyAccidentals("C")).toEqual({});
    expect(keyAccidentals("Bb")).toEqual({ B: -1, E: -1 });
    expect(keyAccidentals("F#m")).toEqual({ F: 1, C: 1, G: 1 });
    expect(keyAccidentals("Ador")).toEqual({ F: 1 });
    expect(keyAccidentals("Dmix")).toEqual({ F: 1 });
    expect(keyAccidentals("Eb")).toEqual({ B: -1, E: -1, A: -1 });
  });

  it("round-trips through the analyzer", () => {
    const abc = "X:1\nM:4/4\nL:1/4\nQ:1/4=96\nK:D\nD E F G | A2 d2 |]";
    const part = parseAbc(abc);
    const m = synthMelody(toMelody(part.events), 96, SR);
    const a = analyzeAudio(AudioSpecSchema.parse({ reference: { abc } }), { sampleRate: SR, samples: m.samples, click: { bpm: 96, firstBeatS: m.firstBeatS } });
    expect(a.metrics.notes_expected.value).toBe(6);
    expect(a.metrics.notes_correct.value).toBe(6);
    expect(a.metrics.mean_abs_onset_ms.value).toBeLessThan(10);
    expect(a.metrics.mean_abs_cents.value).toBeLessThan(5);
  });
});

describe("patterns", () => {
  it("reads step patterns, bars and beat lists", () => {
    expect(parsePattern("x.x.", 4, 1).map((e) => e.beat)).toEqual([0, 2]);
    expect(parsePattern("D_DU", 2, 2).map((e) => [e.beat, e.symbol])).toEqual([
      [0, "D"],
      [1, "D"],
      [1.5, "U"],
      [2, "D"],
      [3, "D"],
      [3.5, "U"]
    ]);
    expect(parsePattern("x... | x.x.", 4, 4).map((e) => e.beat)).toEqual([0, 4, 6, 8, 12, 14]);
    expect(parsePattern("1 2 2.5 4", 4, 1).map((e) => e.beat)).toEqual([0, 1, 1.5, 3]);
    expect(parsePattern("0, 1.5, 3", 4, 2).map((e) => e.beat)).toEqual([0, 1.5, 3, 4, 5.5, 7]);
  });
});

describe("MIDI", () => {
  const tempoTrack = track([
    [0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20], // 500000 us per quarter = 120 BPM
    [0, 0xff, 0x58, 4, 3, 2, 24, 8] // 3/4
  ]);
  const melody = track([
    name("Melody"),
    [0, 0x90, 60, 100],
    [480, 0x80, 60, 0],
    [0, 0x90, 64, 90],
    [240, 64, 0], // running status, velocity 0 = note off
    [240, 67, 80],
    [0, 71, 80],
    [480, 67, 0],
    [0, 71, 0],
    [480, 74, 100],
    [480, 74, 0]
  ]);
  const drums = track([
    [0, 0x99, 38, 100],
    [120, 0x89, 38, 0],
    [360, 0x99, 42, 100],
    [120, 0x89, 42, 0]
  ]);
  const bytes = smf([tempoTrack, melody, drums]);

  it("parses tracks, tempo, time signature, running status and note-off by velocity 0", () => {
    const f = parseMidi(bytes);
    expect(f.format).toBe(1);
    expect(f.division).toBe(480);
    expect(f.tracks).toHaveLength(3);
    expect(f.tempos).toEqual([{ tick: 0, usPerQuarter: 500000 }]);
    expect(f.timeSignatures).toEqual([{ tick: 0, num: 3, den: 4 }]);
    expect(f.tracks[1].name).toBe("Melody");
    expect(f.tracks[1].notes.map((n) => [n.tick, n.midi, n.durationTicks])).toEqual([
      [0, 60, 480],
      [480, 64, 240],
      [960, 67, 480],
      [960, 71, 480],
      [1920, 74, 480]
    ]);
  });

  it("turns a track into expected events, with chords, drums and bar ranges", () => {
    const f = parseMidi(bytes);
    const p = midiToExpected(f);
    expect(p.tempoBpm).toBe(120);
    expect(p.beatsPerBar).toBe(3);
    expect(pick(p.events)).toEqual([
      [0, [60], 1],
      [1, [64], 0.5],
      [2, [67, 71], 1],
      [4, [74], 1]
    ]);
    expect(pick(midiToExpected(f, { track: 2 }).events)).toEqual([
      [0, [], 0.25],
      [1, [], 0.25]
    ]);
    expect(pick(midiToExpected(f, { bars: "2" }).events)).toEqual([[1, [74], 1]]);
    expect(expectedFromReference({ midi: "song.mid" }).issue).toMatch(/wasn't supplied/);
  });

  it("round-trips through the analyzer with the bytes in the context", () => {
    const simple = smf([tempoTrack, track([[0, 0x90, 62, 100], [480, 62, 0], [0, 66, 100], [480, 66, 0], [0, 69, 100], [960, 69, 0]])]);
    const events = midiToExpected(parseMidi(simple)).events;
    const m = synthMelody(toMelody(events), 120, SR, { pitchErrorCents: { 1: -30 } });
    const a = analyzeAudio(AudioSpecSchema.parse({ reference: { midi: "song.mid" }, tolerance: { pitch_cents: 20 } }), { sampleRate: SR, samples: m.samples, click: { bpm: 120, firstBeatS: m.firstBeatS } }, { referenceBytes: simple });
    expect(a.metrics.notes_expected.value).toBe(3);
    expect(a.metrics.pitch_accuracy.value).toBeCloseTo(2 / 3, 6);
    expect(a.metrics.pitch_accuracy.per![1]).toBeLessThan(-25);
  });
});

describe("MusicXML", () => {
  const xml = `<?xml version="1.0"?>
<score-partwise version="4.0">
  <part-list>
    <score-part id="P1"><part-name>Flute</part-name></score-part>
    <score-part id="P2"><part-name>Keys</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>2</divisions><time><beats>2</beats><beat-type>4</beat-type></time></attributes>
      <direction><sound tempo="84"/></direction>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>2</duration></note>
      <note><pitch><step>E</step><alter>-1</alter><octave>5</octave></pitch><duration>1</duration><tie type="start"/></note>
      <note><pitch><step>E</step><alter>-1</alter><octave>5</octave></pitch><duration>1</duration><tie type="stop"/></note>
    </measure>
    <measure number="2">
      <note><rest/><duration>1</duration></note>
      <note><grace/><pitch><step>D</step><octave>5</octave></pitch></note>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration></note>
      <note><chord/><pitch><step>B</step><octave>4</octave></pitch><duration>1</duration></note>
      <note><pitch><step>F</step><alter>1</alter><octave>4</octave></pitch><duration>2</duration></note>
    </measure>
  </part>
  <part id="P2">
    <measure number="1">
      <attributes><divisions>1</divisions><staves>2</staves></attributes>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><staff>1</staff></note>
      <backup><duration>2</duration></backup>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>1</duration><staff>2</staff></note>
      <note><pitch><step>G</step><octave>2</octave></pitch><duration>1</duration><staff>2</staff></note>
    </measure>
  </part>
</score-partwise>`;

  it("reads notes, alters, ties, rests, grace notes, chords and tempo", () => {
    const p = parseMusicXml(xml);
    expect(p.partId).toBe("P1");
    expect(p.partName).toBe("Flute");
    expect(p.tempoBpm).toBe(84);
    expect(p.beatsPerBar).toBe(2);
    expect(pick(p.events)).toEqual([
      [0, [72], 1],
      [1, [75], 1],
      [2.5, [67, 71], 0.5],
      [3, [66], 1]
    ]);
  });

  it("picks parts, staves and bars", () => {
    expect(pick(parseMusicXml(xml, { bars: "2" }).events)).toEqual([
      [0.5, [67, 71], 0.5],
      [1, [66], 1]
    ]);
    expect(pick(parseMusicXml(xml, { part: "keys#2" }).events)).toEqual([
      [0, [48], 1],
      [1, [43], 1]
    ]);
    expect(pick(parseMusicXml(xml, { part: "P2#1" }).events)).toEqual([[0, [64], 2]]);
    expect(pick(parseMusicXml(xml, { part: "keys" }).events)).toEqual([
      [0, [64, 48], 2],
      [1, [43], 1]
    ]);
  });

  it("round-trips through the analyzer", () => {
    const solo = xml.replace(/<note><chord\/>[\s\S]*?<\/note>/, "");
    const events = parseMusicXml(solo).events;
    const m = synthMelody(toMelody(events), 84, SR, { onsetErrorMs: { 2: 70 } });
    const a = analyzeAudio(AudioSpecSchema.parse({ reference: { score: "piece.musicxml" }, mistakes: [{ id: "late", when: "late_share > 0" }] }), { sampleRate: SR, samples: m.samples, click: { bpm: 84, firstBeatS: m.firstBeatS } }, { referenceBytes: new TextEncoder().encode(solo) });
    expect(a.metrics.notes_expected.value).toBe(4);
    expect(a.metrics.notes_correct.value).toBe(4);
    expect(a.metrics.mean_onset_ms.per![2]).toBeGreaterThan(60);
    expect(a.mistakes.map((x) => x.id)).toEqual(["late"]);
  });
});
