import type { Request, Response } from "express";
import { normalizeEmail as normalizePlatformEmail, normalizePhone } from "@melvingadgets/platform-kit";
import SessionModel from "../Model/SessionModel.js";
import UserModel from "../Model/UserModel.js";
import type { AuthApp } from "../types/auth.js";

import { sendResetPasswordEmail, sendVerificationEmail } from "../Utils/Mailer.js";
import {
  buildDeviceInfo,
  buildResetUrl,
  buildVerifyUrl,
  comparePassword,
  consumeEmailVerificationToken,
  consumePasswordResetToken,
  createOrUpdateProfileForUser,
  createSessionForUser,
  createUserRecord,
  deactivateUserSessions,
  ensurePasswordStrength,
  findUserWithProfile,
  hashPassword,
  isMailConfigured,
  issueEmailVerificationToken,
  issuePasswordResetToken,
  platformTokenFields,
  rotateRefreshToken,
  toSafeProfile,
  toSafeUser,
} from "../Utils/authHelpers.js";

const normalizeEmail = (value: unknown): string => String(value ?? "").trim().toLowerCase();
const normalizeString = (value: unknown): string => String(value ?? "").trim();

// Friendly names for the app an account first came from, for telling a returning person they
// already have an account (RegisterUser). Keyed by the auth `originApp` enum.
const ORIGIN_APP_LABELS: Record<AuthApp, string> = {
  easybuy: "EasyBuy",
  ecommerce: "the Mel Store",
  "auth-service": "Melvin",
};

/**
 * A mail send failed. One JSON line, same shape as the request log (AGENTS.md §6), with the
 * personId — NEVER the email address, the token or the URL (AGENTS.md §6.3).
 */
const logMailFailure = (event: string, personId: unknown, error: unknown): void => {
  process.stdout.write(
    `${JSON.stringify({
      time: new Date().toISOString(),
      level: "warn",
      svc: "auth",
      event,
      personId: personId ? String(personId) : null,
      message: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
};

export const RegisterUser = async (req: Request, res: Response) => {
  try {
    const fullName = normalizeString(req.body?.fullName);
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password ?? "");
    if (!fullName || !email || !password) {
      return res.status(400).json({ message: "fullName, email and password are required" });
    }

    ensurePasswordStrength(password);

    // Recognise a returning person instead of a flat "email in use". Someone whose account
    // came from a legacy app (EasyBuy accounts were imported passwordless, 2026-11-02) needs to
    // be told it exists and sent to reset/set a password — not left guessing. Owner decision:
    // name the account and the app. `code` lets the client show the recognition panel; the
    // register endpoint already reveals that an email is taken, so naming the origin app adds
    // little and helps the person. `+password` is read only to tell "set" from "reset"; the hash
    // is never returned.
    const existing = await UserModel.findOne({ email }).select("+password").lean();
    if (existing) {
      const appLabel = ORIGIN_APP_LABELS[existing.originApp as AuthApp] ?? "Melvin";
      const hasPassword = Boolean(existing.password);

      // A passwordless account (the EasyBuy imports, 2026-11-02) can only get in by setting a
      // password, and there is no "forgot password" screen in the hub yet — so send the
      // set-password link here, best-effort, the moment they try to register. It is the same
      // capability as /forgot-password (this route is rate-limited too) and only ever helps the
      // real owner. An account that already has a password is told to sign in instead — never an
      // unsolicited reset for an established login.
      let resetEmailSent = false;
      if (!hasPassword && existing.email && isMailConfigured()) {
        try {
          const token = await issuePasswordResetToken(existing._id);
          await sendResetPasswordEmail({
            to: existing.email,
            fullName: existing.fullName,
            resetUrl: buildResetUrl(token),
          });
          resetEmailSent = true;
        } catch (error) {
          logMailFailure("reset_email_failed", existing._id, error);
        }
      }

      return res.status(409).json({
        code: "ACCOUNT_EXISTS",
        message: hasPassword
          ? `You already have a Melvin account (from ${appLabel}). Sign in instead, or reset your password if you've forgotten it.`
          : resetEmailSent
            ? `You already have a Melvin account from ${appLabel}. We've emailed you a secure link to set your password and sign in.`
            : `You already have a Melvin account from ${appLabel}. Reset your password to set one and sign in.`,
        account: { originApp: existing.originApp, appLabel, hasPassword },
        resetEmailSent,
      });
    }

    const user = await createUserRecord({
      email,
      passwordHash: await hashPassword(password),
      fullName,
      role: "User",
      emailVerified: false,
    });

    let verificationRequired = true;
    if (!isMailConfigured()) {
      verificationRequired = false;
      await UserModel.findByIdAndUpdate(user._id, { $set: { emailVerified: true } });
    } else {
      // The account EXISTS by now. A mail failure is a mail failure: reporting it as
      // "unable to create user" left the person locked out of a row they could neither use nor
      // recreate — and would have made the reseller claim that follows sign-up point at nobody.
      // The person can verify later through /resend-verification once mail works.
      try {
        const token = await issueEmailVerificationToken(user._id);
        await sendVerificationEmail({
          to: email,
          fullName,
          verifyUrl: buildVerifyUrl(token),
        });
      } catch (error) {
        logMailFailure("verification_email_failed", user._id, error);
      }
    }

    return res.status(201).json({
      message: verificationRequired
        ? "registration was successful check email to verify account"
        : "registration was successful",
      success: 1,
      data: {
        user: toSafeUser({
          _id: user._id,
          email: user.email,
          fullName: user.fullName,
          role: user.role,
          emailVerified: verificationRequired ? false : true,
          disabled: user.disabled,
          originApp: user.originApp,
        }),
      },
    });
  } catch (error: any) {
    return res.status(400).json({
      message: "unable to create user",
      reason: error?.message || "Unknown error",
    });
  }
};

