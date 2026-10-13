import { Store } from "@las/store";
import type { Capabilities } from "@las/schema";
import { defaultConfig, type LasConfig } from "./config.js";
import { detectCapabilities } from "./core/capabilities.js";

/** Everything a tool handler needs. One per server process. */
export class LasContext {
  readonly store: Store;
  readonly config: LasConfig;
  /** set by the MCP layer once the client's capabilities are known */
  widgetsSupported = false;
  private capsCache?: { at: number; caps: Capabilities };
  /** the studio reports its devices here while open */
  devices: { camera: boolean; microphone: boolean; motion: boolean; phone: boolean; reportedAt?: number } = { camera: false, microphone: false, motion: false, phone: false };
  /** listeners for live studio updates (server-sent events) */
  readonly listeners = new Set<(event: { type: string; payload: unknown }) => void>();

  constructor(config: Partial<LasConfig> = {}, store?: Store) {
    this.config = defaultConfig(config);
    this.store = store ?? new Store(this.config.dbPath);
  }

  async capabilities(fresh = false): Promise<Capabilities> {
    if (!fresh && this.capsCache && Date.now() - this.capsCache.at < 60_000) return this.capsCache.caps;
    const caps = await detectCapabilities(this);
    this.capsCache = { at: Date.now(), caps };
    return caps;
  }

  emit(type: string, payload: unknown): void {
    for (const l of this.listeners) {
      try {
        l({ type, payload });
      } catch {
        /* a dead listener never breaks a tool */
      }
    }
  }

  studioLink(path: string): string {
    return `${this.config.studioUrl}${path.startsWith("/") ? path : "/" + path}`;
  }

  close(): void {
    this.store.close();
  }
}
