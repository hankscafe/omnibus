import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeSearchAndDownload } from '@/lib/automation';
import { GetComicsService } from '@/lib/getcomics';
import { ProwlarrService } from '@/lib/prowlarr';
import { DownloadService } from '@/lib/download-clients';
import { SystemNotifier } from '@/lib/notifications';

// 1. Hoist the mocks
const mocks = vi.hoisted(() => ({
    findManyClients: vi.fn(),
    findManySettings: vi.fn(),
    findUniqueSetting: vi.fn(),
    updateRequest: vi.fn(),
    findUniqueRequest: vi.fn(),
    findFirstRequest: vi.fn().mockResolvedValue(null), // <-- ADDED: Mock for Traffic Cop duplicate check
    findFirstSeries: vi.fn().mockResolvedValue(null),  // canonical series lookup (metadata anchor)
    countIssues: vi.fn().mockResolvedValue(0),
    findManyIssues: vi.fn().mockResolvedValue([]),
    log: vi.fn()
}));

// 2. Mock Dependencies
vi.mock('@/lib/db', () => ({
    prisma: {
        downloadClient: { findMany: mocks.findManyClients },
        systemSetting: {
            findMany: mocks.findManySettings,
            findUnique: mocks.findUniqueSetting
        },
        request: {
            update: mocks.updateRequest,
            findUnique: mocks.findUniqueRequest,
            findFirst: mocks.findFirstRequest // <-- ADDED: Wire up the mock
        },
        series: { findFirst: mocks.findFirstSeries },
        issue: { count: mocks.countIssues, findMany: mocks.findManyIssues }
    }
}));

// Keep the real pure helpers (enabledHostersFromSetting handles the getcomics_direct/getcomics_main
// hoster migration) while stubbing the network-bound service methods.
vi.mock('@/lib/getcomics', async (importOriginal) => {
    const actual = await importOriginal() as any;
    return { ...actual, GetComicsService: { search: vi.fn(), scrapeDeepLink: vi.fn() } };
});
vi.mock('@/lib/prowlarr', () => ({ ProwlarrService: { searchComics: vi.fn() } }));
vi.mock('@/lib/download-clients', () => ({ DownloadService: { addDownload: vi.fn(), downloadDirectFile: vi.fn().mockResolvedValue(true) } }));
vi.mock('@/lib/notifications', () => ({ SystemNotifier: { sendAlert: vi.fn().mockResolvedValue(true) } }));
vi.mock('@/lib/logger', () => ({ Logger: { log: mocks.log } }));
// Keep the real normalizeRequestName (used by the indexer relevance guard) while stubbing query generation.
vi.mock('@/lib/search-engine', async (importOriginal) => {
    const actual = await importOriginal() as any;
    return {
        ...actual,
        getCustomAcronyms: vi.fn().mockResolvedValue({}),
        generateSearchQueries: vi.fn().mockReturnValue(['Batman 2024'])
    };
});

