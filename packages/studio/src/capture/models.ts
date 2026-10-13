/**
 * Model weights the studio downloads once from their official hosts and keeps in the browser's Cache API.
 * Code and WASM runtimes are served by the studio itself (/vendor, copied from npm at build time).
 *
 * | Model | Size (approx.) | License |
 * |---|---|---|
 * | MediaPipe Pose Landmarker lite | 5.6 MB | Apache-2.0 |
 * | MediaPipe Hand Landmarker | 7.5 MB | Apache-2.0 |
 * | MediaPipe Face Landmarker | 3.6 MB | Apache-2.0 |
 * | MediaPipe Object Detector (EfficientDet-Lite0) | 7 MB | weights: no license stated (DESIGN §11 ⚠) |
 * | Whisper tiny (onnx-community/whisper-tiny, quantized) | ~40 MB | MIT (verify the ONNX conversion's card) |
 * | Tesseract English LSTM data (tessdata_fast) | 2 MB | Apache-2.0 |
 */
export const MODEL_URLS = {
  pose: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task",
  hands: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task",
  face: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task",
  objects: "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/latest/efficientdet_lite0.tflite"
} as const;

export const WHISPER_MODEL = "onnx-community/whisper-tiny";
export const TESSDATA_URL = "https://tessdata.projectnaptha.com/4.0.0_fast";
export const MODEL_CACHE = "las-models-v1";

/** Fetches a model file once and serves it from the Cache API afterwards (works offline from then on). */
export async function cachedModel(url: string, onProgress?: (share: number) => void): Promise<Uint8Array> {
  const cache = typeof caches !== "undefined" ? await caches.open(MODEL_CACHE).catch(() => undefined) : undefined;
  const hit = await cache?.match(url);
  if (hit) return new Uint8Array(await hit.arrayBuffer());
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Couldn't download ${url.split("/").pop()} (${res.status}).`);
  const total = Number(res.headers.get("content-length") ?? 0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (total) onProgress?.(got / total);
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  await cache?.put(url, new Response(out.slice(), { headers: { "content-type": "application/octet-stream" } })).catch(() => undefined);
  return out;
}

export async function isCached(url: string): Promise<boolean> {
  if (typeof caches === "undefined") return false;
  const cache = await caches.open(MODEL_CACHE).catch(() => undefined);
  return !!(await cache?.match(url));
}
