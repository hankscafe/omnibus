// __tests__/lib/komga-dto.test.ts
//
// #206 (Paperback): the Komga-compatible facade answers Paperback's built-in "Paperback" source,
// whose code (Paperback-iOS/extensions-default, src/Paperback/*.ts) reads a fixed handful of
// Komga DTO fields and calls .map / .toLowerCase / .toUpperCase / parseFloat on them. These tests
// pin the mapper contract: every field that source touches is present, typed, and never null.
import { describe, it, expect } from 'vitest';
import {
    komgaPage,
    mapSeriesStatus,
    formatSize,
    parseJsonList,
    bookNumber,
    bookTitle,
    titleSortKey,
    orderBooks,
    seriesAuthors,
    toLibraryDto,
    toSeriesDto,
    toBookDto,
    toPageDtos,
    toCollectionDto,
} from '@/lib/komga/dto';

const D = new Date('2026-09-01T12:00:00.000Z');

const baseSeries = (over: Record<string, unknown> = {}) => ({
    id: 'ser_1',
    name: 'Batman',
    year: 2016,
    publisher: 'DC Comics',
    folderPath: '/comics/DC Comics/Batman (2016)',
    libraryId: 'lib_1',
    isManga: false,
    description: 'Gotham after Rebirth.',
    status: 'Continuing',
    genres: '["Superhero","Crime"]',
    tags: null,
    writers: '["Tom King"]',
    artists: '["David Finch","Mikel Janín"]',
    languageISO: null,
    createdAt: D,
    updatedAt: D,
    ...over,
});

const baseIssue = (over: Record<string, unknown> = {}) => ({
    id: 'iss_1',
    seriesId: 'ser_1',
    number: '1',
    isAnnual: false,
    attachedVolumeId: null,
    attachmentName: null,
    name: 'I Am Gotham, Part One',
    description: 'Two new heroes.',
    releaseDate: '2016-06-15',
    filePath: '/comics/DC Comics/Batman (2016)/Batman 001 (2016).cbz',
    pageCount: 24,
    writers: '["Tom King"]',
    artists: '["David Finch"]',
    createdAt: D,
    updatedAt: D,
    ...over,
});

describe('komga dto: page envelope', () => {
    it('wraps content in the Spring Page shape the extension reads .content from', () => {
        const page = komgaPage(['a', 'b'], 1, 2, 5);
        expect(page.content).toEqual(['a', 'b']);
        expect(page.number).toBe(1);
        expect(page.size).toBe(2);
        expect(page.totalElements).toBe(5);
        expect(page.totalPages).toBe(3);
        expect(page.numberOfElements).toBe(2);
        expect(page.first).toBe(false);
        expect(page.last).toBe(false);
        expect(page.empty).toBe(false);
    });

    it('flags an empty single page as first, last and empty', () => {
        const page = komgaPage([], 0, 20, 0);
        expect(page.totalPages).toBe(0);
        expect(page.first).toBe(true);
        expect(page.last).toBe(true);
        expect(page.empty).toBe(true);
    });
});

