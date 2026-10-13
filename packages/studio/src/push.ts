/** Web Push on this device (opt-in from Settings): the service worker's subscription, stored on the local server. */
import { api } from "./api.js";

export function pushSupported(): boolean {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator && typeof window !== "undefined" && "PushManager" in window && "Notification" in window;
}

/** VAPID public keys come as URL-safe base64; the Push API wants bytes. */
export function base64UrlToBytes(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

export async function subscribePush(): Promise<string> {
  if (!pushSupported()) throw new Error("This browser can't receive push reminders.");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Notifications are blocked for the studio. Allow them in the browser's site settings.");
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await api.pushKey();
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(publicKey) as BufferSource }));
  const r = await api.pushSubscribe(sub.toJSON());
  try {
    localStorage.setItem("las.pushId", r.id);
  } catch {}
  return r.id;
}

export async function unsubscribePush(id: string): Promise<void> {
  const reg = await navigator.serviceWorker.ready;
  await (await reg.pushManager.getSubscription())?.unsubscribe();
  await api.pushUnsubscribe(id);
  try {
    localStorage.removeItem("las.pushId");
  } catch {}
}
