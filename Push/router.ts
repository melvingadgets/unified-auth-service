import express, { type Request, type Response } from "express";
import { verifyToken } from "../Middleware/verifyToken.js";
import { rateLimiter } from "../Middleware/rateLimiter.js";
import { parseEndpoint, parseSubscription, PushInputError } from "./endpoint.js";
import { MAX_SUBSCRIPTIONS_PER_PERSON, PushSubscriptionModel, subscriptionId } from "./model.js";
import type { PushSender } from "./sender.js";

// /api/v1/auth/me/push (Shortwork/docs/notifications.md §8). The person always comes from the
// verified token, never from the request (AGENTS.md §2.5).

const personOf = (req: Request): string => (req.user?._id ? String(req.user._id) : "");

const fail = (res: Response, error: unknown, what: string) => {
  if (error instanceof PushInputError) return res.status(400).json({ message: error.message });
  return res.status(500).json({ message: `could not ${what}` });
};

export const createPushRouter = (sender: PushSender | null, allowedHosts: readonly string[]) => {
  const router = express.Router();
  // A test alert is for checking a device, not for sending a stream of them.
  const testLimiter = rateLimiter({
    windowMs: 10 * 60 * 1000,
    limit: 5,
    message: "Too many test alerts. Try again later.",
    keyOf: (req) => `person:${personOf(req)}`,
  });

  router.get("/config", verifyToken, (_req: Request, res: Response) => {
    res.status(200).json({ enabled: sender !== null, publicKey: sender?.publicKey ?? null });
  });

  /** Saves this browser's subscription for the signed-in person (a re-subscribe replaces it). */
  router.put("/subscription", verifyToken, async (req: Request, res: Response) => {
    const personId = personOf(req);
    if (!personId) return res.status(401).json({ message: "please login to get token" });
    if (!sender) return res.status(503).json({ message: "push alerts are not available" });
    try {
      const subscription = parseSubscription(req.body, allowedHosts);
      const now = new Date();
      await PushSubscriptionModel.updateOne(
        { _id: subscriptionId(subscription.endpoint) },
        {
          $set: { personId, endpoint: subscription.endpoint, keys: subscription.keys, updatedAt: now },
          $setOnInsert: { createdAt: now, lastSentAt: null },
        },
        { upsert: true }
      );
      // Keep the newest few per person, so one account can't fan a notice out without limit.
      const extra = await PushSubscriptionModel.find({ personId })
        .sort({ updatedAt: -1 })
        .skip(MAX_SUBSCRIPTIONS_PER_PERSON)
        .select({ _id: 1 })
        .lean();
      if (extra.length > 0) await PushSubscriptionModel.deleteMany({ _id: { $in: extra.map((row) => row._id) }, personId });
      return res.status(200).json({ subscribed: true });
    } catch (error) {
      return fail(res, error, "save this device");
    }
  });

  /** Removes this browser's subscription, but only if it belongs to the caller. */
  router.delete("/subscription", verifyToken, async (req: Request, res: Response) => {
    const personId = personOf(req);
    if (!personId) return res.status(401).json({ message: "please login to get token" });
    try {
      const endpoint = parseEndpoint(req.body);
      const result = await PushSubscriptionModel.deleteOne({ _id: subscriptionId(endpoint), personId });
      return res.status(200).json({ removed: result.deletedCount === 1 });
    } catch (error) {
      return fail(res, error, "remove this device");
    }
  });

  /** Sends "Notifications are on" to the caller's own devices. */
  router.post("/test", verifyToken, testLimiter, async (req: Request, res: Response) => {
    const personId = personOf(req);
    if (!personId) return res.status(401).json({ message: "please login to get token" });
    if (!sender) return res.status(503).json({ message: "push alerts are not available" });
    try {
      const result = await sender.send(personId, {
        id: `test:${Date.now()}`,
        title: "Notifications are on",
        body: "This device will show alerts from Melvin Gadgets.",
        app: "Settings",
        tag: "push-test",
      });
      return res.status(200).json(result);
    } catch (error) {
      return fail(res, error, "send a test alert");
    }
  });

  return router;
};
