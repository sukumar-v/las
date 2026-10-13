/** Main-thread side of on-device transcription. */
import SpeechWorker from "./speech-worker.ts?worker";

export interface Transcript {
  text: string;
  language?: string;
  words: { word: string; start: number; end: number; confidence: number }[];
}

let worker: Worker | undefined;
let seq = 0;

export function transcribe(samples: Float32Array, sampleRate: number, language: string | undefined, onProgress?: (label: string, share?: number) => void): Promise<Transcript> {
  worker ??= new SpeechWorker();
  const id = ++seq;
  const w = worker;
  return new Promise((resolve, reject) => {
    const onMsg = (e: MessageEvent<{ id: number; type: string; transcript?: Transcript; error?: string; status?: string; progress?: number; file?: string }>) => {
      if (e.data.id !== id) return;
      if (e.data.type === "progress") onProgress?.(e.data.file ?? e.data.status ?? "model", e.data.progress !== undefined ? e.data.progress / 100 : undefined);
      else {
        w.removeEventListener("message", onMsg);
        if (e.data.type === "done") resolve(e.data.transcript!);
        else reject(new Error(e.data.error ?? "transcription failed"));
      }
    };
    w.addEventListener("message", onMsg);
    w.postMessage({ id, samples, sampleRate, language });
  });
}
