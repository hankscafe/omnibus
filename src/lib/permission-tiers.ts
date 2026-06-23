// src/lib/permission-tiers.ts
//
// Themed permission tiers ("quick-apply presets"). A tier is just a named bundle of the underlying
// per-user permission flags; applying one writes those flags onto the user — admins can still toggle
// individual flags afterward. The tier shown for a user is DERIVED from their flags via `tierFromUser`,
// so a hand-edited combo that matches no preset shows as "Custom". There is no stored `tier` column, so
// nothing can drift out of sync.
//
// Phase 1 manages the request/download/global-list flags below. Phase 2 layers library access on top
// via TIER_ALL_LIBRARIES (Civilian/Sidekick → default Comics only; Vigilante/Hero → ALL libraries).
//
// Isomorphic (no server-only imports) so both the admin client page and server routes can use it.

export interface TierFlags {
  canRequest: boolean;
  autoApproveRequests: boolean;
  canDownload: boolean;
  canCreateGlobalLists: boolean;
}

export type TierName = "Civilian" | "Sidekick" | "Vigilante" | "Hero";

/** Ordered low → high. The UI renders this ladder; `tierFromUser` matches against it. */
export const PERMISSION_TIERS: { name: TierName; description: string; flags: TierFlags }[] = [
  {
    name: "Civilian",
    description: "Read the default Comics library only. Cannot request, download, or create global lists.",
    flags: { canRequest: false, autoApproveRequests: false, canDownload: false, canCreateGlobalLists: false },
  },
  {
    name: "Sidekick",
    description: "Request (needs admin approval) and download. Default Comics library.",
    flags: { canRequest: true, autoApproveRequests: false, canDownload: true, canCreateGlobalLists: false },
  },
  {
    name: "Vigilante",
    description: "Request (needs admin approval), download, and create global lists. All libraries.",
    flags: { canRequest: true, autoApproveRequests: false, canDownload: true, canCreateGlobalLists: true },
  },
  {
    name: "Hero",
    description: "Auto-approved requests, download, and global lists. All libraries.",
    flags: { canRequest: true, autoApproveRequests: true, canDownload: true, canCreateGlobalLists: true },
  },
];

/** Whether applying a tier should grant ALL libraries (true) or only the default Comics library (false).
 *  Consumed in Phase 2 when applying a tier rewrites the user's UserLibraryAccess rows. */
export const TIER_ALL_LIBRARIES: Record<TierName, boolean> = {
  Civilian: false,
  Sidekick: false,
  Vigilante: true,
  Hero: true,
};

const TIER_BY_NAME = Object.fromEntries(PERMISSION_TIERS.map((t) => [t.name, t])) as Record<
  TierName,
  (typeof PERMISSION_TIERS)[number]
>;

export function tierFlags(name: TierName): TierFlags {
  return TIER_BY_NAME[name].flags;
}

/** Derive a user's display tier from their flags. ADMIN is its own label; an unrecognized combo is "Custom". */
export function tierFromUser(u: {
  role?: string | null;
  canRequest?: boolean | null;
  autoApproveRequests?: boolean | null;
  canDownload?: boolean | null;
  canCreateGlobalLists?: boolean | null;
}): TierName | "Admin" | "Custom" {
  if (u.role === "ADMIN") return "Admin";
  const match = PERMISSION_TIERS.find(
    (t) =>
      !!u.canRequest === t.flags.canRequest &&
      !!u.autoApproveRequests === t.flags.autoApproveRequests &&
      !!u.canDownload === t.flags.canDownload &&
      !!u.canCreateGlobalLists === t.flags.canCreateGlobalLists,
  );
  return match ? match.name : "Custom";
}
