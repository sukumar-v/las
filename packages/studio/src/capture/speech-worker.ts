/// <reference lib="webworker" />
/**
 * Speech to text on the device with Transformers.js (Apache-2.0) and Whisper tiny (weights MIT), loaded on
 * first use: ~40 MB downloaded once from the Hugging Face Hub into the browser cache. ONNX Runtime's WASM
 * is emitted into the studio's own build, never fetched from a CDN.
 */
import { WHISPER_MODEL } from "./models.js";

type Req = { id: number; samples: Float32Array; sampleRate: number; language?: string };
let asr: Promise<any> | undefined;

/** Whisper wants 16 kHz mono. */
export function resample(x: Float32Array, from: number, to = 16000): Float32Array {
  if (from === to) return x;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(x.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor(i * ratio);
    const b = Math.min(x.length, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let j = a; j < b; j++) s += x[j];
    out[i] = b > a ? s / (b - a) : x[a] ?? 0;
  }
  return out;
}

async function load(post: (m: unknown) => void) {
  const t = await import("@huggingface/transformers");
  t.env.allowLocalModels = false;
  t.env.useBrowserCache = true;
  // ONNX Runtime's WASM is part of the studio's own build (no CDN); one thread needs no cross-origin isolation
  const wasm = (t.env.backends.onnx as { wasm?: { numThreads?: number } }).wasm;
  if (wasm) wasm.numThreads = 1;
  return t.pipeline("automatic-speech-recognition", WHISPER_MODEL, {
    device: "wasm",
    dtype: "q8",
    progress_callback: (p: { status?: string; progress?: number; file?: string }) => post({ type: "progress", status: p.status, progress: p.progress, file: p.file })
  } as any);
}

self.onmessage = async (e: MessageEvent<Req>) => {
  const { id, samples, sampleRate, language } = e.data;
  const post = (m: unknown) => (self as unknown as Worker).postMessage({ id, ...(m as object) });
  try {
    asr ??= load(post);
    const pipe = await asr;
    const audio = resample(samples, sampleRate);
    const out = await pipe(audio, { return_timestamps: "word", language: language?.split("-")[0], task: "transcribe", chunk_length_s: 30 });
    const words = (out.chunks ?? []).map((c: { text: string; timestamp: [number, number | null] }) => ({ word: c.text.trim(), start: c.timestamp[0] ?? 0, end: c.timestamp[1] ?? c.timestamp[0] ?? 0, confidence: 0.9 })).filter((w: { word: string }) => w.word);
    post({ type: "done", transcript: { text: String(out.text ?? "").trim(), language, words } });
  } catch (err) {
    asr = undefined;
    post({ type: "error", error: String((err as Error)?.message ?? err) });
  }
};
