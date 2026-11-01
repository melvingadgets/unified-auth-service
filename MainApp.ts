import express, { type Application } from "express";
import cors from "cors";
import { createDeliveryVerifier } from "@melvingadgets/platform-kit";
import AuthRouter from "./Router/AuthRouter.js";
import AdminRouter from "./Router/AdminRouter.js";
import InternalRouter from "./Router/InternalRouter.js";
import OAuthRouter from "./Router/OAuthRouter.js";
import PlatformInternalRouter from "./Router/PlatformInternalRouter.js";
import NotificationsRouter from "./Notifications/router.js";
import { createNotificationReceiver, type NotificationReceiverOptions } from "./Notifications/receiver.js";
import { createPushRouter } from "./Push/router.js";
import { createPushSender, type PushSender } from "./Push/sender.js";
import SetupRouter from "./Setup/setup.js";
import { requestLog } from "./Middleware/requestLog.js";
import { config } from "./config/Config.js";
import { buildPlatformCorsOptions } from "./Utils/corsHelper.js";
import { platformVerifier } from "./Utils/platformTokens.js";

export interface MainAppDeps {
  /** The relay's delivery-signature verifier. Tests pass one built from a local key set. */
  notificationDeliveries?: NotificationReceiverOptions["deliveries"];
  /** Replaces the Web Push sender built from VAPID_*; null turns push off. */
  push?: PushSender | null;
}

const buildPushSender = (): PushSender | null => {
  if (!config.push.vapid) return null;
  try {
    return createPushSender({ vapid: config.push.vapid, allowedHosts: config.push.allowedHosts });
  } catch {
    // Never the error text: it can quote the bad value.
    const line = { time: new Date().toISOString(), level: "error", svc: "auth", event: "push_config", message: "VAPID settings are unusable; push alerts are off" };
    process.stdout.write(`${JSON.stringify(line)}\n`);
    return null;
  }
};

export const MainApp = (app: Application, deps: MainAppDeps = {}) => {
  const push = deps.push !== undefined ? deps.push : buildPushSender();

  // Railway terminates TLS in one proxy hop; without this every client shares the proxy's IP.
  app.set("trust proxy", 1);
  app.use(requestLog("auth"));

  // Event deliveries from the relay (Shortwork/docs/notifications.md §5). The signature covers the
  // exact body bytes, so this route reads the raw body and must stay before express.json().
  app.post(
    "/internal/events",
    express.raw({ type: () => true, limit: "1mb" }),
    createNotificationReceiver({
      tokens: platformVerifier,
      deliveries:
        deps.notificationDeliveries !== undefined
          ? deps.notificationDeliveries
          : config.relayJwksUrl
            ? createDeliveryVerifier({ jwks: config.relayJwksUrl })
            : null,
      push,
    })
  );

  app.use(express.json());

  app.use(cors(buildPlatformCorsOptions(config.corsOrigins)));

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.get("/api/v1", (_req, res) => {
    res.status(200).json({
      message: "Auth service is running successfully",
    });
  });

  app.use(OAuthRouter);
  app.use("/api/v1/auth/me/notifications", NotificationsRouter);
  app.use("/api/v1/auth/me/push", createPushRouter(push, config.push.allowedHosts));
  app.use("/api/v1/auth/me/setup", SetupRouter);
  app.use("/api/v1/auth", AuthRouter);
  app.use("/api/v1/auth/admin", AdminRouter);
  // Service-token routes (Shortwork/AGENTS.md §2) sit next to the legacy service-key ones until callers move.
  app.use("/api/v1/auth/internal/v2", PlatformInternalRouter);
  app.use("/api/v1/auth/internal", InternalRouter);
};
