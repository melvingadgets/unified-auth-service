import mongoose from "mongoose";

// A person's home-screen choices (Shortwork/docs/app-store.md §3). One document per person.
//
// This module decides NOTHING about access. It records a display preference: which apps sit on the
// home screen. Whether someone is a reseller, a vendor or a customer stays owned by each backend
// (`VendorProfile.status`, the reseller service's `Reseller` record), and no route anywhere may read
// this collection to allow or refuse anything. "On my home screen" is not a grant.

/** `"added"` or `"removed"`. Absent means "never chosen", which is not the same as `"removed"`. */
export type HomeAppState = "added" | "removed";

export interface HomeAppsRecord {
  personId: string;
  apps: Record<string, HomeAppState>;
  /** Incremented on every write. A PATCH must carry the version it read (§3.8). */
  version: number;
  updatedAt: Date;
  createdAt: Date;
}

const homeAppsSchema = new mongoose.Schema<HomeAppsRecord>(
  {
    // Unique: the first write relies on this index rather than findOne-then-create (AGENTS.md §3.8),
    // so two concurrent first writes from one person cannot make two documents.
    personId: { type: String, required: true, unique: true },
    apps: { type: mongoose.Schema.Types.Mixed, required: true, default: {} },
    version: { type: Number, required: true, default: 0 },
    updatedAt: { type: Date, required: true },
    createdAt: { type: Date, required: true },
  },
  { versionKey: false, collection: "home_apps" }
);

export const HomeAppsModel = mongoose.model<HomeAppsRecord>("HomeApps", homeAppsSchema);

/** What a person sees before they have ever saved a choice. */
export interface HomeAppsView {
  /** False until this person has saved anything; the hub then uploads its local set. */
  configured: boolean;
  apps: Record<string, HomeAppState>;
  version: number;
}

export const emptyView = (): HomeAppsView => ({ configured: false, apps: {}, version: 0 });

export const toView = (record: HomeAppsRecord | null): HomeAppsView => {
  if (!record) return emptyView();
  return { configured: true, apps: { ...record.apps }, version: record.version };
};
