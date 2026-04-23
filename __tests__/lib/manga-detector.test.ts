import { describe, it, expect, vi, beforeEach } from 'vitest';
// FIX: Using detectManga (or your actual function name)
import { detectManga } from '../../src/lib/manga-detector';

const fetchMock = vi.fn();
global.fetch = fetchMock;

describe('Logic: Manga Detector', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should return true immediately if the publisher is explicitly a Manga publisher', async () => {
        // FIX: Match the standard ComicVine nested object shape
        const metadata = { publisher: { name: 'VIZ Media LLC' }, concepts: [] } as any;
        
        const result = await detectManga(metadata);
        
        expect(result).toBe(true);
        expect(fetchMock).not.toHaveBeenCalled(); 
    });

    it('should return true if the publisher is generic, but ComicVine tags it with a Manga concept', async () => {
        const metadata = { 
            publisher: 'Unknown', 
            concepts: [{ name: 'Superhero' }, { name: 'Manga' }] 
        };
        
        // FIX: Update the function call
        const result = await detectManga(metadata);
        
        expect(result).toBe(true);
        expect(fetchMock).not.toHaveBeenCalled(); 
    });

    it('should fallback to AniList API and return true if AniList confirms it', async () => {
        const metadata = { 
            name: 'Naruto', // This is what the function uses to search
            publisher: { name: 'Unknown Print' }, 
            year: 1999
        } as any;
        
        // We must provide the exact nested title object the GraphQL query expects
        const mockResponseData = { 
            data: { 
                Page: { 
                    media: [
                        { 
                            title: {
                                english: 'Naruto',
                                romaji: 'Naruto'
                            },
                            startDate: { year: 1999 },
                            format: 'MANGA' 
                        }
                    ] 
                } 
            } 
        };

        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => mockResponseData
        });

        const result = await detectManga(metadata);
        
        expect(result).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('should return false if publisher, concepts, and AniList all fail to detect Manga', async () => {
        const metadata = { publisher: 'DC Comics', concepts: [{ name: 'Superhero' }], title: 'Batman' };
        
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ data: { Media: { format: 'COMIC' } } })
        });

        // FIX: Update the function call
        const result = await detectManga(metadata);
        
        expect(result).toBe(false);
    });
});