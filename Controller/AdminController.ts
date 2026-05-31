import type { Request, Response } from "express";
import mongoose from "mongoose";
import ProfileModel from "../Model/ProfileModel.js";
import SessionModel from "../Model/SessionModel.js";
import UserModel from "../Model/UserModel.js";
import {
  createUserRecord,
  deactivateUserSessions,
  ensurePasswordStrength,
  hashPassword,
  normalizeRoleInput,
  toSafeProfile,
  toSafeUser,
} from "../Utils/authHelpers.js";

const normalizeString = (value: unknown): string => String(value ?? "").trim();
const normalizeEmail = (value: unknown): string => normalizeString(value).toLowerCase();

export const AdminCreateUser = async (req: Request, res: Response) => {
  try {
    const actorRole = req.user?.role;
    if (!actorRole) {
      return res.status(401).json({ message: "Access denied" });
    }

    const fullName = normalizeString(req.body?.fullName);
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password ?? "");
    const requestedRole = normalizeRoleInput(req.body?.role || "User");

    if (!fullName || !email || !password) {
      return res.status(400).json({ message: "fullName, email and password are required" });
    }

    if (actorRole === "Admin" && requestedRole !== "User") {
      return res.status(403).json({ message: "Admin can create user accounts only" });
    }

    ensurePasswordStrength(password);

    const existing = await UserModel.findOne({ email }).lean();
    if (existing) {
      return res.status(409).json({ message: "Email Already in use" });
    }

    const user = await createUserRecord({
      email,
      passwordHash: await hashPassword(password),
      fullName,
      role: requestedRole,
      app: "auth-service",
      emailVerified: true,
    });

    return res.status(201).json({
      message: "registration was successful",
      success: 1,
      data: {
        user: toSafeUser(user),
      },
    });
  } catch (error: any) {
    return res.status(400).json({
      message: "unable to create user",
      reason: error?.message || "Unknown error",
    });
  }
};

