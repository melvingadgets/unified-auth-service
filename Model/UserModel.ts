import mongoose from "mongoose";
import type { AuthApp, AuthRole, DomainRole } from "../types/auth.js";
import { DOMAIN_ROLES } from "../types/auth.js";

// A person is identified by email or phone (decision S4, 2026-10-23): at least one is
// required, each is unique when present, and a phone only signs someone in once verified.
export interface AuthUser {
  email?: string;
  phone?: string;
  phoneVerified: boolean;
  password?: string;
  googleId?: string;
  fullName: string;
  role: AuthRole;
  /** Narrow capabilities granted on top of `role`. Empty for ordinary people and staff tiers. */
  domainRoles: DomainRole[];
  emailVerified: boolean;
  disabled: boolean;
  originApp: AuthApp;
  legacyIds?: {
    easybuy?: string;
    ecommerce?: string;
  };
  /** One per verification e-mail sent (hash only), oldest first. */
  emailVerificationTokens?: Array<{ hash: string; expiresAt: Date }>;
  /** Legacy single token: links mailed before 2026-11-01 are read from here until they expire. */
  emailVerificationTokenHash?: string | null;
  emailVerificationTokenExpiresAt?: Date | null;
  passwordResetTokenHash?: string | null;
  passwordResetTokenExpiresAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface AuthUserDocument extends AuthUser, mongoose.Document {}

const UserSchema = new mongoose.Schema<AuthUserDocument>(
  {
    email: {
      type: String,
      lowercase: true,
      trim: true,
    },
    // E.164, normalised by the platform kit before it gets here.
    phone: {
      type: String,
      trim: true,
      match: /^\+[1-9]\d{7,14}$/,
    },
    phoneVerified: {
      type: Boolean,
      default: false,
    },
    password: {
      type: String,
      required: false,
      select: false,
    },
    googleId: {
      type: String,
      sparse: true,
      unique: true,
      index: true,
    },
    fullName: {
      type: String,
      required: true,
      trim: true,
    },
    role: {
      type: String,
      enum: ["User", "Admin", "SuperAdmin"],
      default: "User",
      index: true,
    },
    // Not a staff tier: `market:salesperson` grants two market permissions and nothing
    // else (docs/rbac-unification.md). Defaulted to [] so every existing row reads as
    // "no domain roles" without a backfill.
    domainRoles: {
      type: [String],
      enum: DOMAIN_ROLES,
      default: [],
    },
    emailVerified: {
      type: Boolean,
      default: false,
      index: true,
    },
    disabled: {
      type: Boolean,
      default: false,
      index: true,
    },
    originApp: {
      type: String,
      enum: ["easybuy", "ecommerce", "auth-service"],
      default: "auth-service",
    },
    legacyIds: {
      easybuy: {
        type: String,
        sparse: true,
        index: true,
      },
      ecommerce: {
        type: String,
        sparse: true,
        index: true,
      },
    },
    // Every verification link still in someone's inbox stays good until its own expiry: issuing a
    // new one used to overwrite the single hash below, so the link in each earlier e-mail stopped
    // working (2026-10-31, from production). Capped in authHelpers.issueEmailVerificationToken.
    // Entries are left in place after verifying, so a flow that ever changes `email` must clear them.
    emailVerificationTokens: {
      type: [
        {
          _id: false,
          hash: { type: String, required: true },
          expiresAt: { type: Date, required: true },
        },
      ],
      default: undefined,
      select: false,
    },
    emailVerificationTokenHash: {
      type: String,
      default: null,
    },
    emailVerificationTokenExpiresAt: {
      type: Date,
      default: null,
    },
    passwordResetTokenHash: {
      type: String,
      default: null,
    },
    passwordResetTokenExpiresAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

// Unique only where present, so people without one of them don't collide on null.
UserSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: "string" } } });
UserSchema.index({ phone: 1 }, { unique: true, partialFilterExpression: { phone: { $type: "string" } } });

UserSchema.pre("validate", function requireIdentifier(next) {
  if (!this.email && !this.phone) {
    next(new Error("a person needs an email or a phone number"));
    return;
  }
  next();
});

export default mongoose.model<AuthUserDocument>("auth_user", UserSchema);
