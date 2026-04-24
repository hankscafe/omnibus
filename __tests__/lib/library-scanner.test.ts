import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LibraryScanner } from '@/lib/library-scanner';

const mocks = vi.hoisted(() => ({
    findUniqueLock: vi.fn(),
    upsertLock: vi.fn(),
    deleteLock: vi.fn().mockResolvedValue(true), // FIX: Add mockResolvedValue so .catch() works!
    findManyLibraries: vi.fn(),
    findManySeries: vi.fn(),
    createSeries: vi.fn(),
    parseComicInfo: vi.fn(),
    log: vi.fn()
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        jobLock: { findUnique: mocks.findUniqueLock, upsert: mocks.upsertLock, delete: mocks.deleteLock },
        library: { findMany: mocks.findManyLibraries },
        series: { findMany: mocks.findManySeries, create: mocks.createSeries, deleteMany: vi.fn() },
        issue: { deleteMany: vi.fn() }
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
        mocks.findUniqueLock.mockResolvedValue(null);
        mocks.findManyLibraries.mockResolvedValue([{ id: 'lib_1', path: '/library/comics', isManga: false }]);
        mocks.findManySeries.mockResolvedValue([]);
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
});