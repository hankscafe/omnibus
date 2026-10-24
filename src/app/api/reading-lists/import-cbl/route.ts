// src/app/api/reading-lists/import-cbl/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';
import { Logger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/utils/error';
import { XMLParser } from 'fast-xml-parser';
import { assertSafeFetchUrl } from '@/lib/utils/ssrf';

export const dynamic = 'force-dynamic';

type Source = 'COMICVINE' | 'METRON';

/** One <Book> of a CBL. DieselTech's lists (cbl-tools' format) carry the volume's start year and the
 *  provider's ids: <Book Series="Batman" Number="651" Volume="1940" Year="2006"><Database Name="cv"
 *  Series="796" Issue="121997" /></Book>. Older ComicRack lists have only Series and Number. */
interface CblBook {
    series: string;
    number: string;
    startYear: number | null;
    source: Source | null;
    volumeId: string | null;
    issueId: string | null;
}

const DATABASE_SOURCES: Record<string, Source> = { cv: 'COMICVINE', comicvine: 'COMICVINE', metron: 'METRON' };

const digits = (v: unknown): string | null => {
    const s = String(v ?? '').trim();
    return /^\d+$/.test(s) ? s : null;
};
// ReadingListItem.cvIssueId is an Int: an id that can't be stored is no id at all.
const issueIdOf = (v: unknown): string | null => {
    const s = digits(v);
    return s && Number(s) <= 2_147_483_647 ? s : null;
};

type RawDatabase = { Name?: unknown; Series?: unknown; Issue?: unknown };
/** A <Book> as fast-xml-parser hands it over: attributes unprefixed, child elements as keys. */
type RawBook = { Series?: unknown; series?: unknown; Number?: unknown; number?: unknown; Volume?: unknown; Database?: RawDatabase | RawDatabase[] };

function readBook(book: RawBook): CblBook | null {
    const series = book.Series || book.series;
    if (!series) return null;
    // A book may list several databases; ComicVine's ids are the ones Omnibus matches by default.
    const databases = (Array.isArray(book.Database) ? book.Database : [book.Database])
        .map(db => ({
            source: DATABASE_SOURCES[String(db?.Name ?? '').trim().toLowerCase()] as Source | undefined,
            volumeId: digits(db?.Series),
            issueId: issueIdOf(db?.Issue),
        }))
        .filter((db): db is { source: Source; volumeId: string | null; issueId: string } => !!db.source && !!db.issueId);
    const db = databases.find(d => d.source === 'COMICVINE') ?? databases[0];
    const startYear = parseInt(String(book.Volume ?? ''), 10);
    return {
        series: String(series),
        number: String(book.Number || book.number || '1'),
        startYear: startYear > 0 ? startYear : null,
        source: db?.source ?? null,
        volumeId: db?.volumeId ?? null,
        issueId: db?.issueId ?? null,
    };
}

const SERIES_FIELDS = { id: true, name: true, year: true, coverUrl: true, folderPath: true, metadataId: true, metadataSource: true } as const;
type SeriesRow = { id: string; name: string; year: number; coverUrl: string | null; folderPath: string; metadataId: string | null; metadataSource: string };

const providerIdsWhere = (idsBySource: Map<Source, Set<string>>) =>
    Array.from(idsBySource, ([metadataSource, ids]) => ({ metadataSource, metadataId: { in: Array.from(ids) } }));

/** The series a book's name points at. A series that carries the SAME provider's id for a DIFFERENT
 *  volume is never a candidate (a 2011 "Batman" is not the 1940 one). Among the rest the book's start
 *  year decides (exact, then one off - ComicVine's start year and a folder's year often disagree by
 *  one); with no year match, only a single candidate is taken, and a book with no start year at all
 *  keeps the old first-exact-name rule. */
function seriesByName(book: CblBook, allSeries: SeriesRow[], normalize: (s: string) => string): SeriesRow | null {
    const key = normalize(book.series);
    const compatible = (s: SeriesRow) =>
        !(book.source && book.volumeId && s.metadataSource === book.source && digits(s.metadataId) && s.metadataId !== book.volumeId);
    // Prefer an exact normalized match; only fall back to a prefix match when it's unambiguous (a
    // single candidate), so 'Batman' can't silently link to 'Batman Beyond' / 'Batman and Robin'.
    const exact = allSeries.filter(s => normalize(s.name) === key).filter(compatible);
    if (exact.length === 0) {
        const prefix = allSeries.filter(s => normalize(s.name).startsWith(key)).filter(compatible);
        return prefix.length === 1 ? prefix[0] : null;
    }
    if (book.startYear === null) return exact[0];
    const year = book.startYear;
    return exact.find(s => s.year === year)
        ?? exact.find(s => Math.abs(s.year - year) === 1)
        ?? (exact.length === 1 ? exact[0] : null);
}

export async function POST(request: Request) {
    const authOptions = await getAuthOptions();
    const session = await getServerSession(authOptions);
    const userId = (session?.user as any)?.id;

    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    try {
        const formData = await request.formData();
        const file = formData.get('file') as File;
        const url = formData.get('url') as string;
        const listName = formData.get('name') as string;
        const isGlobal = formData.get('isGlobal') === 'true';

        if (!listName || (!file && !url)) {
            return NextResponse.json({ error: "List Name and either a File or URL are required." }, { status: 400 });
        }

        let xmlContent = "";

        if (file) {
            xmlContent = await file.text();
        } else if (url) {
            try {
                // SSRF guard: only public http(s) hosts, no redirects (which could bounce to an internal
                // address), a hard timeout, and a body-size cap.
                assertSafeFetchUrl(url);
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 8000);
                const res = await fetch(url, { signal: controller.signal, redirect: 'error' });
                clearTimeout(timeoutId);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                if (parseInt(res.headers.get('content-length') || '0', 10) > 5_000_000) throw new Error('CBL too large');
                xmlContent = await res.text();
                if (xmlContent.length > 5_000_000) throw new Error('CBL too large');
            } catch (e) {
                return NextResponse.json({ error: "Failed to download CBL from the provided URL." }, { status: 400 });
            }
        }

        if (!xmlContent) return NextResponse.json({ error: "CBL file is empty or unreadable." }, { status: 400 });

        const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
        let parsed: any;
        try {
            parsed = parser.parse(xmlContent);
        } catch (e) {
            return NextResponse.json({ error: "Invalid XML format." }, { status: 400 });
        }

        if (!parsed?.ReadingList?.Books?.Book) {
            return NextResponse.json({ error: "Could not find any books in this CBL file." }, { status: 400 });
        }

        let rawBooks = parsed.ReadingList.Books.Book;
        if (!Array.isArray(rawBooks)) rawBooks = [rawBooks];
        const books = (rawBooks as RawBook[]).map(readBook).filter((b): b is CblBook => b !== null);

        const normalize = (str: string) => str ? str.toLowerCase().replace(/[^a-z0-9]/g, '') : "";
        const seriesCover = (s: { coverUrl: string | null; folderPath: string | null } | null | undefined) =>
            s ? s.coverUrl || (s.folderPath ? `/api/library/cover?path=${encodeURIComponent(s.folderPath)}` : null) : null;

        Logger.log(`[CBL Import Debug] Processing ${books.length} items from CBL...`, 'debug');

        // 1. The provider's own ids, one query each for the whole file: issues by issue id, series by volume id.
        const issueIdsBySource = new Map<Source, Set<string>>();
        const volumeIdsBySource = new Map<Source, Set<string>>();
        for (const b of books) {
            if (!b.source) continue;
            if (b.issueId) issueIdsBySource.set(b.source, (issueIdsBySource.get(b.source) ?? new Set<string>()).add(b.issueId));
            if (b.volumeId) volumeIdsBySource.set(b.source, (volumeIdsBySource.get(b.source) ?? new Set<string>()).add(b.volumeId));
        }
        const issuesById = issueIdsBySource.size > 0
            ? await prisma.issue.findMany({
                where: { OR: providerIdsWhere(issueIdsBySource) },
                select: { id: true, metadataId: true, metadataSource: true, series: { select: { coverUrl: true, folderPath: true } } },
            })
            : [];
        const seriesByVolume: SeriesRow[] = volumeIdsBySource.size > 0
            ? await prisma.series.findMany({ where: { OR: providerIdsWhere(volumeIdsBySource) }, select: SERIES_FIELDS })
            : [];
        const issueById = (b: CblBook) =>
            b.issueId ? issuesById.find(i => i.metadataSource === b.source && i.metadataId === b.issueId) : undefined;

        // 2. A series for every book its issue id didn't settle: by volume id, else by name (the whole
        //    series list is loaded only when some book needs a name match).
        let allSeries: SeriesRow[] | null = null;
        const seriesFor = new Map<CblBook, SeriesRow | null>();
        for (const b of books) {
            if (issueById(b)) continue;
            const byVolume = b.volumeId ? seriesByVolume.find(s => s.metadataSource === b.source && s.metadataId === b.volumeId) : undefined;
            if (byVolume) {
                seriesFor.set(b, byVolume);
                continue;
            }
            allSeries ??= await prisma.series.findMany({ select: SERIES_FIELDS });
            seriesFor.set(b, seriesByName(b, allSeries, normalize));
        }

        // 3. Issue numbers, only in the matched series' own run - an annual or an attached edition can
        //    share a number with the run's issue.
        const matchedSeriesIds = Array.from(new Set(Array.from(seriesFor.values()).flatMap(s => (s ? [s.id] : []))));
        const runIssues = matchedSeriesIds.length > 0
            ? await prisma.issue.findMany({
                where: { seriesId: { in: matchedSeriesIds }, isAnnual: false, attachedVolumeId: null },
                select: { id: true, seriesId: true, number: true },
            })
            : [];

        const itemsToLink: { issueId: string | null; title: string; cvIssueId?: number; metadataSource?: Source }[] = [];
        let missingCount = 0;
        let listCoverUrl: string | null = null;

        for (const b of books) {
            const title = `${b.series} #${b.number}`;
            Logger.log(`[CBL Import Debug] Evaluating CBL entry: "${title}"`, 'debug');

            let matchedIssueId: string | null = null;
            const byId = issueById(b);
            if (byId) {
                matchedIssueId = byId.id;
                if (!listCoverUrl) listCoverUrl = seriesCover(byId.series);
                Logger.log(`[CBL Import Debug] SUCCESS -> Linked by ${b.source} issue id ${b.issueId} [ID: ${matchedIssueId}]`, 'debug');
            } else {
                const matchedSeries = seriesFor.get(b);
                if (matchedSeries) {
                    if (!listCoverUrl) listCoverUrl = seriesCover(matchedSeries);
                    const parsedTargetNum = parseFloat(b.number.replace(/[^0-9.-]/g, ''));
                    const matchedIssue = runIssues.find(iss => iss.seriesId === matchedSeries.id && parseFloat(iss.number) === parsedTargetNum);
                    if (matchedIssue) {
                        matchedIssueId = matchedIssue.id;
                        Logger.log(`[CBL Import Debug] SUCCESS -> Linked to local issue [ID: ${matchedIssueId}]`, 'debug');
                    } else {
                        Logger.log(`[CBL Import Debug] FAILED -> Matched series "${matchedSeries.name}", but issue #${b.number} is missing.`, 'debug');
                    }
                } else {
                    Logger.log(`[CBL Import Debug] FAILED -> No local series matched "${b.series}".`, 'debug');
                }
            }
            if (!matchedIssueId) missingCount++;

            // The provider's issue id rides along, linked or not: opening the list links an entry once its
            // issue is in the library, and Request finds the right volume from it instead of guessing.
            itemsToLink.push({
                issueId: matchedIssueId,
                title,
                ...(b.source && b.issueId ? { cvIssueId: parseInt(b.issueId, 10), metadataSource: b.source } : {}),
            });
        }

        if (itemsToLink.length === 0) {
            return NextResponse.json({ error: "Could not extract any valid comics from this CBL file." }, { status: 400 });
        }

        const canMakeGlobal = (session?.user as any)?.role === 'ADMIN' || (session?.user as any)?.canCreateGlobalLists === true;

        const newList = await prisma.readingList.create({
            data: {
                name: listName,
                description: `Imported from CBL. Items not currently in your library: ${missingCount}`,
                coverUrl: listCoverUrl, 
                isGlobal: isGlobal === true && canMakeGlobal,
                userId: userId
            }
        });

        let orderCount = 0;
        const itemsData = itemsToLink.map(item => ({
            listId: newList.id,
            issueId: item.issueId,
            title: item.title,
            order: orderCount++,
            ...(item.cvIssueId !== undefined ? { cvIssueId: item.cvIssueId, metadataSource: item.metadataSource } : {}),
        }));

        await prisma.readingListItem.createMany({ data: itemsData });

        return NextResponse.json({ 
            success: true, 
            listId: newList.id,
            message: `Successfully imported ${itemsToLink.length} issues into "${listName}"!` 
        });

    } catch (error: unknown) {
        Logger.log(`CBL Import Error: ${getErrorMessage(error)}`, 'error');
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
    }
}