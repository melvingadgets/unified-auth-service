import { randomUUID } from "crypto";
import express from "express";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The hub's Setup Assistant, remembered per person (/api/v1/auth/me/setup). Real Express app,
// real MongoDB and real sign-ins.

let app: express.Application;
const PASSWORD = "correct horse battery";

const signUpAndLogin = async (email: string) => {
  const UserModel = (await import("../Model/UserModel.js")).default;
  const { hashPassword } = await import("../Utils/authHelpers.js");
  await UserModel.create({
    fullName: "Test Person",
    email,
    role: "User",
    emailVerified: true,
    disabled: false,
    password: await hashPassword(PASSWORD),
  });
  const res = await request(app).post("/api/v1/auth/login").send({ identifier: email, password: PASSWORD });
  expect(res.status).toBe(201);
  return res.body.accessToken as string;
};

const getSetup = (token: string) => request(app).get("/api/v1/auth/me/setup").set("authorization", `Bearer ${token}`);
const putSetup = (token: string, body: unknown) =>
  request(app).put("/api/v1/auth/me/setup").set("authorization", `Bearer ${token}`).send(body as object);

let ada: string;
let bola: string;

beforeAll(async () => {
  const db = await import("../Database/Database.js");
  await db.default;
  const { MainApp } = await import("../MainApp.js");
  app = express();
  MainApp(app, { push: null });
  ada = await signUpAndLogin(`ada-setup-${randomUUID().slice(0, 6)}@example.com`);
  bola = await signUpAndLogin(`bola-setup-${randomUUID().slice(0, 6)}@example.com`);
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

describe("/api/v1/auth/me/setup", () => {
  it("is not done for someone who has never finished it, existing accounts included", async () => {
    const res = await getSetup(ada);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ completedAt: null, interests: [] });
  });

  it("records finishing it, and keeps the first finish when it is run again", async () => {
    const first = await putSetup(ada, { completed: true, interests: ["easybuy", "shop"] });
    expect(first.status).toBe(200);
    expect(first.body.interests).toEqual(["easybuy", "shop"]);
    const completedAt = first.body.completedAt as string;
    expect(Number.isNaN(Date.parse(completedAt))).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const again = await putSetup(ada, { completed: true, interests: ["reseller"] });
    expect(again.body).toEqual({ completedAt, interests: ["reseller"] });
    expect((await getSetup(ada)).body).toEqual({ completedAt, interests: ["reseller"] });

    // Someone else's progress is their own.
    expect((await getSetup(bola)).body).toEqual({ completedAt: null, interests: [] });
  });

  it("accepts finishing with no interests", async () => {
    const res = await putSetup(bola, { completed: true });
    expect(res.status).toBe(200);
    expect(res.body.interests).toEqual([]);
    expect(res.body.completedAt).not.toBeNull();
  });

  it("refuses anything but known interests and a finished run, and anyone signed out", async () => {
    for (const body of [
      {},
      { completed: false, interests: [] },
      { completed: true, interests: ["crypto"] },
      { completed: true, interests: ["shop", "shop"] },
      { completed: true, interests: "shop" },
      { completed: true, interests: ["shop", "easybuy", "reseller", "swap", "shop"] },
    ]) {
      expect((await putSetup(ada, body)).status).toBe(400);
    }
    expect((await getSetup(ada)).body.interests).toEqual(["reseller"]);
    expect((await request(app).get("/api/v1/auth/me/setup")).status).toBe(401);
    expect((await request(app).put("/api/v1/auth/me/setup").send({ completed: true })).status).toBe(401);
  });
});
