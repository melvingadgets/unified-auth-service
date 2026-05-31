import bcrypt from "bcrypt";
import type { Request } from "express";
import mongoose from "mongoose";
import ProfileModel from "../Model/ProfileModel.js";
import SessionModel from "../Model/SessionModel.js";
import UserModel from "../Model/UserModel.js";
import { resolveAuthApp } from "../config/AppConfig.js";
import { config } from "../config/Config.js";
import type { AuthApp, AuthRole } from "../types/auth.js";
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
  email: string;
  fullName: string;
  role: AuthRole;
  emailVerified: boolean;
  disabled: boolean;
  originApp: AuthApp;
}) => ({
  _id: String(user._id),
  email: user.email,
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

export const createSessionForUser = async (args: {
  user: { _id: mongoose.Types.ObjectId | string; email: string; fullName: string; role: AuthRole };
  app: AuthApp;
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
    email: args.user.email,
    fullName: args.user.fullName,
    role: args.user.role,
    jti,
    app: args.app,
  });
  const expiresAt = decodeTokenExpiry(token);

  await SessionModel.create({
    user: args.user._id,
    jti,
    active: true,
    app: args.app,
    device: {
      userAgent: args.device?.userAgent || "",
      ip: args.device?.ip || "",
      browser: args.device?.browser || "",
      os: args.device?.os || "",
    },
    loginAt: new Date(),
    lastSeenAt: new Date(),
    expiresAt,
  });

  return {
    token,
    jti,
    expiresAt,
  };
};

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

export const resolveLoginApp = (value: unknown) => resolveAuthApp(value).slug;

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

export const shouldRequireEmailVerification = (app: AuthApp): boolean =>
  resolveAuthApp(app).requiresEmailVerification;

export const isMailConfigured = () =>
  Boolean(config.mail.from && config.mail.smtp.gmailUser && config.mail.smtp.gmailAppPassword);

export const createUserRecord = async (args: {
  email: string;
  passwordHash: string;
  fullName: string;
  role: AuthRole;
  app: AuthApp;
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
    originApp: args.app,
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
