import type { Request, Response } from "express";
import {
  bearerToken,
  DeliveryError,
  DELIVERY_ID_HEADER,
  EVENT_ID_HEADER,
  EventValidationError,
  isDuplicateKey,
  parseEvent,
  SIGNATURE_HEADER,
  subjectKey,
  type EventEnvelope,
  type TokenVerifier,
} from "@melvingadgets/platform-kit";
import type { PushMessage, PushSender } from "../Push/sender.js";
import { composeNotification, type CollapseRule, type NotificationDraft } from "./compose.js";
import { NotificationCursorModel, NotificationDeadLetterModel, NotificationModel } from "./model.js";

// The relay delivers events here (Shortwork/docs/notifications.md §5; AGENTS.md §3.2–§3.5).
// It mirrors the kit's createEventReceiver, except for step 4: the kit applies events inside a
// MongoDB transaction, and auth's effect is one document whose _id is the eventId, which is
// atomic on its own (a standalone Mongo included).

interface DeliveryVerifierLike {
  verify(signature: string | undefined, body: Uint8Array, ids: { eventId: string; deliveryId: string }): Promise<void>;
}

export interface NotificationReceiverOptions {
  /** Auth's own token verifier; null while RS256 isn't configured. */
  readonly tokens: () => Promise<TokenVerifier> | null;
  /** The relay's delivery-signature verifier; null while RELAY_JWKS_URL isn't set. */
  readonly deliveries: DeliveryVerifierLike | null;
  /** Web Push to the person's devices; null while VAPID isn't configured. */
  readonly push?: PushSender | null;
}

export type ApplyOutcome = "applied" | "duplicate" | "stale" | "ignored";

export interface ApplyResult {
  outcome: ApplyOutcome;
  personId: string | null;
  /** Stored already read: an event that arrived long after it happened (a backfill, a late replay). */
  history: boolean;
  /** What to alert the person's devices with: only for an applied notice that is news. */
  push: PushMessage | null;
}

/**
 * An event this much older than its arrival is history: it goes in the inbox already read and
 * never alerts a device. Live deliveries arrive within seconds; this is a relay backfill or a
 * replay of a delivery that died days ago (docs/notifications.md §7).
 */
export const HISTORY_AFTER_MS = 24 * 60 * 60 * 1000;

export const isHistory = (event: EventEnvelope, now: Date): boolean =>
  now.getTime() - Date.parse(event.occurredAt) > HISTORY_AFTER_MS;

