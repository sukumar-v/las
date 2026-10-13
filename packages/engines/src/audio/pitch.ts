/**
 * Pitch arithmetic in twelve-tone equal temperament: note names <-> MIDI numbers <-> Hz, and
 * cents. Note names use scientific pitch notation ("C4" is middle C, "A4" is the tuning note)
 * with #/b accidentals (also ♯/♭, x for a double sharp).
 */

const STEP_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const PC_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** Words that mean "no note" in a notes reference. */
const REST_NAMES = new Set(["r", "rest", "z", "-", "_", "."]);

export function isRestName(name: string): boolean {
  return REST_NAMES.has(name.trim().toLowerCase());
}

/** MIDI note number for a name like "C#4", "Bb3", "F##2", "E♭5". Returns NaN when it can't be read. */
export function noteToMidi(name: string): number {
  const m = /^\s*([A-Ga-g])((?:#|b|♯|♭|x)*)(-?\d+)\s*$/.exec(name);
  if (!m) return NaN;
  let acc = 0;
  for (const c of m[2]) acc += c === "#" || c === "♯" ? 1 : c === "x" ? 2 : -1;
  return 12 * (Number(m[3]) + 1) + STEP_PC[m[1].toUpperCase()] + acc;
}

export function midiToHz(midi: number, tuning = 440): number {
  return tuning * 2 ** ((midi - 69) / 12);
}

/** Fractional MIDI number of a frequency (69 = the tuning note). */
export function hzToMidi(hz: number, tuning = 440): number {
  return 69 + 12 * Math.log2(hz / tuning);
}

/** Hz for a note name or a number already in Hz. */
export function noteToHz(note: string | number, tuning = 440): number {
  return typeof note === "number" ? note : midiToHz(noteToMidi(note), tuning);
}

export function midiName(midi: number): string {
  const r = Math.round(midi);
  return `${PC_NAMES[((r % 12) + 12) % 12]}${Math.floor(r / 12) - 1}`;
}

/** Signed distance from `targetHz` in cents (positive = sharp). */
export function centsOff(hz: number, targetHz: number): number {
  return 1200 * Math.log2(hz / targetHz);
}

/** Nearest equal-tempered note to `hz` and how far off it is. */
export function noteName(hz: number, tuning = 440): { name: string; midi: number; cents: number } {
  const m = hzToMidi(hz, tuning);
  const r = Math.round(m);
  return { name: midiName(r), midi: r, cents: (m - r) * 100 };
}
