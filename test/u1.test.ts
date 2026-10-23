import express from "express";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTokenVerifier, type TokenVerifier } from "@melvingadgets/platform-kit";
import { TEST_CLIENT_SECRETS } from "./setup-env.js";

// U1 (BACKEND-UNIFICATION.md §8): auth as authorization server. Runs against a throwaway
// database on the local MongoDB (MONGO_TEST_URL), dropped at the end.

let app: express.Application;
let verifier: TokenVerifier;
let UserModel: typeof import("../Model/UserModel.js").default;
let SessionModel: typeof import("../Model/SessionModel.js").default;
let hashPassword: typeof import("../Utils/authHelpers.js").hashPassword;

const PASSWORD = "correct horse battery";

beforeAll(async () => {
  const db = await import("../Database/Database.js");
  await db.default;
  const { MainApp } = await import("../MainApp.js");
  UserModel = (await import("../Model/UserModel.js")).default;
  SessionModel = (await import("../Model/SessionModel.js")).default;
  hashPassword = (await import("../Utils/authHelpers.js")).hashPassword;
  await Promise.all([UserModel.syncIndexes(), SessionModel.syncIndexes()]);
  app = express();
  MainApp(app);

  const jwks = await request(app).get("/.well-known/jwks.json");
  verifier = createTokenVerifier({ issuer: "http://auth.test", jwks: jwks.body });
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString("base64")}`;

const serviceToken = async (audience: string, scope: string, client: keyof typeof TEST_CLIENT_SECRETS = "store") => {
  const res = await request(app)
    .post("/oauth/token")
    .set("authorization", basic(`svc-${client}`, TEST_CLIENT_SECRETS[client]))
    .type("form")
    .send({ grant_type: "client_credentials", audience, scope });
  expect(res.status).toBe(200);
  return res.body.access_token as string;
};

const createUser = async (fields: Record<string, unknown>) =>
  UserModel.create({ fullName: "Ada Obi", role: "User", emailVerified: true, disabled: false, password: await hashPassword(PASSWORD), ...fields });

const login = (identifier: string, password = PASSWORD) => request(app).post("/api/v1/auth/login").send({ identifier, password });

describe("JWKS", () => {
  it("publishes the public key only", async () => {
    const res = await request(app).get("/.well-known/jwks.json");
    expect(res.status).toBe(200);
    expect(res.body.keys).toHaveLength(1);
    expect(res.body.keys[0]).toMatchObject({ kid: "test-key", alg: "RS256", kty: "RSA", use: "sig" });
    expect(res.body.keys[0].d).toBeUndefined();
  });
});

describe("POST /oauth/token (client credentials)", () => {
  it("issues a 5-minute token for a granted audience and scope", async () => {
    const res = await request(app)
      .post("/oauth/token")
      .set("authorization", basic("svc-store", TEST_CLIENT_SECRETS.store))
      .type("form")
      .send({ grant_type: "client_credentials", audience: "easybuy", scope: "easybuy:quote.read easybuy:catalog.read" });
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toMatchObject({ token_type: "Bearer", expires_in: 300, scope: "easybuy:catalog.read easybuy:quote.read" });
    const caller = await verifier.verifyServiceToken(res.body.access_token, { audience: "easybuy", scope: "easybuy:quote.read" });
    expect(caller.service).toBe("store");
  });

  it("accepts credentials in a JSON body too", async () => {
    const res = await request(app).post("/oauth/token").send({
      grant_type: "client_credentials",
      client_id: "svc-easybuy",
      client_secret: TEST_CLIENT_SECRETS.easybuy,
      audience: "market",
      scope: "market:prices.read",
    });
    expect(res.status).toBe(200);
  });

  it("answers invalid_client the same way for a wrong secret and an unknown client", async () => {
    const wrong = await request(app)
      .post("/oauth/token")
      .set("authorization", basic("svc-store", "nope"))
      .type("form")
      .send({ grant_type: "client_credentials", audience: "easybuy", scope: "easybuy:quote.read" });
    const unknown = await request(app)
      .post("/oauth/token")
      .set("authorization", basic("svc-ghost", "nope"))
      .type("form")
      .send({ grant_type: "client_credentials", audience: "easybuy", scope: "easybuy:quote.read" });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual({ error: "invalid_client" });
    expect(unknown.body).toEqual(wrong.body);
    expect(wrong.headers["www-authenticate"]).toContain("Basic");
  });

  it("refuses links that aren't in the grants table", async () => {
    const res = await request(app)
      .post("/oauth/token")
      .set("authorization", basic("svc-easybuy", TEST_CLIENT_SECRETS.easybuy))
      .type("form")
      .send({ grant_type: "client_credentials", audience: "store", scope: "easybuy:quote.read" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid_scope" });
  });

  it("rejects unknown scopes, a missing audience and other grant types", async () => {
    const auth = basic("svc-store", TEST_CLIENT_SECRETS.store);
    const send = (body: Record<string, string>) => request(app).post("/oauth/token").set("authorization", auth).type("form").send(body);
    expect((await send({ grant_type: "client_credentials", audience: "easybuy", scope: "easybuy:everything" })).body).toEqual({ error: "invalid_scope" });
    expect((await send({ grant_type: "client_credentials", scope: "easybuy:quote.read" })).body).toEqual({ error: "invalid_request" });
    expect((await send({ grant_type: "password", audience: "easybuy", scope: "easybuy:quote.read" })).body).toEqual({ error: "unsupported_grant_type" });
  });
});

describe("login", () => {
  beforeAll(async () => {
    await createUser({ email: "ada@example.com" });
    await createUser({ email: "google-only@example.com", password: undefined, googleId: "g-1" });
    await createUser({ email: "phone-user@example.com", phone: "+2348031234567", phoneVerified: true });
    await createUser({ email: "unverified-phone@example.com", phone: "+2348039998888", phoneVerified: false });
  });

  it("gives the same answer for an unknown account, a wrong password and a Google-only account", async () => {
    const unknown = await login("nobody@example.com");
    const wrongPassword = await login("ada@example.com", "not the password");
    const googleOnly = await login("google-only@example.com");
    for (const res of [unknown, wrongPassword, googleOnly]) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ message: "invalid credentials" });
    }
  });

  it("rejects an empty body with 400 instead of a lookup", async () => {
    expect((await request(app).post("/api/v1/auth/login").send({})).status).toBe(400);
    expect((await request(app).post("/api/v1/auth/login").send({ identifier: "ada@example.com", password: 12345678 })).status).toBe(400);
  });

  it("returns the legacy token plus RS256 access and refresh tokens", async () => {
    const res = await login("ada@example.com");
    expect(res.status).toBe(201);
    expect(typeof res.body.data).toBe("string");
    const person = await verifier.verifyUserToken(res.body.accessToken);
    const user = await UserModel.findOne({ email: "ada@example.com" }).lean();
    expect(person.personId).toBe(String(user?._id));
    expect(await SessionModel.exists({ jti: person.sessionId, active: true })).toBeTruthy();
    expect(res.body.refreshToken).toMatch(/^[0-9a-f]{64}$/);
    // The refresh token is stored only as a hash.
    expect(await SessionModel.exists({ refreshTokenHash: res.body.refreshToken })).toBeNull();
  });

  it("signs in with a verified phone in any common format, never an unverified one", async () => {
    expect((await login("0803 123 4567")).status).toBe(201);
    expect((await login("+234 803 123 4567")).status).toBe(201);
    expect((await login("08039998888")).status).toBe(401);
  });

  it("the RS256 access token works on /me", async () => {
    const { body } = await login("ada@example.com");
    const me = await request(app).get("/api/v1/auth/me").set("authorization", `Bearer ${body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.data.user.email).toBe("ada@example.com");
  });
});

