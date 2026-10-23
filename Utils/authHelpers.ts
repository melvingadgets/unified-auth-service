import bcrypt from "bcrypt";
import type { Request } from "express";
import mongoose from "mongoose";
import ProfileModel from "../Model/ProfileModel.js";
import SessionModel from "../Model/SessionModel.js";
import UserModel from "../Model/UserModel.js";

import { config } from "../config/Config.js";
import type { AuthApp, AuthRole } from "../types/auth.js";
import { platformSigner } from "./platformTokens.js";
import {
  decodeTokenExpiry,
  generateJti,
  generateOpaqueToken,
  hashToken,
  signAccessToken,
} from "./tokens.js";

const SALT_ROUNDS = 10;

export const parseFullName = (fullName: string) => {
  const trimmed = fullName.trim();
  const [firstName = "", ...rest] = trimmed.split(/\s+/);
  return {
    firstName,
    lastName: rest.join(" "),
  };
};

export const toSafeUser = (user: {
  _id: mongoose.Types.ObjectId | string;
  email?: string | null;
  phone?: string | null;
  phoneVerified?: boolean;
  fullName: string;
  role: AuthRole;
  emailVerified: boolean;
  disabled: boolean;
  originApp: AuthApp;
}) => ({
  _id: String(user._id),
  email: user.email ?? null,
  phone: user.phone ?? null,
  phoneVerified: Boolean(user.phoneVerified),
  fullName: user.fullName,
  role: user.role,
  emailVerified: user.emailVerified,
  disabled: user.disabled,
  originApp: user.originApp,
});

export const toSafeProfile = (profile: {
  firstName?: string;
  lastName?: string;
  phoneNumber?: string;
  dateOfBirth?: Date | null;
  gender?: string;
  address?: string;
  avatar?: string;
} | null) =>
  profile
    ? {
        firstName: profile.firstName || "",
        lastName: profile.lastName || "",
        phoneNumber: profile.phoneNumber || "",
        dateOfBirth: profile.dateOfBirth || null,
        gender: profile.gender || "",
        address: profile.address || "",
        avatar: profile.avatar || "",
      }
    : null;

export const hashPassword = async (password: string) => bcrypt.hash(password, SALT_ROUNDS);

export const comparePassword = async (password: string, hashedPassword: string) =>
  bcrypt.compare(password, hashedPassword);

export const ensurePasswordStrength = (password: string) => {
  if (String(password).length < 8) {
    throw new Error("password must not be less than eight characters");
  }
};

