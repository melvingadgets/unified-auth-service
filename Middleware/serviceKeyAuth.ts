import type { NextFunction, Request, Response } from "express";
import { config } from "../config/Config.js";

export const serviceKeyAuth = (req: Request, res: Response, next: NextFunction) => {
  const key = String(req.get("x-service-key") || "").trim();
  if (!config.serviceKey || key !== config.serviceKey) {
    return res.status(401).json({ message: "Invalid service key" });
  }
  next();
};
