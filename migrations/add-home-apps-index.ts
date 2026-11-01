/**
 * Creates the `home_apps` unique index and reports counts before and after (Shortwork/AGENTS.md §7.3).
 *
 *   npx tsx migrations/add-home-apps-index.ts [--apply]
 *
 * Without --apply it only reports, which is what CI and a first review run. The index is what makes
 * concurrent first writes safe (§3.8): without it two devices can create two documents for one
 * person and neither the router nor the database would notice.
 *
 * Idempotent, and safe to re-run: an existing index with the same spec is reported as already
 * present. If a duplicate personId is found the script stops and prints the offending ids rather
 * than deleting documents — a duplicate is a data problem to look at, not to sweep away.
 */
import mongoose from "mongoose";
import { config } from "../config/Config.js";

const APPLY = process.argv.includes("--apply");
const COLLECTION = "home_apps";
const INDEX = { personId: 1 };

const main = async (): Promise<void> => {
  const connection = await mongoose.createConnection(config.databaseUrl).asPromise();
  try {
    const collection = connection.collection(COLLECTION);

    const before = await collection.countDocuments({});
    const distinctPeople = (await collection.distinct("personId")).length;
    const indexes = await collection.indexes();
    const existing = indexes.find((index) => JSON.stringify(index.key) === JSON.stringify(INDEX));

    console.log(JSON.stringify({ step: "before", collection: COLLECTION, documents: before, distinctPeople, hasUniquePersonIdIndex: Boolean(existing?.unique) }));

    if (before !== distinctPeople) {
      const duplicates = await collection
        .aggregate([{ $group: { _id: "$personId", n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }, { $limit: 10 }])
        .toArray();
      console.error(
        JSON.stringify({
          step: "blocked",
          reason: "more than one document for a personId; resolve these before creating the unique index",
          duplicatePersonIds: duplicates.map((row) => row._id),
        })
      );
      process.exitCode = 1;
      return;
    }

    if (existing?.unique) {
      console.log(JSON.stringify({ step: "index", action: "already present", name: existing.name }));
    } else if (!APPLY) {
      console.log(JSON.stringify({ step: "index", action: "would create", spec: INDEX, unique: true, hint: "re-run with --apply" }));
    } else {
      await collection.createIndex(INDEX, { unique: true, name: "personId_1" });
      console.log(JSON.stringify({ step: "index", action: "created", spec: INDEX, unique: true }));
    }

    const after = await collection.countDocuments({});
    console.log(JSON.stringify({ step: "after", collection: COLLECTION, documents: after, unchanged: before === after }));
  } finally {
    await connection.close();
  }
};

main().catch((error) => {
  console.error(JSON.stringify({ step: "error", message: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
