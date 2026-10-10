// A volume request creates the Series row - and its folderPath - from what the requester sent
// (POST /api/request when the provider lookup fails; POST /api/request/manual always). A requester
// is any user with the Request permission, not only an admin. Publisher "..", name "comics" and a
// blank year used to store the LIBRARY ROOT itself as the new series' folder, so an admin's later
// "delete series + files" removed the whole library.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as requestPost } from '@/app/api/request/route';
import { POST as manualPost } from '@/app/api/request/manual/route';
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
vi.mock('@/lib/download-clients', () => ({ DownloadService: { addDownload: vi.fn() } }));
vi.mock('@/lib/getcomics', () => ({ enabledHostersFromSetting: vi.fn(), scrapeDeepLinkViaEngine: vi.fn() }));
vi.mock('@/lib/importer', () => ({ Importer: { importRequest: vi.fn() } }));
vi.mock('@/lib/discord', () => ({ DiscordNotifier: { sendAlert: vi.fn().mockResolvedValue(undefined) } }));
vi.mock('@/lib/mailer', () => ({ Mailer: { sendAlert: vi.fn().mockResolvedValue(undefined) } }));

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

const LIBRARY = '/data/comics';

// Hostile volume requests and the folder each must land in. Every value is sanitized the way a
// ComicInfo value is (dots-only → "_"), and the year keeps only its digits - the number the Series
// row stores anyway.
const CASES = [
    { label: 'publisher ".." + the library folder name = the library root', body: { name: 'comics', publisher: '..', year: '' }, folder: `${LIBRARY}/_/comics` },
    { label: 'a series named ".."', body: { name: '..', publisher: '..', year: '' }, folder: `${LIBRARY}/_/_` },
    { label: 'a year that climbs', body: { name: 'Saga', publisher: 'Image', year: '2012/../../../config/x' }, folder: `${LIBRARY}/Image/Saga (2012)` },
    { label: 'a year that is only a path', body: { name: 'Saga', publisher: 'Image', year: '/../../..' }, folder: `${LIBRARY}/Image/Saga` },
];

function createdFolder(): string {
    const calls = (prisma.series.upsert as any).mock.calls;
    expect(calls).toHaveLength(1);
    return calls[0][0].create.folderPath;
}

describe('volume requests never place a series folder outside the library', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (getToken as any).mockResolvedValue({ id: 'user-1', role: 'USER', name: 'Reader' });
        (prisma.user.findUnique as any).mockResolvedValue({ id: 'user-1', role: 'USER', canRequest: true, autoApproveRequests: false });
        (prisma.systemSetting.findUnique as any).mockImplementation(async ({ where }: any) => ({ key: where.key, value: 'dummy' }));
        (prisma.systemSetting.findMany as any).mockResolvedValue([]);
        (prisma.series.findUnique as any).mockResolvedValue(null);
        (prisma.series.upsert as any).mockResolvedValue({ id: 'series-1', name: 'x', folderPath: `${LIBRARY}/x` });
        (prisma.library.findMany as any).mockResolvedValue([{ id: 'lib1', path: LIBRARY, isManga: false, isDefault: true }]);
        (prisma.request.create as any).mockResolvedValue({ id: 'req-1' });
        (prisma.request.findFirst as any).mockResolvedValue(null);
        // An id the provider doesn't know: the lookup fails, so the requester's own values stay.
        (cachedCvGet as any).mockRejectedValue(new Error('404 Object Not Found'));
    });

    describe('POST /api/request', () => {
        it.each(CASES)('$label', async ({ body, folder }) => {
            const res = await requestPost(new NextRequest('http://localhost/api/request', {
                method: 'POST',
                body: JSON.stringify({ type: 'volume', cvId: 99999999, metadataSource: 'COMICVINE', monitorOnly: true, ...body }),
            }));

            expect(res.status).toBe(200);
            expect(createdFolder()).toBe(folder);
        });
    });

    describe('POST /api/request/manual', () => {
        it.each(CASES)('$label', async ({ body, folder }) => {
            const res = await manualPost(new NextRequest('http://localhost/api/request/manual', {
                method: 'POST',
                body: JSON.stringify({ type: 'volume', monitored: true, cvId: 99999999, metadataSource: 'COMICVINE', ...body }),
            }));

            expect(res.status).toBe(200);
            expect(createdFolder()).toBe(folder);
        });
    });

    it('a folder pattern that climbs out of the library refuses the request instead of storing it', async () => {
        (prisma.systemSetting.findMany as any).mockResolvedValue([{ key: 'folder_naming_pattern', value: '../{Series}' }]);

        const res = await manualPost(new NextRequest('http://localhost/api/request/manual', {
            method: 'POST',
            body: JSON.stringify({ type: 'volume', monitored: true, cvId: 99999999, name: 'Saga', publisher: 'Image', year: '2012' }),
        }));

        expect(res.status).toBe(400);
        expect(prisma.series.upsert).not.toHaveBeenCalled();
        expect(prisma.request.create).not.toHaveBeenCalled();
    });
});
