/** Turns any symbolic audio reference (notes, ABC, pattern, MIDI, MusicXML) into expected events. */
import type { AudioReference } from "@las/schema";
import { parseAbc } from "./abc.js";
import { midiToExpected, parseMidi } from "./midi.js";
import { parseMusicXml } from "./musicxml.js";
import { notesToEvents } from "./notes.js";
import { parsePattern } from "./pattern.js";
import type { ExpectedPart } from "./types.js";

export * from "./types.js";
export * from "./abc.js";
export * from "./midi.js";
export * from "./musicxml.js";
export * from "./notes.js";
export * from "./pattern.js";

/** Reference file contents the caller loaded: bytes for MIDI, bytes or text for MusicXML. */
export type ReferenceBytes = Uint8Array | ArrayBuffer | string;

function asText(b: ReferenceBytes): string {
  if (typeof b === "string") return b;
  return new TextDecoder().decode(b instanceof Uint8Array ? b : new Uint8Array(b));
}

/**
 * Expected events for a symbolic reference. A `recording` reference is not handled here (it
 * needs the audio analysis); it returns null like a missing file, with the reason.
 */
export function expectedFromReference(ref: AudioReference, bytes?: ReferenceBytes): { part: ExpectedPart | null; issue?: string } {
  if ("notes" in ref) return { part: { events: notesToEvents(ref.notes) } };
  if ("pattern" in ref) return { part: { events: parsePattern(ref.pattern, ref.beats_per_bar, ref.bars), beatsPerBar: ref.beats_per_bar } };
  if ("abc" in ref) {
    // the abc field holds the tune itself; a file path is read through bytes like the others
    const text = /\n|K:/.test(ref.abc) ? ref.abc : bytes !== undefined ? asText(bytes) : ref.abc;
    const t = parseAbc(text);
    return { part: t.events.length ? t : null, issue: t.events.length ? undefined : "the ABC reference has no notes" };
  }
  if ("midi" in ref) {
    if (bytes === undefined || typeof bytes === "string") return { part: null, issue: "the MIDI reference file wasn't supplied" };
    try {
      const p = midiToExpected(parseMidi(bytes), { track: ref.track, bars: ref.bars });
      return { part: p.events.length ? p : null, issue: p.events.length ? undefined : "the MIDI track has no notes" };
    } catch (e) {
      return { part: null, issue: `the MIDI reference couldn't be read: ${(e as Error).message}` };
    }
  }
  if ("score" in ref) {
    if (bytes === undefined) return { part: null, issue: "the score file wasn't supplied" };
    try {
      const p = parseMusicXml(asText(bytes), { part: ref.part, bars: ref.bars });
      return { part: p.events.length ? p : null, issue: p.events.length ? undefined : "the score part has no notes" };
    } catch (e) {
      return { part: null, issue: `the score couldn't be read: ${(e as Error).message}` };
    }
  }
  return { part: null, issue: "a recording reference needs the reference's audio" };
}

