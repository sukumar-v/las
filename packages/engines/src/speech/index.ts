/**
 * The speech engine: any language Whisper (or another transcriber) handles. It measures how
 * much of the target was understood, word confidence, pace, pauses, filler words, pitch range
 * and, for tonal languages, each syllable's pitch contour against the expected tones. Per-sound
 * scores are used only when a license-clean model supplied them; otherwise the result says so
 * and precision is "reduced". Accents are not penalized: the measure is being understood.
 */
import { CONFIDENCE_FLOOR, type Analysis, type SpeechSpec, type Value } from "@las/schema";
import { applyConfidenceFloor, evalCondition, evalCriteria, finish, mean, metric, metricVars, reRecord, version } from "../common/analysis.js";
import type { AnalyzeContext, SpeechEvidence } from "../types.js";
import { criteriaFrom, namesIn } from "../audio/context.js";
import { percentile, rmsOf, toDb } from "../audio/dsp.js";
import { detectPitchTrack } from "../audio/features.js";
import { checkAudioQuality } from "../audio/index.js";
import { alignTokens, isNoSpaceScript, normalizeSpeechText, speechTokens } from "./text.js";
import { classifyToneContour, DEFAULT_TONE_SHAPES, segmentSyllables, type ToneShape } from "./tones.js";

export * from "./text.js";
export * from "./tones.js";
export * from "./transcriber.js";

/**
 * Hesitation sounds in several languages (data, not code). Matching ignores repeated letters,
 * so "ummm" counts as "um". Callers extend the list per language with `fillers` in the context.
 */
export const SPEECH_FILLERS: readonly string[] = ["um", "uh", "er", "ehm", "euh", "eh", "ano", "eto", "那个", "这个", "este", "pues", "음", "어"];

/** A silence between words longer than this is a pause. */
export const PAUSE_S = 0.4;

/** Extra inputs the speech engine reads from the analyze context. */
export interface SpeechAnalyzeContext extends AnalyzeContext {
  /** more filler words for this language */
  fillers?: string[];
  /** per-sound scores 0..1 from a license-clean pronunciation model, by sound id */
  soundScores?: Record<string, number>;
  /** rubric grades for open answers (the agent's or a local model's), like the visual engine */
  grades?: { criterion: string; level: number; confidence: number; note?: string }[];
  /** tone number -> accepted contour shapes, for numberings other than the default */
  toneShapes?: Record<number, ToneShape | ToneShape[]>;
}

const ENGINE = "speech" as const;
const squeeze = (s: string) => s.replace(/(.)\1+/gu, "$1");
const r1 = (x: number) => Math.round(x * 10) / 10;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Filler words in a transcript, with their times. */
export function findFillers(words: { word: string; start: number }[], lang?: string, extra: string[] = []): { word: string; t: number }[] {
  const list = [...SPEECH_FILLERS, ...extra].map((f) => normalizeSpeechText(f, lang)).filter(Boolean);
  const spaced = new Set(list.filter((f) => !Array.from(f).some(isNoSpaceScript)).map(squeeze));
  const unspaced = list.filter((f) => Array.from(f).some(isNoSpaceScript));
  const out: { word: string; t: number }[] = [];
  for (const w of words) {
    const norm = normalizeSpeechText(w.word, lang);
    for (const tok of norm.split(" ")) if (tok && spaced.has(squeeze(tok))) out.push({ word: tok, t: w.start });
    for (const f of unspaced) {
      let k = norm.indexOf(f);
      while (k >= 0) {
        out.push({ word: f, t: w.start });
        k = norm.indexOf(f, k + f.length);
      }
    }
  }
  return out;
}

