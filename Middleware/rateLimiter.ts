import type { NextFunction, Request, Response } from "express";

const WINDOW_MS = 15 * 60 * 1000;
const LIMIT = 10;
const hits = new Map<string, { count: number; resetAt: number }>();

export const authRateLimiter = (req: Request, res: Response, next: NextFunction) => {
  const key = String(req.ip || req.headers["x-forwarded-for"] || "unknown");
  const now = Date.now();
  const current = hits.get(key);

  if (!current || current.resetAt <= now) {
    hits.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return next();
  }

  if (current.count >= LIMIT) {
    return res.status(429).json({
      message: "Too many auth requests. Try again later.",
    });
  }

  current.count += 1;
  hits.set(key, current);
  next();
};
