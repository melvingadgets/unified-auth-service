import { createPublicKey, randomUUID } from "crypto";
import express from "express";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createDeliverySigner,
  createDeliveryVerifier,
  createEvent,
  easybuyPaymentApproved,
  easybuyRequestApproved,
  easybuyRequestSubmitted,
  generateSigningKey,
  resellerChatMessagePosted,
  storeOrderCompleted,
  type EventEnvelope,
} from "@melvingadgets/platform-kit";
import { TEST_CLIENT_SECRETS } from "./setup-env.js";

// In-app notifications end to end inside auth (Shortwork/docs/notifications.md): relay-signed
// deliveries into /internal/events, then the person's own inbox API. Real Express app, real
// MongoDB (the throwaway test database), real RS256 tokens from auth's /oauth/token and real
// delivery signatures; nothing under test is mocked.

let app: express.Application;
let UserModel: typeof import("../Model/UserModel.js").default;
let hashPassword: typeof import("../Utils/authHelpers.js").hashPassword;
let models: typeof import("../Notifications/model.js");

const relayKey = generateSigningKey("relay-test");
const strangerKey = generateSigningKey("not-the-relay");
const relaySigner = createDeliverySigner(relayKey);
const strangerSigner = createDeliverySigner(strangerKey);
const publicJwk = (key: { kid: string; privateKeyPem: string }) => ({
  ...createPublicKey(key.privateKeyPem).export({ format: "jwk" }),
  kid: key.kid,
  alg: "RS256",
  use: "sig",
});

const PASSWORD = "correct horse battery";
let ada: { id: string; token: string };
let bola: { id: string; token: string };

const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;

const serviceToken = async (client: keyof typeof TEST_CLIENT_SECRETS, audience: string, scope: string) => {
  const res = await request(app)
    .post("/oauth/token")
    .set("authorization", basic(`svc-${client}`, TEST_CLIENT_SECRETS[client]))
    .type("form")
    .send({ grant_type: "client_credentials", audience, scope });
  expect(res.status).toBe(200);
  return res.body.access_token as string;
};

const signUpAndLogin = async (email: string) => {
  const user = await UserModel.create({
    fullName: "Test Person",
    email,
    role: "User",
    emailVerified: true,
    disabled: false,
    password: await hashPassword(PASSWORD),
  });
  const res = await request(app).post("/api/v1/auth/login").send({ identifier: email, password: PASSWORD });
  expect(res.status).toBe(201);
  return { id: String(user._id), token: res.body.accessToken as string };
};

interface DeliverOptions {
  signer?: typeof relaySigner;
  token?: string | null;
  tamper?: (body: string) => string;
}

const deliver = async (event: unknown, options: DeliverOptions = {}) => {
  const body = JSON.stringify(event);
  const eventId = (event as { eventId?: string }).eventId ?? "";
  const deliveryId = randomUUID();
  const signature = await (options.signer ?? relaySigner).sign(body, { eventId, deliveryId });
  const token = options.token === undefined ? await serviceToken("relay", "auth", "events:deliver") : options.token;
  const req = request(app)
    .post("/internal/events")
    .set("content-type", "application/json")
    .set("melvin-signature", signature)
    .set("melvin-delivery-id", deliveryId)
    .set("melvin-event-id", eventId);
  if (token) req.set("authorization", `Bearer ${token}`);
  return req.send(options.tamper ? options.tamper(body) : body);
};

const payment = (personId: string | null, amountKobo: number, seq = 1, receiptId = `rcpt-${randomUUID().slice(0, 8)}`) =>
  createEvent(easybuyPaymentApproved, {
    subject: { kind: "receipt", id: receiptId, ...(personId ? { personId } : {}) },
    seq,
    traceId: "trace-notifications",
    data: {
      receiptId,
      personId,
      itemId: "item-1",
      amountKobo,
      plan: "Weekly",
      method: "bank_transfer",
      approvedAt: "2026-11-01T09:00:00.000+01:00",
    },
  });

const requestEvent = (definition: typeof easybuyRequestSubmitted | typeof easybuyRequestApproved, personId: string, requestId: string, seq: number) =>
  definition === easybuyRequestSubmitted
    ? createEvent(easybuyRequestSubmitted, {
        subject: { kind: "request", id: requestId, personId },
        seq,
        traceId: "trace-notifications",
        data: { requestId, personId, provider: "Apple", model: "iPhone 15", capacity: "128GB", plan: "Monthly" },
      })
    : createEvent(easybuyRequestApproved, {
        subject: { kind: "request", id: requestId, personId },
        seq,
        traceId: "trace-notifications",
        data: { requestId, personId },
      });

