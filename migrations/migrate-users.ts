import fs from "fs/promises";
import path from "path";
import mongoose from "mongoose";
import { config } from "../config/Config.js";

type MappingFile = {
  easybuy: Record<string, string>;
  ecommerce: Record<string, string>;
};

type AnyDoc = Record<string, any>;

const OUTPUT_DIR = path.join(process.cwd(), "migrations", "output");
const OUTPUT_FILE = path.join(OUTPUT_DIR, "user-id-map.json");

const authDatabaseUrl = config.databaseUrl;
const easybuyDatabaseUrl = String(process.env.EASYBUY_DATABASE_URL ?? process.env.Database_url ?? "").trim();
const ecommerceDatabaseUrl = String(process.env.ECOMMERCE_DATABASE_URL ?? "").trim();

if (!easybuyDatabaseUrl || !ecommerceDatabaseUrl) {
  throw new Error("EASYBUY_DATABASE_URL and ECOMMERCE_DATABASE_URL are required");
}

/**
 * Unknown roles do not exist: a value the source service never issued is a data
 * defect, and silently defaulting it to `User` would quietly demote a real admin.
 * Every mapper throws instead, naming the value, so the migration stops rather than
 * guessing (AGENTS.md §7.3 — a migration reports before/after, it doesn't invent).
 */
const unmappedRole = (service: string, value: unknown): never => {
  throw new Error(`${service} user has an unrecognised role: ${JSON.stringify(value)}`);
};

const rankRole = (role: unknown): number => {
  const normalized = String(role ?? "").trim().toLowerCase();
  if (normalized === "superadmin") return 3;
  if (normalized === "admin") return 2;
  if (normalized === "user" || normalized === "") return 1;
  throw new Error(`unrecognised role in auth: ${JSON.stringify(role)}`);
};

const mapEasyBuyRole = (role: unknown): "User" | "Admin" | "SuperAdmin" => {
  const normalized = String(role ?? "").trim().toLowerCase();
  if (normalized === "superadmin") return "SuperAdmin";
  if (normalized === "admin") return "Admin";
  if (normalized === "user" || normalized === "") return "User";
  return unmappedRole("EasyBuy", role);
};

/**
 * A store `superadmin` is a SuperAdmin — this used to return `"Admin"`, and the caller's
 * `rankRole` comparison then kept whichever was lower, so every store SuperAdmin was
 * demoted on import. `storeowner` was the store's name for an admin.
 */
const mapEcommerceRole = (role: unknown): "User" | "Admin" | "SuperAdmin" => {
  const normalized = String(role ?? "").trim().toLowerCase();
  if (normalized === "superadmin") return "SuperAdmin";
  if (normalized === "admin" || normalized === "storeowner") return "Admin";
  if (normalized === "user" || normalized === "") return "User";
  return unmappedRole("ecommerce", role);
};

