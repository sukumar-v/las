/**
 * Small per-enrollment loop settings kept in the store's setting table. Each key is
 * `<name>.<enrollment id>` so export and delete can find them by enrollment.
 */
import type { LasContext } from "../context.js";

export interface PainState {
  area: string;
  level: number;
  firstAt: string;
  at: string;
  /** drills above this intensity are left out until `until` */
  cap: number;
  until: string;
}

const key = (name: string, sk: string) => `${name}.${sk}`;

export const loopSettings = {
  pain: (ctx: LasContext, sk: string, now = new Date()): PainState | undefined => {
    const p = ctx.store.getSetting<PainState | null>(key("pain", sk), null);
    return p && p.until > now.toISOString() ? p : undefined;
  },
  setPain: (ctx: LasContext, sk: string, p: PainState | null) => ctx.store.setSetting(key("pain", sk), p),
  /** a lighter week from a plateau check-in: shorter sessions, one intensity level lower, until the date */
  lighterUntil: (ctx: LasContext, sk: string, now = new Date()): string | undefined => {
    const u = ctx.store.getSetting<string | null>(key("lighter", sk), null);
    return u && u > now.toISOString() ? u : undefined;
  },
  setLighter: (ctx: LasContext, sk: string, until: string | null) => ctx.store.setSetting(key("lighter", sk), until),
  /** "try a variation": the next session uses each node's other drills first */
  variation: (ctx: LasContext, sk: string): boolean => ctx.store.getSetting<boolean>(key("variation", sk), false),
  setVariation: (ctx: LasContext, sk: string, on: boolean) => ctx.store.setSetting(key("variation", sk), on),
  /** "too easy / too hard" after a session: the next session starts a level higher or lower */
  difficultyOffset: (ctx: LasContext, sk: string): number => ctx.store.getSetting<number>(key("difficultyOffset", sk), 0),
  setDifficultyOffset: (ctx: LasContext, sk: string, v: number) => ctx.store.setSetting(key("difficultyOffset", sk), Math.max(-2, Math.min(2, v))),
  /** the goal a stepping stone was taken toward, offered again once the stone is done */
  nextGoal: (ctx: LasContext, sk: string): { step: number; title: string } | undefined => ctx.store.getSetting<{ step: number; title: string } | null>(key("nextGoal", sk), null) ?? undefined,
  setNextGoal: (ctx: LasContext, sk: string, g: { step: number; title: string } | null) => ctx.store.setSetting(key("nextGoal", sk), g),
  clearFor: (ctx: LasContext, sk: string) => {
    for (const n of ["pain", "lighter", "variation", "difficultyOffset", "nextGoal"]) ctx.store.db.run("DELETE FROM setting WHERE key = ?", key(n, sk));
  }
};
