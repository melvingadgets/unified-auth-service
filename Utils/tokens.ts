import { createHash, randomBytes, randomUUID } from "crypto";
import jwt, { type JwtPayload } from "jsonwebtoken";
import { config } from "../config/Config.js";
import type { AuthApp, AuthRole, JwtUserPayload } from "../types/auth.js";

const ACCESS_TOKEN_TTL_SECONDS = 40 * 60;

export const hashToken = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export const generateOpaqueToken = (): string =>
  randomBytes(32).toString("hex");

export const generateJti = (): string => randomUUID();

export const signAccessToken = (payload: {
  _id: string;
  email: string;
  fullName: string;
  role: AuthRole;
  jti: string;
  app: AuthApp;
}): string =>
  jwt.sign(payload, config.jwtSecret, {
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
  });

export const decodeTokenExpiry = (token: string): Date => {
  const decoded = jwt.decode(token) as JwtPayload | null;
  if (decoded?.exp) {
    return new Date(decoded.exp * 1000);
  }
  return new Date(Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000);
};

export const verifyAccessToken = (token: string): JwtUserPayload =>
  jwt.verify(token, config.jwtSecret) as JwtUserPayload;

export const getTokenFromRequest = (cookieHeader?: string, authHeader?: string): string => {
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.split(" ")[1] || "";
  }

  if (!cookieHeader) return "";

  const sessionCookie = cookieHeader
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith("sessionId="));

  return sessionCookie?.split("=")[1] || "";
};
