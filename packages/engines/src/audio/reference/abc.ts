/**
 * A small ABC notation reader: enough of ABC 2.1 to turn a tune body into timed notes.
 *
 * Read: headers M: (meter), L: (unit length), Q: (tempo), K: (key signature and mode), V: (only
 * the first voice is kept); note letters with ^ _ = accidentals, ' and , octave marks and
 * lengths (2, /2, /, 3/2); rests z and x, whole-bar rests Z and X; chords [CEG]; ties -;
 * broken rhythm > and <; tuplets (3 and (p:q:r; inline fields [K:..]. Ignored: bar lines,
 * repeats and endings (not expanded), decorations, chord symbols, annotations, grace notes,
 * slurs. Accidentals carry to the end of the bar, as the standard says.
 *
 * Output beats are quarter notes.
 */
import type { ExpectedEvent, ExpectedPart } from "./types.js";

const STEP_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
/** Major-key position on the circle of fifths. */
const MAJOR_FIFTHS: Record<string, number> = { C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, F: -1 };
/** Fifths offset of each mode from its relative major. */
const MODE_OFFSET: Record<string, number> = { maj: 0, ion: 0, "": 0, mix: -1, dor: -2, m: -3, min: -3, aeo: -3, phr: -4, loc: -5, lyd: 1 };
const SHARP_ORDER = "FCGDAEB";
const FLAT_ORDER = "BEADGCF";

