/**
 * Creates or rotates OAuth client credentials, one client per backend
 * (Shortwork/AGENTS.md §2.1).
 *
 *   npx tsx scripts/oauth-clients.ts <out-dir> <service> [<service> ...]
 *
 * For each service: a client id `svc-<service>` and a fresh 32-byte secret. Clients for
 * services not named are carried over from the current AUTH_OAUTH_CLIENTS_B64. Writes:
 *   <out-dir>/auth.env               AUTH_OAUTH_CLIENTS_B64=... (hashes only), for the auth service
 *   <out-dir>/<service>.client.env   SERVICE_CLIENT_ID / SERVICE_CLIENT_SECRET, for that backend
 * Nothing secret is printed. Copy each file's values into the right environment, then delete them.
 */
import { createHash, randomBytes } from "crypto";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { isServiceId } from "@melvingadgets/platform-kit";

type Client = { clientId: string; service: string; secretHash: string };

const [outDir, ...services] = process.argv.slice(2);
if (!outDir || services.length === 0 || !services.every(isServiceId)) {
  console.error("usage: tsx scripts/oauth-clients.ts <out-dir> <service> [...]; services: auth easybuy store market relay gateway reseller");
  process.exit(1);
}

const current: Client[] = process.env.AUTH_OAUTH_CLIENTS_B64
  ? JSON.parse(Buffer.from(process.env.AUTH_OAUTH_CLIENTS_B64, "base64").toString("utf8"))
  : [];
const clients = current.filter((client) => !(services as string[]).includes(client.service));

mkdirSync(outDir, { recursive: true });
for (const service of services) {
  const clientId = `svc-${service}`;
  const secret = randomBytes(32).toString("hex");
  clients.push({ clientId, service, secretHash: createHash("sha256").update(secret, "utf8").digest("hex") });
  writeFileSync(join(outDir, `${service}.client.env`), `SERVICE_CLIENT_ID=${clientId}\nSERVICE_CLIENT_SECRET=${secret}\n`, {
    mode: 0o600,
  });
}
writeFileSync(join(outDir, "auth.env"), `AUTH_OAUTH_CLIENTS_B64=${Buffer.from(JSON.stringify(clients)).toString("base64")}\n`, {
  mode: 0o600,
});
console.log(`wrote credentials for ${services.join(", ")} (${clients.length} client(s) registered) to ${outDir}`);
