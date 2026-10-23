import type { NextFunction, Request, Response } from "express";
import { decodeProtectedHeader } from "jose";
import SessionModel from "../Model/SessionModel.js";
import { platformVerifier } from "../Utils/platformTokens.js";
import { getTokenFromRequest, verifyAccessToken } from "../Utils/tokens.js";

// Accepts the legacy HS256 token and the RS256 platform token side by side, so apps can
// move to platform tokens one at a time (Shortwork/AGENTS.md §7.1). Either way the
// session must still be active: logging out stops both kinds at once.
const isPlatformToken = (token: string): boolean => {
  try {
    return decodeProtectedHeader(token).alg === "RS256";
  } catch {
    return false;
  }
};

export const verifyToken = async (req: Request, res: Response, next: NextFunction) => {
  const token = getTokenFromRequest(req.headers.cookie, req.headers.authorization);

  if (!token) {
    return res.status(401).json({ message: "please login to get token" });
  }

  try {
    if (isPlatformToken(token)) {
      const verifier = platformVerifier();
      if (!verifier) return res.status(401).json({ message: "token expire" });
      const person = await (await verifier).verifyUserToken(token);
      const activeSession = await SessionModel.findOneAndUpdate(
        { jti: person.sessionId, user: person.personId, active: true, expiresAt: { $gt: new Date() } },
        { $set: { lastSeenAt: new Date() } }
      ).lean();
      if (!activeSession) {
        return res.status(401).json({ message: "session inactive or expired" });
      }
      req.person = person;
      req.user = { _id: person.personId, email: "", fullName: "", role: person.role, jti: person.sessionId, app: activeSession.app };
      req.authToken = token;
      req.authSession = { jti: person.sessionId };
      return next();
    }

    const payload = verifyAccessToken(token);
    const activeSession = await SessionModel.findOneAndUpdate(
      {
        jti: payload.jti,
        user: payload._id,
        active: true,
        expiresAt: { $gt: new Date() },
      },
      { $set: { lastSeenAt: new Date() } }
    ).lean();

    if (!activeSession) {
      return res.status(401).json({ message: "session inactive or expired" });
    }

    req.user = payload;
    req.authToken = token;
    req.authSession = { jti: payload.jti };
    next();
  } catch (_error) {
    return res.status(401).json({ message: "token expire" });
  }
};
