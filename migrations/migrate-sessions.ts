import fs from "fs/promises";
import path from "path";
import mongoose from "mongoose";
import { config } from "../config/Config.js";

type MappingFile = {
  easybuy: Record<string, string>;
  ecommerce: Record<string, string>;
};

const mappingFile = path.join(process.cwd(), "migrations", "output", "user-id-map.json");
const easybuyDatabaseUrl = String(process.env.EASYBUY_DATABASE_URL ?? process.env.Database_url ?? "").trim();

if (!easybuyDatabaseUrl) {
  throw new Error("EASYBUY_DATABASE_URL is required");
}

const main = async () => {
  const mapping = JSON.parse(await fs.readFile(mappingFile, "utf8")) as MappingFile;
  const authConn = await mongoose.createConnection(config.databaseUrl).asPromise();
  const easybuyConn = await mongoose.createConnection(easybuyDatabaseUrl).asPromise();

  try {
    const authSessions = authConn.collection("auth_sessions");
    const easybuySessions = easybuyConn.collection("sessions");

    const sessions = await easybuySessions.find({}).toArray();
    let migratedCount = 0;

    for (const session of sessions) {
      const mappedUserId = mapping.easybuy[String(session.user)];
      if (!mappedUserId) continue;

      await authSessions.updateOne(
        { jti: String(session.jti || "") },
        {
          $setOnInsert: {
            _id: new mongoose.Types.ObjectId(),
            user: new mongoose.Types.ObjectId(mappedUserId),
            jti: String(session.jti || ""),
            active: Boolean(session.active),
            app: "easybuy",
            device: {
              userAgent: "",
              ip: "",
              browser: "",
              os: "",
            },
            loginAt: session.loginAt ? new Date(session.loginAt) : new Date(),
            logoutAt: session.logoutAt ? new Date(session.logoutAt) : null,
            lastSeenAt: session.lastSeenAt ? new Date(session.lastSeenAt) : new Date(),
            expiresAt: session.expiresAt ? new Date(session.expiresAt) : new Date(),
            createdAt: session.createdAt ? new Date(session.createdAt) : new Date(),
            updatedAt: session.updatedAt ? new Date(session.updatedAt) : new Date(),
          },
        },
        { upsert: true }
      );
      migratedCount += 1;
    }

    console.log(`Migrated ${migratedCount} EasyBuy sessions into auth_sessions`);
  } finally {
    await Promise.all([authConn.close(), easybuyConn.close()]);
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
