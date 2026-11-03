import "./setup-env.js";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { config } from "../config/Config.js";
import UserModel from "../Model/UserModel.js";
import AuthRouter from "../Router/AuthRouter.js";
import { OAuth2Client } from "google-auth-library";
import * as authHelpers from "../Utils/authHelpers.js";

// Ensure a mock googleClientId is configured for tests
config.googleClientId = "mock-google-client-id";

const app = express();
app.use(express.json());
app.use("/api/v1/auth", AuthRouter);

describe("Industry Standard Google & Email Account Merging", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    config.googleClientId = "mock-google-client-id";
  });

  it("rejects request when idToken is missing", async () => {
    const res = await request(app).post("/api/v1/auth/google").send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("idToken is required");
  });

  it("rejects token when Google reports email_verified is false (OIDC §5.1 rule)", async () => {
    vi.spyOn(OAuth2Client.prototype, "verifyIdToken").mockResolvedValue({
      getPayload: () => ({
        email: "unverified@example.com",
        email_verified: false,
        sub: "google-sub-123",
        name: "Unverified User",
      }),
    } as any);

    const res = await request(app).post("/api/v1/auth/google").send({
      idToken: "mock-unverified-token",
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("GOOGLE_EMAIL_NOT_VERIFIED");
  });

  it("detects Google account collision when email is already linked to a different googleId", async () => {
    vi.spyOn(OAuth2Client.prototype, "verifyIdToken").mockResolvedValue({
      getPayload: () => ({
        email: "existing@example.com",
        email_verified: true,
        sub: "attacker-google-sub",
        name: "Collision Attempt",
      }),
    } as any);

    vi.spyOn(UserModel, "findOne").mockReturnValue({
      select: () => ({
        lean: vi.fn().mockResolvedValue({
          _id: "user-123",
          email: "existing@example.com",
          googleId: "original-google-sub",
          emailVerified: true,
          disabled: false,
        }),
      }),
    } as any);

    const res = await request(app).post("/api/v1/auth/google").send({
      idToken: "mock-colliding-token",
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("GOOGLE_ACCOUNT_COLLISION");
  });

  it("safely merges when local email account is already verified (preserves password, links googleId)", async () => {
    vi.spyOn(OAuth2Client.prototype, "verifyIdToken").mockResolvedValue({
      getPayload: () => ({
        email: "verified-customer@example.com",
        email_verified: true,
        sub: "google-sub-999",
        name: "Verified Customer",
      }),
    } as any);

    const existingUser = {
      _id: "user-verified-456",
      email: "verified-customer@example.com",
      googleId: undefined,
      password: "hashed-existing-password",
      emailVerified: true,
      disabled: false,
      fullName: "Verified Customer",
      role: "User",
      domainRoles: [],
    };

    vi.spyOn(UserModel, "findOne").mockReturnValue({
      select: () => ({
        lean: vi.fn().mockResolvedValue(existingUser),
      }),
    } as any);

    const updateOneSpy = vi.spyOn(UserModel, "updateOne").mockResolvedValue({} as any);
    const deactivateSessionsSpy = vi.spyOn(authHelpers, "deactivateUserSessions").mockResolvedValue(1 as any);

    vi.spyOn(authHelpers, "createSessionForUser").mockResolvedValue({
      token: "mock-session-token",
      expiresAt: new Date(Date.now() + 3600_000),
      platform: {
        accessToken: "mock-access-token",
        refreshToken: "mock-refresh-token",
        expiresIn: 3600,
        tokenType: "Bearer",
      },
    } as any);

    const res = await request(app).post("/api/v1/auth/google").send({
      idToken: "mock-valid-google-token",
    });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(1);
    expect(res.body.isNewUser).toBe(false);

    // Verified auto-merge: sets googleId without unsetting password
    expect(updateOneSpy).toHaveBeenCalledWith(
      { _id: "user-verified-456" },
      { $set: { googleId: "google-sub-999" } }
    );
  });

  it("defends against Pre-Account Takeover: wipes unverified password and claims account for verified Google user", async () => {
    vi.spyOn(OAuth2Client.prototype, "verifyIdToken").mockResolvedValue({
      getPayload: () => ({
        email: "unverified-local@example.com",
        email_verified: true,
        sub: "google-sub-777",
        name: "Genuine Owner",
      }),
    } as any);

    const unverifiedAccount = {
      _id: "user-unverified-789",
      email: "unverified-local@example.com",
      googleId: undefined,
      password: "attacker-set-unverified-password",
      emailVerified: false,
      disabled: false,
      fullName: "Victim Name",
      role: "User",
      domainRoles: [],
    };

    vi.spyOn(UserModel, "findOne").mockReturnValue({
      select: () => ({
        lean: vi.fn().mockResolvedValue(unverifiedAccount),
      }),
    } as any);

    const updateOneSpy = vi.spyOn(UserModel, "updateOne").mockResolvedValue({} as any);
    const deactivateSessionsSpy = vi.spyOn(authHelpers, "deactivateUserSessions").mockResolvedValue(1 as any);

    vi.spyOn(authHelpers, "createSessionForUser").mockResolvedValue({
      token: "mock-session-token",
      expiresAt: new Date(Date.now() + 3600_000),
      platform: {
        accessToken: "mock-access-token",
        refreshToken: "mock-refresh-token",
        expiresIn: 3600,
        tokenType: "Bearer",
      },
    } as any);

    const res = await request(app).post("/api/v1/auth/google").send({
      idToken: "mock-valid-google-token",
    });

    expect(res.status).toBe(201);
    expect(res.body.isNewUser).toBe(false);

    // Crucial Pre-ATO assertion: unverified password & tokens must be purged, and sessions revoked!
    expect(deactivateSessionsSpy).toHaveBeenCalledWith("user-unverified-789");
    expect(updateOneSpy).toHaveBeenCalledWith(
      { _id: "user-unverified-789" },
      {
        $set: { googleId: "google-sub-777", emailVerified: true },
        $unset: {
          password: 1,
          emailVerificationTokens: 1,
          emailVerificationTokenHash: 1,
          emailVerificationTokenExpiresAt: 1,
        },
      }
    );
  });

  it("recognizes Google-created accounts when attempting password login", async () => {
    vi.spyOn(UserModel, "findOne").mockReturnValue({
      select: () => ({
        lean: vi.fn().mockResolvedValue({
          _id: "google-user-111",
          email: "googleuser@example.com",
          googleId: "google-sub-111",
          password: null, // no password set
          fullName: "Google User",
          originApp: "auth-service",
          role: "User",
        }),
      }),
    } as any);

    const res = await request(app).post("/api/v1/auth/login").send({
      identifier: "googleuser@example.com",
      password: "SomePassword123!",
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ACCOUNT_EXISTS");
    expect(res.body.message).toContain("This account was created with Google");
  });

  it("recognizes Google-created accounts when attempting password registration", async () => {
    vi.spyOn(UserModel, "findOne").mockReturnValue({
      select: () => ({
        lean: vi.fn().mockResolvedValue({
          _id: "google-user-222",
          email: "googleuser2@example.com",
          googleId: "google-sub-222",
          password: null, // no password set
          fullName: "Google User 2",
          originApp: "auth-service",
          role: "User",
        }),
      }),
    } as any);

    const res = await request(app).post("/api/v1/auth/register").send({
      fullName: "Google User 2",
      email: "googleuser2@example.com",
      password: "StrongPassword123!",
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ACCOUNT_EXISTS");
    expect(res.body.message).toContain("created with Google");
  });
});
