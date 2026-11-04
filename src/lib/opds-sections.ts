// src/lib/opds-sections.ts
//
// The catalog root's sections (#221 points 1 and 2): Continue Reading, Recently Added, On Deck and
// Libraries. Each is a feed of its own, linked from the root next to "All Series".
//
// Continue Reading and On Deck reuse the Komga facade's own loaders (lib/komga/data.ts) so their
// selection rules have exactly one implementation, and then re-read the rows they chose: the facade
// returns Komga DTOs shaped for Paperback (the file basename as `name`, the story title folded into
// `metadata.title`, no publisher), while an OPDS entry needs the raw row to compose
// `Series #N - Title`, render <author> from the credit columns and type the acquisition link.
import { prisma } from '@/lib/db';
import type { Prisma } from '@prisma/client';
import { escapeXml } from '@/lib/utils/xml';
import { nestedSeriesAccessWhere, seriesAccessWhere, type AccessibleLibraries } from '@/lib/library-access';
import { inProgressBooks, onDeckBooks } from '@/lib/komga/data';
import { entryUpdated, issueEntry, type IssueProgress } from '@/lib/opds-feed';
import { progressByIssueId } from '@/lib/opds-progress';
import { OMNIBUS_OPDS, type OpdsFlavour } from '@/lib/opds-flavour';

/** How many entries a root section shows. */
export const SECTION_SIZE = 20;

export const SECTION_NAMES = ['continue', 'recent', 'ondeck', 'libraries'] as const;
export type SectionName = (typeof SECTION_NAMES)[number];

export function isSectionName(value: string): value is SectionName {
    return (SECTION_NAMES as readonly string[]).includes(value);
}

const SERIES_FIELDS = { id: true, name: true, publisher: true, writers: true, artists: true } as const;

export interface SectionFeed {
    id: string;
    title: string;
    kind: 'navigation' | 'acquisition';
    entries: string;
    /** The stamps the feed's own `<updated>` is derived from. */
    stamps: Array<Date | string | null | undefined>;
}

/** The raw rows behind a set of issue ids, in the order the ids were given. */
async function issuesByIds(ids: string[]) {
    if (ids.length === 0) return [];
    const rows = await prisma.issue.findMany({
        where: { id: { in: ids } },
        include: { series: { select: SERIES_FIELDS } },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => Boolean(r));
}

/** The entries for a set of issue rows, with the caller's progress folded into each one. */
function issueEntries(
    baseUrl: string,
    userId: string,
    rows: Awaited<ReturnType<typeof issuesByIds>>,
    progress: Map<string, IssueProgress>,
    flavour: OpdsFlavour,
): string {
    return rows
        .map((r) => issueEntry(baseUrl, r.series, r, {
            pageCount: r.pageCount ?? 0,
            progress: progress.get(r.id) ?? null,
            flavour,
        }))
        .join('');
}

/**
 * Continue Reading / On Deck — the caller's own started-unfinished books, and the next book after
 * the last one they finished. Both come from the Komga facade's loaders, which already fold in the
 * library grants and the user's progress.
 *
 * `pse:count` is the stored `pageCount`: the series feed is what heals a zero one (it reads the
 * archive, writes the count back and is the normal browsing path), and doing that here would read
 * an archive per entry on the catalog's home screen.
 */
export async function loadIssueSection(
    kind: 'continue' | 'ondeck',
    userId: string,
    libs: AccessibleLibraries,
    baseUrl: string,
    flavour: OpdsFlavour = OMNIBUS_OPDS,
): Promise<SectionFeed> {
    const page = kind === 'continue'
        ? await inProgressBooks(userId, libs, 0, SECTION_SIZE)
        : await onDeckBooks(userId, libs, SECTION_SIZE);
    const rows = await issuesByIds(page.content.map((b) => b.id));
    const progress = await progressByIssueId(userId, rows.map((r) => r.id));
    return {
        id: `urn:omnibus:${kind}`,
        title: kind === 'continue' ? 'Continue Reading' : 'On Deck',
        kind: 'acquisition',
        entries: issueEntries(baseUrl, userId, rows, progress, flavour),
        stamps: rows.map((r) => r.updatedAt),
    };
}

/**
 * Recently Added, by `Issue.fileAddedAt` — when the file that is there now arrived. `createdAt`
 * would miss every download that filled a monitored placeholder (the skeleton row is older).
 */
export async function loadRecentSection(userId: string, libs: AccessibleLibraries, baseUrl: string, flavour: OpdsFlavour = OMNIBUS_OPDS): Promise<SectionFeed> {
    const rows = await prisma.issue.findMany({
        where: {
            AND: [
                { filePath: { not: null } },
                { fileAddedAt: { not: null } },
                nestedSeriesAccessWhere(libs) as Prisma.IssueWhereInput,
            ],
        },
        include: { series: { select: SERIES_FIELDS } },
        orderBy: [{ fileAddedAt: 'desc' }, { id: 'asc' }],
        take: SECTION_SIZE,
    });
    const progress = await progressByIssueId(userId, rows.map((r) => r.id));
    return {
        id: 'urn:omnibus:recent',
        title: 'Recently Added',
        kind: 'acquisition',
        entries: issueEntries(baseUrl, userId, rows, progress, flavour),
        stamps: rows.map((r) => r.updatedAt),
    };
}

/**
 * The libraries the caller may browse, each a navigation entry into `?library=<id>`. A library has
 * no timestamp of its own, so its `<updated>` is its newest series' — the moment it last changed.
 */
export async function loadLibrariesSection(libs: AccessibleLibraries, baseUrl: string, flavour: OpdsFlavour = OMNIBUS_OPDS): Promise<SectionFeed> {
    const [libraries, newest] = await Promise.all([
        prisma.library.findMany({
            where: libs === 'ALL' ? {} : { id: { in: libs } },
            orderBy: { name: 'asc' },
        }),
        prisma.series.groupBy({
            by: ['libraryId'],
            where: seriesAccessWhere(libs) as Prisma.SeriesWhereInput,
            _max: { updatedAt: true },
        }),
    ]);
    const lastChange = new Map(newest.map((g) => [g.libraryId, g._max.updatedAt]));

    const entries = libraries.map((lib) => `
  <entry>
    <title>${escapeXml(lib.name)}</title>
    <id>urn:omnibus:library:${lib.id}</id>
    <updated>${entryUpdated(lastChange.get(lib.id) ?? null)}</updated>
    <content type="text">${escapeXml(lib.name)}</content>
    <link rel="subsection" href="${baseUrl}${flavour.base}/series?library=${encodeURIComponent(lib.id)}" type="application/atom+xml;profile=opds-catalog;kind=navigation"/>
  </entry>`).join('');

    return {
        id: 'urn:omnibus:libraries',
        title: 'Libraries',
        kind: 'navigation',
        entries,
        stamps: libraries.map((lib) => lastChange.get(lib.id) ?? null),
    };
}