/** Accidental per letter for a key such as "G", "Dm", "Bb", "F#m", "Ador". */
export function keyAccidentals(key: string): Record<string, number> {
  const out: Record<string, number> = {};
  const m = /^\s*([A-Ga-g])([#b]?)\s*([A-Za-z]*)/.exec(key);
  if (!m || /^\s*(none|hp)\b/i.test(key)) return out;
  const mode = m[3].toLowerCase();
  const modeKey = mode === "m" ? "m" : mode.slice(0, 3);
  let fifths = MAJOR_FIFTHS[m[1].toUpperCase()] + (m[2] === "#" ? 7 : m[2] === "b" ? -7 : 0) + (MODE_OFFSET[modeKey] ?? 0);
  fifths = Math.max(-7, Math.min(7, fifths));
  for (let i = 0; i < Math.abs(fifths); i++) out[(fifths > 0 ? SHARP_ORDER : FLAT_ORDER)[i]] = fifths > 0 ? 1 : -1;
  return out;
}

function fraction(s: string): number {
  const m = /^\s*(\d+)\s*\/\s*(\d+)/.exec(s);
  return m ? Number(m[1]) / Number(m[2]) : NaN;
}

export interface AbcTune extends ExpectedPart {
  meter?: [number, number];
  unit: number;
  key: string;
  title?: string;
}

export function parseAbc(text: string): AbcTune {
  let meter: [number, number] | undefined;
  let unit = NaN;
  let tempoBpm: number | undefined;
  let tempoRaw: string | undefined;
  let key = "C";
  let title: string | undefined;
  let keyAcc: Record<string, number> = {};
  let barAcc: Record<string, number> = {};
  let firstVoice: string | undefined;
  let voiceOn = true;
  const events: ExpectedEvent[] = [];
  let beat = 0;
  // pending state between tokens
  let tieOpen: number[] = []; // midis tied from the last event
  let lastEvent: ExpectedEvent | undefined;
  let brokenNext = 1;
  let tuplet: { left: number; factor: number } | null = null;

  const field = (name: string, value: string) => {
    const v = value.trim();
    if (name === "M") {
      if (/^C\|/.test(v)) meter = [2, 2];
      else if (/^C/.test(v)) meter = [4, 4];
      else {
        const m = /^(\d+)\s*\/\s*(\d+)/.exec(v);
        if (m) meter = [Number(m[1]), Number(m[2])];
      }
    } else if (name === "L") unit = fraction(v);
    else if (name === "Q") tempoRaw = v;
    else if (name === "K") {
      key = v || "C";
      keyAcc = keyAccidentals(key);
    } else if (name === "T" && !title) title = v;
    else if (name === "V") {
      const id = v.split(/\s+/)[0];
      if (firstVoice === undefined) firstVoice = id;
      voiceOn = id === firstVoice;
    }
  };
  const unitLen = () => (Number.isFinite(unit) ? unit : meter && meter[0] / meter[1] < 0.75 ? 1 / 16 : 1 / 8);
  const barBeats = () => (meter ? (meter[0] / meter[1]) * 4 : 4);

  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (const raw of lines) {
    const line = raw.replace(/%.*$/, "");
    const f = /^([A-Za-z]):(.*)$/.exec(line);
    if (f) {
      field(f[1], f[2]);
      continue;
    }
    let i = 0;
    const s = line;
    const readLen = (): number => {
      const m = /^(\d*)(\/*)(\d*)/.exec(s.slice(i))!;
      i += m[0].length;
      const num = m[1] ? Number(m[1]) : 1;
      if (!m[2]) return num;
      if (m[3]) return num / Number(m[3]);
      return num / 2 ** m[2].length;
    };
    const readNote = (): { midi: number; len: number } | null => {
      let acc: number | null = null;
      while (s[i] === "^" || s[i] === "_" || s[i] === "=") {
        acc = (acc ?? 0) + (s[i] === "^" ? 1 : s[i] === "_" ? -1 : 0);
        i++;
      }
      const c = s[i];
      if (!c || !/[A-Ga-g]/.test(c)) return null;
      i++;
      let octave = c === c.toLowerCase() ? 5 : 4;
      while (s[i] === "'" || s[i] === ",") {
        octave += s[i] === "'" ? 1 : -1;
        i++;
      }
      const letter = c.toUpperCase();
      const id = `${letter}${octave}`;
      if (acc !== null) barAcc[id] = acc;
      const alter = barAcc[id] ?? keyAcc[letter] ?? 0;
      const len = readLen();
      return { midi: 12 * (octave + 1) + STEP_PC[letter] + alter, len };
    };
    const place = (midis: number[], lenUnits: number, rest: boolean) => {
      let len = lenUnits * unitLen() * 4 * brokenNext;
      brokenNext = 1;
      if (tuplet) {
        len *= tuplet.factor;
        if (--tuplet.left <= 0) tuplet = null;
      }
      if (!voiceOn) return;
      if (rest) {
        tieOpen = [];
        lastEvent = undefined;
      } else {
        const tied = midis.length > 0 && tieOpen.length > 0 && midis.every((m) => tieOpen.includes(m));
        if (tied && lastEvent) lastEvent.dur += len;
        else {
          lastEvent = { beat, dur: len, midis };
          events.push(lastEvent);
        }
        tieOpen = [];
      }
      beat += len;
    };

    while (i < s.length) {
      const c = s[i];
      if (c === '"') {
        i = s.indexOf('"', i + 1);
        i = i < 0 ? s.length : i + 1;
      } else if (c === "!" || (c === "+" && s.indexOf("+", i + 1) > i)) {
        const j = s.indexOf(c, i + 1);
        i = j < 0 ? s.length : j + 1;
      } else if (c === "{") {
        const j = s.indexOf("}", i);
        i = j < 0 ? s.length : j + 1;
      } else if (c === "[" && /^\[[A-Za-z]:/.test(s.slice(i))) {
        const j = s.indexOf("]", i);
        const body = s.slice(i + 1, j < 0 ? s.length : j);
        field(body[0], body.slice(2));
        i = j < 0 ? s.length : j + 1;
      } else if (c === "|" || c === ":" || (c === "[" && /^\[[|\d]/.test(s.slice(i)))) {
        barAcc = {};
        i++;
        while (i < s.length && /[|:\]\d]/.test(s[i])) i++;
      } else if (c === "[") {
        // chord: [CEG]2
        i++;
        const midis: number[] = [];
        let first = 1;
        while (i < s.length && s[i] !== "]") {
          const n = readNote();
          if (n) {
            if (!midis.length) first = n.len;
            midis.push(n.midi);
          } else i++;
        }
        i++;
        const mult = readLen();
        place(midis, first * mult, false);
      } else if (c === "(" && /\d/.test(s[i + 1] ?? "")) {
        const m = /^\((\d+)(?::(\d*))?(?::(\d*))?/.exec(s.slice(i))!;
        i += m[0].length;
        const p = Number(m[1]);
        const compound = !!meter && meter[0] % 3 === 0 && meter[0] > 3;
        const qDefault: Record<number, number> = { 2: 3, 3: 2, 4: 3, 6: 2, 8: 3 };
        const q = m[2] ? Number(m[2]) : (qDefault[p] ?? (compound ? 3 : 2));
        const r = m[3] ? Number(m[3]) : p;
        tuplet = { left: r, factor: q / p };
      } else if (c === "-") {
        tieOpen = lastEvent ? lastEvent.midis.slice() : [];
        i++;
      } else if (c === ">" || c === "<") {
        let n = 0;
        while (s[i] === c) {
          n++;
          i++;
        }
        const short = 1 / 2 ** n;
        const long = 2 - short;
        if (lastEvent) {
          const extra = lastEvent.dur * ((c === ">" ? long : short) - 1);
          lastEvent.dur += extra;
          beat += extra;
        }
        brokenNext = c === ">" ? short : long;
      } else if (c === "z" || c === "x") {
        i++;
        place([], readLen(), true);
      } else if (c === "Z" || c === "X") {
        i++;
        const m = /^\d+/.exec(s.slice(i));
        if (m) i += m[0].length;
        const barsN = m ? Number(m[0]) : 1;
        if (voiceOn) beat += barsN * barBeats();
        lastEvent = undefined;
      } else if (/[\^_=A-Ga-g]/.test(c)) {
        const n = readNote();
        if (n) place([n.midi], n.len, false);
        else i++;
      } else i++;
    }
  }

  if (tempoRaw) {
    const m = /(\d+)\s*\/\s*(\d+)\s*=\s*(\d+(?:\.\d+)?)/.exec(tempoRaw);
    if (m) tempoBpm = Number(m[3]) * 4 * (Number(m[1]) / Number(m[2]));
    else {
      const n = /^\s*(\d+(?:\.\d+)?)\s*$/.exec(tempoRaw);
      if (n) tempoBpm = Number(n[1]) * unitLen() * 4;
    }
  }
  return { events, tempoBpm, beatsPerBar: barBeats(), meter, unit: unitLen(), key, title };
}
