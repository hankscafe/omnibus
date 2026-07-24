import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    issueFindMany: vi.fn(),
    issueGroupBy: vi.fn(),
    existsSync: vi.fn(),
    statSync: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
    prisma: { issue: { findMany: mocks.issueFindMany, groupBy: mocks.issueGroupBy } }
}));

vi.mock('fs-extra', () => ({
    existsSync: mocks.existsSync,
    statSync: mocks.statSync,
    default: { existsSync: mocks.existsSync, statSync: mocks.statSync },
}));

import { findDuplicateGroups, filenamesDisagree } from '@/lib/duplicate-detector';

const issue = (id: string, seriesId: string, number: string, filePath: string, seriesName = 'Batman', metadataId: string | null = null, metadataSource: string | null = null) =>
    ({ id, seriesId, number, filePath, series: { name: seriesName, metadataId, metadataSource } });

// Drive both prisma calls from one dataset: groupBy returns the (seriesId, number) pairs the DB would
// report with count > 1, and findMany returns the issues in those candidate series (as the real
// `seriesId in seriesIds` query would).
function setIssues(issues: ReturnType<typeof issue>[]) {
    const counts = new Map<string, number>();
    for (const i of issues) counts.set(`${i.seriesId} ${i.number}`, (counts.get(`${i.seriesId} ${i.number}`) || 0) + 1);
    const groups = [...counts.entries()]
        .filter(([, n]) => n > 1)
        .map(([k, n]) => { const [seriesId, number] = k.split(' '); return { seriesId, number, _count: { seriesId: n } }; });
    mocks.issueGroupBy.mockResolvedValue(groups);
    const candidateSeries = new Set(groups.map(g => g.seriesId));
    mocks.issueFindMany.mockResolvedValue(issues.filter(i => candidateSeries.has(i.seriesId)));
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.existsSync.mockReturnValue(true);
    mocks.statSync.mockReturnValue({ size: 100 });
});

describe('findDuplicateGroups', () => {
    it('flags two existing files for the same series + number as a duplicate (and ignores singletons)', async () => {
        setIssues([
            issue('a', 's1', '1', '/lib/s1/Batman 1.cbz'),
            issue('b', 's1', '1', '/lib/s1/Batman 001.cbz'),
            issue('c', 's1', '2', '/lib/s1/Batman 2.cbz'), // singleton → not a dupe
        ]);
        const groups = await findDuplicateGroups();
        expect(groups).toHaveLength(1);
        expect(groups[0].seriesId).toBe('s1');
        expect(groups[0].issueNumber).toBe('1');
        expect(groups[0].files.map(f => f.id).sort()).toEqual(['a', 'b']);
    });

    it('does NOT flag a group when only one of the files actually exists on disk', async () => {
        mocks.existsSync.mockImplementation((p: string) => p.includes('exists'));
        setIssues([
            issue('a', 's1', '1', '/lib/s1/exists.cbz'),
            issue('b', 's1', '1', '/lib/s1/missing.cbz'),
        ]);
        const groups = await findDuplicateGroups();
        expect(groups).toHaveLength(0);
    });

    it('keys by series, so the same number across different series is not a duplicate', async () => {
        setIssues([
            issue('a', 's1', '1', '/lib/s1/a.cbz', 'Batman'),
            issue('b', 's2', '1', '/lib/s2/b.cbz', 'Superman'),
        ]);
        const groups = await findDuplicateGroups();
        expect(groups).toHaveLength(0);
    });

    it('returns an empty array when there are no issues', async () => {
        setIssues([]);
        expect(await findDuplicateGroups()).toEqual([]);
    });
});

// Issue #196: the resolver grouped files 001 and 004 of a mini-series as "duplicates of Issue #4" —
// crossed records from the corruption-era sync, not real duplicates. Deleting a copy would have
// removed a real comic. These pin the guard: filename disagreement → suspectedMispair, per-file
// parsed numbers surface the disagreement, provider linkage rides along for one-click refresh.
describe('filenamesDisagree', () => {
    it('flags genuinely different parsed numbers', () => {
        expect(filenamesDisagree(['1', '4'])).toBe(true);
        expect(filenamesDisagree(['3', '3', '4'])).toBe(true);
        expect(filenamesDisagree(['1.5', '1'])).toBe(true);
    });

    it('never flags padding/suffix-equivalent, single, or empty entries', () => {
        expect(filenamesDisagree(['001', '1'])).toBe(false);
        expect(filenamesDisagree(['2', '2'])).toBe(false);
        expect(filenamesDisagree(['1A', '1a'])).toBe(false);
        expect(filenamesDisagree(['3'])).toBe(false);
        expect(filenamesDisagree([])).toBe(false);
    });
});

describe('suspected-mispair detection (issue #196)', () => {
    it('flags the anacronismo case: files 001 and 004 sharing DB number "4"', async () => {
        setIssues([
            issue('i1', 's1', '4', '/comics/DH/Cyberpunk 2077 Blackout (2022)/Cyberpunk 2077 Blackout 001 (2022).cbz', 'Cyberpunk 2077: Blackout', '143306', 'COMICVINE'),
            issue('i4', 's1', '4', '/comics/DH/Cyberpunk 2077 Blackout (2022)/Cyberpunk 2077 Blackout 004 (2022).cbz', 'Cyberpunk 2077: Blackout', '143306', 'COMICVINE'),
        ]);
        const groups = await findDuplicateGroups();
        expect(groups).toHaveLength(1);
        const g = groups[0];
        expect(g.suspectedMispair).toBe(true);
        // The year-like "2077" in the title must never be read as the issue number.
        expect(g.files.map(f => f.parsedNumber)).toEqual(['1', '4']);
        // Provider linkage for the UI's one-click Refresh Metadata steer.
        expect(g.seriesMetadataId).toBe('143306');
        expect(g.seriesMetadataSource).toBe('COMICVINE');
    });

    it('does not flag a true duplicate (padding/edition variants of the same number)', async () => {
        setIssues([
            issue('a', 's1', '1', '/comics/Image/Saga (2012)/Saga 001 (2012).cbz', 'Saga'),
            issue('b', 's1', '1', '/comics/Image/Saga (2012)/Saga 01 (2012) (digital).cbz', 'Saga'),
        ]);
        const groups = await findDuplicateGroups();
        expect(groups).toHaveLength(1);
        expect(groups[0].suspectedMispair).toBe(false);
        expect(groups[0].files.map(f => f.parsedNumber)).toEqual(['1', '1']);
    });

    it('carries null provider linkage for an unmatched series (UI hides the refresh steer)', async () => {
        setIssues([
            issue('x', 's2', '2', '/comics/X/Thing 001.cbz', 'Thing'),
            issue('y', 's2', '2', '/comics/X/Thing 002.cbz', 'Thing'),
        ]);
        const groups = await findDuplicateGroups();
        expect(groups).toHaveLength(1);
        expect(groups[0].suspectedMispair).toBe(true);
        expect(groups[0].seriesMetadataId).toBeNull();
        expect(groups[0].seriesMetadataSource).toBeNull();
    });
});
