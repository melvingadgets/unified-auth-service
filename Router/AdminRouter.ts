import express from "express";
import {
  AdminCreateUser,
  AdminDeleteUser,
  AdminDisableUser,
  AdminGetSingleUser,
  AdminListUsers,
  AdminSessionStats,
  AdminUpdateUserRole,
} from "../Controller/AdminController.js";
import { requireRole } from "../Middleware/requireRole.js";
import { verifyToken } from "../Middleware/verifyToken.js";

const router = express.Router();

router.use(verifyToken, requireRole(["Admin", "SuperAdmin"]));
router.post("/create-user", AdminCreateUser);
router.get("/users", AdminListUsers);
router.get("/users/:id", AdminGetSingleUser);
router.patch("/users/:id/role", AdminUpdateUserRole);
router.patch("/users/:id/disable", AdminDisableUser);
router.delete("/users/:id", AdminDeleteUser);
router.get("/sessions/stats", AdminSessionStats);

export default router;
