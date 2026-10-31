import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "../.env") });

// The role copied across used to be whatever the legacy row held, spelling included.
// Map it through the one normaliser (it lowercases and accepts User/Admin/SuperAdmin),
// and refuse anything else rather than importing a role auth would later reject.
const mapLegacyRole = (role: unknown): "User" | "Admin" | "SuperAdmin" => {
  const normalized = String(role ?? "").trim().toLowerCase();
  if (normalized === "superadmin") return "SuperAdmin";
  if (normalized === "admin") return "Admin";
  if (normalized === "user" || normalized === "") return "User";
  throw new Error(`EasyBuy user has an unrecognised role: ${JSON.stringify(role)}`);
};

const EASYBUY_DB_URL = String(process.env.EASYBUY_DATABASE_URL ?? "").trim();
const AUTH_DB_URL = String(process.env.DATABASE_URL ?? "").trim();

if (!EASYBUY_DB_URL || !AUTH_DB_URL) {
  console.error("Missing EASYBUY_DATABASE_URL or DATABASE_URL in .env");
  process.exit(1);
}

// 1. Define Legacy Easybuy Schemas (Simplified for reading)
const EasybuyUserSchema = new mongoose.Schema({}, { strict: false });
const EasybuyProfileSchema = new mongoose.Schema({}, { strict: false });

// 2. Define New Auth Service Schemas
const AuthUserSchema = new mongoose.Schema({}, { strict: false });
const AuthProfileSchema = new mongoose.Schema({}, { strict: false });

const parseFullName = (fullName: string) => {
  const trimmed = fullName.trim();
  const [firstName = "", ...rest] = trimmed.split(/\s+/);
  return {
    firstName,
    lastName: rest.join(" "),
  };
};

const runMigration = async () => {
  console.log("Connecting to databases...");
  const easybuyConn = await mongoose.createConnection(EASYBUY_DB_URL).asPromise();
  const authConn = await mongoose.createConnection(AUTH_DB_URL).asPromise();

  console.log("Databases connected successfully.");

  const LegacyUser = easybuyConn.model("user", EasybuyUserSchema, "users");
  const LegacyProfile = easybuyConn.model("profile", EasybuyProfileSchema, "profiles");

  const AuthUser = authConn.model("auth_user", AuthUserSchema, "auth_users");
  const AuthProfile = authConn.model("auth_profile", AuthProfileSchema, "auth_profiles");

  const legacyUsers = await LegacyUser.find({}).lean() as any[];
  const legacyProfiles = await LegacyProfile.find({}).lean() as any[];

  console.log(`Found ${legacyUsers.length} users and ${legacyProfiles.length} profiles in Easybuy database.`);

  let insertedUsers = 0;
  let mergedUsers = 0;
  let skippedUsers = 0;

  for (const oldUser of legacyUsers) {
    const email = String(oldUser.email || "").toLowerCase().trim();
    if (!email) {
      console.log(`Skipping legacy user ${oldUser._id} because email is missing.`);
      skippedUsers++;
      continue;
    }

    // Find profile
    const oldProfile = legacyProfiles.find(p => String(p._id) === String(oldUser._id));

    const existingAuthUser = await AuthUser.findOne({ email }).lean() as any;

    let newUserId;

    if (existingAuthUser) {
      console.log(`Email ${email} already exists in unified DB. Merging legacy ID...`);
      await AuthUser.updateOne(
        { _id: existingAuthUser._id },
        { $set: { "legacyIds.easybuy": String(oldUser._id) } }
      );
      newUserId = existingAuthUser._id;
      mergedUsers++;
    } else {
      // Create new Auth User
      const newAuthUser = new AuthUser({
        email: email,
        password: oldUser.password, // Exact hash copy
        fullName: oldUser.fullName || "Easybuy User",
        role: mapLegacyRole(oldUser.role),
        emailVerified: true, // Legacy users are considered verified
        disabled: false,
        originApp: "easybuy",
        legacyIds: {
          easybuy: String(oldUser._id),
        },
        createdAt: oldUser.createdAt || new Date(),
        updatedAt: oldUser.updatedAt || new Date(),
      });
      await newAuthUser.save();
      newUserId = newAuthUser._id;
      insertedUsers++;
    }

    // Upsert Profile
    const names = parseFullName(oldUser.fullName || oldProfile?.FullName || "");
    const profileUpdates = {
      user: newUserId,
      firstName: oldProfile?.FullName ? parseFullName(oldProfile.FullName).firstName : names.firstName,
      lastName: oldProfile?.FullName ? parseFullName(oldProfile.FullName).lastName : names.lastName,
      address: oldProfile?.Address || "",
      gender: oldProfile?.Gender || "",
      avatar: oldProfile?.Avatar || "",
    };

    await AuthProfile.findOneAndUpdate(
      { user: newUserId },
      { $set: profileUpdates },
      { upsert: true }
    );
  }

  console.log("Migration Complete! 🎉");
  console.log(`Total legacy users processed: ${legacyUsers.length}`);
  console.log(`Newly inserted into Auth Service: ${insertedUsers}`);
  console.log(`Merged with existing Auth accounts: ${mergedUsers}`);
  console.log(`Skipped (no email): ${skippedUsers}`);

  await easybuyConn.close();
  await authConn.close();
  process.exit(0);
};

runMigration().catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});
