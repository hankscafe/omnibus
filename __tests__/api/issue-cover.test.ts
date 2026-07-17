// Discussion #182 (local-first ingest): /api/library/cover?issueId=<id> renders the archive's
// first page via the engine so scanned issues get real covers with ZERO provider API calls.
// The branch must fall back to the series folder cover (existing directory logic) or the
// placeholder SVG on any failure — never a 4xx/5xx that breaks a grid <img>.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from '@/app/api/library/cover/route';
import { resetLibraryRootsCache } from '@/lib/library-roots';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    issueFindUnique: vi.fn(),
    libraryFindMany: vi.fn(),
    fsExistsSync: vi.fn().mockReturnValue(true),
    fsStatSync: vi.fn().mockReturnValue({ mtimeMs: 1 }),
    fsMkdirSync: vi.fn(),
    fsReaddirSync: vi.fn().mockReturnValue([]),
    fsUnlinkSync: vi.fn(),
    fsPromisesStat: vi.fn(),
    fsPromisesReadFile: vi.fn(),
    fsPromisesUtimes: vi.fn().mockResolvedValue(true),
    fsPromisesWriteFile: vi.fn().mockResolvedValue(true),
    fsPromisesRename: vi.fn().mockResolvedValue(true),
    fsPromisesUnlink: vi.fn().mockResolvedValue(true),
    fetch: vi.fn(),
    log: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        issue: { findUnique: mocks.issueFindUnique },
        library: { findMany: mocks.libraryFindMany },
    }
}));

vi.mock('fs', () => {
    const fsPromises = {
        stat: mocks.fsPromisesStat,
        readFile: mocks.fsPromisesReadFile,
        utimes: mocks.fsPromisesUtimes,
        writeFile: mocks.fsPromisesWriteFile,
        rename: mocks.fsPromisesRename,
        unlink: mocks.fsPromisesUnlink,
    };
    return {
        existsSync: mocks.fsExistsSync,
        statSync: mocks.fsStatSync,
        mkdirSync: mocks.fsMkdirSync,
        readdirSync: mocks.fsReaddirSync,
        unlinkSync: mocks.fsUnlinkSync,
        promises: fsPromises,
        default: {
            existsSync: mocks.fsExistsSync,
            statSync: mocks.fsStatSync,
            mkdirSync: mocks.fsMkdirSync,
            readdirSync: mocks.fsReaddirSync,
            unlinkSync: mocks.fsUnlinkSync,
            promises: fsPromises,
        }
    };
});

vi.mock('@/lib/engine', () => ({
    ENGINE_URL: 'http://engine:8080',
    engineHeaders: (h?: Record<string, string>) => ({ ...(h || {}) }),
}));
vi.mock('@/lib/logger', () => ({ Logger: { log: mocks.log } }));

const req = (qs: string) => new NextRequest(`http://localhost/api/library/cover?${qs}`);
const ARCHIVE = '/data/comics/Saga (2012)/Saga 001.cbz';
const FOLDER = '/data/comics/Saga (2012)';

describe('API Route: issue first-page covers (?issueId=)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('fetch', mocks.fetch);
        resetLibraryRootsCache(); // roots are cached module-wide (issue #183); isolate each case
        mocks.libraryFindMany.mockResolvedValue([{ path: '/data/comics' }]);
        mocks.issueFindUnique.mockResolvedValue({ filePath: ARCHIVE, series: { folderPath: FOLDER } });
        // Archive stat succeeds; every readFile misses (no disk cache, no folder cover) by default.
        mocks.fsPromisesStat.mockResolvedValue({ mtimeMs: 777, isDirectory: () => true });
        mocks.fsPromisesReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    });

    it('renders page 0 via the engine and serves WebP', async () => {
        mocks.fetch.mockResolvedValue({
            ok: true,
            arrayBuffer: async () => Buffer.from('webp_bytes').buffer,
        });

        const res = await GET(req('issueId=issue_1'));

        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('image/webp');
        expect(mocks.fetch).toHaveBeenCalledWith(
            'http://engine:8080/api/reader/page',
            expect.objectContaining({ method: 'POST', body: expect.stringContaining('"index":0') })
        );
        const body = JSON.parse(mocks.fetch.mock.calls[0][1].body);
        expect(body.path).toBe(ARCHIVE);
    });

    it('serves the disk cache without touching the engine on a warm hit', async () => {
        mocks.fsPromisesReadFile.mockImplementation(async (p: string) => {
            if (String(p).includes('issue_covers')) return Buffer.from('cached_webp');
            throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        });

        const res = await GET(req('issueId=issue_1'));

        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('image/webp');
        expect(mocks.fetch).not.toHaveBeenCalled();
    });

    it('falls back to the series folder cover when the engine is down', async () => {
        mocks.fetch.mockRejectedValue(new Error('ECONNREFUSED'));
        // The directory branch finds <folder>/cover.jpg.
        mocks.fsPromisesReadFile.mockImplementation(async (p: string) => {
            if (String(p).toLowerCase().includes('cover.jpg')) return Buffer.from('folder_cover');
            throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        });

        const res = await GET(req('issueId=issue_1'));

        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    });

    it('gives up on a slow engine render and falls back to the folder cover (issue #183)', async () => {
        // The route arms a 5s abort watchdog so scan-pinned engines can't freeze the grid;
        // simulate the watchdog firing as the AbortError the fetch would surface.
        mocks.fetch.mockRejectedValue(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
        mocks.fsPromisesReadFile.mockImplementation(async (p: string) => {
            if (String(p).toLowerCase().includes('cover.jpg')) return Buffer.from('folder_cover');
            throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        });

        const res = await GET(req('issueId=issue_1'));

        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('image/jpeg');
        // The render request actually carried the abort signal.
        expect(mocks.fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    });

    it('returns the placeholder for an unknown issue (never a 4xx that breaks <img>)', async () => {
        mocks.issueFindUnique.mockResolvedValue(null);

        const res = await GET(req('issueId=nope'));

        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('image/svg+xml');
        expect(mocks.fetch).not.toHaveBeenCalled();
    });

    it('refuses to render an archive outside every library root (defense in depth)', async () => {
        mocks.issueFindUnique.mockResolvedValue({ filePath: '/srv/secrets/dump.cbz', series: { folderPath: null } });

        const res = await GET(req('issueId=issue_1'));

        // No engine call for the out-of-root path, and no folder to fall back to → placeholder.
        expect(mocks.fetch).not.toHaveBeenCalled();
        expect(res.headers.get('Content-Type')).toBe('image/svg+xml');
    });

    it('skips straight to the series folder cover when the issue has no file', async () => {
        mocks.issueFindUnique.mockResolvedValue({ filePath: null, series: { folderPath: FOLDER } });
        mocks.fsPromisesReadFile.mockImplementation(async (p: string) => {
            if (String(p).toLowerCase().includes('cover.jpg')) return Buffer.from('folder_cover');
            throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        });

        const res = await GET(req('issueId=issue_1'));

        expect(mocks.fetch).not.toHaveBeenCalled();
        expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    });
});
