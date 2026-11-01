import express, { type Request, type Response } from "express";
import { verifyToken } from "../Middleware/verifyToken.js";
import {
  HomeAppsInputError,
  isMissingVersion,
  parseChanges,
  parseVersion,
  patchHomeApps,
  readHomeApps,
  replaceHomeApps,
} from "./preferences.js";

// /api/v1/auth/me/home-apps (Shortwork/docs/app-store.md §3). The person always comes from the
// verified token, never from the request (AGENTS.md §2.5) — there is no :personId parameter to
// tamper with, by design.

const personOf = (req: Request): string => (req.user?._id ? String(req.user._id) : "");

const fail = (res: Response, error: unknown, what: string) => {
  if (error instanceof HomeAppsInputError) return res.status(400).json({ message: error.message });
  return res.status(500).json({ message: `could not ${what}` });
};

const router = express.Router();

router.get("/", verifyToken, async (req: Request, res: Response) => {
  const personId = personOf(req);
  if (!personId) return res.status(401).json({ message: "please login to get token" });
  try {
    return res.status(200).json(await readHomeApps(personId));
  } catch (error) {
    return fail(res, error, "load your home screen");
  }
});

/**
 * PATCH { changes, version } — apply a partial change at a version.
 *
 * 409 with the current state when the version moved, so the caller can merge and retry. The body
 * carries `version` rather than an `If-Match` header on purpose: the browser calls this cross-origin
 * with the person's own token, and every header it sends has to be added to each service's CORS
 * allow-list, where a blocked preflight leaves no log on the server.
 */
router.patch("/", verifyToken, async (req: Request, res: Response) => {
  const personId = personOf(req);
  if (!personId) return res.status(401).json({ message: "please login to get token" });

  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const changes = parseChanges(body.changes);

    // A missing version means "I have never saved" — the same as 0 for a first write, and a 409 for
    // anyone who already has a document. This keeps older hub builds working.
    const version = isMissingVersion(body.version) ? 0 : parseVersion(body.version);

    const result = await patchHomeApps(personId, changes, version);
    if (!result.ok) return res.status(409).json(result.current);
    return res.status(200).json(result.view);
  } catch (error) {
    return fail(res, error, "save your home screen");
  }
});

/** PUT { apps, version } — replace the whole map. Used for a first upload or a full reset. */
router.put("/", verifyToken, async (req: Request, res: Response) => {
  const personId = personOf(req);
  if (!personId) return res.status(401).json({ message: "please login to get token" });

  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const apps = body.apps;
    if (!apps || typeof apps !== "object" || Array.isArray(apps)) {
      throw new HomeAppsInputError("apps must be an object of app name to state");
    }
    const version = isMissingVersion(body.version) ? 0 : parseVersion(body.version);

    const result = await replaceHomeApps(personId, apps as Record<string, "added" | "removed">, version);
    if (!result.ok) return res.status(409).json(result.current);
    return res.status(200).json(result.view);
  } catch (error) {
    return fail(res, error, "save your home screen");
  }
});

export default router;
