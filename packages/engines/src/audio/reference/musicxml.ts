/**
 * A minimal uncompressed MusicXML (partwise) reader for one part: <divisions>, <time>, <note>
 * with <pitch> (<step>, <alter>, <octave>), <unpitched>, <rest>, <chord/>, <grace/> (skipped),
 * <tie type="stop"> (merged into the previous note), <staff>, <backup> and <forward>, and the
 * first <sound tempo>. Beats are quarter notes. It reads text with regular expressions, so it
 * needs no DOM and runs the same in Node and the browser.
 */
import { mergeSimultaneous, parseBarRange, type ExpectedEvent, type ExpectedPart } from "./types.js";

const STEP_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
/** Words that pick a staff of a multi-staff part when the part name doesn't match: notation vocabulary only. */
const STAFF_WORDS: { re: RegExp; staff: "first" | "last" }[] = [
  { re: /\b(upper|top|treble|right|staff ?1)\b/, staff: "first" },
  { re: /\b(lower|bottom|bass|left|staff ?2)\b/, staff: "last" }
];

const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, " ").trim();
const tag = (xml: string, name: string): string | undefined => new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`).exec(xml)?.[1]?.trim();

export interface MusicXmlPart extends ExpectedPart {
  partId: string;
  partName?: string;
  staff?: number;
}

/**
 * `part` picks a part by id ("P1") or name ("Violin"), optionally with "#2" for a staff; words
 * like "upper"/"lower" pick the first/last staff of a multi-staff part. Default: the first part.
 */
export function parseMusicXml(text: string, opts: { part?: string; bars?: string } = {}): MusicXmlPart {
  const names = new Map<string, string>();
  for (const m of text.matchAll(/<score-part\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/score-part>/g)) names.set(m[1], tag(m[2], "part-name") ?? "");
  const parts = [...text.matchAll(/<part\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/part>/g)].map((m) => ({ id: m[1], body: m[2] }));
  if (!parts.length) throw new Error("no <part> found in MusicXML");

  let wantStaff: number | "last" | undefined;
  let chosen = parts[0];
  if (opts.part) {
    const [label, staffNo] = opts.part.split("#");
    if (staffNo) wantStaff = Number(staffNo);
    const n = norm(label);
    const hit = parts.find((p) => norm(p.id) === n || norm(names.get(p.id) ?? "") === n);
    if (hit) chosen = hit;
    else if (!staffNo) {
      const w = STAFF_WORDS.find((s) => s.re.test(n));
      if (w) wantStaff = w.staff === "first" ? 1 : "last";
    }
  }
  const staves = Number(/<staves>\s*(\d+)\s*<\/staves>/.exec(chosen.body)?.[1] ?? 1);
  const staff = wantStaff === "last" ? staves : wantStaff;

  let divisions = 1;
  let beatsPerBar = 4;
  let tempoBpm: number | undefined;
  const events: ExpectedEvent[] = [];
  let measureStart = 0;
  const lastByMidi = new Map<number, ExpectedEvent>();
  let lastOnset = 0;
  let measureIdx = 0;
  const kept: { measure: number; ev: ExpectedEvent }[] = [];
  const measureStarts = new Map<number, number>();

  for (const mm of chosen.body.matchAll(/<measure\b([^>]*)>([\s\S]*?)<\/measure>/g)) {
    measureIdx++;
    const numAttr = /number="(\d+)"/.exec(mm[1])?.[1];
    const measureNo = numAttr !== undefined ? Number(numAttr) : measureIdx;
    if (!measureStarts.has(measureNo)) measureStarts.set(measureNo, measureStart);
    let cursor = 0;
    let maxCursor = 0;
    for (const el of mm[2].matchAll(/<(attributes|note|backup|forward|sound|direction)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g)) {
      const kind = el[1];
      const attrs = el[2] ?? "";
      const body = el[3] ?? "";
      if (kind === "attributes") {
        const d = tag(body, "divisions");
        if (d) divisions = Number(d) || divisions;
        const beats = tag(body, "beats");
        const bt = tag(body, "beat-type");
        if (beats && bt) beatsPerBar = (Number(beats) * 4) / Number(bt);
      } else if (kind === "sound" || kind === "direction") {
        const tm = /tempo="([\d.]+)"/.exec(kind === "sound" ? attrs : body)?.[1] ?? tag(body, "per-minute");
        if (tm && tempoBpm === undefined) tempoBpm = Number(tm);
      } else if (kind === "backup" || kind === "forward") {
        const d = Number(tag(body, "duration") ?? 0) / divisions;
        cursor += kind === "backup" ? -d : d;
        maxCursor = Math.max(maxCursor, cursor);
      } else {
        if (/<grace\b/.test(body)) continue;
        const dur = Number(tag(body, "duration") ?? 0) / divisions;
        const isChord = /<chord\s*\/?>/.test(body);
        const onset = isChord ? lastOnset : measureStart + cursor;
        if (!isChord) {
          lastOnset = onset;
          cursor += dur;
          maxCursor = Math.max(maxCursor, cursor);
        }
        if (/<rest\b/.test(body)) continue;
        const noteStaff = Number(tag(body, "staff") ?? 1);
        if (staff !== undefined && noteStaff !== staff) continue;
        let midi: number | null = null;
        const pitch = tag(body, "pitch");
        if (pitch) {
          const step = tag(pitch, "step") ?? "C";
          const alter = Math.round(Number(tag(pitch, "alter") ?? 0));
          const octave = Number(tag(pitch, "octave") ?? 4);
          midi = 12 * (octave + 1) + (STEP_PC[step] ?? 0) + alter;
        }
        const tieStop = /<tie\s+type="stop"/.test(body);
        const prev = midi !== null ? lastByMidi.get(midi) : undefined;
        if (tieStop && prev) {
          prev.dur = onset + dur - prev.beat;
          continue;
        }
        const ev: ExpectedEvent = { beat: onset, dur, midis: midi === null ? [] : [midi] };
        if (midi !== null) lastByMidi.set(midi, ev);
        events.push(ev);
        kept.push({ measure: measureNo, ev });
      }
    }
    measureStart += Math.max(maxCursor, 0);
  }

  // bars are counted by measure number, so pickups numbered 0 sit before bar 1
  const range = parseBarRange(opts.bars);
  let selected = events;
  if (range) {
    const inRange = kept.filter((k) => k.measure >= range[0] && k.measure <= range[1]).map((k) => k.ev);
    const from = measureStarts.get(range[0]) ?? (inRange.length ? Math.min(...inRange.map((e) => e.beat)) : 0);
    selected = inRange.map((e) => ({ ...e, beat: e.beat - from }));
  }
  return { events: mergeSimultaneous(selected), tempoBpm, beatsPerBar, partId: chosen.id, partName: names.get(chosen.id), staff };
}
