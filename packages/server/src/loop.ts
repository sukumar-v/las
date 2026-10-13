import type { StudioEvent } from "@las/schema";
import type { LasContext } from "./context.js";
import type { EventSink } from "./http/app.js";
import { LoopError } from "./core/common.js";
import { handleEvent } from "./core/sessions.js";

/**
 * The learning loop's event sink: every studio event updates mastery, reviews, mistakes, the time log,
 * proof checks and the schedule (core/sessions.ts), then goes out to live listeners (the studio's stream).
 * A learner-facing problem (an unknown session, say) comes back as `{error}` instead of failing the request.
 */
export function installLoop(ctx: LasContext): EventSink {
  return {
    async onEvent(event: StudioEvent) {
      try {
        const result = await handleEvent(ctx, event);
        ctx.emit(event.type, event);
        return result;
      } catch (e) {
        if (e instanceof LoopError) {
          ctx.store.logEvent(null, event.type, event);
          return { error: e.message };
        }
        throw e;
      }
    }
  };
}
