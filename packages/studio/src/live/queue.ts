/**
 * The live session's outbox (live-coach §14, "the studio goes offline"): events go out in the order they
 * happened. When the server can't be reached the rest wait, in memory and in sessionStorage, and go out in the same
 * order on reconnect. An event the server refuses (a 4xx) is dropped so it never blocks the ones behind it.
 */
import type { StudioEvent } from "@las/schema";

export interface QueueStore {
  load(): StudioEvent[];
  save(items: StudioEvent[]): void;
}

/** sessionStorage under one key; a convenience, so failures are ignored. */
export function sessionQueueStore(key: string): QueueStore {
  return {
    load() {
      try {
        const s = sessionStorage.getItem(key);
        const v = s ? JSON.parse(s) : [];
        return Array.isArray(v) ? v : [];
      } catch {
        return [];
      }
    },
    save(items) {
      try {
        if (items.length) sessionStorage.setItem(key, JSON.stringify(items));
        else sessionStorage.removeItem(key);
      } catch {
        /* memory still holds them */
      }
    }
  };
}

export const memoryQueueStore = (): QueueStore => {
  let held: StudioEvent[] = [];
  return { load: () => [...held], save: (items) => void (held = [...items]) };
};

/** Network trouble (no answer, or a gateway error) keeps the event for later; anything else is a refusal. */
export function isRetryable(e: unknown): boolean {
  const status = (e as { status?: number } | undefined)?.status;
  return status === undefined || status === 0 || status === 502 || status === 503 || status === 504;
}

export interface EventQueue {
  /** adds an event and starts sending; resolves when this flush ends */
  push(ev: StudioEvent): Promise<void>;
  /** sends whatever is waiting, in order */
  flush(): Promise<void>;
  pending(): StudioEvent[];
  online(): boolean;
}

export function createEventQueue(opts: { send: (ev: StudioEvent) => Promise<unknown>; store?: QueueStore; onChange?: (s: { pending: number; online: boolean }) => void; onRefused?: (ev: StudioEvent, e: unknown) => void }): EventQueue {
  const store = opts.store ?? memoryQueueStore();
  const items: StudioEvent[] = store.load();
  let isOnline = true;
  let running: Promise<void> | undefined;
  const changed = () => opts.onChange?.({ pending: items.length, online: isOnline });

  async function run(): Promise<void> {
    while (items.length) {
      const ev = items[0];
      try {
        await opts.send(ev);
      } catch (e) {
        if (isRetryable(e)) {
          isOnline = false;
          changed();
          return;
        }
        opts.onRefused?.(ev, e);
      }
      items.shift();
      store.save(items);
      isOnline = true;
      changed();
    }
  }

  function flush(): Promise<void> {
    if (running) return running;
    running = run().finally(() => {
      running = undefined;
      // an event pushed while the last send was settling goes out now
      if (items.length && isOnline) void flush();
    });
    return running;
  }

  return {
    push(ev) {
      items.push(ev);
      store.save(items);
      changed();
      return flush();
    },
    flush,
    pending: () => [...items],
    online: () => isOnline
  };
}
