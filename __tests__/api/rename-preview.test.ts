// The rename PREVIEW must promise exactly the name the renamers produce — a preview that says one
// thing while Standardize does another already shipped once (annuals, beta.007). This pins the
// collected-edition naming on the preview side: a LOCAL edition's books after the edition, a
// provider trade and a plain issue after the series.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '@/app/api/library/rename/preview/route';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    seriesFindUnique: vi.fn(),
    issueFindMany: vi.fn(),
    attachedVolumeFindMany: vi.fn(),
    libraryFindMany: vi.fn(),
    systemSettingFindMany: vi.fn(),
    mockSession: { user: { id: 'admin_1', role: 'ADMIN' } },
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        series: { findUnique: mocks.seriesFindUnique },
        issue: { findMany: mocks.issueFindMany },
        attachedVolume: { findMany: mocks.attachedVolumeFindMany },
        library: { findMany: mocks.libraryFindMany },
        systemSetting: { findMany: mocks.systemSettingFindMany },
    },
}));
vi.mock('next-auth/jwt', () => ({ getToken: vi.fn().mockResolvedValue(mocks.mockSession.user) }));

const post = (body: Record<string, unknown>) => POST(new NextRequest('http://localhost/api/library/rename/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
}));

describe('API Route: Rename Preview', () => {
    beforeEach(() => {
        mocks.systemSettingFindMany.mockResolvedValue([]);
        mocks.attachedVolumeFindMany.mockResolvedValue([]);
        mocks.libraryFindMany.mockResolvedValue([{ id: 'lib_1', path: '/data/comics', isDefault: true, isManga: false }]);
        mocks.seriesFindUnique.mockResolvedValue({
            id: 'series_1', libraryId: 'lib_1', folderPath: '/data/comics/DC Comics/Batman (2016)',
            publisher: 'DC Comics', name: 'Batman', year: 2016, imprint: 'Black $& Label', isManga: false,
        });
    });

    it('preserves the previous cleanup result for templates without Imprint', async () => {
        mocks.issueFindMany.mockResolvedValue([{
            id: 'issue_1', number: '1', name: 'Batman #1', releaseDate: '2016-01-01',
            filePath: '/data/comics/old/Batman 1.cbz', attachedVolume: null,
        }]);
        const res = await post({
            seriesIds: ['series_1'], folderPattern: '{Series}', filePattern: '{Series} --- #{Issue}',
        });
        const { previews } = await res.json();
        // Original Node cleanup and the Rust renamer each collapse the hyphen run once.
        expect(previews[0].newPath).toBe('/data/comics/Batman/Batman - - #001.cbz');
    });

    // #244: the preview promises the padding the renamers will use, and no "(0000)" for a series
    // with no year.
    it.each([
        { padding: 'none', name: 'Batman #1.cbz' },
        { padding: '2', name: 'Batman #01.cbz' },
        { padding: undefined, name: 'Batman #001.cbz' },
    ])('promises the padding setting ($padding)', async ({ padding, name }) => {
        mocks.systemSettingFindMany.mockResolvedValue(padding ? [{ key: 'issue_number_padding', value: padding }] : []);
        mocks.issueFindMany.mockResolvedValue([{
            id: 'issue_1', number: '1', name: null, releaseDate: null, filePath: '/data/comics/old/Batman 1.cbz', attachedVolume: null,
        }]);
        mocks.seriesFindUnique.mockResolvedValue({
            id: 'series_1', libraryId: 'lib_1', folderPath: '/data/comics/Batman', publisher: 'DC Comics', name: 'Batman', year: 0, imprint: null, isManga: false,
        });
        const res = await post({ seriesIds: ['series_1'], folderPattern: '{Series} ({Year})', filePattern: '{Series} #{Issue} ({IssueYear})' });
        const { previews } = await res.json();
        expect(previews[0].newPath).toBe(`/data/comics/Batman/${name}`);
    });

    it('promises a LOCAL collected edition\'s books under the edition\'s name, and everything else under the series', async () => {
        mocks.issueFindMany.mockResolvedValue([
            {
                id: 'local_book', number: '1', name: 'Vol. 1', releaseDate: null,
                filePath: '/data/comics/DC Comics/Batman (2016)/Batman Compendium 01.cbz',
                attachedVolume: { kind: 'COLLECTED', metadataSource: 'LOCAL', name: 'Batman Compendium' },
            },
            {
                id: 'cv_book', number: '2', name: 'Vol. 2: City of Owls', releaseDate: '2016-06-01',
                filePath: '/data/comics/DC Comics/Batman (2016)/Batman TPB 02.cbz',
                attachedVolume: { kind: 'COLLECTED', metadataSource: 'COMICVINE', name: 'Batman' },
            },
            {
                id: 'issue_3', number: '3', name: 'Batman #3', releaseDate: '2016-03-01',
                filePath: '/data/comics/DC Comics/Batman (2016)/Batman 3.cbz', attachedVolume: null,
            },
        ]);

        const res = await post({ seriesIds: ['series_1'], folderPattern: '{Publisher}/{Series} ({Year})', filePattern: '{Series} #{Issue}' });
        const { previews } = await res.json();

        // The preview asks for what the rule needs, like the renamer does.
        expect(mocks.issueFindMany).toHaveBeenCalledWith(expect.objectContaining({
            include: { attachedVolume: { select: expect.objectContaining({ kind: true, metadataSource: true, name: true }) } },
        }));
        expect(previews.map((p: { newPath: string }) => p.newPath)).toEqual([
            '/data/comics/DC Comics/Batman (2016)/Batman Compendium Vol. 001 (2016).cbz',
            '/data/comics/DC Comics/Batman (2016)/Batman Vol. 002 (2016).cbz',
            '/data/comics/DC Comics/Batman (2016)/Batman #003.cbz',
        ]);
    });

    it('refuses a non-admin', async () => {
        const { getToken } = await import('next-auth/jwt');
        vi.mocked(getToken).mockResolvedValueOnce({ id: 'u1', role: 'USER' } as never);
        const res = await post({ seriesIds: ['series_1'], folderPattern: '{Series}', filePattern: '{Series} #{Issue}' });
        expect(res.status).toBe(403);
    });

    it('resolves repeated case variants of {Imprint} literally in folder and file names', async () => {
        mocks.issueFindMany.mockResolvedValue([{
            id: 'issue_1', number: '1', name: 'Batman #1', releaseDate: '2016-01-01',
            filePath: '/data/comics/old/Batman 1.cbz', attachedVolume: null,
        }]);

        const res = await post({
            seriesIds: ['series_1'],
            folderPattern: '{imprint}/{IMPRINT}/{Series}',
            filePattern: '{Imprint} {imprint} #{Issue}',
        });
        const { previews } = await res.json();
        expect(previews[0].newPath).toBe('/data/comics/Black $& Label/Black $& Label/Batman/Black $& Label Black $& Label #001.cbz');
    });

    // #239: the preview promises what both renamers now do for a volume kept as its own series.
    it('promises a kept-as-its-own collection its collected names in its own folder, ignoring a stray attachment id', async () => {
        mocks.seriesFindUnique.mockResolvedValue({
            id: 'child', libraryId: 'lib_1', folderPath: '/data/comics/DC Comics/Absolute Batman (2025)',
            publisher: 'DC Comics', name: 'Absolute Batman', year: 2025, isManga: false,
            metadataSource: 'COMICVINE', metadataId: '167340',
        });
        mocks.issueFindMany.mockResolvedValue([
            {
                id: 'c1', seriesId: 'child', number: '1', name: 'The Zoo', releaseDate: '2025-03-25',
                filePath: '/data/comics/DC Comics/Absolute Batman (2025)/Absolute Batman #01.cbz', attachedVolume: null,
            },
            {
                id: 'c2', seriesId: 'child', number: '2', name: 'Abomination', releaseDate: '2026-01-20',
                filePath: '/data/comics/DC Comics/Absolute Batman (2025)/Absolute Batman #02.cbz',
                attachedVolume: { kind: 'ANNUAL', metadataSource: 'COMICVINE', name: 'Elsewhere Annual', seriesId: 'parent' },
            },
        ]);
        const body = { seriesIds: ['child'], folderPattern: '{Publisher}/{Series} ({Year})', filePattern: '{Series} #{Issue}' };

        mocks.attachedVolumeFindMany.mockResolvedValue([{ kind: 'COLLECTED' }]);
        let data = await (await post(body)).json();
        expect(data.previews.map((p: any) => p.newPath)).toEqual([
            '/data/comics/DC Comics/Absolute Batman (2025)/Absolute Batman Vol. 001 (2025).cbz',
            '/data/comics/DC Comics/Absolute Batman (2025)/Absolute Batman Vol. 002 (2026).cbz',
        ]);

        mocks.attachedVolumeFindMany.mockResolvedValue([]);
        data = await (await post(body)).json();
        expect(data.previews.map((p: any) => p.newPath)).toEqual([
            '/data/comics/DC Comics/Absolute Batman (2025)/Absolute Batman #001.cbz',
            '/data/comics/DC Comics/Absolute Batman (2025)/Absolute Batman #002.cbz',
        ]);
    });
});
