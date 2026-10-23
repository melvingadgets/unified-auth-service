// Runs before any app module is imported: Config.ts reads the environment at import time.
import { createHash, randomUUID } from "crypto";
import { generateSigningKey } from "@melvingadgets/platform-kit";

export const TEST_CLIENT_SECRETS = { store: "store-secret-for-tests", easybuy: "easybuy-secret-for-tests" };

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

process.env.DATABASE_URL = `${process.env.MONGO_TEST_URL ?? "mongodb://127.0.0.1:27017"}/auth_u1_test_${randomUUID().slice(0, 8)}`;
process.env.AUTH_JWT_SECRET = "legacy-test-secret";
// The suite logs in far more than 10 times; the limiter itself is tested on its own.
process.env.AUTH_RATE_LIMIT = "1000";
process.env.AUTH_SERVICE_PUBLIC_URL = "http://auth.test";
process.env.AUTH_SIGNING_KEYS_B64 = Buffer.from(JSON.stringify([generateSigningKey("test-key")])).toString("base64");
process.env.AUTH_ACTIVE_KID = "test-key";
process.env.AUTH_OAUTH_CLIENTS_B64 = Buffer.from(
  JSON.stringify([
    { clientId: "svc-store", service: "store", secretHash: sha256(TEST_CLIENT_SECRETS.store) },
    { clientId: "svc-easybuy", service: "easybuy", secretHash: sha256(TEST_CLIENT_SECRETS.easybuy) },
  ])
).toString("base64");
// No mail transport: registration verifies the email immediately.
delete process.env.MAIL_FROM;
delete process.env.RESEND_API_KEY;
delete process.env.GMAIL_USER;
