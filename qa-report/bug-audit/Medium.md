# Medium Severity Issues

## Shared CORS allow-list trusts dynamic *.vercel.app subdomains for credentialed CORS — 2026-10-31 23:30 WAT (UTC+01:00)
- **Category:** Security / Cross-Origin Resource Sharing
- **Affected Components:** `unified-auth-service/Utils/corsHelper.ts`
- **Reproducible Evidence:** Regex matching `/^https:\/\/(easybuy|store|aurapaytrack(er)?|melvin-os)(-[a-z0-9-]+)?\.vercel\.app$/i` allows any attacker who registers an unclaimed Vercel project matching these prefixes to receive `Access-Control-Allow-Credentials: true`.
- **Actual Impact:** Potential cross-origin session hijack if an attacker provisions an arbitrary `easybuy-<random>.vercel.app` project.
- **Verification Needed to Close:** Restrict Vercel subdomains strictly to known project team scope (`*.melvingadgets-projects.vercel.app`) or exact production project aliases.

## nodemailer 6.10.1 carries high-severity advisories (SMTP fallback only) — 2026-11-01 11:40 WAT (UTC+01:00)
- **Category:** Security / Vulnerable dependency
- **Affected Components:** `Utils/Mailer.ts`, the SMTP transport (`nodemailer.createTransport`). It is used only when `MAIL_PROVIDER` is not `resend`.
- **Reproducible Evidence:**
  - `npm audit --audit-level=high` reports nodemailer `<=10.1.3`. The advisories:
    - GHSA-mm7p-fcc7-pg87: email to an unintended domain via an address interpretation conflict.
    - GHSA-c7w3-x93f-qmm8 and GHSA-vvjj-xcjg-gr5g: SMTP command injection.
    - GHSA-268h-hp4c-crq3: header injection.
    - GHSA-wqvq-jvpq-h66f: jsonTransport file access.
  - The only fix is a major upgrade (`npm audit fix --force`).
  - Production sends through Resend (`MAIL_PROVIDER=resend`, no Gmail credentials, checked 2026-11-01), so this code path does not run there today.
  - The same audit run fixed body-parser and qs without breaking changes (express 4.22.3).
- **Actual Impact:**
  - None in production while Resend is the provider.
  - Switching to SMTP, or a misconfigured provider, would put a vulnerable mailer on every verification and password-reset email.
  - The open advisory also keeps the §8.4 audit gate red.
- **Verification Needed to Close:**
  - nodemailer is upgraded to a fixed major, with the SMTP path tested against a local SMTP sink, or the SMTP transport is removed.
  - `npm audit --audit-level=high` then reports no runtime advisory.

## bcrypt 5's install-time fetcher pulls tar 6.2.1 (npm rates it critical) — 2026-11-01 17:50 WAT (UTC+01:00)
- **Category:** Security / Vulnerable dependency (install time)
- **Affected Components:** `bcrypt@5.1.1` (direct), through `@mapbox/node-pre-gyp@1.0.11` to `tar@6.2.1`, plus `rimraf`, `glob` and `minimatch` (moderate). Password hashing in `Utils/authHelpers.ts` uses bcrypt.
- **Reproducible Evidence:**
  - `npm audit` reports 1 critical, 3 high and 3 moderate: tar is critical and node-pre-gyp is high. The tar advisories include:
    - GHSA-34x7-hfp2-rc4v, GHSA-8qq5-rm4j-mr97 and GHSA-83g3-92jg-28cx: hardlink and symlink path traversal on extraction.
    - GHSA-r292-9mhp-454m and GHSA-23hp-3jrh-7fpw: denial of service.
  - The only fix npm offers is bcrypt 6.0.0, a major version (`npm audit fix --force`).
  - Path: `npm ls tar` shows `bcrypt@5.1.1 → @mapbox/node-pre-gyp@1.0.11 → tar@6.2.1`.
- **Actual Impact:**
  - **At run time, none:** node-pre-gyp runs only during `npm install`, to download and unpack bcrypt's prebuilt binary, and no request path reaches tar.
  - **At install time:** a tampered binary download could write outside the package folder on the build machine.
  - **The gate:** it keeps the §8.4 audit gate (`npm audit --audit-level=high`) red, alongside the nodemailer entry above.
- **Verification Needed to Close:**
  - bcrypt is upgraded to 6.x, which ships prebuilt binaries without node-pre-gyp.
  - Existing password hashes still verify: test sign-in with a hash made by 5.1.1.
  - `npm audit` no longer lists tar or node-pre-gyp.
