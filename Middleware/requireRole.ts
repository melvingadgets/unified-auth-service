import type { NextFunction, Request, Response } from "express";
import type { AuthRole } from "../types/auth.js";

export const requireRole =
  (allowedRoles: AuthRole[]) => (req: Request, res: Response, next: NextFunction) => {
    const role = req.user?.role;
    if (!role || !allowedRoles.includes(role)) {
      return res.status(403).json({ message: "Access denied" });
    }
    next();
  };
