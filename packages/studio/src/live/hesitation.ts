/**
 * `learner.hesitated` (live-coach §6): N seconds on a screen with no action. Once per screen, and never while a
 * recording runs (the learner is busy, not stuck). Any action starts the count again.
 */
import { COACH_DEFAULTS } from "@las/schema";

export interface HesitationTimer {
  /** a new screen: the count starts and the screen may fire once */
  start(screenId: string): void;
  /** the learner did something: the count starts again */
  activity(): void;
  stop(): void;
  fired(screenId: string): boolean;
}

export function createHesitationTimer(opts: { onHesitate: (screenId: string, seconds: number) => void; seconds?: number; isRecording?: () => boolean }): HesitationTimer {
  const seconds = opts.seconds ?? COACH_DEFAULTS.hesitationS;
  let screen: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = new Set<string>();

  const clear = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const arm = () => {
    clear();
    if (!screen || done.has(screen)) return;
    const id = screen;
    timer = setTimeout(() => {
      timer = undefined;
      if (screen !== id || done.has(id)) return;
      // busy recording: look again after another full wait
      if (opts.isRecording?.()) return arm();
      done.add(id);
      opts.onHesitate(id, seconds);
    }, seconds * 1000);
  };

  return {
    start(screenId) {
      screen = screenId;
      arm();
    },
    activity() {
      if (screen && !done.has(screen)) arm();
    },
    stop() {
      clear();
      screen = undefined;
    },
    fired: (id) => done.has(id)
  };
}

/** True while the shared recording screen is recording (it marks itself with data-recording). */
export function recordingInDocument(doc: Document | undefined = typeof document === "undefined" ? undefined : document): boolean {
  return !!doc?.querySelector('[data-recording="true"]');
}
