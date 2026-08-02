// v1.4.3-beta.001 (library cover-load speed): /api/library/cover gains ?w= WebP thumbnails with a
// disk cache plus ETag/If-None-Match revalidation. Stored covers are frequently the RAW first page
// of an archive (1-4MB) served into a ~200px grid cell, and the old max-age=86400-with-no-validator
// headers meant every browser re-downloaded the whole wall daily. These tests pin: the resize+cache
// pipeline, 304s answered from stat alone, whitelist enforcement, the untouched no-w byte paths
// (OPDS clients fetch without w and may not speak WebP), and the remote branch's upstream-skipping
// cache. Real image bytes flow through the mocked fs so sharp exercises the true decode path.
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import crypto from 'crypto';
import sharp from 'sharp';
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

const req = (qs: string, headers?: Record<string, string>) =>
    new NextRequest(`http://localhost/api/library/cover?${qs}`, headers ? { headers } : undefined);

const FOLDER = '/data/comics/Saga (2012)';
const FILE = '/data/comics/Saga (2012)/cover.jpg';
const MTIME = 1111;

// A realistic oversized "raw first page" source, generated once. Its byte length feeds the
// expected ETag, so everything derives from the same buffer.
let bigJpeg: Buffer;
const fileEtag = (w?: number) => `"c-${MTIME}-${bigJpeg.length}${w ? `-w${w}` : ''}"`;

const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
const fileStat = (over?: Partial<{ mtimeMs: number; size: number }>) => ({
    mtimeMs: MTIME, size: bigJpeg.length, isDirectory: () => false, isFile: () => true, ...over,
});
// The route normalizes ?path= (win32: backslashes) before hitting fs — compare separator-blind.
const norm = (p: unknown) => String(p).replace(/\\/g, '/');

beforeAll(async () => {
    bigJpeg = await sharp({
        create: { width: 1200, height: 1800, channels: 3, background: { r: 180, g: 40, b: 60 } }
    }).jpeg({ quality: 92 }).toBuffer();
});

beforeEach(() => {
    vi.stubGlobal('fetch', mocks.fetch);
    resetLibraryRootsCache(); // roots are cached module-wide (issue #183); isolate each case
    mocks.libraryFindMany.mockResolvedValue([{ path: '/data/comics' }]);
    // Default: the target is a plain file; every readFile misses the thumb cache but finds the source.
    mocks.fsPromisesStat.mockImplementation(async (p: string) => {
        if (norm(p) === FILE) return fileStat();
        throw enoent();
    });
    mocks.fsPromisesReadFile.mockImplementation(async (p: string) => {
        if (norm(p).includes('cover_thumbs')) throw enoent();
        if (norm(p) === FILE) return bigJpeg;
        throw enoent();
    });
});

