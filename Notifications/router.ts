import express, { type Request, type Response } from "express";
import { verifyToken } from "../Middleware/verifyToken.js";
import { InboxInputError, listNotifications, markRead, parseLimit, parseReadSelector, summarize } from "./inbox.js";

// /api/v1/auth/me/notifications (Shortwork/docs/notifications.md §6). The person always comes from
// the verified token, never from the request (AGENTS.md §2.5).

const personOf = (req: Request): string => (req.user?._id ? String(req.user._id) : "");

const fail = (res: Response, error: unknown, what: string) => {
  if (error instanceof InboxInputError) return res.status(400).json({ message: error.message });
  return res.status(500).json({ message: `could not ${what}` });
};

const router = express.Router();

router.get("/", verifyToken, async (req: Request, res: Response) => {
  const personId = personOf(req);
  if (!personId) return res.status(401).json({ message: "please login to get token" });
  try {
    const limit = parseLimit(req.query.limit);
    const before = typeof req.query.before === "string" && req.query.before ? req.query.before : undefined;
    const [page, summary] = await Promise.all([listNotifications(personId, { limit, before }), summarize(personId)]);
    return res.status(200).json({ ...page, unread: summary.unread });
  } catch (error) {
    return fail(res, error, "load notifications");
  }
});

router.get("/summary", verifyToken, async (req: Request, res: Response) => {
  const personId = personOf(req);
  if (!personId) return res.status(401).json({ message: "please login to get token" });
  try {
    return res.status(200).json(await summarize(personId));
  } catch (error) {
    return fail(res, error, "count notifications");
  }
});

router.post("/read", verifyToken, async (req: Request, res: Response) => {
  const personId = personOf(req);
  if (!personId) return res.status(401).json({ message: "please login to get token" });
  try {
    await markRead(personId, parseReadSelector(req.body));
    return res.status(200).json(await summarize(personId));
  } catch (error) {
    return fail(res, error, "update notifications");
  }
});

export default router;
