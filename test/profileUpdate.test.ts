import express from "express";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The Profile app (Melvin OS, 2026-10-30) is the first client of PATCH /me/profile. Before it
// existed, a partial save silently WIPED every field the request did not mention: the controller
// passed `""` for an absent key and `createOrUpdateProfileForUser` defaulted the rest, so sending
// only `fullName` erased the phone, gender, address and avatar.
//
// These pin both halves of the fix: the partial save preserves, and an explicit blank still clears
// (which is how a person removes an address they no longer want shown).

let app: express.Application;
let UserModel: typeof import("../Model/UserModel.js").default;
let hashPassword: typeof import("../Utils/authHelpers.js").hashPassword;

const PASSWORD = "correct horse battery";

beforeAll(async () => {
  const db = await import("../Database/Database.js");
  await db.default;
  const { MainApp } = await import("../MainApp.js");
  UserModel = (await import("../Model/UserModel.js")).default;
  hashPassword = (await import("../Utils/authHelpers.js")).hashPassword;
  app = express();
  MainApp(app);
}, 30_000);

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const makeUser = async (label: string) => {
  const email = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const [user] = await UserModel.create([{ email, fullName: "Ada Obi", password: await hashPassword(PASSWORD), emailVerified: true, role: "User", originApp: "auth-service" }]);
  const login = await request(app).post("/api/v1/auth/login").send({ identifier: email, password: PASSWORD });
  expect(login.status).toBe(201);
  return { userId: String(user!._id), token: login.body.accessToken as string };
};

describe("PATCH /me/profile", () => {
  it("keeps every field a partial save does not mention", async () => {
    const { token } = await makeUser("partial");

    // A full save first, so there is something to preserve.
    const full = await request(app)
      .patch("/api/v1/auth/me/profile")
      .set("authorization", `Bearer ${token}`)
      .send({ fullName: "Ada Obi", firstName: "Ada", lastName: "Obi", phoneNumber: "+2348031234512", dateOfBirth: "1995-04-12", gender: "Female", address: "12 Marina, Lagos", avatar: "https://example.test/ada.png" });
    expect(full.status).toBe(200);
    expect(full.body.data.profile.address).toBe("12 Marina, Lagos");

    // The regression: a save that carries only the name. The derived first/last names follow the
    // new full name on purpose — a rename that left the old surname behind would be worse — but
    // nothing else may move.
    const partial = await request(app).patch("/api/v1/auth/me/profile").set("authorization", `Bearer ${token}`).send({ fullName: "Ada Nwosu" });
    expect(partial.status).toBe(200);

    const profile = partial.body.data.profile;
    expect(profile.firstName).toBe("Ada");
    expect(profile.lastName).toBe("Nwosu");
    expect(profile.phoneNumber).toBe("+2348031234512");
    expect(profile.gender).toBe("Female");
    expect(profile.address).toBe("12 Marina, Lagos");
    expect(profile.avatar).toBe("https://example.test/ada.png");
    expect(new Date(profile.dateOfBirth).toISOString()).toBe(new Date("1995-04-12").toISOString());
  });

  it("still lets an explicit blank clear a field", async () => {
    const { token } = await makeUser("blank");
    await request(app)
      .patch("/api/v1/auth/me/profile")
      .set("authorization", `Bearer ${token}`)
      .send({ address: "1 Broad Street", gender: "Female" });

    const cleared = await request(app).patch("/api/v1/auth/me/profile").set("authorization", `Bearer ${token}`).send({ address: "" });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.profile.address).toBe("");
    // Clearing the address did not touch the gender.
    expect(cleared.body.data.profile.gender).toBe("Female");
  });

  it("updates the name without a body name touching anything else", async () => {
    const { userId, token } = await makeUser("rename");
    await request(app).patch("/api/v1/auth/me/profile").set("authorization", `Bearer ${token}`).send({ fullName: "Chidi Okeke", gender: "Male" });

    const user = await UserModel.findById(userId).lean();
    expect(user!.fullName).toBe("Chidi Okeke");
    const me = await request(app).get("/api/v1/auth/me").set("authorization", `Bearer ${token}`);
    expect(me.body.data.profile.gender).toBe("Male");
    // The derived names follow the new full name, because fullName was part of the patch.
    expect(me.body.data.profile.firstName).toBe("Chidi");
  });

  it("returns createdAt, so the app can say when the person joined", async () => {
    const { token } = await makeUser("created");
    const me = await request(app).get("/api/v1/auth/me").set("authorization", `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(typeof me.body.data.user.createdAt).toBe("string");
    expect(Number.isNaN(new Date(me.body.data.user.createdAt).getTime())).toBe(false);
  });
});