describe('komga dto: scalar helpers', () => {
    it('maps Omnibus series status words onto Komga\'s four states (never null: the source lowercases it)', () => {
        expect(mapSeriesStatus('Ended')).toBe('ENDED');
        expect(mapSeriesStatus('Completed')).toBe('ENDED');
        expect(mapSeriesStatus('Continuing')).toBe('ONGOING');
        expect(mapSeriesStatus('Cancelled')).toBe('ABANDONED');
        expect(mapSeriesStatus('On Hiatus')).toBe('HIATUS');
        expect(mapSeriesStatus(null)).toBe('ONGOING');
        expect(mapSeriesStatus('')).toBe('ONGOING');
    });

    it('formats byte counts the way the chapter row shows them ("title (size)")', () => {
        expect(formatSize(0)).toBe('0 B');
        expect(formatSize(1536)).toBe('1.5 KiB');
        expect(formatSize(Math.round(12.3 * 1024 * 1024))).toBe('12.3 MiB');
        expect(formatSize(2 * 1024 * 1024 * 1024)).toBe('2.0 GiB');
    });

    it('parses the JSON-array string convention tolerantly', () => {
        expect(parseJsonList('["Superhero","Crime"]')).toEqual(['Superhero', 'Crime']);
        expect(parseJsonList('["a","","  ", 3]')).toEqual(['a']);
        expect(parseJsonList('"not an array"')).toEqual([]);
        expect(parseJsonList('garbage')).toEqual([]);
        expect(parseJsonList(null)).toEqual([]);
        expect(parseJsonList(undefined)).toEqual([]);
    });

    it('gives the source a number parseFloat can read: fractions and leading zeros normalised, no NaN', () => {
        expect(bookNumber('13½')).toBe('13.5');
        expect(bookNumber('½')).toBe('0.5');
        expect(bookNumber('001')).toBe('1');
        expect(bookNumber(' 7 ')).toBe('7');
        expect(bookNumber('12a')).toBe('12a'); // parseFloat("12a") = 12
        expect(bookNumber('abc')).toBe('0');
        expect(bookNumber('')).toBe('0');
    });

    it('strips a leading article for titleSort like Komga does', () => {
        expect(titleSortKey('The Batman Who Laughs')).toBe('Batman Who Laughs');
        expect(titleSortKey('A Man Among Ye')).toBe('Man Among Ye');
        expect(titleSortKey('An Unkindness of Ravens')).toBe('Unkindness of Ravens');
        expect(titleSortKey('Batman')).toBe('Batman');
        expect(titleSortKey('Theory of Everything')).toBe('Theory of Everything');
    });
});

describe('komga dto: book titles and order', () => {
    it('uses the story title for a main-run issue and composes "Series #N" when there is none', () => {
        expect(bookTitle(baseIssue(), 'Batman')).toBe('I Am Gotham, Part One');
        expect(bookTitle(baseIssue({ name: null, number: '2' }), 'Batman')).toBe('Batman #2');
        expect(bookTitle(baseIssue({ name: '   ', number: '3' }), 'Batman')).toBe('Batman #3');
    });

    it('names an annual with its domain, and an attached row with its volume (#203 lane label)', () => {
        expect(bookTitle(baseIssue({ name: null, isAnnual: true, number: '1' }), 'Batman')).toBe('Batman Annual #1');
        expect(bookTitle(baseIssue({ name: 'Ghosts', isAnnual: true, number: '1' }), 'Batman')).toBe('Batman Annual #1: Ghosts');
        expect(bookTitle(
            baseIssue({ name: null, isAnnual: true, number: '1', attachedVolumeId: 'att_1', attachmentName: "The Amazing Spider-Man '96" }),
            'The Amazing Spider-Man',
        )).toBe("The Amazing Spider-Man '96 · Annual #1");
        expect(bookTitle(
            baseIssue({ name: 'Court of Owls', isAnnual: false, number: '1', attachedVolumeId: 'att_2', attachmentName: 'Batman: The Court of Owls' }),
            'Batman',
        )).toBe('Batman: The Court of Owls · Issue #1: Court of Owls');
    });

    it('orders the run by number (fractions in place) and shelves annuals after it, 1-based positions', () => {
        const ordered = orderBooks([
            baseIssue({ id: 'a1', number: '1', isAnnual: true }),
            baseIssue({ id: 'i14', number: '14' }),
            baseIssue({ id: 'i13h', number: '13½' }),
            baseIssue({ id: 'i13', number: '13' }),
            baseIssue({ id: 'i2', number: '002' }),
        ]);
        expect(ordered.map(b => b.issue.id)).toEqual(['i2', 'i13', 'i13h', 'i14', 'a1']);
        expect(ordered.map(b => b.position)).toEqual([1, 2, 3, 4, 5]);
    });
});

