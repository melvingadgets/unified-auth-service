# Runbook — import EasyBuy identities into unified auth

**Status (2026-11-02):** script written and dry-run-validated against the live EasyBuy Atlas source.
**NOT yet executed against production auth.** Executing needs owner approval to push + redeploy the
auth service (AGENTS.md §7.4: never push or deploy without explicit approval).

Script: `migrations/import-easybuy-identities.cjs`.

## What it does
- Imports EasyBuy `users` + `publiceasybuyrequests` into auth `auth_users` / `auth_profiles`.
- **Passwordless** — no password is copied, so imported people must reset to sign in (owner decision:
  "force a password reset"). This is what makes the "you already have an account" recognition true.
- **Skips drafts** (`publiceasybuydrafts`) by decision; the "resume your application" prompt is separate.
- Idempotent, dedups by email, handles phone-uniqueness collisions, backs up before writing.

## Dry-run result (local, against EasyBuy Atlas, 2026-11-02)
- Source: 20 users + 99 requests → **92 unique people** (by email), 0 skipped for missing email.
- Phones: 95/99 request phones valid E.164; 4 are genuine bad data (5/9/12-digit) and are dropped.
- Distinct phone values: 62 (some numbers are shared across different applicants → phone kept on the
  first account only, per the unique index).
- Insert/merge split is only meaningful against prod auth (local target is the empty Atlas
  `unified_auth`, so local shows insert=92). The in-Railway dry-run below gives the true split.

## Why it must run inside Railway
Prod auth DB `melvin_auth` is on `mongodb.railway.internal` — no public endpoint, unreachable from a
laptop (see memory `prod-database-topology`). EasyBuy Atlas IS reachable from Railway egress. So the
import runs inside the `unified-auth` container, which can see both.

## Prereqs
1. Set the source URL on the auth service (value piped from EasyBuy's `Database_url`, never printed):
   ```
   printf '%s' "$EB_URI" | railway variable set EASYBUY_DATABASE_URL --stdin --skip-deploys \
     --service unified-auth --environment production
   ```
2. Add `railway.json` at the auth repo root and commit the script + this file, then push `main`
   (pushing auth `main` does NOT auto-deploy — safe):
   ```json
   {
     "$schema": "https://railway.app/railway.schema.json",
     "deploy": { "startCommand": "node migrations/import-easybuy-identities.cjs ; node dist/Server.js" }
   }
   ```
   The `;` (not `&&`) guarantees the server starts even if the migration errors. `IMPORT_DRY_RUN`
   defaults to a dry run, so a stray deploy with this file writes nothing.

## Execute (dry-run → live → revert)
1. **Dry run:**
   ```
   railway variable set IMPORT_DRY_RUN 1 --skip-deploys --service unified-auth --environment production
   railway redeploy --service unified-auth --environment production --commit <sha> --yes
   ```
   Read the deploy logs for `[import] ... SUMMARY {"mode":"dry",...}`. Confirm the insert/merge counts.
2. **Live:**
   ```
   railway variable set IMPORT_DRY_RUN 0 --skip-deploys --service unified-auth --environment production
   railway redeploy --service unified-auth --environment production --commit <sha> --yes
   ```
   Read logs for `SUMMARY {"mode":"live",...,"backup":"auth_users_premig_<ts>"}`. **Note the backup name.**
3. **Revert:** remove the `startCommand` from `railway.json` (restore normal boot), push, redeploy;
   set `IMPORT_DRY_RUN` back to `1` (or remove it) so any later deploy is a no-op.

## Rollback
The live run snapshots `auth_users` → `auth_users_premig_<ts>` and `auth_profiles` →
`auth_profiles_premig_<ts>` before writing. To undo, restore those over the live collections
(`aggregate([{ $out: "auth_users" }])` from the backup collection) and redeploy clean.

## Fallback
If no `[import]` lines appear in the logs, `railway.json` `startCommand` was not honored on
`railway redeploy --commit`. Instead temporarily set package.json `start` to
`node migrations/import-easybuy-identities.cjs ; node dist/Server.js` and redeploy.

## Follow-ups (separate from this import)
- Registration recognition: when someone registers with an existing email, tell them they already
  have an account (name the app, EasyBuy) and route them to password reset.
- Post-login "continue your previous application" prompt for people who match a draft.
