/**
 * Grants `domainRoles: ['market:salesperson']` to an explicit list of people.
 *
 * WHY THIS IS NOT A JOIN
 * The market's `StaffRole` collection keys on `user_id`, which is an anonymous HMAC
 * capability id (`u_<random hex>`) minted free at `POST /api/auth/session` — not a
 * personId. There is no key linking a StaffRole row to an auth user, so the roster
 * cannot be migrated faithfully. It also cannot be trusted: `docs/swap-abuse-and-
 * telemetry.md` measured 31 `salesperson` rows against 24 buyers, 24 of them from a
 * bulk-grant script and 7 from a spoofing script. Copying that across would hand
 * `market.swap.settle` (real money) to everyone who ever called /api/auth/session.
 *
 * So this script only ever grants to people the owner names, in a file of personIds
 * (auth `_id`s) or a comma-separated list. With no list it is a dry-run report.
 *
 * Usage:
 *   npx tsx scripts/migrate-staff-roles.ts                       # dry-run report
 *   npx tsx scripts/migrate-staff-roles.ts --people p1,p2        # grant
 *   npx tsx scripts/migrate-staff-roles.ts --people-file ids.json # grant
 *   npx tsx scripts/migrate-staff-roles.ts --revoke p1,p2        # take it away again
 *
 * Idempotent: a person who already holds the domain role is counted as unchanged, and
 * every write is a set-union on the array. Prints before/after counts (AGENTS.md §7.3).
 */

import fs from "fs/promises";
import mongoose from "mongoose";
import { config } from "../config/Config.js";

const DOMAIN_ROLE = "market:salesperson";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const peopleFile = flag("--people-file");
const peopleFlag = flag("--people") ?? flag("--revoke");
const revoking = args.includes("--revoke");

const parsePeople = async (): Promise<string[]> => {
  if (peopleFile) {
    const raw = await fs.readFile(peopleFile, "utf8");
    const parsed: unknown = JSON.parse(raw);
    // Accept ["id", ...] or { personIds: [...] } so either file shape works.
    const ids = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { personIds?: unknown }).personIds)
        ? (parsed as { personIds: unknown[] }).personIds
        : null;
    if (!ids) throw new Error(`${peopleFile} must be a JSON array of personIds, or { "personIds": [...] }`);
    return ids.map((id) => String(id).trim()).filter(Boolean);
  }
  if (peopleFlag) return peopleFlag.split(",").map((id) => id.trim()).filter(Boolean);
  return [];
};

const main = async () => {
  const people = await parsePeople();
  const authConn = await mongoose.createConnection(config.databaseUrl).asPromise();

  try {
    const authUsers = authConn.collection("auth_users");

    const before = await authUsers.countDocuments({ domainRoles: DOMAIN_ROLE });
    const total = await authUsers.estimatedDocumentCount();
    console.log(`[staff-roles] ${DOMAIN_ROLE} held by ${before} of ${total} auth users (before)`);

    if (people.length === 0) {
      // Dry run. Report what a real run would need to know, and nothing else — this
      // script never reads another service's database (AGENTS.md §1.2).
      console.log("[staff-roles] DRY RUN — no personId list supplied, nothing written.");
      console.log("[staff-roles] Re-run with --people <id>[,<id>...] or --people-file <file.json>.");
      const current = await authUsers
        .find({ domainRoles: DOMAIN_ROLE }, { projection: { email: 1, role: 1, disabled: 1 } })
        .toArray();
      for (const user of current) {
        // Never print an email: this is the platform's log rule (AGENTS.md §6.3).
        console.log(`  personId=${String(user._id)} role=${String(user.role)} disabled=${Boolean(user.disabled)}`);
      }
      return;
    }

    const invalid = people.filter((id) => !mongoose.isValidObjectId(id));
    if (invalid.length > 0) {
      throw new Error(`not valid personIds: ${invalid.join(", ")}`);
    }

    const valid = people.filter((id) => mongoose.isValidObjectId(id)).map((id) => new mongoose.Types.ObjectId(id));
    const found = await authUsers.countDocuments({ _id: { $in: valid } });
    if (found !== valid.length) {
      // Refuse rather than grant to a subset: a typo'd id would otherwise look like a
      // successful grant for everyone else and leave one seller unable to work.
      throw new Error(`${valid.length - found} of ${valid.length} personIds do not exist in auth_users; nothing written`);
    }

    const update = revoking
      ? { $pull: { domainRoles: DOMAIN_ROLE } }
      : { $addToSet: { domainRoles: DOMAIN_ROLE } };

    // The collection is untyped (`AnyObject`), and mongoose's PullOperator demands a
    // filter-document shape a plain string doesn't satisfy. `$pull` by value is correct
    // here, so the cast is on the update alone.
    const result = await authUsers.updateMany({ _id: { $in: valid } }, update as never);

    const after = await authUsers.countDocuments({ domainRoles: DOMAIN_ROLE });
    console.log(`[staff-roles] ${revoking ? "revoked" : "granted"} for ${valid.length} people`);
    console.log(`[staff-roles] matched ${result.matchedCount}, modified ${result.modifiedCount}`);
    console.log(`[staff-roles] ${DOMAIN_ROLE} held by ${after} of ${total} auth users (after)`);
  } finally {
    await authConn.close();
  }
};

main().catch((error) => {
  console.error(`[staff-roles] failed: ${error?.message || error}`);
  process.exit(1);
});
