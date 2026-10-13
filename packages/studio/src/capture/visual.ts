/**
 * Photos of finished work: downscaled to at most 1024 px on the device; points the learner taps for the
 * rubric; optional text recognition with Tesseract.js (Apache-2.0) when a criterion reads text.
 */
import { TESSDATA_URL } from "./models.js";

export interface Photo {
  width: number;
  height: number;
  pixels: { data: Uint8ClampedArray; width: number; height: number };
  /** a small preview for the screen */
  url: string;
  blob: Blob;
}

export function fitWithin(w: number, h: number, max = 1024): { width: number; height: number } {
  const s = Math.min(1, max / Math.max(w, h, 1));
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

export async function photoFrom(source: Blob | HTMLVideoElement, max = 1024): Promise<Photo> {
  const bmp = source instanceof Blob ? await createImageBitmap(source) : source;
  const sw = source instanceof Blob ? (bmp as ImageBitmap).width : (source as HTMLVideoElement).videoWidth;
  const sh = source instanceof Blob ? (bmp as ImageBitmap).height : (source as HTMLVideoElement).videoHeight;
  const { width, height } = fitWithin(sw, sh, max);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(bmp as CanvasImageSource, 0, 0, width, height);
  const img = g.getImageData(0, 0, width, height);
  const blob = source instanceof Blob ? source : await new Promise<Blob>((r) => canvas.toBlob((b) => r(b ?? new Blob()), "image/jpeg", 0.9));
  return { width, height, pixels: { data: img.data, width, height }, url: URL.createObjectURL(blob), blob };
}

/** A photo from raw pixels (the end-to-end fixture), drawn to a canvas for its preview. */
export async function photoFromPixels(p: { width: number; height: number; data: Uint8ClampedArray }): Promise<Photo> {
  const canvas = document.createElement("canvas");
  canvas.width = p.width;
  canvas.height = p.height;
  canvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(p.data), p.width, p.height), 0, 0);
  const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b ?? new Blob()), "image/png"));
  return { width: p.width, height: p.height, pixels: { data: p.data, width: p.width, height: p.height }, url: URL.createObjectURL(blob), blob };
}

/** Whether any rubric criterion measures text, so OCR is worth loading. */
export function needsOcr(spec: { criteria?: { measure?: string }[] }): boolean {
  return (spec.criteria ?? []).some((c) => /^\s*text\s*\(/.test(c.measure ?? ""));
}

/** Text in the photo, read on the device. The English data (~2 MB, Apache-2.0) downloads once. */
export async function readText(blob: Blob, lang = "eng"): Promise<string> {
  const url = "/vendor/tesseract/tesseract.esm.min.js";
  const t = await import(/* @vite-ignore */ url);
  const worker = await (t.createWorker ?? t.default.createWorker)(lang, 1, { workerPath: "/vendor/tesseract/worker.min.js", corePath: "/vendor/tesseract/", langPath: TESSDATA_URL, workerBlobURL: false });
  try {
    const r = await worker.recognize(blob);
    return String(r.data?.text ?? "").trim();
  } finally {
    await worker.terminate();
  }
}
