import mongoose from "mongoose";
import type { AuthApp } from "../types/auth.js";

type DeviceInfo = {
  userAgent?: string;
  ip?: string;
  browser?: string;
  os?: string;
};

export interface AuthSession {
  user: mongoose.Types.ObjectId;
  jti: string;
  active: boolean;
  app: AuthApp;
  device?: DeviceInfo;
  loginAt: Date;
  logoutAt?: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface AuthSessionDocument extends AuthSession, mongoose.Document {}

const SessionSchema = new mongoose.Schema<AuthSessionDocument>(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "auth_user",
      required: true,
      index: true,
    },
    jti: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    active: {
      type: Boolean,
      default: true,
      index: true,
    },
    app: {
      type: String,
      enum: ["easybuy", "ecommerce", "auth-service"],
      required: true,
      index: true,
    },
    device: {
      userAgent: {
        type: String,
        default: "",
      },
      ip: {
        type: String,
        default: "",
      },
      browser: {
        type: String,
        default: "",
      },
      os: {
        type: String,
        default: "",
      },
    },
    loginAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    logoutAt: {
      type: Date,
      default: null,
    },
    lastSeenAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

SessionSchema.index({ active: 1, expiresAt: 1 });
SessionSchema.index({ user: 1, active: 1 });
SessionSchema.index({ jti: 1, user: 1, active: 1 });

export default mongoose.model<AuthSessionDocument>("auth_session", SessionSchema);
