import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '@/app/api/request/retry/route';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    userFindUnique: vi.fn(),
    requestFindUnique: vi.fn(),
    requestFindFirst: vi.fn(),
    requestUpdate: vi.fn(),
    seriesFindFirst: vi.fn(),
    settingFindMany: vi.fn(),
    settingFindUnique: vi.fn(),
    downloadDirectFile: vi.fn(),
    importRequest: vi.fn(),
    scrapeDeepLinkViaEngine: vi.fn(),
    fetch: vi.fn(),
    log: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        user: { findUnique: mocks.userFindUnique },
        request: { findUnique: mocks.requestFindUnique, findFirst: mocks.requestFindFirst, update: mocks.requestUpdate },
        series: { findFirst: mocks.seriesFindFirst },
        systemSetting: { findMany: mocks.settingFindMany, findUnique: mocks.settingFindUnique },
    }
}));

vi.mock('next-auth/jwt', () => ({ getToken: vi.fn().mockResolvedValue({ id: 'user_1', role: 'ADMIN' }) }));
vi.mock('@/lib/download-clients', () => ({ DownloadService: { downloadDirectFile: mocks.downloadDirectFile } }));
vi.mock('@/lib/importer', () => ({ Importer: { importRequest: mocks.importRequest } }));
vi.mock('@/lib/queue', () => ({ omnibusQueue: { getJobs: vi.fn().mockResolvedValue([]) } }));
vi.mock('@/lib/getcomics', () => ({
    enabledHostersFromSetting: vi.fn().mockReturnValue(['getcomics_direct', 'getcomics_main', 'mediafire']),
    scrapeDeepLinkViaEngine: mocks.scrapeDeepLinkViaEngine,
}));
vi.mock('@/lib/engine', () => ({
    ENGINE_URL: 'http://engine',
    engineHeaders: (extra?: Record<string, string>) => extra || {},
}));
vi.mock('@/lib/logger', () => ({ Logger: { log: mocks.log } }));

function retryRequest(id = 'req_1') {
    return POST(new NextRequest('http://localhost/api/request/retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
    }));
}

describe('API Route: Request Retry (engine recovery search)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('fetch', mocks.fetch);
        mocks.userFindUnique.mockResolvedValue({ id: 'user_1', role: 'ADMIN' });
        // A lost link: no downloadLink at all → falls straight through to the recovery search.
        mocks.requestFindUnique.mockResolvedValue({
            id: 'req_1', userId: 'user_1', activeDownloadName: 'Batman 001', volumeId: '0', failedLinks: '[]', downloadLink: null
        });
        mocks.requestFindFirst.mockResolvedValue(null);
        mocks.settingFindMany.mockResolvedValue([{ key: 'download_path', value: '/downloads' }]);
        mocks.settingFindUnique.mockResolvedValue(null); // ddl_enabled unset → enabled
        mocks.downloadDirectFile.mockResolvedValue(false);
        mocks.fetch.mockRejectedValue(new Error('engine unavailable'));
    });

    it('recovers via the engine automation search and starts the top enabled-hoster candidate', async () => {
        mocks.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                success: true,
                best_match: { title: 'Batman 001 (2016)', protocol: 'ddl', downloadUrl: 'https://x/best', indexer: 'getcomics_direct' },
                // First candidate's hoster is NOT enabled → the airtight check must skip to the second.
                ddl_candidates: [
                    { url: 'https://x/blocked', hoster: 'terabox' },
                    { url: 'https://x/file.cbz', hoster: 'mediafire' },
                ]
            })
        });

        const res = await retryRequest();
        const data = await res.json();

        expect(data.success).toBe(true);
        // The engine got the DDL-only recovery search (the retired Node GetComics stack is never used).
        const body = JSON.parse(mocks.fetch.mock.calls[0][1].body);
        expect(body).toMatchObject({ name: 'Batman 001', skip_indexers: true, request_id: 'req_1' });
        // Disabled-hoster candidate skipped; download started on the enabled one.
        expect(mocks.requestUpdate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ status: 'DOWNLOADING', downloadLink: 'https://x/file.cbz' })
        }));
        expect(mocks.downloadDirectFile).toHaveBeenCalledWith('https://x/file.cbz', expect.any(String), '/downloads', 'req_1', 'mediafire');
    });

    it('holds a manual-only recovery as MANUAL_DDL', async () => {
        mocks.fetch.mockResolvedValue({
            ok: true,
            json: async () => ({ success: false, manual_ddl: { url: 'https://getcomics.org/dls/x', name: 'Batman 001' } })
        });

        const res = await retryRequest();
        const data = await res.json();

        expect(data.success).toBe(true);
        expect(mocks.requestUpdate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ status: 'MANUAL_DDL', downloadLink: 'https://getcomics.org/dls/x' })
        }));
        expect(mocks.downloadDirectFile).not.toHaveBeenCalled();
    });

    it('returns the lost-link error when the engine is unreachable', async () => {
        const res = await retryRequest();
        expect(res.status).toBe(400);
        expect(mocks.downloadDirectFile).not.toHaveBeenCalled();
    });
});
