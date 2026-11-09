// POST /api/request type=volume - the "Monitor Series?" answer. Requesting a whole series asks
// (Search, Discover, Calendar) whether Omnibus should also monitor it for future issues. "Yes,
// Request & Monitor" sends monitored=true; "No, Just Request Current Issues" sends monitored=false.
// The route used to read `monitored` and never use it: the series was always saved monitored, so
// the Series Monitor went on downloading the future issues the requester had just said no to.
//
// Only an explicit no changes anything. Callers that don't answer (For You's Monitor, the reading
// list's add-missing - both monitorOnly) keep monitoring, and a no never switches off a series that
// is already monitored (someone else may be following it): the update leaves the flag alone.
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

// The mocked module functions, as plain mocks (their real Prisma / next-auth types don't matter here).
const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

const cvIssue = (n: number) => ({ id: 9000 + n, name: null, issue_number: String(n), cover_date: '2024-01-01', store_date: '2024-01-01', image: {} });

const requestSeries = (extra: Record<string, unknown>) => POST(new NextRequest('http://localhost/api/request', {
    method: 'POST',
    body: JSON.stringify({ type: 'volume', cvId: 4242, name: 'Saga', metadataSource: 'COMICVINE', year: '2012', publisher: 'Image', ...extra }),
}));

// The one series upsert the request made.
const upserted = () => {
    const calls = vi.mocked(prisma.series.upsert).mock.calls;
    expect(calls).toHaveLength(1);
    return calls[0][0] as { create: Record<string, unknown>; update: Record<string, unknown> };
};
const filed = () => vi.mocked(prisma.request.create).mock.calls.map(c => (c[0] as { data: { activeDownloadName: string } }).data.activeDownloadName);

describe('API: a series request follows the "Monitor Series?" answer (POST)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mock(getToken).mockResolvedValue({ id: 'user-1', role: 'USER', name: 'Reader' });
        mock(prisma.user.findUnique).mockResolvedValue({ id: 'user-1', role: 'USER', canRequest: true, autoApproveRequests: true });
        mock(prisma.systemSetting.findUnique).mockImplementation(async ({ where }: { where: { key: string } }) => ({ key: where.key, value: 'dummy' }));
        mock(prisma.systemSetting.findMany).mockResolvedValue([]);
        mock(prisma.series.findUnique).mockResolvedValue(null);
        mock(prisma.series.upsert).mockResolvedValue({ id: 'series-1', name: 'Saga', folderPath: '/data/comics/Image/Saga (2012)' });
        mock(prisma.library.findMany).mockResolvedValue([{ id: 'lib1', path: '/data/comics', isManga: false, isDefault: true }]);
        mock(prisma.request.create).mockImplementation(async ({ data }: { data: { activeDownloadName: string; status: string } }) =>
            ({ id: `req-${data.activeDownloadName}`, status: data.status }));
        mock(prisma.request.findFirst).mockResolvedValue(null);
        mock(prisma.issue.findMany).mockResolvedValue([]);
        mock(cachedCvGet).mockImplementation(async (url: string) => url.includes('/issues/')
            ? { data: { results: [1, 2, 3].map(cvIssue) } }
            : { data: { results: { name: 'Saga', publisher: { name: 'Image' }, start_year: '2012', description: 'd' } } });
    });

    it('"No, Just Request Current Issues": the series is saved unmonitored, and its issues are still requested', async () => {
        expect((await requestSeries({ monitored: false, monitorOnly: false })).status).toBe(200);

        expect(upserted().create.monitored).toBe(false);
        expect(filed()).toEqual(['Saga #1', 'Saga #2', 'Saga #3']);
    });

    it('a no leaves a series that is already in the library as it is - never switches its monitoring off', async () => {
        expect((await requestSeries({ monitored: false })).status).toBe(200);

        expect(upserted().update).not.toHaveProperty('monitored');
    });

    it('"Yes, Request & Monitor": the series is monitored, new or already in the library', async () => {
        expect((await requestSeries({ monitored: true, monitorOnly: false })).status).toBe(200);

        const { create, update } = upserted();
        expect(create.monitored).toBe(true);
        expect(update.monitored).toBe(true);
        expect(filed()).toEqual(['Saga #1', 'Saga #2', 'Saga #3']);
    });

    it('a caller that does not answer keeps monitoring the series, as before', async () => {
        expect((await requestSeries({})).status).toBe(200);

        const { create, update } = upserted();
        expect(create.monitored).toBe(true);
        expect(update.monitored).toBe(true);
    });

    it("monitor-only (For You's Monitor, a reading list's add-missing) monitors the series and requests nothing", async () => {
        expect((await requestSeries({ monitorOnly: true })).status).toBe(200);

        const { create, update } = upserted();
        expect(create.monitored).toBe(true);
        expect(update.monitored).toBe(true);
        expect(filed()).toEqual([]);
    });
});
