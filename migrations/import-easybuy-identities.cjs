#!/usr/bin/env node
/*
 * Import legacy EasyBuy identities into unified auth — passwordless, idempotent, dry-run first.
 *
 * WHY THIS EXISTS (and is not scripts/migrate-easybuy.ts or migrations/migrate-users.ts):
 *   - Owner decision (2026-11-02): imported accounts FORCE A PASSWORD RESET. So we create them
 *     PASSWORDLESS (no `password` field at all) — the old EasyBuy hash must never sign anyone in.
 *     The two existing importers copy the hash; this one must not, so it is a separate script.
 *   - It also imports `publiceasybuyrequests` (financing applicants), not only `users`. Most
 *     applicants never created a `users` row, yet they are the people who, on trying to register,
 *     must be told "you already have an account" — so they must exist in auth as claimable
 *     (passwordless, emailVerified per their verification) accounts.
 *   - Drafts (`publiceasybuydrafts`) are deliberately NOT imported (owner decision); the "continue
 *     your previous application" resume prompt is a separate, post-login feature.
 *
 * SAFETY:
 *   - DRY RUN BY DEFAULT. It writes nothing unless IMPORT_DRY_RUN is exactly "0". A dry run reads
 *     both databases, computes the full plan, and prints counts + a sanitized sample.
 *   - Before any write (real run only) it snapshots auth_users / auth_profiles into
 *     auth_users_premig_<ts> / auth_profiles_premig_<ts> in the same DB (the rollback source).
 *   - Idempotent: people are keyed by normalized email; a second run re-links (merge) and never
 *     duplicates. Unique indexes on email and phone are the real guard (AGENTS.md §3.8).
 *   - Dedup by email in memory first; on insert, an email collision becomes a merge and a phone
 *     collision drops the phone (it belongs to the first account) so the person still gets an account.
 *
 * ENV:
 *   DATABASE_URL           auth (inside Railway: melvin_auth on mongodb.railway.internal)
 *   EASYBUY_DATABASE_URL   EasyBuy Atlas (EasybuyTracker) — reachable locally and from Railway egress
 *   IMPORT_DRY_RUN         "0" = perform the import. Anything else (incl. unset) = dry run.
 *
 * Runs as plain CommonJS (.cjs) so it is unaffected by the repo's "type":"module", using the
 * `mongodb` driver already in dependencies. Designed to be safe inside a start-command chain:
 *   node migrations/import-easybuy-identities.cjs ; node dist/Server.js
 * (the `;` means the server starts even if this exits non-zero).
 */
"use strict";

const { MongoClient } = require("mongodb");

const PHONE_E164 = /^\+[1-9]\d{7,14}$/;
const DRY_RUN = String(process.env.IMPORT_DRY_RUN ?? "1") !== "0";
const AUTH_URL = String(process.env.DATABASE_URL || process.env.Database_url || "").trim();
const EASYBUY_URL = String(process.env.EASYBUY_DATABASE_URL || "").trim();

const normEmail = (v) => String(v || "").trim().toLowerCase();

/** Nigerian numbers to E.164, or null when it cannot be made valid (we never store a bad phone). */
function normPhone(v) {
  let raw = String(v == null ? "" : v).trim();
  if (!raw) return null;
  const hadPlus = raw.startsWith("+");
  let digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  let candidate;
  if (hadPlus) candidate = "+" + digits;
  else if (digits.length === 13 && digits.startsWith("234")) candidate = "+" + digits;
  else if (digits.length === 11 && digits.startsWith("0")) candidate = "+234" + digits.slice(1);
  else if (digits.length === 10) candidate = "+234" + digits;
  else if (digits.startsWith("234")) candidate = "+" + digits;
  else candidate = "+" + digits;
  return PHONE_E164.test(candidate) ? candidate : null;
}

const ROLE_RANK = { User: 1, Admin: 2, SuperAdmin: 3 };
/** Map a legacy role, refusing the unknown rather than silently demoting (AGENTS.md §4.4). */
function mapRole(role) {
  const n = String(role == null ? "" : role).trim().toLowerCase();
  if (n === "superadmin") return "SuperAdmin";
  if (n === "admin") return "Admin";
  if (n === "user" || n === "") return "User";
  throw new Error(`EasyBuy row has an unrecognised role: ${JSON.stringify(role)}`);
}

function splitName(fullName) {
  const parts = String(fullName || "").trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] || "", lastName: parts.slice(1).join(" ") };
}

