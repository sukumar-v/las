/**
 * A minimal Standard MIDI File reader (format 0 and 1): header, track chunks, variable-length
 * delta times, running status, note on/off (velocity 0 = off), tempo and time signature meta
 * events. Other events are skipped by their declared lengths.
 */
import { mergeSimultaneous, parseBarRange, sliceBars, type ExpectedEvent, type ExpectedPart } from "./types.js";

export interface MidiNote {
  tick: number;
  durationTicks: number;
  midi: number;
  velocity: number;
  channel: number;
}
export interface MidiTrack {
  name?: string;
  notes: MidiNote[];
}
export interface MidiFile {
  format: number;
  /** ticks per quarter note; for SMPTE timing, ticks per second as a negative number */
  division: number;
  tracks: MidiTrack[];
  tempos: { tick: number; usPerQuarter: number }[];
  timeSignatures: { tick: number; num: number; den: number }[];
}

/** General MIDI reserves channel 10 (index 9) for unpitched percussion. */
const PERCUSSION_CHANNEL = 9;

export function parseMidi(input: Uint8Array | ArrayBuffer): MidiFile {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  let p = 0;
  const u32 = () => {
    const v = ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
    p += 4;
    return v;
  };
  const u16 = () => {
    const v = (b[p] << 8) | b[p + 1];
    p += 2;
    return v;
  };
  const str4 = () => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
  const vlq = () => {
    let v = 0;
    for (let k = 0; k < 4; k++) {
      const c = b[p++];
      v = (v << 7) | (c & 0x7f);
      if (!(c & 0x80)) break;
    }
    return v;
  };

  if (str4() !== "MThd") throw new Error("not a Standard MIDI File (missing MThd)");
  p += 4;
  const hlen = u32();
  const hstart = p;
  const format = u16();
  const ntrks = u16();
  const rawDiv = u16();
  p = hstart + hlen;
  const division = rawDiv & 0x8000 ? -((256 - (rawDiv >> 8)) * (rawDiv & 0xff)) : rawDiv;

  const tracks: MidiTrack[] = [];
  const tempos: MidiFile["tempos"] = [];
  const timeSignatures: MidiFile["timeSignatures"] = [];
  for (let t = 0; t < ntrks && p + 8 <= b.length; t++) {
    const id = str4();
    p += 4;
    const len = u32();
    const end = Math.min(b.length, p + len);
    if (id !== "MTrk") {
      p = end;
      continue;
    }
    const track: MidiTrack = { notes: [] };
    const open = new Map<number, MidiNote[]>(); // (channel << 8 | key) -> started notes
    let tick = 0;
    let status = 0;
    while (p < end) {
      tick += vlq();
      let s = b[p];
      if (s & 0x80) p++;
      else s = status; // running status
      if (s === 0xff) {
        const type = b[p++];
        const l = vlq();
        const d = b.subarray(p, p + l);
        if (type === 0x51 && l >= 3) tempos.push({ tick, usPerQuarter: (d[0] << 16) | (d[1] << 8) | d[2] });
        else if (type === 0x58 && l >= 2) timeSignatures.push({ tick, num: d[0], den: 2 ** d[1] });
        else if (type === 0x03 && track.name === undefined) track.name = new TextDecoder().decode(d);
        p += l;
        if (type === 0x2f) break;
        continue;
      }
      if (s === 0xf0 || s === 0xf7) {
        p += vlq();
        continue;
      }
      status = s;
      const kind = s & 0xf0;
      const ch = s & 0x0f;
      if (kind === 0x80 || kind === 0x90) {
        const key = b[p++];
        const vel = b[p++];
        const k = (ch << 8) | key;
        if (kind === 0x90 && vel > 0) {
          const n: MidiNote = { tick, durationTicks: 0, midi: key, velocity: vel, channel: ch };
          track.notes.push(n);
          const list = open.get(k) ?? [];
          list.push(n);
          open.set(k, list);
        } else {
          const n = open.get(k)?.shift();
          if (n) n.durationTicks = tick - n.tick;
        }
      } else if (kind === 0xc0 || kind === 0xd0) p += 1;
      else p += 2;
    }
    p = end;
    tracks.push(track);
  }
  return { format, division, tracks, tempos, timeSignatures };
}

/** Turns one track of a MIDI file into expected events in quarter-note beats. */
export function midiToExpected(file: MidiFile, opts: { track?: number; bars?: string } = {}): ExpectedPart {
  const track = opts.track !== undefined ? file.tracks[opts.track] : file.tracks.find((t) => t.notes.length > 0);
  if (!track) return { events: [] };
  // SMPTE timing has no beats; read it at 120 beats per minute (one beat = 0.5 s)
  const tpq = file.division > 0 ? file.division : -file.division / 2;
  const tempoBpm = file.division > 0 ? (file.tempos.length ? 60e6 / file.tempos[0].usPerQuarter : 120) : 120;
  const ts = file.timeSignatures[0];
  const beatsPerBar = ts ? (ts.num * 4) / ts.den : 4;
  const events: ExpectedEvent[] = track.notes.map((n) => ({
    beat: n.tick / tpq,
    dur: Math.max(n.durationTicks, 1) / tpq,
    midis: n.channel === PERCUSSION_CHANNEL ? [] : [n.midi]
  }));
  const merged = mergeSimultaneous(events, 1 / 64);
  return { events: sliceBars(merged, parseBarRange(opts.bars), beatsPerBar), tempoBpm, beatsPerBar };
}
