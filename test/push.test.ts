import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, randomUUID, type ECDH } from "crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "http";
import type { AddressInfo } from "net";
import express from "express";
import { importJWK, jwtVerify } from "jose";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createDeliverySigner,
  createDeliveryVerifier,
  createEvent,
  easybuyPaymentApproved,
  easybuyRepaymentDue,
  generateSigningKey,
  resellerChatMessagePosted,
} from "@melvingadgets/platform-kit";
import { DEFAULT_PUSH_HOSTS, isAllowedPushEndpoint, parseSubscription, PushInputError } from "../Push/endpoint.js";
import { TEST_CLIENT_SECRETS } from "./setup-env.js";

// Web Push from auth (Shortwork/docs/notifications.md §8). A local HTTP server stands in for the
// browsers' push services, and each "device" is a real P-256 key pair plus auth secret, so every
// alert auth sends is decrypted here exactly as a browser would (RFC 8291, aes128gcm) and its
// VAPID signature is checked against auth's public key. Nothing under test is mocked.

// ---- The push service and the devices ---------------------------------------------------------

interface PushHit {
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

const hits: PushHit[] = [];
/** Path → the status the push service answers (201 when unset). */
const answers = new Map<string, number>();
let pushServer: Server;
let pushOrigin = "";

interface Device {
  ecdh: ECDH;
  auth: Buffer;
  path: string;
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
}

const newDevice = (): Device => {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  const path = `/push/${randomUUID()}`;
  return {
    ecdh,
    auth,
    path,
    subscription: {
      endpoint: `${pushOrigin}${path}`,
      keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: auth.toString("base64url") },
    },
  };
};

/** What the browser does with an aes128gcm push body (RFC 8188 §2, RFC 8291 §3.4). */
const decrypt = (device: Device, body: Buffer): unknown => {
  const salt = body.subarray(0, 16);
  const recordSize = body.readUInt32BE(16);
  const keyIdLength = body[20];
  const serverPublic = body.subarray(21, 21 + keyIdLength);
  const ciphertext = body.subarray(21 + keyIdLength);
  expect(ciphertext.length).toBeLessThanOrEqual(recordSize);

  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), device.ecdh.getPublicKey(), serverPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", device.ecdh.computeSecret(serverPublic), device.auth, keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  // A single record: the plaintext, the last-record delimiter 0x02, then zero padding.
  let end = padded.length - 1;
  while (end > 0 && padded[end] === 0) end -= 1;
  expect(padded[end]).toBe(2);
  return JSON.parse(padded.subarray(0, end).toString("utf8"));
};

/** The VAPID header must be signed by auth's key, for this push service, by this sender. */
const expectVapid = async (hit: PushHit) => {
  const match = /^vapid t=([^,]+), k=(.+)$/.exec(String(hit.headers.authorization));
  expect(match).not.toBeNull();
  const [, token, publicKey] = match!;
  expect(publicKey).toBe(process.env.VAPID_PUBLIC_KEY);
  const raw = Buffer.from(publicKey, "base64url");
  const key = await importJWK(
    { kty: "EC", crv: "P-256", x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33).toString("base64url") },
    "ES256"
  );
  const { payload } = await jwtVerify(token, key, { audience: pushOrigin });
  expect(payload.sub).toBe("mailto:alerts@example.com");
};

const hitsFor = (device: Device) => hits.filter((hit) => hit.path === device.path);

