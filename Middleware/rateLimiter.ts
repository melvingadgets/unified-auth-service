import type { NextFunction, Request, Response } from "express";

// In-memory fixed-window limiter, one bucket map per limiter. Keyed on req.ip,
// which is the real client address only because MainApp sets `trust proxy`
// (Railway puts one proxy in front of the service).
export const rateLimiter = ({ windowMs, limit, message }: { windowMs: number; limit: number; message: string }) => {
  const hits = new Map<string, { count: number; resetAt: number }>();

  return (req: Request, res: Response, next: NextFunction) => {
    const key = String(req.ip || "unknown");
    const now = Date.now();
    const current = hits.get(key);

    if (!current || current.resetAt <= now) {
      // Drop expired buckets now and then so the map can't grow without bound.
      if (hits.size > 10_000) {
        for (const [bucketKey, bucket] of hits) if (bucket.resetAt <= now) hits.delete(bucketKey);
      }
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (current.count >= limit) {
      res.set("Retry-After", String(Math.ceil((current.resetAt - now) / 1000)));
      return res.status(429).json({ message });
    }

    current.count += 1;
    next();
  };
};

export const authRateLimiter = rateLimiter({
  windowMs: 15 * 60 * 1000,
  // Login, register and recovery attempts per client IP per 15 minutes.
  limit: Number(process.env.AUTH_RATE_LIMIT ?? 10) || 10,
  message: "Too many auth requests. Try again later.",
});

// Services renew 5-minute tokens per audience and scope set; this is generous for that
// and still stops a client-secret guessing run.
export const tokenRateLimiter = rateLimiter({
  windowMs: 60 * 1000,
  limit: 120,
  message: "Too many token requests. Try again later.",
});
