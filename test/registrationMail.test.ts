import express from "express";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mailIsConfigured, type MailConfigView } from "../Utils/authHelpers.js";

// Sign-up used to fail with `400 "unable to create user"` whenever the mail provider rejected the
// send — after the account row had already been created. Retrying gave `409 "Email Already in
// use"` and signing in gave `403 "please check your email to verify account"`: a person locked out
// of an account they could neither use nor recreate (reported 2026-10-30).
//
// Two defects compounded:
//   1. `isMailConfigured()` only checked for NON-EMPTY values, so a placeholder from .env.example
//      counted as a working provider.
//   2. A failed send was reported as a failed registration.
//
// Two layers of test:
//   - `mailIsConfigured` is pure, so every config shape is checked exhaustively and exactly.
//   - The HTTP tests assert the invariant that actually protects the customer: REGISTRATION ALWAYS
//     ANSWERS 201 for a valid new account, whatever mail does. They do not depend on which mail
//     state the test process happens to be in (Config reads the env once, at import).

const PASSWORD = "correct horse battery";

const config = (overrides: Partial<MailConfigView> = {}): MailConfigView => ({
  provider: "resend",
  from: "Melvin <noreply@melvingadgets.com>",
  smtp: { gmailUser: "", gmailAppPassword: "" },
  resend: { apiKey: "" },
  ...overrides,
});

describe("mailIsConfigured", () => {
  it("is false when nothing is set", () => {
    expect(mailIsConfigured(config())).toBe(false);
    expect(mailIsConfigured(config({ from: "" }))).toBe(false);
  });

  it("treats every .env.example placeholder as NOT configured", () => {
    // These are the exact values the example file used to ship. Each is non-empty, which is why
    // the old presence check called them a working provider.
    expect(mailIsConfigured(config({ from: '"Unified Auth <noreply@yourdomain.com>"' }))).toBe(false);
    expect(mailIsConfigured(config({ resend: { apiKey: "re_your_api_key_here" } }))).toBe(false);
    expect(
      mailIsConfigured(config({ provider: "smtp", smtp: { gmailUser: "youremail@gmail.com", gmailAppPassword: "your16charapppassword" } })),
    ).toBe(false);
    expect(mailIsConfigured(config({ provider: "smtp", smtp: { gmailUser: "replace_me", gmailAppPassword: "replace_me" } }))).toBe(false);
    expect(mailIsConfigured(config({ from: "Melvin <noreply@example.com>" }))).toBe(false);
  });

  it("accepts a real-looking Resend key with a real from address", () => {
    expect(mailIsConfigured(config({ resend: { apiKey: "re_9f3ab21c8d7e6504" } }))).toBe(true);
  });

  it("requires BOTH SMTP values", () => {
    const both = config({ provider: "smtp", smtp: { gmailUser: "ops@melvingadgets.com", gmailAppPassword: "abcdefghijklmnop" } });
    expect(mailIsConfigured(both)).toBe(true);

    const noPassword = config({ provider: "smtp", smtp: { gmailUser: "ops@melvingadgets.com", gmailAppPassword: "" } });
    expect(mailIsConfigured(noPassword)).toBe(false);

    const noUser = config({ provider: "smtp", smtp: { gmailUser: "", gmailAppPassword: "abcdefghijklmnop" } });
    expect(mailIsConfigured(noUser)).toBe(false);
  });

  it("refuses a Resend key when the provider is smtp, and vice versa", () => {
    expect(mailIsConfigured(config({ provider: "smtp", resend: { apiKey: "re_9f3ab21c8d7e6504" } }))).toBe(false);
    expect(mailIsConfigured(config({ provider: "resend", smtp: { gmailUser: "ops@melvingadgets.com", gmailAppPassword: "abcdefghijklmnop" } }))).toBe(false);
  });

  it("requires a from address even with a good key", () => {
    expect(mailIsConfigured(config({ from: "", resend: { apiKey: "re_9f3ab21c8d7e6504" } }))).toBe(false);
  });
});

// ── The invariant, over real HTTP ─────────────────────────────────────────────────────────────

let app: express.Application;
let UserModel: typeof import("../Model/UserModel.js").default;

