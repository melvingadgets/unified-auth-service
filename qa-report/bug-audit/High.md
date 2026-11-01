# High Severity Issues

## Auth mail endpoint compiler options, raw HTML and shared key route — 2026-10-31 23:30 WAT (UTC+01:00)
- **Category:** Security / Mail Dispatch
- **Affected Components:** `unified-auth-service/Controller/InternalMailController.ts`, `Utils/Mailer.ts`, `Router/`
- **Reproducible Evidence:** While a template allow-list was added, callers can still steer EJS compiler options (`client: true`), pass arbitrary raw `html`, and dispatch via legacy shared `x-service-key` rather than per-service OAuth service tokens (`POST /api/v1/auth/internal/mail/send`).
- **Actual Impact:** Risk of EJS template injection or spoofed transactional emails if an internal service token is compromised.
- **Verification Needed to Close:** Restrict template compilation to safe sandbox options, forbid unvetted raw `html` overrides from untrusted callers, and enforce dedicated service token scopes (`auth:mail.send`).
