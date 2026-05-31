import mongoose from "mongoose";
import type { AuthApp, AuthRole } from "../types/auth.js";

export interface AuthUser {
  email: string;
  password: string;
  fullName: string;
  role: AuthRole;
  emailVerified: boolean;
  disabled: boolean;
  originApp: AuthApp;
  legacyIds?: {
    easybuy?: string;
    ecommerce?: string;
  };
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
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    password: {
      type: String,
      required: true,
      select: false,
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

export default mongoose.model<AuthUserDocument>("auth_user", UserSchema);
