// src/lib/library-access.ts
//
// Per-library access control. Non-admin users see only the libraries they've been granted
// (UserLibraryAccess rows); admins bypass everything. This is the single chokepoint every
// user-facing "read library content" route should funnel through — call getAccessibleLibraryIds,
// then apply seriesAccessWhere() to a Series query (or canAccessLibraryId() for a single series).
//
// Enforcement is a fresh DB lookup (not the JWT) so grants/revocations take effect immediately.
import { prisma } from '@/lib/db';

export type AccessibleLibraries = string[] | 'ALL';

/** Library IDs a user may see. ADMIN → 'ALL' (bypass). Otherwise the granted IDs ([] = none). */
export async function getAccessibleLibraryIds(
  userId: string | null | undefined,
  role?: string | null,
): Promise<AccessibleLibraries> {
  if (role === 'ADMIN') return 'ALL';
  if (!userId) return [];
  const rows = await prisma.userLibraryAccess.findMany({ where: { userId }, select: { libraryId: true } });
  return rows.map((r) => r.libraryId);
}

/** Accessible library filesystem paths (the reader validates a file path, not a series id). */
export async function getAccessibleLibraryPaths(
  userId: string | null | undefined,
  role?: string | null,
): Promise<string[] | 'ALL'> {
  if (role === 'ADMIN') return 'ALL';
  if (!userId) return [];
  const rows = await prisma.userLibraryAccess.findMany({
    where: { userId },
    select: { library: { select: { path: true } } },
  });
  return rows.map((r) => r.library.path).filter(Boolean);
}

/** Prisma `where` fragment for a Series query: `{}` for ADMIN, else a `libraryId` filter. Spread into `where`. */
export function seriesAccessWhere(ids: AccessibleLibraries): Record<string, unknown> {
  if (ids === 'ALL') return {};
  return { libraryId: { in: ids } };
}

/** Same fragment but nested under a `series` relation (for Issue / ReadingListItem queries). */
export function nestedSeriesAccessWhere(ids: AccessibleLibraries): Record<string, unknown> {
  if (ids === 'ALL') return {};
  return { series: { libraryId: { in: ids } } };
}

/** Whether a given series' libraryId is accessible. A null libraryId is hidden from non-admins. */
export function canAccessLibraryId(ids: AccessibleLibraries, libraryId: string | null | undefined): boolean {
  if (ids === 'ALL') return true;
  if (!libraryId) return false;
  return ids.includes(libraryId);
}

/** Whether a given filesystem path lives under an accessible library root (for the reader). */
export function canAccessPath(paths: string[] | 'ALL', filePath: string | null | undefined): boolean {
  if (paths === 'ALL') return true;
  if (!filePath) return false;
  const target = filePath.replace(/\\/g, '/').toLowerCase();
  return paths.some((p) => {
    const root = p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    return target === root || target.startsWith(root + '/');
  });
}

/** Libraries a NEW user is seeded with = those an admin flagged `defaultAccess` (managed in Settings).
 *  Falls back to the primary Comics library only when nothing is flagged yet (pre-migration / fresh setup),
 *  so a new user is never left with an empty library by accident. */
export async function getDefaultLibraryIds(): Promise<string[]> {
  const flagged = await prisma.library.findMany({ where: { defaultAccess: true }, select: { id: true } });
  if (flagged.length > 0) return flagged.map((l) => l.id);
  const comics = await prisma.library.findMany({ where: { isManga: false }, select: { id: true, isDefault: true } });
  const def = comics.filter((l) => l.isDefault);
  return (def.length ? def : comics).map((l) => l.id);
}

/** Replace a user's library grants with exactly `libraryIds` (Apply Tier + admin checkboxes). */
export async function setUserLibraryAccess(userId: string, libraryIds: string[]): Promise<void> {
  const unique = Array.from(new Set(libraryIds));
  await prisma.$transaction([
    prisma.userLibraryAccess.deleteMany({ where: { userId } }),
    // No skipDuplicates (unsupported by Prisma's SQLite connector, and unnecessary): the preceding
    // deleteMany clears this user's rows and `unique` is de-duplicated, so no collision is possible.
    ...(unique.length
      ? [prisma.userLibraryAccess.createMany({ data: unique.map((libraryId) => ({ userId, libraryId })) })]
      : []),
  ]);
}

/** Grant a user ALL current libraries (migration backfill + Vigilante/Hero tiers). */
export async function grantAllLibraries(userId: string): Promise<void> {
  const libs = await prisma.library.findMany({ select: { id: true } });
  await setUserLibraryAccess(userId, libs.map((l) => l.id));
}