// Compared against when there is no stored password, so every failed login costs one bcrypt run.
const UNUSED_PASSWORD_HASH = hashPassword("melvin-unused-password");

// One answer for an unknown account, a wrong password and a Google-only account, so the
// login form can't be used to find out who has an account (BACKEND-UNIFICATION.md §2, risk #7).
const INVALID_CREDENTIALS = { message: "invalid credentials" };

// Sign in with an email, or with a phone number once it has been verified (decision S4).
const findUserByIdentifier = (identifier: string) => {
  const email = normalizePlatformEmail(identifier);
  if (email) return UserModel.findOne({ email }).select("+password").lean();
  const phone = normalizePhone(identifier);
  if (phone) return UserModel.findOne({ phone, phoneVerified: true }).select("+password").lean();
  return Promise.resolve(null);
};

export const LoginUser = async (req: Request, res: Response): Promise<Response> => {
  try {
    const identifier = normalizeString(req.body?.identifier ?? req.body?.email ?? req.body?.phone);
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!identifier || !password) {
      return res.status(400).json({ message: "identifier (email or phone) and password are required" });
    }

    const user = await findUserByIdentifier(identifier);

    // A passwordless account (the EasyBuy imports) can't sign in until a password is set. Tell the
    // client so it can offer to email a set-password link, instead of a dead "invalid credentials".
    // This reveals the email is a claimable imported account — the disclosure the owner chose for
    // recognition; a wrong password on a normal account still gets the neutral answer below.
    if (user && !user.password) {
      const appLabel = ORIGIN_APP_LABELS[user.originApp as AuthApp] ?? "Melvin";
      return res.status(409).json({
        code: "PASSWORD_SETUP_REQUIRED",
        message: `This ${appLabel} account doesn't have a password yet — we can email you a secure link to set one.`,
        account: { originApp: user.originApp, appLabel, hasPassword: false },
      });
    }

    const validPassword = await comparePassword(password, user?.password ? String(user.password) : await UNUSED_PASSWORD_HASH);
    if (!user || !validPassword) {
      return res.status(401).json(INVALID_CREDENTIALS);
    }

    if (user.disabled) {
      return res.status(403).json({ message: "Account is disabled" });
    }

    if (user.email && !user.emailVerified) {
      if (isMailConfigured()) {
        // Best-effort re-send. If it fails the person must still get the 403 that tells them what
        // is wrong, not a 500 from a mail provider.
        try {
          const token = await issueEmailVerificationToken(user._id);
          await sendVerificationEmail({
            to: user.email,
            fullName: user.fullName,
            verifyUrl: buildVerifyUrl(token),
          });
        } catch (error) {
          logMailFailure("verification_resend_failed", user._id, error);
        }
      }
      return res.status(403).json({ code: "EMAIL_NOT_VERIFIED", message: "please check your email to verify account" });
    }

    const session = await createSessionForUser({
      user: {
        _id: user._id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        domainRoles: user.domainRoles,
      },
      device: buildDeviceInfo(req, req.body?.device),
    });

    res.cookie("sessionId", session.token, {
      httpOnly: true,
      sameSite: "lax",
      expires: session.expiresAt,
    });

    return res.status(201).json({
      success: 1,
      message: "login successful",
      data: session.token,
      user: toSafeUser(user),
      ...platformTokenFields(session.platform),
    });
  } catch (error: any) {
    return res.status(400).json({
      message: "unable to login",
      reason: error?.message || "Unknown error",
    });
  }
};

