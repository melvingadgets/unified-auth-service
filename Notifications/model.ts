import mongoose from "mongoose";

// Auth's notification collections (Shortwork/docs/notifications.md §4). A notification is a
// read-only cache of another service's fact (AGENTS.md §1.3): it carries its source, the
// source's seq and when it was received, and it can be rebuilt by re-delivering events.

const RETENTION_SECONDS = 180 * 24 * 60 * 60;

export interface NotificationRecord {
  /** The eventId. One event makes at most one notification, so the document is its own inbox record. */
  _id: string;
  personId: string;
  category: string;
  app: string;
  title: string;
  body: string;
  source: string;
  sourceType: string;
  sourceSeq: number;
  subjectKey: string;
  occurredAt: Date;
  asOf: Date;
  readAt: Date | null;
  createdAt: Date;
}

const notificationSchema = new mongoose.Schema<NotificationRecord>(
  {
    _id: { type: String, required: true },
    personId: { type: String, required: true },
    category: { type: String, required: true },
    app: { type: String, required: true },
    title: { type: String, required: true },
    body: { type: String, required: true },
    source: { type: String, required: true },
    sourceType: { type: String, required: true },
    sourceSeq: { type: Number, required: true },
    subjectKey: { type: String, required: true },
    occurredAt: { type: Date, required: true },
    asOf: { type: Date, required: true },
    readAt: { type: Date, default: null },
    createdAt: { type: Date, required: true },
  },
  { versionKey: false, collection: "notifications" }
);

notificationSchema.index({ personId: 1, occurredAt: -1, _id: -1 });
notificationSchema.index({ personId: 1, readAt: 1 });
// A recent-activity feed: every fact stays with the service that owns it.
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: RETENTION_SECONDS });

export const NotificationModel = mongoose.model<NotificationRecord>("Notification", notificationSchema);

/** The last seq applied per event subject (AGENTS.md §3.3). */
interface CursorRecord {
  _id: string;
  seq: number;
  updatedAt: Date;
}

export const NotificationCursorModel = mongoose.model<CursorRecord>(
  "NotificationCursor",
  new mongoose.Schema<CursorRecord>(
    {
      _id: { type: String, required: true },
      seq: { type: Number, required: true },
      updatedAt: { type: Date, required: true },
    },
    { versionKey: false, collection: "notification_cursors" }
  )
);

/** Deliveries that can never apply (bad envelope, unknown type or version). Never retried. */
interface DeadLetterRecord {
  _id: string;
  reason: string;
  message: string;
  body: string;
  deadLetteredAt: Date;
}

export const NotificationDeadLetterModel = mongoose.model<DeadLetterRecord>(
  "NotificationDeadLetter",
  new mongoose.Schema<DeadLetterRecord>(
    {
      _id: { type: String, required: true },
      reason: { type: String, required: true },
      message: { type: String, required: true },
      body: { type: String, required: true },
      deadLetteredAt: { type: Date, required: true },
    },
    { versionKey: false, collection: "notification_dead_letters" }
  )
);
