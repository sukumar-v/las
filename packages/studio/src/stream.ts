/** The server's live event stream (/api/stream): theme changes, analyses from a paired phone, check-ins. */
type Handler = (payload: any) => void;
const handlers = new Map<string, Set<Handler>>();
let source: EventSource | undefined;

function ensure(): void {
  if (source || typeof EventSource === "undefined") return;
  source = new EventSource("/api/stream");
  source.onerror = () => {
    // the browser reconnects on its own; nothing to show the learner
  };
}

export function onStream(type: string, fn: Handler): () => void {
  ensure();
  let set = handlers.get(type);
  if (!set) {
    set = new Set();
    handlers.set(type, set);
    source?.addEventListener(type, (e) => {
      let data: unknown;
      try {
        data = JSON.parse((e as MessageEvent).data);
      } catch {
        data = undefined;
      }
      for (const h of handlers.get(type) ?? []) h(data);
    });
  }
  set.add(fn);
  return () => set!.delete(fn);
}