describe("refresh tokens", () => {
  beforeAll(async () => {
    await createUser({ email: "refresh@example.com" });
  });

  const refresh = (refreshToken: string) => request(app).post("/api/v1/auth/token/refresh").send({ refreshToken });

  it("rotates: the new pair works and the old refresh token stops working", async () => {
    const first = (await login("refresh@example.com")).body;
    const second = await refresh(first.refreshToken);
    expect(second.status).toBe(200);
    expect(second.body.refreshToken).not.toBe(first.refreshToken);
    await verifier.verifyUserToken(second.body.accessToken);
    // Within the grace window a replay is refused but doesn't end the session.
    expect((await refresh(first.refreshToken)).body).toEqual({ message: "invalid refresh token" });
    expect((await refresh(second.body.refreshToken)).status).toBe(200);
  });

  it("only one of two concurrent refreshes with the same token succeeds", async () => {
    const { refreshToken } = (await login("refresh@example.com")).body;
    const results = await Promise.all([refresh(refreshToken), refresh(refreshToken), refresh(refreshToken)]);
    expect(results.filter((res) => res.status === 200)).toHaveLength(1);
  });

  it("revokes the whole session when a rotated-out token is replayed after the grace window", async () => {
    const first = (await login("refresh@example.com")).body;
    const second = (await refresh(first.refreshToken)).body;
    const { sessionId } = await verifier.verifyUserToken(second.accessToken);
    await SessionModel.updateOne({ jti: sessionId }, { $set: { refreshRotatedAt: new Date(Date.now() - 60_000) } });

    expect((await refresh(first.refreshToken)).body).toEqual({ message: "session revoked" });
    expect((await refresh(second.refreshToken)).status).toBe(401);
    expect((await request(app).get("/api/v1/auth/me").set("authorization", `Bearer ${second.accessToken}`)).status).toBe(401);
  });

  it("logout ends both the access token and the refresh token", async () => {
    const { accessToken, refreshToken } = (await login("refresh@example.com")).body;
    expect((await request(app).post("/api/v1/auth/logout").set("authorization", `Bearer ${accessToken}`)).status).toBe(200);
    expect((await request(app).get("/api/v1/auth/me").set("authorization", `Bearer ${accessToken}`)).status).toBe(401);
    expect((await refresh(refreshToken)).status).toBe(401);
  });

  it("a disabled person can't refresh", async () => {
    await createUser({ email: "soon-disabled@example.com" });
    const { refreshToken } = (await login("soon-disabled@example.com")).body;
    await UserModel.updateOne({ email: "soon-disabled@example.com" }, { $set: { disabled: true } });
    expect((await refresh(refreshToken)).body).toEqual({ message: "session revoked" });
  });
});

