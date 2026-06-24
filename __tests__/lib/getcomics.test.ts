import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GetComicsService } from '@/lib/getcomics';
import axios from 'axios';

// 1. Hoist the mocks
const mocks = vi.hoisted(() => ({
    findUniqueSetting: vi.fn(),
    log: vi.fn()
}));

// 2. Mock Axios and Dependencies
vi.mock('axios');
vi.mock('@/lib/db', () => ({
    prisma: { systemSetting: { findUnique: mocks.findUniqueSetting } }
}));
vi.mock('@/lib/logger', () => ({ Logger: { log: mocks.log } }));

describe('Download Pipeline: GetComics Scraper', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should successfully bypass Cloudflare using FlareSolverr if a 403 occurs', async () => {
        // THE FIX: Provide specific responses based on which setting the parser is requesting
        mocks.findUniqueSetting.mockImplementation((args: any) => {
            if (args.where.key === 'flaresolverr_url') return Promise.resolve({ value: 'http://flaresolverr:8191' });
            if (args.where.key === 'allow_bulk_packs') return Promise.resolve({ value: 'false' });
            return Promise.resolve(null);
        });
        
        // First call throws 403 Forbidden (Cloudflare block)
        vi.mocked(axios.get).mockRejectedValueOnce({ response: { status: 403 } });
        
        // Second call is the FlareSolverr POST request returning the solved HTML
        vi.mocked(axios.post).mockResolvedValueOnce({
            data: { solution: { response: '<html><article><h1 class="post-title"><a href="http://link">Batman #001</a></h1></article></html>' } }
        } as any);

        // Run a search
        const results = await GetComicsService.performSearch('Batman 001', 'Batman 001', false, false);
        
        // Assert that FlareSolverr was triggered correctly
        expect(axios.post).toHaveBeenCalledWith(
            'http://flaresolverr:8191/v1',
            expect.objectContaining({ cmd: 'request.get' }),
            expect.any(Object)
        );
        expect(results).toHaveLength(1);
    });

    it('should reject TPB/Omnibus/Vol results when searching for a single issue', async () => {
        // Use a generic mock response for all other settings
        mocks.findUniqueSetting.mockResolvedValue(null);

        // Mock a successful HTML response with a TPB and a single issue
        const fakeHtml = `
            <html>
                <article><h1 class="post-title"><a href="http://link1">Batman Vol 1 TPB</a></h1></article>
                <article><h1 class="post-title"><a href="http://link2">Batman #001</a></h1></article>
                <article><h1 class="post-title"><a href="http://link3">Batman The Absolute Omnibus</a></h1></article>
            </html>
        `;
        vi.mocked(axios.get).mockResolvedValueOnce({ data: fakeHtml } as any);

        // Perform search looking specifically for issue 1
        const results = await GetComicsService.performSearch('Batman 001', 'Batman 001', false, false);

        // It should have aggressively ignored "Vol 1 TPB" and "Absolute Omnibus"
        expect(results).toHaveLength(1);
        expect(results[0].title).toBe('Batman #001');
    });
});

describe('Download Pipeline: GetComics Section-Targeting', () => {
    // A multi-pack article page (like the real "Crossed Collection") with one heading + button group
    // per archive. Vol. 1 (#0–9, 2008-2010) and Vol. 4 Badlands (#1–25, 2012-2013) both contain a "#1",
    // so the requested YEAR is what disambiguates them.
    const MULTI_PACK_HTML = `
        <div class="post-contents">
            <h3>Crossed Vol. 1 #0 – 9 (2008-2010)</h3>
            <div class="aio-button-center"><a class="aio-button" href="https://comicfiles.example/crossed-vol1.cbz">Download Now</a></div>
            <h3>Crossed Vol. 4 – Badlands #1 – 25 (2012-2013)</h3>
            <div class="aio-button-center"><a class="aio-button" href="https://comicfiles.example/crossed-badlands.cbz">Download Now</a></div>
        </div>
    `;

    beforeEach(() => {
        vi.clearAllMocks();
        // Default hoster prefs (getcomics_direct enabled) for every settings lookup.
        mocks.findUniqueSetting.mockResolvedValue(null);
    });

    it('targets the archive whose issue range AND year contain the requested issue (2008 -> Vol. 1)', async () => {
        vi.mocked(axios.get).mockResolvedValueOnce({ data: MULTI_PACK_HTML } as any);

        const result = await GetComicsService.scrapeDeepLink('https://getcomics.org/crossed-collection/', { issueNum: 1, year: '2008' });

        expect(result.url).toBe('https://comicfiles.example/crossed-vol1.cbz');
        expect(result.hoster).toBe('getcomics_direct');
        expect(result.ambiguous).toBeFalsy();
    });

    it('uses the year to pick the right same-numbered issue (2012 -> Badlands #1, not Vol. 1 #1)', async () => {
        vi.mocked(axios.get).mockResolvedValueOnce({ data: MULTI_PACK_HTML } as any);

        const result = await GetComicsService.scrapeDeepLink('https://getcomics.org/crossed-collection/', { issueNum: 1, year: '2012' });

        expect(result.url).toBe('https://comicfiles.example/crossed-badlands.cbz');
        expect(result.ambiguous).toBeFalsy();
    });

    it('flags the page as ambiguous when no archive contains the requested issue', async () => {
        vi.mocked(axios.get).mockResolvedValueOnce({ data: MULTI_PACK_HTML } as any);

        const result = await GetComicsService.scrapeDeepLink('https://getcomics.org/crossed-collection/', { issueNum: 99, year: '2008' });

        expect(result.ambiguous).toBe(true);
        expect(result.hoster).toBe('unknown');
    });

    it('keeps the original flat behavior when no target issue is supplied', async () => {
        vi.mocked(axios.get).mockResolvedValueOnce({ data: MULTI_PACK_HTML } as any);

        const result = await GetComicsService.scrapeDeepLink('https://getcomics.org/crossed-collection/');

        // No target -> no section targeting; returns the first valid link by hoster priority.
        expect(result.url).toBe('https://comicfiles.example/crossed-vol1.cbz');
        expect(result.ambiguous).toBeFalsy();
    });
});