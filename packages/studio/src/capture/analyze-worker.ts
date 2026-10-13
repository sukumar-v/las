/// <reference lib="webworker" />
/** Runs an engine's analysis off the main thread, so the screen stays responsive while a clip is measured. */
import { analyze } from "@las/engines";

self.onmessage = async (e: MessageEvent<{ id: number; spec: any; evidence: any; ctx: any }>) => {
  const { id, spec, evidence, ctx } = e.data;
  try {
    const analysis = await analyze(spec, evidence, ctx);
    (self as unknown as Worker).postMessage({ id, analysis });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String((err as Error)?.message ?? err) });
  }
};
