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
import { composeNotification } from "./compose.js";
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
}

export type ApplyOutcome = "applied" | "duplicate" | "stale" | "ignored";

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
 */
export const applyNotification = async (event: EventEnvelope, now: Date = new Date()): Promise<ApplyOutcome> => {
  const notification = composeNotification(event);
  if (!notification) return "ignored";

  if (await NotificationModel.exists({ _id: event.eventId })) return "duplicate";

  const key = subjectKey(event.source, event.subject);
  const cursor = await NotificationCursorModel.findById(key).lean();
  if (cursor && event.seq <= cursor.seq) return "stale";

  try {
    await NotificationModel.create({
      _id: event.eventId,
      ...notification,
      source: event.source,
      sourceType: event.type,
      sourceSeq: event.seq,
      subjectKey: key,
      occurredAt: new Date(event.occurredAt),
      asOf: now,
      readAt: null,
      createdAt: now,
    });
  } catch (error) {
    if (isDuplicateKey(error)) return "duplicate";
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
  return "applied";
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
    try {
      const outcome = await applyNotification(event);
      const personId = composeNotification(event)?.personId ?? null;
      log("info", { eventId: event.eventId, type: event.type, personId, outcome });
      res.status(200).json({ status: outcome });
    } catch (error) {
      log("error", { eventId: event.eventId, type: event.type, outcome: "failed", message: (error as Error).message });
      res.status(500).json({ message: "could not apply event" });
    }
  };
};
