import type { Request, Response } from "express";
import SessionModel from "../Model/SessionModel.js";
import UserModel from "../Model/UserModel.js";
import { resolveAuthApp } from "../config/AppConfig.js";
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
  resolveLoginApp,
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
    const appConfig = resolveAuthApp(req.body?.app);

    if (!appConfig.allowPublicRegistration) {
      return res.status(403).json({ message: "Public registration is not allowed for this app" });
    }

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
      app: appConfig.slug,
      emailVerified: !appConfig.requiresEmailVerification,
    });

    let verificationRequired = appConfig.requiresEmailVerification;
    if (verificationRequired) {
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

export const LoginUser = async (req: Request, res: Response): Promise<Response> => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password ?? "");
    const app = resolveLoginApp(req.body?.app);
    const appConfig = resolveAuthApp(app);

    const user = await UserModel.findOne({ email }).select("+password").lean();
    if (!user) {
      return res.status(404).json({ message: "user does not exist" });
    }

    if (user.disabled) {
      return res.status(403).json({ message: "Account is disabled" });
    }

    const validPassword = await comparePassword(password, String(user.password));
    if (!validPassword) {
      return res.status(404).json({ message: "Password is incorrect" });
    }

    if (appConfig.requiresEmailVerification && !user.emailVerified) {
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
      app,
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
    });
  } catch (error: any) {
    return res.status(400).json({
      message: "unable to login",
      reason: error?.message || "Unknown error",
    });
  }
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

    const user = await UserModel.findOne({ email }).lean();
    if (!user) {
      return res.status(404).json({ message: "user does not exist" });
    }

    if (user.emailVerified) {
      return res.status(200).json({ message: "Account is already verified" });
    }

    if (!isMailConfigured()) {
      return res.status(400).json({ message: "Mail transport is not configured" });
    }

    const token = await issueEmailVerificationToken(user._id);
    await sendVerificationEmail({
      to: user.email,
      fullName: user.fullName,
      verifyUrl: buildVerifyUrl(token),
    });

    return res.status(200).json({ message: "Verification email sent" });
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

    const user = await UserModel.findOne({ email }).lean();
    if (!user) {
      return res.status(200).json({ message: "If the account exists, a reset email has been sent" });
    }

    if (!isMailConfigured()) {
      return res.status(400).json({ message: "Mail transport is not configured" });
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
