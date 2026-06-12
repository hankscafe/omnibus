// __tests__/lib/library-scanner.test.ts
// LibraryScanner.scan() is a thin forwarder: it POSTs each configured library to the
// Rust engine (/api/scan), which owns the crawl, ComicInfo parsing, JobLock, and ghost
// sweep (covered by the engine's own unit tests).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LibraryScanner } from '@/lib/library-scanner';
import { ENGINE_URL } from '@/lib/engine';

const mocks = vi.hoisted(() => ({
    findManyLibraries: vi.fn(),
    engineFetch: vi.fn(),
    log: vi.fn()
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        library: { findMany: mocks.findManyLibraries }
    }
}));

vi.mock('@/lib/logger', () => ({ Logger: { log: mocks.log } }));

describe('File System: Library Scanner (engine forwarder)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.NEXTAUTH_SECRET = 'test-secret';
        mocks.engineFetch.mockResolvedValue({ ok: true, status: 200 });
        vi.stubGlobal('fetch', mocks.engineFetch);
        mocks.findManyLibraries.mockResolvedValue([
            { id: 'lib_1', name: 'Comics', path: '/library/comics', isManga: false }
        ]);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('should forward one scan request per configured library to the Rust engine', async () => {
        mocks.findManyLibraries.mockResolvedValueOnce([
            { id: 'lib_1', name: 'Comics', path: '/library/comics', isManga: false },
            { id: 'lib_2', name: 'Manga', path: '/library/manga', isManga: true }
        ]);

        const result = await LibraryScanner.scan();

        expect(result).toBe(true);
        expect(mocks.engineFetch).toHaveBeenCalledTimes(2);
        expect(mocks.engineFetch).toHaveBeenCalledWith(
            `${ENGINE_URL}/api/scan`,
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    'Content-Type': 'application/json',
                    'X-Internal-Secret': 'test-secret'
                })
            })
        );

        const bodies = mocks.engineFetch.mock.calls.map((c: any[]) => JSON.parse(c[1].body));
        expect(bodies[0]).toEqual(expect.objectContaining({ library_id: 'lib_1', library_path: '/library/comics' }));
        expect(bodies[1]).toEqual(expect.objectContaining({ library_id: 'lib_2', library_path: '/library/manga' }));
    });

    it('should return false without contacting the engine when no libraries are configured', async () => {
        mocks.findManyLibraries.mockResolvedValueOnce([]);

        const result = await LibraryScanner.scan();

        expect(result).toBe(false);
        expect(mocks.engineFetch).not.toHaveBeenCalled();
    });

    it('should return false when the engine accepts none of the scan requests', async () => {
        mocks.engineFetch.mockRejectedValue(new Error('ECONNREFUSED'));

        const result = await LibraryScanner.scan();

        expect(result).toBe(false);
    });

    it('should return false when the engine rejects every library with an error status', async () => {
        mocks.engineFetch.mockResolvedValue({ ok: false, status: 401 });

        const result = await LibraryScanner.scan();

        expect(result).toBe(false);
    });

    it('should still return true when at least one library is accepted', async () => {
        mocks.findManyLibraries.mockResolvedValueOnce([
            { id: 'lib_1', name: 'Comics', path: '/library/comics', isManga: false },
            { id: 'lib_2', name: 'Manga', path: '/library/manga', isManga: true }
        ]);
        mocks.engineFetch
            .mockRejectedValueOnce(new Error('ECONNREFUSED'))
            .mockResolvedValueOnce({ ok: true, status: 200 });

        const result = await LibraryScanner.scan();

        expect(result).toBe(true);
        expect(mocks.engineFetch).toHaveBeenCalledTimes(2);
    });
});