const chat = (from: "customer" | "reseller", recipientPersonId: string, conversationId: string, seq: number) =>
  createEvent(resellerChatMessagePosted, {
    subject: { kind: "conversation", id: conversationId },
    seq,
    traceId: "trace-notifications",
    data: { conversationId, seq, from, recipientPersonId },
  });

const inbox = (token: string) => request(app).get("/api/v1/auth/me/notifications").set("authorization", `Bearer ${token}`);
const summary = (token: string) => request(app).get("/api/v1/auth/me/notifications/summary").set("authorization", `Bearer ${token}`);
const markRead = (token: string, body: unknown) =>
  request(app).post("/api/v1/auth/me/notifications/read").set("authorization", `Bearer ${token}`).send(body as object);

beforeAll(async () => {
  const db = await import("../Database/Database.js");
  await db.default;
  const { MainApp } = await import("../MainApp.js");
  UserModel = (await import("../Model/UserModel.js")).default;
  hashPassword = (await import("../Utils/authHelpers.js")).hashPassword;
  models = await import("../Notifications/model.js");
  await Promise.all([
    UserModel.syncIndexes(),
    models.NotificationModel.syncIndexes(),
    models.NotificationCursorModel.syncIndexes(),
    models.NotificationDeadLetterModel.syncIndexes(),
  ]);

  app = express();
  MainApp(app, { notificationDeliveries: createDeliveryVerifier({ jwks: { keys: [publicJwk(relayKey)] } }) });

  ada = await signUpAndLogin(`ada-${randomUUID().slice(0, 6)}@example.com`);
  bola = await signUpAndLogin(`bola-${randomUUID().slice(0, 6)}@example.com`);
});

beforeEach(async () => {
  await Promise.all([
    models.NotificationModel.deleteMany({}),
    models.NotificationCursorModel.deleteMany({}),
    models.NotificationDeadLetterModel.deleteMany({}),
  ]);
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

describe("POST /internal/events (relay deliveries)", () => {
  it("stores one notification for the person in the event, with its source and seq", async () => {
    const event = payment(ada.id, 2_500_000);
    const res = await deliver(event);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "applied" });

    const stored = await models.NotificationModel.findById(event.eventId).lean();
    expect(stored).toMatchObject({
      personId: ada.id,
      app: "Easybuy Portal",
      title: "Payment confirmed",
      body: "We received your EasyBuy payment of ₦25,000. Thank you.",
      source: "easybuy",
      sourceType: "easybuy.payment.approved",
      sourceSeq: 1,
      readAt: null,
    });
  });

  it("acknowledges a repeated delivery of the same event without storing it twice", async () => {
    const event = payment(ada.id, 1_000_000);
    expect((await deliver(event)).body.status).toBe("applied");
    const again = await deliver(event);
    expect(again.status).toBe(200);
    expect(again.body.status).toBe("duplicate");
    expect(await models.NotificationModel.countDocuments({ personId: ada.id })).toBe(1);
  });

  it("skips an event older than one already applied for the same subject (§3.3)", async () => {
    const approved = requestEvent(easybuyRequestApproved, ada.id, "req-ordered", 2);
    const submittedLate = requestEvent(easybuyRequestSubmitted, ada.id, "req-ordered", 1);
    expect((await deliver(approved)).body.status).toBe("applied");
    const late = await deliver(submittedLate);
    expect(late.status).toBe(200);
    expect(late.body.status).toBe("stale");
    const titles = (await models.NotificationModel.find({ personId: ada.id }).lean()).map((n) => n.title);
    expect(titles).toEqual(["Application approved"]);
  });

  it("acknowledges an event with no platform person and stores nothing", async () => {
    const res = await deliver(payment(null, 500_000));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ignored");
    expect(await models.NotificationModel.countDocuments({})).toBe(0);
  });

  it("rejects a delivery signed by anyone but the relay", async () => {
    const res = await deliver(payment(ada.id, 500_000), { signer: strangerSigner });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("invalid");
    expect(await models.NotificationModel.countDocuments({})).toBe(0);
  });

  it("rejects a body changed after it was signed", async () => {
    const res = await deliver(payment(ada.id, 500_000), { tamper: (body) => body.replace("500000", "50000000") });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("body_mismatch");
    expect(await models.NotificationModel.countDocuments({})).toBe(0);
  });

  it("rejects a delivery with no service token, or a token without events:deliver for auth", async () => {
    expect((await deliver(payment(ada.id, 500_000), { token: null })).status).toBe(401);
    const lookupToken = await serviceToken("store", "auth", "auth:people.read");
    expect((await deliver(payment(ada.id, 500_000), { token: lookupToken })).status).toBe(401);
    expect(await models.NotificationModel.countDocuments({})).toBe(0);
  });

  it("dead-letters a signed but invalid event and acknowledges it, so the relay stops retrying", async () => {
    const event = payment(ada.id, 500_000) as EventEnvelope;
    const poison = { ...event, data: { ...(event.data as object), amountKobo: 12.5 } };
    const res = await deliver(poison);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("dead_lettered");
    const letter = await models.NotificationDeadLetterModel.findById(event.eventId).lean();
    expect(letter?.reason).toBe("invalid_data");
    expect(await models.NotificationModel.countDocuments({})).toBe(0);
  });
});

