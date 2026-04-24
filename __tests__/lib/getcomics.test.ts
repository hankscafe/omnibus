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
        // Simulate FlareSolverr being configured in the database
        mocks.findUniqueSetting.mockResolvedValueOnce({ value: 'http://flaresolverr:8191' });
        
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
        mocks.findUniqueSetting.mockResolvedValueOnce(null);

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