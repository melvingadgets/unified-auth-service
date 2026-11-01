import express, { type Request, type Response } from "express";
import mongoose from "mongoose";
import { verifyToken } from "../Middleware/verifyToken.js";

// The hub's Setup Assistant, remembered per person (/api/v1/auth/me/setup). It runs once for
// everyone, existing accounts included; finishing it records when, and what the person said they
// came for, so it never shows again on another device. Not identity data: nothing else reads it.

export const SETUP_INTERESTS = ["shop", "easybuy", "reseller", "swap"] as const;
export type SetupInterest = (typeof SETUP_INTERESTS)[number];

interface SetupRecord {
  /** The personId. */
  _id: string;
  completedAt: Date;
  interests: SetupInterest[];
  updatedAt: Date;
}

export const PersonSetupModel = mongoose.model<SetupRecord>(
  "PersonSetup",
  new mongoose.Schema<SetupRecord>(
    {
      _id: { type: String, required: true },
      completedAt: { type: Date, required: true },
      interests: { type: [String], default: [] },
      updatedAt: { type: Date, required: true },
    },
    { versionKey: false, collection: "person_setup" }
  )
);

export class SetupInputError extends Error {}

/** `{ interests, completed: true }`. Interests are a subset of SETUP_INTERESTS, without repeats. */
export const parseSetupUpdate = (body: unknown): { interests: SetupInterest[] } => {
  const input = (body && typeof body === "object" ? body : {}) as { interests?: unknown; completed?: unknown };
  if (input.completed !== true) throw new SetupInputError("completed must be true");
  const interests = input.interests ?? [];
  if (
    !Array.isArray(interests) ||
    interests.length > SETUP_INTERESTS.length ||
    !interests.every((interest) => (SETUP_INTERESTS as readonly unknown[]).includes(interest)) ||
    new Set(interests).size !== interests.length
  ) {
    throw new SetupInputError(`interests must be a list drawn from ${SETUP_INTERESTS.join(", ")}`);
  }
  return { interests: interests as SetupInterest[] };
};

const personOf = (req: Request): string => (req.user?._id ? String(req.user._id) : "");

const toPublic = (record: Pick<SetupRecord, "completedAt" | "interests"> | null) => ({
  completedAt: record ? record.completedAt.toISOString() : null,
  interests: record ? record.interests : [],
});

const router = express.Router();

router.get("/", verifyToken, async (req: Request, res: Response) => {
  const personId = personOf(req);
  if (!personId) return res.status(401).json({ message: "please login to get token" });
  try {
    return res.status(200).json(toPublic(await PersonSetupModel.findById(personId).lean()));
  } catch {
    return res.status(500).json({ message: "could not load setup" });
  }
});

router.put("/", verifyToken, async (req: Request, res: Response) => {
  const personId = personOf(req);
  if (!personId) return res.status(401).json({ message: "please login to get token" });
  try {
    const { interests } = parseSetupUpdate(req.body);
    const now = new Date();
    // $min keeps the first completion: running the assistant again only updates the interests.
    const record = await PersonSetupModel.findOneAndUpdate(
      { _id: personId },
      { $set: { interests, updatedAt: now }, $min: { completedAt: now } },
      { upsert: true, new: true, lean: true }
    );
    return res.status(200).json(toPublic(record));
  } catch (error) {
    if (error instanceof SetupInputError) return res.status(400).json({ message: error.message });
    return res.status(500).json({ message: "could not save setup" });
  }
});

export default router;
