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
import { requestLog } from "./Middleware/requestLog.js";
import { config } from "./config/Config.js";
import { buildPlatformCorsOptions } from "./Utils/corsHelper.js";
import { platformVerifier } from "./Utils/platformTokens.js";

export interface MainAppDeps {
  /** The relay's delivery-signature verifier. Tests pass one built from a local key set. */
  notificationDeliveries?: NotificationReceiverOptions["deliveries"];
}

export const MainApp = (app: Application, deps: MainAppDeps = {}) => {
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
  app.use("/api/v1/auth", AuthRouter);
  app.use("/api/v1/auth/admin", AdminRouter);
  // Service-token routes (Shortwork/AGENTS.md §2) sit next to the legacy service-key ones until callers move.
  app.use("/api/v1/auth/internal/v2", PlatformInternalRouter);
  app.use("/api/v1/auth/internal", InternalRouter);
};
