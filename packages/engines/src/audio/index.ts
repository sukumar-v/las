/**
 * The audio engine: any instrument, voice or percussion against any reference. It measures
 * pitch (cents), right and wrong notes, timing against the beat (ms), tempo and its drift, and
 * dynamics, then evaluates the spec's pass expression, mistake detectors and the caller's
 * proof criteria over those metrics. It never knows which instrument or piece it is hearing.
 *
 * Pipeline: quality check -> pitch track, onsets, notes -> expected events from the reference
 * -> grid (click, tempo or fitted) -> alignment -> metrics -> mistakes, markers, overlay.
 */
import { CONFIDENCE_FLOOR, type Analysis, type AudioSpec, type Value } from "@las/schema";
import { applyConfidenceFloor, evalCondition, evalCriteria, finish, mean, metric, metricVars, reRecord, std, version } from "../common/analysis.js";
import type { AnalyzeContext, AudioEvidence } from "../types.js";
import { criteriaFrom, namesIn } from "./context.js";
import { fitAndAlign, type Alignment, type Grid, type PlayedEvent } from "./align.js";
import { linearFit, rmsOf, toDb } from "./dsp.js";
import { detectNotes, detectOnsets, detectPitchTrack, levelAt, type DetectedNote } from "./features.js";
import { midiName, midiToHz } from "./pitch.js";
import { expectedFromReference, type ExpectedEvent, type ExpectedPart, type ReferenceBytes } from "./reference/index.js";
import { estimateTempo } from "./tempo.js";

export * from "./pitch.js";
export * from "./features.js";
export * from "./tempo.js";
export * from "./reference/index.js";
export { synthTone, synthMelody, synthClicks, synthNoise, silence as synthSilence } from "./synth.js";
export type { ToneOptions, MelodyOptions, ClickOptions, PatternClicks, SynthResult as AudioSynthResult } from "./synth.js";

/** Extra inputs the audio engine reads from the analyze context. */
export interface AudioAnalyzeContext extends AnalyzeContext {
  /** the reference file's contents for `score` (MusicXML) and `midi` references */
  referenceBytes?: ReferenceBytes;
  /** the reference recording, for `recording` references */
  referenceEvidence?: AudioEvidence;
}

const ENGINE = "audio" as const;

// ---------------------------------------------------------------- quality

export interface AudioQuality {
  ok: boolean;
  issues: string[];
  reRecord?: string;
  /** loudest 50 ms frame, dBFS */
  peakFrameDb: number;
}

/** Can this recording be measured at all? Too short, silent, clipping or too quiet fail. */
export function checkAudioQuality(samples: Float32Array, sampleRate: number): AudioQuality {
  const dur = samples.length / sampleRate;
  const frame = Math.max(1, Math.round(0.05 * sampleRate));
  let peakFrameDb = -120;
  for (let i = 0; i < samples.length; i += frame) peakFrameDb = Math.max(peakFrameDb, toDb(rmsOf(samples, i, i + frame)));
  if (dur < 0.5) return { ok: false, issues: ["recording too short"], reRecord: "That was too short to measure. Record at least a few seconds, then try again.", peakFrameDb };
  if (peakFrameDb < -50) return { ok: false, issues: ["no sound"], reRecord: "I couldn't hear anything. Check the microphone is on and allowed, move closer, and record again.", peakFrameDb };
  let clipped = 0;
  for (let i = 0; i < samples.length; i++) if (Math.abs(samples[i]) >= 0.999) clipped++;
  if (clipped > 10 && clipped / samples.length > 0.001) {
    return { ok: false, issues: ["clipping audio"], reRecord: "The sound is distorting (too loud for the microphone). Move a little further away or turn the input down, then record again.", peakFrameDb };
  }
  if (peakFrameDb < -40) return { ok: false, issues: ["audio too quiet"], reRecord: "It's too quiet to measure. Move closer to the microphone or play a little louder, then record again.", peakFrameDb };
  return { ok: true, issues: [], peakFrameDb };
}