beforeAll(async () => {
  const db = await import("../Database/Database.js");
  await db.default;
  const { MainApp } = await import("../MainApp.js");
  UserModel = (await import("../Model/UserModel.js")).default;
  app = express();
  MainApp(app);
}, 30_000);

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const emailOf = (label: string) => `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
const register = (email: string) => request(app).post("/api/v1/auth/register").send({ fullName: "Ada Obi", email, password: PASSWORD });

describe("registration never fails because of mail", () => {
  it("answers 201 for a valid new account, whatever the mail state is", async () => {
    const email = emailOf("always-201");
    const created = await register(email);

    expect(created.status).toBe(201);
    expect(created.body.success).toBe(1);
    expect(created.body.message).toContain("registration was successful");
    // A failure is named as a failure. "unable to create user" must never come back for an
    // account that was in fact created.
    expect(created.body.message).not.toContain("unable to create user");
  }, 30_000);

  it("leaves exactly one account, so a retry is a duplicate and not a second row", async () => {
    const email = emailOf("dupe");
    expect((await register(email)).status).toBe(201);
    const dupe = await register(email);
    expect(dupe.status).toBe(409);
    // Recognise the returning person rather than a flat "email in use". A fresh account's
    // originApp defaults to auth-service ("Melvin") and it has a password.
    expect(dupe.body.code).toBe("ACCOUNT_EXISTS");
    expect(dupe.body.account).toMatchObject({ appLabel: "Melvin", hasPassword: true });

    const rows = await UserModel.find({ email }).lean();
    expect(rows).toHaveLength(1);
  }, 30_000);

  it("names the origin app and tells a passwordless import to set a password", async () => {
    // A passwordless EasyBuy import, as migrations/import-easybuy-identities.cjs creates them.
    const email = emailOf("imported");
    await UserModel.create({
      email,
      fullName: "Chidi Nwosu",
      role: "User",
      emailVerified: true,
      disabled: false,
      originApp: "easybuy",
      // no password -> passwordless -> must set one (via reset) to sign in
    });

    const res = await register(email);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ACCOUNT_EXISTS");
    expect(res.body.account).toMatchObject({ originApp: "easybuy", appLabel: "EasyBuy", hasPassword: false });
    expect(res.body.message).toContain("EasyBuy");
    // Message routes them to a password regardless of this process's mail state; the flag is a boolean.
    expect(res.body.message).toMatch(/password/i);
    expect(typeof res.body.resetEmailSent).toBe("boolean");

    // The register attempt created nothing new.
    expect(await UserModel.countDocuments({ email })).toBe(1);
  }, 30_000);

  it("serves the password-reset page behind the email link (GET /reset-password)", async () => {
    const res = await request(app).get("/api/v1/auth/reset-password?token=anything");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/html/);
    expect(res.text).toContain("Set your password");
    // The token must not be reflected into the HTML (no reflected-XSS surface).
    expect(res.text).not.toContain("anything");
  }, 30_000);

  it("on sign-in, tells a passwordless import to set a password instead of a dead 'invalid credentials'", async () => {
    const email = emailOf("pwless-login");
    await UserModel.create({ email, fullName: "Ada Eze", role: "User", emailVerified: true, disabled: false, originApp: "easybuy" });

    const res = await request(app).post("/api/v1/auth/login").send({ email, password: "anything-they-type" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PASSWORD_SETUP_REQUIRED");
    expect(res.body.account).toMatchObject({ originApp: "easybuy", appLabel: "EasyBuy", hasPassword: false });
  }, 30_000);

  it("keeps the neutral answer for a wrong password on a normal account (no enumeration)", async () => {
    const email = emailOf("wrongpw");
    expect((await register(email)).status).toBe(201);

    const res = await request(app).post("/api/v1/auth/login").send({ email, password: "DefinitelyWrong1!" });
    expect(res.status).toBe(401);
    expect(res.body.code).toBeUndefined();
    expect(res.body.message).toMatch(/invalid credentials/i);
  }, 30_000);

  it("a completed password reset also verifies the email", async () => {
    const { issuePasswordResetToken } = await import("../Utils/authHelpers.js");
    const email = emailOf("reset-verify");
    const created = await UserModel.create({ email, fullName: "Uche M", role: "User", emailVerified: false, disabled: false, originApp: "easybuy" });

    const token = await issuePasswordResetToken(String(created._id));
    const res = await request(app).post("/api/v1/auth/reset-password").send({ token, password: "BrandNewPass1!" });
    expect(res.status).toBe(200);

    const row = await UserModel.findOne({ email }).lean();
    expect(row?.emailVerified).toBe(true);
  }, 30_000);

  it("never leaves the account unusable without saying why", async () => {
    const email = emailOf("state");
    await register(email);

    // Whichever mail state this process is in, the account must end up in exactly one of two
    // usable states: verified (mail off) or unverified-with-a-403-that-explains-it (mail on).
    const row = await UserModel.findOne({ email }).lean();
    expect(row).not.toBeNull();

    const login = await request(app).post("/api/v1/auth/login").send({ identifier: email, password: PASSWORD });
    if (row!.emailVerified) {
      expect(login.status).toBe(201);
    } else {
      // A mail problem must surface as this 403, never a 500 or a blank failure.
      expect(login.status).toBe(403);
      expect(login.body.message).toContain("verify account");
    }
  }, 30_000);

  it("a wrong password is still 401 — the mail path did not disturb authentication", async () => {
    const email = emailOf("auth");
    await register(email);
    const login = await request(app).post("/api/v1/auth/login").send({ identifier: email, password: "wrong password entirely" });
    expect(login.status).toBe(401);
  }, 30_000);
});
