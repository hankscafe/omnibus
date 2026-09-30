import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from '@/app/api/search/route';

// Metron beta 4 (#216 follow-up): a Metron search result's cover costs one extra Metron request, so
// only a search someone is looking at asks for covers - an automated caller (Smart Match's Auto-Scan)
// sends covers=none. A page whose covers were skipped because Metron was busy isn't cached, so the
// next look fills them instead of showing blanks for 12 hours.

const mocks = vi.hoisted(() => ({
    searchSeries: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    upsert: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
    prisma: { systemSetting: { findMany: mocks.findMany, findUnique: mocks.findUnique, upsert: mocks.upsert } },
}));
vi.mock('@/lib/metadata/providers/metron', () => ({
    MetronProvider: class { searchSeries = mocks.searchSeries; },
}));
vi.mock('@/lib/metadata/metadata-cache', () => ({ cachedCvGet: vi.fn() }));

const result = (id: number, extra: Record<string, unknown> = {}) => ({
    sourceId: String(id), source: 'METRON', name: `Series ${id}`, year: 2020, publisher: 'DC', issueCount: 12,
    coverUrl: `https://static.metron.cloud/${id}.jpg`, ...extra,
});
const search = (qs: string) => GET(new Request(`http://localhost/api/search?${qs}`));
const cachedKeys = () => mocks.upsert.mock.calls.map(([arg]: any[]) => arg.where.key as string);

describe('GET /api/search - Metron covers', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.findMany.mockResolvedValue([{ key: 'primary_metadata_source', value: 'METRON' }]);
        mocks.findUnique.mockResolvedValue(null);
        mocks.upsert.mockResolvedValue({});
    });

    it('a search someone is looking at asks for covers, and shows them through the cover proxy', async () => {
        mocks.searchSeries.mockResolvedValue([result(1)]);

        const body = await (await search('q=Batman&provider=METRON')).json();

        expect(mocks.searchSeries).toHaveBeenCalledWith('Batman', 1, { covers: true });
        expect(body.results[0].image).toBe(`/api/library/cover?path=${encodeURIComponent('https://static.metron.cloud/1.jpg')}`);
    });

    it('covers=none asks for none, and caches under its own key', async () => {
        mocks.searchSeries.mockResolvedValue([result(1, { coverUrl: null })]);

        await search('q=Batman&provider=METRON&covers=none');
        await search('q=Batman&provider=METRON');

        expect(mocks.searchSeries.mock.calls.map(c => c[2])).toEqual([{ covers: false }, { covers: true }]);
        const [withoutCovers, withCovers] = cachedKeys();
        expect(withoutCovers).not.toBe(withCovers);
    });

    it('a page with a skipped cover is not cached - the next look fills it', async () => {
        mocks.searchSeries.mockResolvedValue([result(1), result(2, { coverUrl: null, coverPending: true })]);

        const body = await (await search('q=Batman&provider=METRON')).json();

        expect(body.results).toHaveLength(2);
        expect(mocks.upsert).not.toHaveBeenCalled();
    });

    it('a complete page is cached as before', async () => {
        mocks.searchSeries.mockResolvedValue([result(1), result(2, { coverUrl: null })]);

        await search('q=Batman&provider=METRON');

        expect(cachedKeys()).toHaveLength(1);
    });
});