describe('local ?w= thumbnails (task A)', () => {
    it('serves a 480px WebP far smaller than the source, caches it, and stamps a source-derived ETag', async () => {
        const res = await GET(req(`path=${encodeURIComponent(FILE)}&w=480`));

        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('image/webp');
        expect(res.headers.get('ETag')).toBe(fileEtag(480));
        expect(res.headers.get('Cache-Control')).toContain('max-age=604800');

        const body = Buffer.from(await res.arrayBuffer());
        expect(body.length).toBeLessThan(bigJpeg.length);
        const meta = await sharp(body).metadata();
        expect(meta.format).toBe('webp');
        expect(meta.width).toBe(480);

        // The thumbnail was written to the disk cache (atomic temp file under cover_thumbs).
        const writes = mocks.fsPromisesWriteFile.mock.calls.map(c => String(c[0]));
        expect(writes.some(p => p.includes('cover_thumbs'))).toBe(true);
    });

    it('serves a warm thumbnail from the disk cache without re-reading the source', async () => {
        const cachedWebp = await sharp(bigJpeg).resize({ width: 480 }).webp().toBuffer();
        mocks.fsPromisesReadFile.mockImplementation(async (p: string) => {
            if (String(p).includes('cover_thumbs')) return cachedWebp;
            throw enoent();
        });

        const res = await GET(req(`path=${encodeURIComponent(FILE)}&w=480`));

        expect(res.status).toBe(200);
        expect(Buffer.compare(Buffer.from(await res.arrayBuffer()), cachedWebp)).toBe(0);
        // Only the cache file was read — the multi-MB source stayed untouched.
        const reads = mocks.fsPromisesReadFile.mock.calls.map(c => String(c[0]));
        expect(reads.every(p => p.includes('cover_thumbs'))).toBe(true);
        // The read touched the cache file's mtime so the weekly reaper keeps hot thumbs alive.
        expect(mocks.fsPromisesUtimes).toHaveBeenCalled();
    });

    it('answers 304 from the stat alone when If-None-Match matches — no read, no resize (task B)', async () => {
        const res = await GET(req(`path=${encodeURIComponent(FILE)}&w=480`, { 'if-none-match': fileEtag(480) }));

        expect(res.status).toBe(304);
        expect(res.headers.get('ETag')).toBe(fileEtag(480));
        expect(res.headers.get('Cache-Control')).toContain('max-age=604800');
        expect(mocks.fsPromisesReadFile).not.toHaveBeenCalled();
    });

    it('rolls the ETag when the source file is rewritten (new mtime) so stale 304s stop', async () => {
        mocks.fsPromisesStat.mockImplementation(async (p: string) => {
            if (norm(p) === FILE) return fileStat({ mtimeMs: 2222 });
            throw enoent();
        });

        const res = await GET(req(`path=${encodeURIComponent(FILE)}&w=480`, { 'if-none-match': fileEtag(480) }));

        expect(res.status).toBe(200);
        expect(res.headers.get('ETag')).toBe(`"c-2222-${bigJpeg.length}-w480"`);
    });

    it('ignores widths off the whitelist and serves the original bytes (cache-stuffing guard)', async () => {
        const res = await GET(req(`path=${encodeURIComponent(FILE)}&w=999`));

        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('image/jpeg');
        expect(res.headers.get('ETag')).toBe(fileEtag());
        expect(Buffer.compare(Buffer.from(await res.arrayBuffer()), bigJpeg)).toBe(0);
    });

    it('keeps no-w responses byte-identical, now with a validator + long fresh window (task B)', async () => {
        const res = await GET(req(`path=${encodeURIComponent(FILE)}`));

        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('image/jpeg');
        expect(res.headers.get('ETag')).toBe(fileEtag());
        expect(res.headers.get('Cache-Control')).toContain('stale-while-revalidate');
        expect(Buffer.compare(Buffer.from(await res.arrayBuffer()), bigJpeg)).toBe(0);
    });

    it('falls back to the original bytes when sharp cannot decode the source, and caches nothing', async () => {
        const junk = Buffer.from('definitely not an image');
        mocks.fsPromisesStat.mockImplementation(async (p: string) => {
            if (norm(p) === FILE) return fileStat({ size: junk.length });
            throw enoent();
        });
        mocks.fsPromisesReadFile.mockImplementation(async (p: string) => {
            if (norm(p).includes('cover_thumbs')) throw enoent();
            if (norm(p) === FILE) return junk;
            throw enoent();
        });

        const res = await GET(req(`path=${encodeURIComponent(FILE)}&w=480`));

        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('image/jpeg');
        expect(Buffer.compare(Buffer.from(await res.arrayBuffer()), junk)).toBe(0);
        expect(mocks.fsPromisesWriteFile).not.toHaveBeenCalled();
    });
});

describe('folder covers resolve to a candidate file first', () => {
    it('thumbnails the folder cover via the same pipeline', async () => {
        mocks.fsPromisesStat.mockImplementation(async (p: string) => {
            const s = norm(p);
            if (s === FOLDER) return { mtimeMs: 5, size: 0, isDirectory: () => true, isFile: () => false };
            if (s.endsWith('cover.jpg')) return fileStat();
            throw enoent();
        });

        const res = await GET(req(`path=${encodeURIComponent(FOLDER)}&w=480`));

        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('image/webp');
        expect(res.headers.get('ETag')).toBe(fileEtag(480));
        const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
        expect(meta.width).toBe(480);
    });
});