describe('Core Logic: Automation Engine', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        
        // Default DB mocks
        mocks.findManyClients.mockResolvedValue([{ id: 'client_1', type: 'qbit' }]);
        mocks.findManySettings.mockResolvedValue([{ key: 'download_path', value: '/downloads' }]);
        
        // Default to returning null so it assumes default hosters are enabled
        mocks.findUniqueSetting.mockResolvedValue(null); 
        
        mocks.findUniqueRequest.mockResolvedValue({ id: 'req_1', activeDownloadName: 'Batman 2024', user: { username: 'Bruce' } });
    });

    it('should successfully find a direct download on GetComics and send it to the client', async () => {
        // 1. Mock GetComics finding the file
        vi.mocked(GetComicsService.search).mockResolvedValueOnce([{ title: 'Batman #01 (2024)', downloadUrl: 'http://getcomics/123' } as any]);
        // 2. Mock the deep-link scraper finding a valid premium hoster
        vi.mocked(GetComicsService.scrapeDeepLink).mockResolvedValueOnce({ url: 'http://mediafire/file.cbz', isDirect: false, hoster: 'mediafire' });

        await executeSearchAndDownload('req_1', 'Batman', '2024', 'DC');

        // Assert it hit the Direct File Downloader, NOT the Torrent downloader
        expect(DownloadService.downloadDirectFile).toHaveBeenCalledWith(
            'http://mediafire/file.cbz',
            'Batman #01 (2024)',
            '/downloads',
            'req_1',
            'mediafire'
        );

        // Assert it updated the database request status
        expect(mocks.updateRequest).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'req_1' },
            data: expect.objectContaining({ status: 'DOWNLOADING' })
        }));
    });

    it('auto-downloads a getcomics_direct CDN link via the internal downloader', async () => {
        // The hoster taxonomy was split from a single `getcomics` key into `getcomics_direct` +
        // `getcomics_main`. scrapeDeepLink returns the new keys; the automation gate must recognize
        // getcomics_direct (clean CDN) so it isn't wrongly rejected as "unsupported" and dumped onto indexers.
        vi.mocked(GetComicsService.search).mockResolvedValueOnce([{ title: 'Batman #01 (2024)', downloadUrl: 'http://getcomics/123' } as any]);
        vi.mocked(GetComicsService.scrapeDeepLink).mockResolvedValueOnce({ url: 'https://cdn.getcomics.org/file.cbz', isDirect: true, hoster: 'getcomics_direct' });

        await executeSearchAndDownload('req_1', 'Batman', '2024', 'DC');

        expect(DownloadService.downloadDirectFile).toHaveBeenCalledWith(
            'https://cdn.getcomics.org/file.cbz', 'Batman #01 (2024)', '/downloads', 'req_1', 'getcomics_direct'
        );
        expect(DownloadService.addDownload).not.toHaveBeenCalled();
    });

    it('routes a getcomics_main /dls/ link to MANUAL_DDL instead of a Cloudflare-doomed direct download', async () => {
        // getcomics.org/dls/ links are Cloudflare-protected; a Node Internal DL always 403s (no FlareSolverr).
        // So getcomics_main must NOT be dispatched to downloadDirectFile — it's held as a manual link, Prowlarr
        // gets a shot, and it ends as a one-click MANUAL_DDL when the indexers come up empty (the Wolverine #3 fix).
        vi.mocked(GetComicsService.search).mockResolvedValueOnce([{ title: 'Wolverine #3 (2024)', downloadUrl: 'http://getcomics/123' } as any]);
        vi.mocked(GetComicsService.scrapeDeepLink).mockResolvedValueOnce({ url: 'https://getcomics.org/dls/abc', isDirect: true, hoster: 'getcomics_main' });
        vi.mocked(ProwlarrService.searchComics).mockResolvedValue([]); // indexers empty → revert to the held manual link

        await executeSearchAndDownload('req_1', 'Wolverine', '2024', 'Marvel');

        expect(DownloadService.downloadDirectFile).not.toHaveBeenCalled();
        expect(mocks.updateRequest).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ status: 'MANUAL_DDL', downloadLink: 'https://getcomics.org/dls/abc' })
        }));
    });

    it('rejects an off-target indexer release (wrong series/issue) instead of grabbing it', async () => {
        // Reproduces the X-Men: Outback #1 -> "X-Men 031" mis-grab. GetComics finds nothing; Prowlarr (fed a
        // broad query) returns a different series/issue. The relevance guard, anchored to the request, must
        // discard it and stall rather than download.
        mocks.findUniqueRequest.mockResolvedValue({ id: 'req_1', activeDownloadName: 'X-Men: Outback #1', user: { username: 'Bruce' } });
        vi.mocked(GetComicsService.search).mockResolvedValueOnce([]);
        vi.mocked(ProwlarrService.searchComics).mockResolvedValue([
            { title: 'X-Men 031 (2026) (Digital) (Kileko-Empire) (cbz)', downloadUrl: 'magnet:?xt=wrong', seeders: 50, protocol: 'torrent' } as any
        ]);

        await executeSearchAndDownload('req_1', 'X-Men: Outback #1', '2026', 'Marvel');

        expect(DownloadService.addDownload).not.toHaveBeenCalled();
        expect(mocks.updateRequest).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ status: 'STALLED' })
        }));
    });

    it('anchors series matching on the canonical metadata name, even when activeDownloadName is polluted', async () => {
        // Hardening for ":"/"-" series names + retry pollution: a prior wrong grab left activeDownloadName =
        // "X-Men 031 …", but the request is for the "X-Men: Outback" volume. The guard must judge against the
        // canonical series name (requires "outback"), not the polluted activeDownloadName, and reject the
        // re-offered wrong issue rather than "confirming" it.
        mocks.findUniqueRequest.mockResolvedValue({
            id: 'req_1', volumeId: 'cv_173293', metadataSource: 'COMICVINE',
            activeDownloadName: 'X-Men 031 (2026) (Digital) (Kileko-Empire) (cbz)', user: { username: 'Bruce' }
        });
        mocks.findFirstSeries.mockResolvedValue({ id: 'series_1', name: 'X-Men: Outback' });

        vi.mocked(GetComicsService.search).mockResolvedValueOnce([]);
        vi.mocked(ProwlarrService.searchComics).mockResolvedValue([
            { title: 'X-Men 031 (2026) (Digital) (Kileko-Empire) (cbz)', downloadUrl: 'magnet:?xt=wrong', seeders: 50, protocol: 'torrent' } as any
        ]);

        await executeSearchAndDownload('req_1', 'X-Men: Outback #1', '2026', 'Marvel');

        expect(DownloadService.addDownload).not.toHaveBeenCalled();
        expect(mocks.updateRequest).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ status: 'STALLED' })
        }));
    });

    it('should completely skip GetComics and go straight to Prowlarr if all file hosters are disabled', async () => {
        // Simulate an admin disabling all file hosters by returning an empty array
        mocks.findUniqueSetting.mockResolvedValueOnce({ value: JSON.stringify([]) });
        
        vi.mocked(ProwlarrService.searchComics).mockResolvedValueOnce([
            { title: 'Batman #01 (2024)', downloadUrl: 'magnet:?xt=123', seeders: 50, protocol: 'torrent', score: 100 } as any
        ]);

        await executeSearchAndDownload('req_1', 'Batman', '2024', 'DC');

        // Assert GetComics was completely bypassed
        expect(GetComicsService.search).not.toHaveBeenCalled();
        expect(DownloadService.addDownload).toHaveBeenCalled();
    });

    it('should fallback to Prowlarr if GetComics has no results', async () => {
        // 1. GetComics returns nothing
        vi.mocked(GetComicsService.search).mockResolvedValueOnce([]);
        
        // 2. Prowlarr returns a healthy torrent
        vi.mocked(ProwlarrService.searchComics).mockResolvedValueOnce([
            { title: 'Batman #01 (2024)', downloadUrl: 'magnet:?xt=123', seeders: 50, protocol: 'torrent', score: 100 } as any
        ]);

        await executeSearchAndDownload('req_1', 'Batman', '2024', 'DC');

        // Assert it handed the torrent magnet link to the standard client adder
        expect(DownloadService.addDownload).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'client_1' }),
            'magnet:?xt=123',
            'Batman #01 (2024)',
            0,
            0
        );
    });

    it('should stall the request and send a failure notification if the file is found nowhere', async () => {
        // Neither search engine finds anything
        vi.mocked(GetComicsService.search).mockResolvedValueOnce([]);
        vi.mocked(ProwlarrService.searchComics).mockResolvedValueOnce([]);

        await executeSearchAndDownload('req_1', 'Batman', '2024', 'DC');

        // Assert the database was updated to STALLED
        expect(mocks.updateRequest).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'req_1' },
            data: expect.objectContaining({ status: 'STALLED' })
        }));

        // Assert the user gets a notification telling them it couldn't be found
        expect(SystemNotifier.sendAlert).toHaveBeenCalledWith('download_failed', expect.objectContaining({
            title: 'Batman'
        }));
    });
});