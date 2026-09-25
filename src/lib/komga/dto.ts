// src/lib/komga/dto.ts
//
// #206 (Paperback iOS): Omnibus rows → the Komga DTO shapes Paperback's built-in "Paperback"
// source reads. That source (Paperback-iOS/extensions-default, src/Paperback/*.ts, GPL-3.0) is a
// Komga REST client: a manga is a Komga `series`, a chapter is a `book`. It touches a fixed set of
// fields and calls .map / .toLowerCase / .toUpperCase / parseFloat on them without null checks —
// so every mapper here yields a complete, typed object: arrays are never null, strings never
// undefined, numbers never NaN. Pure functions; the DB side lives in ./data.ts.
import path from 'path';
import { normalizeFractionNumbers } from '@/lib/utils/issue-parser';
import { laneLabel, sortIssuesForDisplay } from '@/lib/utils/issue-sort';

// ---------------------------------------------------------------------------------------------
// Input rows (structural — Prisma rows carry more columns than these; that's fine)
// ---------------------------------------------------------------------------------------------

export interface KomgaSeriesRow {
    id: string;
    name: string;
    year?: number | null;
    publisher?: string | null;
    folderPath: string;
    libraryId?: string | null;
    isManga?: boolean | null;
    description?: string | null;
    status?: string | null;
    genres?: string | null;
    tags?: string | null;
    writers?: string | null;
    artists?: string | null;
    languageISO?: string | null;
    createdAt: Date;
    updatedAt: Date;
}

export interface KomgaIssueRow {
    id: string;
    seriesId: string;
    number: string;
    isAnnual?: boolean | null;
    attachedVolumeId?: string | null;
    /** The attached volume's name (#203 lane label) — the data layer lifts it off the relation. */
    attachmentName?: string | null;
    name?: string | null;
    description?: string | null;
    releaseDate?: string | null;
    filePath?: string | null;
    pageCount?: number | null;
    writers?: string | null;
    artists?: string | null;
    createdAt: Date;
    updatedAt: Date;
}

export interface SeriesCounts {
    booksCount: number;
    booksReadCount: number;
    booksInProgressCount: number;
    /** The series' newest Issue.fileAddedAt — its lastModified (#206 follow-up). */
    lastFileAddedAt?: Date | null;
}

export interface KomgaAuthor {
    name: string;
    role: 'writer' | 'penciller';
}

export interface ProgressRow {
    currentPage: number;
    isCompleted: boolean;
    updatedAt: Date;
}

// ---------------------------------------------------------------------------------------------
// Page envelope (Spring Data `Page`) — the source reads only `.content`
// ---------------------------------------------------------------------------------------------

export interface KomgaPage<T> {
    content: T[];
    pageable: { pageNumber: number; pageSize: number; offset: number; paged: boolean; unpaged: boolean; sort: KomgaSort };
    sort: KomgaSort;
    number: number;
    size: number;
    numberOfElements: number;
    totalElements: number;
    totalPages: number;
    first: boolean;
    last: boolean;
    empty: boolean;
}

interface KomgaSort { empty: boolean; sorted: boolean; unsorted: boolean }

const UNSORTED: KomgaSort = { empty: true, sorted: false, unsorted: true };

export function komgaPage<T>(content: T[], page: number, size: number, total: number): KomgaPage<T> {
    const totalPages = size > 0 && total > 0 ? Math.ceil(total / size) : 0;
    return {
        content,
        pageable: { pageNumber: page, pageSize: size, offset: page * size, paged: true, unpaged: false, sort: UNSORTED },
        sort: UNSORTED,
        number: page,
        size,
        numberOfElements: content.length,
        totalElements: total,
        totalPages,
        first: page === 0,
        last: page >= totalPages - 1,
        empty: content.length === 0,
    };
}

// ---------------------------------------------------------------------------------------------
// Scalar helpers
// ---------------------------------------------------------------------------------------------

