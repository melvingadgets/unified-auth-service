import express, { type Application } from "express";
import cors from "cors";
import AuthRouter from "./Router/AuthRouter.js";
import AdminRouter from "./Router/AdminRouter.js";
import InternalRouter from "./Router/InternalRouter.js";
import { config } from "./config/Config.js";

export const MainApp = (app: Application) => {
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

  app.use("/api/v1/auth", AuthRouter);
  app.use("/api/v1/auth/admin", AdminRouter);
  app.use("/api/v1/auth/internal", InternalRouter);
};
