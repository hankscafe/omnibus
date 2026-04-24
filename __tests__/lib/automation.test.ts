import { describe, it, expect, vi, beforeEach } from 'vitest';
import { searchAndDownload } from '@/lib/automation';
import { GetComicsService } from '@/lib/getcomics';
import { ProwlarrService } from '@/lib/prowlarr';
import { DownloadService } from '@/lib/download-clients';
import { SystemNotifier } from '@/lib/notifications';

// 1. Hoist the mocks
const mocks = vi.hoisted(() => ({
    findManyClients: vi.fn(),
    findManySettings: vi.fn(),
    updateRequest: vi.fn(),
    findUniqueRequest: vi.fn(),
    log: vi.fn()
}));

// 2. Mock Dependencies
vi.mock('@/lib/db', () => ({
    prisma: {
        downloadClient: { findMany: mocks.findManyClients },
        systemSetting: { findMany: mocks.findManySettings },
        request: { update: mocks.updateRequest, findUnique: mocks.findUniqueRequest }
    }
}));

vi.mock('@/lib/getcomics', () => ({ GetComicsService: { search: vi.fn(), scrapeDeepLink: vi.fn() } }));
vi.mock('@/lib/prowlarr', () => ({ ProwlarrService: { searchComics: vi.fn() } }));
vi.mock('@/lib/download-clients', () => ({ DownloadService: { addDownload: vi.fn(), downloadDirectFile: vi.fn().mockResolvedValue(true) } }));
vi.mock('@/lib/notifications', () => ({ SystemNotifier: { sendAlert: vi.fn().mockResolvedValue(true) } }));
vi.mock('@/lib/logger', () => ({ Logger: { log: mocks.log } }));
vi.mock('@/lib/search-engine', () => ({
    getCustomAcronyms: vi.fn().mockResolvedValue({}),
    generateSearchQueries: vi.fn().mockReturnValue(['Batman 2024'])
}));

describe('Core Logic: Automation Engine', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        
        // Default DB mocks
        mocks.findManyClients.mockResolvedValue([{ id: 'client_1', type: 'qbit' }]);
        mocks.findManySettings.mockResolvedValue([{ key: 'download_path', value: '/downloads' }]);
        mocks.findUniqueRequest.mockResolvedValue({ id: 'req_1', activeDownloadName: 'Batman 2024', user: { username: 'Bruce' } });
    });

    it('should successfully find a direct download on GetComics and send it to the client', async () => {
        // 1. Mock GetComics finding the file
        vi.mocked(GetComicsService.search).mockResolvedValueOnce([{ title: 'Batman #01 (2024)', downloadUrl: 'http://getcomics/123' } as any]);
        // 2. Mock the deep-link scraper finding a valid premium hoster
        vi.mocked(GetComicsService.scrapeDeepLink).mockResolvedValueOnce({ url: 'http://mediafire/file.cbz', isDirect: false, hoster: 'mediafire' });

        await searchAndDownload('req_1', 'Batman', '2024', 'DC');

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

    it('should fallback to Prowlarr if GetComics has no results', async () => {
        // 1. GetComics returns nothing
        vi.mocked(GetComicsService.search).mockResolvedValueOnce([]);
        
        // 2. Prowlarr returns a healthy torrent
        vi.mocked(ProwlarrService.searchComics).mockResolvedValueOnce([
            { title: 'Batman #01 (2024)', downloadUrl: 'magnet:?xt=123', seeders: 50, protocol: 'torrent', score: 100 } as any
        ]);

        await searchAndDownload('req_1', 'Batman', '2024', 'DC');

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

        await searchAndDownload('req_1', 'Batman', '2024', 'DC');

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