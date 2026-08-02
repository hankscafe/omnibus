// Fork review #5 (Auto-Build add-missing-series): collectMissingArcSeries resolves unmatched arc
// issues to parent series and returns ONLY series with no Series row at all. These tests pin the
// batched ComicVine volume lookup (100 ids per call), the Metron name-search fallback, dedupe,
// the owned-series exclusion, and graceful degradation when a provider call throws.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { collectMissingArcSeries } from '@/lib/utils/arc-missing-series';
import { loggerLog } from '../../helpers/setup-global';

const mocks = vi.hoisted(() => ({
    seriesFindMany: vi.fn(),
    cachedCvGet: vi.fn(),
    searchSeries: vi.fn(),
    log: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ prisma: { series: { findMany: mocks.seriesFindMany } } }));
vi.mock('@/lib/metadata/metadata-cache', () => ({ cachedCvGet: mocks.cachedCvGet }));
vi.mock('@/lib/metadata/providers/metron', () => ({
    MetronProvider: class { searchSeries = mocks.searchSeries; }
}));

const cvIssue = (id: number, volumeId: number, volumeName: string) => ({ id, volume: { id: volumeId, name: volumeName } });

describe('collectMissingArcSeries — ComicVine', () => {
    beforeEach(() => {
        mocks.seriesFindMany.mockResolvedValue([]);
    });

    it('batch-resolves volumes, dedupes, and excludes already-owned series', async () => {
        mocks.cachedCvGet.mockResolvedValue({
            data: { results: [cvIssue(1, 100, 'Avengers'), cvIssue(2, 100, 'Avengers'), cvIssue(3, 200, 'Thor')] }
        });
        // Thor (200) already has a Series row → excluded, even though its issue was unmatched.
        mocks.seriesFindMany.mockResolvedValue([{ metadataId: '200' }]);

        const result = await collectMissingArcSeries([], [1, 2, 3], 'COMICVINE', 'key123');

        expect(result).toEqual([{ id: '100', name: 'Avengers', source: 'COMICVINE' }]);
        const call = mocks.cachedCvGet.mock.calls[0];
        expect(call[0]).toContain('/api/issues/');
        expect(call[1].params.filter).toBe('id:1|2|3');
        expect(call[1].params.field_list).toBe('id,volume');
    });

    it('chunks the id list at 100 per API call', async () => {
        mocks.cachedCvGet.mockResolvedValue({ data: { results: [] } });
        const ids = Array.from({ length: 150 }, (_, i) => i + 1);

        await collectMissingArcSeries([], ids, 'COMICVINE', 'key123');

        expect(mocks.cachedCvGet).toHaveBeenCalledTimes(2);
        expect(mocks.cachedCvGet.mock.calls[0][1].params.filter.split('|')).toHaveLength(100);
        expect(mocks.cachedCvGet.mock.calls[1][1].params.filter.split('|')).toHaveLength(50);
    });

    it('returns [] without any provider or DB calls when nothing is unmatched', async () => {
        const result = await collectMissingArcSeries([], [], 'COMICVINE', 'key123');

        expect(result).toEqual([]);
        expect(mocks.cachedCvGet).not.toHaveBeenCalled();
        expect(mocks.seriesFindMany).not.toHaveBeenCalled();
    });

    it('returns [] when no API key is available (never throws at the caller)', async () => {
        const result = await collectMissingArcSeries([], [1], 'COMICVINE', null);
        expect(result).toEqual([]);
        expect(mocks.cachedCvGet).not.toHaveBeenCalled();
    });

    it('degrades to the resolvable subset when a batch call throws', async () => {
        mocks.cachedCvGet
            .mockRejectedValueOnce(new Error('CV 420'))
            .mockResolvedValueOnce({ data: { results: [cvIssue(101, 300, 'X-Men')] } });
        const ids = Array.from({ length: 101 }, (_, i) => i + 1);

        const result = await collectMissingArcSeries([], ids, 'COMICVINE', 'key123');

        expect(result).toEqual([{ id: '300', name: 'X-Men', source: 'COMICVINE' }]);
        expect(loggerLog).toHaveBeenCalledWith(expect.stringContaining('volume batch lookup failed'), 'warn');
    });
});

describe('collectMissingArcSeries — Metron', () => {
    beforeEach(() => {
        mocks.seriesFindMany.mockResolvedValue([]);
    });

    const issuesList = [
        { id: 11, series: { name: 'Venom' } },
        { id: 12, series: { name: 'Venom' } },
        { id: 13, series: { name: 'Carnage' } },
        { id: 14, series: { name: 'Carnage' } }, // matched locally → not in unmatched ids below
    ];

    it('resolves unique series names via provider search, preferring the exact name match', async () => {
        mocks.searchSeries.mockImplementation(async (name: string) =>
            name === 'Venom'
                ? [{ sourceId: '901', name: 'Venom: First Host' }, { sourceId: '900', name: 'venom' }]
                : [{ sourceId: '910', name: 'Carnage' }]
        );

        const result = await collectMissingArcSeries(issuesList, [11, 12, 13], 'METRON', null);

        // One search per unique name; the case-insensitive exact match (900) beats the first hit.
        expect(mocks.searchSeries).toHaveBeenCalledTimes(2);
        expect(result).toEqual([
            { id: '900', name: 'venom', source: 'METRON' },
            { id: '910', name: 'Carnage', source: 'METRON' },
        ]);
    });

    it('skips series whose lookup throws and keeps the rest', async () => {
        mocks.searchSeries.mockImplementation(async (name: string) => {
            if (name === 'Venom') throw new Error('metron 429');
            return [{ sourceId: '910', name: 'Carnage' }];
        });

        const result = await collectMissingArcSeries(issuesList, [11, 13], 'METRON', null);

        expect(result).toEqual([{ id: '910', name: 'Carnage', source: 'METRON' }]);
        expect(loggerLog).toHaveBeenCalledWith(expect.stringContaining('Metron series lookup failed'), 'warn');
    });
});