// POST /token/refresh { refreshToken } → a new access token and a new refresh token.
// The old refresh token stops working at once; replaying it later revokes the session.
export const RefreshPlatformToken = async (req: Request, res: Response) => {
  res.set("Cache-Control", "no-store");
  const presented = typeof req.body?.refreshToken === "string" ? req.body.refreshToken.trim() : "";
  if (!presented) return res.status(400).json({ message: "refreshToken is required" });

  const outcome = await rotateRefreshToken(presented);
  if (outcome.status !== "ok") {
    return res.status(401).json({ message: outcome.status === "revoked" ? "session revoked" : "invalid refresh token" });
  }
  return res.status(200).json({ success: 1, ...platformTokenFields(outcome.tokens) });
};

export const VerifyEmail = async (req: Request, res: Response) => {
  const token = normalizeString(req.params?.token);
  if (!token) {
    return res.status(400).send("<h1>Invalid verification token</h1>");
  }

  const user = await consumeEmailVerificationToken(token);
  if (!user) {
    // Signing in to an unverified account e-mails a fresh link (LoginUser), so say so.
    return res
      .status(400)
      .send("<h1>Verification link is invalid or expired</h1><p>Sign in again and we will e-mail you a new link.</p>");
  }

  return res.status(200).send("<h1>Account has been verified</h1><p>You can close this page and sign in.</p>");
};

export const ResendVerificationEmail = async (req: Request, res: Response) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!email) {
      return res.status(400).json({ message: "email is required" });
    }

    if (!isMailConfigured()) {
      return res.status(400).json({ message: "Mail transport is not configured" });
    }

    // Same answer whether or not the account exists or is already verified.
    const user = await UserModel.findOne({ email }).lean();
    if (user?.email && !user.emailVerified) {
      try {
        const token = await issueEmailVerificationToken(user._id);
        await sendVerificationEmail({
          to: user.email,
          fullName: user.fullName,
          verifyUrl: buildVerifyUrl(token),
        });
      } catch (error) {
        logMailFailure("verification_resend_failed", user._id, error);
      }
    }

    return res.status(200).json({ message: "If the account exists and is unverified, a verification email has been sent" });
  } catch (error: any) {
    return res.status(400).json({
      message: "Failed to resend verification email",
      reason: error?.message || "Unknown error",
    });
  }
};

export const ForgotPassword = async (req: Request, res: Response) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!email) {
      return res.status(400).json({ message: "email is required" });
    }

    if (!isMailConfigured()) {
      return res.status(400).json({ message: "Mail transport is not configured" });
    }

    const user = await UserModel.findOne({ email }).lean();
    if (!user?.email) {
      return res.status(200).json({ message: "If the account exists, a reset email has been sent" });
    }

    // Both branches answer 200 alike — that equality is what stops this route revealing whether an
    // account exists, so a mail failure is logged and swallowed here too.
    try {
      const token = await issuePasswordResetToken(user._id);
      await sendResetPasswordEmail({
        to: user.email,
        fullName: user.fullName,
        resetUrl: buildResetUrl(token),
      });
    } catch (error) {
      logMailFailure("password_reset_email_failed", user._id, error);
    }

    return res.status(200).json({ message: "If the account exists, a reset email has been sent" });
  } catch (error: any) {
    return res.status(400).json({
      message: "Failed to start password reset",
      reason: error?.message || "Unknown error",
    });
  }
};

export const ResetPassword = async (req: Request, res: Response) => {
  try {
    const token = normalizeString(req.body?.token || req.query?.token);
    const password = String(req.body?.password ?? "");
    if (!token || !password) {
      return res.status(400).json({ message: "token and password are required" });
    }

    ensurePasswordStrength(password);
    const nextPasswordHash = await hashPassword(password);
    const user = await consumePasswordResetToken(token, nextPasswordHash);

    if (!user) {
      return res.status(400).json({ message: "Reset token is invalid or expired" });
    }

    await deactivateUserSessions(user._id);
    return res.status(200).json({ message: "Password reset successful" });
  } catch (error: any) {
    return res.status(400).json({
      message: "Failed to reset password",
      reason: error?.message || "Unknown error",
    });
  }
};