/** Pauses: gaps between words, or quiet stretches in the audio when there are no word times. */
function findPauses(ev: SpeechEvidence): { start: number; end: number }[] {
  const w = ev.transcript?.words ?? [];
  if (w.length >= 2) {
    const out: { start: number; end: number }[] = [];
    for (let i = 1; i < w.length; i++) if (w[i].start - w[i - 1].end > PAUSE_S) out.push({ start: w[i - 1].end, end: w[i].start });
    return out;
  }
  if (!ev.samples?.length || !ev.sampleRate) return [];
  // 20 ms frames; speech is anything within 35 dB of the loudest frame
  const f = Math.round(0.02 * ev.sampleRate);
  const db: number[] = [];
  for (let i = 0; i + f <= ev.samples.length; i += f) db.push(toDb(rmsOf(ev.samples, i, i + f)));
  const gate = Math.max(-55, Math.max(...db) - 35);
  const active = db.map((d) => d > gate);
  const first = active.indexOf(true);
  const last = active.lastIndexOf(true);
  const out: { start: number; end: number }[] = [];
  let s = -1;
  for (let i = first; i <= last && first >= 0; i++) {
    if (!active[i] && s < 0) s = i;
    if (active[i] && s >= 0) {
      if ((i - s) * 0.02 > PAUSE_S) out.push({ start: s * 0.02, end: i * 0.02 });
      s = -1;
    }
  }
  return out;
}

