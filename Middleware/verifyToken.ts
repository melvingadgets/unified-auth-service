import type { NextFunction, Request, Response } from "express";
import SessionModel from "../Model/SessionModel.js";
import { getTokenFromRequest, verifyAccessToken } from "../Utils/tokens.js";

export const verifyToken = async (req: Request, res: Response, next: NextFunction) => {
  const token = getTokenFromRequest(req.headers.cookie, req.headers.authorization);

  if (!token) {
    return res.status(401).json({ message: "please login to get token" });
  }

  try {
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