describe("/api/v1/auth/me/notifications", () => {
  it("lists only the caller's notifications, newest first, with an unread count", async () => {
    await deliver(payment(ada.id, 100_000));
    await deliver(createEvent(storeOrderCompleted, {
      subject: { kind: "order", id: "ord-9", personId: ada.id },
      seq: 1,
      traceId: "trace-notifications",
      occurredAt: new Date(Date.now() + 1000).toISOString(),
      data: { orderId: "ord-9", personId: ada.id, serviceFeeKobo: 0 },
    }));
    await deliver(payment(bola.id, 200_000));

    const res = await inbox(ada.token);
    expect(res.status).toBe(200);
    expect(res.body.unread).toBe(2);
    expect(res.body.notifications.map((n: { title: string }) => n.title)).toEqual(["Order delivered", "Payment confirmed"]);
    expect(res.body.notifications[0]).not.toHaveProperty("personId");

    const other = await inbox(bola.token);
    expect(other.body.notifications.map((n: { title: string }) => n.title)).toEqual(["Payment confirmed"]);
  });

  it("pages with a cursor and never repeats or skips a notification", async () => {
    const base = Date.parse("2026-11-01T09:00:00.000Z");
    for (let i = 0; i < 5; i += 1) {
      const event = payment(ada.id, 100_000 + i);
      // Two share a timestamp, so the cursor has to break the tie by id.
      await deliver({ ...event, occurredAt: new Date(base + Math.min(i, 3) * 1000).toISOString() });
    }
    const first = await request(app).get("/api/v1/auth/me/notifications?limit=2").set("authorization", `Bearer ${ada.token}`);
    const second = await request(app)
      .get(`/api/v1/auth/me/notifications?limit=2&before=${encodeURIComponent(first.body.nextBefore)}`)
      .set("authorization", `Bearer ${ada.token}`);
    const third = await request(app)
      .get(`/api/v1/auth/me/notifications?limit=2&before=${encodeURIComponent(second.body.nextBefore)}`)
      .set("authorization", `Bearer ${ada.token}`);
    const ids = [...first.body.notifications, ...second.body.notifications, ...third.body.notifications].map((n: { id: string }) => n.id);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
    expect(third.body.nextBefore).toBeNull();
  });

  it("counts unread per app for badges, and marks read by app, by id, or all", async () => {
    await deliver(payment(ada.id, 100_000));
    await deliver(payment(ada.id, 150_000));
    await deliver(requestEvent(easybuyRequestApproved, ada.id, "req-badge", 1));

    expect((await summary(ada.token)).body).toEqual({ unread: 3, byApp: { "Easybuy Portal": 2, Profile: 1 } });

    const afterApp = await markRead(ada.token, { app: "Easybuy Portal" });
    expect(afterApp.status).toBe(200);
    expect(afterApp.body).toEqual({ unread: 1, byApp: { Profile: 1 } });

    const [profileNotice] = (await inbox(ada.token)).body.notifications.filter((n: { app: string }) => n.app === "Profile");
    expect((await markRead(ada.token, { ids: [profileNotice.id] })).body).toEqual({ unread: 0, byApp: {} });

    // Repeating a read changes nothing (idempotent without a key).
    const readAt = (await models.NotificationModel.findById(profileNotice.id).lean())?.readAt;
    await markRead(ada.token, { ids: [profileNotice.id] });
    expect((await models.NotificationModel.findById(profileNotice.id).lean())?.readAt).toEqual(readAt);

    await deliver(payment(ada.id, 175_000));
    expect((await markRead(ada.token, { all: true })).body).toEqual({ unread: 0, byApp: {} });
  });

  it("cannot read or mark another person's notification, and says nothing about it", async () => {
    const event = payment(ada.id, 100_000);
    await deliver(event);
    const res = await markRead(bola.token, { ids: [event.eventId] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ unread: 0, byApp: {} });
    expect((await models.NotificationModel.findById(event.eventId).lean())?.readAt).toBeNull();
    expect((await summary(ada.token)).body.unread).toBe(1);
  });

  it("requires a signed-in person and rejects malformed requests", async () => {
    expect((await request(app).get("/api/v1/auth/me/notifications")).status).toBe(401);
    expect((await request(app).post("/api/v1/auth/me/notifications/read").send({ all: true })).status).toBe(401);
    expect((await markRead(ada.token, {})).status).toBe(400);
    expect((await markRead(ada.token, { all: true, app: "Profile" })).status).toBe(400);
    expect((await markRead(ada.token, { app: "Settings" })).status).toBe(400);
    expect((await markRead(ada.token, { ids: [] })).status).toBe(400);
    expect((await request(app).get("/api/v1/auth/me/notifications?limit=500").set("authorization", `Bearer ${ada.token}`)).status).toBe(400);
    expect((await request(app).get("/api/v1/auth/me/notifications?before=nonsense").set("authorization", `Bearer ${ada.token}`)).status).toBe(400);
  });
});

