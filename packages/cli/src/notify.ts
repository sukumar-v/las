import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { NotifyChannel } from "./adapters.js";
import { commandOnPath } from "./env.js";

/**
 * Tells the learner their coach is waiting (live-coach §4: the alive-pid rule, and clients with no headless mode).
 * "push" goes through the studio's Web Push (`sendPush` in packages/server/src/core/push.ts, reused as is) and falls
 * back to the OS notifier when nothing was delivered; "os" uses the OS notifier only; "none" only logs.
 * The text is the adapter's fixed `notifyText`: never learner text.
 */

export interface Notice {
  channel: NotifyChannel;
  text: string;
  /** studio path or URL a tap opens */
  url: string;
  liveSessionId: string;
  sk: string;
}

/** Which channel delivered it ("log" when none did). */
export type Notifier = (n: Notice) => Promise<"push" | "os" | "log">;

const TITLE = "Learn Any Skill";

type SendPush = (ctx: unknown, payload: unknown) => Promise<{ sent: number }>;

/** `sendPush` from @las/server: its public entry when exported there, else core/push next to the entry file. */
async function loadSendPush(): Promise<SendPush | undefined> {
  const mod = (await import("@las/server")) as Record<string, unknown>;
  if (typeof mod.sendPush === "function") return mod.sendPush as SendPush;
  try {
    const entry = createRequire(import.meta.url).resolve("@las/server");
    const file = ["push.js", "push.ts"].map((f) => join(dirname(entry), "core", f)).find(existsSync);
    if (!file) return undefined;
    const push = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    return typeof push.sendPush === "function" ? (push.sendPush as SendPush) : undefined;
  } catch {
    return undefined;
  }
}

/** The desktop's own notifier: notify-send (Linux), osascript (macOS). None on Windows yet. */
export function osNotify(text: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    if (platform === "linux" && commandOnPath("notify-send")) {
      return spawnSync("notify-send", ["--app-name", TITLE, TITLE, text], { timeout: 5000 }).status === 0;
    }
    if (platform === "darwin") {
      const q = (s: string) => `"${s.replace(/[\\"]/g, "\\$&")}"`;
      return spawnSync("osascript", ["-e", `display notification ${q(text)} with title ${q(TITLE)}`], { timeout: 5000 }).status === 0;
    }
  } catch {
    /* no notifier */
  }
  return false;
}

/**
 * The real notifier. The push payload keeps the shape the studio's service worker shows today (a `checkin` with a
 * question and no options, so a tap opens `url`) and says `type: "coach"` so the worker can tell it apart.
 */
export function makeNotifier(ctx: { studioLink(path: string): string }, log: (line: string) => void, platform: NodeJS.Platform = process.platform): Notifier {
  return async (n) => {
    if (n.channel === "push") {
      try {
        const send = await loadSendPush();
        if (send) {
          const r = await send(ctx, { type: "coach", checkin: { id: `coach-${n.liveSessionId}`, question: n.text, options: [] }, sk: n.sk, url: n.url });
          if (r.sent > 0) return "push";
        }
      } catch (e) {
        log(`las coach: push not sent: ${(e as Error).message}`);
      }
    }
    if (n.channel !== "none" && osNotify(n.text, platform)) return "os";
    log(`las coach: ${n.text} (${ctx.studioLink(n.url)})`);
    return "log";
  };
}
