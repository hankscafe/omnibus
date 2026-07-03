import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from '@/app/api/reader/image/route';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    libraryFindMany: vi.fn(),
    fsExistsSync: vi.fn(),
    fsStatSync: vi.fn(),
    fsReadFileSync: vi.fn(),
    fsUtimesSync: vi.fn(),
    fsMkdirSync: vi.fn(),
    fsReaddirSync: vi.fn().mockReturnValue([]),
    fsUnlinkSync: vi.fn(),
    // async fs.promises used on the request hot path
    fsPromisesStat: vi.fn(),
    fsPromisesReadFile: vi.fn(),
    fsPromisesUtimes: vi.fn().mockResolvedValue(true),
    zipGetEntry: vi.fn(),
    zipGetEntries: vi.fn().mockReturnValue([]),
    zipGetData: vi.fn(),
    sharpResize: vi.fn().mockReturnThis(),
    sharpWebp: vi.fn().mockReturnThis(),
    sharpTrim: vi.fn().mockReturnThis(),
    sharpToBuffer: vi.fn().mockResolvedValue(Buffer.from('fake_image_data')),
    log: vi.fn(),
    mockSession: { user: { id: 'user_1', role: 'ADMIN' } } // Hoisted Auth
}));

vi.mock('@/lib/db', () => ({
    prisma: { library: { findMany: mocks.libraryFindMany } }
}));

vi.mock('fs', () => ({
    existsSync: mocks.fsExistsSync,
    statSync: mocks.fsStatSync,
    readFileSync: mocks.fsReadFileSync,
    utimesSync: mocks.fsUtimesSync,
    mkdirSync: mocks.fsMkdirSync,
    readdirSync: mocks.fsReaddirSync,
    unlinkSync: mocks.fsUnlinkSync,
    promises: { writeFile: vi.fn().mockResolvedValue(true), rename: vi.fn().mockResolvedValue(true), mkdir: vi.fn().mockResolvedValue(true), unlink: vi.fn().mockResolvedValue(true), stat: mocks.fsPromisesStat, readFile: mocks.fsPromisesReadFile, utimes: mocks.fsPromisesUtimes },
    default: {
        existsSync: mocks.fsExistsSync,
        statSync: mocks.fsStatSync,
        readFileSync: mocks.fsReadFileSync,
        utimesSync: mocks.fsUtimesSync,
        mkdirSync: mocks.fsMkdirSync,
        readdirSync: mocks.fsReaddirSync,
        unlinkSync: mocks.fsUnlinkSync,
        promises: { writeFile: vi.fn().mockResolvedValue(true), rename: vi.fn().mockResolvedValue(true), mkdir: vi.fn().mockResolvedValue(true), unlink: vi.fn().mockResolvedValue(true), stat: mocks.fsPromisesStat, readFile: mocks.fsPromisesReadFile, utimes: mocks.fsPromisesUtimes }
    }
}));

vi.mock('fs/promises', () => ({
    writeFile: vi.fn().mockResolvedValue(true),
    rename: vi.fn().mockResolvedValue(true),
    mkdir: vi.fn().mockResolvedValue(true),
    unlink: vi.fn().mockResolvedValue(true),
    default: { writeFile: vi.fn().mockResolvedValue(true), rename: vi.fn().mockResolvedValue(true), mkdir: vi.fn().mockResolvedValue(true), unlink: vi.fn().mockResolvedValue(true) }
}));

vi.mock('next-auth/next', () => ({ getServerSession: vi.fn().mockResolvedValue(mocks.mockSession) }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn().mockResolvedValue(mocks.mockSession) }));
vi.mock('next-auth/jwt', () => ({ getToken: vi.fn().mockResolvedValue(mocks.mockSession.user) }));
vi.mock('@/lib/auth', () => ({ getAuthSession: vi.fn().mockResolvedValue(mocks.mockSession) }));
vi.mock('@/app/api/auth/[...nextauth]/options', () => ({ getAuthOptions: vi.fn() }));

// CRITICAL FIX: Treat AdmZip as a class so 'new AdmZip()' executes correctly
vi.mock('adm-zip', () => {
    return {
        default: class AdmZipMock {
            getEntry(name: string) { return mocks.zipGetEntry(name); }
            getEntries() { return mocks.zipGetEntries(); }
        }
    };
});

vi.mock('sharp', () => {
    return {
        default: vi.fn(() => ({
            resize: mocks.sharpResize,
            webp: mocks.sharpWebp,
            trim: mocks.sharpTrim,
            toBuffer: mocks.sharpToBuffer
        }))
    };
});

vi.mock('@/lib/logger', () => ({ Logger: { log: mocks.log } }));

describe('API Route: Reader Image Serving', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.libraryFindMany.mockResolvedValue([{ path: '/data/comics' }]);
        mocks.fsExistsSync.mockReturnValue(true);
        mocks.fsStatSync.mockReturnValue({ mtimeMs: 12345, size: 50000 });
        // Source-file stat (async) resolves so the route proceeds; utimes is best-effort.
        mocks.fsPromisesStat.mockResolvedValue({ mtimeMs: 12345, size: 50000 });
        mocks.fsPromisesUtimes.mockResolvedValue(true);
    });

    it('should reject unauthorized paths outside the library root', async () => {
        const req = new NextRequest('http://localhost/api/reader/image?path=/etc/passwd&page=page1.jpg');
        const res = await GET(req);
        
        expect(res.status).toBe(403);
        expect(await res.text()).toBe('Unauthorized path access');
    });

    it('should serve a cached webp image if it already exists on disk', async () => {
        // The async cache read resolves → cache hit, served without touching the zip.
        mocks.fsPromisesReadFile.mockResolvedValue(Buffer.from('cached_data'));

        const req = new NextRequest('http://localhost/api/reader/image?path=/data/comics/batman.cbz&page=page1.jpg');
        const res = await GET(req);

        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('image/webp');
        expect(mocks.fsPromisesReadFile).toHaveBeenCalled();
        expect(mocks.zipGetEntry).not.toHaveBeenCalled();
    });

    it('should extract from zip and convert to webp if no cache exists', async () => {
        // Async cache read rejects with ENOENT → cache miss → fall through to extraction.
        mocks.fsPromisesReadFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));

        // Mock out the zip parsing to feed the sharp pipeline
        mocks.zipGetEntry.mockReturnValue({ getData: mocks.zipGetData });
        mocks.zipGetData.mockReturnValue(Buffer.from('raw_zip_data'));

        const req = new NextRequest('http://localhost/api/reader/image?path=/data/comics/batman.cbz&page=page1.jpg');
        const res = await GET(req);
        
        expect(res.status).toBe(200);
        expect(mocks.sharpToBuffer).toHaveBeenCalled();
    });
});