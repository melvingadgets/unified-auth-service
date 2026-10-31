import express from "express";
import { CheckSession, GetPerson, LookupPerson } from "../Controller/PlatformInternalController.js";
import { InternalSendMail } from "../Controller/InternalMailController.js";
import { requireAuthScope } from "../Middleware/platformGuards.js";

const router = express.Router();

router.get("/sessions/:sid", requireAuthScope("auth:sessions.check"), CheckSession);
router.get("/people/:personId", requireAuthScope("auth:people.read"), GetPerson);
router.post("/people/lookup", requireAuthScope("auth:people.read"), LookupPerson);
router.post("/mail/send", requireAuthScope("auth:people.read"), InternalSendMail);

export default router;