// Sanitized masks for the sample the dry run prints (never log a real email/phone — AGENTS.md §6.3).
const maskEmail = (e) => {
  const [u = "", d = ""] = String(e).split("@");
  const mu = u.length <= 2 ? u[0] + "*" : u.slice(0, 2) + "*".repeat(Math.max(1, u.length - 2));
  return `${mu}@${d ? d[0] + "***" : "***"}`;
};
const maskPhone = (p) => (p ? p.slice(0, 5) + "***" + p.slice(-2) : "—");

async function run() {
  if (!AUTH_URL || !EASYBUY_URL) {
    console.error("[import] FATAL: DATABASE_URL and EASYBUY_DATABASE_URL are both required.");
    process.exitCode = 1;
    return;
  }
  console.log(`[import] mode=${DRY_RUN ? "DRY RUN (no writes)" : "LIVE (will write)"}  started=${new Date().toISOString()}`);

  const opts = { serverSelectionTimeoutMS: 15000 };
  const authClient = new MongoClient(AUTH_URL, opts);
  const ebClient = new MongoClient(EASYBUY_URL, opts);

  try {
    await authClient.connect();
    await ebClient.connect();
    const auth = authClient.db(); // db name comes from the URI
    const eb = ebClient.db();
    const authUsers = auth.collection("auth_users");
    const authProfiles = auth.collection("auth_profiles");

    const beforeCount = await authUsers.countDocuments();
    console.log(`[import] auth_users before: ${beforeCount}`);

    const legacyUsers = await eb.collection("users").find({}).toArray();
    const requests = await eb.collection("publiceasybuyrequests").find({}).toArray();
    console.log(`[import] source: ${legacyUsers.length} users, ${requests.length} requests`);

    // ---- 1. Build one person per normalized email ----------------------------------------
    /** @type {Map<string, any>} */
    const people = new Map();
    const touch = (email) => {
      if (!people.has(email)) {
        people.set(email, {
          email, phone: null, fullName: "", role: "User",
          legacyEasybuyId: null, emailVerified: false, createdAt: null, sources: new Set(),
        });
      }
      return people.get(email);
    };
    const bumpRole = (p, role) => {
      if (ROLE_RANK[role] > ROLE_RANK[p.role]) p.role = role;
    };
    const earliest = (a, b) => (!a ? b : !b ? a : a < b ? a : b);

    let skippedNoEmail = 0;
    for (const u of legacyUsers) {
      const email = normEmail(u.email);
      if (!email) { skippedNoEmail++; continue; }
      const p = touch(email);
      p.sources.add("user");
      p.legacyEasybuyId = String(u._id);
      bumpRole(p, mapRole(u.role));
      p.emailVerified = true; // a real EasyBuy account is treated as verified
      if (!p.fullName) p.fullName = String(u.fullName || "").trim();
      const ph = normPhone(u.phone);
      if (ph && !p.phone) p.phone = ph;
      p.createdAt = earliest(p.createdAt, u.createdAt instanceof Date ? u.createdAt : null);
    }
    for (const r of requests) {
      const email = normEmail(r.email);
      if (!email) { skippedNoEmail++; continue; }
      const p = touch(email);
      p.sources.add("request");
      const verified = r.status === "verified" || r.status === "approved" || Boolean(r.verifiedAt);
      if (verified) p.emailVerified = true;
      if (!p.fullName) p.fullName = String(r.fullName || "").trim();
      const ph = normPhone(r.phone);
      if (ph && !p.phone) p.phone = ph;
      p.createdAt = earliest(p.createdAt, r.createdAt instanceof Date ? r.createdAt : null);
    }

    const planned = [...people.values()];
    const uniquePhones = new Set(planned.map((p) => p.phone).filter(Boolean));
    console.log(`[import] unique people (by email): ${planned.length}; with a valid phone: ${uniquePhones.size}; skipped (no email): ${skippedNoEmail}`);

    // ---- 2. Classify against auth: insert vs merge ----------------------------------------
    let wouldInsert = 0, wouldMerge = 0;
    const sample = [];
    for (const p of planned) {
      const existing = await authUsers.findOne({ email: p.email }, { projection: { _id: 1 } });
      p._action = existing ? "merge" : "insert";
      p._existingId = existing ? existing._id : null;
      if (existing) wouldMerge++; else wouldInsert++;
      if (sample.length < 8) {
        sample.push(`    ${p._action.padEnd(6)} ${maskEmail(p.email)}  ${maskPhone(p.phone)}  role=${p.role} verified=${p.emailVerified} src=${[...p.sources].join("+")}`);
      }
    }
    console.log(`[import] plan: insert=${wouldInsert}, merge(existing)=${wouldMerge}`);
    console.log(`[import] sample (sanitized):\n${sample.join("\n")}`);

    if (DRY_RUN) {
      console.log(`[import] DRY RUN — no writes. SUMMARY ${JSON.stringify({ mode: "dry", beforeCount, sourceUsers: legacyUsers.length, sourceRequests: requests.length, uniquePeople: planned.length, uniquePhones: uniquePhones.size, wouldInsert, wouldMerge, skippedNoEmail })}`);
      return;
    }

    // ---- 3. Backup, then write (LIVE only) ------------------------------------------------
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const usersBak = `auth_users_premig_${ts}`;
    const profilesBak = `auth_profiles_premig_${ts}`;
    console.log(`[import] backing up auth_users -> ${usersBak}, auth_profiles -> ${profilesBak}`);
    await authUsers.aggregate([{ $match: {} }, { $out: usersBak }]).toArray();
    await authProfiles.aggregate([{ $match: {} }, { $out: profilesBak }]).toArray();
    console.log(`[import] backup complete (${await auth.collection(usersBak).countDocuments()} users, ${await auth.collection(profilesBak).countDocuments()} profiles).`);

    let inserted = 0, merged = 0, phoneDropped = 0, errors = 0;
    const usedPhones = new Set(); // proactively avoid within-run phone collisions
    const now = new Date();

    for (const p of planned) {
      try {
        let authId = p._existingId;
        if (p._action === "merge") {
          const $set = { updatedAt: now };
          if (p.legacyEasybuyId) $set["legacyIds.easybuy"] = p.legacyEasybuyId;
          await authUsers.updateOne({ _id: authId }, { $set });
          merged++;
        } else {
          let phone = p.phone;
          if (phone && usedPhones.has(phone)) { phone = null; phoneDropped++; }
          const doc = {
            email: p.email,
            phoneVerified: false,
            fullName: p.fullName || "EasyBuy Customer",
            role: p.role,
            domainRoles: [],
            emailVerified: p.emailVerified,
            disabled: false,
            originApp: "easybuy",
            legacyIds: p.legacyEasybuyId ? { easybuy: p.legacyEasybuyId } : {},
            emailVerificationTokenHash: null,
            emailVerificationTokenExpiresAt: null,
            passwordResetTokenHash: null,
            passwordResetTokenExpiresAt: null,
            createdAt: p.createdAt instanceof Date ? p.createdAt : now,
            updatedAt: now,
          };
          if (phone) doc.phone = phone; // NO password field -> passwordless -> forced reset
          try {
            const res = await authUsers.insertOne(doc);
            authId = res.insertedId;
            if (phone) usedPhones.add(phone);
            inserted++;
          } catch (e) {
            if (e && e.code === 11000) {
              const key = JSON.stringify(e.keyPattern || e.keyValue || {});
              if (key.includes("phone") && phone) {
                delete doc.phone; phoneDropped++;
                const res = await authUsers.insertOne(doc);
                authId = res.insertedId; inserted++;
              } else {
                const ex = await authUsers.findOne({ email: p.email }, { projection: { _id: 1 } });
                if (ex) {
                  authId = ex._id;
                  const $set = { updatedAt: now };
                  if (p.legacyEasybuyId) $set["legacyIds.easybuy"] = p.legacyEasybuyId;
                  await authUsers.updateOne({ _id: authId }, { $set });
                  merged++;
                } else { throw e; }
              }
            } else { throw e; }
          }
        }
        // Minimal profile (name + phone), idempotent by user — mirrors migrations/migrate-users.ts.
        if (authId) {
          const { firstName, lastName } = splitName(p.fullName);
          await authProfiles.updateOne(
            { user: authId },
            { $set: { firstName, lastName, phoneNumber: p.phone || "" }, $setOnInsert: { user: authId, createdAt: now }, $currentDate: { updatedAt: true } },
            { upsert: true }
          );
        }
      } catch (e) {
        errors++;
        console.error(`[import] ERROR on ${maskEmail(p.email)}: ${e && e.message ? e.message : e}`);
      }
    }

    const afterCount = await authUsers.countDocuments();
    console.log(`[import] auth_users after: ${afterCount} (delta ${afterCount - beforeCount})`);
    console.log(`[import] LIVE done. SUMMARY ${JSON.stringify({ mode: "live", beforeCount, afterCount, inserted, merged, phoneDropped, errors, backup: usersBak })}`);
  } catch (e) {
    console.error(`[import] FATAL: ${e && e.stack ? e.stack : e}`);
    process.exitCode = 1;
  } finally {
    await Promise.allSettled([authClient.close(), ebClient.close()]);
    console.log(`[import] connections closed; finished=${new Date().toISOString()}`);
  }
}

run();
