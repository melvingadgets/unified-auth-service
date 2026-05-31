# Unified Auth Service

Centralized authentication service for distributed applications. Provides login, registration, email verification, password reset, session management, and admin user management across multiple frontend/backend apps.

## Quick Start

```bash
# Install dependencies
npm install

# Copy env file and fill in values
cp .env.example .env

# Run in development mode
npm run dev

# Build for production
npm run build
npm start
```

## Environment Variables

See [.env.example](.env.example) for all available configuration.

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: 5500) |
| `DATABASE_URL` | **Yes** | MongoDB connection string for auth database |
| `AUTH_JWT_SECRET` | **Yes** | JWT signing secret (share with consumer backends) |
| `AUTH_SERVICE_KEY` | No | API key for backend-to-backend internal endpoints |
| `AUTH_SERVICE_PUBLIC_URL` | No | Public URL for email verification/reset links |
| `CORS_ORIGINS` | No | Comma-separated allowed origins |
| `GMAIL_USER` | No | Gmail address for sending emails |
| `GMAIL_APP_PASSWORD` | No | Gmail app password |
| `MAIL_FROM` | No | Email sender display name |

## API Endpoints

### Public Auth

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/auth/register` | Register new user |
| POST | `/api/v1/auth/login` | Login |
| GET | `/api/v1/auth/verify-email/:token` | Verify email |
| POST | `/api/v1/auth/resend-verification` | Resend verification email |
| POST | `/api/v1/auth/forgot-password` | Request password reset |
| POST | `/api/v1/auth/reset-password` | Complete password reset |

### Authenticated

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/auth/me` | Get current user + profile |
| PATCH | `/api/v1/auth/me/profile` | Update profile |
| PATCH | `/api/v1/auth/me/password` | Change password |
| POST | `/api/v1/auth/logout` | Logout current session |
| POST | `/api/v1/auth/logout-all` | Revoke all sessions |
| GET | `/api/v1/auth/sessions` | List active sessions |
| DELETE | `/api/v1/auth/sessions/:jti` | Revoke specific session |

### Admin (requires Admin or SuperAdmin role)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/auth/admin/create-user` | Create user |
| GET | `/api/v1/auth/admin/users` | List users (paginated) |
| GET | `/api/v1/auth/admin/users/:id` | Get single user |
| PATCH | `/api/v1/auth/admin/users/:id/role` | Update user role |
| PATCH | `/api/v1/auth/admin/users/:id/disable` | Disable/enable user |
| DELETE | `/api/v1/auth/admin/users/:id` | Delete user |
| GET | `/api/v1/auth/admin/sessions/stats` | Session statistics |

### Internal (requires `x-service-key` header)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/auth/internal/validate-session` | Validate a session |
| POST | `/api/v1/auth/internal/bulk-users` | Resolve users by IDs |

## Multi-App Support

Login and registration accept an `app` field to identify which application the user is accessing:

```json
{
  "email": "user@example.com",
  "password": "password123",
  "app": "easybuy"
}
```

Each app can have different configurations (email verification, public registration, etc.) defined in `config/AppConfig.ts`.

## Migration

To import users from existing EasyBuy and Store databases:

```bash
# Set source database URLs
export EASYBUY_DATABASE_URL=mongodb+srv://...
export ECOMMERCE_DATABASE_URL=mongodb+srv://...

# Run user migration (creates ID mapping file)
npm run migrate:users

# Run session migration (requires mapping file from previous step)
npm run migrate:sessions
```
