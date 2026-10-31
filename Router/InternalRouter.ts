import express from "express";
import { InternalBulkUsers, InternalValidateSession } from "../Controller/InternalController.js";
import { InternalSendMail } from "../Controller/InternalMailController.js";
import { serviceKeyAuth } from "../Middleware/serviceKeyAuth.js";

const router = express.Router();

router.use(serviceKeyAuth);
router.post("/validate-session", InternalValidateSession);
router.post("/bulk-users", InternalBulkUsers);
router.post("/mail/send", InternalSendMail);

export default router;
