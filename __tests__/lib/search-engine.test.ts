import { describe, it, expect } from 'vitest';
import { generateSearchQueries } from '@/lib/search-engine';

describe('Core Logic: Fuzzy Search Generator', () => {
    const customAcronyms = {
        'tmnt': 'teenage mutant ninja turtles',
        'asm': 'amazing spider-man'
    };

    it('should generate basic queries with and without the year', () => {
        const queries = generateSearchQueries('Batman', '2016', customAcronyms);
        expect(queries).toContain('Batman 2016');
        expect(queries).toContain('Batman');
    });

    it('should strip possessives correctly', () => {
        const queries = generateSearchQueries("Spider-Man's Adventure", '2022', customAcronyms);
        
        // It should convert "Spider-Man's" to "Spider Man Adventure"
        expect(queries).toContain('Spider Man Adventure 2022');
        expect(queries).toContain('Spider Man Adventure');
    });

    it('should replace ampersands and colons with dashes for alternate searches', () => {
        const queries = generateSearchQueries('Batman & Robin', '2011', customAcronyms);
        
        // FIX: The function intelligently collapses the spaces!
        expect(queries).toContain('Batman Robin 2011'); // standard alphanumeric clean
        expect(queries).toContain('Batman - Robin 2011'); // dashed alternative
    });

    it('should extract and search by subtitles (after the issue number)', () => {
        const queries = generateSearchQueries('Superman Unlimited #12: Besides Myself', '2015', customAcronyms);
        
        // It should isolate the subtitle and append the year
        expect(queries).toContain('Besides Myself 2015');
        
        // It should also isolate the main part AND securely preserve the issue number for the search
        expect(queries).toContain('Superman Unlimited 12 2015');
        expect(queries).toContain('Superman Unlimited 12');
    });

    it('should expand custom acronyms', () => {
        const queries = generateSearchQueries('TMNT', '2020', customAcronyms);
        
        // It should expand TMNT out fully
        expect(queries).toContain('teenage mutant ninja turtles 2020');
        expect(queries).toContain('teenage mutant ninja turtles');
    });
});