export type KomgaSeriesStatus = 'ENDED' | 'ONGOING' | 'ABANDONED' | 'HIATUS';

/** Provider status words → Komga's four states. The source lowercases the result, so never null. */
export function mapSeriesStatus(status: string | null | undefined): KomgaSeriesStatus {
    const s = (status ?? '').toLowerCase();
    if (/hiatus/.test(s)) return 'HIATUS';
    if (/cancel|abandon/.test(s)) return 'ABANDONED';
    if (/end|complet|finish/.test(s)) return 'ENDED';
    return 'ONGOING';
}

const SIZE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];

/** "1.5 KiB" — the chapter row shows it as "title (size)". */
export function formatSize(bytes: number): string {
    const b = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
    if (b < 1024) return `${b} B`;
    let value = b;
    let unit = 0;
    while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value.toFixed(1)} ${SIZE_UNITS[unit]}`;
}

/** The JSON-array-string column convention (Issue.writers et al.), tolerant of anything else. */
export function parseJsonList(raw: string | null | undefined): string[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed
            .filter((v): v is string => typeof v === 'string')
            .map(v => v.trim())
            .filter(v => v.length > 0);
    } catch {
        return [];
    }
}

/**
 * A number string the source's `parseFloat(book.metadata.number)` can read: vulgar fractions
 * become decimals (#200/#205 parity), leading zeros go, and anything unparsable is "0" — NaN would
 * become the chapter number in the app.
 */
export function bookNumber(raw: string | null | undefined): string {
    const normalized = normalizeFractionNumbers(String(raw ?? '').trim()).replace(/^0+(?=\d)/, '');
    return Number.isFinite(parseFloat(normalized)) ? normalized : '0';
}

/** Komga's titleSort drops a leading article. */
export function titleSortKey(title: string): string {
    return title.replace(/^(the|an|a)\s+/i, '');
}

// ---------------------------------------------------------------------------------------------
// Books: title + order
// ---------------------------------------------------------------------------------------------

/**
 * The book's title. A main-run issue keeps its story title (Komga's ComicInfo Title) and falls
 * back to "Series #N"; an annual says so; an attached row carries its volume's name (#203 lane
 * label — seven volumes' "Annual #1" must stay tellable apart in a flat chapter list).
 */
export function bookTitle(issue: Pick<KomgaIssueRow, 'name' | 'number' | 'isAnnual' | 'attachmentName'>, seriesName: string): string {
    const name = (issue.name ?? '').trim();
    const num = String(issue.number ?? '').trim();
    const lane = (issue.attachmentName ?? '').trim();
    if (lane) {
        const base = `${laneLabel({ isAnnual: issue.isAnnual, attachmentName: lane })} #${num}`;
        return name ? `${base}: ${name}` : base;
    }
    if (issue.isAnnual) {
        const base = `${seriesName} Annual #${num}`;
        return name ? `${base}: ${name}` : base;
    }
    return name || `${seriesName} #${num}`;
}

export interface OrderedBook<T> {
    issue: T;
    /** 1-based place in the series' reading order — Komga's numberSort. */
    position: number;
}

/** The series page's default order: the run by number (fractions in place), then the annuals. */
export function orderBooks<T extends Pick<KomgaIssueRow, 'number' | 'isAnnual' | 'releaseDate'>>(issues: readonly T[]): OrderedBook<T>[] {
    const keyed = issues.map(issue => ({
        issue,
        parsedNum: parseFloat(bookNumber(issue.number)),
        isAnnual: issue.isAnnual,
        releaseDate: issue.releaseDate,
    }));
    return sortIssuesForDisplay(keyed, 'number_asc').map((k, idx) => ({ issue: k.issue, position: idx + 1 }));
}

// ---------------------------------------------------------------------------------------------
// Authors
// ---------------------------------------------------------------------------------------------

