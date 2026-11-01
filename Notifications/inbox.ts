import { NOTIFICATION_APPS, type NotificationApp } from "./compose.js";
import { NotificationModel, type NotificationRecord } from "./model.js";

// A person's own notifications (Shortwork/docs/notifications.md §6). Every query is scoped by the
// personId from the verified token, so another person's notification is never read, counted or
// changed — and an unknown id behaves exactly like someone else's.

export const MAX_PAGE = 50;
const DEFAULT_PAGE = 30;
const MAX_IDS = 100;

export interface PublicNotification {
  id: string;
  app: string;
  category: string;
  title: string;
  body: string;
  occurredAt: string;
  readAt: string | null;
}

export interface NotificationSummary {
  unread: number;
  byApp: Record<string, number>;
}

const toPublic = (record: NotificationRecord): PublicNotification => ({
  id: record._id,
  app: record.app,
  category: record.category,
  title: record.title,
  body: record.body,
  occurredAt: record.occurredAt.toISOString(),
  readAt: record.readAt ? record.readAt.toISOString() : null,
});

/** "2026-11-01T10:00:00.000Z_<eventId>" — the last item of a page, so ties in time never skip one. */
const encodeCursor = (record: NotificationRecord): string => `${record.occurredAt.toISOString()}_${record._id}`;

const decodeCursor = (value: string): { at: Date; id: string } | null => {
  const split = value.indexOf("_");
  if (split < 1) return null;
  const at = new Date(value.slice(0, split));
  const id = value.slice(split + 1);
  return Number.isNaN(at.getTime()) || !id ? null : { at, id };
};

export class InboxInputError extends Error {}

export const parseLimit = (raw: unknown): number => {
  if (raw === undefined || raw === "") return DEFAULT_PAGE;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PAGE) throw new InboxInputError(`limit must be 1–${MAX_PAGE}`);
  return n;
};

export const listNotifications = async (
  personId: string,
  options: { limit: number; before?: string }
): Promise<{ notifications: PublicNotification[]; nextBefore: string | null }> => {
  const filter: Record<string, unknown> = { personId };
  if (options.before) {
    const cursor = decodeCursor(options.before);
    if (!cursor) throw new InboxInputError("before is not a valid cursor");
    filter.$or = [{ occurredAt: { $lt: cursor.at } }, { occurredAt: cursor.at, _id: { $lt: cursor.id } }];
  }

  const records = await NotificationModel.find(filter)
    .sort({ occurredAt: -1, _id: -1 })
    .limit(options.limit + 1)
    .lean<NotificationRecord[]>();

  const page = records.slice(0, options.limit);
  return {
    notifications: page.map(toPublic),
    nextBefore: records.length > options.limit ? encodeCursor(page[page.length - 1]) : null,
  };
};

export const summarize = async (personId: string): Promise<NotificationSummary> => {
  const groups = await NotificationModel.aggregate<{ _id: string; n: number }>([
    { $match: { personId, readAt: null } },
    { $group: { _id: "$app", n: { $sum: 1 } } },
  ]);
  const byApp: Record<string, number> = {};
  let unread = 0;
  for (const group of groups) {
    byApp[group._id] = group.n;
    unread += group.n;
  }
  return { unread, byApp };
};

export type ReadSelector = { ids: string[] } | { app: NotificationApp } | { all: true };

/** Accepts exactly one of { ids }, { app } or { all: true }. */
export const parseReadSelector = (body: unknown): ReadSelector => {
  const input = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const given = ["ids", "app", "all"].filter((key) => input[key] !== undefined);
  if (given.length !== 1) throw new InboxInputError("send exactly one of ids, app or all");

  if (input.ids !== undefined) {
    const ids = input.ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_IDS || !ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= 128)) {
      throw new InboxInputError(`ids must be 1–${MAX_IDS} notification ids`);
    }
    return { ids: ids as string[] };
  }
  if (input.app !== undefined) {
    if (!(NOTIFICATION_APPS as readonly unknown[]).includes(input.app)) throw new InboxInputError("app is not one that has notifications");
    return { app: input.app as NotificationApp };
  }
  if (input.all !== true) throw new InboxInputError("all must be true");
  return { all: true };
};

/** Idempotent: only unread notifications change, so repeating a request changes nothing. */
export const markRead = async (personId: string, selector: ReadSelector, now: Date = new Date()): Promise<void> => {
  const filter: Record<string, unknown> = { personId, readAt: null };
  if ("ids" in selector) filter._id = { $in: selector.ids };
  if ("app" in selector) filter.app = selector.app;
  await NotificationModel.updateMany(filter, { $set: { readAt: now } });
};
