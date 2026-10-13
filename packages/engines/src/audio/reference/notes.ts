/** A melody written inline as [note name, beats] pairs; "r"/"rest"/"z" are rests. */
import { isRestName, noteToMidi } from "../pitch.js";
import type { ExpectedEvent } from "./types.js";

export function notesToEvents(notes: [string, number][]): ExpectedEvent[] {
  const out: ExpectedEvent[] = [];
  let beat = 0;
  for (const [name, beats] of notes) {
    if (!isRestName(name)) {
      // a chord may be written "C4+E4+G4" or "C4 E4 G4"
      const midis = name.split(/[+\s,]+/).filter(Boolean).map(noteToMidi).filter(Number.isFinite);
      out.push({ beat, dur: beats, midis });
    }
    beat += beats;
  }
  return out;
}
