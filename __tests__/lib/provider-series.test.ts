// #257: the series picked loose collected editions belong to, picked from the provider — found by
// its provider key, or created the way a Smart Matcher match files it, without a file of its own.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    seriesFindUnique: vi.fn(), seriesCreate: vi.fn(), libraryFindMany: vi.fn(), settingFindUnique: vi.fn(),
    detectManga: vi.fn(), folderOwner: vi.fn(), ensureLibraryDir: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
    prisma: {
        series: { findUnique: mocks.seriesFindUnique, create: mocks.seriesCreate },
        library: { findMany: mocks.libraryFindMany },
        systemSetting: { findUnique: mocks.settingFindUnique },
    },
}));
vi.mock('@/lib/manga-detector', () => ({ detectManga: mocks.detectManga }));
vi.mock('@/lib/match-collision', () => ({ folderOwner: mocks.folderOwner }));
vi.mock('@/lib/utils/safe-fs', () => ({ ensureLibraryDir: mocks.ensureLibraryDir }));
const provider = vi.hoisted(() => ({ metronDetails: vi.fn(), cvGet: vi.fn() }));
vi.mock('@/lib/metadata/providers/metron', () => ({ MetronProvider: vi.fn(function () { return { getSeriesDetails: provider.metronDetails }; }) }));
vi.mock('@/lib/metadata/metadata-cache', () => ({ cachedCvGet: provider.cvGet }));
vi.mock('@/lib/logger', () => ({ Logger: { log: vi.fn() } }));

import { findOrCreateProviderSeries } from '@/lib/provider-series';

const PARENT = { metadataSource: 'comicvine', metadataId: ' 161049 ', name: 'Power Rangers Prime', year: '2024', publisher: 'Boom! Studios' };

describe('findOrCreateProviderSeries', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.seriesFindUnique.mockResolvedValue(null);
        mocks.libraryFindMany.mockResolvedValue([
            { id: 'libM', name: 'Manga', path: '/data/library/Manga', isManga: true, isDefault: false },
            { id: 'libC', name: 'Comics', path: '/data/library/Comics', isManga: false, isDefault: true },
        ]);
        mocks.settingFindUnique.mockResolvedValue(null);
        mocks.detectManga.mockResolvedValue(false);
        mocks.folderOwner.mockResolvedValue(null);
        mocks.seriesCreate.mockImplementation(async ({ data }: any) => ({ id: 'new', ...data }));
    });

    it('returns the library series that already has this provider key, creating nothing', async () => {
        mocks.seriesFindUnique.mockResolvedValue({ id: 'prp', name: 'Power Rangers Prime' });
        const result = await findOrCreateProviderSeries(PARENT);
        expect(mocks.seriesFindUnique).toHaveBeenCalledWith({ where: { metadataSource_metadataId: { metadataSource: 'COMICVINE', metadataId: '161049' } } });
        expect(result).toEqual({ series: { id: 'prp', name: 'Power Rangers Prime' }, created: false });
        expect(mocks.seriesCreate).not.toHaveBeenCalled();
    });

    it('creates it in the comics library under the folder pattern, matched to the provider, and makes its folder', async () => {
        const result = await findOrCreateProviderSeries(PARENT);
        expect(mocks.seriesCreate).toHaveBeenCalledWith({
            data: expect.objectContaining({
                cvId: 161049, metadataId: '161049', metadataSource: 'COMICVINE', matchState: 'MATCHED',
                name: 'Power Rangers Prime', year: 2024, publisher: 'Boom! Studios',
                folderPath: '/data/library/Comics/Boom! Studios/Power Rangers Prime (2024)', isManga: false, libraryId: 'libC',
            }),
        });
        expect(mocks.ensureLibraryDir).toHaveBeenCalledWith('/data/library/Comics/Boom! Studios/Power Rangers Prime (2024)');
        // The folder before the row: a series never points at a folder that couldn't be made.
        expect(mocks.ensureLibraryDir.mock.invocationCallOrder[0]).toBeLessThan(mocks.seriesCreate.mock.invocationCallOrder[0]);
        expect(result).toEqual(expect.objectContaining({ created: true }));
    });

    it('files a manga in the manga library, and follows a custom folder pattern', async () => {
        mocks.detectManga.mockResolvedValue(true);
        mocks.settingFindUnique.mockResolvedValue({ key: 'folder_naming_pattern', value: '{Series}' });
        await findOrCreateProviderSeries({ metadataSource: 'METRON', metadataId: '42', name: 'Berserk', year: 2003, publisher: 'Dark Horse' });
        expect(mocks.seriesCreate).toHaveBeenCalledWith({
            data: expect.objectContaining({ cvId: null, metadataSource: 'METRON', folderPath: '/data/library/Manga/Berserk', isManga: true, libraryId: 'libM' }),
        });
    });

    it('never shares a folder: a series owning the computed folder stops it before anything is created', async () => {
        mocks.folderOwner.mockResolvedValue({ id: 'other', name: 'Power Rangers Prime', year: 2024 });
        const result = await findOrCreateProviderSeries(PARENT);
        expect(result).toEqual(expect.objectContaining({ status: 409 }));
        expect(mocks.seriesCreate).not.toHaveBeenCalled();
        expect(mocks.ensureLibraryDir).not.toHaveBeenCalled();
    });

    it.each([
        ['a source that is not a provider', { ...PARENT, metadataSource: 'LOCAL' }],
        ['an id that is not a provider id', { ...PARENT, metadataId: '4050-161049' }],
        ['no name', { ...PARENT, name: '  ' }],
    ])('refuses %s', async (_label, ref) => {
        const result = await findOrCreateProviderSeries(ref);
        expect(result).toEqual(expect.objectContaining({ status: 400 }));
        expect(mocks.seriesCreate).not.toHaveBeenCalled();
    });

    it('refuses when there is no library to put it in', async () => {
        mocks.libraryFindMany.mockResolvedValue([]);
        expect(await findOrCreateProviderSeries(PARENT)).toEqual(expect.objectContaining({ status: 400 }));
    });
});

