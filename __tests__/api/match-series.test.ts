// __tests__/api/match-series.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '@/app/api/library/match-series/route';
import fs from 'fs';
import axios from 'axios';
import { makePostJson } from '../helpers/request';

// 1. Hoist the mocks
const mocks = vi.hoisted(() => ({
    findManyLibraries: vi.fn(),
    findUniqueSetting: vi.fn(),
    findUniqueSeries: vi.fn(),
    findFirstSeries: vi.fn(),
    createSeries: vi.fn(),
    log: vi.fn(),
    getSeriesDetails: vi.fn(),
    findManySettings: vi.fn(),
    findManyRequests: vi.fn(),
    updateManyRequests: vi.fn(),
    findManyIssues: vi.fn(),
    updateManyIssues: vi.fn(),
    findFirstIssue: vi.fn(),
    createIssue: vi.fn(),
    updateIssue: vi.fn(),
    updateSeries: vi.fn(),
    deleteSeries: vi.fn(),
    transaction: vi.fn(),
    safeRelocateFolder: vi.fn(),
    moveFileSafe: vi.fn()
}));

// 2. Mock Server Dependencies

vi.mock('next-auth', () => ({
    getServerSession: vi.fn().mockResolvedValue({ user: { id: 'admin_1', role: 'ADMIN' } })
}));

vi.mock('next-auth/next', () => ({
    getServerSession: vi.fn().mockResolvedValue({ user: { id: 'admin_1', role: 'ADMIN' } })
}));



// 3. Mock Database & App Dependencies
vi.mock('@/lib/db', () => ({
    prisma: {
        library: { findMany: mocks.findManyLibraries },
        systemSetting: { findMany: mocks.findManySettings, findUnique: mocks.findUniqueSetting },
        series: { findUnique: mocks.findUniqueSeries, findFirst: mocks.findFirstSeries, create: mocks.createSeries, update: mocks.updateSeries, delete: mocks.deleteSeries },
        issue: { findMany: mocks.findManyIssues, updateMany: mocks.updateManyIssues, findFirst: mocks.findFirstIssue, create: mocks.createIssue, update: mocks.updateIssue },
        request: { findMany: mocks.findManyRequests, updateMany: mocks.updateManyRequests },
        $transaction: mocks.transaction
    }
}));

vi.mock('axios');
// The CV path fetches through the pooled apiClient (via cachedCvGet) — alias it to the same
// automocked axios.get so per-test mocks and call assertions serve both clients.
vi.mock('@/lib/api-client', async () => {
    const axios = (await import('axios')).default;
    return { apiClient: { get: axios.get } };
});

vi.mock('fs', () => ({
    default: {
        existsSync: vi.fn().mockReturnValue(true),
        mkdirSync: vi.fn(),
        promises: {
            stat: vi.fn().mockResolvedValue({ isFile: () => false }),
            readdir: vi.fn().mockResolvedValue([]),
            rename: vi.fn().mockResolvedValue(true),
            mkdir: vi.fn().mockResolvedValue(true),
            rmdir: vi.fn().mockResolvedValue(true),
            writeFile: vi.fn().mockResolvedValue(true)
        }
    }
}));



vi.mock('@/lib/manga-detector', () => ({ detectManga: vi.fn().mockResolvedValue(false) }));

vi.mock('@/lib/metadata/providers/metron', () => {
    return { MetronProvider: class { getSeriesDetails = mocks.getSeriesDetails } }
});

vi.mock('@/lib/queue', () => ({ omnibusQueue: { add: vi.fn() } }));

// Non-destructive folder relocator — mocked so we can assert the route surfaces its conflict count.
vi.mock('@/lib/utils/safe-fs', () => ({
    safeRelocateFolder: mocks.safeRelocateFolder,
    moveFileSafe: mocks.moveFileSafe,
    cleanupEmptyDirs: vi.fn(),
    ensureLibraryDir: vi.fn() // #199 UMASK-aware mkdir — a no-op here, the real thing is unit-tested in safe-fs.test.ts
}));

const createReq = makePostJson('http://localhost/api/library/match-series');

