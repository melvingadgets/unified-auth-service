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
- **In-app notifications (`Notifications/`; design: `Shortwork/docs/notifications.md`):** auth hosts each person's inbox. It is self-contained and touches no auth model, so it can move to its own service later by re-delivery.
  - `POST /internal/events` receives relay deliveries: service token (`aud` auth, `events:deliver`), then the relay's JWS over the raw body (`RELAY_JWKS_URL`), then the kit registry. It is mounted **before** `express.json()`; moving it after breaks every signature.
  - Exactly once without transactions: a notification's `_id` is its eventId. The test database is a standalone Mongo, so never switch this to the kit's `applyOnce` (it needs a replica set). The stale rule uses `notification_cursors`.
  - `compose.ts` is pure and owns all wording. Text never carries a name, email, phone, NIN, free-text reason or message content. Logs carry eventId / type / personId / outcome only.
  - `/api/v1/auth/me/notifications` (list, `/summary`, `/read`) is always scoped by the token's person. Someone else's id behaves exactly like an unknown one.

  - **History:** an event more than 24 h older than its arrival (a relay backfill, a late replay) is stored already read and never pushed (`HISTORY_AFTER_MS` in `receiver.ts`).
  - **Chat notices collapse:** `reseller.chat.message.posted` makes one notice per recipient and conversation (`_id` `chat:<personId>:<conversationId>`). One pipeline update guarded by `lastSeq < seq` moves it forward; a repeat or an older message hits the unique `_id` and changes nothing. Keep that single update: a find-then-write would let a racing duplicate count twice.
  - **Repayment reminders:** `easybuy.repayment.due` (kit 0.8.0) makes one notice per event in the Easybuy Portal, with the naira amount and the due date. EasyBuy decides who owes what and when, and sends each stage once; `compose.ts` only words it. `dueOn` is a Lagos calendar date, so `formatDueDate` reads its parts and never builds a `Date`.
- **Web Push (`Push/`):** `/api/v1/auth/me/push` saves browser subscriptions (`push_subscriptions`, `_id` = sha256 of the endpoint) and alerts devices after each stored notice that is news.
  - **SSRF guard:** a subscription's endpoint is browser input that auth later POSTs to. `Push/endpoint.ts` allows only the browsers' push services over https; never widen it beyond them. `PUSH_ALLOWED_HOSTS` exists for loopback test servers only.
  - **Sending:** `web-push` encrypts the payload and signs the VAPID header; auth makes the request itself, with a 3 s timeout and no redirects. It runs after the 200 to the relay, so it never delays or undoes a delivery. A 404/410 deletes the subscription. Logs carry personId and counts, never an endpoint.
  - **Keys:** `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT`, one pair per environment. Replacing the pair orphans every saved device.
- **Setup Assistant (`Setup/setup.ts`):** `/api/v1/auth/me/setup` remembers per person that the hub's Setup Assistant was finished, and the interests chosen. It isn't identity data, and nothing else reads it.


- **Home-screen preferences (`HomeApps/`; design: `Shortwork/docs/app-store.md`):** auth holds one document per person saying which apps sit on their home screen.
  - `GET /api/v1/auth/me/home-apps` → `{ configured, apps, version }`. `PATCH` `{ changes, version }` merges; `PUT` `{ apps, version }` replaces (a device's first upload, or a Setup Assistant reset).
  - **A display preference that grants nothing.** Never read this to allow or refuse anything: whether someone is a reseller or a vendor stays in those services, and "on my home screen" is not access. There is no `:personId` in the path for the same reason (§2.5).
  - Optimistic concurrency: `version` rides in the body (not `If-Match`) so no CORS header is needed; a mismatch answers **409 with the current state**, and the client merges and retries. The first write relies on the unique index, never findOne-then-create (§3.8).
  - App names are validated because they become Mongo path keys: letters and single spaces, starting with a letter, ≤ 40 chars, ≤ 64 apps, ≤ 32 changes per call.
  - Index: `migrations/add-home-apps-index.ts` (dry-run by default, `--apply` to create, before/after counts).
  - No event, no kit change: nothing else needs to know.

