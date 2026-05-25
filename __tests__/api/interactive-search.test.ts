// __tests__/api/interactive-search.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from '@/app/api/search/interactive/route';
import { ProwlarrService } from '@/lib/prowlarr';
import { GetComicsService } from '@/lib/getcomics';

// 1. Hoist the mocks
const mocks = vi.hoisted(() => ({
    findUniqueSetting: vi.fn(),
    log: vi.fn()
}));

// 2. Mock Dependencies
vi.mock('@/lib/db', () => ({
    prisma: { systemSetting: { findUnique: mocks.findUniqueSetting } }
}));
vi.mock('@/lib/logger', () => ({ Logger: { log: mocks.log } }));

// Mock the core search services
vi.mock('@/lib/prowlarr', () => ({
    ProwlarrService: { searchComics: vi.fn() }
}));
vi.mock('@/lib/getcomics', () => ({
    GetComicsService: { search: vi.fn() }
}));

const createReq = (query: string) => new Request(`http://localhost/api/search/interactive?q=${encodeURIComponent(query)}`);

describe('API Route: Interactive Search (/api/search/interactive)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        
        // Mock Prowlarr to always return 1 item
        vi.mocked(ProwlarrService.searchComics).mockResolvedValue([{ name: 'Batman (Prowlarr)', id: '1' }] as any);
        // Mock GetComics to always return 1 item
        vi.mocked(GetComicsService.search).mockResolvedValue([{ name: 'Batman (GetComics)', id: '2' }] as any);
    });

    it('should query both Prowlarr and GetComics if hosters are enabled in settings', async () => {
        // Mock hoster settings: One hoster is enabled
        mocks.findUniqueSetting.mockResolvedValueOnce({ 
            value: JSON.stringify([{ hoster: 'MediaFire', enabled: true }]) 
        });

        const res = await GET(createReq('Batman'));
        const data = await res.json();

        expect(res.status).toBe(200);
        expect(ProwlarrService.searchComics).toHaveBeenCalledWith('Batman', true, false);
        expect(GetComicsService.search).toHaveBeenCalledWith('Batman', true, false);

        expect(data.prowlarr).toHaveLength(1);
        expect(data.getcomics).toHaveLength(1);
    });

    it('should bypass GetComics completely if NO hosters are enabled', async () => {
        // Mock hoster settings: All hosters are disabled
        mocks.findUniqueSetting.mockResolvedValueOnce({ 
            value: JSON.stringify([{ hoster: 'MediaFire', enabled: false }]) 
        });

        const res = await GET(createReq('Batman'));
        const data = await res.json();

        expect(res.status).toBe(200);
        expect(ProwlarrService.searchComics).toHaveBeenCalledWith('Batman', true, false);
        
        // GetComics should NEVER be called
        expect(GetComicsService.search).not.toHaveBeenCalled();

        expect(data.prowlarr).toHaveLength(1);
        expect(data.getcomics).toHaveLength(0);
    });

    it('should return a 400 error if no query is provided', async () => {
        const req = new Request('http://localhost/api/search/interactive');
        const res = await GET(req);
        
        expect(res.status).toBe(400);
    });
});