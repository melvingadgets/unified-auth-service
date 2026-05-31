import type { Request, Response } from "express";
import SessionModel from "../Model/SessionModel.js";
import UserModel from "../Model/UserModel.js";
import { toSafeUser } from "../Utils/authHelpers.js";

const normalizeString = (value: unknown): string => String(value ?? "").trim();

export const InternalValidateSession = async (req: Request, res: Response) => {
  const userId = normalizeString(req.body?.userId);
  const jti = normalizeString(req.body?.jti);

  if (!userId || !jti) {
    return res.status(400).json({ message: "userId and jti are required" });
  }

  const session = await SessionModel.findOne({
    user: userId,
    jti,
    active: true,
    expiresAt: { $gt: new Date() },
  }).lean();

  return res.status(200).json({
    message: "Session validation complete",
    data: {
      valid: Boolean(session),
    },
  });
};

export const InternalBulkUsers = async (req: Request, res: Response) => {
  const userIds = Array.isArray(req.body?.userIds) ? req.body.userIds.map(String) : [];
  if (!userIds.length) {
    return res.status(400).json({ message: "userIds must contain at least one id" });
  }

  const users = await UserModel.find({ _id: { $in: userIds } }).lean();
  return res.status(200).json({
    message: "Users resolved successfully",
    data: users.map((user) => toSafeUser(user)),
  });
};
