import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProwlarrService } from '@/lib/prowlarr';
import axios from 'axios';

// 1. Hoist the mocks
const mocks = vi.hoisted(() => ({
    findManySettings: vi.fn(),
    findIndexers: vi.fn(),
    log: vi.fn()
}));

// 2. Mock Axios and Dependencies
vi.mock('axios');
vi.mock('@/lib/db', () => ({
    prisma: {
        systemSetting: { findMany: mocks.findManySettings },
        indexer: { findMany: mocks.findIndexers }
    }
}));
vi.mock('@/lib/logger', () => ({ Logger: { log: mocks.log } }));

describe('Search Engine: Prowlarr Smart Filter', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        
        // Mock a standard Prowlarr URL and API key in the DB
        mocks.findManySettings.mockResolvedValue([
            { key: 'prowlarr_url', value: 'http://prowlarr:9696' },
            { key: 'prowlarr_key', value: 'secret123' },
            { key: 'prowlarr_categories', value: '7030,8030' }
        ]);
        mocks.findIndexers.mockResolvedValue([]);
    });

    it('should filter out mismatched issue numbers', async () => {
        // Simulate Prowlarr returning issue #17, #18, and #118
        vi.mocked(axios.get).mockResolvedValueOnce({
            data: [
                { title: "Batman #017 (2016)", size: 100, seeders: 5, protocol: 'torrent' },
                { title: "Batman #018 (2016)", size: 100, seeders: 5, protocol: 'torrent' },
                { title: "Batman #118 (2016)", size: 100, seeders: 5, protocol: 'torrent' }
            ]
        } as any);

        // We are specifically looking for issue 18
        const results = await ProwlarrService.searchComics("Batman 018 2016");
        
        expect(results).toHaveLength(1);
        expect(results[0].title).toBe("Batman #018 (2016)");
    });

    it('should filter out TPBs and Omnibuses when looking for a single issue', async () => {
        vi.mocked(axios.get).mockResolvedValueOnce({
            data: [
                { title: "Batman Vol 1 TPB (2016)", size: 500, seeders: 5, protocol: 'torrent' },
                { title: "Batman #001 (2016)", size: 100, seeders: 5, protocol: 'torrent' },
                { title: "Batman The Absolute Omnibus (2016)", size: 1000, seeders: 5, protocol: 'torrent' }
            ]
        } as any);

        // We are specifically looking for issue #1
        const results = await ProwlarrService.searchComics("Batman 001 2016");
        
        expect(results).toHaveLength(1);
        expect(results[0].title).toBe("Batman #001 (2016)");
    });

    it('should strictly enforce the release year to prevent downloading reboots', async () => {
        vi.mocked(axios.get).mockResolvedValueOnce({
            data: [
                { title: "Amazing Spider-Man #001 (1963)", size: 100, seeders: 5, protocol: 'torrent' },
                { title: "Amazing Spider-Man #001 (1999)", size: 100, seeders: 5, protocol: 'torrent' },
                { title: "Amazing Spider-Man #001 (2014)", size: 100, seeders: 5, protocol: 'torrent' },
                { title: "Amazing Spider-Man #001 (2022)", size: 100, seeders: 5, protocol: 'torrent' }
            ]
        } as any);

        // We want the 2014 reboot!
        const results = await ProwlarrService.searchComics("Amazing Spider-Man 001 2014");
        
        expect(results).toHaveLength(1);
        expect(results[0].title).toBe("Amazing Spider-Man #001 (2014)");
    });
});