describe('komga dto: series', () => {
    it('collects writer/penciller authors from the JSON credit columns, de-duplicated', () => {
        expect(seriesAuthors({ writers: '["Tom King","Tom King"]', artists: '["David Finch"]' })).toEqual([
            { name: 'Tom King', role: 'writer' },
            { name: 'David Finch', role: 'penciller' },
        ]);
        expect(seriesAuthors({ writers: null, artists: null })).toEqual([]);
    });

    // Paperback's update check walks /series/updated and stops at the first lastModified older than
    // its last run, so lastModified must be the same arrival time the list is ordered by — the
    // series' newest Issue.fileAddedAt (#206 follow-up), never Series.updatedAt.
    it('dates a series by its newest file arrival, falling back to its creation, never its updatedAt', () => {
        const arrived = new Date('2026-09-20T09:00:00.000Z');
        const touched = new Date('2026-09-24T12:00:00.000Z'); // a monitor run bumped the row
        const s = { ...baseSeries(), updatedAt: touched };

        const dto = toSeriesDto(s, { booksCount: 2, booksReadCount: 0, booksInProgressCount: 0, lastFileAddedAt: arrived });
        expect(dto.lastModified).toBe(arrived.toISOString());
        expect(dto.fileLastModified).toBe(arrived.toISOString());
        expect(dto.metadata.lastModified).toBe(arrived.toISOString());
        expect(dto.booksMetadata.lastModified).toBe(arrived.toISOString());

        const unstamped = toSeriesDto(s, { booksCount: 2, booksReadCount: 0, booksInProgressCount: 0 });
        expect(unstamped.metadata.lastModified).toBe(D.toISOString()); // createdAt, not the monitor's touch
    });

    it('builds a SeriesDto with every field the source reads, typed so its .map/.toLowerCase calls hold', () => {
        const dto = toSeriesDto(baseSeries(), { booksCount: 10, booksReadCount: 3, booksInProgressCount: 1 }, seriesAuthors(baseSeries()));

        expect(dto.id).toBe('ser_1');
        expect(dto.libraryId).toBe('lib_1');
        expect(dto.name).toBe('Batman (2016)');
        expect(dto.url).toBe('/comics/DC Comics/Batman (2016)');
        expect(dto.booksCount).toBe(10);
        expect(dto.booksReadCount).toBe(3);
        expect(dto.booksInProgressCount).toBe(1);
        expect(dto.booksUnreadCount).toBe(6);
        expect(dto.lastModified).toBe(D.toISOString());
        expect(dto.created).toBe(D.toISOString());
        expect(dto.deleted).toBe(false);
        expect(dto.oneshot).toBe(false);

        // The year is the only disambiguator Paperback will show for same-named volumes.
        expect(dto.metadata.title).toBe('Batman (2016)');
        expect(dto.metadata.titleSort).toBe('Batman (2016)');
        expect(dto.metadata.status).toBe('ONGOING');
        expect(dto.metadata.summary).toBe('Gotham after Rebirth.');
        expect(dto.metadata.publisher).toBe('DC Comics');
        expect(dto.metadata.readingDirection).toBe('LEFT_TO_RIGHT');
        expect(dto.metadata.language).toBe('en'); // parseLangCode calls .toUpperCase() — never null
        expect(dto.metadata.genres).toEqual(['Superhero', 'Crime']);
        expect(dto.metadata.tags).toEqual([]);
        expect(dto.metadata.lastModified).toBe(D.toISOString());
        expect(dto.metadata.statusLock).toBe(false);
        expect(dto.metadata.sharingLabels).toEqual([]);
        expect(dto.metadata.links).toEqual([]);
        expect(dto.metadata.alternateTitles).toEqual([]);

        expect(dto.booksMetadata.authors).toEqual([
            { name: 'Tom King', role: 'writer' },
            { name: 'David Finch', role: 'penciller' },
            { name: 'Mikel Janín', role: 'penciller' },
        ]);
        expect(dto.booksMetadata.summary).toBe('');
        expect(dto.booksMetadata.tags).toEqual([]);
    });

    it('reads right-to-left for manga, honours languageISO, and tolerates nulls', () => {
        const dto = toSeriesDto(
            baseSeries({ isManga: true, languageISO: 'ja', description: null, publisher: null, genres: null, libraryId: null, year: 0, status: 'Ended', tags: '["Shonen"]' }),
            { booksCount: 0, booksReadCount: 0, booksInProgressCount: 0 },
            [],
        );
        expect(dto.metadata.readingDirection).toBe('RIGHT_TO_LEFT');
        expect(dto.metadata.language).toBe('ja');
        expect(dto.metadata.summary).toBe('');
        expect(dto.metadata.publisher).toBe('');
        expect(dto.metadata.genres).toEqual([]);
        expect(dto.metadata.tags).toEqual(['Shonen']);
        expect(dto.metadata.status).toBe('ENDED');
        expect(dto.metadata.title).toBe('Batman'); // no year → bare name
        expect(dto.libraryId).toBe('');
        expect(dto.booksUnreadCount).toBe(0);
    });
});

