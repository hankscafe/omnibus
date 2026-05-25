// __tests__/lib/metadata-extractor.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseComicInfo } from '@/lib/metadata-extractor';

// 1. Hoist our variables so vi.mock can see them
const mocks = vi.hoisted(() => ({
    getEntries: vi.fn(),
    log: vi.fn()
}));

vi.mock('@/lib/logger', () => ({
    Logger: { log: mocks.log }
}));

// 2. Use a native ES6 class to perfectly mock 'new AdmZip()'
vi.mock('adm-zip', () => {
    return {
        default: class AdmZipMock {
            // When the code calls zip.getEntries(), it will hit our mock function
            getEntries() {
                return mocks.getEntries();
            }
        }
    };
});

describe('Core Logic: ComicInfo.xml Extractor', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should return null if the file is not a valid archive extension', async () => {
        const result = await parseComicInfo('/library/comic.pdf');
        expect(result).toBeNull();
    });

    it('should return null if ComicInfo.xml is missing from the archive', async () => {
        mocks.getEntries.mockReturnValue([
            { entryName: 'page_01.jpg' },
            { entryName: 'page_02.jpg' }
        ]);

        const result = await parseComicInfo('/library/comic.cbz');
        expect(result).toBeNull();
    });

    it('should perfectly parse standard ComicInfo.xml data with ComicVine IDs', async () => {
        const fakeXml = `
            <?xml version="1.0"?>
            <ComicInfo>
                <Series>Batman</Series>
                <Number>12</Number>
                <Year>2016</Year>
                <Publisher>DC Comics</Publisher>
                <Writer>Tom King</Writer>
                <Manga>No</Manga>
                <ComicVineVolumeId>12345</ComicVineVolumeId>
            </ComicInfo>
        `;

        mocks.getEntries.mockReturnValue([
            { entryName: 'ComicInfo.xml', getData: () => Buffer.from(fakeXml, 'utf8') }
        ]);

        const result = await parseComicInfo('/library/comic.cbz');
        
        expect(result).not.toBeNull();
        expect(result?.series).toBe('Batman');
        expect(result?.number).toBe('12');
        expect(result?.publisher).toBe('DC Comics');
        expect(result?.year).toBe(2016);
        expect(result?.writers).toEqual(['Tom King']);
        expect(result?.isManga).toBe(false);
        expect(result?.metadataId).toBe(12345);
        expect(result?.metadataSource).toBe('COMICVINE');
    });

    it('should perfectly parse custom ComicInfo.xml data with Metron IDs', async () => {
        const fakeXml = `
            <?xml version="1.0"?>
            <ComicInfo>
                <Series>Venom</Series>
                <MetronId>987</MetronId>
                <MetronIssueId>654</MetronIssueId>
            </ComicInfo>
        `;

        mocks.getEntries.mockReturnValue([
            { entryName: 'ComicInfo.xml', getData: () => Buffer.from(fakeXml, 'utf8') }
        ]);

        const result = await parseComicInfo('/library/comic.cbz');
        
        expect(result).not.toBeNull();
        expect(result?.series).toBe('Venom');
        expect(result?.metronId).toBe(987);
        expect(result?.metadataId).toBe(987);
        expect(result?.metadataIssueId).toBe(654);
        expect(result?.metadataSource).toBe('METRON'); // Verifies Source flag is mapped correctly
    });

    it('should fallback to parsing the <Web> URL tag if <ComicVineVolumeId> is missing', async () => {
        const fakeXml = `
            <?xml version="1.0"?>
            <ComicInfo>
                <Series>Invincible</Series>
                <Web>https://comicvine.gamespot.com/invincible/4050-98765/</Web>
            </ComicInfo>
        `;

        mocks.getEntries.mockReturnValue([
            { entryName: 'ComicInfo.xml', getData: () => Buffer.from(fakeXml, 'utf8') }
        ]);

        const result = await parseComicInfo('/library/comic.cbz');
        
        expect(result?.cvId).toBe(98765);
        expect(result?.metadataId).toBe(98765);
        expect(result?.metadataSource).toBe('COMICVINE');
    });

    it('should fallback to parsing the <Web> URL tag for Metron Links', async () => {
        const fakeXml = `
            <?xml version="1.0"?>
            <ComicInfo>
                <Series>Spider-Man</Series>
                <Web>https://metron.cloud/series/10101/</Web>
            </ComicInfo>
        `;

        mocks.getEntries.mockReturnValue([
            { entryName: 'ComicInfo.xml', getData: () => Buffer.from(fakeXml, 'utf8') }
        ]);

        const result = await parseComicInfo('/library/comic.cbz');
        
        expect(result?.metronId).toBe(10101);
        expect(result?.metadataId).toBe(10101);
        expect(result?.metadataSource).toBe('METRON');
    });
});