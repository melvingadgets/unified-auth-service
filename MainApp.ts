import express, { type Application } from "express";
import cors from "cors";
import AuthRouter from "./Router/AuthRouter.js";
import AdminRouter from "./Router/AdminRouter.js";
import InternalRouter from "./Router/InternalRouter.js";
import OAuthRouter from "./Router/OAuthRouter.js";
import PlatformInternalRouter from "./Router/PlatformInternalRouter.js";
import { requestLog } from "./Middleware/requestLog.js";
import { config } from "./config/Config.js";

export const MainApp = (app: Application) => {
  // Railway terminates TLS in one proxy hop; without this every client shares the proxy's IP.
  app.set("trust proxy", 1);
  app.use(requestLog("auth"));
  app.use(express.json());

  const corsOptions: cors.CorsOptions = {
    origin: config.corsOrigins.length > 0 ? config.corsOrigins : "*",
    credentials: true,
  };
  app.use(cors(corsOptions));

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.get("/api/v1", (_req, res) => {
    res.status(200).json({
      message: "Auth service is running successfully",
    });
  });

  app.use(OAuthRouter);
  app.use("/api/v1/auth", AuthRouter);
  app.use("/api/v1/auth/admin", AdminRouter);
  // Service-token routes (Shortwork/AGENTS.md §2) sit next to the legacy service-key ones until callers move.
  app.use("/api/v1/auth/internal/v2", PlatformInternalRouter);
  app.use("/api/v1/auth/internal", InternalRouter);
};
