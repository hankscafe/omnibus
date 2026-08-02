// Auto-follow on request (Beta A): requesting is the strongest interest signal, so both request
// paths subscribe the requester — the volume path follows the just-upserted series directly
// (covering monitorOnly and therefore the Auto-Build add-missing flow), the single-issue path
// follows by catalog identity (silent no-op when the series isn't in the library).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '@/app/api/request/route';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { getToken } from 'next-auth/jwt';
import { followSeries, followSeriesByCatalogId } from '@/lib/follows';

vi.mock('next-auth/jwt', () => ({ getToken: vi.fn() }));
vi.mock('@/lib/automation', () => ({
    searchAndDownload: vi.fn().mockResolvedValue(undefined),
    processAutomationQueue: vi.fn()
}));
vi.mock('@/lib/trophy-evaluator', () => ({ evaluateTrophies: vi.fn().mockResolvedValue(true) }));
vi.mock('@/lib/manga-detector', () => ({ detectManga: vi.fn().mockResolvedValue(false) }));
vi.mock('@/lib/metadata-fetcher', () => ({ syncSeriesMetadata: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/metadata/providers/metron-cover', () => ({ getMetronCover: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/metadata/metadata-cache', () => ({
    cachedCvGet: vi.fn().mockResolvedValue({
        data: { results: { name: 'Saga', publisher: { name: 'Image' }, start_year: '2012', description: 'd' } }
    })
}));
vi.mock('@/lib/follows', () => ({
    followSeries: vi.fn().mockResolvedValue(undefined),
    followSeriesByCatalogId: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        user: { findUnique: vi.fn() },
        request: { create: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn(), count: vi.fn() },
        series: { upsert: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn() },
        library: { findMany: vi.fn() },
        systemSetting: { findUnique: vi.fn(), findMany: vi.fn() }
    }
}));

describe('API: request auto-follow (POST)', () => {
    beforeEach(() => {
        (getToken as any).mockResolvedValue({ id: 'user-1', role: 'USER', name: 'Reader' });
        (prisma.user.findUnique as any).mockResolvedValue({ id: 'user-1', role: 'USER', canRequest: true, autoApproveRequests: true });
        (prisma.systemSetting.findUnique as any).mockImplementation(async ({ where }: any) => ({ key: where.key, value: 'dummy' }));
        (prisma.systemSetting.findMany as any).mockResolvedValue([]);
        (prisma.series.findUnique as any).mockResolvedValue(null);
        (prisma.series.upsert as any).mockResolvedValue({ id: 'series-1', folderPath: '/data/comics/Saga (2012)' });
        (prisma.library.findMany as any).mockResolvedValue([{ id: 'lib1', path: '/data/comics', isManga: false, isDefault: true }]);
        (prisma.request.create as any).mockResolvedValue({ id: 'req-1', status: 'PENDING' });
        (prisma.request.findFirst as any).mockResolvedValue(null);
    });

    it('volume request (monitorOnly) follows the upserted series for the requester', async () => {
        const res = await POST(new NextRequest('http://localhost/api/request', {
            method: 'POST',
            body: JSON.stringify({ type: 'volume', cvId: 4242, name: 'Saga', metadataSource: 'COMICVINE', monitorOnly: true })
        }));

        expect(res.status).toBe(200);
        expect(followSeries).toHaveBeenCalledWith('user-1', 'series-1');
    });

    it('single-issue request follows by catalog identity', async () => {
        const res = await POST(new NextRequest('http://localhost/api/request', {
            method: 'POST',
            body: JSON.stringify({ type: 'issue', cvId: 555, name: 'Saga #1', publisher: 'Image', year: '2012', issueNumber: '1' })
        }));

        expect(res.status).toBe(200);
        expect(followSeriesByCatalogId).toHaveBeenCalledWith('user-1', 'COMICVINE', '555');
        expect(followSeries).not.toHaveBeenCalled();
    });
});