/** Overall level (dBFS) of the sounding part: 50 ms frames within 40 dB of the loudest. */
function activeRmsDb(samples: Float32Array, sampleRate: number, peakFrameDb: number): number {
  const frame = Math.max(1, Math.round(0.05 * sampleRate));
  let power = 0;
  let n = 0;
  for (let i = 0; i < samples.length; i += frame) {
    const r = rmsOf(samples, i, i + frame);
    if (toDb(r) > peakFrameDb - 40) {
      power += r * r;
      n++;
    }
  }
  return n ? toDb(Math.sqrt(power / n)) : -120;
}

// ---------------------------------------------------------------- reference from a recording

/**
 * A reference recording becomes expected events the same way the learner's take is measured:
 * its notes (or its onsets when it has no clear pitch), placed in beats of its own estimated
 * tempo so the learner's tempo can be compared.
 */
function expectedFromRecording(ref: AudioEvidence, tuning: number): ExpectedPart | null {
  if (!ref?.samples?.length) return null;
  const onsets = detectOnsets(ref.samples, ref.sampleRate);
  const notes = detectNotes(ref.samples, ref.sampleRate, { tuning, onsets });
  const est = estimateTempo(onsets);
  const bpm = Number.isFinite(est.bpm) ? est.bpm : 60;
  const p = 60 / bpm;
  if (notes.length >= 2) {
    const t0 = notes[0].t;
    return { events: notes.map((n) => ({ beat: (n.t - t0) / p, dur: (n.end - n.t) / p, midis: [Math.round(n.midi)] })), tempoBpm: bpm };
  }
  if (!onsets.length) return null;
  const t0 = onsets[0];
  return { events: onsets.map((t, i) => ({ beat: (t - t0) / p, dur: ((onsets[i + 1] ?? t + p) - t) / p, midis: [] })), tempoBpm: bpm };
}

// ---------------------------------------------------------------- no reference: the beat grid itself

/**
 * Without a reference, each onset is compared with the nearest point of the beat grid at the
 * coarsest subdivision (beat, half, third, quarter) that at least 80% of the onsets sit close
 * to. The grid comes from the click, or the tempo with its start fitted, or the onsets alone.
 */
function gridOnlyAlignment(played: PlayedEvent[], known: { offset?: number; period?: number }): { events: ExpectedEvent[]; align: Alignment; fit: number } | null {
  const times = played.map((p) => p.t);
  let grid: Grid;
  if (known.offset !== undefined && known.period !== undefined) grid = { offset: known.offset, period: known.period };
  else {
    const period = known.period ?? estimateTempo(times).period;
    if (!Number.isFinite(period) || period <= 0) return null;
    let sx = 0;
    let sy = 0;
    for (const t of times) {
      sx += Math.cos((2 * Math.PI * t) / period);
      sy += Math.sin((2 * Math.PI * t) / period);
    }
    grid = { offset: ((Math.atan2(sy, sx) / (2 * Math.PI)) * period + period) % period, period };
  }
  let sub = 0.25;
  let fit = 0;
  for (const s of [1, 1 / 2, 1 / 3, 1 / 4]) {
    const step = s * grid.period;
    const close = times.filter((t) => {
      const r = (t - grid.offset) / step;
      return Math.abs(r - Math.round(r)) * step <= 0.15 * step;
    }).length;
    fit = close / times.length;
    if (fit >= 0.8) {
      sub = s;
      break;
    }
  }
  // each onset claims its nearest grid point; two onsets on one point keep the closer
  const byBeat = new Map<number, number>();
  times.forEach((t, j) => {
    const k = Math.round((t - grid.offset) / (sub * grid.period));
    const beat = Math.round(k * sub * 1e6) / 1e6;
    const prev = byBeat.get(beat);
    const err = (j2: number) => Math.abs(times[j2] - (grid.offset + beat * grid.period));
    if (prev === undefined || err(j) < err(prev)) byBeat.set(beat, j);
  });
  const beats = [...byBeat.keys()].sort((a, b) => a - b);
  const events = beats.map((b) => ({ beat: b, dur: sub, midis: [] as number[] }));
  return { events, align: { grid, match: beats.map((b) => byBeat.get(b)!), cost: 0 }, fit };
}

// ---------------------------------------------------------------- helpers

