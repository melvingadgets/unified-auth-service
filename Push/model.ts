import { createHash } from "crypto";
import mongoose from "mongoose";

// Web Push subscriptions (Shortwork/docs/notifications.md §8): one row per browser. The _id is a
// hash of the endpoint, so a browser that subscribes again replaces its own row, and a browser a
// different person signs in to moves to them. The endpoint and keys are never logged or returned.

export const MAX_SUBSCRIPTIONS_PER_PERSON = 10;

export interface PushSubscriptionRecord {
  /** sha256 of the endpoint, hex. */
  _id: string;
  personId: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  createdAt: Date;
  updatedAt: Date;
  lastSentAt: Date | null;
}

export const subscriptionId = (endpoint: string): string => createHash("sha256").update(endpoint, "utf8").digest("hex");

const schema = new mongoose.Schema<PushSubscriptionRecord>(
  {
    _id: { type: String, required: true },
    personId: { type: String, required: true },
    endpoint: { type: String, required: true },
    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true },
    },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
    lastSentAt: { type: Date, default: null },
  },
  { versionKey: false, collection: "push_subscriptions" }
);

schema.index({ personId: 1, updatedAt: -1 });

export const PushSubscriptionModel = mongoose.model<PushSubscriptionRecord>("PushSubscription", schema);