describe('komga dto: books, pages, libraries, collections', () => {
    const series = { id: 'ser_1', name: 'Batman', libraryId: 'lib_1' };
    const mtime = new Date('2026-08-20T08:00:00.000Z');

    it('builds a BookDto: normalised number, position as numberSort, size string, archive media type', () => {
        const dto = toBookDto(baseIssue({ number: '13½' }), series, { position: 14, sizeBytes: 1536, mtime, progress: null });

        expect(dto.id).toBe('iss_1');
        expect(dto.seriesId).toBe('ser_1');
        expect(dto.seriesTitle).toBe('Batman');
        expect(dto.libraryId).toBe('lib_1');
        expect(dto.name).toBe('Batman 001 (2016)');
        expect(dto.url).toBe('/comics/DC Comics/Batman (2016)/Batman 001 (2016).cbz');
        expect(dto.number).toBe(14);
        expect(dto.sizeBytes).toBe(1536);
        expect(dto.size).toBe('1.5 KiB');
        expect(dto.fileLastModified).toBe(mtime.toISOString());
        expect(dto.media.status).toBe('READY');
        expect(dto.media.mediaType).toBe('application/zip');
        expect(dto.media.pagesCount).toBe(24);
        expect(dto.metadata.number).toBe('13.5');
        expect(dto.metadata.numberSort).toBe(14);
        expect(dto.metadata.title).toBe('I Am Gotham, Part One');
        expect(dto.metadata.summary).toBe('Two new heroes.');
        expect(dto.metadata.releaseDate).toBe('2016-06-15');
        expect(dto.metadata.authors).toEqual([
            { name: 'Tom King', role: 'writer' },
            { name: 'David Finch', role: 'penciller' },
        ]);
        expect(dto.readProgress).toBeNull();
        expect(dto.deleted).toBe(false);
        expect(dto.oneshot).toBe(false);
    });

    it('maps RAR/7z media types and attaches read progress when the user has some', () => {
        const rar = toBookDto(baseIssue({ filePath: '/c/Batman 002.cbr' }), series, { position: 2, sizeBytes: 0, mtime, progress: null });
        expect(rar.media.mediaType).toBe('application/x-rar-compressed');
        const sevenZip = toBookDto(baseIssue({ filePath: '/c/Batman 003.cb7' }), series, { position: 3, sizeBytes: 0, mtime, progress: null });
        expect(sevenZip.media.mediaType).toBe('application/x-7z-compressed');

        const read = toBookDto(baseIssue(), series, {
            position: 1, sizeBytes: 10, mtime,
            progress: { currentPage: 24, isCompleted: true, updatedAt: mtime },
        });
        expect(read.readProgress).toEqual(expect.objectContaining({ page: 24, completed: true, readDate: mtime.toISOString() }));
    });

    it('lists pages 1-based as JPEGs (the source only checks mediaType against its supported list)', () => {
        const pages = toPageDtos(3);
        expect(pages.map(p => p.number)).toEqual([1, 2, 3]);
        expect(pages.every(p => p.mediaType === 'image/jpeg')).toBe(true);
        expect(pages.every(p => typeof p.fileName === 'string' && typeof p.size === 'string')).toBe(true);
        expect(toPageDtos(0)).toEqual([]);
    });

    it('builds a LibraryDto with id/name/root and the boolean scaffolding Komga clients expect', () => {
        const dto = toLibraryDto({ id: 'lib_1', name: 'Comics', path: '/comics' });
        expect(dto).toEqual(expect.objectContaining({ id: 'lib_1', name: 'Comics', root: '/comics', unavailable: false }));
        expect(typeof dto.scanInterval).toBe('string');
    });

    it('builds a CollectionDto from an Omnibus collection', () => {
        const dto = toCollectionDto({ id: 'col_1', name: 'Bat-family', createdAt: D, updatedAt: D });
        expect(dto).toEqual(expect.objectContaining({ id: 'col_1', name: 'Bat-family', ordered: false, seriesIds: [], filtered: false }));
    });
});
