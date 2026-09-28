// POST /api/request type=volume — "Request Missing" / "Request Series" expand a provider volume into
// one request per issue not already owned. #203 COLLECTED coverage: an issue an OWNED collected
// edition reprints is not asked for either — and the owned check reads the RUN only, so an owned
// trade numbered "3" can no longer stand in for single #3 (nor an annual for #1).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '@/app/api/request/route';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { getToken } from 'next-auth/jwt';
import { cachedCvGet } from '@/lib/metadata/metadata-cache';

vi.mock('next-auth/jwt', () => ({ getToken: vi.fn() }));
vi.mock('@/lib/automation', () => ({ searchAndDownload: vi.fn().mockResolvedValue(undefined), processAutomationQueue: vi.fn() }));
vi.mock('@/lib/trophy-evaluator', () => ({ evaluateTrophies: vi.fn().mockResolvedValue(true) }));
vi.mock('@/lib/manga-detector', () => ({ detectManga: vi.fn().mockResolvedValue(false) }));
vi.mock('@/lib/metadata-fetcher', () => ({ syncSeriesMetadata: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/metadata/providers/metron-cover', () => ({ getMetronCover: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/metadata/metadata-cache', () => ({ cachedCvGet: vi.fn() }));
vi.mock('@/lib/follows', () => ({ followSeries: vi.fn().mockResolvedValue(undefined), followSeriesByCatalogId: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/logger', () => ({ Logger: { log: vi.fn() } }));
vi.mock('@/lib/audit-logger', () => ({ AuditLogger: { log: vi.fn() } }));

vi.mock('@/lib/db', () => ({
    prisma: {
        user: { findUnique: vi.fn() },
        request: { create: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn(), count: vi.fn() },
        series: { upsert: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn() },
        issue: { findMany: vi.fn() },
        library: { findMany: vi.fn() },
        systemSetting: { findUnique: vi.fn(), findMany: vi.fn() },
    }
}));

const cvIssue = (n: number) => ({ id: 9000 + n, name: null, issue_number: String(n), cover_date: '2024-01-01', store_date: '2024-01-01', image: {} });

describe('API: volume request vs. coverage (POST)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (getToken as any).mockResolvedValue({ id: 'user-1', role: 'USER', name: 'Reader' });
        (prisma.user.findUnique as any).mockResolvedValue({ id: 'user-1', role: 'USER', canRequest: true, autoApproveRequests: true });
        (prisma.systemSetting.findUnique as any).mockImplementation(async ({ where }: any) => ({ key: where.key, value: 'dummy' }));
        (prisma.systemSetting.findMany as any).mockResolvedValue([]);
        (prisma.series.findUnique as any).mockResolvedValue(null);
        (prisma.series.upsert as any).mockResolvedValue({ id: 'series-1', name: 'Saga', folderPath: '/data/comics/Saga (2012)' });
        (prisma.library.findMany as any).mockResolvedValue([{ id: 'lib1', path: '/data/comics', isManga: false, isDefault: true }]);
        (prisma.request.create as any).mockImplementation(async ({ data }: any) => ({ id: `req-${data.activeDownloadName}`, status: data.status }));
        (prisma.request.findFirst as any).mockResolvedValue(null);
        (cachedCvGet as any).mockImplementation(async (url: string) => url.includes('/issues/')
            ? { data: { results: [1, 2, 3, 4, 5, 6].map(cvIssue) } }
            : { data: { results: { name: 'Saga', publisher: { name: 'Image' }, start_year: '2012', description: 'd' } } });
    });

    it('skips the issues an owned collected edition covers, and reads ownership from the run alone', async () => {
        let ownedWhere: any = null;
        (prisma.issue.findMany as any).mockImplementation(async ({ where }: any) => {
            if (where.attachedVolume) return [{ seriesId: 'series-1', coversIssues: '5-6' }];
            ownedWhere = where;
            return [{ number: '1' }];
        });

        const res = await POST(new NextRequest('http://localhost/api/request', {
            method: 'POST',
            body: JSON.stringify({ type: 'volume', cvId: 4242, name: 'Saga', metadataSource: 'COMICVINE', year: '2012', publisher: 'Image' }),
        }));

        expect(res.status).toBe(200);
        const filed = (prisma.request.create as any).mock.calls.map((c: any[]) => c[0].data.activeDownloadName);
        // #1 is on disk, #5-6 are in the trade; #3 is asked for even though a trade row may carry "3".
        expect(filed).toEqual(['Saga #2', 'Saga #3', 'Saga #4']);
        expect(ownedWhere).toEqual(expect.objectContaining({ seriesId: 'series-1', filePath: { not: null }, attachedVolumeId: null, isAnnual: false }));
    });

    it('does not trust a request payload to set or overwrite a series imprint', async () => {
        (prisma.systemSetting.findMany as any).mockResolvedValue([
            { key: 'folder_naming_pattern', value: '{Imprint}/{Publisher}/{Series} ({Year})' },
        ]);
        (prisma.series.findUnique as any)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ isManga: false, imprint: 'Vertigo' });

        for (const name of ['New Series', 'Existing Series']) {
            const res = await POST(new NextRequest('http://localhost/api/request', {
                method: 'POST',
                body: JSON.stringify({
                    type: 'volume',
                    cvId: name === 'New Series' ? 4242 : 4243,
                    name,
                    metadataSource: 'COMICVINE',
                    year: '2012',
                    publisher: 'Image',
                    imprint: 'Spoofed Imprint',
                    monitorOnly: true,
                }),
            }));
            expect(res.status).toBe(200);
        }

        const upserts = (prisma.series.upsert as any).mock.calls.map((call: any[]) => call[0]);
        expect(upserts).toHaveLength(2);
        expect(upserts[0].create).not.toHaveProperty('imprint');
        expect(upserts[0].create.folderPath).toBe('/data/comics/Image/Saga (2012)');
        expect(upserts[1].update).not.toHaveProperty('imprint');
    });
});