describe('remote provider covers with ?w=', () => {
    const REMOTE = 'https://comicvine.gamespot.com/a/uploads/original/cover.jpg';
    const remoteEtag = `"r-${crypto.createHash('md5').update(`${REMOTE}|w480`).digest('hex')}"`;
    const upstream = () => ({
        ok: true,
        headers: { get: (k: string) => k === 'content-type' ? 'image/jpeg' : k === 'content-length' ? String(bigJpeg.length) : null },
        arrayBuffer: async () => bigJpeg.buffer.slice(bigJpeg.byteOffset, bigJpeg.byteOffset + bigJpeg.byteLength),
    });

    it('resizes the upstream image to WebP and writes the disk cache', async () => {
        mocks.fetch.mockResolvedValue(upstream());

        const res = await GET(req(`path=${encodeURIComponent(REMOTE)}&w=480`));

        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('image/webp');
        expect(res.headers.get('ETag')).toBe(remoteEtag);
        const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
        expect(meta.width).toBe(480);
        const writes = mocks.fsPromisesWriteFile.mock.calls.map(c => String(c[0]));
        expect(writes.some(p => p.includes('cover_thumbs'))).toBe(true);
    });

    it('serves a warm remote thumbnail without any upstream round-trip', async () => {
        const cachedWebp = await sharp(bigJpeg).resize({ width: 480 }).webp().toBuffer();
        mocks.fsPromisesReadFile.mockImplementation(async (p: string) => {
            if (String(p).includes('cover_thumbs')) return cachedWebp;
            throw enoent();
        });

        const res = await GET(req(`path=${encodeURIComponent(REMOTE)}&w=480`));

        expect(res.status).toBe(200);
        expect(Buffer.compare(Buffer.from(await res.arrayBuffer()), cachedWebp)).toBe(0);
        expect(mocks.fetch).not.toHaveBeenCalled();
    });

    it('answers 304 before any upstream fetch when If-None-Match matches (task B)', async () => {
        const res = await GET(req(`path=${encodeURIComponent(REMOTE)}&w=480`, { 'if-none-match': remoteEtag }));

        expect(res.status).toBe(304);
        expect(res.headers.get('ETag')).toBe(remoteEtag);
        expect(mocks.fetch).not.toHaveBeenCalled();
    });

    it('leaves the no-w remote pass-through byte-identical with legacy headers (OPDS safety)', async () => {
        mocks.fetch.mockResolvedValue(upstream());

        const res = await GET(req(`path=${encodeURIComponent(REMOTE)}`));

        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('image/jpeg');
        expect(res.headers.get('Cache-Control')).toBe('public, max-age=86400');
        expect(res.headers.get('ETag')).toBeNull();
        expect(Buffer.compare(Buffer.from(await res.arrayBuffer()), bigJpeg)).toBe(0);
    });

    it('still refuses untrusted hosts before touching cache or upstream', async () => {
        const res = await GET(req(`path=${encodeURIComponent('https://evil.example.com/cover.jpg')}&w=480`));

        expect(res.status).toBe(403);
        expect(mocks.fetch).not.toHaveBeenCalled();
        expect(mocks.fsPromisesReadFile).not.toHaveBeenCalled();
    });
});

describe('issue first-page renders carry validators too (task B)', () => {
    const ARCHIVE = '/data/comics/Saga (2012)/Saga 001.cbz';
    const issueEtag = `"i-${crypto.createHash('md5').update(`${ARCHIVE}-cover0-777`).digest('hex')}"`;

    beforeEach(() => {
        mocks.issueFindUnique.mockResolvedValue({ filePath: ARCHIVE });
        mocks.fsPromisesStat.mockImplementation(async (p: string) => {
            if (String(p) === ARCHIVE) return { mtimeMs: 777, size: 123, isDirectory: () => false, isFile: () => true };
            throw enoent();
        });
        mocks.fsPromisesReadFile.mockImplementation(async (p: string) => {
            if (String(p).includes('issue_covers')) return Buffer.from('cached_webp');
            throw enoent();
        });
    });

    it('stamps the render-cache-derived ETag on a warm hit', async () => {
        const res = await GET(req('issueId=issue_1'));

        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('image/webp');
        expect(res.headers.get('ETag')).toBe(issueEtag);
        expect(mocks.fetch).not.toHaveBeenCalled();
    });

    it('answers 304 for a matching If-None-Match', async () => {
        const res = await GET(req('issueId=issue_1', { 'if-none-match': issueEtag }));

        expect(res.status).toBe(304);
        expect(res.headers.get('ETag')).toBe(issueEtag);
        expect(mocks.fetch).not.toHaveBeenCalled();
    });
});
