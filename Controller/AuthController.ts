import type { Request, Response } from "express";
import { normalizeEmail as normalizePlatformEmail, normalizePhone } from "@melvingadgets/platform-kit";
import SessionModel from "../Model/SessionModel.js";
import UserModel from "../Model/UserModel.js";

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

export const RegisterUser = async (req: Request, res: Response) => {
  try {
    const fullName = normalizeString(req.body?.fullName);
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password ?? "");
    if (!fullName || !email || !password) {
      return res.status(400).json({ message: "fullName, email and password are required" });
    }

    ensurePasswordStrength(password);

    const existing = await UserModel.findOne({ email }).lean();
    if (existing) {
      return res.status(409).json({ message: "Email Already in use" });
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
      const token = await issueEmailVerificationToken(user._id);
      await sendVerificationEmail({
        to: email,
        fullName,
        verifyUrl: buildVerifyUrl(token),
      });
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
    const validPassword = await comparePassword(password, user?.password ? String(user.password) : await UNUSED_PASSWORD_HASH);
    if (!user || !user.password || !validPassword) {
      return res.status(401).json(INVALID_CREDENTIALS);
    }

    if (user.disabled) {
      return res.status(403).json({ message: "Account is disabled" });
    }

    if (user.email && !user.emailVerified) {
      if (isMailConfigured()) {
        const token = await issueEmailVerificationToken(user._id);
        await sendVerificationEmail({
          to: user.email,
          fullName: user.fullName,
          verifyUrl: buildVerifyUrl(token),
        });
      }
      return res.status(403).json({ message: "please check your email to verify account" });
    }

    const session = await createSessionForUser({
      user: {
        _id: user._id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
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
    return res.status(400).send("<h1>Verification link is invalid or expired</h1>");
  }

  return res.status(200).send("<h1>Account has been verified</h1>");
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
      const token = await issueEmailVerificationToken(user._id);
      await sendVerificationEmail({
        to: user.email,
        fullName: user.fullName,
        verifyUrl: buildVerifyUrl(token),
      });
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

    const token = await issuePasswordResetToken(user._id);
    await sendResetPasswordEmail({
      to: user.email,
      fullName: user.fullName,
      resetUrl: buildResetUrl(token),
    });

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

  const fullName = normalizeString(req.body?.fullName) || user.fullName;
  user.fullName = fullName;
  await user.save();

  const dateOfBirthRaw = normalizeString(req.body?.dateOfBirth);
  const profile = await createOrUpdateProfileForUser({
    userId,
    fullName,
    updates: {
      firstName: normalizeString(req.body?.firstName),
      lastName: normalizeString(req.body?.lastName),
      phoneNumber: normalizeString(req.body?.phoneNumber),
      dateOfBirth: dateOfBirthRaw ? new Date(dateOfBirthRaw) : null,
      gender: normalizeString(req.body?.gender),
      address: normalizeString(req.body?.address),
      avatar: normalizeString(req.body?.avatar),
    },
  });

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
      ...platformTokenFields(session.platform),
    });
  } catch (error: any) {
    return res.status(400).json({
      message: "Google authentication failed",
      reason: error?.message || "Unknown error",
    });
  }
};