export const AdminListUsers = async (req: Request, res: Response) => {
  try {
    const page = Math.max(Number(req.query?.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query?.limit) || 20, 1), 200);
    const role = normalizeString(req.query?.role);
    const search = normalizeString(req.query?.search);
    const disabledRaw = normalizeString(req.query?.disabled);

    const filter: Record<string, unknown> = {};
    if (role) {
      filter.role = role;
    }
    if (disabledRaw === "true" || disabledRaw === "false") {
      filter.disabled = disabledRaw === "true";
    }
    if (search) {
      filter.$or = [
        { email: { $regex: search, $options: "i" } },
        { fullName: { $regex: search, $options: "i" } },
      ];
    }

    const [users, total] = await Promise.all([
      UserModel.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      UserModel.countDocuments(filter),
    ]);

    const userIds = users.map((user) => user._id);
    const profiles = await ProfileModel.find({ user: { $in: userIds } }).lean();
    const profileMap = new Map(profiles.map((profile) => [String(profile.user), profile]));

    return res.status(200).json({
      message: "Users retrieved successfully",
      data: users.map((user) => ({
        ...toSafeUser(user),
        profile: toSafeProfile(profileMap.get(String(user._id)) || null),
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(Math.ceil(total / limit), 1),
      },
    });
  } catch (error: any) {
    return res.status(400).json({
      message: "Failed to retrieve users",
      reason: error?.message || "Unknown error",
    });
  }
};

export const AdminGetSingleUser = async (req: Request, res: Response) => {
  const userId = normalizeString(req.params?.id);
  if (!userId || !mongoose.isValidObjectId(userId)) {
    return res.status(400).json({ message: "A valid user id is required" });
  }

  const [user, profile] = await Promise.all([
    UserModel.findById(userId).lean(),
    ProfileModel.findOne({ user: userId }).lean(),
  ]);

  if (!user) {
    return res.status(404).json({ message: "User not found" });
  }

  return res.status(200).json({
    message: "User retrieved successfully",
    data: {
      ...toSafeUser(user),
      profile: toSafeProfile(profile),
    },
  });
};

export const AdminUpdateUserRole = async (req: Request, res: Response) => {
  if (req.user?.role !== "SuperAdmin") {
    return res.status(403).json({ message: "Access denied" });
  }

  const userId = normalizeString(req.params?.id);
  const role = normalizeRoleInput(req.body?.role);
  if (!userId || !mongoose.isValidObjectId(userId)) {
    return res.status(400).json({ message: "A valid user id is required" });
  }

  const user = await UserModel.findByIdAndUpdate(
    userId,
    { $set: { role } },
    { returnDocument: "after" }
  ).lean();

  if (!user) {
    return res.status(404).json({ message: "User not found" });
  }

  return res.status(200).json({
    message: "User role updated successfully",
    data: toSafeUser(user),
  });
};

export const AdminDisableUser = async (req: Request, res: Response) => {
  const userId = normalizeString(req.params?.id);
  const disabled = Boolean(req.body?.disabled ?? true);

  if (!userId || !mongoose.isValidObjectId(userId)) {
    return res.status(400).json({ message: "A valid user id is required" });
  }

  const user = await UserModel.findByIdAndUpdate(
    userId,
    { $set: { disabled } },
    { returnDocument: "after" }
  ).lean();

  if (!user) {
    return res.status(404).json({ message: "User not found" });
  }

  if (disabled) {
    await deactivateUserSessions(userId);
  }

  return res.status(200).json({
    message: "User status updated successfully",
    data: toSafeUser(user),
  });
};

export const AdminDeleteUser = async (req: Request, res: Response) => {
  if (req.user?.role !== "SuperAdmin") {
    return res.status(403).json({ message: "Access denied" });
  }

  const userId = normalizeString(req.params?.id);
  if (!userId || !mongoose.isValidObjectId(userId)) {
    return res.status(400).json({ message: "A valid user id is required" });
  }

  const session = await mongoose.startSession();
  try {
    let deletedUser: ReturnType<typeof toSafeUser> | null = null;

    await session.withTransaction(async () => {
      const user = await UserModel.findById(userId).session(session).lean();
      if (!user) {
        throw new Error("User not found");
      }

      await Promise.all([
        UserModel.deleteOne({ _id: userId }, { session }),
        ProfileModel.deleteOne({ user: userId }, { session }),
        SessionModel.deleteMany({ user: userId }, { session }),
      ]);

      deletedUser = toSafeUser(user);
    });

    return res.status(200).json({
      message: "User deleted successfully",
      data: deletedUser,
    });
  } catch (error: any) {
    const message = normalizeString(error?.message) || "Unknown error";
    if (message === "User not found") {
      return res.status(404).json({ message });
    }
    return res.status(400).json({
      message: "Failed to delete user",
      reason: message,
    });
  } finally {
    await session.endSession();
  }
};

export const AdminSessionStats = async (_req: Request, res: Response) => {
  try {
    const grouped = await SessionModel.aggregate([
      {
        $match: {
          active: true,
          expiresAt: { $gt: new Date() },
        },
      },
      {
        $lookup: {
          from: "auth_users",
          localField: "user",
          foreignField: "_id",
          as: "userDoc",
        },
      },
      { $unwind: "$userDoc" },
      {
        $group: {
          _id: "$userDoc.role",
          uniqueUsers: { $addToSet: "$user" },
        },
      },
      {
        $project: {
          _id: 0,
          role: "$_id",
          count: { $size: "$uniqueUsers" },
        },
      },
    ]);

    const counts = grouped.reduce<Record<string, number>>((acc, item) => {
      acc[String(item.role)] = Number(item.count || 0);
      return acc;
    }, {});

    return res.status(200).json({
      message: "Login statistics retrieved successfully",
      data: {
        usersLoggedIn: counts.User || 0,
        adminsLoggedIn: counts.Admin || 0,
        superAdminsLoggedIn: counts.SuperAdmin || 0,
        totalLoggedIn: (counts.User || 0) + (counts.Admin || 0) + (counts.SuperAdmin || 0),
      },
    });
  } catch (error: any) {
    return res.status(400).json({
      message: "Failed to retrieve login statistics",
      reason: error?.message || "Unknown error",
    });
  }
};
