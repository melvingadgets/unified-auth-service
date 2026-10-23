import { randomUUID } from "crypto";
import type { NextFunction, Request, Response } from "express";

// One JSON line per request (Shortwork/AGENTS.md §6). The field names are a
// cross-service contract: every backend's logger emits exactly this shape.
// Never add headers, bodies, tokens, emails or phone numbers to it.

type CallerType = "service" | "user" | "anonymous";

const TRACE_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

const resolveTraceId = (req: Request): string => {
  const incoming = req.headers["x-request-id"];
  const value = Array.isArray(incoming) ? incoming[0] : incoming;
  return value && TRACE_ID_PATTERN.test(value) ? value : randomUUID();
};

const clientIp = (req: Request): string => {
  const forwarded = String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim();
  return forwarded || req.socket?.remoteAddress || "";
};

// The route template, never the raw URL: query strings can carry tokens and paths carry IDs.
const routeOf = (req: Request): string =>
  req.route?.path ? `${req.baseUrl}${String(req.route.path)}` : "(unmatched)";

// Only identities that were verified by middleware count; headers are never trusted here.
const callerOf = (req: Request): { type: CallerType; id?: string } => {
  if (req.caller?.id) return { type: req.caller.type, id: req.caller.id };
  if (req.service && "id" in req.service) return { type: "service", id: req.service.id };
  if (req.person?.personId) return { type: "user", id: req.person.personId };
  if (req.user?._id) return { type: "user", id: String(req.user._id) };
  return { type: "anonymous" };
};

export const requestLog =
  (svc: string) =>
  (req: Request, res: Response, next: NextFunction): void => {
    const startedAt = process.hrtime.bigint();
    const traceId = resolveTraceId(req);
    req.traceId = traceId;
    res.setHeader("x-request-id", traceId);

    res.on("finish", () => {
      const status = res.statusCode;
      const line = {
        time: new Date().toISOString(),
        level: status >= 500 ? "error" : status >= 400 ? "warn" : "info",
        svc,
        event: "http",
        traceId,
        method: req.method,
        route: routeOf(req),
        status,
        ms: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6),
        caller: callerOf(req),
        ip: clientIp(req),
      };
      process.stdout.write(`${JSON.stringify(line)}\n`);
    });

    next();
  };
