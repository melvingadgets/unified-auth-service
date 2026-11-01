import express from "express";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";

// The person's home-screen choices, end to end inside auth: real Express app, real MongoDB (the
// throwaway test database) and real RS256 tokens from auth's /oauth/… login. Nothing is mocked.
//
// Auth's test database is standalone, so nothing here may depend on a transaction — the module is
// built so that the unique index, not findOne-then-create, is what makes concurrent first writes
// safe (AGENTS.md §3.8).

let app: express.Application;
let UserModel: typeof import("../Model/UserModel.js").default;
let hashPassword: typeof import("../Utils/authHelpers.js").hashPassword;
let models: typeof import("../HomeApps/model.js");

const PASSWORD = "correct horse battery";
let ada: { id: string; token: string };
let bola: { id: string; token: string };

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

const url = "/api/v1/auth/me/home-apps";
const get = (token: string) => request(app).get(url).set("authorization", `Bearer ${token}`);
const patch = (token: string, body: unknown) => request(app).patch(url).set("authorization", `Bearer ${token}`).send(body as object);
const put = (token: string, body: unknown) => request(app).put(url).set("authorization", `Bearer ${token}`).send(body as object);

beforeAll(async () => {
  const db = await import("../Database/Database.js");
  await db.default;
  const { MainApp } = await import("../MainApp.js");
  UserModel = (await import("../Model/UserModel.js")).default;
  hashPassword = (await import("../Utils/authHelpers.js")).hashPassword;
  models = await import("../HomeApps/model.js");
  await Promise.all([UserModel.syncIndexes(), models.HomeAppsModel.syncIndexes()]);

  app = express();
  MainApp(app);

  ada = await signUpAndLogin(`ada-${randomUUID().slice(0, 6)}@example.com`);
  bola = await signUpAndLogin(`bola-${randomUUID().slice(0, 6)}@example.com`);
});

