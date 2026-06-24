// __tests__/api/match-series.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '@/app/api/library/match-series/route';
import fs from 'fs';
import axios from 'axios';

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
    safeRelocateFolder: vi.fn()
}));

// 2. Mock Server Dependencies
vi.mock('next/cache', () => ({
    revalidatePath: vi.fn(),
    revalidateTag: vi.fn()
}));

vi.mock('next-auth', () => ({
    getServerSession: vi.fn().mockResolvedValue({ user: { id: 'admin_1', role: 'ADMIN' } })
}));

vi.mock('next-auth/next', () => ({
    getServerSession: vi.fn().mockResolvedValue({ user: { id: 'admin_1', role: 'ADMIN' } })
}));

vi.mock('@/app/api/auth/[...nextauth]/options', () => ({
    getAuthOptions: vi.fn().mockResolvedValue({})
}));

vi.mock('@/lib/audit-logger', () => ({
    AuditLogger: { log: vi.fn().mockResolvedValue(true) }
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

vi.mock('@/lib/logger', () => ({ Logger: { log: mocks.log } }));

vi.mock('@/lib/discord', () => ({ DiscordNotifier: { sendAlert: vi.fn().mockResolvedValue(true) } }));

vi.mock('@/lib/manga-detector', () => ({ detectManga: vi.fn().mockResolvedValue(false) }));

vi.mock('@/lib/metadata/providers/metron', () => {
    return { MetronProvider: class { getSeriesDetails = mocks.getSeriesDetails } }
});

vi.mock('@/lib/queue', () => ({ omnibusQueue: { add: vi.fn() } }));

// Non-destructive folder relocator — mocked so we can assert the route surfaces its conflict count.
vi.mock('@/lib/utils/safe-fs', () => ({
    safeRelocateFolder: mocks.safeRelocateFolder,
    cleanupEmptyDirs: vi.fn()
}));

const createReq = (body: any) => new Request('http://localhost/api/library/match-series', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
});

describe('API Route: Smart Matcher (/api/library/match-series)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
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
        expect(vi.mocked(fs.promises.rename)).not.toHaveBeenCalled();
    });
});