const log = (level: "info" | "warn" | "error", fields: Record<string, unknown>): void => {
  // eventId, type, personId and outcome only: never a title, a body or the event data (§6.3).
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), level, svc: "auth", event: "notification_event", ...fields })}\n`);
};

/**
 * Stores the notification an event makes, exactly once:
 * - a repeated eventId is found, or hits the unique _id, and is a duplicate;
 * - a seq at or below the subject's last applied one is stale and stores nothing;
 * - an event with no notification (no person, not announced) is ignored.
 * The cursor moves after the insert, so a crash in between can only let an older event in later.
 * A collapsing notice (chat) is applied by applyCollapsed instead.
 */
export const applyNotification = async (event: EventEnvelope, now: Date = new Date()): Promise<ApplyResult> => {
  const notification = composeNotification(event);
  if (!notification) return { outcome: "ignored", personId: null, history: false, push: null };
  const history = isHistory(event, now);
  if (notification.collapse) return applyCollapsed(event, notification, notification.collapse, history, now);

  const result = (outcome: ApplyOutcome, push: PushMessage | null = null): ApplyResult => ({
    outcome,
    personId: notification.personId,
    history,
    push,
  });

  if (await NotificationModel.exists({ _id: event.eventId })) return result("duplicate");

  const key = subjectKey(event.source, event.subject);
  const cursor = await NotificationCursorModel.findById(key).lean();
  if (cursor && event.seq <= cursor.seq) return result("stale");

  try {
    await NotificationModel.create({
      _id: event.eventId,
      personId: notification.personId,
      category: notification.category,
      app: notification.app,
      title: notification.title,
      body: notification.body,
      source: event.source,
      sourceType: event.type,
      sourceSeq: event.seq,
      subjectKey: key,
      occurredAt: new Date(event.occurredAt),
      asOf: now,
      readAt: history ? now : null,
      createdAt: now,
    });
  } catch (error) {
    if (isDuplicateKey(error)) return result("duplicate");
    throw error;
  }

  const advance = () =>
    NotificationCursorModel.updateOne({ _id: key }, { $max: { seq: event.seq }, $set: { updatedAt: now } }, { upsert: true });
  try {
    await advance();
  } catch (error) {
    // Two first events for one subject can race to create its cursor; the loser just updates it.
    if (!isDuplicateKey(error)) throw error;
    await advance();
  }
  const push = history
    ? null
    : { id: event.eventId, title: notification.title, body: notification.body, app: notification.app, tag: event.eventId };
  return result("applied", push);
};

/**
 * One notice per recipient and conversation. A single update, guarded by `lastSeq < seq`, either
 * moves the notice forward or matches nothing; matching nothing makes the upsert insert a second
 * document with the same _id, which the unique index refuses, so a repeat or an older message
 * changes nothing (AGENTS.md §3.8: the database enforces it, not a read-then-write).
 * Each new message makes the notice unread again; its count starts over once it has been read.
 */
const applyCollapsed = async (
  event: EventEnvelope,
  notification: NotificationDraft,
  rule: CollapseRule,
  history: boolean,
  now: Date
): Promise<ApplyResult> => {
  const literal = (value: string) => ({ $literal: value });
  let stored: { title?: unknown; body?: unknown } | null;
  try {
    stored = (await NotificationModel.collection.findOneAndUpdate(
      { _id: rule.id, lastSeq: { $lt: rule.seq } } as never,
      [
        {
          $set: {
            count: {
              $cond: [{ $eq: [{ $ifNull: ["$readAt", null] }, null] }, { $add: [{ $ifNull: ["$count", 0] }, 1] }, 1],
            },
          },
        },
        {
          $set: {
            personId: literal(notification.personId),
            category: literal(notification.category),
            app: literal(notification.app),
            title: literal(notification.title),
            body: {
              $cond: [
                { $eq: ["$count", 1] },
                literal(notification.body),
                { $concat: [{ $toString: "$count" }, literal(rule.manySuffix)] },
              ],
            },
            source: literal(event.source),
            sourceType: literal(event.type),
            sourceSeq: event.seq,
            subjectKey: literal(subjectKey(event.source, event.subject)),
            occurredAt: new Date(event.occurredAt),
            asOf: now,
            readAt: history ? now : null,
            // The retention clock counts from the latest message.
            createdAt: now,
            lastSeq: rule.seq,
          },
        },
      ],
      { upsert: true, returnDocument: "after" }
    )) as { title?: unknown; body?: unknown } | null;
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    const existing = await NotificationModel.findById(rule.id).select({ lastSeq: 1 }).lean();
    return {
      outcome: existing?.lastSeq === rule.seq ? "duplicate" : "stale",
      personId: notification.personId,
      history,
      push: null,
    };
  }
  const push =
    history || !stored
      ? null
      : { id: rule.id, title: String(stored.title), body: String(stored.body), app: notification.app, tag: rule.tag };
  return { outcome: "applied", personId: notification.personId, history, push };
};

const header = (req: Request, name: string): string | undefined => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

/**
 * Status codes the relay acts on:
 * 200 applied / duplicate / stale / ignored / dead_lettered — handled, stop
 * 401 bad token or signature — the relay alerts; never retried blindly
 * 500 database error — the relay retries with backoff
 * 503 not configured yet
 */
export const createNotificationReceiver = (options: NotificationReceiverOptions) => {
  return async (req: Request, res: Response): Promise<void> => {
    const pending = options.tokens();
    if (!pending || !options.deliveries) {
      res.status(503).json({ message: "event delivery is not configured" });
      return;
    }

    // 1. Service token: only the relay holds events:deliver for auth.
    try {
      const caller = await (await pending).verifyServiceToken(bearerToken(header(req, "authorization")), {
        audience: "auth",
        scope: "events:deliver",
      });
      req.service = caller;
      req.caller = { type: "service", id: caller.service };
    } catch {
      res.status(401).json({ message: "unauthorized" });
      return;
    }

    const body: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const eventId = header(req, EVENT_ID_HEADER) ?? "";
    const deliveryId = header(req, DELIVERY_ID_HEADER) ?? "";

    // 2. Signature over the exact bytes.
    try {
      await options.deliveries.verify(header(req, SIGNATURE_HEADER), body, { eventId, deliveryId });
    } catch (error) {
      const code = error instanceof DeliveryError ? error.code : "invalid";
      res.status(401).json({ message: "bad delivery signature", code });
      return;
    }

    // 3. Contract. A poison message is dead-lettered and acknowledged: retrying can never help.
    let event: EventEnvelope;
    try {
      event = parseEvent(JSON.parse(body.toString("utf8")));
    } catch (error) {
      const reason = error instanceof EventValidationError ? error.reason : "unparseable";
      await NotificationDeadLetterModel.create({
        _id: eventId || `malformed-${deliveryId}`,
        reason,
        message: (error as Error).message.slice(0, 500),
        body: body.toString("utf8").slice(0, 10_000),
        deadLetteredAt: new Date(),
      }).catch(() => undefined);
      log("warn", { eventId: eventId || null, outcome: "dead_lettered", reason });
      res.status(200).json({ status: "dead_lettered" });
      return;
    }

    // 4. Apply exactly once.
    let result: ApplyResult;
    try {
      result = await applyNotification(event);
    } catch (error) {
      log("error", { eventId: event.eventId, type: event.type, outcome: "failed", message: (error as Error).message });
      res.status(500).json({ message: "could not apply event" });
      return;
    }
    log("info", { eventId: event.eventId, type: event.type, personId: result.personId, outcome: result.outcome, history: result.history });
    res.status(200).json({ status: result.outcome });

    // 5. Alert the person's devices once the relay has its answer: a slow push service never
    // holds up a delivery, and a failed alert never undoes the stored notice.
    if (result.push && result.personId && options.push) {
      options.push.send(result.personId, result.push).catch((error: unknown) => {
        log("error", { eventId: event.eventId, outcome: "push_failed", message: (error as Error).message });
      });
    }
  };
};
