import express from "express";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// RBAC unification, Phase 2 (docs/rbac-unification.md): auth hands out the role and
// domain-role claims, guards its own admin routes by permission, and no longer lets
// `?role[...]` reach the Mongo filter.

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
  // The new `domainRoles` path shares no index, so there is nothing to sync; syncing
  // here races the other test file's hooks on the shared mongoose connection.
}, 30_000);

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const hash = async () => hashPassword(PASSWORD);

const login = async (email: string) => {
  const res = await request(app).post("/api/v1/auth/login").send({ identifier: email, password: PASSWORD });
  expect(res.status, `login ${email}`).toBe(201);
  return res.body.accessToken as string;
};

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe("admin routes", () => {
  let plainUser: string;
  let admin: string;
  let superAdmin: string;

  beforeAll(async () => {
    const password = await hash();
    const base = { emailVerified: true, disabled: false, password };
    await UserModel.create({ ...base, fullName: "Plain Person", role: "User", email: "plain@example.com" });
    await UserModel.create({ ...base, fullName: "Ada Admin", role: "Admin", email: "admin@example.com" });
    await UserModel.create({ ...base, fullName: "Sam Super", role: "SuperAdmin", email: "super@example.com" });
    plainUser = await login("plain@example.com");
    admin = await login("admin@example.com");
    superAdmin = await login("super@example.com");
  });

  it("answers 401 with no token, not 403", async () => {
    expect((await request(app).get("/api/v1/auth/admin/users")).status).toBe(401);
  });

  it("keeps a plain User out of every admin route with 403 Access denied", async () => {
    for (const [method, path] of [
      ["get", "/api/v1/auth/admin/users"],
      ["get", "/api/v1/auth/admin/users/000000000000000000000000"],
      ["patch", "/api/v1/auth/admin/users/000000000000000000000000/role"],
      ["delete", "/api/v1/auth/admin/users/000000000000000000000000"],
    ] as const) {
      const res = await request(app)[method](path).set(bearer(plainUser)).send({ role: "User" });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.body).toEqual({ message: "Access denied" });
    }
  });

  it("lets a SuperAdmin through a route an Admin also holds — no lockout", async () => {
    const res = await request(app).get("/api/v1/auth/admin/users").set(bearer(superAdmin));
    expect(res.status).toBe(200);
  });

  it("refuses an Admin the SuperAdmin-only routes", async () => {
    expect((await request(app).get("/api/v1/auth/admin/users").set(bearer(admin))).status).toBe(200);
    const role = await request(app)
      .patch("/api/v1/auth/admin/users/000000000000000000000000/role")
      .set(bearer(admin))
      .send({ role: "Admin" });
    expect(role.status).toBe(403);
    const del = await request(app).delete("/api/v1/auth/admin/users/000000000000000000000000").set(bearer(admin));
    expect(del.status).toBe(403);
  });

  it("refuses an Admin creating an Admin, but allows creating a User", async () => {
    const asAdmin = await request(app)
      .post("/api/v1/auth/admin/create-user")
      .set(bearer(admin))
      .send({ email: "made-by-admin@example.com", password: PASSWORD, fullName: "Made By Admin", role: "Admin" });
    expect(asAdmin.status).toBe(403);

    const user = await request(app)
      .post("/api/v1/auth/admin/create-user")
      .set(bearer(admin))
      .send({ email: "made-by-admin@example.com", password: PASSWORD, fullName: "Made By Admin", role: "User" });
    expect(user.status).toBe(201);
    expect(user.body.data.user.role).toBe("User");
  });

  it("lets a SuperAdmin create an Admin", async () => {
    const res = await request(app)
      .post("/api/v1/auth/admin/create-user")
      .set(bearer(superAdmin))
      .send({ email: "made-by-super@example.com", password: PASSWORD, fullName: "Made By Super", role: "Admin" });
    expect(res.status).toBe(201);
    expect(res.body.data.user.role).toBe("Admin");
  });
});

