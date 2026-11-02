import express from "express";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Reported from production on 2026-10-31: a person tried to sign in before tapping the link in
// their verification e-mail. The 403 login sends a fresh e-mail with a new token — and issuing it
// overwrote the only stored hash, so the link they then tapped on their phone answered
// "Verification link is invalid or expired", twice. Every retry sent another e-mail and voided the
// one before it, so the person could not get in at all.
//
// The rule now: every link e-mailed stays good until its own expiry (the newest
// MAX_EMAIL_VERIFICATION_TOKENS of them), and opening a link again after it worked still says
// "verified". These tests replay the production sequence over HTTP.

// Mail must count as configured so registration and login send verification links. The sender is
// replaced, so nothing leaves the process and the test can read the links it would have mailed.
// Config reads the environment once, at import: the app modules are imported in beforeAll.
process.env.MAIL_PROVIDER = "resend";
process.env.RESEND_API_KEY = "re_9f3ab21c8d7e6504";
process.env.MAIL_FROM = "Melvin <noreply@verifications.melvingadgets.app>";

const mailed: Array<{ to: string; verifyUrl: string }> = [];

vi.mock("../Utils/Mailer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../Utils/Mailer.js")>();
  return {
    ...actual,
    sendVerificationEmail: vi.fn(async (args: { to: string; fullName: string; verifyUrl: string }) => {
      mailed.push({ to: args.to, verifyUrl: args.verifyUrl });
    }),
  };
});

const PASSWORD = "correct horse battery";

let app: express.Application;
let UserModel: typeof import("../Model/UserModel.js").default;
let helpers: typeof import("../Utils/authHelpers.js");
let tokens: typeof import("../Utils/tokens.js");