const waitForHits = async (device: Device, count: number) => {
  const deadline = Date.now() + 5_000;
  while (hitsFor(device).length < count) {
    if (Date.now() > deadline) throw new Error(`expected ${count} pushes, saw ${hitsFor(device).length}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return hitsFor(device);
};

/** For "nothing was sent": give a stray push time to arrive before saying it didn't. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

// ---- Auth, people and relay deliveries ---------------------------------------------------------

let app: express.Application;
let UserModel: typeof import("../Model/UserModel.js").default;
let hashPassword: typeof import("../Utils/authHelpers.js").hashPassword;
let PushSubscriptionModel: typeof import("../Push/model.js").PushSubscriptionModel;
let models: typeof import("../Notifications/model.js");

const relayKey = generateSigningKey("relay-push-test");
const relaySigner = createDeliverySigner(relayKey);
const PASSWORD = "correct horse battery";
let ada: { id: string; token: string };
let bola: { id: string; token: string };
let chidi: { id: string; token: string };

const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;

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

const deliver = async (event: { eventId: string }) => {
  const tokenRes = await request(app)
    .post("/oauth/token")
    .set("authorization", basic("svc-relay", TEST_CLIENT_SECRETS.relay))
    .type("form")
    .send({ grant_type: "client_credentials", audience: "auth", scope: "events:deliver" });
  const body = JSON.stringify(event);
  const deliveryId = randomUUID();
  return request(app)
    .post("/internal/events")
    .set("content-type", "application/json")
    .set("authorization", `Bearer ${tokenRes.body.access_token}`)
    .set("melvin-signature", await relaySigner.sign(body, { eventId: event.eventId, deliveryId }))
    .set("melvin-delivery-id", deliveryId)
    .set("melvin-event-id", event.eventId)
    .send(body);
};

const payment = (personId: string, amountKobo: number) => {
  const receiptId = `rcpt-${randomUUID().slice(0, 8)}`;
  return createEvent(easybuyPaymentApproved, {
    subject: { kind: "receipt", id: receiptId, personId },
    seq: 1,
    traceId: "trace-push",
    data: { receiptId, personId, itemId: null, amountKobo, plan: "Monthly", method: "bank_transfer", approvedAt: "2026-11-01T09:00:00.000Z" },
  });
};

const chat = (recipientPersonId: string, conversationId: string, seq: number) =>
  createEvent(resellerChatMessagePosted, {
    subject: { kind: "conversation", id: conversationId },
    seq,
    traceId: "trace-push",
    data: { conversationId, seq, from: "reseller", recipientPersonId },
  });

const subscribe = (token: string, body: unknown) =>
  request(app).put("/api/v1/auth/me/push/subscription").set("authorization", `Bearer ${token}`).send(body as object);
const unsubscribe = (token: string, endpoint: string) =>
  request(app).delete("/api/v1/auth/me/push/subscription").set("authorization", `Bearer ${token}`).send({ endpoint });
const testAlert = (token: string) => request(app).post("/api/v1/auth/me/push/test").set("authorization", `Bearer ${token}`);

beforeAll(async () => {
  pushServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const path = String(req.url);
      hits.push({ path, headers: req.headers, body: Buffer.concat(chunks) });
      res.statusCode = answers.get(path) ?? 201;
      res.end();
    });
  });
  await new Promise<void>((resolve) => pushServer.listen(0, "127.0.0.1", resolve));
  pushOrigin = `http://127.0.0.1:${(pushServer.address() as AddressInfo).port}`;

  const db = await import("../Database/Database.js");
  await db.default;
  const { MainApp } = await import("../MainApp.js");
  UserModel = (await import("../Model/UserModel.js")).default;
  hashPassword = (await import("../Utils/authHelpers.js")).hashPassword;
  PushSubscriptionModel = (await import("../Push/model.js")).PushSubscriptionModel;
  models = await import("../Notifications/model.js");
  await Promise.all([UserModel.syncIndexes(), PushSubscriptionModel.syncIndexes(), models.NotificationModel.syncIndexes()]);

  const relayJwk = { ...createPublicKey(relayKey.privateKeyPem).export({ format: "jwk" }), kid: relayKey.kid, alg: "RS256", use: "sig" };
  app = express();
  // The sender is the real one MainApp builds from VAPID_* (set in setup-env.ts).
  MainApp(app, { notificationDeliveries: createDeliveryVerifier({ jwks: { keys: [relayJwk] } }) });

  ada = await signUpAndLogin(`ada-push-${randomUUID().slice(0, 6)}@example.com`);
  bola = await signUpAndLogin(`bola-push-${randomUUID().slice(0, 6)}@example.com`);
  chidi = await signUpAndLogin(`chidi-push-${randomUUID().slice(0, 6)}@example.com`);
});

beforeEach(async () => {
  hits.length = 0;
  answers.clear();
  await Promise.all([PushSubscriptionModel.deleteMany({}), models.NotificationModel.deleteMany({}), models.NotificationCursorModel.deleteMany({})]);
});

afterAll(async () => {
  await new Promise((resolve) => pushServer.close(resolve));
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

// ---- Tests -------------------------------------------------------------------------------------

describe("which push endpoints auth will call", () => {
  it("accepts the browsers' own push services over https", () => {
    for (const endpoint of [
      "https://fcm.googleapis.com/fcm/send/abc:def",
      "https://updates.push.services.mozilla.com/wpush/v2/gAAAA",
      "https://web.push.apple.com/QGuQyavXutnMH",
      "https://wns2-par02p.notify.windows.com/w/?token=BQYAAA",
    ]) {
      expect(isAllowedPushEndpoint(endpoint)).toBe(true);
    }
    expect(DEFAULT_PUSH_HOSTS).toHaveLength(4);
  });

  it("refuses everything else, including internal addresses and look-alike hosts", () => {
    for (const endpoint of [
      "http://fcm.googleapis.com/fcm/send/abc",
      "https://fcm.googleapis.com:8443/fcm/send/abc",
      "https://user:pw@fcm.googleapis.com/fcm/send/abc",
      "https://fcm.googleapis.com.evil.example/x",
      "https://push.apple.com.evil.example/x",
      "https://notify.windows.com.evil.example/x",
      "https://evil.example/fcm.googleapis.com",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.5/internal",
      "http://unified-auth.railway.internal:8080/internal/events",
      "https://localhost/x",
      "http://127.0.0.1:9/x",
      "ftp://fcm.googleapis.com/x",
      `https://fcm.googleapis.com/${"a".repeat(2100)}`,
      "not a url",
      42,
    ]) {
      expect(isAllowedPushEndpoint(endpoint)).toBe(false);
    }
    // Plain http only to a loopback host the environment names.
    expect(isAllowedPushEndpoint("http://127.0.0.1:9/x", ["127.0.0.1"])).toBe(true);
    expect(isAllowedPushEndpoint("http://10.0.0.5/x", ["10.0.0.5"])).toBe(false);
  });

  it("checks the subscription keys a browser sends", () => {
    const device = newDevice();
    const good = { endpoint: "https://fcm.googleapis.com/fcm/send/x", keys: device.subscription.keys };
    expect(parseSubscription(good)).toEqual(good);
    const compressed = Buffer.alloc(33, 2).toString("base64url");
    for (const keys of [
      { ...good.keys, p256dh: compressed },
      { ...good.keys, p256dh: "not base64!" },
      { ...good.keys, auth: randomBytes(15).toString("base64url") },
      { p256dh: good.keys.p256dh },
      undefined,
    ]) {
      expect(() => parseSubscription({ endpoint: good.endpoint, keys })).toThrow(PushInputError);
    }
  });
});

describe("/api/v1/auth/me/push", () => {
  it("gives a signed-in person the public key, and nobody else anything", async () => {
    const res = await request(app).get("/api/v1/auth/me/push/config").set("authorization", `Bearer ${ada.token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true, publicKey: process.env.VAPID_PUBLIC_KEY });
    expect((await request(app).get("/api/v1/auth/me/push/config")).status).toBe(401);
    expect((await request(app).put("/api/v1/auth/me/push/subscription").send(newDevice().subscription)).status).toBe(401);
    expect((await request(app).post("/api/v1/auth/me/push/test")).status).toBe(401);
  });

  it("saves a device for the person in the token and refuses an internal endpoint", async () => {
    const device = newDevice();
    expect((await subscribe(ada.token, device.subscription)).status).toBe(200);
    const stored = await PushSubscriptionModel.find({}).lean();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ personId: ada.id, endpoint: device.subscription.endpoint });

    const sneaky = { ...device.subscription, endpoint: "http://unified-auth.railway.internal:8080/internal/events" };
    const refused = await subscribe(ada.token, sneaky);
    expect(refused.status).toBe(400);
    expect(refused.body.message).toBe("endpoint is not a supported push service");
    // A personId in the body is not how the owner is chosen.
    await subscribe(ada.token, { ...newDevice().subscription, personId: bola.id });
    expect(await PushSubscriptionModel.countDocuments({ personId: bola.id })).toBe(0);
  });

  it("moves a device to whoever subscribes it next, and lets only its owner remove it", async () => {
    const device = newDevice();
    await subscribe(ada.token, device.subscription);
    await subscribe(bola.token, device.subscription);
    const rows = await PushSubscriptionModel.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].personId).toBe(bola.id);

    expect((await unsubscribe(ada.token, device.subscription.endpoint)).body).toEqual({ removed: false });
    expect(await PushSubscriptionModel.countDocuments({})).toBe(1);
    expect((await unsubscribe(bola.token, device.subscription.endpoint)).body).toEqual({ removed: true });
    expect(await PushSubscriptionModel.countDocuments({})).toBe(0);
  });

  it("sends a test alert to the caller's own devices only, encrypted for each and signed with auth's key", async () => {
    const adaPhone = newDevice();
    const bolaPhone = newDevice();
    await subscribe(ada.token, adaPhone.subscription);
    await subscribe(bola.token, bolaPhone.subscription);

    const res = await testAlert(ada.token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: 1, removed: 0, failed: 0 });
    const [hit] = await waitForHits(adaPhone, 1);
    expect(decrypt(adaPhone, hit.body)).toMatchObject({ title: "Notifications are on", app: "Settings", tag: "push-test" });
    await expectVapid(hit);
    expect(hit.headers["content-encoding"]).toBe("aes128gcm");
    expect(hit.headers.ttl).toBe(String(24 * 60 * 60));
    expect(hitsFor(bolaPhone)).toHaveLength(0);
  });

  it("forgets a device its push service says is gone", async () => {
    const device = newDevice();
    await subscribe(chidi.token, device.subscription);
    answers.set(device.path, 410);
    expect((await testAlert(chidi.token)).body).toEqual({ sent: 0, removed: 1, failed: 0 });
    expect(await PushSubscriptionModel.countDocuments({ personId: chidi.id })).toBe(0);
  });

  it("limits test alerts per person", async () => {
    await subscribe(chidi.token, newDevice().subscription);
    // One was used by the test above; four more fit in the window, then the limit holds.
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) statuses.push((await testAlert(chidi.token)).status);
    expect(statuses).toEqual([200, 200, 200, 200, 429]);
    // Another person's allowance is their own.
    expect((await testAlert(ada.token)).status).toBe(200);
  });
});

describe("alerts from events", () => {
  it("alerts the person's devices when a notice is stored, with the notice's own text", async () => {
    const device = newDevice();
    await subscribe(ada.token, device.subscription);
    const event = payment(ada.id, 2_500_000);
    expect((await deliver(event)).body.status).toBe("applied");

    const [hit] = await waitForHits(device, 1);
    expect(decrypt(device, hit.body)).toEqual({
      id: event.eventId,
      title: "Payment confirmed",
      body: "We received your EasyBuy payment of ₦25,000. Thank you.",
      app: "Easybuy Portal",
      tag: event.eventId,
    });
    await expectVapid(hit);
  });

  it("alerts about a repayment reminder, unless it arrives too late to be news", async () => {
    const device = newDevice();
    await subscribe(ada.token, device.subscription);
    const remind = (id: string) =>
      createEvent(easybuyRepaymentDue, {
        subject: { kind: "instalment", id, personId: ada.id },
        seq: 1,
        traceId: "trace-push-test",
        data: { itemId: "item-1", personId: ada.id, instalment: 1, dueOn: "2026-11-08", amountKobo: 16_000_000, stage: "overdue" },
      });

    const late = { ...remind(`item-${randomUUID().slice(0, 8)}:1`), occurredAt: new Date(Date.now() - 2 * 86_400_000).toISOString() };
    expect((await deliver(late)).body.status).toBe("applied");
    await settle();
    expect(hitsFor(device)).toHaveLength(0);

    const event = remind(`item-${randomUUID().slice(0, 8)}:1`);
    expect((await deliver(event)).body.status).toBe("applied");
    const [hit] = await waitForHits(device, 1);
    expect(decrypt(device, hit.body)).toEqual({
      id: event.eventId,
      title: "Repayment overdue",
      body: "Your EasyBuy instalment of ₦160,000 was due on 8 Nov 2026. Please pay as soon as you can.",
      app: "Easybuy Portal",
      tag: event.eventId,
    });
    await expectVapid(hit);
  });

  it("never alerts for history, a repeat, or someone else's notice", async () => {
    const device = newDevice();
    await subscribe(ada.token, device.subscription);
    const late = { ...payment(ada.id, 100_000), occurredAt: new Date(Date.now() - 2 * 86_400_000).toISOString() };
    expect((await deliver(late)).body.status).toBe("applied");
    await deliver(payment(bola.id, 100_000));
    await settle();
    expect(hitsFor(device)).toHaveLength(0);

    const fresh = payment(ada.id, 200_000);
    await deliver(fresh);
    await waitForHits(device, 1);
    expect((await deliver(fresh)).body.status).toBe("duplicate");
    await settle();
    expect(hitsFor(device)).toHaveLength(1);
  });

  it("replaces a conversation's alert with its latest count", async () => {
    const device = newDevice();
    await subscribe(ada.token, device.subscription);
    const conv = `conv-${randomUUID().slice(0, 8)}`;
    await deliver(chat(ada.id, conv, 1));
    await waitForHits(device, 1);
    await deliver(chat(ada.id, conv, 2));
    const [first, second] = await waitForHits(device, 2);

    expect(decrypt(device, first.body)).toMatchObject({ body: "Your reseller replied.", app: "Chat", tag: `chat:${conv}` });
    expect(decrypt(device, second.body)).toEqual({
      id: `chat:${ada.id}:${conv}`,
      title: "New message",
      body: "2 new messages from your reseller.",
      app: "Chat",
      tag: `chat:${conv}`,
    });
    // The push service may drop the older one while the device is offline: same Topic.
    expect(first.headers.topic).toBeTruthy();
    expect(second.headers.topic).toBe(first.headers.topic);
  });
});
