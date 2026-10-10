// "Delete series + files" removes the series' folder from disk. It used to remove whatever path the
// row held - a series whose folderPath was the library root (or anywhere else) took that folder with
// it. Both delete routes now only remove a folder strictly inside a configured library.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs-extra';
import { DELETE as bulkDelete } from '@/app/api/library/route';
import { DELETE as seriesDelete } from '@/app/api/library/series/route';
import { prisma } from '@/lib/db';
import { AuditLogger } from '@/lib/audit-logger';

vi.mock('next-auth/next', () => ({ getServerSession: vi.fn().mockResolvedValue({ user: { id: 'admin-1', role: 'ADMIN' } }) }));
vi.mock('@/app/api/auth/[...nextauth]/options', () => ({ getAuthOptions: vi.fn(async () => ({})) }));
vi.mock('@/lib/logger', () => ({ Logger: { log: vi.fn() } }));
vi.mock('@/lib/audit-logger', () => ({ AuditLogger: { log: vi.fn() } }));
vi.mock('@/lib/manga-detector', () => ({ detectManga: vi.fn() }));
vi.mock('@/lib/metadata-extractor', () => ({ parseComicInfo: vi.fn() }));
vi.mock('@/lib/library-scanner', () => ({ LibraryScanner: { scan: vi.fn() } }));
vi.mock('@/lib/db', () => ({
    prisma: {
        series: { findMany: vi.fn(), deleteMany: vi.fn() },
        issue: { deleteMany: vi.fn() },
        library: { findMany: vi.fn() },
    }
}));
vi.mock('fs-extra', () => ({
    default: { existsSync: vi.fn().mockReturnValue(true), remove: vi.fn().mockResolvedValue(undefined) },
}));

const ROUTES = [
    { name: 'DELETE /api/library (bulk)', del: bulkDelete, url: 'http://localhost/api/library' },
    { name: 'DELETE /api/library/series', del: seriesDelete, url: 'http://localhost/api/library/series' },
];

const SERIES = [
    { id: 's-good', folderPath: '/data/comics/Image/Saga (2012)' },
    { id: 's-root', folderPath: '/data/comics' },
    { id: 's-climb', folderPath: '/data/comics/Image/../..' },
    { id: 's-outside', folderPath: '/config' },
    { id: 's-sibling', folderPath: '/data/comics-secret/Saga' },
];

describe.each(ROUTES)('$name with deleteFiles', ({ del, url }) => {
    beforeEach(() => {
        vi.clearAllMocks();
        (prisma.series.findMany as any).mockResolvedValue(SERIES);
        (prisma.library.findMany as any).mockResolvedValue([{ id: 'lib1', path: '/data/comics' }, { id: 'lib2', path: '/data/manga' }]);
        (fs.existsSync as any).mockReturnValue(true);
    });

    it('removes only folders strictly inside a library, and still deletes every row', async () => {
        const res = await del(new Request(url, {
            method: 'DELETE',
            body: JSON.stringify({ seriesIds: SERIES.map(s => s.id), deleteFiles: true }),
        }));

        expect(res.status).toBe(200);
        expect((fs.remove as any).mock.calls.map((c: any[]) => c[0])).toEqual(['/data/comics/Image/Saga (2012)']);
        expect(prisma.series.deleteMany).toHaveBeenCalledWith({ where: { id: { in: SERIES.map(s => s.id) } } });

        // The audit trail records what was removed and what was refused.
        const audit = (AuditLogger.log as any).mock.calls[0][1];
        expect(audit.deletedPaths).toEqual(['/data/comics/Image/Saga (2012)']);
        expect(audit.refusedPaths).toEqual(['/data/comics', '/data/comics/Image/../..', '/config', '/data/comics-secret/Saga']);
    });

    it('removes nothing from disk without deleteFiles', async () => {
        await del(new Request(url, { method: 'DELETE', body: JSON.stringify({ seriesIds: ['s-good'], deleteFiles: false }) }));
        expect(fs.remove).not.toHaveBeenCalled();
    });
});
