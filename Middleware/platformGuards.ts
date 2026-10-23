import type { NextFunction, Request, Response } from "express";
import { requireServiceToken, requireUserToken, type Scope, type TokenVerifier } from "@melvingadgets/platform-kit";
import { platformVerifier } from "../Utils/platformTokens.js";

type Handler = (req: Request, res: Response, next: NextFunction) => void;

// The platform kit's guards, bound to auth's own keys. 503 while RS256 isn't configured.
const withVerifier =
  (build: (verifier: TokenVerifier) => Handler): Handler =>
  (req, res, next) => {
    const pending = platformVerifier();
    if (!pending) {
      res.status(503).json({ message: "platform tokens are not configured" });
      return;
    }
    pending.then((verifier) => build(verifier)(req, res, next), next);
  };

export const requireAuthScope = (scope: Scope): Handler =>
  withVerifier((verifier) => requireServiceToken(verifier, { audience: "auth", scope }) as unknown as Handler);

export const requirePlatformUser: Handler = withVerifier((verifier) => requireUserToken(verifier) as unknown as Handler);
