/**
 * Deterministic evidence for the end-to-end journeys, one per engine, made with the engines' own synthetic
 * generators. The studio's fixture hook (window.__lasFixture) uses it instead of live devices and models.
 * Typed arrays become plain arrays so they survive JSON.
 */
import { squatSequence, synthMelody } from "@las/engines";

export function movementEvidence() {
  const clip = squatSequence({ reps: 5, bottomKneeAngle: 125, fps: 30, width: 480, height: 640 });
  return { frames: clip.frames, fps: clip.fps, width: clip.width, height: clip.height };
}

export function audioEvidence() {
  const sr = 16000;
  const r = synthMelody([["C4", 1], ["E4", 1], ["G4", 1], ["C5", 1]], 90, sr, { pitchErrorCents: [45, 45, 0, 45], leadInS: 0.6, tailS: 0.5 });
  return { sampleRate: r.sampleRate, samples: Array.from(r.samples, (v) => Math.round(v * 1e4) / 1e4), click: { bpm: r.bpm, firstBeatS: r.firstBeatS } };
}

export function speechEvidence() {
  const words = [
    { word: "the", start: 0.3, end: 0.45, confidence: 0.95 },
    { word: "cat", start: 0.5, end: 0.8, confidence: 0.93 },
    { word: "on", start: 1.2, end: 1.35, confidence: 0.9 },
    { word: "mat", start: 1.45, end: 1.8, confidence: 0.92 }
  ];
  return { transcript: { text: words.map((w) => w.word).join(" "), language: "en", words }, durationS: 2.2 };
}

export function visualEvidence() {
  const width = 64;
  const height = 48;
  const data: number[] = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const v = 20 + Math.round((x / width) * 30);
    data.push(v, v, v, 255);
  }
  return { width, height, pixels: { width, height, data } };
}

export function codeEvidence() {
  return { files: { "main.js": "function add(a, b) {\n  return a - b;\n}\n" } };
}

export const EVIDENCE = { movement: movementEvidence, audio: audioEvidence, speech: speechEvidence, visual: visualEvidence, code: codeEvidence };
