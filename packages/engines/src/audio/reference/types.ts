/** What a reference says should be played, in beats, before any timing is known. */
export interface ExpectedEvent {
  /** onset in beats from the start of the reference (quarter notes for scores, MIDI and ABC) */
  beat: number;
  /** length in beats */
  dur: number;
  /** MIDI note numbers that start here; empty for an unpitched onset (a pattern hit, a percussion note) */
  midis: number[];
  /** the pattern symbol for pattern references, e.g. "x", "D", "U" */
  symbol?: string;
}

export interface ExpectedPart {
  events: ExpectedEvent[];
  /** tempo the reference itself declares, in beats per minute */
  tempoBpm?: number;
  beatsPerBar?: number;
}

/** "3-8" or "5" -> [first, last] (1-based, inclusive). */
export function parseBarRange(bars: string | undefined): [number, number] | null {
  if (!bars) return null;
  const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(bars);
  if (!m) return null;
  const a = Number(m[1]);
  return [a, m[2] ? Number(m[2]) : a];
}

/** Keep the events inside bars [first, last] and shift them so the first kept bar starts at beat 0. */
export function sliceBars(events: ExpectedEvent[], range: [number, number] | null, beatsPerBar: number): ExpectedEvent[] {
  if (!range) return events;
  const from = (range[0] - 1) * beatsPerBar;
  const to = range[1] * beatsPerBar;
  return events.filter((e) => e.beat >= from - 1e-9 && e.beat < to - 1e-9).map((e) => ({ ...e, beat: e.beat - from }));
}

/** Merge events that start together (chords, several voices) into one event. */
export function mergeSimultaneous(events: ExpectedEvent[], eps = 1e-6): ExpectedEvent[] {
  const sorted = events.slice().sort((a, b) => a.beat - b.beat);
  const out: ExpectedEvent[] = [];
  for (const e of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.beat - e.beat) <= eps) {
      for (const m of e.midis) if (!last.midis.includes(m)) last.midis.push(m);
      last.dur = Math.max(last.dur, e.dur);
    } else out.push({ ...e, midis: e.midis.slice() });
  }
  return out;
}
