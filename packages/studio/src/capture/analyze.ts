/** The main-thread side of the analysis worker. Falls back to analyzing here when workers are unavailable. */
import type { Analysis } from "@las/schema";
import { analyze } from "@las/engines";
import AnalyzeWorker from "./analyze-worker.ts?worker";

let worker: Worker | undefined;
let seq = 0;
const pending = new Map<number, { resolve: (a: Analysis) => void; reject: (e: Error) => void }>();

function getWorker(): Worker | undefined {
  if (worker) return worker;
  try {
    worker = new AnalyzeWorker();
    worker.onmessage = (e: MessageEvent<{ id: number; analysis?: Analysis; error?: string }>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.error) p.reject(new Error(e.data.error));
      else p.resolve(e.data.analysis!);
    };
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error(e.message || "analysis failed"));
      pending.clear();
      worker = undefined;
    };
  } catch {
    worker = undefined;
  }
  return worker;
}

/** Typed arrays that can move to the worker without a copy. */
function transferables(evidence: any): Transferable[] {
  const out: Transferable[] = [];
  if (evidence?.samples instanceof Float32Array) out.push(evidence.samples.buffer);
  if (evidence?.pixels?.data?.buffer instanceof ArrayBuffer) out.push(evidence.pixels.data.buffer);
  return out;
}

export async function analyzeOnDevice(spec: unknown, evidence: unknown, ctx: Record<string, unknown> = {}): Promise<Analysis> {
  const w = getWorker();
  if (!w) return analyze(spec as any, evidence, ctx);
  const id = ++seq;
  return new Promise<Analysis>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    // transfer copies, so the caller keeps its evidence for upload
    const ev = structuredClone(evidence);
    w.postMessage({ id, spec, evidence: ev, ctx }, transferables(ev));
  });
}
