import bcrypt from "bcrypt";
import type { Request } from "express";
import mongoose from "mongoose";
import ProfileModel from "../Model/ProfileModel.js";
import SessionModel from "../Model/SessionModel.js";
import UserModel from "../Model/UserModel.js";

import { config } from "../config/Config.js";
import type { AuthApp, AuthRole, DomainRole } from "../types/auth.js";
import { DOMAIN_ROLES } from "../types/auth.js";
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
  domainRoles?: DomainRole[] | null;
  emailVerified: boolean;
  disabled: boolean;
  originApp: AuthApp;
  createdAt?: Date | string | null;
}) => ({
  _id: String(user._id),
  email: user.email ?? null,
  phone: user.phone ?? null,
  phoneVerified: Boolean(user.phoneVerified),
  fullName: user.fullName,
  role: user.role,
  // Always an array, never undefined: clients evaluate `domainRoles` directly.
  domainRoles: sanitizeDomainRoles(user.domainRoles),
  emailVerified: user.emailVerified,
  disabled: user.disabled,
  originApp: user.originApp,
  // "Member since" for the Profile app. Additive, and already exposed to services by `toPerson`
  // (PlatformInternalController), so this is not a new class of disclosure.
  createdAt: user.createdAt ? new Date(user.createdAt).toISOString() : null,
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

/**
 * Creates the profile, or updates only the fields the caller actually supplied.
 *
 * The distinction matters: `updates` is a PARTIAL patch. A field that is absent must be left as
 * it was, never reset. The first version defaulted every absent key (`?? ""`), so a caller that
 * sent only `fullName` silently erased the phone, gender, address and avatar — which is exactly
 * what `PATCH /api/v1/auth/me/profile` did (Melvin OS Profile app, 2026-10-30). On create the
 * defaults still apply, because there is nothing to preserve.
 *
 * `firstName`/`lastName` are derived from `fullName` only when the caller did not name them,
 * and only on create or when `fullName` was itself present in the patch.
 */
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
  /** True when `fullName` came from the request, so the derived names may replace the stored ones. */
  fullNameChanged?: boolean;
}) => {
  const { firstName, lastName } = parseFullName(args.fullName);
  const updates = args.updates || {};

  const created = {
    firstName: updates.firstName ?? firstName,
    lastName: updates.lastName ?? lastName,
    phoneNumber: updates.phoneNumber ?? "",
    dateOfBirth: updates.dateOfBirth ?? null,
    gender: updates.gender ?? "",
    address: updates.address ?? "",
    avatar: updates.avatar ?? "",
  };

  // Absent keys are omitted from this patch, so `$set` touches only what was supplied.
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) patch[key] = value;
  }
  if (patch.firstName === undefined && args.fullNameChanged) patch.firstName = firstName;
  if (patch.lastName === undefined && args.fullNameChanged) patch.lastName = lastName;

  const existing = await ProfileModel.findOne({ user: args.userId }).lean();
  if (!existing && !Object.keys(patch).length) {
    // Nothing to change and no row yet: create the default one.
    return ProfileModel.findOneAndUpdate({ user: args.userId }, { $set: created }, { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }).lean();
  }
  if (!existing) {
    return ProfileModel.findOneAndUpdate({ user: args.userId }, { $set: { ...created, ...patch } }, { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }).lean();
  }
  if (!Object.keys(patch).length) return existing;
  return ProfileModel.findOneAndUpdate({ user: args.userId }, { $set: patch }, { returnDocument: "after" }).lean();
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
  user: {
    _id: mongoose.Types.ObjectId | string;
    email?: string | null;
    fullName: string;
    role: AuthRole;
    domainRoles?: DomainRole[] | null;
  };
  app?: AuthApp;
  device?: Partial<{
    userAgent: string;
    ip: string;
    browser: string;
    os: string;
  }>;
}) => {
  const jti = generateJti();
  const domainRoles = sanitizeDomainRoles(args.user.domainRoles);
  const token = signAccessToken({
    _id: String(args.user._id),
    email: args.user.email ?? "",
    fullName: args.user.fullName,
    role: args.user.role,
    domainRoles,
    jti,
    app: args.app || "auth-service",
  });
  const expiresAt = decodeTokenExpiry(token);

  let platform: PlatformSessionTokens | null = null;
  if (platformSigner) {
    const access = await platformSigner.signUserToken({
      personId: String(args.user._id),
      role: args.user.role,
      domainRoles,
      sessionId: jti,
    });
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

  // Role and domain roles are read fresh on every refresh, so a change reaches tokens
  // within 15 minutes rather than at the next login.
  const access = await platformSigner.signUserToken({
    personId: String(user._id),
    role: user.role,
    domainRoles: sanitizeDomainRoles(user.domainRoles),
    sessionId: session.jti,
  });
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

// A verification link is good for a day, and sending another e-mail does not void the earlier ones:
// people open whichever copy is on top, often on another device. On 2026-10-31 a sign-in attempt
// re-sent the e-mail, the new token overwrote the old one, and the link the person then tapped
// answered "invalid or expired" (test/emailVerification.test.ts replays it).
export const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_EMAIL_VERIFICATION_TOKENS = 5;

export const issueEmailVerificationToken = async (userId: string | mongoose.Types.ObjectId) => {
  const token = generateOpaqueToken();
  await UserModel.findByIdAndUpdate(userId, {
    $push: {
      emailVerificationTokens: {
        $each: [{ hash: hashToken(token), expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS) }],
        $slice: -MAX_EMAIL_VERIFICATION_TOKENS,
      },
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

// Repeatable: tokens stay until they expire, so opening a link a second time (a double tap, or a
// mail scanner fetching it first) still answers "verified" instead of "invalid". A token can only
// ever set emailVerified on the account it was issued to.
export const consumeEmailVerificationToken = async (token: string) => {
  const hash = hashToken(token);
  const now = new Date();
  return UserModel.findOneAndUpdate(
    {
      $or: [
        { emailVerificationTokens: { $elemMatch: { hash, expiresAt: { $gt: now } } } },
        // A link mailed before 2026-11-01 sits in the legacy single field until it expires.
        { emailVerificationTokenHash: hash, emailVerificationTokenExpiresAt: { $gt: now } },
      ],
    },
    { $set: { emailVerified: true } },
    { returnDocument: "after" }
  ).lean();
};

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

const isDomainRole = (value: unknown): value is DomainRole =>
  typeof value === "string" && (DOMAIN_ROLES as readonly string[]).includes(value);

/**
 * Validates a `domainRoles` input. Unlike a role, this list is empty by default, so an
 * omitted or null value means "no domain roles" rather than an error. Anything that
 * isn't a list of known names is refused — never silently filtered, because a caller
 * asking for `markat:salesperson` and getting nothing back would look like success.
 */
export const normalizeDomainRoles = (value: unknown): DomainRole[] => {
  if (value === undefined || value === null || value === "") return [];
  if (!Array.isArray(value)) {
    throw new Error(`domainRoles must be a list of: ${DOMAIN_ROLES.join(", ")}`);
  }
  const unknown = value.filter((item) => !isDomainRole(item));
  if (unknown.length > 0) {
    throw new Error(`unknown domain role "${String(unknown[0])}"; expected one of: ${DOMAIN_ROLES.join(", ")}`);
  }
  // Dedupe: the same domain role granted twice is still one grant.
  return [...new Set(value as DomainRole[])];
};

/** The stored list, filtered for reading. Never invents a grant. */
export const sanitizeDomainRoles = (value: unknown): DomainRole[] =>
  Array.isArray(value) ? [...new Set(value.filter(isDomainRole))] : [];



/**
 * The placeholder values `.env.example` used to ship. They are non-empty, so a presence-only check
 * called them "configured" and the first sign-up then failed at send time (2026-10-30). A copied
 * `.env` must take the no-mail path, not a broken one.
 */
const MAIL_PLACEHOLDERS = [
  "re_your_api_key_here",
  "youremail@gmail.com",
  "your16charapppassword",
  "your_google_client_id_here",
  "replace_me",
  "changeme",
];

/** Non-empty AND not an example value: a placeholder is not a credential. */
const looksReal = (value: unknown): boolean => {
  const text = String(value ?? "").trim();
  if (!text) return false;
  const lower = text.toLowerCase();
  if (MAIL_PLACEHOLDERS.includes(lower)) return false;
  if (lower.includes("your_") || lower.includes("replace_") || lower.includes("example.com")) return false;
  return true;
};

/**
 * Whether there is a usable mail transport. Deliberately a LOCAL check — it never contacts the
 * provider, so startup cannot depend on a third party; a real key the provider rejects is a send
 * failure, and every caller must survive one (see `RegisterUser`).
 *
 * This is the single definition: `Utils/Mailer.ts` imports it rather than keeping its own copy,
 * because two copies of one rule is how they drift.
 */
export interface MailConfigView {
  provider: string;
  from: string;
  smtp: { gmailUser: string; gmailAppPassword: string };
  resend: { apiKey: string };
}

/**
 * The decision, as a pure function of a config value — so it is testable with any input without
 * reloading modules (Config reads the environment once, at import).
 */
export const mailIsConfigured = (mail: MailConfigView): boolean => {
  if (!looksReal(mail.from)) return false;
  if (mail.provider === "smtp") return looksReal(mail.smtp.gmailUser) && looksReal(mail.smtp.gmailAppPassword);
  if (mail.provider === "resend") return looksReal(mail.resend.apiKey);
  return false;
};

export const isMailConfigured = () => mailIsConfigured(config.mail);

export const createUserRecord = async (args: {
  email: string;
  passwordHash: string;
  fullName: string;
  role: AuthRole;
  domainRoles?: DomainRole[];
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
    domainRoles: args.domainRoles ?? [],
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