beforeEach(async () => {
  await models.HomeAppsModel.deleteMany({});
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

describe("GET", () => {
  it("answers with an unconfigured, empty view before anything is saved", async () => {
    const res = await get(ada.token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ configured: false, apps: {}, version: 0 });
  });

  it("refuses a request with no token", async () => {
    const res = await request(app).get(url);
    expect(res.status).toBe(401);
  });

  it("refuses a forged token rather than treating it as a person", async () => {
    const res = await get("not-a-real-token");
    expect(res.status).toBe(401);
  });
});

describe("PATCH", () => {
  it("creates the document on the first write and returns the new version", async () => {
    const res = await patch(ada.token, { changes: { Chat: "removed", "EasyBuy Apply": "added" }, version: 0 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      configured: true,
      apps: { Chat: "removed", "EasyBuy Apply": "added" },
      version: 1,
    });

    // And it is readable afterwards.
    const after = await get(ada.token);
    expect(after.body).toMatchObject({ configured: true, version: 1 });
  });

  it("merges a later change instead of replacing the whole map", async () => {
    await patch(ada.token, { changes: { Chat: "removed" }, version: 0 });
    const res = await patch(ada.token, { changes: { Reseller: "added" }, version: 1 });
    expect(res.status).toBe(200);
    expect(res.body.apps).toEqual({ Chat: "removed", Reseller: "added" });
    expect(res.body.version).toBe(2);
  });

  it("answers 409 with the current state when the version has moved", async () => {
    await patch(ada.token, { changes: { Chat: "removed" }, version: 0 });
    // A second device still believes the version is 0.
    const res = await patch(ada.token, { changes: { Reseller: "added" }, version: 0 });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ configured: true, apps: { Chat: "removed" }, version: 1 });

    // Re-applying on top of what is actually stored succeeds and keeps BOTH changes.
    const retry = await patch(ada.token, { changes: { Reseller: "added" }, version: 1 });
    expect(retry.status).toBe(200);
    expect(retry.body.apps).toEqual({ Chat: "removed", Reseller: "added" });
  });

  it("does not let one person read or change another person's choices", async () => {
    await patch(ada.token, { changes: { Chat: "removed" }, version: 0 });

    // Bola sees none of Ada's choices, and her first write starts from an empty document.
    const bolaGet = await get(bola.token);
    expect(bolaGet.body).toEqual({ configured: false, apps: {}, version: 0 });

    const bolaWrite = await patch(bola.token, { changes: { Reseller: "added" }, version: 0 });
    expect(bolaWrite.status).toBe(200);

    // Ada is untouched: still one change, still version 1.
    const adaAfter = await get(ada.token);
    expect(adaAfter.body).toEqual({ configured: true, apps: { Chat: "removed" }, version: 1 });

    // Exactly two documents, one per person.
    expect(await models.HomeAppsModel.countDocuments({})).toBe(2);
  });

  it("refuses an app name that could be a Mongo path or an injection", async () => {
    for (const name of ["$set", "apps.$set", "Chat.Chat", "", " Chat", "Chat ", "-Chat", "Ch@t", "a".repeat(41)]) {
      const res = await patch(ada.token, { changes: { [name]: "added" }, version: 0 });
      expect(res.status, `accepted the invalid name ${JSON.stringify(name)}`).toBe(400);
    }
    // Nothing was written by any of them.
    expect(await models.HomeAppsModel.countDocuments({})).toBe(0);
  });

  it("refuses a state that is not added or removed", async () => {
    for (const state of ["installed", "ADDED", true, 1, null, {}]) {
      const res = await patch(ada.token, { changes: { Chat: state }, version: 0 });
      expect(res.status, `accepted the invalid state ${JSON.stringify(state)}`).toBe(400);
    }
  });

  it("refuses an empty change set and a malformed body", async () => {
    expect((await patch(ada.token, { changes: {}, version: 0 })).status).toBe(400);
    expect((await patch(ada.token, { changes: [], version: 0 })).status).toBe(400);
    expect((await patch(ada.token, { changes: "Chat", version: 0 })).status).toBe(400);
    expect((await patch(ada.token, { version: 0 })).status).toBe(400);
    expect((await patch(ada.token, { changes: { Chat: "added" }, version: -1 })).status).toBe(400);
    expect((await patch(ada.token, { changes: { Chat: "added" }, version: 1.5 })).status).toBe(400);
  });

  it("treats a missing version as a first write, so an older client still works", async () => {
    const res = await patch(ada.token, { changes: { Chat: "removed" } });
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(1);

    // But a second one without a version now conflicts, rather than silently overwriting.
    const second = await patch(ada.token, { changes: { Reseller: "added" } });
    expect(second.status).toBe(409);
  });

  it("counts concurrent first writes as one document, not two", async () => {
    // The unique index is the only thing that can enforce this on a standalone Mongo (§3.8).
    const results = await Promise.all([
      patch(ada.token, { changes: { Chat: "removed" }, version: 0 }),
      patch(ada.token, { changes: { Reseller: "added" }, version: 0 }),
      patch(ada.token, { changes: { Settings: "added" }, version: 0 }),
    ]);

    // Exactly one wins; the others are told the version moved.
    expect(results.filter((res) => res.status === 200)).toHaveLength(1);
    expect(results.filter((res) => res.status === 409)).toHaveLength(2);
    expect(await models.HomeAppsModel.countDocuments({ personId: ada.id })).toBe(1);
  });

  it("survives concurrent changes at the SAME version without losing the winner's write", async () => {
    await patch(ada.token, { changes: { Chat: "removed" }, version: 0 });

    const results = await Promise.all([
      patch(ada.token, { changes: { Reseller: "added" }, version: 1 }),
      patch(ada.token, { changes: { Settings: "added" }, version: 1 }),
    ]);

    expect(results.filter((res) => res.status === 200)).toHaveLength(1);
    expect(results.filter((res) => res.status === 409)).toHaveLength(1);

    // Whatever won is stored intact; the loser changed nothing.
    const stored = await models.HomeAppsModel.findOne({ personId: ada.id }).lean();
    expect(stored?.version).toBe(2);
    expect(Object.keys(stored?.apps ?? {})).toHaveLength(2);
  });
});

describe("PUT (whole map)", () => {
  it("uploads a device's local set on first save", async () => {
    const res = await put(ada.token, { apps: { Profile: "added", Chat: "added", Reseller: "removed" }, version: 0 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ configured: true, apps: { Profile: "added", Chat: "added", Reseller: "removed" }, version: 1 });
  });

  it("replaces rather than merges", async () => {
    await put(ada.token, { apps: { Chat: "removed" }, version: 0 });
    const res = await put(ada.token, { apps: { Reseller: "added" }, version: 1 });
    expect(res.body.apps).toEqual({ Reseller: "added" });
  });

  it("answers 409 at a stale version", async () => {
    await put(ada.token, { apps: { Chat: "removed" }, version: 0 });
    const res = await put(ada.token, { apps: { Reseller: "added" }, version: 0 });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ configured: true, apps: { Chat: "removed" }, version: 1 });
  });

  it("refuses more apps than the cap", async () => {
    const apps: Record<string, "added"> = {};
    for (let i = 0; i < 65; i += 1) apps[`App ${i}`] = "added";
    expect((await put(ada.token, { apps, version: 0 })).status).toBe(400);
  });
});
