/**
 * After a recording: check it's usable, extract features, measure on the device (engines in a worker), then
 * send the analysis to the server, which picks the one fix (evaluation §2). Raw media goes only to the local
 * server's media folder for replay; the agent sees the analysis, never the clip.
 */
import type { Analysis, FeedbackView, ProofResultView } from "@las/schema";
import { beatsFromOnsets, detectOnsets, detectPitchTrack } from "@las/engines";
import type { Api, AttemptInfo } from "../api.js";
import { analyzeOnDevice } from "./analyze.js";
import { EVIDENCE_UPLOAD_LIMIT, evidenceToJson, jsonSize } from "./fixture.js";
import { transcribe } from "./speech.js";
import { needsOcr, readText } from "./visual.js";
import { renderKeyFrames } from "./keyframes.js";

export const PIPELINE_STEPS = ["Recording is usable", "Features extracted", "Measured on this device", "One fix picked"];

export interface Captured {
  engine: string;
  /** the engine's evidence, typed arrays included */
  evidence: any;
  /** the clip, photo or recording for replay; stays on this computer */
  media?: Blob;
}

export interface ProcessResult {
  analysis: Analysis;
  feedback?: FeedbackView;
  proof?: ProofResultView;
  evidence: any;
  mediaUrl?: string;
}

/** Criteria the analysis checks: the milestone proof's, for rehearsals and proof checks. */
export function criteriaOf(info: AttemptInfo): Record<string, string> | undefined {
  const list = (info.attempt.spec?.criteria ?? undefined) as { id: string; check: string }[] | undefined;
  return list?.length ? Object.fromEntries(list.map((c) => [c.id, c.check])) : undefined;
}

/** Beats from a clip's own audio, for movement specs timed to music. */
export async function beatsFromAudio(blob: Blob): Promise<number[] | undefined> {
  try {
    const ctx = new OfflineAudioContext(1, 1, 44100);
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    const samples = buf.getChannelData(0);
    const onsets = detectOnsets(samples, buf.sampleRate);
    const b = beatsFromOnsets(onsets);
    return b.beats.length ? b.beats : undefined;
  } catch {
    return undefined;
  }
}

/** Speech evidence gets a pitch track (10 ms hops) when the audio is there. */
export function withPitchTrack(e: any): any {
  if (!(e?.samples instanceof Float32Array) || !e.sampleRate || e.pitchTrack) return e;
  const hop = Math.round(e.sampleRate * 0.01);
  return { ...e, pitchTrack: detectPitchTrack(e.samples, e.sampleRate, hop).map((p) => ({ t: p.t, hz: p.hz, clarity: p.clarity })), durationS: e.durationS ?? e.samples.length / e.sampleRate };
}

export async function processCapture(api: Api, info: AttemptInfo, cap: Captured, onStep: (done: number) => void): Promise<ProcessResult> {
  const id = info.attempt.id;
  onStep(0);
  let evidence = cap.evidence;
  // 1. features the engines need that the recording doesn't carry yet
  const segBy = info.spec?.segment?.by;
  const beatSource = info.spec?.segment?.beat_source;
  if (cap.engine === "movement" && !evidence.beats?.length && cap.media && (segBy === "phrases" || beatSource === "audio_track")) {
    const beats = await beatsFromAudio(cap.media);
    if (beats) evidence = { ...evidence, beats };
  }
  if (cap.engine === "speech" && !evidence.transcript && evidence.samples) {
    const transcript = await transcribe(evidence.samples, evidence.sampleRate, info.spec?.language);
    evidence = { ...evidence, transcript };
  }
  if (cap.engine === "speech") evidence = withPitchTrack(evidence);
  if (cap.engine === "visual" && evidence.ocrText === undefined && cap.media && needsOcr(info.spec ?? {})) {
    const text = await readText(cap.media).catch(() => undefined);
    if (text !== undefined) evidence = { ...evidence, ocrText: text };
  }
  onStep(1);
  // 2. measure on the device
  let analysis = await analyzeOnDevice(info.spec, evidence, { specId: info.attempt.specId, criteria: criteriaOf(info) });
  if (analysis.keyFrames.length) analysis = await renderKeyFrames(analysis, cap.media, evidence.frames);
  onStep(2);
  // 3. media stays on this computer (the local server's media folder) for replay
  let mediaUrl: string | undefined;
  if (cap.media && cap.media.size) {
    try {
      const up = await api.uploadMedia(id, cap.media);
      await api.event({ type: "attempt.captured", attemptId: id, mediaRef: up.mediaRef }).catch(() => undefined);
      mediaUrl = api.mediaUrl(id);
    } catch {
      mediaUrl = URL.createObjectURL(cap.media);
    }
  }
  // 4. the evidence when it's small enough to keep (replay skeletons, comparisons, the learner's baseline), then
  // always the device's analysis: it carries the rendered key frames, so it is the one the attempt keeps
  const json = evidenceToJson(evidence);
  if (jsonSize(json) <= EVIDENCE_UPLOAD_LIMIT) await api.postEvidence(id, json).catch(() => undefined);
  const posted = await api.postAnalysis(id, analysis);
  const fb = posted.feedback ? posted : await api.feedback(id).catch(() => posted);
  onStep(4);
  return { analysis, feedback: fb.feedback, proof: fb.proof, evidence, mediaUrl };
}