beforeAll(async () => {
  const db = await import("../Database/Database.js");
  await db.default;
  const { MainApp } = await import("../MainApp.js");
  UserModel = (await import("../Model/UserModel.js")).default;
  helpers = await import("../Utils/authHelpers.js");
  tokens = await import("../Utils/tokens.js");
  app = express();
  MainApp(app);
}, 30_000);

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const emailOf = (label: string) => `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
const register = (email: string) => request(app).post("/api/v1/auth/register").send({ fullName: "Ada Obi", email, password: PASSWORD });
const login = (email: string) => request(app).post("/api/v1/auth/login").send({ identifier: email, password: PASSWORD });

/** The path of every verification link mailed to `email`, oldest first. */
const linksTo = (email: string) => mailed.filter((m) => m.to === email).map((m) => new URL(m.verifyUrl).pathname);
const open = (path: string) => request(app).get(path);
const isVerified = async (email: string) => Boolean((await UserModel.findOne({ email }).lean())?.emailVerified);

describe("mail is on for this file", () => {
  it("registration sends a verification link and leaves the account unverified", async () => {
    expect(helpers.isMailConfigured()).toBe(true);
    const email = emailOf("on");
    expect((await register(email)).status).toBe(201);
    expect(linksTo(email)).toHaveLength(1);
    expect(await isVerified(email)).toBe(false);
  });
});

describe("a newer verification e-mail does not void an older one", () => {
  it("the production sequence: register, sign in too early (403, second e-mail), tap the FIRST link", async () => {
    const email = emailOf("first-link");
    expect((await register(email)).status).toBe(201);

    const early = await login(email);
    expect(early.status).toBe(403);
    expect(early.body.message).toContain("verify account");
    // The client keys the "check your email" screen off this code, not the prose.
    expect(early.body.code).toBe("EMAIL_NOT_VERIFIED");

    const [first, second] = linksTo(email);
    expect(second).toBeDefined();
    expect(second).not.toBe(first);

    const opened = await open(first);
    expect(opened.status).toBe(200);
    expect(opened.text).toContain("verified");
    expect(await isVerified(email)).toBe(true);
    expect((await login(email)).status).toBe(201);
  });

  it("every link from repeated sign-in attempts works, in any order", async () => {
    const email = emailOf("any-order");
    await register(email);
    await login(email);
    await login(email);
    const links = linksTo(email);
    expect(links).toHaveLength(3);

    // The middle one first — whichever copy the person opens.
    expect((await open(links[1])).status).toBe(200);
    expect(await isVerified(email)).toBe(true);
    expect((await open(links[0])).status).toBe(200);
    expect((await open(links[2])).status).toBe(200);
  });

  it("keeps only the newest MAX_EMAIL_VERIFICATION_TOKENS links", async () => {
    const email = emailOf("cap");
    await register(email);
    for (let i = 0; i < helpers.MAX_EMAIL_VERIFICATION_TOKENS; i += 1) await login(email);
    const links = linksTo(email);
    expect(links).toHaveLength(helpers.MAX_EMAIL_VERIFICATION_TOKENS + 1);

    expect((await open(links[0])).status).toBe(400);
    expect(await isVerified(email)).toBe(false);
    expect((await open(links[1])).status).toBe(200);
    expect(await isVerified(email)).toBe(true);
  });
});

describe("opening a link is safe to repeat", () => {
  it("opening the same link twice says verified both times (a double tap, or a mail scanner first)", async () => {
    const email = emailOf("twice");
    await register(email);
    const [link] = linksTo(email);

    const firstOpen = await open(link);
    const secondOpen = await open(link);
    expect(firstOpen.status).toBe(200);
    expect(secondOpen.status).toBe(200);
    expect(secondOpen.text).toContain("verified");
  });
});

describe("what a link can never do", () => {
  it("an unknown token is refused and verifies nobody", async () => {
    const email = emailOf("unknown");
    await register(email);
    const refused = await open("/api/v1/auth/verify-email/not-a-token-we-issued");
    expect(refused.status).toBe(400);
    expect(await isVerified(email)).toBe(false);
  });

  it("an expired link is refused", async () => {
    const email = emailOf("expired");
    await register(email);
    const [link] = linksTo(email);
    await UserModel.updateOne({ email }, { $set: { "emailVerificationTokens.$[].expiresAt": new Date(Date.now() - 1_000) } });

    expect((await open(link)).status).toBe(400);
    expect(await isVerified(email)).toBe(false);
  });

  it("a link verifies only the account it was mailed for", async () => {
    const a = emailOf("owner-a");
    const b = emailOf("owner-b");
    await register(a);
    await register(b);
    const [linkA] = linksTo(a);

    expect((await open(linkA)).status).toBe(200);
    expect(await isVerified(a)).toBe(true);
    expect(await isVerified(b)).toBe(false);
  });

  it("each link expires a day after it was sent", async () => {
    const email = emailOf("ttl");
    await register(email);
    const row = await UserModel.findOne({ email }).select("+emailVerificationTokens").lean();
    const expiresAt = row?.emailVerificationTokens?.[0]?.expiresAt;
    expect(expiresAt).toBeInstanceOf(Date);
    const ttl = (expiresAt as Date).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(helpers.EMAIL_VERIFICATION_TTL_MS - 60_000);
    expect(ttl).toBeLessThanOrEqual(helpers.EMAIL_VERIFICATION_TTL_MS);
  });
});

describe("links mailed before the fix shipped", () => {
  it("a token in the old single-hash fields still verifies until it expires", async () => {
    const email = emailOf("legacy");
    const token = "legacy-token-mailed-before-the-deploy";
    await UserModel.create({
      email,
      fullName: "Ada Obi",
      password: await helpers.hashPassword(PASSWORD),
      role: "User",
      emailVerified: false,
      emailVerificationTokenHash: tokens.hashToken(token),
      emailVerificationTokenExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });

    expect((await open(`/api/v1/auth/verify-email/${token}`)).status).toBe(200);
    expect(await isVerified(email)).toBe(true);
  });
});
