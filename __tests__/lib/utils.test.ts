import { describe, it, expect } from 'vitest';
import { parseComicVineCredits } from '../../src/lib/utils';

describe('Utility: ComicVine Credit Parser', () => {
    it('should parse and categorize a standard list of creators', () => {
        // FIX: Cast as 'any' to bypass missing API fields (like api_detail_url)
        const rawCredits = [
            { name: 'Stan Lee', role: 'writer' },
            { name: 'Jack Kirby', role: 'artist, penciler' }
        ] as any;
        
        const result = parseComicVineCredits(rawCredits);
        
        // FIX: Test against the actual object shape TypeScript revealed!
        expect(result.writers).toContain('Stan Lee');
        expect(result.artists).toContain('Jack Kirby');
    });

    it('should deduplicate creators within the same category', () => {
        const rawArrayWithDupes = [
            { name: 'Stan Lee', role: 'writer' },
            { name: 'Stan Lee', role: 'writer' } 
        ] as any;
        
        const result = parseComicVineCredits(rawArrayWithDupes);
        
        expect(result.writers).toHaveLength(1);
        expect(result.writers).toContain('Stan Lee');
    });

    it('should categorize the same creator into multiple roles if applicable', () => {
        const rawCredits = [
            { name: 'Todd McFarlane', role: 'writer' },
            { name: 'Todd McFarlane', role: 'artist' }
        ] as any;
        
        const result = parseComicVineCredits(rawCredits);
        
        expect(result.writers).toContain('Todd McFarlane');
        expect(result.artists).toContain('Todd McFarlane');
    });
});