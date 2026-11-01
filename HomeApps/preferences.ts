import { HomeAppsModel, toView, type HomeAppState, type HomeAppsView } from "./model.js";

// The rules behind /api/v1/auth/me/home-apps (Shortwork/docs/app-store.md §3). Every query is
// scoped by the personId from the verified token, so one person's choices are never read or written
// by another — and an unknown id behaves exactly like someone else's.

/** Bounds that keep a person from using this collection as a general-purpose key-value store. */
export const MAX_APPS = 64;
export const MAX_APP_NAME_LENGTH = 40;
export const MAX_CHANGES = 32;

/**
 * App names are display names and storage keys at once (`AppName` in the hub), and they become
 * Mongo path keys, so this is stricter than "letters and spaces".
 *
 * - It must start with a letter: blocks `$set` (an operator), a leading space (invisible), and "".
 * - A space must come AFTER a letter and before a letter: blocks "Chat " and "Chat  Name", which
 *   would otherwise be distinct keys from "Chat" and "Chat Name" and silently split one app's
 *   preference into two.
 * - No `.` at all, or `Chat.Chat` becomes a nested path inside the apps subdocument.
 */
const APP_NAME = /^[A-Za-z]+(?: [A-Za-z]+)*$/;

export class HomeAppsInputError extends Error {}

export const isValidAppName = (value: unknown): value is string =>
  typeof value === "string" && value.length <= MAX_APP_NAME_LENGTH && APP_NAME.test(value);

export interface Change {
  name: string;
  state: HomeAppState;
}

/** Validates the `changes` object of a PATCH body. Accepts a partial map, like `{ Chat: "removed" }`. */
export const parseChanges = (raw: unknown): Change[] => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HomeAppsInputError("changes must be an object of app name to state");
  }

  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) throw new HomeAppsInputError("changes must not be empty");
  if (entries.length > MAX_CHANGES) throw new HomeAppsInputError(`change at most ${MAX_CHANGES} apps at once`);

  return entries.map(([name, state]) => {
    if (!isValidAppName(name)) {
      // Deliberately does not echo the rejected value: it may be an attempted injection.
      throw new HomeAppsInputError("an app name must be letters and spaces only, starting with a letter");
    }
    if (state !== "added" && state !== "removed") {
      throw new HomeAppsInputError(`${name} must be "added" or "removed"`);
    }
    return { name, state };
  });
};

export const parseVersion = (raw: unknown): number => {
  const version = Number(raw);
  if (!Number.isInteger(version) || version < 0) {
    throw new HomeAppsInputError("version must be a non-negative integer");
  }
  return version;
};

/** True when the caller did not send a version at all — used to tell a PATCH from an initial PUT. */
export const isMissingVersion = (raw: unknown): boolean => raw === undefined || raw === null || raw === "";

export const readHomeApps = async (personId: string): Promise<HomeAppsView> => {
  const record = await HomeAppsModel.findOne({ personId }).lean();
  return toView(record);
};

/**
 * Applies a set of changes at a version.
 *
 * Returns the new view, or the CURRENT view when the version did not match — the caller turns that
 * into a 409 so the client can re-apply its change to what is actually stored (§4, "re-applying
 * after a 409"). A mismatch is not an error the person should see; it means another device wrote
 * first.
 */
export type PatchResult =
  | { ok: true; view: HomeAppsView }
  | { ok: false; current: HomeAppsView };

export const patchHomeApps = async (
  personId: string,
  changes: Change[],
  version: number,
  now: Date = new Date()
): Promise<PatchResult> => {
  // Build the $set paths. App names are validated above, so they are safe as path segments; the
  // value is always a literal here, never a caller-supplied object.
  const set: Record<string, HomeAppState> = {};
  for (const change of changes) set[`apps.${change.name}`] = change.state;

  const updated = await HomeAppsModel.findOneAndUpdate(
    // version in the filter is the whole point: it makes the read-modify-write atomic (§3.8).
    { personId, version },
    { $set: { ...set, updatedAt: now }, $inc: { version: 1 } },
    { new: true }
  ).lean();

  if (updated) {
    // Drop `removed` entries that would only pad the document; "removed" is meaningful only for a
    // person who is signed in and looking at their own screen. Not worth a second write here — the
    // view is correct either way — so this is left to compaction in a later migration if needed.
    return { ok: true, view: toView(updated) };
  }

  // No match. Either there is no document yet (version must be 0 to create one) or the version moved.
  const existing = await HomeAppsModel.findOne({ personId }).lean();
  if (existing) return { ok: false, current: toView(existing) };

  if (version !== 0) {
    // The client believes it has a document this person does not have (a stale device). Sending the
    // empty view back lets it re-send from version 0.
    return { ok: false, current: toView(null) };
  }

  // First write. The unique index on personId makes this safe under concurrency: the loser of a race
  // gets a duplicate-key error and we retry once against the document the winner created.
  try {
    const created = await HomeAppsModel.create({
      personId,
      apps: Object.fromEntries(Object.entries(set).map(([path, state]) => [path.slice("apps.".length), state])),
      version: 1,
      updatedAt: now,
      createdAt: now,
    });
    return { ok: true, view: toView(created.toObject()) };
  } catch (error) {
    if (isDuplicateKey(error)) {
      const winner = await HomeAppsModel.findOne({ personId }).lean();
      return { ok: false, current: toView(winner) };
    }
    throw error;
  }
};

const isDuplicateKey = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: number }).code === 11000;

/**
 * Replaces the whole map at a version. Used for the first upload of a device's local set and for a
 * full reset (the Setup Assistant). Same optimistic-concurrency contract as `patchHomeApps`.
 */
export const replaceHomeApps = async (
  personId: string,
  apps: Record<string, HomeAppState>,
  version: number,
  now: Date = new Date()
): Promise<PatchResult> => {
  const entries = Object.entries(apps);
  if (entries.length > MAX_APPS) throw new HomeAppsInputError(`keep at most ${MAX_APPS} apps`);
  for (const [name] of entries) {
    if (!isValidAppName(name)) {
      throw new HomeAppsInputError("an app name must be letters and spaces only, starting with a letter");
    }
  }

  const updated = await HomeAppsModel.findOneAndUpdate(
    { personId, version },
    { $set: { apps, updatedAt: now }, $inc: { version: 1 } },
    { new: true }
  ).lean();

  if (updated) return { ok: true, view: toView(updated) };

  const existing = await HomeAppsModel.findOne({ personId }).lean();
  if (existing) return { ok: false, current: toView(existing) };
  if (version !== 0) return { ok: false, current: toView(null) };

  try {
    const created = await HomeAppsModel.create({ personId, apps, version: 1, updatedAt: now, createdAt: now });
    return { ok: true, view: toView(created.toObject()) };
  } catch (error) {
    if (isDuplicateKey(error)) {
      const winner = await HomeAppsModel.findOne({ personId }).lean();
      return { ok: false, current: toView(winner) };
    }
    throw error;
  }
};