describe("service-token internal routes", () => {
  let personId = "";
  let sessionId = "";

  beforeAll(async () => {
    const user = await createUser({ email: "lookup@example.com", phone: "+2348025550000", phoneVerified: true });
    personId = String(user._id);
    const { accessToken } = (await login("lookup@example.com")).body;
    sessionId = (await verifier.verifyUserToken(accessToken)).sessionId;
  });

  it("session check needs auth:sessions.check addressed to auth", async () => {
    const path = `/api/v1/auth/internal/v2/sessions/${sessionId}`;
    expect((await request(app).get(path)).status).toBe(401);
    const wrongAudience = await serviceToken("easybuy", "easybuy:quote.read");
    expect((await request(app).get(path).set("authorization", `Bearer ${wrongAudience}`)).status).toBe(401);
    const peopleOnly = await serviceToken("auth", "auth:people.read");
    expect((await request(app).get(path).set("authorization", `Bearer ${peopleOnly}`)).status).toBe(403);

    const token = await serviceToken("auth", "auth:sessions.check");
    const res = await request(app).get(path).set("authorization", `Bearer ${token}`);
    expect(res.body).toEqual({ active: true, personId });
  });

  it("a user token can't stand in for a service token", async () => {
    const { accessToken } = (await login("lookup@example.com")).body;
    const res = await request(app).get(`/api/v1/auth/internal/v2/people/${personId}`).set("authorization", `Bearer ${accessToken}`);
    expect(res.status).toBe(401);
  });

  it("people lookups return the person by id, email or verified phone", async () => {
    const token = await serviceToken("auth", "auth:people.read");
    const byId = await request(app).get(`/api/v1/auth/internal/v2/people/${personId}`).set("authorization", `Bearer ${token}`);
    expect(byId.body).toMatchObject({ personId, email: "lookup@example.com", phone: "+2348025550000", phoneVerified: true });
    const byPhone = await request(app)
      .post("/api/v1/auth/internal/v2/people/lookup")
      .set("authorization", `Bearer ${token}`)
      .send({ phone: "0802 555 0000" });
    expect(byPhone.body.personId).toBe(personId);
    const missing = await request(app)
      .post("/api/v1/auth/internal/v2/people/lookup")
      .set("authorization", `Bearer ${token}`)
      .send({ email: "nobody@example.com" });
    expect(missing.status).toBe(404);
  });
});

describe("rate limiting", () => {
  it("counts each client IP separately behind the proxy and answers 429 with Retry-After", async () => {
    const { rateLimiter } = await import("../Middleware/rateLimiter.js");
    const limited = express();
    limited.set("trust proxy", 1);
    limited.post("/x", rateLimiter({ windowMs: 60_000, limit: 2, message: "slow down" }), (_req, res) => {
      res.status(204).end();
    });
    const from = (ip: string) => request(limited).post("/x").set("x-forwarded-for", ip);
    expect((await from("1.1.1.1")).status).toBe(204);
    expect((await from("1.1.1.1")).status).toBe(204);
    const third = await from("1.1.1.1");
    expect(third.status).toBe(429);
    expect(Number(third.headers["retry-after"])).toBeGreaterThan(0);
    // Another client behind the same proxy has its own allowance.
    expect((await from("2.2.2.2")).status).toBe(204);
  });
});

describe("identity rules", () => {
  it("a person needs an email or a phone, and each is unique when present", async () => {
    await expect(UserModel.create({ fullName: "No Contact", role: "User", emailVerified: false, disabled: false })).rejects.toThrow(
      /email or a phone/
    );
    await UserModel.create({ fullName: "Only Phone A", phone: "+2348011111111", role: "User", emailVerified: false, disabled: false });
    await UserModel.create({ fullName: "Only Phone B", phone: "+2348022222222", role: "User", emailVerified: false, disabled: false });
    await expect(
      UserModel.create({ fullName: "Dup", phone: "+2348011111111", role: "User", emailVerified: false, disabled: false })
    ).rejects.toThrow(/duplicate key/);
  });
});
