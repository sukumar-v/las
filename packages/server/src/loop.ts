import type { StudioEvent } from "@las/schema";
import type { LasContext } from "./context.js";
import type { EventSink } from "./http/app.js";

/** Installs the learning loop's event handling. Phase 5 replaces the body; until then events are logged. */
export function installLoop(ctx: LasContext): EventSink {
  return {
    onEvent(event: StudioEvent) {
      const sk = "sk" in event ? (event as any).sk : undefined;
      ctx.store.logEvent(sk ?? null, event.type, event);
      ctx.emit(event.type, event);
      return { logged: true };
    }
  };
}