/** Writer + penciller credits from the JSON credit columns — the two roles the source displays. */
export function seriesAuthors(row: { writers?: string | null; artists?: string | null }): KomgaAuthor[] {
    return authorsFromRows([row]);
}

export function authorsFromRows(rows: ReadonlyArray<{ writers?: string | null; artists?: string | null }>): KomgaAuthor[] {
    const out: KomgaAuthor[] = [];
    const seen = new Set<string>();
    const push = (name: string, role: KomgaAuthor['role']) => {
        const key = `${role}:${name.toLowerCase()}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ name, role });
    };
    for (const row of rows) for (const w of parseJsonList(row.writers)) push(w, 'writer');
    for (const row of rows) for (const a of parseJsonList(row.artists)) push(a, 'penciller');
    return out;
}

// ---------------------------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------------------------

export function toLibraryDto(lib: { id: string; name: string; path: string }) {
    return {
        id: lib.id,
        name: lib.name,
        root: lib.path,
        importComicInfoBook: true,
        importComicInfoSeries: true,
        importComicInfoCollection: false,
        importComicInfoReadList: false,
        importComicInfoSeriesAppendVolume: false,
        importEpubBook: false,
        importEpubSeries: false,
        importMylarSeries: true,
        importLocalArtwork: true,
        importBarcodeIsbn: false,
        scanForceModifiedTime: false,
        scanInterval: 'DISABLED' as const,
        scanOnStartup: false,
        scanCbx: true,
        scanPdf: false,
        scanEpub: false,
        scanDirectoryExclusions: [] as string[],
        repairExtensions: false,
        convertToCbz: false,
        emptyTrashAfterScan: false,
        seriesCover: 'FIRST' as const,
        hashFiles: false,
        hashPages: false,
        analyzeDimensions: false,
        oneshotsDirectory: undefined as string | undefined,
        unavailable: false,
    };
}

export function toCollectionDto(c: { id: string; name: string; createdAt: Date; updatedAt: Date }) {
    return {
        id: c.id,
        name: c.name,
        ordered: false,
        seriesIds: [] as string[],
        createdDate: c.createdAt.toISOString(),
        lastModifiedDate: c.updatedAt.toISOString(),
        filtered: false,
    };
}

export function toSeriesDto(series: KomgaSeriesRow, counts: SeriesCounts, authors: KomgaAuthor[] = seriesAuthors(series)) {
    const created = series.createdAt.toISOString();
    // When the series last gained a file (#206 follow-up) — the same key /series/updated orders by,
    // which Paperback's update check relies on (it stops at the first lastModified older than its
    // last run). Series.updatedAt moves on every Series Monitor pass and meant nothing to a reader.
    const lastModified = (counts.lastFileAddedAt ?? series.createdAt).toISOString();
    // The year is the only disambiguator Paperback will show for same-named volumes.
    const title = series.year ? `${series.name} (${series.year})` : series.name;
    const booksUnreadCount = Math.max(0, counts.booksCount - counts.booksReadCount - counts.booksInProgressCount);
    return {
        id: series.id,
        libraryId: series.libraryId ?? '',
        name: title,
        url: series.folderPath,
        created,
        lastModified,
        fileLastModified: lastModified,
        booksCount: counts.booksCount,
        booksReadCount: counts.booksReadCount,
        booksUnreadCount,
        booksInProgressCount: counts.booksInProgressCount,
        metadata: {
            status: mapSeriesStatus(series.status),
            statusLock: false,
            title,
            titleLock: false,
            titleSort: titleSortKey(title),
            titleSortLock: false,
            summary: series.description ?? '',
            summaryLock: false,
            readingDirection: series.isManga ? 'RIGHT_TO_LEFT' : 'LEFT_TO_RIGHT',
            readingDirectionLock: false,
            publisher: series.publisher ?? '',
            publisherLock: false,
            ageRating: null as number | null,
            ageRatingLock: false,
            // parseLangCode() in the source calls .toUpperCase() on this — never null.
            language: (series.languageISO ?? '').trim() || 'en',
            languageLock: false,
            genres: parseJsonList(series.genres),
            genresLock: false,
            tags: parseJsonList(series.tags),
            tagsLock: false,
            totalBookCount: null as number | null,
            totalBookCountLock: false,
            sharingLabels: [] as string[],
            sharingLabelsLock: false,
            links: [] as { label: string; url: string }[],
            linksLock: false,
            alternateTitles: [] as { label: string; title: string }[],
            alternateTitlesLock: false,
            created,
            lastModified,
        },
        booksMetadata: {
            authors,
            authorsLock: false,
            tags: [] as string[],
            tagsLock: false,
            releaseDate: null as string | null,
            releaseDateLock: false,
            summary: '',
            summaryLock: false,
            summaryNumber: '',
            summaryNumberLock: false,
            created,
            lastModified,
        },
        deleted: false,
        oneshot: false,
    };
}

function archiveMediaType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
        case '.cbz': case '.zip': return 'application/zip';
        case '.cbr': case '.rar': return 'application/x-rar-compressed';
        case '.cb7': case '.7z': return 'application/x-7z-compressed';
        case '.epub': return 'application/epub+zip';
        case '.pdf': return 'application/pdf';
        default: return 'application/octet-stream';
    }
}

export interface BookExtras {
    position: number;
    sizeBytes: number;
    /** The file's mtime (falls back to the row's updatedAt when the file can't be stat-ed). */
    mtime: Date;
    progress: ProgressRow | null;
}

export function toBookDto(issue: KomgaIssueRow, series: { id: string; name: string; libraryId?: string | null }, extras: BookExtras) {
    const filePath = issue.filePath ?? '';
    const created = issue.createdAt.toISOString();
    const lastModified = issue.updatedAt.toISOString();
    const readAt = extras.progress?.updatedAt.toISOString();
    return {
        id: issue.id,
        seriesId: series.id,
        seriesTitle: series.name,
        libraryId: series.libraryId ?? '',
        name: filePath ? path.basename(filePath, path.extname(filePath)) : bookTitle(issue, series.name),
        url: filePath,
        number: extras.position,
        created,
        lastModified,
        fileLastModified: extras.mtime.toISOString(),
        sizeBytes: extras.sizeBytes,
        size: formatSize(extras.sizeBytes),
        media: {
            status: 'READY',
            mediaType: archiveMediaType(filePath),
            pagesCount: issue.pageCount ?? 0,
            comment: '',
            epubDivinaCompatible: false,
        },
        metadata: {
            title: bookTitle(issue, series.name),
            titleLock: false,
            summary: issue.description ?? '',
            summaryLock: false,
            number: bookNumber(issue.number),
            numberLock: false,
            numberSort: extras.position,
            numberSortLock: false,
            releaseDate: issue.releaseDate ?? null,
            releaseDateLock: false,
            authors: seriesAuthors(issue),
            authorsLock: false,
            tags: [] as string[],
            tagsLock: false,
            isbn: '',
            isbnLock: false,
            links: [] as { label: string; url: string }[],
            linksLock: false,
            created,
            lastModified,
        },
        readProgress: extras.progress && readAt
            ? {
                page: extras.progress.currentPage,
                completed: extras.progress.isCompleted,
                readDate: readAt,
                created: readAt,
                lastModified: readAt,
                deviceId: '',
                deviceName: '',
            }
            : null,
        deleted: false,
        fileHash: '',
        oneshot: false,
    };
}

/** 1-based page list. The source only checks mediaType against its supported set; JPEG is in it. */
export function toPageDtos(pageCount: number) {
    const n = Number.isFinite(pageCount) && pageCount > 0 ? Math.floor(pageCount) : 0;
    return Array.from({ length: n }, (_, i) => ({
        number: i + 1,
        fileName: `${i + 1}.jpg`,
        mediaType: 'image/jpeg',
        size: '',
    }));
}
