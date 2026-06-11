// __tests__/lib/metadata-writer.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeComicInfo, writeSeriesJson } from '@/lib/metadata-writer';
import fs from 'fs-extra';

// 1. Hoist the mocks
const mocks = vi.hoisted(() => ({
    findUniqueIssue: vi.fn(),
    findUniqueSeries: vi.fn(),
    updateSeries: vi.fn(),
    findUniqueSetting: vi.fn(),
    addFile: vi.fn(),
    writeZip: vi.fn(),
    move: vi.fn(),
    readFile: vi.fn()
}));

// 2. Mock dependencies
vi.mock('@/lib/db', () => ({
    prisma: {
        issue: { findUnique: mocks.findUniqueIssue },
        series: { findUnique: mocks.findUniqueSeries, update: mocks.updateSeries },
        systemSetting: { findUnique: mocks.findUniqueSetting }
    }
}));

vi.mock('fs-extra', () => ({
    default: {
        existsSync: vi.fn().mockReturnValue(true),
        move: mocks.move,
        writeFile: vi.fn().mockResolvedValue(true),
        readFile: mocks.readFile
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

    it('should generate a Mylar v1.0.2 series.json for an ended ComicVine series', async () => {
        // Make sure the feature is "enabled" in the DB
        mocks.findUniqueSetting.mockResolvedValueOnce({ value: 'true' });

        mocks.findUniqueSeries.mockResolvedValueOnce({
            id: 'series_1',
            name: 'Wildcats',
            publisher: 'DC Comics',
            year: 1999,
            status: 'Ended',
            isManga: false,
            folderPath: '/library/comics/wildcats',
            cvId: null,
            metadataId: '9418',
            metadataSource: 'COMICVINE',
            description: '<p>Six months after Grifter left the <em>Wildcats</em>.</p>',
            coverUrl: '/api/library/cover?path=%2Fcomics%2Fwildcats%2Fcover.jpg',
            remoteCoverUrl: 'https://comicvine.gamespot.com/a/uploads/scale_large/wildcats.jpg',
            bookType: null,
            seriesJsonWritten: true,
            issues: [
                { releaseDate: '1999-03-01' },
                { releaseDate: '2001-12-15' },
                { releaseDate: '2000-06-10' }
            ]
        });

        const fsWriteSpy = vi.spyOn(fs, 'writeFile');

        const success = await writeSeriesJson('series_1');
        expect(success).toBe(true);

        expect(fsWriteSpy).toHaveBeenCalledTimes(1);
        const jsonPayload = JSON.parse(fsWriteSpy.mock.calls[0][1] as string);

        expect(jsonPayload.version).toBe('1.0.2');
        expect(jsonPayload.metadata.type).toBe('comicSeries');
        expect(jsonPayload.metadata.name).toBe('Wildcats');
        expect(jsonPayload.metadata.publisher).toBe('DC Comics');
        expect(jsonPayload.metadata.comicid).toBe(9418);
        expect(jsonPayload.metadata.year).toBe(1999);
        expect(jsonPayload.metadata.description_text).toBe('Six months after Grifter left the Wildcats.');
        expect(jsonPayload.metadata.booktype).toBe('Print'); // null bookType defaults to Print
        // The REMOTE ComicVine URL, never the Omnibus-local cached cover path
        expect(jsonPayload.metadata.comic_image).toBe('https://comicvine.gamespot.com/a/uploads/scale_large/wildcats.jpg');
        expect(jsonPayload.metadata.total_issues).toBe(3);
        expect(jsonPayload.metadata.publication_run).toBe('March 1999 - December 2001');
        expect(jsonPayload.metadata.status).toBe('Ended');
    });

    it('should write a null comicid and Present run for an ongoing Metron series', async () => {
        process.env.NEXTAUTH_URL = 'https://omnibus.example.com';
        mocks.findUniqueSetting.mockResolvedValueOnce({ value: 'true' });

        mocks.findUniqueSeries.mockResolvedValueOnce({
            id: 'series_2',
            name: 'Chainsaw Man',
            publisher: 'Shueisha',
            year: 2020,
            status: 'Ongoing',
            isManga: true,
            folderPath: '/library/manga/chainsaw',
            cvId: null,
            metadataId: '101',
            metadataSource: 'METRON',
            description: null,
            coverUrl: '/api/library/cover?path=%2Fmanga%2Fchainsaw%2Fcover.jpg',
            remoteCoverUrl: null,
            bookType: 'TPB',
            seriesJsonWritten: true,
            issues: [
                { releaseDate: '2020-09-29' },
                { releaseDate: null }
            ]
        });

        const fsWriteSpy = vi.spyOn(fs, 'writeFile');

        const success = await writeSeriesJson('series_2');
        expect(success).toBe(true);

        const jsonPayload = JSON.parse(fsWriteSpy.mock.calls[0][1] as string);

        // A Metron series ID must never be written as the ComicVine comicid
        expect(jsonPayload.metadata.comicid).toBeNull();
        expect(jsonPayload.metadata.status).toBe('Continuing');
        expect(jsonPayload.metadata.publication_run).toBe('September 2020 - Present');
        expect(jsonPayload.metadata.total_issues).toBe(2);
        expect(jsonPayload.metadata.booktype).toBe('TPB'); // categorized series carry their real booktype

        // Unknown values must be null, never "" — Komga ignores nulls but chokes on blanks.
        expect(jsonPayload.metadata.description_text).toBeNull();
        expect(jsonPayload.metadata.description_formatted).toBeNull();
        const blanks = Object.entries(jsonPayload.metadata).filter(([, v]) => v === '');
        expect(blanks).toEqual([]);

        // No remote cover known — falls back to the locally cached cover as an absolute URL
        expect(jsonPayload.metadata.comic_image).toBe('https://omnibus.example.com/api/library/cover?path=%2Fmanga%2Fchainsaw%2Fcover.jpg');
    });

    it('should never overwrite a series.json that Omnibus did not create', async () => {
        mocks.findUniqueSetting.mockResolvedValueOnce({ value: 'true' });

        mocks.findUniqueSeries.mockResolvedValueOnce({
            id: 'series_3',
            name: 'Curated Series',
            publisher: 'DC Comics',
            year: 1999,
            status: 'Ended',
            isManga: false,
            folderPath: '/library/comics/curated',
            seriesJsonWritten: false, // Omnibus has never written this folder's series.json
            issues: []
        });
        // The existing file is a genuine Mylar-generated file (has a version key)
        mocks.readFile.mockResolvedValueOnce(JSON.stringify({
            version: '1.0.2',
            metadata: { type: 'comicSeries', name: 'Curated Series', comicid: 9418 }
        }));

        const fsWriteSpy = vi.spyOn(fs, 'writeFile');

        const success = await writeSeriesJson('series_3');

        expect(success).toBe(false);
        expect(fsWriteSpy).not.toHaveBeenCalled();
        expect(mocks.updateSeries).not.toHaveBeenCalled();
    });

    it('should upgrade a legacy Omnibus (Komga-style) series.json and claim ownership', async () => {
        mocks.findUniqueSetting.mockResolvedValueOnce({ value: 'true' });

        mocks.findUniqueSeries.mockResolvedValueOnce({
            id: 'series_4',
            name: 'Old Export',
            publisher: 'Marvel',
            year: 2010,
            status: 'Ended',
            isManga: false,
            folderPath: '/library/comics/old-export',
            cvId: 555,
            metadataSource: 'COMICVINE',
            seriesJsonWritten: false, // Written before ownership tracking existed
            issues: [{ releaseDate: '2010-01-01' }]
        });
        // The old Omnibus Komga-style format: no version key, Komga-only fields
        mocks.readFile.mockResolvedValueOnce(JSON.stringify({
            metadata: { title: 'Old Export', readingDirection: 'LEFT_TO_RIGHT', status: 'ENDED' }
        }));

        const fsWriteSpy = vi.spyOn(fs, 'writeFile');

        const success = await writeSeriesJson('series_4');

        expect(success).toBe(true);
        const jsonPayload = JSON.parse(fsWriteSpy.mock.calls[0][1] as string);
        expect(jsonPayload.version).toBe('1.0.2');
        // Ownership is claimed so future runs keep updating the file
        expect(mocks.updateSeries).toHaveBeenCalledWith(expect.objectContaining({
            data: { seriesJsonWritten: true }
        }));
    });
});