const buildProfileUpdate = (profile: AnyDoc | null | undefined, fullName: string) => {
  const split = String(fullName || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  return {
    firstName: String(profile?.FirstName ?? profile?.firstName ?? split[0] ?? "").trim(),
    lastName: String(
      profile?.LastName ??
        profile?.lastName ??
        (split.length > 1 ? split.slice(1).join(" ") : "")
    ).trim(),
    phoneNumber: String(profile?.PhoneNumber ?? profile?.phoneNumber ?? "").trim(),
    gender: String(profile?.Gender ?? profile?.gender ?? "").trim(),
    address: String(profile?.Address ?? profile?.address ?? "").trim(),
    avatar: String(profile?.Avatar ?? profile?.avatar ?? "").trim(),
    dateOfBirth: profile?.DateOfBirth ?? profile?.dateOfBirth ?? null,
  };
};

const upsertAuthProfile = async (
  authProfiles: mongoose.mongo.Collection<AnyDoc>,
  authUserId: mongoose.Types.ObjectId,
  profile: AnyDoc | null | undefined,
  fullName: string
) => {
  await authProfiles.updateOne(
    { user: authUserId },
    {
      $set: buildProfileUpdate(profile, fullName),
      $setOnInsert: {
        user: authUserId,
        createdAt: new Date(),
      },
      $currentDate: {
        updatedAt: true,
      },
    },
    { upsert: true }
  );
};

const main = async () => {
  const authConn = await mongoose.createConnection(authDatabaseUrl).asPromise();
  const easybuyConn = await mongoose.createConnection(easybuyDatabaseUrl).asPromise();
  const ecommerceConn = await mongoose.createConnection(ecommerceDatabaseUrl).asPromise();

  try {
    const authUsers = authConn.collection("auth_users");
    const authProfiles = authConn.collection("auth_profiles");
    const easybuyUsers = easybuyConn.collection("users");
    const easybuyProfiles = easybuyConn.collection("profiles");
    const ecommerceUsers = ecommerceConn.collection("users");
    const ecommerceProfiles = ecommerceConn.collection("profiles");

    const mapping: MappingFile = {
      easybuy: {},
      ecommerce: {},
    };

    const authUsersByEmail = new Map<string, AnyDoc>();
    for (const user of await authUsers.find({}).toArray()) {
      authUsersByEmail.set(String(user.email || "").toLowerCase(), user);
    }

    const easybuyProfileById = new Map(
      (await easybuyProfiles.find({}).toArray()).map((profile) => [String(profile._id), profile])
    );

    console.log("Migrating EasyBuy users...");
    let easybuyCount = 0;

    for (const legacyUser of await easybuyUsers.find({}).toArray()) {
      const email = String(legacyUser.email || "").trim().toLowerCase();
      if (!email) continue;

      const existing = authUsersByEmail.get(email);
      const fullName = String(legacyUser.fullName || "").trim();
      const mappedRole = mapEasyBuyRole(legacyUser.role);
      let authUserId: mongoose.Types.ObjectId;

      if (existing) {
        authUserId = new mongoose.Types.ObjectId(String(existing._id));
        const mergedRole = rankRole(mappedRole) > rankRole(String(existing.role || "User")) ? mappedRole : existing.role;
        await authUsers.updateOne(
          { _id: authUserId },
          {
            $set: {
              role: mergedRole,
              emailVerified: true,
              updatedAt: new Date(),
              "legacyIds.easybuy": String(legacyUser._id),
            },
          }
        );
      } else {
        authUserId = new mongoose.Types.ObjectId();
        const createdUser = {
          _id: authUserId,
          email,
          password: String(legacyUser.password || ""),
          fullName,
          role: mappedRole,
          emailVerified: true,
          disabled: false,
          originApp: "easybuy",
          legacyIds: {
            easybuy: String(legacyUser._id),
          },
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        await authUsers.insertOne(createdUser);
        authUsersByEmail.set(email, createdUser);
      }

      mapping.easybuy[String(legacyUser._id)] = String(authUserId);
      await upsertAuthProfile(
        authProfiles,
        authUserId,
        easybuyProfileById.get(String(legacyUser._id)),
        fullName
      );
      easybuyCount++;
    }

    console.log(`Migrated ${easybuyCount} EasyBuy users`);

    const ecommerceProfileById = new Map(
      (await ecommerceProfiles.find({}).toArray()).map((profile) => [String(profile._id), profile])
    );

    console.log("Migrating ecommerce users...");
    let ecommerceCount = 0;

    for (const legacyUser of await ecommerceUsers.find({}).toArray()) {
      const email = String(legacyUser.email || legacyUser.Email || "").trim().toLowerCase();
      if (!email) continue;

      const existing = authUsersByEmail.get(email);
      const fullName = String(
        legacyUser.fullName ||
        legacyUser.userName ||
        `${String(legacyUser.FirstName || "").trim()} ${String(legacyUser.LastName || "").trim()}`.trim()
      ).trim();
      const mappedRole = mapEcommerceRole(legacyUser.role);
      let authUserId: mongoose.Types.ObjectId;

      if (existing) {
        authUserId = new mongoose.Types.ObjectId(String(existing._id));
        const mergedRole = rankRole(mappedRole) > rankRole(String(existing.role || "User")) ? mappedRole : existing.role;
        await authUsers.updateOne(
          { _id: authUserId },
          {
            $set: {
              role: mergedRole,
              emailVerified: Boolean(existing.emailVerified || legacyUser.verify || legacyUser.Verify),
              updatedAt: new Date(),
              "legacyIds.ecommerce": String(legacyUser._id),
            },
          }
        );
      } else {
        authUserId = new mongoose.Types.ObjectId();
        const createdUser = {
          _id: authUserId,
          email,
          password: String(legacyUser.password || legacyUser.Password || ""),
          fullName,
          role: mappedRole,
          emailVerified: Boolean(legacyUser.verify || legacyUser.Verify),
          disabled: false,
          originApp: "ecommerce",
          legacyIds: {
            ecommerce: String(legacyUser._id),
          },
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        await authUsers.insertOne(createdUser);
        authUsersByEmail.set(email, createdUser);
      }

      mapping.ecommerce[String(legacyUser._id)] = String(authUserId);
      await upsertAuthProfile(
        authProfiles,
        authUserId,
        ecommerceProfileById.get(String(legacyUser._id)),
        fullName
      );
      ecommerceCount++;
    }

    console.log(`Migrated ${ecommerceCount} ecommerce users`);

    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    await fs.writeFile(OUTPUT_FILE, JSON.stringify(mapping, null, 2), "utf8");
    console.log(`Wrote mapping file to ${OUTPUT_FILE}`);
    console.log(`Total unique auth users: ${authUsersByEmail.size}`);
  } finally {
    await Promise.all([
      authConn.close(),
      easybuyConn.close(),
      ecommerceConn.close(),
    ]);
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
