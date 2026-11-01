import { createHash } from "crypto";
import webpush, { type RequestDetails } from "web-push";
import { isAllowedPushEndpoint } from "./endpoint.js";
import { PushSubscriptionModel, type PushSubscriptionRecord } from "./model.js";

// Sends a notice to a person's devices over Web Push (Shortwork/docs/notifications.md §8).
//
// web-push encrypts the payload for the browser (aes128gcm) and signs the VAPID header; this
// module makes the request itself, so every call has a 3 s timeout, never follows a redirect,
// and is checked against the push-service allow-list first.

export interface PushMessage {
  /** The notification's id, so a tap can open it. */
  id: string;
  title: string;
  body: string;
  /** The hub app the notice belongs to. */
  app: string;
  /** A newer alert with the same tag replaces the older one on the device. */
  tag: string;
}

export interface PushResult {
  sent: number;
  removed: number;
  failed: number;
}

export interface PushSender {
  readonly publicKey: string;
  send(personId: string, message: PushMessage): Promise<PushResult>;
}

export interface VapidDetails {
  subject: string;
  publicKey: string;
  privateKey: string;
}

export interface PushSenderOptions {
  vapid: VapidDetails;
  /** Extra allowed hosts (PUSH_ALLOWED_HOSTS): tests and the e2e harness only. */
  allowedHosts: readonly string[];
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

/** How long a push service keeps an alert for an offline device. Older news waits in the inbox. */
const TTL_SECONDS = 24 * 60 * 60;

const log = (fields: Record<string, unknown>): void => {
  // Counts and the person only: never an endpoint, a key or the alert's text (AGENTS.md §6.3).
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), level: "info", svc: "auth", event: "push", ...fields })}\n`);
};

/** A push service collapses alerts with the same Topic: at most 32 URL-safe characters. */
const topicFor = (tag: string): string => createHash("sha256").update(tag, "utf8").digest("base64url").slice(0, 32);

/**
 * Builds the sender, or throws when the VAPID details are unusable, so a bad key is found at
 * start-up rather than on the first notice.
 */
export const createPushSender = (options: PushSenderOptions): PushSender => {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 3_000;
  // Throws on a malformed subject or key pair.
  webpush.getVapidHeaders("https://fcm.googleapis.com", options.vapid.subject, options.vapid.publicKey, options.vapid.privateKey, "aes128gcm");

  type Outcome = "sent" | "removed" | "failed";

  const sendTo = async (subscription: PushSubscriptionRecord, payload: string, tag: string): Promise<Outcome> => {
    if (!isAllowedPushEndpoint(subscription.endpoint, options.allowedHosts)) {
      // Stored before its host was dropped from the list: never call it.
      await PushSubscriptionModel.deleteOne({ _id: subscription._id });
      return "removed";
    }
    let request: RequestDetails;
    try {
      request = webpush.generateRequestDetails({ endpoint: subscription.endpoint, keys: subscription.keys }, payload, {
        vapidDetails: options.vapid,
        TTL: TTL_SECONDS,
        contentEncoding: "aes128gcm",
        urgency: "normal",
        topic: topicFor(tag),
      });
    } catch {
      return "failed";
    }
    // fetch sets the length itself and refuses a hand-written one.
    const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => name.toLowerCase() !== "content-length"));
    try {
      const response = await fetchImpl(request.endpoint, {
        method: "POST",
        headers,
        body: request.body ? new Uint8Array(request.body) : null,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      await response.arrayBuffer().catch(() => undefined);
      if (response.status === 404 || response.status === 410) {
        // The browser unsubscribed or the subscription expired: it will never work again.
        await PushSubscriptionModel.deleteOne({ _id: subscription._id, endpoint: subscription.endpoint });
        return "removed";
      }
      if (!response.ok) return "failed";
      await PushSubscriptionModel.updateOne({ _id: subscription._id }, { $set: { lastSentAt: new Date() } });
      return "sent";
    } catch {
      return "failed";
    }
  };

  return {
    publicKey: options.vapid.publicKey,
    async send(personId, message) {
      const subscriptions = await PushSubscriptionModel.find({ personId }).lean<PushSubscriptionRecord[]>();
      const result: PushResult = { sent: 0, removed: 0, failed: 0 };
      if (subscriptions.length === 0) return result;
      const payload = JSON.stringify(message);
      const outcomes = await Promise.all(subscriptions.map((subscription) => sendTo(subscription, payload, message.tag)));
      for (const outcome of outcomes) result[outcome] += 1;
      log({ personId, ...result });
      return result;
    },
  };
};