describe('API Route: Smart Matcher (/api/library/match-series)', () => {
    beforeEach(() => {
        // clearAllMocks resets call history but NOT implementations — restore the fs.existsSync default
        // so a per-test mockImplementation can't leak into later tests.
        vi.mocked(fs.existsSync).mockReturnValue(true);
        // Setup default path access
        process.env.OMNIBUS_AWAITING_MATCH_DIR = '/unmatched';
        mocks.findManyLibraries.mockResolvedValue([{ id: 'lib_1', path: '/comics', isDefault: true }]);
        mocks.findUniqueSeries.mockResolvedValue(null);
        mocks.findFirstSeries.mockResolvedValue(null);
        mocks.findManySettings.mockResolvedValue([]);
        mocks.findManyRequests.mockResolvedValue([]);
        mocks.findManyIssues.mockResolvedValue([]);
        mocks.findFirstIssue.mockResolvedValue(null);
        mocks.createIssue.mockResolvedValue({ id: 'issue_99' });
        mocks.updateIssue.mockResolvedValue({ id: 'issue_99' });
        mocks.createSeries.mockResolvedValue({ id: 'series_123', folderPath: '/comics/Batman' });
        mocks.updateSeries.mockResolvedValue({ id: 'series_123', folderPath: '/comics/Batman' });
        mocks.safeRelocateFolder.mockResolvedValue({ conflicts: 0 });
        mocks.moveFileSafe.mockResolvedValue(undefined);
    });

    it('should query ComicVine by default if metadataSource is not provided', async () => {
        mocks.findUniqueSetting.mockResolvedValueOnce({ value: 'cv_api_key' });
        vi.mocked(axios.get).mockResolvedValueOnce({ data: { results: { name: 'Batman (CV)', start_year: '2016' } } } as any);

        const res = await POST(createReq({ oldFolderPath: '/unmatched/Batman', metadataId: '4050-1234' }));
        expect(res.status).toBe(200);

        expect(axios.get).toHaveBeenCalledWith(
            expect.stringContaining('comicvine'),
            expect.objectContaining({ params: expect.objectContaining({ api_key: 'cv_api_key' }) })
        );
        expect(mocks.createSeries).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ metadataSource: 'COMICVINE', name: 'Batman (CV)', year: 2016 })
        }));
    });

    it('should route to Metron if metadataSource is explicitly passed as METRON', async () => {
        mocks.getSeriesDetails.mockResolvedValueOnce({ name: 'Batman (Metron)', year: 2020, publisher: 'DC Comics', coverUrl: 'http://metron.image' });
        vi.mocked(axios.get).mockResolvedValueOnce({ data: Buffer.from('fake_image_data') } as any); // Mock the image download

        const res = await POST(createReq({ oldFolderPath: '/unmatched/Batman', metadataId: '987', metadataSource: 'METRON' }));
        expect(res.status).toBe(200);

        expect(mocks.getSeriesDetails).toHaveBeenCalledWith('987');
        
        // Ensure CV was skipped (but allow the cover image download via axios)
        expect(axios.get).not.toHaveBeenCalledWith(
            expect.stringContaining('comicvine'),
            expect.any(Object)
        );
        
        expect(mocks.createSeries).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ metadataSource: 'METRON', name: 'Batman (Metron)', year: 2020 })
        }));
    });

    it('should reject access if the oldFolderPath is outside of authorized libraries', async () => {
        // Attack attempt: Trying to rename a system file
        const res = await POST(createReq({ oldFolderPath: '/etc/shadow', metadataId: '123' }));
        expect(res.status).toBe(403);
        const data = await res.json();
        expect(data.error).toBe('Unauthorized path access');
    });

    it('should substitute admin-supplied {SeriesGroup}/{UniverseName} into the folder and persist + lock them', async () => {
        mocks.findManySettings.mockResolvedValue([
            { key: 'folder_naming_pattern', value: '{SeriesGroup}/{Series} ({Year})' }
        ]);

        const res = await POST(createReq({
            oldFolderPath: '/unmatched/Batman',
            metadataId: '4050-1234',
            name: 'Batman',
            year: 2016,
            publisher: 'DC Comics',
            seriesGroup: 'Batman Family',
            universe: 'DC Universe',
            description: 'The Caped Crusader.',
            lockMetadata: true,
        }));
        expect(res.status).toBe(200);

        expect(mocks.createSeries).toHaveBeenCalledTimes(1);
        const data = mocks.createSeries.mock.calls[0][0].data;
        // The group becomes a real folder tier — no literal token left behind.
        expect(data.folderPath).toContain('Batman Family');
        expect(data.folderPath).toContain('Batman (2016)');
        expect(data.folderPath).not.toContain('{SeriesGroup}');
        // ...and the descriptive fields are persisted + the series is locked from auto-sync.
        expect(data).toMatchObject({
            seriesGroup: 'Batman Family',
            universe: 'DC Universe',
            description: 'The Caped Crusader.',
            hasCustomMetadata: true,
        });
    });

    it('persists the #199 ComicInfo defaults: lists as JSON arrays, validated numbers, two-way B&W', async () => {
        const res = await POST(createReq({
            oldFolderPath: '/unmatched/Caravan',
            metadataId: '4050-1',
            name: 'Caravan', year: 2009, publisher: 'Sergio Bonelli Editore',
            writer: 'A. Writer, B. Writer', penciller: '', inker: 'C. Inker',
            genre: 'Sci-Fi , Western,, ', tags: 'ninja',
            imprint: 'Vertigo', languageISO: 'it', ageRating: 'Mature 17+',
            communityRating: '7.3', alternateCount: 'six', storyArcNumber: '2',
            blackAndWhite: true,
        }));
        expect(res.status).toBe(200);

        const data = mocks.createSeries.mock.calls[0][0].data;
        expect(data).toMatchObject({
            writers: JSON.stringify(['A. Writer', 'B. Writer']), // comma text → JSON array string
            inker: JSON.stringify(['C. Inker']),
            genres: JSON.stringify(['Sci-Fi', 'Western']),       // stray commas/whitespace dropped
            tags: JSON.stringify(['ninja']),
            artists: null,            // explicitly-empty penciller clears the column
            imprint: 'Vertigo',
            languageISO: 'it',
            ageRating: 'Mature 17+',
            communityRating: 5,       // clamped to ComicInfo's 0-5 range
            alternateCount: null,     // garbage number → null, never NaN
            storyArcNumber: '2',
            blackAndWhite: true,
        });
    });

    it('clears B&W to null when the switch is off — never stores a false "No" claim', async () => {
        const res = await POST(createReq({
            oldFolderPath: '/unmatched/Caravan', metadataId: '4050-1', name: 'Caravan', year: 2009,
            blackAndWhite: false,
        }));
        expect(res.status).toBe(200);
        expect(mocks.createSeries.mock.calls[0][0].data.blackAndWhite).toBeNull();
    });

    it('leaves every ComicInfo default column untouched when the dialog was never used', async () => {
        const res = await POST(createReq({
            oldFolderPath: '/unmatched/Caravan', metadataId: '4050-1', name: 'Caravan', year: 2009,
        }));
        expect(res.status).toBe(200);
        const data = mocks.createSeries.mock.calls[0][0].data;
        for (const k of ['writers', 'artists', 'inker', 'imprint', 'tags', 'ageRating', 'communityRating', 'alternateCount', 'blackAndWhite']) {
            expect(data).not.toHaveProperty(k);
        }
    });

    it('should drop an empty {SeriesGroup} segment when no group is supplied (no literal token, no empty tier)', async () => {
        mocks.findManySettings.mockResolvedValue([
            { key: 'folder_naming_pattern', value: '{SeriesGroup}/{Series} ({Year})' }
        ]);

        const res = await POST(createReq({
            oldFolderPath: '/unmatched/Batman',
            metadataId: '4050-1234',
            name: 'Batman',
            year: 2016,
        }));
        expect(res.status).toBe(200);

        const data = mocks.createSeries.mock.calls[0][0].data;
        expect(data.folderPath).not.toContain('{SeriesGroup}');
        expect(data.folderPath).not.toMatch(/\/\//); // no empty leading directory tier
        expect(data.folderPath).toContain('Batman (2016)');
        // No override → no lock, no group persisted.
        expect(data.hasCustomMetadata).toBeUndefined();
        expect(data.seriesGroup).toBeUndefined();
    });

    it('should relocate a folder non-destructively and surface the conflict count', async () => {
        // A target that already holds same-named files → safeRelocateFolder merges (never deletes) and
        // reports the dupes it left in place; the route must pass that count through to the caller.
        mocks.safeRelocateFolder.mockResolvedValue({ conflicts: 2 });

        const res = await POST(createReq({
            oldFolderPath: '/unmatched/Batman',
            metadataId: '4050-1234',
            name: 'Batman',
            year: 2016,
        }));
        expect(res.status).toBe(200);

        // The move went through the safe (merge, never overwrite) helper, sourced from /unmatched.
        expect(mocks.safeRelocateFolder).toHaveBeenCalledWith('/unmatched/Batman', expect.any(String), expect.any(String));
        const data = await res.json();
        expect(data.conflicts).toBe(2);
    });

    it('should preserve a custom cover on re-match (no cover.jpg write, no coverUrl override)', async () => {
        mocks.getSeriesDetails.mockResolvedValueOnce({ name: 'Batman', year: 2020, publisher: 'DC Comics', coverUrl: 'http://cover/img.jpg', status: 'Ongoing' });
        // The series already has an admin-uploaded cover — a manual re-match must not clobber it.
        mocks.findFirstSeries.mockResolvedValue({ id: 's_custom', hasCustomCover: true });

        const res = await POST(createReq({ oldFolderPath: '/unmatched/Batman', metadataId: '987', metadataSource: 'METRON' }));
        expect(res.status).toBe(200);

        // The provider cover was neither downloaded nor written over cover.jpg.
        expect(vi.mocked(fs.promises.writeFile)).not.toHaveBeenCalled();
        // ...and the series update did not repoint coverUrl at the provider art.
        expect(mocks.updateSeries.mock.calls[0][0].data.coverUrl).toBeUndefined();
    });

    it('should apply an admin-supplied cover from the Smart Matcher editor (write + lock, skip provider)', async () => {
        mocks.getSeriesDetails.mockResolvedValueOnce({ name: 'Batman', year: 2020, publisher: 'DC Comics', coverUrl: 'http://cover/img.jpg', status: 'Ongoing' });
        const coverB64 = 'data:image/png;base64,' + Buffer.from('my-custom-cover').toString('base64');

        const res = await POST(createReq({
            oldFolderPath: '/unmatched/Batman',
            metadataId: '987',
            metadataSource: 'METRON',
            coverImageBase64: coverB64,
        }));
        expect(res.status).toBe(200);

        // The supplied bytes were written to cover.jpg...
        expect(vi.mocked(fs.promises.writeFile)).toHaveBeenCalledTimes(1);
        const [coverPath, buf] = vi.mocked(fs.promises.writeFile).mock.calls[0] as any[];
        expect(String(coverPath)).toContain('cover.jpg');
        expect(Buffer.isBuffer(buf) ? buf.toString() : '').toBe('my-custom-cover');
        // ...the series is created with the custom cover + lock...
        expect(mocks.createSeries).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ hasCustomCover: true, coverUrl: expect.stringContaining('/api/library/cover') })
        }));
        // ...and the provider image was never downloaded.
        expect(vi.mocked(axios.get)).not.toHaveBeenCalled();
    });

    it('should write a per-issue custom cover keyed by issue id and lock it', async () => {
        // A loose file matched cleanly into an existing series, creating one issue.
        vi.mocked(fs.promises.stat).mockResolvedValueOnce({ isFile: () => true } as any);
        // Only the source file "exists" — so the move + rename hit no collision path.
        vi.mocked(fs.existsSync).mockImplementation((p: any) => String(p) === '/unmatched/Batman 001.cbz');
        vi.mocked(fs.promises.readdir).mockResolvedValueOnce(['Batman 001.cbz'] as any);
        vi.mocked(axios.get).mockResolvedValue({ data: Buffer.from('series-cover') } as any);
        mocks.getSeriesDetails.mockResolvedValueOnce({ name: 'Batman', year: 2020, publisher: 'DC Comics', coverUrl: 'http://cover/img.jpg', status: 'Ongoing' });
        mocks.findFirstSeries.mockResolvedValue({ id: 's1' });          // unmatchedRecord → update branch
        mocks.updateSeries.mockResolvedValue({ id: 's1', year: 2020 }); // becomes existingRecord
        mocks.findFirstIssue.mockResolvedValue(null);                   // no existing issue → create
        mocks.createIssue.mockResolvedValue({ id: 'issue_99' });

        const coverB64 = 'data:image/png;base64,' + Buffer.from('issue-cover-bytes').toString('base64');
        const res = await POST(createReq({
            oldFolderPath: '/unmatched/Batman 001.cbz',
            metadataId: '987',
            metadataSource: 'METRON',
            exactIssueNumber: '1',
            issueCoverImageBase64: coverB64,
        }));
        expect(res.status).toBe(200);

        // The issue cover was written under uploads/issue-covers, keyed by the created issue id.
        const coverWrite = vi.mocked(fs.promises.writeFile).mock.calls.find(c => String(c[0]).includes('issue-covers'));
        expect(coverWrite).toBeTruthy();
        expect(String(coverWrite![0])).toContain('issue_99.jpg');
        expect(Buffer.isBuffer(coverWrite![1]) ? (coverWrite![1] as Buffer).toString() : '').toBe('issue-cover-bytes');
        // ...and the issue row was locked + repointed at the uploads path.
        expect(mocks.updateIssue).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'issue_99' },
            data: expect.objectContaining({ hasCustomCover: true, coverUrl: expect.stringContaining('/api/uploads/issue-covers/issue_99.jpg') })
        }));
    });

    it('should refuse to overwrite a same-named loose file and report the conflict', async () => {
        // isFile = true and the target name already exists (existsSync defaults to true) → leave the loose
        // file in place, count the conflict, and never call rename (no clobber).
        vi.mocked(fs.promises.stat).mockResolvedValueOnce({ isFile: () => true } as any);

        const res = await POST(createReq({
            oldFolderPath: '/unmatched/Batman 001.cbz',
            metadataId: '4050-1234',
            name: 'Batman',
            year: 2016,
        }));
        expect(res.status).toBe(200);

        const data = await res.json();
        expect(data.conflicts).toBe(1);
        // No move of any kind (cross-device-safe or otherwise) — the loose file stays put.
        expect(mocks.moveFileSafe).not.toHaveBeenCalled();
        expect(vi.mocked(fs.promises.rename)).not.toHaveBeenCalled();
    });

    it('should store the raw provider name in the DB while paths use the sanitized form (#194 e)', async () => {
        mocks.findUniqueSetting.mockResolvedValueOnce({ value: 'cv_api_key' });
        vi.mocked(axios.get).mockResolvedValueOnce({
            data: { results: { name: 'Batman: White Knight', start_year: '2017', publisher: { name: 'DC Comics' } } }
        } as any);

        const res = await POST(createReq({ oldFolderPath: '/unmatched/Batman White Knight', metadataId: '4050-9999' }));
        expect(res.status).toBe(200);

        const data = mocks.createSeries.mock.calls[0][0].data;
        // The DB keeps the colon the provider returned (no more name flip-flop with the sync)...
        expect(data.name).toBe('Batman: White Knight');
        // ...while the folder path uses the sanitized, colon-free form.
        expect(data.folderPath).toContain('Batman White Knight (2017)');
        expect(data.folderPath).not.toContain(':');
    });

    it("should keep an existing local cover in 'archive' mode (no provider download or overwrite) (#194 d)", async () => {
        mocks.findManySettings.mockResolvedValue([{ key: 'cover_source', value: 'archive' }]);
        mocks.getSeriesDetails.mockResolvedValueOnce({ name: 'Batman', year: 2020, publisher: 'DC Comics', coverUrl: 'http://cover/img.jpg', status: 'Ongoing' });

        const res = await POST(createReq({ oldFolderPath: '/unmatched/Batman', metadataId: '987', metadataSource: 'METRON' }));
        expect(res.status).toBe(200);

        // existsSync defaults to true → a local cover.jpg "exists": the provider image is neither
        // downloaded nor written over it (this route used to stamp it unconditionally).
        expect(vi.mocked(axios.get)).not.toHaveBeenCalled();
        expect(vi.mocked(fs.promises.writeFile)).not.toHaveBeenCalled();
        // The series still points at the local folder cover.
        const data = mocks.createSeries.mock.calls[0][0].data;
        expect(decodeURIComponent(String(data.coverUrl))).toContain('cover.jpg');
    });

    it('should still stamp provider art over cover.jpg in the default cover mode', async () => {
        mocks.getSeriesDetails.mockResolvedValueOnce({ name: 'Batman', year: 2020, publisher: 'DC Comics', coverUrl: 'http://cover/img.jpg', status: 'Ongoing' });
        vi.mocked(axios.get).mockResolvedValueOnce({ data: Buffer.from('provider-art') } as any);

        const res = await POST(createReq({ oldFolderPath: '/unmatched/Batman', metadataId: '987', metadataSource: 'METRON' }));
        expect(res.status).toBe(200);

        expect(vi.mocked(axios.get)).toHaveBeenCalledWith('http://cover/img.jpg', expect.any(Object));
        const coverWrite = vi.mocked(fs.promises.writeFile).mock.calls.find(c => String(c[0]).includes('cover.jpg'));
        expect(coverWrite).toBeTruthy();
    });
});

