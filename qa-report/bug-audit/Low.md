# Low Severity Issues

## Session cookie missing Secure attribute — 2026-10-31 23:30 WAT (UTC+01:00)
- **Category:** Security / Cookies
- **Affected Components:** `unified-auth-service/Controller/AuthController.ts`
- **Reproducible Evidence:** Cookies set without `secure: true` in production environments when behind reverse proxies.
- **Actual Impact:** Cookie could be transmitted over unencrypted HTTP if user connects over plain HTTP.
- **Verification Needed to Close:** Enforce `secure: process.env.NODE_ENV === 'production'` on all set-cookie calls.
