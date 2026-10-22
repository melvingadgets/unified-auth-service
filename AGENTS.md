# Unified auth service — agent notes

**Read first:** the platform rules in `C:\Users\HP\Desktop\Shortwork\AGENTS.md` (`../AGENTS.md` from here). They're canonical and override anything below.

- **Role:** the `auth` service. It owns people, logins, sessions and roles (`personId` = user `_id`), and will become the authorization server that issues service tokens (RS256 + JWKS, client credentials; rules §2).
- **Request log:** `Middleware/requestLog.ts`, mounted first in `MainApp.ts`. Keep its fields identical to the other services (rules §6).
- **Local development:** MongoDB here listens on `127.0.0.1` only, and Node may resolve `localhost` to IPv6. Use `mongodb://127.0.0.1:27017/...` for `DATABASE_URL`.
- **Known risks to fix:** login returns `user does not exist` (lets anyone test which emails have accounts) and doesn't validate an empty body; tokens are HS256 with a shared secret (move to RS256, pinned).