describe("the role query filter", () => {
  let token: string;

  beforeAll(async () => {
    token = await login("super@example.com");
  });

  it("accepts a valid role name", async () => {
    const res = await request(app).get("/api/v1/auth/admin/users?role=Admin").set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.data.every((user: { role: string }) => user.role === "Admin")).toBe(true);
  });

  // ~2 tests in a million fail without these fixes, so they're deterministic contracts.
  it("rejects a Mongo operator injected through the query string with 400", async () => {
    for (const query of ["role[$ne]=User", "role[$gt]=", "role[$in][]=Admin", "role[$exists]=true"]) {
      const res = await request(app).get(`/api/v1/auth/admin/users?${query}`).set(bearer(token));
      expect(res.status, query).toBe(400);
      expect(res.body.message).toMatch(/role must be one of/);
    }
  });

  it("rejects a wrong casing rather than silently matching nothing", async () => {
    for (const role of ["admin", "superadmin", "ADMIN", "root"]) {
      expect((await request(app).get(`/api/v1/auth/admin/users?role=${role}`).set(bearer(token))).status, role).toBe(400);
    }
  });

  it("treats an empty role as no filter", async () => {
    expect((await request(app).get("/api/v1/auth/admin/users?role=").set(bearer(token))).status).toBe(200);
  });
});

describe("domainRoles", () => {
  let superToken: string;
  let sellerId: string;

  beforeAll(async () => {
    const user = await UserModel.create({
      fullName: "Sola Seller",
      role: "User",
      email: "seller@example.com",
      emailVerified: true,
      disabled: false,
      password: await hash(),
      domainRoles: ["market:salesperson"],
    });
    sellerId = String(user._id);
    await UserModel.create({
      fullName: "Dana Domain",
      role: "SuperAdmin",
      email: "domain-admin@example.com",
      emailVerified: true,
      disabled: false,
      password: await hash(),
    });
    superToken = await login("domain-admin@example.com");
  });

  it("carries the claim into both the legacy and the RS256 token", async () => {
    const res = await request(app).post("/api/v1/auth/login").send({ identifier: "seller@example.com", password: PASSWORD });
    expect(res.status).toBe(201);
    const { createTokenVerifier } = await import("@melvingadgets/platform-kit");
    const jwks = await request(app).get("/.well-known/jwks.json");
    const verifier = createTokenVerifier({ issuer: "http://auth.test", jwks: jwks.body });
    const person = await verifier.verifyUserToken(res.body.accessToken);
    expect(person.role).toBe("User");
    expect(person.domainRoles).toEqual(["market:salesperson"]);

    // The legacy HS256 token carries the same claim, read without verification here.
    const [, payload] = String(res.body.data).split(".");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
    expect(claims.role).toBe("User");
    expect(claims.domainRoles).toEqual(["market:salesperson"]);
  });

  it("returns [] for everyone without one, never undefined", async () => {
    const res = await request(app).get("/api/v1/auth/admin/users?search=domain-admin@example.com").set(bearer(superToken));
    expect(res.status).toBe(200);
    expect(res.body.data[0].domainRoles).toEqual([]);
  });

  it("grants and revokes through the admin route, and refuses unknown names", async () => {
    const granted = await request(app)
      .patch(`/api/v1/auth/admin/users/${sellerId}/domain-roles`)
      .set(bearer(superToken))
      .send({ domainRoles: ["market:salesperson"] });
    expect(granted.status).toBe(200);
    expect(granted.body.data.domainRoles).toEqual(["market:salesperson"]);

    for (const bad of [["salesperson"], ["market:admin"], "market:salesperson", [{ role: "x" }]]) {
      const res = await request(app)
        .patch(`/api/v1/auth/admin/users/${sellerId}/domain-roles`)
        .set(bearer(superToken))
        .send({ domainRoles: bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }

    const cleared = await request(app)
      .patch(`/api/v1/auth/admin/users/${sellerId}/domain-roles`)
      .set(bearer(superToken))
      .send({ domainRoles: [] });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.domainRoles).toEqual([]);
  });

  it("requires an explicit list rather than silently clearing", async () => {
    const res = await request(app)
      .patch(`/api/v1/auth/admin/users/${sellerId}/domain-roles`)
      .set(bearer(superToken))
      .send({});
    expect(res.status).toBe(400);
  });

  it("refuses a plain User the domain-roles route", async () => {
    const token = await login("seller@example.com");
    const res = await request(app)
      .patch(`/api/v1/auth/admin/users/${sellerId}/domain-roles`)
      .set(bearer(token))
      .send({ domainRoles: ["market:salesperson"] });
    expect(res.status).toBe(403);
  });
});
