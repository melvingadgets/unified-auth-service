# Unified auth service — agent notes

**Read first:** the platform rules in `C:\Users\HP\Desktop\Shortwork\AGENTS.md` (`../AGENTS.md` from here). They're canonical and override anything below.

- **Role:** the `auth` service. It owns people, logins, sessions and roles (`personId` = user `_id`), and will become the authorization server that issues service tokens (RS256 + JWKS, client credentials; rules §2).
- **Request log:** `Middleware/requestLog.ts`, mounted first in `MainApp.ts`. Keep its fields identical to the other services (rules §6).
- **Local development:** MongoDB here listens on `127.0.0.1` only, and Node may resolve `localhost` to IPv6. Use `mongodb://127.0.0.1:27017/...` for `DATABASE_URL`.
- **Platform tokens (U1):** RS256 via `@melvingadgets/platform-kit` (`Utils/platformTokens.ts`).
  - `/.well-known/jwks.json` publishes the keys.
  - `/oauth/token` issues 5-minute service tokens (client credentials). Clients come from `AUTH_OAUTH_CLIENTS_B64`, which holds hashes only. What each client may request comes from the kit's `GRANTS`, never from data.
  - Logins also return a 15-minute `accessToken` plus a rotating `refreshToken`, refreshed at `POST /api/v1/auth/token/refresh`. Replaying a rotated-out refresh token after 10 s revokes the session.
  - The legacy HS256 token keeps working alongside (§7.1). `verifyToken` accepts both, and logout ends both.
- **Service-token routes** live under `/api/v1/auth/internal/v2` and need scopes `auth:sessions.check` or `auth:people.read`. The old service-key routes under `/internal` stay until every caller has moved.
- **Identity:** a person has an email and/or a phone (E.164). Each is unique when present. A phone signs someone in only once `phoneVerified` is true.
- **Login answers** the same `401 invalid credentials` for an unknown account, a wrong password and a Google-only account, with equal timing. Keep it that way.
- **Rate limits** rely on `trust proxy` (one hop on Railway). Without it, every client shares the proxy's IP.
- **Tests:** `npm test` runs against a throwaway database on the local MongoDB (`MONGO_TEST_URL`, default `mongodb://127.0.0.1:27017`) and drops it afterwards.
- **In-app notifications (Phase 1, `Notifications/`; design: `Shortwork/docs/notifications.md`):** auth hosts each person's inbox. It is self-contained and touches no auth model, so it can move to its own service later by re-delivery.
  - `POST /internal/events` receives relay deliveries: service token (`aud` auth, `events:deliver`), then the relay's JWS over the raw body (`RELAY_JWKS_URL`), then the kit registry. It is mounted **before** `express.json()`; moving it after breaks every signature.
  - Exactly once without transactions: a notification's `_id` is its eventId. The test database is a standalone Mongo, so never switch this to the kit's `applyOnce` (it needs a replica set). The stale rule uses `notification_cursors`.
  - `compose.ts` is pure and owns all wording. Text never carries a name, email, phone, NIN, free-text reason or message content. Logs carry eventId / type / personId / outcome only.
  - `/api/v1/auth/me/notifications` (list, `/summary`, `/read`) is always scoped by the token's person. Someone else's id behaves exactly like an unknown one.