describe('findOrCreateProviderSeries — a search result without its publisher', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.seriesFindUnique.mockResolvedValue(null);
        mocks.libraryFindMany.mockResolvedValue([{ id: 'libC', name: 'Comics', path: '/data/library/Comics', isManga: false, isDefault: true }]);
        mocks.settingFindUnique.mockImplementation(async ({ where }: any) => where.key === 'cv_api_key' ? { value: 'k' } : null);
        mocks.detectManga.mockResolvedValue(false);
        mocks.folderOwner.mockResolvedValue(null);
        mocks.seriesCreate.mockImplementation(async ({ data }: any) => ({ id: 'new', ...data }));
    });

    it("files a Metron series by Metron's own publisher, not under Other", async () => {
        provider.metronDetails.mockResolvedValue({ publisher: 'BOOM! Studios', year: 2024 });
        await findOrCreateProviderSeries({ metadataSource: 'METRON', metadataId: '7', name: 'Power Rangers Prime', year: 2024, publisher: 'Unknown' });
        expect(provider.metronDetails).toHaveBeenCalledWith('7');
        expect(mocks.seriesCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ publisher: 'BOOM! Studios', folderPath: '/data/library/Comics/BOOM! Studios/Power Rangers Prime (2024)' }) });
    });

    it('asks ComicVine for a missing year, and never asks when the result had both', async () => {
        provider.cvGet.mockResolvedValue({ data: { results: { publisher: { name: 'Marvel' }, start_year: '1968' } } });
        await findOrCreateProviderSeries({ metadataSource: 'COMICVINE', metadataId: '2400', name: 'Captain America', publisher: 'Marvel' });
        expect(mocks.seriesCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ year: 1968, folderPath: '/data/library/Comics/Marvel/Captain America (1968)' }) });

        provider.cvGet.mockClear();
        await findOrCreateProviderSeries({ metadataSource: 'COMICVINE', metadataId: '2400', name: 'Captain America', year: 1968, publisher: 'Marvel' });
        expect(provider.cvGet).not.toHaveBeenCalled();
    });

    it('keeps the search values when the provider cannot be reached', async () => {
        provider.metronDetails.mockRejectedValue(new Error('429'));
        await findOrCreateProviderSeries({ metadataSource: 'METRON', metadataId: '7', name: 'Power Rangers Prime', year: 2024, publisher: '' });
        expect(mocks.seriesCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ publisher: 'Other' }) });
    });
});