export const createOrUpdateProfileForUser = async (args: {
  userId: string | mongoose.Types.ObjectId;
  fullName: string;
  updates?: Partial<{
    firstName: string;
    lastName: string;
    phoneNumber: string;
    dateOfBirth: Date | null;
    gender: string;
    address: string;
    avatar: string;
  }>;
}) => {
  const { firstName, lastName } = parseFullName(args.fullName);
  const updates = args.updates || {};
  return ProfileModel.findOneAndUpdate(
    { user: args.userId },
    {
      $set: {
        firstName: updates.firstName ?? firstName,
        lastName: updates.lastName ?? lastName,
        phoneNumber: updates.phoneNumber ?? "",
        dateOfBirth: updates.dateOfBirth ?? null,
        gender: updates.gender ?? "",
        address: updates.address ?? "",
        avatar: updates.avatar ?? "",
      },
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
  ).lean();
};

// RS256 tokens for a session (Shortwork/AGENTS.md §2): a 15-minute access token whose
// `sid` is the session's jti, and an opaque refresh token stored only as a hash.
export type PlatformSessionTokens = {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
};

export const createSessionForUser = async (args: {
  user: { _id: mongoose.Types.ObjectId | string; email?: string | null; fullName: string; role: AuthRole };
  app?: AuthApp;
  device?: Partial<{
    userAgent: string;
    ip: string;
    browser: string;
    os: string;
  }>;
}) => {
  const jti = generateJti();
  const token = signAccessToken({
    _id: String(args.user._id),
    email: args.user.email ?? "",
    fullName: args.user.fullName,
    role: args.user.role,
    jti,
    app: args.app || "auth-service",
  });
  const expiresAt = decodeTokenExpiry(token);

  let platform: PlatformSessionTokens | null = null;
  if (platformSigner) {
    const access = await platformSigner.signUserToken({ personId: String(args.user._id), role: args.user.role, sessionId: jti });
    platform = {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: generateOpaqueToken(),
      refreshTokenExpiresAt: new Date(Date.now() + config.refreshTokenTtlDays * 24 * 60 * 60 * 1000),
    };
  }

  await SessionModel.create({
    user: args.user._id,
    jti,
    active: true,
    app: args.app || "auth-service",
    device: {
      userAgent: args.device?.userAgent || "",
      ip: args.device?.ip || "",
      browser: args.device?.browser || "",
      os: args.device?.os || "",
    },
    loginAt: new Date(),
    lastSeenAt: new Date(),
    // With a refresh token the session lives until it expires; the legacy token still dies at 40 min.
    expiresAt: platform ? platform.refreshTokenExpiresAt : expiresAt,
    refreshTokenHash: platform ? hashToken(platform.refreshToken) : null,
  });

  return {
    token,
    jti,
    expiresAt,
    platform,
  };
};

// A replayed refresh token inside this window is a client race (two tabs refreshing at
// once), not theft: it's refused without revoking the session.
const REFRESH_REUSE_GRACE_MS = 10_000;

export type RefreshOutcome =
  | { status: "ok"; tokens: PlatformSessionTokens }
  | { status: "invalid" }
  | { status: "revoked" };

/**
 * Exchanges a refresh token for a new access + refresh pair. The swap is one atomic
 * update keyed on the current hash, so two concurrent uses can't both succeed. Presenting
 * an already-rotated token after the grace window means it leaked: the session is revoked.
 */
export const rotateRefreshToken = async (presented: string): Promise<RefreshOutcome> => {
  if (!platformSigner || !presented) return { status: "invalid" };
  const presentedHash = hashToken(presented);
  const now = new Date();
  const next = generateOpaqueToken();

  const session = await SessionModel.findOneAndUpdate(
    { refreshTokenHash: presentedHash, active: true, expiresAt: { $gt: now } },
    {
      $set: {
        refreshTokenHash: hashToken(next),
        previousRefreshTokenHash: presentedHash,
        refreshRotatedAt: now,
        lastSeenAt: now,
      },
    },
    { returnDocument: "after" }
  ).lean();

  if (!session) {
    const replayed = await SessionModel.findOne({ previousRefreshTokenHash: presentedHash, active: true }).lean();
    if (replayed && now.getTime() - (replayed.refreshRotatedAt?.getTime() ?? 0) > REFRESH_REUSE_GRACE_MS) {
      await revokeSession(replayed._id);
      return { status: "revoked" };
    }
    return { status: "invalid" };
  }

  const user = await UserModel.findById(session.user).lean();
  if (!user || user.disabled) {
    await revokeSession(session._id);
    return { status: "revoked" };
  }

  // The role is read fresh on every refresh, so a role change reaches tokens within 15 minutes.
  const access = await platformSigner.signUserToken({ personId: String(user._id), role: user.role, sessionId: session.jti });
  return {
    status: "ok",
    tokens: {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: next,
      refreshTokenExpiresAt: session.expiresAt,
    },
  };
};

const revokeSession = (sessionId: mongoose.Types.ObjectId | string) =>
  SessionModel.updateOne(
    { _id: sessionId },
    { $set: { active: false, logoutAt: new Date(), refreshTokenHash: null, previousRefreshTokenHash: null } }
  );

/** The platform-token fields added to login responses; empty while RS256 isn't configured. */
export const platformTokenFields = (platform: PlatformSessionTokens | null) =>
  platform
    ? {
        accessToken: platform.accessToken,
        accessTokenExpiresAt: platform.accessTokenExpiresAt,
        refreshToken: platform.refreshToken,
        refreshTokenExpiresAt: platform.refreshTokenExpiresAt,
      }
    : {};

export const buildDeviceInfo = (req: Request, input?: Record<string, unknown>) => ({
  userAgent: String(input?.userAgent ?? req.get("user-agent") ?? "").trim(),
  ip: (String(input?.ip ?? req.get("x-forwarded-for") ?? req.ip ?? "").split(",")[0] || "").trim(),
  browser: String(input?.browser ?? "").trim(),
  os: String(input?.os ?? "").trim(),
});

export const issueEmailVerificationToken = async (userId: string | mongoose.Types.ObjectId) => {
  const token = generateOpaqueToken();
  await UserModel.findByIdAndUpdate(userId, {
    $set: {
      emailVerificationTokenHash: hashToken(token),
      emailVerificationTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  return token;
};

export const issuePasswordResetToken = async (userId: string | mongoose.Types.ObjectId) => {
  const token = generateOpaqueToken();
  await UserModel.findByIdAndUpdate(userId, {
    $set: {
      passwordResetTokenHash: hashToken(token),
      passwordResetTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  return token;
};

export const consumeEmailVerificationToken = async (token: string) =>
  UserModel.findOneAndUpdate(
    {
      emailVerificationTokenHash: hashToken(token),
      emailVerificationTokenExpiresAt: { $gt: new Date() },
    },
    {
      $set: {
        emailVerified: true,
      },
      $unset: {
        emailVerificationTokenHash: 1,
        emailVerificationTokenExpiresAt: 1,
      },
    },
    { returnDocument: "after" }
  ).lean();

export const consumePasswordResetToken = async (token: string, nextPasswordHash: string) =>
  UserModel.findOneAndUpdate(
    {
      passwordResetTokenHash: hashToken(token),
      passwordResetTokenExpiresAt: { $gt: new Date() },
    },
    {
      $set: {
        password: nextPasswordHash,
      },
      $unset: {
        passwordResetTokenHash: 1,
        passwordResetTokenExpiresAt: 1,
      },
    },
    { returnDocument: "after" }
  ).select("+password");



export const buildVerifyUrl = (token: string) =>
  `${config.publicBaseUrl}/api/v1/auth/verify-email/${encodeURIComponent(token)}`;

export const buildResetUrl = (token: string) =>
  `${config.publicBaseUrl}/api/v1/auth/reset-password?token=${encodeURIComponent(token)}`;

export const deactivateUserSessions = async (userId: string | mongoose.Types.ObjectId, exceptJti?: string) => {
  const filter: Record<string, unknown> = {
    user: userId,
    active: true,
  };

  if (exceptJti) {
    filter.jti = { $ne: exceptJti };
  }

  await SessionModel.updateMany(filter, {
    $set: {
      active: false,
      logoutAt: new Date(),
      lastSeenAt: new Date(),
      refreshTokenHash: null,
      previousRefreshTokenHash: null,
    },
  });
};

export const findUserWithProfile = async (userId: string) => {
  const [user, profile] = await Promise.all([
    UserModel.findById(userId).lean(),
    ProfileModel.findOne({ user: userId }).lean(),
  ]);

  if (!user) return null;

  return {
    user: toSafeUser(user),
    profile: toSafeProfile(profile),
  };
};

export const normalizeRoleInput = (value: unknown): AuthRole => {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "user") return "User";
  if (normalized === "admin") return "Admin";
  if (normalized === "superadmin") return "SuperAdmin";
  throw new Error("role must be one of: User, Admin, SuperAdmin");
};



export const isMailConfigured = () =>
  Boolean(
    config.mail.from &&
      ((config.mail.provider === "smtp" && config.mail.smtp.gmailUser && config.mail.smtp.gmailAppPassword) ||
        (config.mail.provider === "resend" && config.mail.resend.apiKey))
  );

export const createUserRecord = async (args: {
  email: string;
  passwordHash: string;
  fullName: string;
  role: AuthRole;
  originApp?: AuthApp;
  emailVerified: boolean;
  legacyIds?: {
    easybuy?: string;
    ecommerce?: string;
  };
}) => {
  const payload: Record<string, unknown> = {
    email: args.email,
    password: args.passwordHash,
    fullName: args.fullName,
    role: args.role,
    emailVerified: args.emailVerified,
    disabled: false,
    originApp: args.originApp || "auth-service",
  };

  if (args.legacyIds) {
    payload.legacyIds = args.legacyIds;
  }

  const user = new UserModel(payload);
  await user.save();

  await createOrUpdateProfileForUser({
    userId: user._id,
    fullName: args.fullName,
  });

  return user;
};
