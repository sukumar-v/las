/**
 * Speech-to-text is pluggable: any engine that turns samples into words with times and
 * confidences can serve the speech analyzer (whisper.cpp through `whisper-cli.ts` in Node, a
 * browser model in the studio, or a transcript the client already has).
 */
import type { SpeechEvidence } from "../types.js";
import { isNoSpaceScript } from "./text.js";

export type Transcript = SpeechEvidence["transcript"];

export interface Transcriber {
  id: string;
  transcribe(samples: Float32Array, sampleRate: number, language?: string): Promise<Transcript>;
}

/**
 * A transcript from plain text, with evenly spaced word times (for tests, and for clients that
 * already have the text). Characters of no-space scripts become one "word" each.
 */
export function transcriptFromText(text: string, opts: { language?: string; start?: number; wordS?: number; gapS?: number; confidence?: number } = {}): Transcript {
  const wordS = opts.wordS ?? 0.35;
  const gapS = opts.gapS ?? 0.05;
  let t = opts.start ?? 0;
  const pieces: string[] = [];
  for (const chunk of text.split(/\s+/).filter(Boolean)) {
    let run = "";
    for (const ch of chunk) {
      if (isNoSpaceScript(ch)) {
        if (run) pieces.push(run);
        run = "";
        pieces.push(ch);
      } else run += ch;
    }
    if (run) pieces.push(run);
  }
  const words = pieces.map((word) => {
    const w = { word, start: t, end: t + wordS, confidence: opts.confidence ?? 0.95 };
    t += wordS + gapS;
    return w;
  });
  return { text, ...(opts.language ? { language: opts.language } : {}), words };
}