describe("history (an event that arrives long after it happened)", () => {
  it("stores it already read, so it is listed but never counted", async () => {
    const late = { ...payment(ada.id, 300_000), occurredAt: new Date(Date.now() - 3 * 86_400_000).toISOString() };
    const res = await deliver(late);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("applied");

    const stored = await models.NotificationModel.findById(late.eventId).lean();
    expect(stored?.readAt).toBeInstanceOf(Date);
    expect((await summary(ada.token)).body).toEqual({ unread: 0, byApp: {} });
    expect((await inbox(ada.token)).body.notifications.map((n: { id: string }) => n.id)).toEqual([late.eventId]);

    // News still counts.
    await deliver(payment(ada.id, 400_000));
    expect((await summary(ada.token)).body).toEqual({ unread: 1, byApp: { "Easybuy Portal": 1 } });
  });
});

describe("chat notices (one per conversation)", () => {
  const conversation = () => `conv-${randomUUID().slice(0, 8)}`;

  it("collapses a conversation's messages into one unread notice that counts them", async () => {
    const conv = conversation();
    expect((await deliver(chat("reseller", ada.id, conv, 1))).body.status).toBe("applied");
    expect((await deliver(chat("reseller", ada.id, conv, 2))).body.status).toBe("applied");

    const { notifications } = (await inbox(ada.token)).body;
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      id: `chat:${ada.id}:${conv}`,
      app: "Chat",
      category: "reseller.chat",
      title: "New message",
      body: "2 new messages from your reseller.",
      readAt: null,
    });
    expect((await summary(ada.token)).body).toEqual({ unread: 1, byApp: { Chat: 1 } });
    expect(await models.NotificationModel.countDocuments({ personId: bola.id })).toBe(0);
  });

  it("ignores a repeated or an older message, and starts counting again once read", async () => {
    const conv = conversation();
    const first = chat("reseller", ada.id, conv, 1);
    const second = chat("reseller", ada.id, conv, 2);
    await deliver(first);
    await deliver(second);
    expect((await deliver(second)).body.status).toBe("duplicate");
    expect((await deliver(first)).body.status).toBe("stale");
    const id = `chat:${ada.id}:${conv}`;
    expect(await models.NotificationModel.findById(id).lean()).toMatchObject({ count: 2, lastSeq: 2 });

    await markRead(ada.token, { app: "Chat" });
    expect((await deliver(chat("reseller", ada.id, conv, 3))).body.status).toBe("applied");
    const after = await models.NotificationModel.findById(id).lean();
    expect(after).toMatchObject({ count: 1, lastSeq: 3, body: "Your reseller replied.", readAt: null });
    expect((await summary(ada.token)).body).toEqual({ unread: 1, byApp: { Chat: 1 } });
  });

  it("applies one message once even when two deliveries of it race", async () => {
    const conv = conversation();
    await deliver(chat("reseller", ada.id, conv, 1));
    const second = chat("reseller", ada.id, conv, 2);
    const results = await Promise.all([deliver(second), deliver(second), deliver(second)]);
    expect(results.map((res) => res.status)).toEqual([200, 200, 200]);
    expect(results.map((res) => res.body.status).sort()).toEqual(["applied", "duplicate", "duplicate"]);
    expect(await models.NotificationModel.findById(`chat:${ada.id}:${conv}`).lean()).toMatchObject({ count: 2, lastSeq: 2 });
  });

  it("tells the reseller about a customer's message in the Reseller app, apart from the customer's own notice", async () => {
    const conv = conversation();
    await deliver(chat("reseller", ada.id, conv, 1));
    await deliver(chat("customer", bola.id, conv, 2));

    const resellerSide = (await inbox(bola.token)).body.notifications;
    expect(resellerSide).toHaveLength(1);
    expect(resellerSide[0]).toMatchObject({
      id: `chat:${bola.id}:${conv}`,
      app: "Reseller",
      title: "New message from a customer",
      body: "A customer sent you a message. Open Chats to reply.",
    });
    // The customer's notice is untouched by the other side's message.
    expect((await inbox(ada.token)).body.notifications[0]).toMatchObject({ body: "Your reseller replied." });
  });
});
