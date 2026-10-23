/**
 * Creates or rotates the RS256 signing keys (Shortwork/AGENTS.md §2.3).
 *
 *   npx tsx scripts/signing-keys.ts <out-file> [--keep <n>]
 *
 * Reads the current AUTH_SIGNING_KEYS_B64 from the environment (if any), adds a new
 * key, keeps the newest <n> keys (default 2, so tokens signed with the previous key
 * still verify until they expire), and writes two lines to <out-file>:
 *   AUTH_SIGNING_KEYS_B64=...
 *   AUTH_ACTIVE_KID=<new kid>
 * Nothing secret is printed. Put both values into the auth service's environment, then
 * delete the file.
 */
import { writeFileSync } from "fs";
import { generateSigningKey, type SigningKey } from "@melvingadgets/platform-kit";

const [outFile, ...rest] = process.argv.slice(2);
if (!outFile) {
  console.error("usage: tsx scripts/signing-keys.ts <out-file> [--keep <n>]");
  process.exit(1);
}
const keepIndex = rest.indexOf("--keep");
const keep = keepIndex >= 0 ? Number(rest[keepIndex + 1]) : 2;
if (!Number.isInteger(keep) || keep < 1) {
  console.error("--keep must be a positive integer");
  process.exit(1);
}

const current = process.env.AUTH_SIGNING_KEYS_B64
  ? (JSON.parse(Buffer.from(process.env.AUTH_SIGNING_KEYS_B64, "base64").toString("utf8")) as SigningKey[])
  : [];
const next = generateSigningKey();
const keys = [...current, next].slice(-keep);

writeFileSync(
  outFile,
  `AUTH_SIGNING_KEYS_B64=${Buffer.from(JSON.stringify(keys)).toString("base64")}\nAUTH_ACTIVE_KID=${next.kid}\n`,
  { mode: 0o600 }
);
console.log(`wrote ${keys.length} key(s) to ${outFile}; new active kid ${next.kid}`);
