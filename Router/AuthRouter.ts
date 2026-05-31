import express from "express";
import { authRateLimiter } from "../Middleware/rateLimiter.js";
import { verifyToken } from "../Middleware/verifyToken.js";
import {
  ForgotPassword,
  GetMe,
  ListMySessions,
  LoginUser,
  LogoutAllSessions,
  LogoutUser,
  RegisterUser,
  ResendVerificationEmail,
  ResetPassword,
  RevokeMySession,
  UpdateMyPassword,
  UpdateMyProfile,
  VerifyEmail,
} from "../Controller/AuthController.js";

const router = express.Router();

router.post("/register", authRateLimiter, RegisterUser);
router.post("/login", authRateLimiter, LoginUser);
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
