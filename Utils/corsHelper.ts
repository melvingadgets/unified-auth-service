import type { CorsOptions } from "cors";

/**
 * Checks whether an incoming HTTP Origin belongs to the Melvin platform:
 * 1. Explicitly configured origins (from CORS_ORIGINS)
 * 2. Local development on any port (localhost / 127.0.0.1)
 * 3. Official Melvin domains (melvingadgets.com, melvingadgets.app)
 * 4. Vercel deployments and preview branches (*.melvingadgets-projects.vercel.app, melvin-os*, aurapaytrack*, easybuy*, store*)
 */
export const isAllowedOrigin = (
  origin: string | undefined,
  explicitOrigins: string[] = []
): boolean => {
  if (!origin) return true; // non-browser requests (curl, mobile native, server-to-server)

  const cleanOrigin = origin.trim().replace(/\/+$/, "");

  // 1. Explicit origins configured in env
  if (explicitOrigins.includes(cleanOrigin)) return true;

  // 2. Localhost on any port (http://localhost:5173, http://127.0.0.1:3000, etc.)
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(cleanOrigin)) return true;

  // 3. Official apex and subdomains (*.melvingadgets.com, *.melvingadgets.app)
  if (/^https?:\/\/([a-z0-9-]+\.)*melvingadgets\.(com|app)$/i.test(cleanOrigin)) return true;

  // 4. Official Melvin Vercel deployments and dynamic branch previews
  if (
    /^https:\/\/([a-z0-9-]+)\.melvingadgets-projects\.vercel\.app$/i.test(cleanOrigin) ||
    /^https:\/\/melvin-os(-[a-z0-9-]+)?\.vercel\.app$/i.test(cleanOrigin) ||
    /^https:\/\/aurapaytrack(er)?(-[a-z0-9-]+)?\.vercel\.app$/i.test(cleanOrigin) ||
    /^https:\/\/easybuy(-[a-z0-9-]+)?\.vercel\.app$/i.test(cleanOrigin) ||
    /^https:\/\/store(-[a-z0-9-]+)?\.vercel\.app$/i.test(cleanOrigin)
  ) {
    return true;
  }

  return false;
};

/**
 * Returns Express CORS options that:
 * - Dynamically echoes the allowed origin so Access-Control-Allow-Credentials: true works per WHATWG spec
 * - Allows all custom platform headers (x-melvin-device, x-melvin-user, x-request-id, x-service-key, Idempotency-Key)
 * - Exposes x-request-id to browser clients for telemetry/debugging
 */
export const buildPlatformCorsOptions = (
  explicitOrigins: string[] = []
): CorsOptions => ({
  origin: (origin, callback) => {
    if (isAllowedOrigin(origin, explicitOrigins)) {
      // Reflect the exact requesting origin back so credentials: true works
      callback(null, origin || true);
    } else {
      callback(null, false);
    }
  },
  credentials: true,
  methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "Accept",
    "X-Requested-With",
    "x-melvin-device",
    "x-melvin-user",
    "x-request-id",
    "x-service-key",
    "Idempotency-Key",
  ],
  exposedHeaders: ["x-request-id"],
  optionsSuccessStatus: 204,
});
