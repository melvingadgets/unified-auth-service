import { createHash, timingSafeEqual } from "crypto";
import type { Request, Response } from "express";
import { SERVICE_TOKEN_TTL_SECONDS, isGranted, isScope, isServiceId, type Scope } from "@melvingadgets/platform-kit";
import { config } from "../config/Config.js";
import { platformSigner } from "../Utils/platformTokens.js";

// OAuth 2.0 client credentials (RFC 6749 §4.4) and the public JWKS
// (Shortwork/AGENTS.md §2.1, §2.3). Errors use the RFC's error codes and never
// say which part of the credentials was wrong.

export const hashClientSecret = (secret: string): string => createHash("sha256").update(secret, "utf8").digest("hex");

const secretMatches = (secret: string, storedHash: string): boolean => {
  const given = Buffer.from(hashClientSecret(secret), "hex");
  const stored = Buffer.from(storedHash, "hex");
  return given.length === stored.length && timingSafeEqual(given, stored);
};

// Compared against when the client id is unknown, so both paths cost the same.
const UNKNOWN_CLIENT_HASH = hashClientSecret("unknown-client");

const oauthError = (res: Response, status: number, error: string) => {
  if (status === 401) res.set("WWW-Authenticate", 'Basic realm="melvin-auth"');
  return res.status(status).json({ error });
};

// RFC 6749 §2.3.1: Basic credentials are form-urlencoded before base64.
const clientCredentials = (req: Request): { clientId: string; clientSecret: string } | null => {
  const header = req.get("authorization") ?? "";
  if (/^Basic\s+/i.test(header)) {
    const decoded = Buffer.from(header.replace(/^Basic\s+/i, ""), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator <= 0) return null;
    try {
      return {
        clientId: decodeURIComponent(decoded.slice(0, separator)),
        clientSecret: decodeURIComponent(decoded.slice(separator + 1)),
      };
    } catch {
      return null;
    }
  }
  const clientId = typeof req.body?.client_id === "string" ? req.body.client_id : "";
  const clientSecret = typeof req.body?.client_secret === "string" ? req.body.client_secret : "";
  return clientId && clientSecret ? { clientId, clientSecret } : null;
};

export const Jwks = async (_req: Request, res: Response) => {
  if (!platformSigner) return res.status(503).json({ error: "temporarily_unavailable" });
  res.set("Cache-Control", "public, max-age=300");
  return res.status(200).json(await platformSigner.jwks());
};

// Synchronous apart from signing: no database read, so a slow database can't hold up service calls.
export const IssueServiceToken = async (req: Request, res: Response) => {
  res.set("Cache-Control", "no-store");
  res.set("Pragma", "no-cache");

  if (req.body?.grant_type !== "client_credentials") return oauthError(res, 400, "unsupported_grant_type");

  const credentials = clientCredentials(req);
  if (!credentials) return oauthError(res, 401, "invalid_client");

  const audience = req.body?.audience;
  const requested = typeof req.body?.scope === "string" ? req.body.scope.split(" ").filter(Boolean) : [];
  if (!isServiceId(audience) || requested.length === 0) return oauthError(res, 400, "invalid_request");
  if (!requested.every(isScope)) return oauthError(res, 400, "invalid_scope");
  const scopes = [...new Set(requested as Scope[])];

  const client = config.oauthClients.find((candidate) => candidate.clientId === credentials.clientId);
  const valid = secretMatches(credentials.clientSecret, client?.secretHash ?? UNKNOWN_CLIENT_HASH) && Boolean(client);
  if (!client || !valid || !isServiceId(client.service)) return oauthError(res, 401, "invalid_client");

  // The request log records the verified client from here on.
  req.service = { id: client.service };

  if (!isGranted(client.service, audience, scopes)) return oauthError(res, 400, "invalid_scope");
  if (!platformSigner) return oauthError(res, 503, "temporarily_unavailable");

  const { token } = await platformSigner.signServiceToken({ caller: client.service, audience, scopes });
  return res.status(200).json({
    access_token: token,
    token_type: "Bearer",
    expires_in: SERVICE_TOKEN_TTL_SECONDS,
    scope: [...scopes].sort().join(" "),
  });
};
