import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LibraryScanner } from '@/lib/library-scanner';
import fs from 'fs-extra';

const mocks = vi.hoisted(() => ({
    findUniqueLock: vi.fn(),
    upsertLock: vi.fn(),
    deleteLock: vi.fn().mockResolvedValue(true), // FIX: Add mockResolvedValue so .catch() works!
    findManyLibraries: vi.fn(),
    findManySeries: vi.fn(),
    findManyIssues: vi.fn(), // <-- NEW: Added mock for ghost issue scanner
    requestFindMany: vi.fn(), // <-- ADDED: Mock for active requests check
    createSeries: vi.fn(),
    seriesDeleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    issueDeleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    systemSettingFindUnique: vi.fn().mockResolvedValue(null),
    systemSettingUpsert: vi.fn().mockResolvedValue({}),
    parseComicInfo: vi.fn(),
    log: vi.fn()
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        jobLock: { findUnique: mocks.findUniqueLock, upsert: mocks.upsertLock, delete: mocks.deleteLock },
        library: { findMany: mocks.findManyLibraries },
        series: { findMany: mocks.findManySeries, create: mocks.createSeries, deleteMany: mocks.seriesDeleteMany },
        issue: {
            findMany: mocks.findManyIssues, // <-- NEW: Link to hoisted mock
            deleteMany: mocks.issueDeleteMany,
            update: vi.fn().mockResolvedValue({}), // <-- NEW: Prevent crashes during ghost sweep
            delete: vi.fn().mockResolvedValue({})  // <-- NEW: Prevent crashes during ghost sweep
        },
        request: { findMany: mocks.requestFindMany }, // <-- ADDED: Link to hoisted mock
        systemSetting: { findUnique: mocks.systemSettingFindUnique, upsert: mocks.systemSettingUpsert },
        readProgress: {
            deleteMany: vi.fn().mockResolvedValue({ count: 0 }) // <-- NEW: Prevent crashes during ghost sweep
        }
    }
}));

vi.mock('fs-extra', () => ({
    default: {
        existsSync: vi.fn().mockReturnValue(true),
        promises: {
            // FIX: Prevent infinite recursion by returning files inside the sub-directory!
            readdir: vi.fn().mockImplementation((dir) => {
                if (typeof dir === 'string' && dir.includes('Batman')) {
                    return Promise.resolve([
                        { name: 'issue1.cbz', isDirectory: () => false, isFile: () => true }
                    ]);
                }
                return Promise.resolve([
                    { name: 'Batman (2016)', isDirectory: () => true, isFile: () => false }
                ]);
            })
        }
    }
}));

vi.mock('@/lib/metadata-extractor', () => ({ parseComicInfo: mocks.parseComicInfo }));
vi.mock('@/lib/manga-detector', () => ({ detectManga: vi.fn().mockResolvedValue(false) }));
vi.mock('@/lib/logger', () => ({ Logger: { log: mocks.log } }));

describe('File System: Library Scanner', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(fs.existsSync).mockReturnValue(true); // reset per test (grace tests override per-path)
        mocks.findUniqueLock.mockResolvedValue(null);
        mocks.findManyLibraries.mockResolvedValue([{ id: 'lib_1', path: '/library/comics', isManga: false }]);
        mocks.findManySeries.mockResolvedValue([]);
        mocks.findManyIssues.mockResolvedValue([]); // <-- NEW: Return empty array by default to pass tests
        mocks.requestFindMany.mockResolvedValue([]); // <-- ADDED: Return empty array to pass active request test
        mocks.systemSettingFindUnique.mockResolvedValue(null);
        mocks.systemSettingUpsert.mockResolvedValue({});
        mocks.seriesDeleteMany.mockResolvedValue({ count: 0 });
        mocks.issueDeleteMany.mockResolvedValue({ count: 0 });
    });

    it('should abort if another scan is currently running (Job Lock)', async () => {
        mocks.findUniqueLock.mockResolvedValueOnce({ lockedAt: new Date(Date.now() - 60000) });
        
        const result = await LibraryScanner.scan();
        
        expect(result).toBeNull();
        expect(mocks.findManyLibraries).not.toHaveBeenCalled();
    });

    it('should crawl the directory, parse ComicInfo, and add unindexed series to the database', async () => {
        mocks.parseComicInfo.mockResolvedValueOnce({
            series: 'Batman',
            publisher: 'DC Comics',
            year: 2016,
            cvId: 12345
        });

        const result = await LibraryScanner.scan();
        
        expect(result).toBe(true);
        expect(mocks.createSeries).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                name: 'Batman',
                publisher: 'DC Comics',
                year: 2016,
                metadataId: '12345'
            })
        }));
    });

    it('does NOT purge a series on its first missing scan (24h grace window)', async () => {
        mocks.findManySeries.mockResolvedValue([
            { id: 's_ghost', folderPath: '/library/comics/Gone', monitored: false, metadataId: 'cv_gone' }
        ]);
        // Library root present; only the series' own subfolder is gone (e.g. a transient SMB hiccup).
        vi.mocked(fs.existsSync).mockImplementation((p: any) => !String(p).includes('Gone'));
        mocks.systemSettingFindUnique.mockResolvedValue(null); // never seen missing before

        await LibraryScanner.scan();

        expect(mocks.seriesDeleteMany).not.toHaveBeenCalled();
        // The miss is recorded so the grace window can elapse across future scans.
        expect(mocks.systemSettingUpsert).toHaveBeenCalledWith(expect.objectContaining({
            where: { key: 'scan_missing_series' },
            create: expect.objectContaining({ value: expect.stringContaining('s_ghost') })
        }));
    });

    it('purges a series whose folder has been missing past the 24h grace window', async () => {
        mocks.findManySeries.mockResolvedValue([
            { id: 's_ghost', folderPath: '/library/comics/Gone', monitored: false, metadataId: 'cv_gone' }
        ]);
        vi.mocked(fs.existsSync).mockImplementation((p: any) => !String(p).includes('Gone'));
        // First seen missing 25h ago → past the grace window.
        mocks.systemSettingFindUnique.mockResolvedValue({
            value: JSON.stringify({ s_ghost: Date.now() - 25 * 60 * 60 * 1000 })
        });

        await LibraryScanner.scan();

        expect(mocks.seriesDeleteMany).toHaveBeenCalledWith({ where: { id: { in: ['s_ghost'] } } });
    });
});