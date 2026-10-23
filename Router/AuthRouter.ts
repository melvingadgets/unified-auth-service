import express from "express";
import { authRateLimiter, rateLimiter } from "../Middleware/rateLimiter.js";
import { verifyToken } from "../Middleware/verifyToken.js";
import {
  ForgotPassword,
  GetMe,
  GoogleLogin,
  ListMySessions,
  LoginUser,
  LogoutAllSessions,
  LogoutUser,
  RefreshPlatformToken,
  RegisterUser,
  ResendVerificationEmail,
  ResetPassword,
  RevokeMySession,
  UpdateMyPassword,
  UpdateMyProfile,
  VerifyEmail,
} from "../Controller/AuthController.js";

const router = express.Router();

// Every open tab refreshes about every 15 minutes, so this is far above normal use.
const refreshRateLimiter = rateLimiter({
  windowMs: 60 * 1000,
  limit: 60,
  message: "Too many refresh requests. Try again later.",
});

router.post("/register", authRateLimiter, RegisterUser);
router.post("/token/refresh", refreshRateLimiter, RefreshPlatformToken);
router.post("/login", authRateLimiter, LoginUser);
router.post("/google", authRateLimiter, GoogleLogin);
router.get("/verify-email/:token", VerifyEmail);
router.post("/resend-verification", authRateLimiter, ResendVerificationEmail);
router.post("/forgot-password", authRateLimiter, ForgotPassword);
router.post("/reset-password", authRateLimiter, ResetPassword);
router.get("/me", verifyToken, GetMe);
router.patch("/me/profile", verifyToken, UpdateMyProfile);
router.patch("/me/password", verifyToken, UpdateMyPassword);
router.post("/logout", verifyToken, LogoutUser);
router.post("/logout-all", verifyToken, LogoutAllSessions);
router.get("/sessions", verifyToken, ListMySessions);
router.delete("/sessions/:jti", verifyToken, RevokeMySession);

export default router;
