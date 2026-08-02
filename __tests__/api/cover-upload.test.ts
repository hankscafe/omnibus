// __tests__/api/cover-upload.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST, DELETE } from '@/app/api/library/cover-upload/route';
import { auditLog } from '../helpers/setup-global';

const mocks = vi.hoisted(() => ({
    getToken: vi.fn(),
    findManyLibraries: vi.fn(),
    findFirstSeries: vi.fn(),
    updateSeries: vi.fn(),
    log: vi.fn(),
    audit: vi.fn(),
    existsSync: vi.fn(),
    pathExists: vi.fn(),
    writeFile: vi.fn(),
    remove: vi.fn(),
}));

vi.mock('next-auth/jwt', () => ({ getToken: mocks.getToken }));
vi.mock('@/lib/db', () => ({
    prisma: {
        library: { findMany: mocks.findManyLibraries },
        series: { findFirst: mocks.findFirstSeries, update: mocks.updateSeries },
    }
}));
// Keep the real isPathWithinRoots (the route uses it for containment now) while overriding UNMATCHED_DIR.
vi.mock('@/lib/utils/paths', async (importOriginal) => ({ ...(await importOriginal() as any), UNMATCHED_DIR: '/unmatched' }));
vi.mock('fs-extra', () => ({
    default: {
        existsSync: mocks.existsSync,
        pathExists: mocks.pathExists,
        writeFile: mocks.writeFile,
        remove: mocks.remove,
    }
}));

const PNG = 'data:image/png;base64,' + Buffer.from('hello-image-bytes-1234567890').toString('base64');
const reqOf = (method: string, body: any) => new Request('http://localhost/api/library/cover-upload', {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
});

describe('API Route: Cover Upload (/api/library/cover-upload)', () => {
    beforeEach(() => {
        mocks.getToken.mockResolvedValue({ id: 'admin_1', role: 'ADMIN' });
        mocks.findManyLibraries.mockResolvedValue([{ path: '/comics' }]);
        mocks.findFirstSeries.mockResolvedValue({ id: 'series_1', name: 'Batman' });
        mocks.updateSeries.mockResolvedValue({});
        mocks.existsSync.mockReturnValue(true);
        mocks.pathExists.mockResolvedValue(false);
        mocks.writeFile.mockResolvedValue(undefined);
        mocks.remove.mockResolvedValue(undefined);
        auditLog.mockResolvedValue(true);
    });

    it('rejects non-admins', async () => {
        mocks.getToken.mockResolvedValue({ id: 'u', role: 'USER' });
        const res = await POST(reqOf('POST', { currentPath: '/comics/Batman', imageBase64: PNG }) as any);
        expect(res.status).toBe(403);
        expect(mocks.writeFile).not.toHaveBeenCalled();
    });

    it('rejects a path outside any library (traversal guard)', async () => {
        const res = await POST(reqOf('POST', { currentPath: '/etc/secrets', imageBase64: PNG }) as any);
        expect(res.status).toBe(403);
        expect(mocks.writeFile).not.toHaveBeenCalled();
    });

    it('writes cover.jpg, locks the series, and returns a cache-busted url', async () => {
        const res = await POST(reqOf('POST', { currentPath: '/comics/Batman', imageBase64: PNG }) as any);
        expect(res.status).toBe(200);

        expect(mocks.writeFile).toHaveBeenCalledTimes(1);
        expect(String(mocks.writeFile.mock.calls[0][0])).toContain('cover.jpg');

        expect(mocks.updateSeries).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'series_1' },
            data: expect.objectContaining({ hasCustomCover: true, coverUrl: expect.stringContaining('/api/library/cover') })
        }));

        const data = await res.json();
        expect(data.coverUrl).toContain('v='); // cache-bust param
    });

    it('DELETE reverts: removes cover.jpg and clears the flag', async () => {
        mocks.pathExists.mockResolvedValue(true);
        const res = await DELETE(reqOf('DELETE', { currentPath: '/comics/Batman' }) as any);
        expect(res.status).toBe(200);
        expect(mocks.remove).toHaveBeenCalled();
        expect(mocks.updateSeries).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'series_1' },
            data: { coverUrl: null, hasCustomCover: false }
        }));
    });
});