// The page behind the reset-email link. `buildResetUrl` points the email at
// GET /reset-password?token=…; before this that hit the POST-only API and dead-ended, so nobody
// — including the passwordless EasyBuy imports (2026-11-02) — could set a password. This serves a
// minimal self-contained form whose own script reads the token from the URL and POSTs it back to
// POST /reset-password. The token is NEVER interpolated into the HTML, so there is no reflected-XSS
// surface, and no personal data is rendered. Kept deliberately dependency-free (no EJS/templating).
const RESET_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="robots" content="noindex, nofollow" />
<title>Set your password · Melvin</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: 24px;
    font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #f4f4f5; color: #09090b; }
  .card { width: 100%; max-width: 380px; background: #fff; border: 1px solid #e4e4e7;
    border-radius: 22px; padding: 28px 24px; box-shadow: 0 20px 60px rgba(0,0,0,.08); }
  .badge { width: 52px; height: 52px; border-radius: 16px; background: #09090b; color: #fff;
    display: grid; place-items: center; margin: 0 auto 14px; font-size: 24px; }
  h1 { font-size: 21px; font-weight: 700; text-align: center; margin: 0 0 6px; }
  p.sub { color: #71717a; font-size: 14px; text-align: center; margin: 0 0 20px; }
  label { display: block; font-size: 12px; font-weight: 600; color: #52525b; margin: 14px 0 6px; }
  input { width: 100%; height: 50px; padding: 0 14px; font-size: 16px; border: 1px solid #d4d4d8;
    border-radius: 14px; background: #fafafa; outline: none; }
  input:focus { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,.18); background: #fff; }
  button { width: 100%; height: 52px; margin-top: 20px; border: 0; border-radius: 14px;
    background: #2563eb; color: #fff; font-size: 16px; font-weight: 600; cursor: pointer; }
  button:disabled { background: #d4d4d8; color: #71717a; cursor: default; }
  .hint { font-size: 12px; color: #a1a1aa; margin-top: 8px; }
  .msg { margin-top: 16px; padding: 12px 14px; border-radius: 12px; font-size: 14px; font-weight: 600; display: none; }
  .msg.err { display: block; background: #fef2f2; border: 1px solid #fecaca; color: #b91c1c; }
  .msg.ok { display: block; background: #f0fdf4; border: 1px solid #bbf7d0; color: #15803d; }
</style>
</head>
<body>
  <main class="card">
    <div class="badge" aria-hidden="true">&#128274;</div>
    <h1>Set your password</h1>
    <p class="sub">Choose a password for your Melvin account, then sign in from the Melvin app.</p>
    <form id="f" novalidate>
      <label for="pw">New password</label>
      <input id="pw" type="password" autocomplete="new-password" placeholder="At least 8 characters" />
      <label for="pw2">Confirm password</label>
      <input id="pw2" type="password" autocomplete="new-password" placeholder="Re-enter password" />
      <div class="hint">Use at least 8 characters.</div>
      <button id="go" type="submit">Set password</button>
    </form>
    <div id="msg" class="msg" role="alert"></div>
  </main>
  <script>
    (function () {
      var token = new URLSearchParams(location.search).get("token") || "";
      var form = document.getElementById("f");
      var pw = document.getElementById("pw");
      var pw2 = document.getElementById("pw2");
      var go = document.getElementById("go");
      var msg = document.getElementById("msg");
      function show(kind, text) { msg.className = "msg " + kind; msg.textContent = text; }
      if (!token) { show("err", "This reset link is invalid or has expired. Request a new one from the Melvin app."); go.disabled = true; return; }
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        if (pw.value.length < 8) { show("err", "Use a password with at least 8 characters."); return; }
        if (pw.value !== pw2.value) { show("err", "Those passwords do not match."); return; }
        go.disabled = true; go.textContent = "Setting password…"; show("", "");
        fetch("/api/v1/auth/reset-password", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Accept": "application/json" },
          body: JSON.stringify({ token: token, password: pw.value })
        }).then(function (r) { return r.json().then(function (b) { return { ok: r.ok, b: b }; }); })
          .then(function (res) {
            if (res.ok) { form.style.display = "none"; show("ok", "Password set. Open the Melvin app and sign in."); }
            else { go.disabled = false; go.textContent = "Set password"; show("err", (res.b && (res.b.reason || res.b.message)) || "Could not reset your password."); }
          })
          .catch(function () { go.disabled = false; go.textContent = "Set password"; show("err", "Network error. Please try again."); });
      });
    })();
  </script>
</body>
</html>`;

export const ResetPasswordPage = (_req: Request, res: Response) => {
  return res.status(200).type("html").send(RESET_PAGE_HTML);
};

export const GetMe = async (req: Request, res: Response) => {
  const userId = req.user?._id;
  if (!userId) {
    return res.status(401).json({ message: "Access denied" });
  }

  const data = await findUserWithProfile(userId);
  if (!data) {
    return res.status(404).json({ message: "User not found" });
  }

  return res.status(200).json({
    message: "Current user retrieved successfully",
    data,
  });
};

export const LogoutUser = async (req: Request, res: Response) => {
  const userId = req.user?._id;
  const jti = req.user?.jti;

  if (userId && jti) {
    await SessionModel.updateOne(
      { user: userId, jti, active: true },
      {
        $set: {
          active: false,
          logoutAt: new Date(),
          lastSeenAt: new Date(),
        },
      }
    );
  }

  res.clearCookie("sessionId");
  return res.status(200).json({ message: "Logout successful" });
};

export const LogoutAllSessions = async (req: Request, res: Response) => {
  const userId = req.user?._id;
  if (!userId) {
    return res.status(401).json({ message: "Access denied" });
  }

  await deactivateUserSessions(userId);
  res.clearCookie("sessionId");
  return res.status(200).json({ message: "All sessions revoked successfully" });
};

export const ListMySessions = async (req: Request, res: Response) => {
  const userId = req.user?._id;
  if (!userId) {
    return res.status(401).json({ message: "Access denied" });
  }

  const sessions = await SessionModel.find({
    user: userId,
    active: true,
    expiresAt: { $gt: new Date() },
  })
    .sort({ lastSeenAt: -1 })
    .select({ _id: 0, jti: 1, app: 1, device: 1, loginAt: 1, lastSeenAt: 1, expiresAt: 1 })
    .lean();

  return res.status(200).json({
    message: "Sessions retrieved successfully",
    data: sessions,
  });
};

export const RevokeMySession = async (req: Request, res: Response) => {
  const userId = req.user?._id;
  const jti = normalizeString(req.params?.jti);
  if (!userId || !jti) {
    return res.status(400).json({ message: "jti is required" });
  }

  const revoked = await SessionModel.findOneAndUpdate(
    { user: userId, jti, active: true },
    {
      $set: {
        active: false,
        logoutAt: new Date(),
        lastSeenAt: new Date(),
      },
    },
    { returnDocument: "after" }
  ).lean();

  if (!revoked) {
    return res.status(404).json({ message: "Session not found" });
  }

  return res.status(200).json({ message: "Session revoked successfully" });
};

export const UpdateMyPassword = async (req: Request, res: Response) => {
  const userId = req.user?._id;
  const currentPassword = String(req.body?.currentPassword ?? "");
  const nextPassword = String(req.body?.newPassword ?? "");

  if (!userId || !currentPassword || !nextPassword) {
    return res.status(400).json({ message: "currentPassword and newPassword are required" });
  }

  try {
    ensurePasswordStrength(nextPassword);
    const user = await UserModel.findById(userId).select("+password");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const valid = await comparePassword(currentPassword, String(user.password));
    if (!valid) {
      return res.status(400).json({ message: "currentPassword is incorrect" });
    }

    user.password = await hashPassword(nextPassword);
    await user.save();
    await deactivateUserSessions(userId, req.user?.jti);

    return res.status(200).json({ message: "Password updated successfully" });
  } catch (error: any) {
    return res.status(400).json({
      message: "Failed to update password",
      reason: error?.message || "Unknown error",
    });
  }
};

export const UpdateMyProfile = async (req: Request, res: Response) => {
  const userId = req.user?._id;
  if (!userId) {
    return res.status(401).json({ message: "Access denied" });
  }

  const user = await UserModel.findById(userId);
  if (!user) {
    return res.status(404).json({ message: "User not found" });
  }

  // A partial save must not wipe the fields it does not mention. `normalizeString` turns an
  // absent key into "", which used to overwrite the stored value; only keys present in the body
  // become updates, and an absent one stays `undefined` (helpers.ts:createOrUpdateProfileForUser
  // treats undefined as "leave alone").
  const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(req.body ?? {}, key);
  const fullNameChanged = has("fullName");
  const fullName = (fullNameChanged ? normalizeString(req.body?.fullName) : "") || user.fullName;
  if (fullNameChanged && fullName !== user.fullName) {
    user.fullName = fullName;
    await user.save();
  }

  const dateOfBirthRaw = has("dateOfBirth") ? normalizeString(req.body?.dateOfBirth) : undefined;
  const updates: Parameters<typeof createOrUpdateProfileForUser>[0]["updates"] = {
    firstName: has("firstName") ? normalizeString(req.body?.firstName) : undefined,
    lastName: has("lastName") ? normalizeString(req.body?.lastName) : undefined,
    phoneNumber: has("phoneNumber") ? normalizeString(req.body?.phoneNumber) : undefined,
    // A present-but-blank dateOfBirth clears it; an absent one leaves it alone.
    dateOfBirth: dateOfBirthRaw === undefined ? undefined : dateOfBirthRaw ? new Date(dateOfBirthRaw) : null,
    gender: has("gender") ? normalizeString(req.body?.gender) : undefined,
    address: has("address") ? normalizeString(req.body?.address) : undefined,
    avatar: has("avatar") ? normalizeString(req.body?.avatar) : undefined,
  };

  const profile = await createOrUpdateProfileForUser({ userId, fullName, updates, fullNameChanged });

  return res.status(200).json({
    message: "Profile updated successfully",
    data: {
      user: toSafeUser({
        _id: user._id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        emailVerified: user.emailVerified,
        disabled: user.disabled,
        originApp: user.originApp,
      }),
      profile: toSafeProfile(profile),
    },
  });
};

import { OAuth2Client } from "google-auth-library";
import { config as appConfig } from "../config/Config.js";

const client = new OAuth2Client(appConfig.googleClientId);

export const GoogleLogin = async (req: Request, res: Response) => {
  try {
    const idToken = String(req.body?.idToken ?? "").trim();
    if (!idToken) {
      return res.status(400).json({ message: "idToken is required" });
    }

    if (!appConfig.googleClientId) {
      return res.status(500).json({ message: "Google Client ID is not configured on the server" });
    }

    const ticket = await client.verifyIdToken({
      idToken,
      audience: appConfig.googleClientId,
    });

    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      return res.status(400).json({ message: "Invalid Google token payload" });
    }

    const email = payload.email.toLowerCase().trim();
    const googleId = payload.sub;
    const fullName = payload.name || "Google User";
    const avatar = payload.picture || "";

    let user = await UserModel.findOne({ email }).lean();
    // Whether THIS request created the account. Additive, and the hub needs it: the Setup Assistant
    // runs after a Google sign-UP exactly as it does after an email one (OSAuthSheet.tsx:279). No
    // existing field is changed and nothing new is disclosed — an email sign-up already tells the
    // client this by which endpoint produced the session.
    let isNewUser = false;

    if (user) {
      if (user.disabled) {
        return res.status(403).json({ message: "Account is disabled" });
      }

      if (!user.googleId) {
        await UserModel.updateOne({ _id: user._id }, { $set: { googleId } });
        user.googleId = googleId;
      }
      if (!user.emailVerified) {
        await UserModel.updateOne({ _id: user._id }, { $set: { emailVerified: true } });
        user.emailVerified = true;
      }
    } else {
      const newUser = new UserModel({
        email,
        googleId,
        fullName,
        role: "User",
        emailVerified: true,
        disabled: false,
        originApp: "auth-service",
      });
      await newUser.save();
      isNewUser = true;
      user = await UserModel.findById(newUser._id).lean();

      if (!user) throw new Error("Failed to create user");

      await createOrUpdateProfileForUser({
        userId: user._id,
        fullName,
        updates: { avatar },
      });
    }

    if (!user) throw new Error("User is null");

    const session = await createSessionForUser({
      user: {
        _id: user._id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        domainRoles: user.domainRoles,
      },
      device: buildDeviceInfo(req, req.body?.device),
    });

    res.cookie("sessionId", session.token, {
      httpOnly: true,
      sameSite: "lax",
      expires: session.expiresAt,
    });

    return res.status(201).json({
      success: 1,
      message: "Google login successful",
      data: session.token,
      user: toSafeUser(user as any),
      // Additive (AGENTS.md §3.5): clients that do not read it are unaffected.
      isNewUser,
      ...platformTokenFields(session.platform),
    });
  } catch (error: any) {
    return res.status(400).json({
      message: "Google authentication failed",
      reason: error?.message || "Unknown error",
    });
  }
};
