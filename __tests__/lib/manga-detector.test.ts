import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectManga } from '../../src/lib/manga-detector';

const fetchMock = vi.fn();
global.fetch = fetchMock;

// 1. Hoist the mock function
const mocks = vi.hoisted(() => ({
    findManySettings: vi.fn()
}));

// 2. Mock the Prisma database so it doesn't crash looking for a DATABASE_URL
vi.mock('@/lib/db', () => ({
    prisma: {
        systemSetting: { findMany: mocks.findManySettings }
    }
}));

describe('Logic: Manga Detector', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Return an empty array so the detector falls back to its default publisher lists
        mocks.findManySettings.mockResolvedValue([]);
    });

    it('should return true immediately if the publisher is explicitly a Manga publisher', async () => {
        const metadata = { publisher: { name: 'VIZ Media LLC' }, concepts: [] } as any;
        
        const result = await detectManga(metadata);
        
        expect(result).toBe(true);
        expect(fetchMock).not.toHaveBeenCalled(); 
    });

    it('should return true if the publisher is generic, but ComicVine tags it with a Manga concept', async () => {
        const metadata = { 
            publisher: { name: 'Unknown' }, 
            concepts: [{ name: 'Superhero' }, { name: 'Manga' }] 
        } as any;
        
        const result = await detectManga(metadata);
        
        expect(result).toBe(true);
        expect(fetchMock).not.toHaveBeenCalled(); 
    });

    it('should fallback to AniList API and return true if AniList confirms it', async () => {
        const metadata = { 
            name: 'Naruto', 
            publisher: { name: '' }, 
            year: 1999
        } as any;
        
        const mockResponseData = { 
            data: { 
                Page: { 
                    media: [
                        { 
                            title: { english: 'Naruto', romaji: 'Naruto' },
                            startDate: { year: 1999 },
                            format: 'MANGA' 
                        }
                    ] 
                } 
            } 
        };

        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => mockResponseData,
            text: async () => JSON.stringify(mockResponseData)
        });

        const result = await detectManga(metadata);
        
        expect(result).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('should return false if publisher, concepts, and AniList all fail to detect Manga', async () => {
        const metadata = { 
            name: 'Batman',
            publisher: { name: 'DC Comics' }, 
            concepts: [{ name: 'Superhero' }] 
        } as any;
        
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ data: { Page: { media: [] } } }),
            text: async () => JSON.stringify({ data: { Page: { media: [] } } })
        });

        const result = await detectManga(metadata);
        
        expect(result).toBe(false);
    });
});