/**
 * The live coach's studio API (docs/design/live-coach.md §8): the open live session, starting one from the
 * studio with no coach, the current screen, advancing past a screen, and studio presence. Learner actions go
 * through POST /api/events as before; screens and state reach the studio on GET /api/stream.
 */
import type { LasContext } from "../context.js";
import type { Handler, Req, Res, Router } from "./router.js";
import { LoopError } from "../core/common.js";
import { advance, getLive, openLiveFor, startFromStudio, studioPing } from "../core/director.js";

function h(fn: (req: Req, res: Res) => Promise<unknown> | unknown): Handler {
  return async (req, res) => {
    try {
      const out = await fn(req, res);
      if (out !== undefined) res.json(out);
    } catch (e) {
      if (e instanceof LoopError) res.json({ ok: false, error: e.message, data: e.data ?? null }, 400);
      else res.json({ ok: false, error: (e as Error).message }, 500);
    }
  };
}

const known = (ctx: LasContext, id: string) => {
  if (!ctx.store.getLiveSession(id)) throw new LoopError(`Unknown live session "${id}".`);
  return id;
};

export function mountLiveRoutes(router: Router, ctx: LasContext): void {
  router.get(
    "/api/live",
    h((req) => {
      const sk = req.query.get("sk");
      if (!sk) throw new LoopError("Missing sk.");
      return { live: openLiveFor(ctx, sk) };
    })
  );
  router.post(
    "/api/live/start",
    h(async (req) => {
      const b = await req.json();
      if (!b.sk) throw new LoopError("Missing sk.");
      return startFromStudio(ctx, String(b.sk), { minutes: typeof b.minutes === "number" ? b.minutes : undefined, location: typeof b.location === "string" ? b.location : undefined });
    })
  );
  router.get(
    "/api/live/:sessionId",
    h((req) => getLive(ctx, known(ctx, req.params.sessionId)))
  );
  router.post(
    "/api/live/:sessionId/advance",
    h(async (req) => {
      const b = await req.json();
      return advance(ctx, known(ctx, req.params.sessionId), typeof b.screenId === "string" ? b.screenId : undefined, typeof b.seconds === "number" ? b.seconds : undefined);
    })
  );
  router.post(
    "/api/live/:sessionId/ping",
    h((req) => studioPing(ctx, known(ctx, req.params.sessionId)))
  );
}
