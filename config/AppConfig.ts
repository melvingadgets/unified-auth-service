import type { AuthApp } from "../types/auth.js";

type AppConfig = {
  slug: AuthApp;
  displayName: string;
  requiresEmailVerification: boolean;
  allowPublicRegistration: boolean;
};

export const APP_CONFIG: Record<AuthApp, AppConfig> = {
  easybuy: {
    slug: "easybuy",
    displayName: "EasyBuy",
    requiresEmailVerification: false,
    allowPublicRegistration: false,
  },
  ecommerce: {
    slug: "ecommerce",
    displayName: "Melasi Store",
    requiresEmailVerification: true,
    allowPublicRegistration: true,
  },
  "auth-service": {
    slug: "auth-service",
    displayName: "Auth Service",
    requiresEmailVerification: false,
    allowPublicRegistration: false,
  },
};

export const resolveAuthApp = (value: unknown): AppConfig => {
  const normalized = String(value ?? "").trim().toLowerCase() as AuthApp;
  return APP_CONFIG[normalized] || APP_CONFIG["auth-service"];
};