// 2026-07-25 worklist item 5: matching used to recompute detectManga({name, publisher, year}) with
// no file/library/existing-row context, then overwrite isManga, repoint libraryId, and physically
// move manga-library series into the Comics library. The rule now: NEVER demote — the admin's
// library placement and any existing DB rows outrank a context-free re-detection; detection only
// runs (and can only PROMOTE) when no prior signal exists.
describe('manga never-demote on match (worklist item 5)', () => {
    const comicLib = { id: 'lib_1', path: '/comics', isDefault: true, isManga: false };
    const mangaLib = { id: 'lib_manga', path: '/manga', isDefault: false, isManga: true };

    beforeEach(async () => {
        const { detectManga } = await import('@/lib/manga-detector');
        // mockReset (not clear) drops any stale mockResolvedValueOnce queues left by earlier suites.
        vi.mocked(detectManga).mockReset().mockResolvedValue(false);
        mocks.getSeriesDetails.mockReset().mockResolvedValue({ name: 'Naruto', year: 1999, publisher: 'Shueisha', coverUrl: null, status: 'Ongoing' });
    });

    it('keeps a manga-library series manga and in its own library even when detection would demote it', async () => {
        const { detectManga } = await import('@/lib/manga-detector');
        mocks.findManyLibraries.mockResolvedValue([comicLib, mangaLib]);
        mocks.findFirstSeries.mockResolvedValue({ id: 'series_m', folderPath: '/manga/Naruto', isManga: true, libraryId: 'lib_manga' });
        mocks.updateSeries.mockResolvedValue({ id: 'series_m', folderPath: '/manga/Shueisha/Naruto (1999)' });

        const res = await POST(createReq({ oldFolderPath: '/manga/Naruto', metadataId: '987', metadataSource: 'METRON' }));
        expect(res.status).toBe(200);

        expect(mocks.updateSeries).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ isManga: true, libraryId: 'lib_manga' })
        }));
        // A positive prior signal short-circuits detection entirely.
        expect(vi.mocked(detectManga)).not.toHaveBeenCalled();
    });

    it('keeps a series in the manga library when only the LIBRARY flag says manga (no series row yet)', async () => {
        mocks.findManyLibraries.mockResolvedValue([comicLib, mangaLib]);
        // Series row exists but untyped (isManga false), sitting in the manga library.
        mocks.findFirstSeries.mockResolvedValue({ id: 'series_u', folderPath: '/manga/Naruto', isManga: false, libraryId: 'lib_manga' });
        mocks.updateSeries.mockResolvedValue({ id: 'series_u', folderPath: '/manga/Shueisha/Naruto (1999)' });

        const res = await POST(createReq({ oldFolderPath: '/manga/Naruto', metadataId: '987', metadataSource: 'METRON' }));
        expect(res.status).toBe(200);

        expect(mocks.updateSeries).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ isManga: true, libraryId: 'lib_manga' })
        }));
    });

    it('does not move a comic series between same-type libraries on re-match', async () => {
        const comicLib2 = { id: 'lib_2', path: '/comics2', isDefault: false, isManga: false };
        mocks.findManyLibraries.mockResolvedValue([comicLib, comicLib2]);
        mocks.findFirstSeries.mockResolvedValue({ id: 'series_c', folderPath: '/comics2/Batman', isManga: false, libraryId: 'lib_2' });
        mocks.updateSeries.mockResolvedValue({ id: 'series_c', folderPath: '/comics2/Shueisha/Naruto (1999)' });

        const res = await POST(createReq({ oldFolderPath: '/comics2/Batman', metadataId: '987', metadataSource: 'METRON' }));
        expect(res.status).toBe(200);

        expect(mocks.updateSeries).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ isManga: false, libraryId: 'lib_2' })
        }));
    });

    it('still promotes: detection may route a fresh unmatched series into the manga library', async () => {
        const { detectManga } = await import('@/lib/manga-detector');
        vi.mocked(detectManga).mockResolvedValue(true);
        mocks.findManyLibraries.mockResolvedValue([comicLib, mangaLib]);
        mocks.findFirstSeries.mockResolvedValue(null);
        mocks.createSeries.mockResolvedValue({ id: 'series_new', folderPath: '/manga/Shueisha/Naruto (1999)' });

        const res = await POST(createReq({ oldFolderPath: '/unmatched/Naruto', metadataId: '987', metadataSource: 'METRON' }));
        expect(res.status).toBe(200);

        expect(mocks.createSeries).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ isManga: true, libraryId: 'lib_manga' })
        }));
    });
});