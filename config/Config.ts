import dotenv from "dotenv";

dotenv.config();

const portValue = String(process.env.PORT ?? "5500").trim();
const databaseUrl = String(process.env.DATABASE_URL ?? process.env.Database_url ?? "").trim();
const jwtSecret = String(process.env.AUTH_JWT_SECRET ?? process.env.JWT_SECRET ?? "").trim();
const serviceKey = String(process.env.AUTH_SERVICE_KEY ?? "").trim();
const publicBaseUrl = String(process.env.AUTH_SERVICE_PUBLIC_URL ?? `http://localhost:${portValue}`).trim();
const corsOrigins = String(process.env.CORS_ORIGINS ?? "").trim();
const mailFrom = String(process.env.MAIL_FROM ?? "").trim();
const mailProviderRaw = String(process.env.MAIL_PROVIDER ?? "smtp").trim().toLowerCase();
const gmailUser = String(process.env.GMAIL_USER ?? "").trim();
const gmailAppPassword = String(process.env.GMAIL_APP_PASSWORD ?? "").trim();

const missing: string[] = [];
if (!databaseUrl) missing.push("DATABASE_URL");
if (!jwtSecret) missing.push("AUTH_JWT_SECRET (or JWT_SECRET)");

if (missing.length > 0) {
  throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
}

export const config = {
  port: Number(portValue) || 5500,
  databaseUrl,
  jwtSecret,
  serviceKey,
  publicBaseUrl,
  corsOrigins: corsOrigins
    ? corsOrigins.split(",").map((origin) => origin.trim()).filter(Boolean)
    : [],
  mail: {
    provider: mailProviderRaw === "smtp" ? "smtp" : "smtp",
    from: mailFrom,
    smtp: {
      gmailUser,
      gmailAppPassword,
    },
  },
};
