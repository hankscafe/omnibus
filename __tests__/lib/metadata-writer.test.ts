// __tests__/lib/metadata-writer.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeComicInfo, writeSeriesJson } from '@/lib/metadata-writer';
import fs from 'fs-extra';

// 1. Hoist the mocks
const mocks = vi.hoisted(() => ({
    findUniqueIssue: vi.fn(),
    findUniqueSeries: vi.fn(),
    findUniqueSetting: vi.fn(),
    addFile: vi.fn(),
    writeZip: vi.fn(),
    move: vi.fn()
}));

// 2. Mock dependencies
vi.mock('@/lib/db', () => ({
    prisma: {
        issue: { findUnique: mocks.findUniqueIssue },
        series: { findUnique: mocks.findUniqueSeries },
        systemSetting: { findUnique: mocks.findUniqueSetting }
    }
}));

vi.mock('fs-extra', () => ({
    default: {
        existsSync: vi.fn().mockReturnValue(true),
        move: mocks.move,
        writeFile: vi.fn().mockResolvedValue(true)
    }
}));

// FIX: Use a proper ES6 class so new AdmZip() doesn't crash the function
vi.mock('adm-zip', () => {
    return {
        default: class AdmZipMock {
            getEntries() { return []; }
            addFile(name: string, content: Buffer) { return mocks.addFile(name, content); }
            writeZip(path: string) { return mocks.writeZip(path); }
            deleteFile() { return; }
        }
    };
});

vi.mock('@/lib/logger', () => ({ Logger: { log: vi.fn() } }));

describe('Ecosystem: Metadata Writer', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should successfully generate and inject ComicInfo.xml into a CBZ file with ComicVine metadata', async () => {
        // Mock the database returning a rich ComicVine issue
        mocks.findUniqueIssue.mockResolvedValueOnce({
            id: 'issue_1',
            name: 'The Dark Knight Returns',
            number: '1',
            filePath: '/library/Batman/issue1.cbz',
            writers: JSON.stringify(['Frank Miller']),
            description: 'A great comic.',
            metadataId: '999',
            metadataSource: 'COMICVINE',
            series: {
                name: 'Batman',
                publisher: 'DC Comics',
                year: 1986,
                isManga: false,
                metadataId: '123',
                metadataSource: 'COMICVINE'
            }
        });

        const success = await writeComicInfo('issue_1');
        expect(success).toBe(true);
        expect(mocks.addFile).toHaveBeenCalledTimes(1);
        
        const xmlBuffer = mocks.addFile.mock.calls[0][1];
        const xmlString = xmlBuffer.toString('utf8');

        // Verify CV XML payload
        expect(xmlString).toContain('<Series>Batman</Series>');
        expect(xmlString).toContain('<Writer>Frank Miller</Writer>');
        expect(xmlString).toContain('<ComicVineVolumeId>123</ComicVineVolumeId>');
        expect(xmlString).toContain('<ComicVineIssueId>999</ComicVineIssueId>');
        expect(xmlString).toContain('<Web>https://comicvine.gamespot.com/issue/4000-999/</Web>');
        
        expect(mocks.writeZip).toHaveBeenCalled();
        expect(mocks.move).toHaveBeenCalled();
    });

    it('should successfully generate and inject ComicInfo.xml with Metron metadata', async () => {
        // Mock the database returning a Metron issue
        mocks.findUniqueIssue.mockResolvedValueOnce({
            id: 'issue_2',
            name: 'Venom',
            number: '3',
            filePath: '/library/Venom/issue3.cbz',
            metadataId: '789',
            metadataSource: 'METRON',
            series: {
                name: 'Venom',
                publisher: 'Marvel',
                year: 2018,
                isManga: false,
                metadataId: '456',
                metadataSource: 'METRON'
            }
        });

        const success = await writeComicInfo('issue_2');
        expect(success).toBe(true);
        expect(mocks.addFile).toHaveBeenCalledTimes(1);
        
        const xmlBuffer = mocks.addFile.mock.calls[0][1];
        const xmlString = xmlBuffer.toString('utf8');

        // Verify Metron XML payload
        expect(xmlString).toContain('<Series>Venom</Series>');
        expect(xmlString).toContain('<MetronId>456</MetronId>');
        expect(xmlString).toContain('<MetronIssueId>789</MetronIssueId>');
        // ComicVine tags should be blank
        expect(xmlString).toContain('<ComicVineVolumeId></ComicVineVolumeId>');
        // Web tag should correctly point to Metron
        expect(xmlString).toContain('<Web>https://metron.cloud/issue/789/</Web>');
    });

    it('should successfully generate a Komga-compatible series.json file', async () => {
        // Make sure the feature is "enabled" in the DB
        mocks.findUniqueSetting.mockResolvedValueOnce({ value: 'true' });

        mocks.findUniqueSeries.mockResolvedValueOnce({
            id: 'series_1',
            name: 'Chainsaw Man',
            publisher: 'Shueisha',
            status: 'Ongoing',
            isManga: true,
            folderPath: '/library/manga/chainsaw',
            metadataId: '101',
            metadataSource: 'METRON',
            issues: [
                { genres: JSON.stringify(['Action', 'Gore']) },
                { genres: JSON.stringify(['Action', 'Demon']) }
            ]
        });

        const fsWriteSpy = vi.spyOn(fs, 'writeFile');

        const success = await writeSeriesJson('series_1');
        expect(success).toBe(true);

        expect(fsWriteSpy).toHaveBeenCalledTimes(1);
        const jsonPayload = JSON.parse(fsWriteSpy.mock.calls[0][1] as string);
        
        expect(jsonPayload.metadata.title).toBe('Chainsaw Man');
        expect(jsonPayload.metadata.readingDirection).toBe('RIGHT_TO_LEFT'); 
        expect(jsonPayload.metadata.genres).toEqual(expect.arrayContaining(['Action', 'Gore', 'Demon'])); 
        // Verify it routed the JSON link to Metron
        expect(jsonPayload.metadata.links[0].url).toBe('https://metron.cloud/series/101/');
    });
});