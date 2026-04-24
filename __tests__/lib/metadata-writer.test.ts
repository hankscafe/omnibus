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

    it('should successfully generate and inject ComicInfo.xml into a CBZ file', async () => {
        // Mock the database returning a rich issue
        mocks.findUniqueIssue.mockResolvedValueOnce({
            id: 'issue_1',
            name: 'The Dark Knight Returns',
            number: '1',
            filePath: '/library/Batman/issue1.cbz',
            writers: JSON.stringify(['Frank Miller']),
            description: 'A great comic.',
            series: {
                name: 'Batman',
                publisher: 'DC Comics',
                year: 1986,
                isManga: false
            }
        });

        const success = await writeComicInfo('issue_1');
        
        expect(success).toBe(true);

        // Assert it attempted to write the file into the ZIP archive
        expect(mocks.addFile).toHaveBeenCalledTimes(1);
        
        // Grab the raw XML string it generated
        const xmlBuffer = mocks.addFile.mock.calls[0][1];
        const xmlString = xmlBuffer.toString('utf8');

        // Verify the XML payload was formatted perfectly
        expect(xmlString).toContain('<Series>Batman</Series>');
        expect(xmlString).toContain('<Title>The Dark Knight Returns</Title>');
        expect(xmlString).toContain('<Writer>Frank Miller</Writer>');
        expect(xmlString).toContain('<Manga>No</Manga>');
        
        // Verify it finished the ZIP repackaging process
        expect(mocks.writeZip).toHaveBeenCalled();
        expect(mocks.move).toHaveBeenCalled();
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
            issues: [
                { genres: JSON.stringify(['Action', 'Gore']) },
                { genres: JSON.stringify(['Action', 'Demon']) }
            ]
        });

        const fsWriteSpy = vi.spyOn(fs, 'writeFile');

        const success = await writeSeriesJson('series_1');
        expect(success).toBe(true);

        // Assert it wrote the file to the series folder
        expect(fsWriteSpy).toHaveBeenCalledTimes(1);
        
        // Check the JSON payload it generated
        const jsonPayload = JSON.parse(fsWriteSpy.mock.calls[0][1] as string);
        
        expect(jsonPayload.metadata.title).toBe('Chainsaw Man');
        expect(jsonPayload.metadata.readingDirection).toBe('RIGHT_TO_LEFT'); // Verified Manga flag works
        expect(jsonPayload.metadata.genres).toEqual(expect.arrayContaining(['Action', 'Gore', 'Demon'])); 
    });
});