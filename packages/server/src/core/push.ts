/**
 * Web Push for check-ins (learning loop §7 "Delivery", DESIGN §10): opt-in, per browser. The studio's service
 * worker subscribes with the server's VAPID public key; `runCheckins` sends one push per check-in it delivers,
 * within the quiet hours and nudge limits it already enforces. Uses `web-push` (MPL-2.0) unmodified, loaded
 * lazily so nothing changes for learners who never opt in.
 */
import type { CheckinView } from "@las/schema";
import type { LasContext } from "../context.js";

const VAPID_KEY = "push.vapid";
/** Decision: push services require a contact in the VAPID claims; a local install has no address, so this is a placeholder. */
export const VAPID_SUBJECT = "mailto:learner@localhost.invalid";

export interface PushSubscriptionJson {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}

/** What the service worker receives: the check-in, the skill it belongs to and where a tap opens. */
export interface PushPayload {
  type: "checkin";
  checkin: CheckinView;
  sk?: string;
  url: string;
}

type WebPush = {
  generateVAPIDKeys(): { publicKey: string; privateKey: string };
  sendNotification(sub: PushSubscriptionJson, payload: string, opts: { vapidDetails: { subject: string; publicKey: string; privateKey: string }; TTL?: number }): Promise<{ statusCode: number }>;
};

let webPush: Promise<WebPush> | undefined;
async function loadWebPush(): Promise<WebPush> {
  webPush ??= import("web-push").then((m) => ((m as { default?: WebPush }).default ?? (m as unknown as WebPush)));
  return webPush;
}

/** The server's VAPID keys, generated once and kept in the store's settings. */
export async function vapidKeys(ctx: LasContext): Promise<{ publicKey: string; privateKey: string }> {
  const have = ctx.store.getSetting<{ publicKey: string; privateKey: string } | null>(VAPID_KEY, null);
  if (have?.publicKey && have.privateKey) return have;
  const keys = (await loadWebPush()).generateVAPIDKeys();
  ctx.store.setSetting(VAPID_KEY, keys);
  return keys;
}

export function isSubscription(v: unknown): v is PushSubscriptionJson {
  const s = v as PushSubscriptionJson | undefined;
  return !!s && typeof s.endpoint === "string" && /^https:\/\//.test(s.endpoint) && typeof s.keys?.p256dh === "string" && typeof s.keys?.auth === "string";
}

export function subscriptions(ctx: LasContext): { id: string; subscription: PushSubscriptionJson }[] {
  const learner = ctx.store.getOrCreateLearner();
  return ctx.store.listPushSubscriptions(learner.id).filter((s) => isSubscription(s.subscription));
}

/** Sends one payload to every subscription. Gone subscriptions (404/410) are removed. */
export async function sendPush(ctx: LasContext, payload: PushPayload): Promise<{ sent: number; failed: number; removed: number }> {
  const subs = subscriptions(ctx);
  const out = { sent: 0, failed: 0, removed: 0 };
  if (!subs.length) return out;
  const wp = await loadWebPush();
  const keys = await vapidKeys(ctx);
  const body = JSON.stringify(payload);
  for (const s of subs) {
    try {
      await wp.sendNotification(s.subscription, body, { vapidDetails: { subject: VAPID_SUBJECT, ...keys }, TTL: 12 * 3600 });
      out.sent++;
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        ctx.store.removePushSubscription(s.id);
        out.removed++;
      } else out.failed++;
    }
  }
  return out;
}

/**
 * The `deliver` callback for runCheckins when this learner has opted in to push on any device; undefined
 * otherwise, so `las checkin` and the studio's check-in run push automatically once a subscription exists.
 */
export function pushDeliverer(ctx: LasContext): ((c: CheckinView) => Promise<void>) | undefined {
  if (!subscriptions(ctx).length) return undefined;
  return async (c) => {
    const sk = ctx.store.getCheckin(c.id)?.enrollmentId;
    try {
      await sendPush(ctx, { type: "checkin", checkin: c, sk, url: sk ? `/app/today?sk=${encodeURIComponent(sk)}` : "/" });
    } catch (e) {
      // a push service being unreachable never stops the check-in run; Today still shows the check-in
      process.stderr.write(`[las] push not sent: ${(e as Error).message}\n`);
    }
  };
}
