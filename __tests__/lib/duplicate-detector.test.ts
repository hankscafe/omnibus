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

import { findDuplicateGroups } from '@/lib/duplicate-detector';

const issue = (id: string, seriesId: string, number: string, filePath: string, seriesName = 'Batman') =>
    ({ id, seriesId, number, filePath, series: { name: seriesName } });

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