export function analyzeSpeech(spec: SpeechSpec, evidence: SpeechEvidence, ctx: AnalyzeContext = {}): Analysis {
  const cx = ctx as SpeechAnalyzeContext;
  const v = version(ENGINE, ctx.specId, ctx.modelVersion);
  const lang = spec.language;
  const issues: string[] = [];

  if (evidence.samples?.length && evidence.sampleRate) {
    const q = checkAudioQuality(evidence.samples, evidence.sampleRate);
    if (!q.ok) return reRecord(ENGINE, q.issues, q.reRecord!, v);
  }
  const tr = evidence.transcript ?? { text: "", words: [] };
  const words = (tr.words ?? []).filter((w) => normalizeSpeechText(w.word, lang) !== "");
  const text = tr.text?.trim() ? tr.text : words.map((w) => w.word).join(" ");
  const heard = speechTokens(text, lang);
  if (!heard.length) return reRecord(ENGINE, ["no words recognized"], "I couldn't make out any words. Speak a little louder and closer to the microphone, then record again.", v);

  const metrics: Analysis["metrics"] = {};
  const put = (name: string, value: number, unit: string, conf: number, per?: number[]) => {
    if (Number.isFinite(value)) metrics[name] = metric(value, unit, conf, per?.filter(Number.isFinite));
  };

  // 1. words: confidence, and the target compared with what was heard
  const confs = words.map((w) => w.confidence).filter(Number.isFinite);
  const meanConf = confs.length ? mean(confs) : NaN;
  put("mean_word_confidence", meanConf, "share", 0.9, confs.map((c) => r3(c)));
  const asrConf = Number.isFinite(meanConf) ? Math.min(1, 0.6 + 0.4 * meanConf) : 0.8;
  const target = spec.target ? speechTokens(spec.target, lang) : [];
  const align = target.length ? alignTokens(target, heard) : null;
  if (align) {
    const len = Math.max(target.length, heard.length);
    put("intelligibility", Math.max(0, 1 - align.distance / len), "share", asrConf);
    put("words_expected", target.length, "words", 1);
    put("words_recognized", align.ops.filter((o) => o.op === "ok" || o.op === "near").length, "words", asrConf);
  } else put("words_recognized", heard.length, "words", asrConf);

  // 2. timing: duration, pace, pauses, fillers
  const first = words[0];
  const last = words[words.length - 1];
  const duration = evidence.durationS ?? (evidence.samples && evidence.sampleRate ? evidence.samples.length / evidence.sampleRate : last ? last.end : NaN);
  put("duration_s", duration, "s", 1);
  const spokenS = first && last && last.end > first.start ? last.end - first.start : duration;
  const wordCount = words.length || heard.length;
  if (spokenS > 0) put("words_per_minute", wordCount / (spokenS / 60), "wpm", words.length ? 0.9 : 0.6);
  const pauses = findPauses(evidence);
  const pauseConf = words.length >= 2 ? 0.9 : 0.75;
  put("pause_count", pauses.length, "pauses", pauseConf, pauses.map((p) => r3(p.end - p.start)));
  if (spokenS > 0) put("pause_share", Math.min(1, pauses.reduce((s, p) => s + p.end - p.start, 0) / spokenS), "share", pauseConf);
  const fillerWords = words.length ? words : heard.map((w, i) => ({ word: w, start: i }));
  const fillers = findFillers(fillerWords, lang, cx.fillers ?? []);
  put("filler_count", fillers.length, "words", asrConf);

  // 3. pitch: range, and tones per syllable
  let track = (evidence.pitchTrack ?? []).filter((f) => f.clarity >= 0.5 || f.hz <= 0).map((f) => ({ t: f.t, hz: f.clarity >= 0.5 ? f.hz : 0 }));
  if (!track.length && evidence.samples?.length && evidence.sampleRate) {
    // speech: 10 ms hops, a slightly lower clarity bar than music, voice range only
    track = detectPitchTrack(evidence.samples, evidence.sampleRate, Math.round(0.01 * evidence.sampleRate), { minClarity: 0.8, minHz: 50, maxHz: 1000 }).map((f) => ({ t: f.t, hz: f.hz }));
  }
  const voiced = track.filter((f) => f.hz > 0).map((f) => f.hz);
  if (voiced.length >= 10) {
    const st = voiced.map((h) => 12 * Math.log2(h / percentile(voiced, 50)));
    put("pitch_range_st", percentile(st, 95) - percentile(st, 5), "st", 0.85);
  }

  const syllables: { word: string; start: number; end: number; contour: number[]; tone?: ToneShape; expected?: number; ok?: boolean }[] = [];
  if (spec.tones && spec.tone_pattern?.length) {
    if (voiced.length < 4) issues.push("no clear pitch heard, so tones couldn't be checked");
    else {
      const shapes: Record<number, ToneShape[]> = { ...DEFAULT_TONE_SHAPES };
      for (const [k, s] of Object.entries(cx.toneShapes ?? {})) shapes[Number(k)] = Array.isArray(s) ? s : [s];
      const segs = segmentSyllables({ count: spec.tone_pattern.length, words, pitchTrack: track });
      const okList: number[] = [];
      segs.forEach((s, i) => {
        const hz = track.filter((f) => f.t >= s.start && f.t <= s.end).map((f) => f.hz);
        const c = classifyToneContour(hz);
        const want = spec.tone_pattern![i];
        const ok = (shapes[want] ?? []).includes(c.shape);
        okList.push(ok ? 1 : 0);
        // the drawn contour: 12 evenly spaced points in semitones
        const pts = c.st.length ? Array.from({ length: 12 }, (_, k) => r1(c.st[Math.min(c.st.length - 1, Math.round((k * (c.st.length - 1)) / 11))])) : [];
        syllables.push({ word: s.word, start: r3(s.start), end: r3(s.end), contour: pts, tone: c.shape, expected: want, ok });
      });
      const segConf = words.length === segs.length || segs.every((s) => s.word) ? 0.85 : 0.7;
      put("tone_accuracy", mean(okList), "share", segConf, okList);
    }
  }

  // 4. per-sound scores only from a supplied model; otherwise say what is used instead
  let precision: "full" | "reduced" = "reduced";
  const sound: Record<string, number> = {};
  if (cx.soundScores && Object.keys(cx.soundScores).length) {
    const ids = spec.sounds?.length ? spec.sounds.filter((s) => s in cx.soundScores!) : Object.keys(cx.soundScores);
    for (const id of ids) if (Number.isFinite(cx.soundScores[id])) sound[id] = cx.soundScores[id];
    const vals = Object.values(sound);
    if (vals.length) {
      put("sound_score", mean(vals), "share", 0.8, vals.map(r3));
      precision = "full";
    }
  }
  if (precision === "reduced") issues.push("per-sound scoring isn't available for this language here; intelligibility and comparison with your earlier attempts are used instead");

  // 5. rubric grades for open answers
  const rubricIds = new Set(spec.rubric?.criteria.map((c) => c.id) ?? []);
  for (const g of cx.grades ?? []) {
    if (spec.rubric && !rubricIds.has(g.criterion)) continue;
    put(g.criterion, g.level, "level", g.confidence);
  }

  // 6. expressions
  const vars = metricVars(metrics, { baseline: (ctx.baseline ?? {}) as Value, learner: (ctx.learner ?? {}) as Value, sound: sound as Value });
  const wordTime = (h: number | undefined) => (h !== undefined && words[Math.min(h, words.length - 1)] ? words[Math.min(h, words.length - 1)].start : (first?.start ?? 0));
  const missedAt = (): number[] => {
    if (!align) return [];
    let lastH: number | undefined;
    const out: number[] = [];
    for (const o of align.ops) {
      if (o.h !== undefined) lastH = o.h;
      if (o.op === "sub" || o.op === "del" || o.op === "ins") out.push(wordTime(o.h ?? lastH));
    }
    return out;
  };
  const locate: Record<string, () => number[]> = {
    intelligibility: missedAt,
    words_recognized: missedAt,
    mean_word_confidence: () => words.filter((w) => w.confidence < 0.6).map((w) => w.start),
    pause_count: () => pauses.map((p) => p.start),
    pause_share: () => pauses.map((p) => p.start),
    filler_count: () => fillers.map((f) => f.t),
    tone_accuracy: () => syllables.filter((s) => !s.ok).map((s) => s.start)
  };
  const mistakes: Analysis["mistakes"] = [];
  for (const m of spec.mistakes ?? []) {
    if (evalCondition(m.when, vars) !== true) continue;
    const used = [...namesIn(m.when)].filter((n) => n in metrics);
    const confidence = used.length ? Math.min(...used.map((n) => metrics[n].confidence)) : 1;
    const at = [...new Set(used.flatMap((n) => locate[n]?.() ?? []))].filter(Number.isFinite).sort((a, b) => a - b).map(r3);
    mistakes.push({ id: m.id, severity: m.severity ?? 2, confidence, at, evidence: { kind: "time", t: at[0] ?? first?.start ?? 0, ...(at.length > 1 ? { end: at[at.length - 1] } : {}) } });
  }
  const criteria = evalCriteria(criteriaFrom(ctx.criteria), vars);
  if (spec.pass) criteria.pass = evalCondition(spec.pass, vars) === true;
  if (spec.rubric?.pass) criteria.rubric = evalCondition(spec.rubric.pass, vars) === true;

  // 7. markers: missed or wrong words, fillers, pauses, off-target tones
  const markers: Analysis["markers"] = [];
  if (align) {
    let lastH: number | undefined;
    for (const o of align.ops) {
      if (o.h !== undefined) lastH = o.h;
      if (o.op === "del") markers.push({ t: wordTime(lastH), label: `missed "${target[o.t!]}"`, role: "attention" });
      else if (o.op === "sub") markers.push({ t: wordTime(o.h), label: `"${heard[o.h!]}" for "${target[o.t!]}"`, role: "attention" });
    }
  }
  for (const f of fillers) markers.push({ t: f.t, label: `filler "${f.word}"`, role: "attention" });
  for (const p of pauses) markers.push({ t: p.start, label: `pause ${r1(p.end - p.start)} s`, role: "neutral" });
  for (const s of syllables) markers.push({ t: s.start, label: `${s.word || "syllable"}: ${s.tone}`, role: s.ok ? "good" : "attention" });
  markers.sort((a, b) => a.t - b.t);

  // 8. praise
  const val = (k: string) => metrics[k]?.value;
  const cands: { metric: string; score: number; label: string }[] = [];
  if (val("intelligibility") !== undefined) cands.push({ metric: "intelligibility", score: val("intelligibility")!, label: "Clearly understood" });
  if (val("tone_accuracy") !== undefined) cands.push({ metric: "tone_accuracy", score: val("tone_accuracy")!, label: "Tones on target" });
  if (val("sound_score") !== undefined) cands.push({ metric: "sound_score", score: val("sound_score")!, label: "Sounds on target" });
  if (val("mean_word_confidence") !== undefined) cands.push({ metric: "mean_word_confidence", score: val("mean_word_confidence")! - 0.05, label: "Clear words" });
  if (val("filler_count") === 0 && wordCount >= 8) cands.push({ metric: "filler_count", score: 0.85, label: "No filler words" });
  const best = cands.filter((c) => c.score >= 0.7 && (metrics[c.metric]?.confidence ?? 0) >= CONFIDENCE_FLOOR).sort((a, b) => b.score - a.score)[0];

  const okTarget = new Set(align?.ops.filter((o) => o.op === "ok" || o.op === "near").map((o) => o.t!) ?? []);
  const overlay = {
    kind: "contour",
    syllables,
    words: words.map((w) => ({ word: w.word, confidence: r3(w.confidence), start: r3(w.start), end: r3(w.end) })),
    ...(target.length ? { target: target.map((token, i) => ({ token, ok: okTarget.has(i) })) } : {})
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
    ...(syllables.length ? { segments: syllables.map((s) => [s.start, s.end] as [number, number]) } : {}),
    precision
  });
}
