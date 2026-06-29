import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeSearchAndDownload } from '@/lib/automation';
import { GetComicsService } from '@/lib/getcomics';
import { ProwlarrService } from '@/lib/prowlarr';
import { DownloadService } from '@/lib/download-clients';
import { SystemNotifier } from '@/lib/notifications';
import { generateSearchQueries } from '@/lib/search-engine';

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

    it('auto-downloads a working getcomics_main /dls/ link instead of dumping it to indexers', async () => {
        // getcomics.org/dls/ "main server" links serve the file directly for most issues (the in-browser
        // "Download Now" button works immediately). Many posts now expose ONLY this link, so it must be
        // ATTEMPTED — soft-fail — rather than blanket-held for manual. A working link downloads and imports.
        vi.mocked(GetComicsService.search).mockResolvedValueOnce([{ title: 'Wolverine #3 (2024)', downloadUrl: 'http://getcomics/123' } as any]);
        vi.mocked(GetComicsService.scrapeDeepLink).mockResolvedValueOnce({ url: 'https://getcomics.org/dls/abc', isDirect: true, hoster: 'getcomics_main' });
        vi.mocked(DownloadService.downloadDirectFile).mockResolvedValue(true); // /dls/ streams fine

        await executeSearchAndDownload('req_1', 'Wolverine', '2024', 'Marvel');

        expect(DownloadService.downloadDirectFile).toHaveBeenCalledWith(
            'https://getcomics.org/dls/abc', expect.anything(), expect.anything(), 'req_1', 'getcomics_main',
            expect.objectContaining({ softFail: true })
        );
        // It downloaded directly — it must NOT have fallen through to the indexers or a manual hold.
        expect(ProwlarrService.searchComics).not.toHaveBeenCalled();
        expect(DownloadService.addDownload).not.toHaveBeenCalled();
        expect(mocks.updateRequest).not.toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ status: 'MANUAL_DDL' })
        }));
    });

    it('falls a genuinely Cloudflare-gated getcomics_main link to MANUAL_DDL when the /dls/ fetch fails', async () => {
        // The subset of /dls/ links behind a LIVE Cloudflare challenge fail the soft-fail download. Those are
        // held as a one-click manual link, Prowlarr gets a shot, and they end as MANUAL_DDL when indexers are empty.
        vi.mocked(GetComicsService.search).mockResolvedValueOnce([{ title: 'Wolverine #3 (2024)', downloadUrl: 'http://getcomics/123' } as any]);
        vi.mocked(GetComicsService.scrapeDeepLink).mockResolvedValueOnce({ url: 'https://getcomics.org/dls/abc', isDirect: true, hoster: 'getcomics_main' });
        vi.mocked(DownloadService.downloadDirectFile).mockResolvedValue(false); // soft-fail: CF challenge
        vi.mocked(ProwlarrService.searchComics).mockResolvedValue([]); // indexers empty → revert to the held manual link

        await executeSearchAndDownload('req_1', 'Wolverine', '2024', 'Marvel');

        expect(DownloadService.downloadDirectFile).toHaveBeenCalled();
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

    it('rejects a same-name-different-subtitle indexer release whose distinguishing word is a stop-word', async () => {
        // Reproduces the Wolverine #3 -> "Wolverine - Blood Hunt 003" mis-grab. GetComics finds the correct
        // page but only on a CF-gated getcomics_main link whose /dls/ fetch soft-fails (held for manual);
        // Prowlarr then offers a DIFFERENT series ("Blood Hunt") that merely contains "Wolverine" + issue 3.
        // Because "blood" is a STOP_WORD, Prowlarr's ratio gate sees only 2 extra tokens and lets it through,
        // and the forward-only presence check can't tell the series apart. The reverse guard ("hunt" is an
        // extra series word the canonical name lacks) must discard it, leaving the held link as MANUAL_DDL.
        mocks.findUniqueRequest.mockResolvedValue({ id: 'req_1', activeDownloadName: 'Wolverine #3', user: { username: 'Logan' } });
        vi.mocked(GetComicsService.search).mockResolvedValueOnce([{ title: 'Wolverine #3 (2024)', downloadUrl: 'http://getcomics/123' } as any]);
        vi.mocked(GetComicsService.scrapeDeepLink).mockResolvedValueOnce({ url: 'https://getcomics.org/dls/abc', isDirect: true, hoster: 'getcomics_main' });
        vi.mocked(DownloadService.downloadDirectFile).mockResolvedValue(false); // soft-fail: CF challenge → fall to Prowlarr
        vi.mocked(ProwlarrService.searchComics).mockResolvedValue([
            { title: 'Wolverine - Blood Hunt 003 (2024) (digital) (Marika-Empire) (cbz)', downloadUrl: 'magnet:?xt=wrong', seeders: 50, protocol: 'torrent' } as any
        ]);

        await executeSearchAndDownload('req_1', 'Wolverine #3', '2024', 'Marvel');

        expect(DownloadService.addDownload).not.toHaveBeenCalled();
        expect(mocks.updateRequest).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ status: 'MANUAL_DDL', downloadLink: 'https://getcomics.org/dls/abc' })
        }));
    });

    it('still accepts the correct same-series release for a single-issue request', async () => {
        // Guardrail for the reverse check: the legitimate main-series release must NOT be rejected. Its core
        // title is exactly the canonical name, so there are no extra series words and it downloads normally.
        mocks.findUniqueRequest.mockResolvedValue({ id: 'req_1', activeDownloadName: 'Wolverine #3', user: { username: 'Logan' } });
        vi.mocked(GetComicsService.search).mockResolvedValueOnce([]);
        vi.mocked(ProwlarrService.searchComics).mockResolvedValue([
            { title: 'Wolverine 003 (2024) (Digital) (Kileko-Empire) (cbz)', downloadUrl: 'magnet:?xt=right', seeders: 50, protocol: 'torrent' } as any
        ]);

        await executeSearchAndDownload('req_1', 'Wolverine #3', '2024', 'Marvel');

        expect(DownloadService.addDownload).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'client_1' }),
            'magnet:?xt=right',
            expect.anything(), expect.anything(), expect.anything(), expect.anything()
        );
    });

    it('searches under the accurate per-issue release year, not the series year (long-running N+1)', async () => {
        // A long-running series started in 2024 but issue #22 shipped in 2026. The engine overrides the series
        // year with the issue's release year — and that override must reach BOTH the generated query string
        // AND the year filter, or GetComics/Prowlarr search "...2024" and never find the 2026 post. (The query
        // builder strips the '#', so the filter's old pack-detection also misfired and forced the series year.)
        mocks.findUniqueRequest.mockResolvedValue({
            id: 'req_1', volumeId: 'cv_123', metadataSource: 'COMICVINE',
            activeDownloadName: 'Wolverine #22', user: { username: 'Logan' }
        });
        mocks.findFirstSeries.mockResolvedValue({ id: 'series_1', name: 'Wolverine' });
        mocks.countIssues.mockResolvedValue(0);
        mocks.findManyIssues.mockResolvedValue([{ number: '22', releaseDate: '2026-03-01' }]);
        vi.mocked(generateSearchQueries).mockReturnValueOnce(['Wolverine 22 2026']);
        vi.mocked(GetComicsService.search).mockResolvedValue([]);
        vi.mocked(ProwlarrService.searchComics).mockResolvedValue([]);

        await executeSearchAndDownload('req_1', 'Wolverine #22', '2024', 'Marvel');

        // The accurate issue year (2026) is what we build queries from...
        expect(generateSearchQueries).toHaveBeenCalledWith('Wolverine #22', '2026', expect.anything(), false, expect.anything(), expect.anything());
        // ...and what the issue-targeted search filters on (5th arg to GetComics, 4th to Prowlarr) — NOT 2024.
        expect(GetComicsService.search).toHaveBeenCalledWith('Wolverine 22 2026', false, false, 'Wolverine #22', '2026', expect.anything());
        expect(ProwlarrService.searchComics).toHaveBeenCalledWith('Wolverine 22 2026', false, false, '2026', expect.anything());
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
            0,
            false
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

    it('parks an unreleased issue as UNRELEASED (not STALLED) so the monitor retries it once it drops', async () => {
        // A monitored series requests an issue whose release date is in the future. GetComics + Prowlarr
        // find nothing (it isn't out yet). Instead of STALLING it as a failure that never retries, it must
        // be parked UNRELEASED so the Series Monitor's UNRELEASED→PENDING refire grabs it once it releases.
        mocks.findUniqueRequest.mockResolvedValue({
            id: 'req_1', volumeId: 'cv_999', metadataSource: 'COMICVINE',
            activeDownloadName: 'Spawn #999', user: { username: 'Bruce' }
        });
        mocks.findFirstSeries.mockResolvedValue({ id: 'series_1', name: 'Spawn' });
        mocks.findManyIssues.mockResolvedValue([{ number: '999', releaseDate: '2099-12-31' }]);

        vi.mocked(GetComicsService.search).mockResolvedValueOnce([]);
        vi.mocked(ProwlarrService.searchComics).mockResolvedValueOnce([]);

        await executeSearchAndDownload('req_1', 'Spawn #999', '2099', 'Image');

        expect(mocks.updateRequest).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'req_1' },
            data: expect.objectContaining({ status: 'UNRELEASED' })
        }));
        // It must NOT be stalled, and must NOT alert the user as a failure.
        expect(mocks.updateRequest).not.toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ status: 'STALLED' })
        }));
        expect(SystemNotifier.sendAlert).not.toHaveBeenCalled();
    });
});