import type { Request, Response } from "express";
import { can, isPlatformRole } from "@melvingadgets/platform-kit";
import mongoose from "mongoose";
import ProfileModel from "../Model/ProfileModel.js";
import SessionModel from "../Model/SessionModel.js";
import UserModel from "../Model/UserModel.js";
import {
  createUserRecord,
  deactivateUserSessions,
  ensurePasswordStrength,
  hashPassword,
  normalizeDomainRoles,
  normalizeRoleInput,
  toSafeProfile,
  toSafeUser,
} from "../Utils/authHelpers.js";

const normalizeString = (value: unknown): string => String(value ?? "").trim();
const normalizeEmail = (value: unknown): string => normalizeString(value).toLowerCase();

// Whoever the guard verified. `verifyToken` sets `req.person` for a platform token and
// `req.user` for the legacy one; `can` reads the role from whichever is present and
// fails closed on neither.
const actorOf = (req: Request) =>
  req.person
    ? { role: req.person.role, domainRoles: req.person.domainRoles }
    : { role: req.user?.role, domainRoles: req.user?.domainRoles };

export const AdminCreateUser = async (req: Request, res: Response) => {
  try {
    const fullName = normalizeString(req.body?.fullName);
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password ?? "");
    // Scoped to this try: a bad role or domain role is a 400 with its reason, below.
    const requestedRole = normalizeRoleInput(req.body?.role || "User");
    const requestedDomainRoles = normalizeDomainRoles(req.body?.domainRoles);

    if (!fullName || !email || !password) {
      return res.status(400).json({ message: "fullName, email and password are required" });
    }

    // Creating an Admin or SuperAdmin is itself a permission, not a role comparison.
    // An Admin holds `auth.users.create_user` and so may create `User` accounts only.
    if (requestedRole !== "User" && !can(actorOf(req), "auth.users.create_admin")) {
      return res.status(403).json({ message: "Access denied" });
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
      domainRoles: requestedDomainRoles,
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
    const search = normalizeString(req.query?.search);
    const disabledRaw = normalizeString(req.query?.disabled);

    // `req.query.role` used to be copied straight into the Mongo filter. Express's
    // default `qs` parser turns `?role[$ne]=User` into `{ "$ne": "User" }`, so an Admin
    // could filter on anything. It must be exactly one known role name or it's refused.
    const rawRole = req.query?.role;
    let role: string | undefined;
    if (rawRole !== undefined && rawRole !== "") {
      if (typeof rawRole !== "string" || !isPlatformRole(rawRole)) {
        return res.status(400).json({ message: "role must be one of: User, Admin, SuperAdmin" });
      }
      role = rawRole;
    }

    const filter: Record<string, unknown> = {};
    if (role) {
      filter.role = role;
    }
    if (disabledRaw === "true" || disabledRaw === "false") {
      filter.disabled = disabledRaw === "true";
    }
    if (search) {
      // Regex metacharacters in user input must not change the query's meaning.
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.$or = [
        { email: { $regex: escaped, $options: "i" } },
        { fullName: { $regex: escaped, $options: "i" } },
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

// Guarded by `auth.users.change_role`. The role comparison that used to live here
// (`req.user?.role !== "SuperAdmin"`) is gone: it read the legacy claim only, so a
// platform-token SuperAdmin was refused while the guard already allowed them.
export const AdminUpdateUserRole = async (req: Request, res: Response) => {
  const userId = normalizeString(req.params?.id);
  if (!userId || !mongoose.isValidObjectId(userId)) {
    return res.status(400).json({ message: "A valid user id is required" });
  }

  let role: ReturnType<typeof normalizeRoleInput>;
  try {
    role = normalizeRoleInput(req.body?.role);
  } catch (error: any) {
    return res.status(400).json({ message: error?.message || "role must be one of: User, Admin, SuperAdmin" });
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

/**
 * Grants or revokes narrow capabilities without touching the global role — the way a
 * Computer Village seller gets `market:salesperson` while staying a plain `User`.
 * Guarded by `auth.users.change_role`, the same as changing the role itself.
 */
export const AdminUpdateUserDomainRoles = async (req: Request, res: Response) => {
  const userId = normalizeString(req.params?.id);
  if (!userId || !mongoose.isValidObjectId(userId)) {
    return res.status(400).json({ message: "A valid user id is required" });
  }

  let domainRoles: ReturnType<typeof normalizeDomainRoles>;
  try {
    if (req.body?.domainRoles === undefined) {
      return res.status(400).json({ message: "domainRoles is required (send [] to clear)" });
    }
    domainRoles = normalizeDomainRoles(req.body?.domainRoles);
  } catch (error: any) {
    return res.status(400).json({ message: error?.message || "invalid domainRoles" });
  }

  const user = await UserModel.findByIdAndUpdate(
    userId,
    { $set: { domainRoles } },
    { returnDocument: "after" }
  ).lean();

  if (!user) {
    return res.status(404).json({ message: "User not found" });
  }

  return res.status(200).json({
    message: "User domain roles updated successfully",
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

// Guarded by `auth.users.delete` (SuperAdmin only). See AdminUpdateUserRole above.
export const AdminDeleteUser = async (req: Request, res: Response) => {
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
