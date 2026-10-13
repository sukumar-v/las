import { z } from "zod";
import { EngineIdSchema } from "./engines.js";
import { LANGUAGES, RUNNER_IDS } from "./specs/test.js";

export const EngineStatusSchema = z.object({
  id: EngineIdSchema,
  available: z.boolean(),
  /** short, learner-safe reason when unavailable */
  reason: z.string().optional(),
  models: z.array(z.object({ id: z.string(), downloaded: z.boolean(), license: z.string() })).default([]),
  backend: z.enum(["wasm", "webgpu", "cpu", "gpu", "native", "none"]).default("wasm"),
  /** sub-capabilities, e.g. speech: per-sound scoring languages; game: engines found */
  details: z.record(z.string(), z.unknown()).optional()
});

export const CapabilitiesSchema = z.object({
  version: z.string(),
  platform: z.object({ os: z.string(), arch: z.string(), node: z.string() }),
  engines: z.array(EngineStatusSchema),
  runners: z.object({
    browser: z.array(z.enum(LANGUAGES)),
    local: z.array(z.object({ language: z.enum(LANGUAGES), tool: z.string(), version: z.string().optional(), consented: z.boolean().default(false) })),
    container: z.object({ available: z.boolean(), runtime: z.string().optional(), consented: z.boolean().default(false) })
  }),
  devices: z.object({ camera: z.boolean(), microphone: z.boolean(), motion: z.boolean(), phone: z.boolean(), studio: z.boolean() }),
  external: z.array(z.object({ name: z.string(), protocol: z.string(), path: z.string(), license: z.string(), note: z.string().optional() })),
  localModels: z.array(z.object({ id: z.string(), kind: z.enum(["vision", "tts", "stt", "phoneme"]), available: z.boolean(), license: z.string() })),
  /** whether the connected client renders MCP Apps widgets */
  widgets: z.boolean(),
  studioUrl: z.string()
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;
export type EngineStatus = z.infer<typeof EngineStatusSchema>;

export const RUNNERS = RUNNER_IDS;
