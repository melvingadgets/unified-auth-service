import type { Request, Response } from "express";
import mongoose from "mongoose";
import { normalizeEmail, normalizePhone } from "@melvingadgets/platform-kit";
import SessionModel from "../Model/SessionModel.js";
import UserModel from "../Model/UserModel.js";

// Service-to-service lookups (Shortwork/AGENTS.md §2, scopes auth:sessions.check and
// auth:people.read). Callers are verified services; people are identified by personId.

const toPerson = (user: {
  _id: mongoose.Types.ObjectId | string;
  email?: string | null;
  phone?: string | null;
  fullName: string;
  role: string;
  disabled: boolean;
  emailVerified: boolean;
  phoneVerified?: boolean;
}) => ({
  personId: String(user._id),
  email: user.email || null,
  phone: user.phone || null,
  fullName: user.fullName,
  role: user.role,
  disabled: user.disabled,
  emailVerified: user.emailVerified,
  phoneVerified: Boolean(user.phoneVerified),
});

// A session is usable when it's active and unexpired; receivers cache the answer briefly.
export const CheckSession = async (req: Request, res: Response) => {
  const sid = String(req.params.sid ?? "");
  const session = sid
    ? await SessionModel.findOne({ jti: sid, active: true, expiresAt: { $gt: new Date() } })
        .select({ _id: 0, user: 1 })
        .lean()
    : null;
  res.set("Cache-Control", "no-store");
  return res.status(200).json({ active: Boolean(session), personId: session ? String(session.user) : null });
};

export const GetPerson = async (req: Request, res: Response) => {
  const personId = String(req.params.personId ?? "");
  if (!mongoose.isValidObjectId(personId)) return res.status(404).json({ message: "person not found" });
  const user = await UserModel.findById(personId).lean();
  if (!user) return res.status(404).json({ message: "person not found" });
  return res.status(200).json(toPerson(user));
};

// Exact match on a normalised email or a verified phone; used to link a service's own
// records to a person. Unverified phones never match (AGENTS.md §1.4).
export const LookupPerson = async (req: Request, res: Response) => {
  const email = req.body?.email !== undefined ? normalizeEmail(String(req.body.email)) : null;
  const phone = req.body?.phone !== undefined ? normalizePhone(String(req.body.phone)) : null;
  if (!email && !phone) return res.status(400).json({ message: "a valid email or phone is required" });

  const user = await UserModel.findOne(email ? { email } : { phone, phoneVerified: true }).lean();
  if (!user) return res.status(404).json({ message: "person not found" });
  return res.status(200).json(toPerson(user));
};
