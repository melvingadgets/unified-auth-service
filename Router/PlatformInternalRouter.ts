import express from "express";
import { CheckSession, GetPerson, LookupPerson } from "../Controller/PlatformInternalController.js";
import { requireAuthScope } from "../Middleware/platformGuards.js";

const router = express.Router();

router.get("/sessions/:sid", requireAuthScope("auth:sessions.check"), CheckSession);
router.get("/people/:personId", requireAuthScope("auth:people.read"), GetPerson);
router.post("/people/lookup", requireAuthScope("auth:people.read"), LookupPerson);

export default router;