interface Played extends PlayedEvent {
  /** time in the recording, before removing the output delay */
  raw: number;
  hz: number;
  /** cents from the nearest equal-tempered note */
  centsNearest: number;
  clarity: number;
  db: number;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const signed = (x: number, unit: string) => `${x >= 0 ? "+" : ""}${Math.round(x)}${unit}`;


// ---------------------------------------------------------------- the analyzer

export function analyzeAudio(spec: AudioSpec, evidence: AudioEvidence, ctx: AnalyzeContext = {}): Analysis {
  const cx = ctx as AudioAnalyzeContext;
  const v = version(ENGINE, ctx.specId, ctx.modelVersion);
  const { samples, sampleRate: sr } = evidence;
  if (!samples || !sr) return reRecord(ENGINE, ["no audio"], "I couldn't hear anything. Check the microphone is on and allowed, then record again.", v);
  const q = checkAudioQuality(samples, sr);
  if (!q.ok) return reRecord(ENGINE, q.issues, q.reRecord!, v);

  const tuning = spec.tuning_hz ?? 440;
  const tolMs = spec.tolerance?.onset_ms ?? 60;
  const tolCents = spec.tolerance?.pitch_cents ?? 30;
  const tolS = tolMs / 1000;
  const delayS = (evidence.outputDelayMs ?? 0) / 1000;
  const issues: string[] = [];

  // 1. features
  const track = detectPitchTrack(samples, sr);
  const onsets = detectOnsets(samples, sr);
  const notes = detectNotes(samples, sr, { tuning, track, onsets });

  // 2. what was expected
  let part: ExpectedPart | null = null;
  let fitTempo = false;
  if (spec.reference) {
    if ("recording" in spec.reference) {
      part = cx.referenceEvidence ? expectedFromRecording(cx.referenceEvidence, tuning) : null;
      if (!part) issues.push("the reference recording wasn't supplied or had no notes");
      fitTempo = true;
    } else {
      const r = expectedFromReference(spec.reference, cx.referenceBytes);
      part = r.part;
      if (r.issue) issues.push(r.issue);
    }
  }
  const pitchedRef = !!part?.events.some((e) => e.midis.length);

  // 3. what was played: notes when pitch matters, otherwise onsets
  const usePitch = notes.length > 0 && (pitchedRef || (!part && notes.length >= Math.max(1, onsets.length * 0.5)));
  const played: Played[] = usePitch
    ? notes.map((n: DetectedNote) => ({ t: n.t - delayS, raw: n.t, midi: n.midi, hz: n.hz, centsNearest: n.cents, clarity: n.clarity, db: n.db }))
    : onsets.map((t) => ({ t: t - delayS, raw: t, hz: 0, centsNearest: 0, clarity: 1, db: levelAt(samples, sr, t) }));
  if (pitchedRef && !notes.length && onsets.length) issues.push("no clear pitch heard; only timing was measured");
  if (!played.length) {
    return reRecord(ENGINE, [...issues, "no notes or hits detected"], "I couldn't hear any clear notes or hits. Play a little louder or closer to the microphone, then record again.", v);
  }

  // 4. the beat grid and the alignment
  const bpm = evidence.click?.bpm ?? spec.tempo ?? part?.tempoBpm;
  const known: { offset?: number; period?: number } = {};
  if (!fitTempo && evidence.click) {
    known.offset = evidence.click.firstBeatS;
    known.period = 60 / evidence.click.bpm;
  } else if (!fitTempo && bpm) known.period = 60 / bpm;

  let events: ExpectedEvent[] = [];
  let align: Alignment | null = null;
  let gridFit = 1;
  if (part) {
    events = part.events;
    align = fitAndAlign(events, played, known, tolS);
  } else {
    const g = gridOnlyAlignment(played, known);
    if (g) {
      events = g.events;
      align = g.align;
      gridFit = g.fit;
    }
  }

  // 5. per-event results
  const N = events.length;
  const grid = align?.grid;
  const expT = events.map((e) => (grid ? grid.offset + e.beat * grid.period : NaN));
  const errMs: (number | null)[] = events.map((_, i) => {
    const j = align?.match[i] ?? -1;
    return j >= 0 ? (played[j].t - expT[i]) * 1000 : null;
  });
  const cents: (number | null)[] = events.map((e, i) => {
    const j = align?.match[i] ?? -1;
    if (j < 0) return null;
    const m = played[j].midi;
    if (m === undefined) return null;
    if (!e.midis.length) return part ? null : played[j].centsNearest;
    const target = e.midis.reduce((a, b) => (Math.abs(m - b) < Math.abs(m - a) ? b : a));
    return (m - target) * 100;
  });
  const matched = events.map((_, i) => (align?.match[i] ?? -1) >= 0);
  const nMatched = matched.filter(Boolean).length;
  const matchRate = part ? (N ? nMatched / N : 0) : gridFit;
  const errs = errMs.filter((x): x is number => x !== null);
  const centsList = cents.filter((x): x is number => x !== null);
  // a matched note is "correct" when it rounds to the expected note
  const correct = events.map((e, i) => matched[i] && (!e.midis.length || (cents[i] !== null && Math.abs(cents[i]!) < 50)));
  const tunable = centsList.filter((c) => Math.abs(c) < 100); // beyond a semitone it's a wrong note, not intonation
  const clarityMean = usePitch ? mean(played.filter((_, j) => !align || align.match.includes(j) || !part).map((p) => p.clarity)) : 0.9;

  // 6. metrics
  const metrics: Analysis["metrics"] = {};
  const put = (name: string, value: number, unit: string, conf: number, per?: number[]) => {
    if (Number.isFinite(value)) metrics[name] = metric(value, unit, conf, per?.filter(Number.isFinite));
  };
  const confTiming = Math.min(1, 0.5 + 0.5 * matchRate);
  const confPitch = clarityMean * Math.min(1, 0.5 + 0.5 * matchRate);

  if (part) {
    put("notes_expected", N, "notes", 1);
    put("notes_detected", played.length, "notes", usePitch ? clarityMean : 0.9);
    put("notes_correct", correct.filter(Boolean).length, "notes", usePitch || !pitchedRef ? Math.min(1, clarityMean + 0.05) : 0.5);
    put("note_accuracy", N ? correct.filter(Boolean).length / N : NaN, "share", usePitch || !pitchedRef ? Math.min(1, clarityMean + 0.05) : 0.5);
  }
  if (centsList.length) {
    put("pitch_accuracy", centsList.filter((c) => Math.abs(c) <= tolCents).length / centsList.length, "share", confPitch, centsList.map(r1));
    put("mean_abs_cents", tunable.length ? mean(tunable.map(Math.abs)) : NaN, "cents", confPitch, tunable.map(r1));
  }
  if (errs.length) {
    put("mean_abs_onset_ms", mean(errs.map(Math.abs)), "ms", confTiming, errs.map(r1));
    put("mean_onset_ms", mean(errs), "ms", confTiming * (known.offset !== undefined ? 1 : 0.9), errs.map(r1));
    put("onset_std_ms", std(errs), "ms", confTiming);
    put("onset_share_on_time", errs.filter((e) => Math.abs(e) <= tolMs).length / errs.length, "share", confTiming);
    put("early_share", errs.filter((e) => e < -tolMs).length / errs.length, "share", confTiming);
    put("late_share", errs.filter((e) => e > tolMs).length / errs.length, "share", confTiming);
    // strokes: pattern symbols U and D (either case)
    for (const [sym, name] of [["U", "up_offset_ms"], ["D", "down_offset_ms"]] as const) {
      const xs = events.map((e, i) => ((e.symbol ?? "").toUpperCase() === sym ? errMs[i] : null)).filter((x): x is number => x !== null);
      if (xs.length) put(name, mean(xs), "ms", confTiming, xs.map(r1));
    }
  }

  // tempo: a line through (beat, time) of the paired events; drift compares the two halves
  const pb: number[] = [];
  const pt: number[] = [];
  events.forEach((e, i) => {
    const j = align?.match[i] ?? -1;
    if (j >= 0) {
      pb.push(e.beat);
      pt.push(played[j].t);
    }
  });
  let tempoBpm = NaN;
  let driftPct = NaN;
  let tempoConf = 0;
  if (new Set(pb).size >= 3) {
    const f = linearFit(pb, pt);
    if (f.b > 0) tempoBpm = 60 / f.b;
    const h = pb.length >> 1;
    if (new Set(pb.slice(0, h)).size >= 2 && new Set(pb.slice(h)).size >= 2) {
      const f1 = linearFit(pb.slice(0, h), pt.slice(0, h));
      const f2 = linearFit(pb.slice(h), pt.slice(h));
      if (f1.b > 0 && f2.b > 0) driftPct = (f1.b / f2.b - 1) * 100;
    }
    tempoConf = Math.min(1, pb.length / 8) * confTiming;
  } else {
    const est = estimateTempo(played.map((p) => p.t));
    tempoBpm = est.bpm;
    driftPct = est.driftPct;
    tempoConf = est.confidence * 0.8;
  }
  put("tempo_bpm", tempoBpm, "bpm", tempoConf);
  put("tempo_drift_pct", driftPct, "%", tempoConf);

  // dynamics: each played event's peak level; range is loudest minus softest
  const levels = (part && align ? played.filter((_, j) => align!.match.includes(j)) : played).map((p) => p.db).filter((d) => d > -120);
  put("rms_db", activeRmsDb(samples, sr, q.peakFrameDb), "dB", 0.9);
  if (levels.length >= 2) put("dynamics_range_db", Math.max(...levels) - Math.min(...levels), "dB", 0.9, levels.map(r1));

  if (part && N && matchRate < 0.5) issues.push("most expected notes weren't found; check the right piece or part was played");

  // 7. where each kind of problem is, for mistake evidence
  const timeOf = (i: number) => {
    const j = align?.match[i] ?? -1;
    return j >= 0 ? played[j].raw : expT[i] + delayS;
  };
  const idx = (pred: (i: number) => boolean) => events.map((_, i) => i).filter(pred);
  const offTime = (i: number) => errMs[i] !== null && Math.abs(errMs[i]!) > tolMs;
  const stroke = (sym: string) => idx((i) => (events[i].symbol ?? "").toUpperCase() === sym && offTime(i));
  const locate: Record<string, () => number[]> = {
    mean_abs_onset_ms: () => idx(offTime),
    mean_onset_ms: () => idx(offTime),
    onset_std_ms: () => idx(offTime),
    onset_share_on_time: () => idx(offTime),
    early_share: () => idx((i) => errMs[i] !== null && errMs[i]! < -tolMs),
    late_share: () => idx((i) => errMs[i] !== null && errMs[i]! > tolMs),
    up_offset_ms: () => stroke("U"),
    down_offset_ms: () => stroke("D"),
    pitch_accuracy: () => idx((i) => cents[i] !== null && Math.abs(cents[i]!) > tolCents),
    mean_abs_cents: () => idx((i) => cents[i] !== null && Math.abs(cents[i]!) > tolCents),
    notes_correct: () => idx((i) => !correct[i]),
    note_accuracy: () => idx((i) => !correct[i]),
    notes_detected: () => idx((i) => !matched[i])
  };

  // 8. expressions: pass, mistakes, criteria
  const vars = metricVars(metrics, { baseline: (ctx.baseline ?? {}) as Value, learner: (ctx.learner ?? {}) as Value });
  const mistakes: Analysis["mistakes"] = [];
  for (const m of spec.mistakes ?? []) {
    if (evalCondition(m.when, vars) !== true) continue;
    const used = [...namesIn(m.when)].filter((n) => n in metrics);
    const confidence = used.length ? Math.min(...used.map((n) => metrics[n].confidence)) : 1;
    const where = [...new Set(used.flatMap((n) => locate[n]?.() ?? []))].sort((a, b) => a - b);
    const at = where.map(timeOf).filter(Number.isFinite).map((t) => Math.round(t * 1000) / 1000);
    mistakes.push({
      id: m.id,
      severity: m.severity ?? 2,
      confidence,
      at,
      evidence: at.length ? { kind: "time", t: at[0], ...(at.length > 1 ? { end: at[at.length - 1] } : {}) } : { kind: "time", t: played[0].raw },
      ...(where.length && N ? { share: Math.min(1, where.length / N) } : {})
    });
  }
  const criteria = evalCriteria(criteriaFrom(cx.criteria), vars);
  if (spec.pass) criteria.pass = evalCondition(spec.pass, vars) === true;

  // 9. markers: one per expected event (a beat or note), plus played events that matched nothing
  const markers: Analysis["markers"] = [];
  events.forEach((e, i) => {
    const t = timeOf(i);
    if (!Number.isFinite(t)) return;
    const name = e.midis.length ? e.midis.map(midiName).join("+") : (e.symbol ?? "beat");
    if (!matched[i]) {
      markers.push({ t, label: part ? `missed ${name}` : name, role: "attention" });
      return;
    }
    const parts = [name];
    if (cents[i] !== null) parts.push(signed(cents[i]!, "¢"));
    if (errMs[i] !== null) parts.push(signed(errMs[i]!, " ms"));
    const good = !offTime(i) && (cents[i] === null || Math.abs(cents[i]!) <= tolCents) && correct[i];
    markers.push({ t, label: parts.join(" "), role: good ? "good" : "attention" });
  });
  if (part && align) {
    played.forEach((p, j) => {
      if (!align!.match.includes(j)) markers.push({ t: p.raw, label: p.midi !== undefined ? `extra ${midiName(p.midi)}` : "extra hit", role: "attention" });
    });
  }
  markers.sort((a, b) => a.t - b.t);

  // 10. praise: the best graded aspect that is actually good
  const grades = new Set(spec.grade ?? ["pitch", "rhythm"]);
  const praiseCands: { metric: string; score: number; label: string }[] = [];
  const val = (k: string) => metrics[k]?.value;
  if (grades.has("pitch") && val("pitch_accuracy") !== undefined) praiseCands.push({ metric: "pitch_accuracy", score: val("pitch_accuracy")!, label: "Notes in tune" });
  if (grades.has("notes") && val("note_accuracy") !== undefined) praiseCands.push({ metric: "note_accuracy", score: val("note_accuracy")!, label: "Right notes" });
  if ((grades.has("rhythm") || grades.has("onsets")) && val("onset_share_on_time") !== undefined) praiseCands.push({ metric: "onset_share_on_time", score: val("onset_share_on_time")!, label: "On the beat" });
  if (grades.has("tempo") && val("tempo_drift_pct") !== undefined) praiseCands.push({ metric: "tempo_drift_pct", score: 1 - Math.abs(val("tempo_drift_pct")!) / 10, label: "Steady tempo" });
  if (grades.has("dynamics") && val("dynamics_range_db") !== undefined) praiseCands.push({ metric: "dynamics_range_db", score: Math.min(1, val("dynamics_range_db")! / 12), label: "Clear dynamics" });
  const best = praiseCands.filter((p) => p.score >= 0.6 && (metrics[p.metric]?.confidence ?? 0) >= CONFIDENCE_FLOOR).sort((a, b) => b.score - a.score)[0];

  // 11. overlay for the studio's beat timeline (times are positions in the recording)
  const overlay = {
    kind: "beat_timeline",
    beats: expT.map((t) => (Number.isFinite(t) ? Math.round((t + delayS) * 1000) / 1000 : null)),
    offsetsMs: errMs.map((e) => (e === null ? null : r1(e))),
    toleranceMs: tolMs,
    symbols: events.map((e) => e.symbol ?? (e.midis.length ? e.midis.map(midiName).join("+") : "")),
    notes: played.map((p, j) => {
      const i = align ? align.match.indexOf(j) : -1;
      const exp = i >= 0 && events[i].midis.length ? events[i] : undefined;
      return {
        t: Math.round(p.raw * 1000) / 1000,
        hz: Math.round(p.hz * 100) / 100,
        cents: r1(i >= 0 && cents[i] !== null ? cents[i]! : p.centsNearest),
        ...(exp ? { expected: exp.midis.map(midiName).join("+"), expectedHz: Math.round(midiToHz(exp.midis[0], tuning) * 100) / 100 } : {})
      };
    }),
    ...(grid ? { bpm: Math.round((60 / grid.period) * 100) / 100 } : {})
  };

  return finish({
    engine: ENGINE,
    quality: { ok: true, issues },
    metrics,
    markers,
    mistakes: applyConfidenceFloor(mistakes),
    criteria,
    ...(best ? { praise: { metric: best.metric, label: best.label } } : {}),
    keyFrames: [],
    overlay,
    version: v,
    ...(usePitch ? { segments: notes.map((n) => [Math.round(n.t * 1000) / 1000, Math.round(n.end * 1000) / 1000] as [number, number]) } : {}),
    precision: "full"
  });
}
