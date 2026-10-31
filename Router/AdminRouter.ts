import express from "express";
import { requirePermission } from "@melvingadgets/platform-kit";
import {
  AdminCreateUser,
  AdminDeleteUser,
  AdminDisableUser,
  AdminGetSingleUser,
  AdminListUsers,
  AdminSessionStats,
  AdminUpdateUserDomainRoles,
  AdminUpdateUserRole,
} from "../Controller/AdminController.js";
import { verifyToken } from "../Middleware/verifyToken.js";

const router = express.Router();

// Every route names the permission it needs (docs/rbac-unification.md). A blanket
// `requireRole(["Admin","SuperAdmin"])` used to guard all of them, which excluded a
// SuperAdmin from nothing but also gave an Admin every route in this file.
router.use(verifyToken);

router.post("/create-user", requirePermission("auth.users.create_user"), AdminCreateUser);
router.get("/users", requirePermission("auth.users.read"), AdminListUsers);
router.get("/users/:id", requirePermission("auth.users.read"), AdminGetSingleUser);
// Changing a role or a domain role is SuperAdmin work; so is deleting a person.
router.patch("/users/:id/role", requirePermission("auth.users.change_role"), AdminUpdateUserRole);
router.patch("/users/:id/domain-roles", requirePermission("auth.users.change_role"), AdminUpdateUserDomainRoles);
router.patch("/users/:id/disable", requirePermission("auth.users.change_role"), AdminDisableUser);
router.delete("/users/:id", requirePermission("auth.users.delete"), AdminDeleteUser);
router.get("/sessions/stats", requirePermission("auth.users.read"), AdminSessionStats);

export default router;
