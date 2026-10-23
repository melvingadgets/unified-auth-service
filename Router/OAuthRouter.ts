import express from "express";
import { tokenRateLimiter } from "../Middleware/rateLimiter.js";
import { IssueServiceToken, Jwks } from "../Controller/OAuthController.js";

const router = express.Router();

router.get("/.well-known/jwks.json", Jwks);
// RFC 6749 §4.4.2 sends the token request form-encoded; JSON is accepted too.
router.post("/oauth/token", tokenRateLimiter, express.urlencoded({ extended: false }), IssueServiceToken);

export default router;
