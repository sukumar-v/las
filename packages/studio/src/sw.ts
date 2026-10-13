/// <reference lib="webworker" />
/**
 * The studio's service worker (hand-written, no dependency). Precaches the built shell so the studio opens
 * offline; caches runtimes, model weights and fonts cache-first; never caches the API. Shows check-in
 * reminders from Web Push and answers them from the notification's buttons.
 */
const sw = self as unknown as ServiceWorkerGlobalScope;
// the build prepends `self.__LAS_PRECACHE__ = [...]` (the shell's files) and a version (vite.config.ts)
const injected = self as unknown as { __LAS_PRECACHE__?: string[]; __LAS_VERSION__?: string };
const PRECACHE: string[] = injected.__LAS_PRECACHE__ ?? [];
const VERSION: string = injected.__LAS_VERSION__ ?? "dev";
const SHELL = `las-shell-${VERSION}`;
const RUNTIME = "las-runtime-v1";
const MODELS = "las-models-v1";

/** Requests answered from the cache first: the studio's /vendor runtimes, cached fonts and model files, model hosts. */
function cacheFirst(url: URL): string | undefined {
  if (url.origin === sw.location.origin) {
    if (url.pathname.startsWith("/vendor/")) return RUNTIME;
    if (url.pathname.startsWith("/api/fonts/") || url.pathname.startsWith("/api/models/")) return RUNTIME;
    return undefined;
  }
  if (/(^|\.)storage\.googleapis\.com$|(^|\.)huggingface\.co$|(^|\.)hf\.co$|tessdata\.projectnaptha\.com$/.test(url.hostname)) return MODELS;
  return undefined;
}

sw.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(PRECACHE))
      .then(() => sw.skipWaiting())
  );
});

sw.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("las-shell-") && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => sw.clients.claim())
  );
});

sw.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const bucket = cacheFirst(url);
  if (bucket) {
    e.respondWith(
      caches.open(bucket).then(async (c) => {
        const hit = await c.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok && (res.type === "basic" || res.type === "cors")) await c.put(req, res.clone()).catch(() => undefined);
        return res;
      })
    );
    return;
  }
  // the API, the event stream and media are always live
  if (url.origin !== sw.location.origin || url.pathname.startsWith("/api/") || url.pathname === "/manifest.webmanifest") return;
  // the shell: network first so updates land, the cache when offline; every studio path is the app
  e.respondWith(
    fetch(req)
      .then((res) => res)
      .catch(async () => {
        const c = await caches.open(SHELL);
        return (await c.match(req)) ?? (req.mode === "navigate" ? ((await c.match("/")) ?? Response.error()) : Response.error());
      })
  );
});

interface PushData {
  type: "checkin";
  checkin: { id: string; question: string; options: { id: string; label: string }[] };
  sk?: string;
  url: string;
}

sw.addEventListener("push", (e) => {
  let data: PushData | undefined;
  try {
    data = e.data?.json() as PushData;
  } catch {
    data = undefined;
  }
  if (!data?.checkin) return;
  const c = data.checkin;
  const max = (Notification as unknown as { maxActions?: number }).maxActions ?? 2;
  e.waitUntil(
    sw.registration.showNotification("Learn Any Skill", {
      body: c.question,
      tag: c.id,
      data,
      // one-tap answers where the platform shows buttons; elsewhere a tap opens Today
      actions: c.options.slice(0, max).map((o) => ({ action: o.id, title: o.label }))
    } as NotificationOptions)
  );
});

sw.addEventListener("notificationclick", (e) => {
  const data = e.notification.data as PushData | undefined;
  e.notification.close();
  const answer = e.action && data?.checkin ? fetch("/api/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "checkin.answered", checkinId: data.checkin.id, option: e.action }) }).catch(() => undefined) : Promise.resolve(undefined);
  const target = data?.url ?? "/";
  e.waitUntil(
    answer.then(async () => {
      const wins = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of wins) {
        if ("focus" in w) {
          await (w as WindowClient).navigate(target).catch(() => undefined);
          return (w as WindowClient).focus();
        }
      }
      return sw.clients.openWindow(target);
    })
  );
});
